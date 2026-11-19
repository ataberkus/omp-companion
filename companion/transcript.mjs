// OMP session files (.jsonl) read into panel messages: session heads, tails, context use, background jobs, tool
// records and diffs, advisor/collab cards, the session tree and user prompts.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { now, contentText, clip } from './util.mjs';
import { toolImages } from './images.mjs';
import { splitPdfRefs, attachedText } from './pdfs.mjs';
export function advisorMessage(m,id,at){
 if(m.customType!=='advisor'||m.display!==true||!Array.isArray(m.details?.notes))return null;
 const notes=m.details.notes.slice(0,32).filter(n=>typeof n?.note==='string'&&n.note.trim()).map(n=>({note:n.note.slice(0,10000),severity:['nit','concern','blocker'].includes(n.severity)?n.severity:'nit',...(typeof n.advisor==='string'?{advisor:n.advisor.slice(0,80)}:{})}));
 return notes.length?{id,role:'advisor',text:notes.map(n=>n.note).join('\n').slice(-100000),notes,at}:null;
}
// OMP's /tan breadcrumb (pi-tui background-tan-message.ts): one line; the system-notice content is for the model only.
export function tanMessage(m,id,at){
 if(m.customType!=='background-tan-dispatch'||m.display!==true)return null;
 const work=String(m.details?.work||'').replace(/\s+/g,' ').trim();
 return {id,role:'system',text:`Tangent dispatched [task] ${String(m.details?.jobId||'unknown')}${work?` — ${work.length>56?work.slice(0,55)+'…':work}`:''}`,at};
}
// billion-context's /acp, /acp-cache and /acp-rule reports (pi.sendMessage with customType bili-*): shown as a system note.
export function biliMessage(m,id,at){
 if(typeof m?.customType!=='string'||!m.customType.startsWith('bili-')||m.display!==true)return null;
 const text=contentText(m.content).trim();
 return text?{id,role:'system',text:text.slice(-100000),at}:null;
}
// A collab guest's prompt as OMP stores it on the host (a `collab-prompt` custom message): a user message with its author.
export const collabPrompt=(m,id,at)=>{if(m?.customType!=='collab-prompt')return null;const own=splitPdfRefs(contentText(m.content).trim()),text=own.text.trim(),hasImage=Array.isArray(m.content)&&m.content.some(c=>c?.type==='image');return text||hasImage||own.pdfs.length?{id,role:'user',text:attachedText(text.slice(-100000),hasImage,own.pdfs),hasImage,...(own.pdfs.length?{pdfs:own.pdfs}:{}),at,from:String(m.details?.from||'Guest').slice(0,80)}:null;};
// Transcripts keep only their newest messages; a long autonomous run can push the user's prompt out of that window.
// capMessages returns a new array of the newest `limit` (callers such as backfillEntries detect a transcript change by
// identity) and records a dropped message of the user's on `into` (promptTrimmed: a session, or an import's info
// object), so hasPrompt still knows the session was prompted. Persisted on the session: it outlives restarts.
export const MESSAGE_LIMIT=600;
const isPrompt=m=>m?.role==='user';
export function capMessages(into,list,limit=MESSAGE_LIMIT){
 if(list.length>limit&&list.slice(0,-limit).some(isPrompt))into.promptTrimmed=true;
 return list.slice(-limit);
}
// Whether the session has had a prompt of the user's: one in its transcript, or one trimmed out of it. Fresh sessions
// (none sent, a /btw only) have neither. Mark done, Edit last / Regenerate and first-launch-only flags follow it.
export const hasPrompt=s=>!!s.promptTrimmed||!!s.messages?.some(isPrompt);
// Background jobs (async bash, task subagents) as recorded in a session transcript. Scans append-only files incrementally.
// The 32 files scanned last are kept (each holds its jobs' task text and output, ~1-3 MB for a task-heavy session); an
// evicted one is scanned again from the start, which gives the same jobs in the same order.
const jobScans=new Map();
export async function scanJobs(file){
 let st;try{st=await fs.stat(file);}catch{return [];}
 let c=jobScans.get(file);if(!c||st.size<c.offset)c={offset:0,calls:new Map(),jobs:new Map(),order:0};
 // Two scans of one file can overlap (two dashboards polling it): each reads from the same offset, and only the first to
 // finish applies its lines, or the second would apply them again and move the offset past lines it never read. The
 // offset is taken before the open: one moved meanwhile, past this scan's older stat, made a negative length (RangeError).
 if(st.size>c.offset){const from=c.offset,n=st.size-from;const fh=await fs.open(file,'r');try{
  const buf=Buffer.alloc(n);await fh.read(buf,0,n,from);const end=buf.lastIndexOf(10);
  if(end>=0&&c.offset===from){for(const line of buf.subarray(0,end).toString('utf8').split('\n'))scanJobLine(c,line);c.offset=from+end+1;}
 }finally{await fh.close();}}
 jobScans.delete(file);jobScans.set(file,c);if(jobScans.size>32)jobScans.delete(jobScans.keys().next().value);
 return [...c.jobs.values()].sort((a,b)=>a.order-b.order);
}
const jobStatus=v=>{v=String(v||'').toLowerCase();return /fail|error|abort/.test(v)?'error':/cancel|kill/.test(v)?'cancelled':/run|pend|queue|start/.test(v)?'running':'done';};
// A notice covering several jobs has one "── Job <id> …" section each.
const jobSection=(text,id)=>{const parts=text.split(/\n(?=── Job )/);return parts.find(p=>p.startsWith(`── Job ${id} `)||p.startsWith(`── Job ${id}\n`))||text;};
function scanJobLine(c,line){
 const call=line.includes('"toolCall"')&&(line.includes('"async":true')||line.includes('"name":"task"'));
 const result=line.includes('"toolResult"')&&(line.includes('"async":{')||line.includes('"toolName":"task"')||line.includes('"jobs":['));
 const done=line.includes('"async-result"');if(!call&&!result&&!done)return;
 let f;try{f=JSON.parse(line);}catch{return;}const at=f.timestamp||now();const m=f.message||{};
 if(call&&m.role==='assistant')for(const p of Array.isArray(m.content)?m.content:[]){if(p?.type!=='toolCall')continue;const a=p.arguments||{};
  if(p.name==='task'||a.async===true)c.calls.set(p.id,{name:p.name,intent:String(p.intent||a.i||''),command:typeof a.command==='string'?a.command.slice(0,2000):'',tasks:Array.isArray(a.tasks)?a.tasks:[],at});}
 // A call is needed until its result: OMP writes one per call (agent-loop's resultEmitted), and the other results that
 // reuse an id (an ask re-answered, a pending call's synthetic result on a new branch) carry no job progress to name.
 if(result&&m.role==='toolResult'){const d=m.details||{};const info=c.calls.get(m.toolCallId)||{};c.calls.delete(m.toolCallId);const put=(id,job)=>{const prev=c.jobs.get(id);c.jobs.set(id,{...prev,...job,id,order:prev?.order??++c.order});};
  if(m.toolName==='task'||d.async?.type==='task'){const prog=Array.isArray(d.progress)?d.progress:[];const results=Array.isArray(d.results)?d.results:[];
   for(const [i,p] of prog.entries()){const id=String(p.id||info.tasks?.[i]?.name||`task-${i}`);const r=results.find(r=>r?.id===p.id||r?.index===p.index);const spec=info.tasks?.find(t=>t?.name===p.id)||{};
    put(id,{type:'task',agent:String(p.agent||'task'),title:String(p.description||spec.description||spec.name||id).slice(0,300),task:String(p.task||spec.task||'').slice(0,6000),intent:info.intent,toolCallId:m.toolCallId,startedAt:info.at||at,status:d.async?'running':(m.isError||r?.exitCode>0||/fail|error|abort/i.test(String(r?.status||p.status||'')))?'error':'done',finishedAt:d.async?undefined:at,durationMs:d.async?undefined:(r?.durationMs??d.totalDurationMs),output:d.async?'':clip(r?.output??r?.result??'',8000)});}}
  // A snapshot of job states: under `jobs`, or under `proc.jobs` in the result of a `write proc://<id>/kill` (a cancel).
  else if(Array.isArray(d.jobs??d.proc?.jobs)){for(const j of d.jobs??d.proc.jobs){const id=String(j?.id||j?.jobId||'');const prev=c.jobs.get(id);if(!prev)continue;const status=jobStatus(j.status);
   c.jobs.set(id,{...prev,status,durationMs:j.durationMs??prev.durationMs,model:j.resolvedModel||prev.model,finishedAt:status==='running'?prev.finishedAt:(prev.finishedAt||at),output:j.resultText?clip(j.resultText,8000):prev.output});}}
  else if(d.async?.jobId)put(String(d.async.jobId),{type:String(d.async.type||info.name||'bash'),title:info.intent||(info.command||'').slice(0,120)||String(d.async.jobId),command:info.command,intent:info.intent,toolCallId:m.toolCallId,startedAt:info.at||at,status:'running'});}
 if(done&&f.customType==='async-result'){const text=typeof f.content==='string'?f.content:contentText(f.content);
  for(const j of Array.isArray(f.details?.jobs)?f.details.jobs:[]){const id=String(j.jobId||'');if(!id)continue;const prev=c.jobs.get(id)||{id,type:String(j.type||'bash'),title:String(j.label||id),order:++c.order,startedAt:at};
   c.jobs.set(id,{...prev,status:jobStatus(j.status||j.state||'completed'),finishedAt:at,durationMs:j.durationMs,label:String(j.label||''),output:clip(jobSection(text.replace(/^<system-notice>\s*/,'').replace(/<\/system-notice>\s*$/,''),id),8000)});}}
}
export const THINKING=['off','minimal','low','medium','high','xhigh','max','auto'];
export const thinkingText=content=>Array.isArray(content)?content.filter(c=>c?.type==='thinking'&&c.thinking).map(c=>c.thinking).join('\n\n'):'';
// Tool calls are stored structured ({tool:{name,intent,args,result,status}}); `text` retains a plain summary for session history.
const writeFiles=(name,args)=>{if(name!=='write'||typeof args?.content!=='string'||/^[a-z][\w+.-]+:\/\//i.test(String(args.path||'')))return undefined;const lines=args.content.slice(0,60000).split('\n');return [{path:String(args.path||args.file_path||''),op:'write',diff:lines.map((l,i)=>`+${i+1}|${l}`).join('\n')+(args.content.length>60000?'\n… (content truncated)':'')}];};
export const toolRecord=(name,args,intent)=>{const t={name:String(name||'tool'),intent:typeof intent==='string'?intent:typeof args?.i==='string'?args.i:'',args:clip(name==='write'&&typeof args?.content==='string'?{...args,content:`(${args.content.split('\n').length} lines, shown as a diff)`}:args,6000),status:'running'};const files=writeFiles(name,args);if(files)t.files=files;return t;};
// OMP edit results carry a line-numbered diff (" N|ctx", "-N|old", "+N|new"), per file for multi-file patches.
export const editFiles=d=>{if(!d||typeof d!=='object')return undefined;const list=Array.isArray(d.perFileResults)&&d.perFileResults.length?d.perFileResults:typeof d.diff==='string'?[d]:[];let budget=60000;const out=[];
 for(const f of list.slice(0,30)){if(typeof f?.diff!=='string'||budget<=0)continue;const diff=f.diff.length>budget?f.diff.slice(0,budget)+'\n… (diff truncated)':f.diff;budget-=diff.length;out.push({path:String(f.path||d.path||''),op:String(f.op||d.op||''),diff});}
 return out.length?out:undefined;};
export const toolSummary=t=>`${t.status==='running'?'':t.status==='error'?'Error · ':'Done · '}${t.name}  ${t.intent||t.args.slice(0,300)}`;
// `!command` runs from the composer: OMP records them as bashExecution messages ({command, output, exitCode, cancelled}).
export const shellRecord=(command,r)=>{const t=toolRecord('bash',{command:String(command||'')},'You ran this command');t.user=true;if(r){t.status=r.cancelled||(typeof r.exitCode==='number'&&r.exitCode!==0)?'error':'done';t.result=clip(String(r.output||'')+(r.cancelled?'\n(cancelled)':typeof r.exitCode==='number'&&r.exitCode!==0?`\n(exit code ${r.exitCode})`:''),8000);}return t;};
// Native OMP session files: a fixed-width {type:'title'} slot on the first line (rewritten in place on every rename),
// then {type:'session',cwd,id,timestamp,title?,parentSession?}; model, level and title changes can appear anywhere.
// `reasoning` is the level the session last ran with: the spawn's ":level" suffix, a level change, or the effort sent with a request ("auto" resolves there).
function scanModel(head,f){
 if(f.type==='model_change'&&f.model)head.model=String(f.model).replace(/:.*$/,'');
 else if(f.type==='thinking_level_change'&&f.thinkingLevel)head.thinking=head.reasoning=f.thinkingLevel;
 else if(f.type==='session_init'){const l=String(f.resolvedModel||'').split(':').pop();if(l!=='auto'&&THINKING.includes(l))head.reasoning=l;}
 else if(f.type==='message'&&f.message?.role==='assistant'){const m=f.message;if(m.provider&&m.model)head.model=`${m.provider}/${m.model}`;const e=m.requestControls?.effort?.topLevel;if(typeof e==='string'&&e)head.reasoning=e;}
}
// scanModel over the tail's lines newest first, each field set by the newest frame that carries it (what scanning them in
// order leaves), and the newest title change. Only lines that can carry one are parsed: a 256 KB tail is mostly tool output.
function scanTail(head,lines){
 const got={};
 for(let i=lines.length-1;i>=0;i--){const line=lines[i];
  const kind=line.includes('"title_change"')?'title':line.includes('"model_change"')||line.includes('"thinking_level_change"')||line.includes('"session_init"')?'model':!(got.model&&got.reasoning)&&line.includes('"role":"assistant"')?'model':'';
  if(!kind||(kind==='title'&&got.title))continue;let f;try{f=JSON.parse(line);}catch{continue;}
  if(f.type==='title_change'&&typeof f.title==='string'){got.title=true;head._change={title:f.title,at:f.timestamp||''};continue;}
  const was={model:head.model,thinking:head.thinking,reasoning:head.reasoning};scanModel(head,f);
  for(const k of ['model','thinking','reasoning']){if(head[k]===was[k])continue;if(got[k])head[k]=was[k];else got[k]=true;}
 }
 return got;
}
// A title as OMP's session list shows it (session-listing.ts sanitizeSessionName): its first line, no control characters.
export const cleanTitle=v=>typeof v==='string'?v.split(/\r?\n/)[0].replace(/[\x00-\x1F\x7F]/g,'').trim():'';
// The newest frame timestamp in a tail (scanned from the end): a session's real last activity, independent of the file's
// mtime. Frames are appended in time order, so the first line from the end that carries a top-level string timestamp is the
// newest; a few trailing lines without one (a cut final line, a frame OMP wrote without a timestamp) are skipped.
function newestAt(lines){for(let i=lines.length-1,tries=0;i>=0&&tries<60;i--){const line=lines[i];if(!line)continue;tries++;let f;try{f=JSON.parse(line);}catch{continue;}if(f&&typeof f.timestamp==='string')return f.timestamp;}return '';}
// The start of a user prompt from a line the read window cut off (a first prompt longer than 64 KB): its first string.
function cutPrompt(line){
 const r=line.indexOf('"role":"user"');if(r<0)return '';
 const at=[line.indexOf('"text":"',r),line.indexOf('"content":"',r)].filter(i=>i>=0);if(!at.length)return '';
 const start=line.indexOf(':"',Math.min(...at))+2;let j=start;
 while(j<line.length&&j-start<4000){const ch=line[j];if(ch==='"')break;if(ch==='\\'){const n=line[j+1]==='u'?6:2;if(j+n>line.length)break;j+=n;}else j++;}
 try{return JSON.parse('"'+line.slice(start,j)+'"');}catch{return '';}
}
// title: the one OMP's resume list shows. The first-line slot when the file has one (an empty slot: no title), unless a
// title change is newer than the slot; a legacy file without a slot takes its newest title change, then its header's.
// parent: the session file this one was forked from (header parentSession). id stays empty while OMP has not written the
// header yet (a file it is creating). updatedAt: the newest activity time — the newest frame timestamp or the slot's
// updatedAt (a rename bumps it in place) — which a file's mtime trails when OMP holds the file open; on Windows the write
// time is not flushed to disk until the handle closes, so a session continued in a terminal for days keeps an old mtime.
export async function readSessionHead(file){
 const fh=await fs.open(file,'r');try{const size=(await fh.stat()).size;const buf=Buffer.alloc(Math.min(64*1024,size));const {bytesRead}=await fh.read(buf,0,buf.length,0);
  const head={title:'',cwd:'',id:'',createdAt:'',updatedAt:'',preview:'',model:'',thinking:'',reasoning:'',parent:''};let slot,header;
  for(const line of buf.subarray(0,bytesRead).toString('utf8').split('\n').slice(0,80)){let f;try{f=JSON.parse(line);}catch{if(!head.preview&&line.startsWith('{"type":"message"'))head.preview=cutPrompt(line).slice(0,240);continue;}
   if(f?.type==='title'&&typeof f.title==='string'){slot={title:f.title,at:f.updatedAt||''};if(typeof f.updatedAt==='string'&&f.updatedAt>head.updatedAt)head.updatedAt=f.updatedAt;}
   else if(f?.type==='title_change'&&typeof f.title==='string')head._change={title:f.title,at:f.timestamp||''};
   else if(f?.type==='session'&&!header){header=f;head.cwd=typeof f.cwd==='string'?f.cwd:'';head.id=typeof f.id==='string'?f.id:'';head.createdAt=typeof f.timestamp==='string'?f.timestamp:'';head.parent=typeof f.parentSession==='string'?f.parentSession:'';}
   else if(f?.type==='message'&&f.message?.role==='user'&&!head.preview)head.preview=contentText(f.message.content).slice(0,240);
   if(f&&typeof f==='object'){scanModel(head,f);if(typeof f.timestamp==='string'&&f.timestamp>head.updatedAt)head.updatedAt=f.timestamp;}}
  // The last 32 KB usually holds the last reply's model and the newest frame's time; up to 256 KB is read only when the
  // model is not there (a long final turn). Both tail reads end at EOF, so either sees the newest frame.
  if(size>buf.length){const keep={model:head.model,thinking:head.thinking,reasoning:head.reasoning,_change:head._change};
   for(const n of [32*1024,256*1024]){const len=Math.min(n,size-buf.length);Object.assign(head,keep);const tail=Buffer.alloc(len);const r=await fh.read(tail,0,len,size-len);
    const lines=tail.subarray(0,r.bytesRead).toString('utf8').split('\n').slice(1);const at=newestAt(lines);if(at>head.updatedAt)head.updatedAt=at;
    if(scanTail(head,lines).model||len<n)break;}}
  if(!head.updatedAt)head.updatedAt=head.createdAt;
  const change=head._change;delete head._change;
  head.title=cleanTitle(change&&(!slot||change.at>slot.at)?change.title:slot?slot.title:change?change.title:header?.title);
  return head;}finally{await fh.close();}
}
export async function readTail(file,max){const fh=await fs.open(file,'r');try{const {size}=await fh.stat();const n=Math.min(size,max);const buf=Buffer.alloc(n);await fh.read(buf,0,n,size-n);const t=buf.toString('utf8');return n<size?t.slice(t.indexOf('\n')+1):t;}finally{await fh.close();}}
// Tokens the model saw on its last turn, i.e. how full the context window is.
export const usageTokens=u=>u&&typeof u==='object'?(u.input||0)+(u.cacheRead||0)+(u.cacheWrite||0)+(u.output||0):undefined;
export async function lastContext(file){
 const lines=(await readTail(file,4*1024*1024)).split('\n');
 for(let i=lines.length-1;i>=0;i--){if(!lines[i].includes('"usage"'))continue;let f;try{f=JSON.parse(lines[i]);}catch{continue;}const m=f.message||{};if(f.type==='message'&&m.role==='assistant'&&usageTokens(m.usage))return usageTokens(m.usage);if(f.type==='compaction')return undefined;}
 return undefined;
}
// The last `limit` messages of a session file, from its last 12 MB (readTail's lines). Read and parsed in two steps: the
// last limit × 8 KB first, which usually holds them (reading and parsing all 12 MB to keep 150 blocked the event loop for
// 60-110 ms on a large file), and the rest only when those lines yield fewer and hold no context reset. Exact: a message
// of the shorter tail is built from its own lines (a tool's result follows its call), and what they cannot see (calls,
// results and context resets further up) touches only messages that are cut anyway, or cleared by a reset they hold.
// A caller that asks whether a prompt was cut (info.promptTrimmed: a resume or a session switch, once each) gets the whole
// 12 MB parsed, as before: a prompt further up is out of the shorter tail's sight. Previews and transcripts never ask.
export async function importMessages(file,limit=400,stash,info){
 const parse=(buf,cut)=>{const frames=[];if(cut)buf=buf.subarray(buf.indexOf(10)+1);for(const line of buf.toString('utf8').split('\n')){try{frames.push(JSON.parse(line));}catch{}}return frames;};
 const fh=await fs.open(file,'r');try{
  const {size}=await fh.stat(),start=Math.max(0,size-12*1024*1024),at=limit>0&&!info?Math.max(start,size-limit*8192):start;
  const tail=Buffer.alloc(size-at);await fh.read(tail,0,tail.length,at);
  if(at===start)return entryMessages(parse(tail,at>0),limit,stash,info);
  // The shorter tail starts after its first newline; the rest of the 12 MB ends there.
  const nl=tail.indexOf(10),end=nl<0?size:at+nl+1,frames=parse(tail.subarray(end-at),false);
  const kept=entryMessages(frames,limit);if(kept.length>=limit||frames.some(f=>f?.type==='reset_boundary'))return stash?entryMessages(frames,limit,stash):kept;
  const head=Buffer.alloc(end-start);await fh.read(head,0,head.length,start);
  return entryMessages([...parse(head,start>0),...frames],limit,stash);
 }finally{await fh.close();}
}
// OMP session entries (file lines or get_entries) as thread messages; user prompts keep their entry ID for branching.
// stash stores tool-result images ([{mimeType,bytes}] → [{mimeType,id}]); without it they are left out. info.promptTrimmed
// is set when a prompt of the user's falls outside the newest `limit` messages (capMessages).
export function entryMessages(frames,limit=400,stash,info={}){
 const out=[];const tools=new Map(),shots=new Map();
 for(const f of frames){
  // OMP's /clear: the model's context starts after the latest boundary, and so does the transcript (as in OMP's TUI).
  if(f?.type==='reset_boundary'){out.length=0;tools.clear();shots.clear();out.push({id:f.id||randomUUID(),role:'system',text:'Context reset (/clear): earlier messages are no longer in the model’s context; the session file keeps them.',at:f.timestamp||now()});continue;}
  if(f?.type!=='message'&&f?.type!=='custom_message')continue;const m=f.type==='custom_message'?f:f.message||{};const at=f.timestamp||now();
  // A prompt's PDFs are its trailing "Attached PDF:" lines (pdfs.mjs): shown as chips, not as text.
  if(m.role==='user'){const agent=m.synthetic&&m.attribution==='agent',raw=contentText(m.content).trim(),own=agent?{text:raw,pdfs:[]}:splitPdfRefs(raw),v=own.text.trim(),hasImage=Array.isArray(m.content)&&m.content.some(c=>c?.type==='image');if(v||hasImage||own.pdfs.length)out.push({id:f.id||randomUUID(),role:agent?'advisor-update':'user',text:attachedText(v.slice(-100000),hasImage,own.pdfs),hasImage,...(own.pdfs.length?{pdfs:own.pdfs}:{}),at,...(f.type==='message'&&f.id&&!agent?{entryId:String(f.id)}:{})});}
  else if(m.role==='assistant'){
   const th=thinkingText(m.content).trim();if(th)out.push({id:(f.id||randomUUID())+'-think',role:'thinking',text:th.slice(-40000),at,sourceTimestamp:m.timestamp});
   const v=contentText(m.content).trim();if(v)out.push({id:f.id||randomUUID(),role:'assistant',text:v.slice(-100000),at,model:m.provider&&m.model?`${m.provider}/${m.model}`:undefined});
   for(const c of Array.isArray(m.content)?m.content:[])if(c?.type==='toolCall'){const tool=toolRecord(c.name,c.arguments,c.intent);tool.status='done';const msg={id:'tool-'+c.id,role:'tool',tool,text:toolSummary(tool),at};tools.set(c.id,msg);out.push(msg);}
  }
  else if(f.type==='custom_message'||m.role==='custom'){const card=collabPrompt(m,f.id||randomUUID(),at)||advisorMessage(m,f.id||randomUUID(),at)||tanMessage(m,f.id||randomUUID(),at)||biliMessage(m,f.id||randomUUID(),at);if(card)out.push(card);}
  else if(m.role==='toolResult'){const msg=tools.get(m.toolCallId);if(msg){msg.tool.result=clip(contentText(m.content),8000);msg.tool.status=m.isError?'error':'done';const files=editFiles(m.details);if(files)msg.tool.files=files;msg.text=toolSummary(msg.tool);if(stash)shots.set(msg,m.content);}}
  else if(m.role==='bashExecution'){const tool=shellRecord(m.command,m);out.push({id:'tool-'+(f.id||randomUUID()),role:'tool',tool,text:toolSummary(tool),at});}
 }
 const kept=capMessages(info,out,limit);
 // Only messages that are kept get their images decoded and stored.
 for(const msg of kept){const content=shots.get(msg);if(!content)continue;const images=toolImages(content);if(images.length)msg.tool.images=stash(images);}
 return kept;
}
// OMP's session tree, flattened for display. Indentation grows only where the conversation forks.
export function treeView(r){
 const leaf=r?.leafId||null,parents=new Map(),nodes=[];const stack=(Array.isArray(r?.tree)?r.tree:[]).map(n=>[n,0]).reverse();
 while(stack.length&&nodes.length<3000){const [n,depth]=stack.pop();const e=n?.entry||{};parents.set(e.id,e.parentId);const kids=Array.isArray(n?.children)?n.children:[];
  const m=e.type==='message'?e.message||{}:null;let kind='',textv='';
  if(m?.role==='user'){kind='user';const own=splitPdfRefs(contentText(m.content));textv=attachedText(own.text,Array.isArray(m.content)&&m.content.some(c=>c?.type==='image'),own.pdfs);}
  else if(m?.role==='assistant'){kind='assistant';textv=contentText(m.content).trim()||(Array.isArray(m.content)?'Tools: '+m.content.filter(c=>c?.type==='toolCall').map(c=>c.name).join(', '):'');}
  else if(e.type==='compaction'){kind='compaction';textv='Context compacted';}
  else if(e.type==='branch_summary'){kind='branch';textv=String(e.summary||'Branch summary');}
  if(kind)nodes.push({id:String(e.id),kind,text:textv.slice(0,300),at:e.timestamp,label:n.label?String(n.label).slice(0,80):undefined,depth,forks:kids.length>1?kids.length:undefined});
  const next=kids.length>1?depth+1:depth;for(let i=kids.length-1;i>=0;i--)stack.push([kids[i],next]);
 }
 const path=new Set();for(let id=leaf;id&&!path.has(id);id=parents.get(id))path.add(id);
 for(const n of nodes)n.onPath=path.has(n.id);
 return {leafId:leaf,nodes,truncated:nodes.length>=3000};
}
// A user message entry's prompt as OMP's branch reads it: text parts joined, image parts kept. Advisor updates are not the user's.
export function entryPrompt(e){
 const m=e?.type==='message'?e.message:null;if(m?.role!=='user'||(m.synthetic&&m.attribution==='agent'))return null;
 const parts=Array.isArray(m.content)?m.content:[{type:'text',text:String(m.content??'')}];
 return {entryId:String(e.id),text:parts.filter(c=>c?.type==='text').map(c=>c.text).join(''),images:parts.filter(c=>c?.type==='image'&&typeof c.data==='string'&&typeof c.mimeType==='string').map(c=>({type:'image',mimeType:c.mimeType,data:c.data}))};
}
// From get_entries: entryId's prompt, or without one the newest prompt on OMP's active path (leaf back to the root).
export function userPrompt(r,entryId){
 const byId=new Map((Array.isArray(r?.entries)?r.entries:[]).map(e=>[e?.id,e]));
 if(entryId!==undefined)return entryPrompt(byId.get(entryId));
 for(let id=r?.leafId,seen=new Set();id&&!seen.has(id);id=byId.get(id)?.parentId){seen.add(id);const p=entryPrompt(byId.get(id));if(p)return p;}
 return null;
}
