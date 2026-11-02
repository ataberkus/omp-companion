// Dashboard poll deltas: the viewed transcript and the session list go out as changes since the dashboard's last rev.
import { randomBytes } from 'node:crypto';
// Content comparison without serializing: snapshot() copies a value's objects and arrays, sharing its leaves (strings
// included), so a copy costs object headers only. same() compares a live value with a snapshot under JSON.stringify's
// rules (own enumerable keys in order; undefined, functions and symbols left out, or null in arrays; non-finite numbers
// as null; toJSON values by their JSON), so it is true only when their JSON is equal (for JSON-shaped values, exactly
// then; a toJSON() that gives undefined counts as changed, one extra send), and an unchanged string compares
// by reference without reading its text. A "__proto__" key (JSON.parse makes it an own key) is defined on the copy, not
// set as its prototype, which never compared equal. fields() and sameFields() do an object's fields, leaving out the keys
// in `drop` (a session summary's transcript and /btw answers). Kept as their JSON instead: toJSON values, other objects
// that are not plain (a boxed 5 or a Map has no keys to compare), and values nested over 100 deep (the walk recurses,
// and would overflow the stack at about 3,100 levels in Node, before JSON.stringify's 4,100).
class Frozen{constructor(json){this.json=json;}}
const skip=v=>v===undefined||typeof v==='function'||typeof v==='symbol',leaf=v=>(typeof v==='number'&&!Number.isFinite(v))||skip(v)?null:v,own=Object.prototype.hasOwnProperty;
const byJson=(v,d,p)=>typeof v.toJSON==='function'||d>100||!Array.isArray(v)&&(p=Object.getPrototypeOf(v))!==Object.prototype&&p!==null;
function snapshot(v,d=0){if(v===null||typeof v!=='object')return leaf(v);if(byJson(v,d))return new Frozen(JSON.stringify(v));
 if(Array.isArray(v)){const a=new Array(v.length);for(let i=0;i<v.length;i++)a[i]=snapshot(v[i],d+1);return a;}return fields(v,undefined,d+1);}
function fields(v,drop,d=0){const o={};for(const k in v){if(!own.call(v,k)||drop?.has(k))continue;const x=v[k];if(skip(x))continue;if(k==='__proto__')Object.defineProperty(o,k,{value:snapshot(x,d),enumerable:true,writable:true,configurable:true});else o[k]=snapshot(x,d);}return o;}
function same(live,snap){if(live===null||typeof live!=='object')return (snap===null||typeof snap!=='object')&&leaf(live)===snap;
 if(snap===null||typeof snap!=='object')return false;if(snap instanceof Frozen)return JSON.stringify(live)===snap.json;if(byJson(live,0))return false;
 if(Array.isArray(live)){if(!Array.isArray(snap)||snap.length!==live.length)return false;for(let i=0;i<live.length;i++)if(!same(live[i],snap[i]))return false;return true;}
 return !Array.isArray(snap)&&sameFields(live,snap);}
function sameFields(live,snap,drop){let n=0;const sk=Object.keys(snap);
 for(const k in live){if(!own.call(live,k)||drop?.has(k))continue;const x=live[k];if(skip(x))continue;if(sk[n]!==k||!same(x,snap[k]))return false;n++;}return n===sk.length;}
