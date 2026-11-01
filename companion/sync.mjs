// Dashboard poll deltas: the viewed transcript and the session list go out as changes since the dashboard's last rev.
import { randomBytes } from 'node:crypto';
export function createSync(ctx){
 const {store}=ctx;
 // A viewed transcript (up to 600 messages, megabytes) changes on almost every poll while its session streams, and the
 // poll's ETag covers the whole store, so any session streaming anywhere made every dashboard download the transcript it
 // views again, every 1.2 s. Dashboards that send since=<epoch>.<rev> get only the messages that changed after that rev,
 // plus the message order when it changed, and merge them into their copy. Each poll serializes the viewed session's
 // messages one by one and compares them with the previous poll of that session (by any dashboard): changed and new
 // messages take the next rev. Comparing content means no change slips by, wherever in the companion it was made.
 // An unknown epoch (first poll, an evicted entry, a restarted companion) gets the full transcript. Null when message IDs
 // are missing or repeated: that transcript is sent whole.
 const txSync=new Map();
 function transcriptDelta(s,since){
  const list=s.messages||[],ids=new Set();
  for(const m of list){if(typeof m?.id!=='string'||ids.has(m.id)){txSync.delete(s.id);return null;}ids.add(m.id);}
  const c=txSync.get(s.id)||{epoch:randomBytes(6).toString('base64url'),rev:0,orderRev:0,order:[],entries:new Map()};
  txSync.delete(s.id);txSync.set(s.id,c);if(txSync.size>8)txSync.delete(txSync.keys().next().value);
  const entries=new Map(),next=c.rev+1;let changed=false,reordered=list.length!==c.order.length;
  for(let i=0;i<list.length;i++){const m=list[i],json=JSON.stringify(m),prev=c.entries.get(m.id);
   if(prev?.json===json)entries.set(m.id,prev);else{entries.set(m.id,{json,rev:next});changed=true;}
   if(c.order[i]!==m.id)reordered=true;}
  if(changed||reordered)c.rev=next;
  if(reordered){c.orderRev=next;c.order=[...ids];}
  c.entries=entries;
  const held=/^([\w-]{1,32})\.(\d{1,15})$/.exec(since||''),rev=held?.[1]===c.epoch?Number(held[2]):-1;
  if(!(rev>=0&&rev<=c.rev))return {delta:false,tx:{session:s.id,epoch:c.epoch,rev:c.rev}};
  return {delta:true,tx:{session:s.id,epoch:c.epoch,rev:c.rev,...(c.orderRev>rev?{order:c.order}:{}),changed:list.filter(m=>entries.get(m.id).rev>rev)}};
 }
 // The session list and the rest of the store go out as changes too. A full reply with 400 sessions was ~600 KB (~180 KB
 // gzipped) and went out on every poll, every 1.2 s per dashboard while any session worked, though only the working
 // sessions' summaries had changed. Each poll serializes every session's summary (all but its transcript and /btw answers,
 // which go out on their own) and the store's other fields (top), and compares them with the previous poll's, like the
 // viewed transcript. A dashboard that sends store=<epoch>.<rev> gets the summaries that changed after that rev, the order
 // when it changed and top when it changed; an unknown epoch or rev gets everything. Returned serialized, splicing in each
 // summary's JSON from the comparison; null when session IDs repeat, which only the full list can show.
 const storeSync={epoch:randomBytes(6).toString('base64url'),rev:0,top:'',topRev:0,order:[],orderRev:0,entries:new Map()};
 function storeDelta(top,since){
  const c=storeSync,next=c.rev+1,entries=new Map(),order=[];let changed=false;
  for(const s of store.sessions){if(entries.has(s.id))return null;
   const json=JSON.stringify({...s,messages:undefined,_btw:undefined}),prev=c.entries.get(s.id);
   if(prev?.json===json)entries.set(s.id,prev);else{entries.set(s.id,{json,rev:next});changed=true;}
   order.push(s.id);}
  const topJson=JSON.stringify(top);if(topJson!==c.top){c.top=topJson;c.topRev=next;changed=true;}
  if(order.length!==c.order.length||order.some((id,i)=>id!==c.order[i])){c.order=order;c.orderRev=next;changed=true;}
  if(changed)c.rev=next;
  c.entries=entries;
  const held=/^([\w-]{1,32})\.(\d{1,15})$/.exec(since||''),rev=held?.[1]===c.epoch?Number(held[2]):-1,all=!(rev>=0&&rev<=c.rev),out=[];
  for(const e of entries.values())if(all||e.rev>rev)out.push(e.json);
  return `{"epoch":"${c.epoch}","rev":${c.rev}${all||c.topRev>rev?`,"top":${c.top}`:''}${all||c.orderRev>rev?`,"order":${JSON.stringify(c.order)}`:''},"changed":[${out.join(',')}]}`;
 }
 return {transcriptDelta,storeDelta};
}