export function createSync(ctx){
 const {store}=ctx;
 // A viewed transcript (up to 600 messages, megabytes) changes on almost every poll while its session streams, and the
 // poll's ETag covers the whole store, so any session streaming anywhere made every dashboard download the transcript it
 // views again, every 1.2 s. Dashboards that send since=<epoch>.<rev> get only the messages that changed after that rev,
 // plus the message order when it changed (with od=1, an edit of the order they hold: see orderEdit), and merge them
 // into their copy. Each poll compares the viewed session's messages one by one with their snapshots from the previous
 // poll of that session (by any dashboard): changed and new messages take the next rev. Comparing content means no
 // change slips by, wherever in the companion it was made.
 // Serializing every message for it instead cost 5-6 ms a poll and 2 MB of garbage on a 600-message transcript.
 // An unknown epoch (first poll, an evicted entry, a restarted companion) gets the full transcript. Null when message IDs
 // are missing or repeated: that transcript is sent whole.
 const txSync=new Map();
 // The order (600 IDs: ~23 KB, ~12 KB gzipped) was most of a streaming poll's bytes: nearly every poll that adds a
 // message sent it whole. A dashboard that sends od=1 gets an edit of the order it holds instead: drop its first `drop`
 // IDs, then replace the `del` IDs at `at` with `add`; n is the new length, for the dashboard to check. The order held at
 // rev r is the one recorded at the latest order change at or before r (also the order of a whole transcript sent at r).
 // The last 8 are kept (c.orders: the arrays c.order held, nothing copied), for a few changes between polls, dashboards
 // at different revs and a switch back to a session viewed before. One splice past a dropped front covers what streaming
 // does: appends, the 600 cap's drops, inserts before unread steers, a cancelled steer's removal, a read steer moved up.
 // The order goes out whole when the one held is older than the history, and when the edit would add a quarter of the
 // IDs or more (a reset, a reorder that moves many): not much smaller then.
 function orderEdit(h,n){const k=Math.max(0,h.indexOf(n[0])),len=h.length-k;let p=0,q=0;
  while(p<len&&p<n.length&&h[k+p]===n[p])p++;while(q<len-p&&q<n.length-p&&h[h.length-1-q]===n[n.length-1-q])q++;
  const add=n.slice(p,n.length-q);return add.length*4<n.length?{drop:k,at:p,del:len-p-q,add,n:n.length}:null;}
 function transcriptDelta(s,since,od=false){
  const list=s.messages||[],ids=new Set();
  for(const m of list){if(typeof m?.id!=='string'||ids.has(m.id)){txSync.delete(s.id);return null;}ids.add(m.id);}
  const c=txSync.get(s.id)||{epoch:randomBytes(6).toString('base64url'),rev:0,orderRev:0,order:[],orders:[],entries:new Map()};
  txSync.delete(s.id);txSync.set(s.id,c);if(txSync.size>8)txSync.delete(txSync.keys().next().value);
  const entries=new Map(),next=c.rev+1;let changed=false,reordered=list.length!==c.order.length;
  for(let i=0;i<list.length;i++){const m=list[i],prev=c.entries.get(m.id);
   if(prev&&same(m,prev.snap))entries.set(m.id,prev);else{entries.set(m.id,{snap:snapshot(m),rev:next});changed=true;}
   if(c.order[i]!==m.id)reordered=true;}
  if(changed||reordered)c.rev=next;
  if(reordered){c.orderRev=next;c.order=[...ids];c.orders.push({rev:next,order:c.order});if(c.orders.length>8)c.orders.shift();}
  c.entries=entries;
  const held=/^([\w-]{1,32})\.(\d{1,15})$/.exec(since||''),rev=held?.[1]===c.epoch?Number(held[2]):-1;
  if(!(rev>=0&&rev<=c.rev))return {delta:false,tx:{session:s.id,epoch:c.epoch,rev:c.rev}};
  let edit=null;if(od&&c.orderRev>rev)for(let i=c.orders.length-1;i>=0;i--)if(c.orders[i].rev<=rev){edit=orderEdit(c.orders[i].order,c.order);break;}
  return {delta:true,tx:{session:s.id,epoch:c.epoch,rev:c.rev,...(c.orderRev>rev?edit?{orderEdit:edit}:{order:c.order}:{}),changed:list.filter(m=>entries.get(m.id).rev>rev)}};
 }
 // The session list and the rest of the store go out as changes too. A full reply with 400 sessions was ~600 KB (~180 KB
 // gzipped) and went out on every poll, every 1.2 s per dashboard while any session worked, though only the working
 // sessions' summaries had changed. Each poll compares every session's summary (all but its transcript and /btw answers,
 // which go out on their own) with its snapshot from the previous poll, like the viewed transcript, and the store's other
 // fields (top) with their previous JSON. A dashboard that sends store=<epoch>.<rev> gets the summaries that changed after
 // that rev, the order when it changed and top when it changed; an unknown epoch or rev gets everything. Returned
 // serialized; only the summaries that go out are serialized, each once while it is unchanged (a full reply, a dashboard's
 // first, sends all 400: comparing and then serializing them all cost more than the old serialize-and-compare). Null when
 // session IDs repeat, which only the full list can show.
 const storeSync={epoch:randomBytes(6).toString('base64url'),rev:0,top:'',topRev:0,order:[],orderRev:0,entries:new Map()},unsent=new Set(['messages','_btw']);
 function storeDelta(top,since){
  const c=storeSync,next=c.rev+1,entries=new Map(),order=[];let changed=false;
  for(const s of store.sessions){if(entries.has(s.id))return null;
   const prev=c.entries.get(s.id);
   if(prev&&sameFields(s,prev.snap,unsent))entries.set(s.id,prev);else{entries.set(s.id,{snap:fields(s,unsent),rev:next});changed=true;}
   order.push(s.id);}
  const topJson=JSON.stringify(top);if(topJson!==c.top){c.top=topJson;c.topRev=next;changed=true;}
  if(order.length!==c.order.length||order.some((id,i)=>id!==c.order[i])){c.order=order;c.orderRev=next;changed=true;}
  if(changed)c.rev=next;
  c.entries=entries;
  const held=/^([\w-]{1,32})\.(\d{1,15})$/.exec(since||''),rev=held?.[1]===c.epoch?Number(held[2]):-1,all=!(rev>=0&&rev<=c.rev),out=[];
  for(const s of store.sessions){const e=entries.get(s.id);if(all||e.rev>rev)out.push(e.json??=JSON.stringify({...s,messages:undefined,_btw:undefined}));}
  return `{"epoch":"${c.epoch}","rev":${c.rev}${all||c.topRev>rev?`,"top":${c.top}`:''}${all||c.orderRev>rev?`,"order":${JSON.stringify(c.order)}`:''},"changed":[${out.join(',')}]}`;
 }
 return {transcriptDelta,storeDelta};
}
