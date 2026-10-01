import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RpcProcess } from './rpc.mjs';
const exec=promisify(execFile);
const now=()=>new Date().toISOString();
const colors=['#e8a16a','#93a9ee','#80bca4','#b59bd6'];
const error=(message,status=400)=>Object.assign(new Error(message),{status});
function text(value,name,max=10000){if(typeof value!=='string'||!value.trim()||value.length>max)throw error(`${name} is required (maximum ${max} characters).`);return value.trim();}
function contentText(content){if(typeof content==='string')return content;return Array.isArray(content)?content.filter(c=>c?.type==='text').map(c=>c.text).join('\n'):'';}
function parseAdvisorStatus(text){
 const t=String(text||'').trim();const num=v=>v===undefined?undefined:Number(String(v).replace(/[^\d]/g,''))||0;
 if(/^Advisor (is )?disabled\./.test(t))return {enabled:false};
 if(/^Advisor enabled\.$/.test(t))return {enabled:true};
 if(/no model is assigned to the 'advisor' role/.test(t))return {enabled:true,noModel:true};
 let m=t.match(/^Advisor is enabled \(([^)]+)\)\.(?: Context: ([\d.,\s\u00a0]+) \/ ([\d.,\s\u00a0]+) tokens)?[\s\S]*?\$(\d+(?:\.\d+)?)/);
 if(m)return {enabled:true,model:m[1],contextTokens:num(m[2]),contextWindow:num(m[3]),cost:Number(m[4])||0};
 // OMP prints this only when no advisor runtime is live; after '/advisor off' it can still read "running", so it says nothing about on/off.
 if((m=t.match(/^Advisor "([^"]+)" is ([^.]+)\./)))return {name:m[1],state:m[2]};
 if((m=t.match(/^Advisors enabled \((\d+)\):/))){const models=[...t.matchAll(/\u2022 [^(\[\n]+\(([^)]+)\)/g)].map(x=>x[1]);const c=t.match(/\$([\d.]+)\.\s*$/);return {enabled:true,count:Number(m[1]),model:models.join(', '),cost:c?Number(c[1]):undefined};}
 return null;
}
function advisorMessage(m,id,at){
 if(m.customType!=='advisor'||m.display!==true||!Array.isArray(m.details?.notes))return null;
 const notes=m.details.notes.slice(0,32).filter(n=>typeof n?.note==='string'&&n.note.trim()).map(n=>({note:n.note.slice(0,10000),severity:['nit','concern','blocker'].includes(n.severity)?n.severity:'nit',...(typeof n.advisor==='string'?{advisor:n.advisor.slice(0,80)}:{})}));
 return notes.length?{id,role:'advisor',text:notes.map(n=>n.note).join('\n').slice(-100000),notes,at}:null;
}
const MAX_IMAGE_BYTES=5*1024*1024,MAX_IMAGES=6;
function chatImages(body){
 if(body.images===undefined)return [];
 if(!Array.isArray(body.images)||!body.images.length||body.images.length>MAX_IMAGES)throw error(`Attach 1 to ${MAX_IMAGES} images.`);
 const images=body.images.map(image=>{const data=image?.data;
  if(image?.type!=='image'||!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mimeType)||typeof data!=='string'||data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!data.length||data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw error('Use a PNG, JPEG, WebP or GIF image up to 5 MB.');
  const bytes=Buffer.from(data,'base64');
  const valid=image.mimeType==='image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
   :image.mimeType==='image/jpeg' ? bytes[0]===255&&bytes[1]===216&&bytes[2]===255
   :image.mimeType==='image/webp' ? bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'
   :['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
  if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||!valid)throw error('Image data does not match its file type or exceeds 5 MB.');
  return {type:'image',mimeType:image.mimeType,data};});
 // preview: one data URL or one per image; stored on the message as-is.
 const previews=body.preview===undefined?[]:[].concat(body.preview);
 if(previews.length>images.length||previews.some(p=>typeof p!=='string'||p.length>1024*1024||!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(p)))throw error('Invalid image preview.');
 return images;
}
async function git(cwd,args){return (await exec('git',['-C',cwd,...args],{timeout:15000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();}
const samePath=(a,b)=>{const n=v=>path.resolve(v||'');return process.platform==='win32'?n(a).toLowerCase()===n(b).toLowerCase():n(a)===n(b);};
async function resolveDir(value){let dir=text(value,'Directory path',4000);if(dir==='~'||dir.startsWith('~/')||dir.startsWith('~\\'))dir=path.join(os.homedir(),dir.slice(2));if(!path.isAbsolute(dir))throw error('Use an absolute directory path.');let stat;try{dir=await fs.realpath(dir);stat=await fs.stat(dir);}catch{throw error('Directory does not exist on this machine.');}if(!stat.isDirectory())throw error('Path must be a directory.');return dir;}
const exists=p=>fs.access(p).then(()=>true,()=>false);
// Keep only what the dashboard shows from OMP's subagent registry entries.
const subagentView=e=>{const p=e?.progress||{};const pick=o=>Object.fromEntries(Object.entries(o||{}).filter(([,v])=>['string','number','boolean'].includes(typeof v)).map(([k,v])=>[k,typeof v==='string'?v.slice(0,300):v]));
 return {id:String(e?.id||p.id||''),agent:String(e?.agent||''),description:String(e?.description||p.description||'').slice(0,300),status:String(e?.status||p.status||''),sessionFile:e?.sessionFile||'',parentToolCallId:e?.parentToolCallId||'',lastUpdate:e?.lastUpdate||Date.now(),progress:pick(p)};};
const goalView=g=>g?{objective:String(g.objective||'').slice(0,500),status:String(g.status||''),tokensUsed:g.tokensUsed,tokenBudget:g.tokenBudget}:undefined;
// Background jobs (async bash, task subagents) as recorded in a session transcript. Scans append-only files incrementally.
const jobScans=new Map();
async function scanJobs(file){
 let st;try{st=await fs.stat(file);}catch{return [];}
 let c=jobScans.get(file);if(!c||st.size<c.offset)c={offset:0,calls:new Map(),jobs:new Map(),order:0};
 if(st.size>c.offset){const fh=await fs.open(file,'r');try{
  const n=st.size-c.offset;const buf=Buffer.alloc(n);await fh.read(buf,0,n,c.offset);const end=buf.lastIndexOf(10);
  if(end>=0){for(const line of buf.subarray(0,end).toString('utf8').split('\n'))scanJobLine(c,line);c.offset+=end+1;}
 }finally{await fh.close();}jobScans.set(file,c);}
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
 if(result&&m.role==='toolResult'){const d=m.details||{};const info=c.calls.get(m.toolCallId)||{};const put=(id,job)=>{const prev=c.jobs.get(id);c.jobs.set(id,{...prev,...job,id,order:prev?.order??++c.order});};
  if(m.toolName==='task'||d.async?.type==='task'){const prog=Array.isArray(d.progress)?d.progress:[];const results=Array.isArray(d.results)?d.results:[];
   for(const [i,p] of prog.entries()){const id=String(p.id||info.tasks?.[i]?.name||`task-${i}`);const r=results.find(r=>r?.id===p.id||r?.index===p.index);const spec=info.tasks?.find(t=>t?.name===p.id)||{};
    put(id,{type:'task',agent:String(p.agent||'task'),title:String(p.description||spec.description||spec.name||id).slice(0,300),task:String(p.task||spec.task||'').slice(0,6000),intent:info.intent,toolCallId:m.toolCallId,startedAt:info.at||at,status:d.async?'running':(m.isError||r?.exitCode>0||/fail|error|abort/i.test(String(r?.status||p.status||'')))?'error':'done',finishedAt:d.async?undefined:at,durationMs:d.async?undefined:(r?.durationMs??d.totalDurationMs),output:d.async?'':clip(r?.output??r?.result??'',8000)});}}
  else if(Array.isArray(d.jobs)){for(const j of d.jobs){const id=String(j?.id||j?.jobId||'');const prev=c.jobs.get(id);if(!prev)continue;const status=jobStatus(j.status);
   c.jobs.set(id,{...prev,status,durationMs:j.durationMs??prev.durationMs,model:j.resolvedModel||prev.model,finishedAt:status==='running'?prev.finishedAt:(prev.finishedAt||at),output:j.resultText?clip(j.resultText,8000):prev.output});}}
  else if(d.async?.jobId)put(String(d.async.jobId),{type:String(d.async.type||info.name||'bash'),title:info.intent||(info.command||'').slice(0,120)||String(d.async.jobId),command:info.command,intent:info.intent,toolCallId:m.toolCallId,startedAt:info.at||at,status:'running'});}
 if(done&&f.customType==='async-result'){const text=typeof f.content==='string'?f.content:contentText(f.content);
  for(const j of Array.isArray(f.details?.jobs)?f.details.jobs:[]){const id=String(j.jobId||'');if(!id)continue;const prev=c.jobs.get(id)||{id,type:String(j.type||'bash'),title:String(j.label||id),order:++c.order,startedAt:at};
   c.jobs.set(id,{...prev,status:jobStatus(j.status||j.state||'completed'),finishedAt:at,durationMs:j.durationMs,label:String(j.label||''),output:clip(jobSection(text.replace(/^<system-notice>\s*/,'').replace(/<\/system-notice>\s*$/,''),id),8000)});}}
}
const THINKING=['off','minimal','low','medium','high','xhigh','max','auto'];
const clip=(v,n)=>{const s=typeof v==='string'?v:JSON.stringify(v??{},null,1);return s.length>n?s.slice(0,n)+`\n… (${s.length-n} more characters)`:s;};
const thinkingText=content=>Array.isArray(content)?content.filter(c=>c?.type==='thinking'&&c.thinking).map(c=>c.thinking).join('\n\n'):'';
// Tool calls are stored structured ({tool:{name,intent,args,result,status}}); `text` retains a plain summary for session history.
const writeFiles=(name,args)=>{if(name!=='write'||typeof args?.content!=='string'||/^[a-z][\w+.-]+:\/\//i.test(String(args.path||'')))return undefined;const lines=args.content.slice(0,60000).split('\n');return [{path:String(args.path||args.file_path||''),op:'write',diff:lines.map((l,i)=>`+${i+1}|${l}`).join('\n')+(args.content.length>60000?'\n… (content truncated)':'')}];};
const toolRecord=(name,args,intent)=>{const t={name:String(name||'tool'),intent:typeof intent==='string'?intent:typeof args?.i==='string'?args.i:'',args:clip(name==='write'&&typeof args?.content==='string'?{...args,content:`(${args.content.split('\n').length} lines, shown as a diff)`}:args,6000),status:'running'};const files=writeFiles(name,args);if(files)t.files=files;return t;};
// OMP edit results carry a line-numbered diff (" N|ctx", "-N|old", "+N|new"), per file for multi-file patches.
const editFiles=d=>{if(!d||typeof d!=='object')return undefined;const list=Array.isArray(d.perFileResults)&&d.perFileResults.length?d.perFileResults:typeof d.diff==='string'?[d]:[];let budget=60000;const out=[];
 for(const f of list.slice(0,30)){if(typeof f?.diff!=='string'||budget<=0)continue;const diff=f.diff.length>budget?f.diff.slice(0,budget)+'\n… (diff truncated)':f.diff;budget-=diff.length;out.push({path:String(f.path||d.path||''),op:String(f.op||d.op||''),diff});}
 return out.length?out:undefined;};
const toolSummary=t=>`${t.status==='running'?'':t.status==='error'?'Error · ':'Done · '}${t.name}  ${t.intent||t.args.slice(0,300)}`;
// `!command` runs from the composer: OMP records them as bashExecution messages ({command, output, exitCode, cancelled}).
const shellRecord=(command,r)=>{const t=toolRecord('bash',{command:String(command||'')},'You ran this command');t.user=true;if(r){t.status=r.cancelled||(typeof r.exitCode==='number'&&r.exitCode!==0)?'error':'done';t.result=clip(String(r.output||'')+(r.cancelled?'\n(cancelled)':typeof r.exitCode==='number'&&r.exitCode!==0?`\n(exit code ${r.exitCode})`:''),8000);}return t;};
// Native OMP session files: first lines hold {type:'title'} and {type:'session',cwd,id,timestamp}; model changes can appear anywhere.
function scanModel(head,f){
 if(f.type==='model_change'&&f.model)head.model=String(f.model).replace(/:.*$/,'');
 else if(f.type==='thinking_level_change'&&f.thinkingLevel)head.thinking=f.thinkingLevel;
 else if(f.type==='message'&&f.message?.role==='assistant'&&f.message.provider&&f.message.model)head.model=`${f.message.provider}/${f.message.model}`;
}
async function readSessionHead(file){
 const fh=await fs.open(file,'r');try{const size=(await fh.stat()).size;const buf=Buffer.alloc(64*1024);const {bytesRead}=await fh.read(buf,0,buf.length,0);const head={title:'',cwd:'',id:'',createdAt:'',preview:'',model:'',thinking:''};
  for(const line of buf.subarray(0,bytesRead).toString('utf8').split('\n').slice(0,80)){let f;try{f=JSON.parse(line);}catch{continue;}
   if(f.type==='title'&&f.title)head.title=f.title;else if(f.type==='title_change'&&f.title&&!head.title)head.title=f.title;else if(f.type==='session'){head.cwd=f.cwd||'';head.id=f.id||'';head.createdAt=f.timestamp||'';}
   else if(f.type==='message'&&f.message?.role==='user'&&!head.preview)head.preview=contentText(f.message.content).slice(0,240);
   scanModel(head,f);}
  if(size>buf.length){const tail=Buffer.alloc(Math.min(256*1024,size-buf.length));const r=await fh.read(tail,0,tail.length,size-tail.length);
   for(const line of tail.subarray(0,r.bytesRead).toString('utf8').split('\n').slice(1)){let f;try{f=JSON.parse(line);}catch{continue;}scanModel(head,f);}}
  return head;}finally{await fh.close();}
}
async function readTail(file,max){const fh=await fs.open(file,'r');try{const {size}=await fh.stat();const n=Math.min(size,max);const buf=Buffer.alloc(n);await fh.read(buf,0,n,size-n);const t=buf.toString('utf8');return n<size?t.slice(t.indexOf('\n')+1):t;}finally{await fh.close();}}
// Tokens the model saw on its last turn, i.e. how full the context window is.
const usageTokens=u=>u&&typeof u==='object'?(u.input||0)+(u.cacheRead||0)+(u.cacheWrite||0)+(u.output||0):undefined;
async function lastContext(file){
 const lines=(await readTail(file,4*1024*1024)).split('\n');
 for(let i=lines.length-1;i>=0;i--){if(!lines[i].includes('"usage"'))continue;let f;try{f=JSON.parse(lines[i]);}catch{continue;}const m=f.message||{};if(f.type==='message'&&m.role==='assistant'&&usageTokens(m.usage))return usageTokens(m.usage);if(f.type==='compaction')return undefined;}
 return undefined;
}
async function importMessages(file,limit=400){
 const out=[];const tools=new Map();
 for(const line of (await readTail(file,12*1024*1024)).split('\n')){let f;try{f=JSON.parse(line);}catch{continue;}if(f.type!=='message'&&f.type!=='custom_message')continue;const m=f.type==='custom_message'?f:f.message||{};const at=f.timestamp||now();
  if(m.role==='user'){const v=contentText(m.content).trim(),hasImage=Array.isArray(m.content)&&m.content.some(c=>c?.type==='image');if(v||hasImage)out.push({id:f.id||randomUUID(),role:m.synthetic&&m.attribution==='agent'?'advisor-update':'user',text:v.slice(-100000)||'Image attached',hasImage,at});}
  else if(m.role==='assistant'){
   const th=thinkingText(m.content).trim();if(th)out.push({id:(f.id||randomUUID())+'-think',role:'thinking',text:th.slice(-40000),at,sourceTimestamp:m.timestamp});
   const v=contentText(m.content).trim();if(v)out.push({id:f.id||randomUUID(),role:'assistant',text:v.slice(-100000),at,model:m.provider&&m.model?`${m.provider}/${m.model}`:undefined});
   for(const c of Array.isArray(m.content)?m.content:[])if(c?.type==='toolCall'){const tool=toolRecord(c.name,c.arguments,c.intent);tool.status='done';const msg={id:'tool-'+c.id,role:'tool',tool,text:toolSummary(tool),at};tools.set(c.id,msg);out.push(msg);}
  }
  else if(f.type==='custom_message'||m.role==='custom'){const card=advisorMessage(m,f.id||randomUUID(),at);if(card)out.push(card);}
  else if(m.role==='toolResult'){const msg=tools.get(m.toolCallId);if(msg){msg.tool.result=clip(contentText(m.content),8000);msg.tool.status=m.isError?'error':'done';const files=editFiles(m.details);if(files)msg.tool.files=files;msg.text=toolSummary(msg.tool);}}
  else if(m.role==='bashExecution'){const tool=shellRecord(m.command,m);out.push({id:'tool-'+(f.id||randomUUID()),role:'tool',tool,text:toolSummary(tool),at});}
 }
 return out.slice(-limit);
}

export async function createCompanion(options={}){
 const dataDir=options.dataDir||process.env.OMP_WEB_DATA_DIR||path.join(os.homedir(),'.omp-web');
 // OMP_BIN may point at the native executable or a source checkout's cli.ts.
 const ompEntry=options.ompCommand||process.env.OMP_BIN||'omp',ompSource=/\.ts$/i.test(ompEntry);
 const ompExecutable=ompSource?'bun':ompEntry,ompPrefix=ompSource?[path.resolve(ompEntry)]:[];
 const execOmp=(args,opts)=>exec(ompExecutable,[...ompPrefix,...args],opts);
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const stateFile=path.join(dataDir,'workspace.json');
 const queuedImageFile=id=>path.join(dataDir,'queued-images',id+'.json');
 let store;
 try{store=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error(`Cannot read workspace: ${e.message}`);store={projects:[],sessions:[],activity:[]};}
 // Sidebar keys ('s:<id>' or 'f:<native file>') the user archived; archiving only hides, it never deletes.
 store.archived=Array.isArray(store.archived)?store.archived.filter(k=>typeof k==='string'):[];
 for(const s of store.sessions){delete s._streamId;delete s._thinkId;delete s._compacting;delete s.uiRequests;if(['running','queued'].includes(s.status)){s.status='paused';s.error=undefined;}for(const a of s.subagentList||[])if(/run|pend|start|queue/i.test(a.status))a.status='stopped';}
 const token=options.token||randomBytes(32).toString('hex');
 const allowedOrigins=new Set(options.allowedOrigins||String(process.env.OMP_ALLOWED_ORIGINS||'').split(',').filter(Boolean));
 let eventSaveTimer;const scheduleSave=()=>{if(!eventSaveTimer)eventSaveTimer=setTimeout(()=>{eventSaveTimer=undefined;void persist();},300);};
 const runners=new Map();const launches=new Map();const locks=new Map();let closing=false;let saveChain=Promise.resolve();
 // Only the current thought is live; completed messages remain in OMP's transcript.
 const subagentThoughts=new Map();
 const persist=()=>{const snapshot=JSON.stringify(store,(key,value)=>key.startsWith('_')||key==='uiRequests'?undefined:value);saveChain=saveChain.catch(()=>{}).then(async()=>{await fs.writeFile(stateFile+'.tmp',snapshot,{mode:0o600});await fs.rename(stateFile+'.tmp',stateFile);});saveChain.catch(e=>console.error('Workspace save failed:',e.message));return saveChain;};
 const activity=(s,message,type='update')=>{store.activity.unshift({id:randomUUID(),projectId:s?.projectId,sessionId:s?.id,text:message,type,at:now()});store.activity=store.activity.slice(0,500);};
 const append=(s,role,value,id=randomUUID())=>{if(!value)return;const existing=s.messages.find(m=>m.id===id);if(existing)existing.text=value.slice(-100000);else s.messages.push({id,role,text:value.slice(-100000),at:now()});s.messages=s.messages.slice(-600);return s.messages.find(m=>m.id===id);};
 // Slash commands per live session, from available_commands_update; served on demand, not in every /api/state poll.
 const commands=new Map();
 const slashList=list=>list.slice(0,500).filter(c=>typeof c?.name==='string').map(c=>({name:c.name.slice(0,100),description:String(c.description||'').slice(0,300),aliases:Array.isArray(c.aliases)?c.aliases.filter(a=>typeof a==='string').slice(0,10):[],hint:String(c.input?.hint||'').slice(0,100),source:String(c.source||'')}));
 const commandProbes=new Set();
 async function discoverCommands(dir){
  let list;
  const rpc=new RpcProcess(ompExecutable,[...ompPrefix,...(options.ompArgs??['--mode','rpc-ui','--no-session'])],dir,f=>{if(f.type==='available_commands_update'&&Array.isArray(f.commands))list=slashList(f.commands);},()=>{});
  commandProbes.add(rpc);
  try{
   // Startup publishes the catalog before handling get_state; no prompt or saved session is needed.
   await rpc.send({type:'get_state'});
   if(!list)throw error('OMP did not provide its slash commands. Update OMP and try again.',502);
   return list;
  }finally{
   const stopped=new Promise(resolve=>rpc.child.once('close',resolve));
   if(!rpc.stopping)rpc.kill();
   if(rpc.child.exitCode===null&&rpc.child.signalCode===null)await stopped;
   commandProbes.delete(rpc);
  }
 }
 // Session toggles the dashboard can change; values are validated in command().
 const PREFS={fast:v=>({type:'set_fast_mode',enabled:v}),autoCompaction:v=>({type:'set_auto_compaction',enabled:v}),autoRetry:v=>({type:'set_auto_retry',enabled:v}),steeringMode:v=>({type:'set_steering_mode',mode:v}),interruptMode:v=>({type:'set_interrupt_mode',mode:v})};
 const PREF_VALUES={fast:[true,false],autoCompaction:[true,false],autoRetry:[true,false],steeringMode:['one-at-a-time','all'],interruptMode:['immediate','wait']};
 function settle(s){
  void lock(s.id,async()=>{
   if(s.status!=='running')return;
   if(s._planReview||s.planMode?.reviewPending){s.status='review';return;}
   if(s.queuedMessages?.length)await sendQueued(s);
   else{s.status='review';activity(s,`${s.title} is ready for review`,'review');}
  }).catch(e=>{s.status='error';s.error=`Could not send queued message: ${e.message}`;void persist();});
 }
 function event(s,f){
  s.updatedAt=now();if(f.type!=='response')s._lastEvent=Date.now();
  // Advisor toggles print command_output, which is not progress on the turn itself.
  if(f.type!=='response'&&f.type!=='command_output')s.lastActivityAt=now();
  if(f.type==='agent_start'){s.status='running';s.error=undefined;}
  if(f.type==='auto_compaction_start')s._compacting=true;
  if(f.type==='auto_compaction_end'){
   s._compacting=!!f.willRetry;
   if(!f.willRetry)append(s,'system',f.aborted?'Context compaction stopped.':f.skipped?'Context compaction skipped.':f.errorMessage?`Context compaction failed: ${f.errorMessage}`:'Context compacted.');
  }
  if(f.type==='message_update'&&f.assistantMessageEvent?.type==='thinking_delta'){
   s._thinkId??=randomUUID();const m=s.messages.find(m=>m.id===s._thinkId);append(s,'thinking',(m?.text||'')+f.assistantMessageEvent.delta,s._thinkId);
  }
  if(f.type==='message_update'&&f.assistantMessageEvent?.type==='text_delta'){
   s._streamId??=randomUUID();const m=s.messages.find(m=>m.id===s._streamId);append(s,'assistant',(m?.text||'')+f.assistantMessageEvent.delta,s._streamId);
  }
  if(f.type==='message_start'&&f.message?.role==='user'){
   // Steers wait for a tool/turn boundary; OMP echoes them when read, so place them where the agent actually saw them.
   const said=contentText(f.message.content).trim(),i=s.messages.findIndex(m=>m.steer&&(m.text.trim()===said||(m.hasImage&&m.text==='Image attached'&&!said)));
   if(i>=0){const [m]=s.messages.splice(i,1);delete m.steer;m.at=now();s.messages.push(m);}
  }
  if(f.type==='message_end'){
   const m=f.message||{};if(m.role==='assistant'){const ct=usageTokens(m.usage);if(ct)s.contextTokens=ct;if(m.stopReason==='error'){s.status='error';s.error=m.errorMessage||'OMP provider failed.';append(s,'system',s.error);activity(s,`${s.title}: ${s.error}`,'error');}else if(m.stopReason==='aborted'){s.status='paused';}const th=thinkingText(m.content);if(th)append(s,'thinking',th.slice(-40000),s._thinkId||randomUUID());const v=contentText(m.content);if(v){const msg=append(s,'assistant',v,s._streamId||randomUUID());if(msg&&m.provider&&m.model)msg.model=`${m.provider}/${m.model}`;}if(m.provider&&m.model){s.provider=m.provider;s.model=m.model;}delete s._streamId;delete s._thinkId;if(m.usage){s.tokens+=(m.usage.totalTokens||((m.usage.input||0)+(m.usage.output||0)));s.cost+=m.usage.cost?.total||0;}}
   if(m.role==='custom'){const card=advisorMessage(m,randomUUID(),now());if(card){const saved=append(s,'advisor',card.text,card.id);saved.notes=card.notes;}}
  }
  if(f.type==='tool_execution_start'){const tool=toolRecord(f.toolName,f.args,f.intent);const msg=append(s,'tool',toolSummary(tool),'tool-'+(f.toolCallId||randomUUID()));if(msg){msg.tool=tool;msg.startedAt=now();}}
  if(f.type==='tool_execution_end'){let msg=s.messages.find(m=>m.id==='tool-'+f.toolCallId);if(!msg){msg=append(s,'tool','tool','tool-'+(f.toolCallId||randomUUID()));msg.tool=toolRecord(f.toolName,{},'');}
   msg.tool.status=f.isError?'error':'done';msg.tool.result=clip(contentText(f.result?.content),8000);const files=editFiles(f.result?.details);if(files)msg.tool.files=files;msg.tool.ms=msg.startedAt?Date.now()-new Date(msg.startedAt).getTime():undefined;msg.text=toolSummary(msg.tool);}
  if(f.type==='command_output'){const text=typeof f.text==='string'?f.text:contentText(f.content);const adv=parseAdvisorStatus(text);if(adv)s.advisor={enabled:adv.enabled??s.advisor?.enabled??adv.state==='running',...adv,at:now()};if(!(adv&&s._silentAdvisorUntil>Date.now()))append(s,adv?'system':'assistant',text);}
  // Correlated by command id: an aborted run's result can land after the next prompt started, and must not pause it.
  if(f.type==='prompt_result'&&!(f.id&&f.id!==s._promptId)){
   if(f.status==='error'){s.status='error';s.error=f.error?.message||'OMP reported an error.';append(s,'system',s.error);activity(s,`${s.title}: ${s.error}`,'error');}
   else if(f.status==='aborted'){s.status='paused';activity(s,`Stopped ${s.title}`,'paused');}
   dropSteers(s);
  }
  if(f.type==='session_settled'){dropSteers(s);if(s.status==='running')settle(s);}
  if(f.type==='subagent_progress'||f.type==='subagent_lifecycle'){const p=f.payload||f;const id=p.progress?.id||p.id||p.subagentId;
   if(id){s.subagentList??=[];const prev=s.subagentList.find(x=>x.id===id);const next=subagentView({...prev,...p,id,progress:p.progress||prev?.progress,status:p.status||p.progress?.status||p.phase||prev?.status});if(prev)Object.assign(prev,next);else s.subagentList.push(next);s.subagentList=s.subagentList.slice(-50);
    const key=s.id+':'+id;let thought=subagentThoughts.get(key);
    if(!thought||p.status==='started'||(thought.file&&next.sessionFile&&!samePath(thought.file,next.sessionFile))){thought={parentId:s.id,text:'',at:now(),streaming:false};subagentThoughts.set(key,thought);if(subagentThoughts.size>256)subagentThoughts.delete(subagentThoughts.keys().next().value);}
    thought.file=next.sessionFile||thought.file;thought.active=/run|pend|start|queue/i.test(next.status);if(!thought.active)thought.streaming=false;
   }}
  if(f.type==='subagent_event'){const p=f.payload||{},e=p.event;const thought=subagentThoughts.get(s.id+':'+p.id);
   if(thought&&e?.message?.role==='assistant'&&['message_start','message_update','message_end'].includes(e.type)){
    if(e.type==='message_start'||!thought.id)thought.id='sub-think-'+randomUUID();
    thought.text=thinkingText(e.message.content).slice(-40000);thought.at=now();thought.sourceTimestamp=e.message.timestamp;thought.streaming=e.type!=='message_end';
   }}
  if(f.type==='extension_ui_request'&&f.id){
   if(f.method==='cancel')s.uiRequests=(s.uiRequests||[]).filter(q=>q.id!==f.targetId);
   else if(['select','confirm','input','editor'].includes(f.method)){
    const q={id:f.id,method:f.method,title:String(f.title||'Question').slice(0,500)};
    if(f.method==='select'){q.options=Array.isArray(f.options)?f.options.filter(x=>typeof x==='string').slice(0,100):[];q.optionDetails=Array.isArray(f.optionDetails)?f.optionDetails.slice(0,q.options.length).map(x=>({description:String(x?.description||'').slice(0,500)})):[];}
    if(f.method==='confirm')q.message=String(f.message||'').slice(0,2000);
    if(f.method==='input')q.placeholder=String(f.placeholder||'').slice(0,500);
    if(f.method==='editor')q.prefill=String(f.prefill||'').slice(0,20000);
    (s.uiRequests??=[]).push(q);
   }else if(f.method==='notify')notice(s,f.notifyType,f.message);
   else if(f.method==='setStatus'){s._status??={};const key=String(f.statusKey||'').slice(0,80);if(f.statusText)s._status[key]=String(f.statusText).slice(0,300);else delete s._status[key];}
   else if(f.method==='setWidget'){s._widgets??={};const key=String(f.widgetKey||'').slice(0,80);if(Array.isArray(f.widgetLines)&&f.widgetLines.length)s._widgets[key]=f.widgetLines.slice(0,40).map(l=>String(l).slice(0,500));else delete s._widgets[key];}
   else if(f.method==='set_editor_text')s._editorText={id:f.id,text:String(f.text??'').slice(0,200000)};
   // Login flows: the browser can't be opened for the user without a click, so the dashboard shows the link.
   else if(f.method==='open_url'){const url=[f.launchUrl,f.url].find(u=>typeof u==='string'&&/^https?:\/\//i.test(u));if(url)s._openUrl={id:f.id,url:url.slice(0,4000),instructions:String(f.instructions||'').slice(0,1000)};}
   else if(f.method!=='setTitle')void runners.get(s.id)?.reply({type:'extension_ui_response',id:f.id,cancelled:true}).catch(()=>{});
  }
  if(f.type==='tool_execution_update'){const msg=s.messages.find(m=>m.id==='tool-'+f.toolCallId);const out=contentText(f.partialResult?.content);if(msg?.tool?.status==='running'&&out)msg.tool.result=out.length>8000?'…'+out.slice(-8000):out;}
  if(f.type==='extension_error')notice(s,'error',`Extension ${path.basename(String(f.extensionPath||'extension'))} failed${f.event?` in ${f.event}`:''}: ${f.error}`);
  if(f.type==='notice')notice(s,f.level,f.source?`${f.source}: ${f.message}`:f.message);
  if(f.type==='auto_retry_start')s._retry={attempt:f.attempt,maxAttempts:f.maxAttempts,delayMs:f.delayMs,error:String(f.errorMessage||'').slice(0,1000),at:now()};
  if(f.type==='auto_retry_end'){delete s._retry;if(!f.success)append(s,'system',`Retries stopped after attempt ${f.attempt}${f.finalError?`: ${f.finalError}`:'.'}`);}
  if(f.type==='retry_fallback_applied')append(s,'system',`Switched from ${f.from} to fallback model ${f.to}${f.reason?` (${f.reason})`:''}.`);
  if(f.type==='model_changed'){const rpc=runners.get(s.id);if(rpc)void refresh(s,rpc);}
  if(f.type==='thinking_level_changed'&&f.thinkingLevel)s.thinking=f.thinkingLevel;
  if(f.type==='ttsr_triggered'&&Array.isArray(f.rules)&&f.rules.length)append(s,'system',`Rule applied: ${f.rules.map(r=>r?.name||r?.id||'rule').join(', ')}`);
  if(f.type==='irc_message'){const v=contentText(f.message?.content);if(v)append(s,'system',v);}
  if(f.type==='todo_auto_clear')s.todos=[];
  if(f.type==='goal_updated')s.goal=goalView(f.goal);
  if(f.type==='plan_mode_changed'){s.planMode=f.planMode;s._planSupported=true;}
  if(f.type==='plan_review')s._planReview=f.proposal;
  if(f.type==='plan_review_clear'&&s._planReview?.id===f.proposalId)delete s._planReview;
  if(f.type==='available_commands_update'&&Array.isArray(f.commands))commands.set(s.id,slashList(f.commands));
  if(f.type==='response'&&!f.success){s.error=f.error;if(['prompt','steer','follow_up'].includes(f.command))s.status='error';}
  scheduleSave();
 }
 // OMP forgets steers it never read once the turn ends; flag them so the user can resend.
 function dropSteers(s){for(const m of s.messages)if(m.steer==='pending')m.steer='dropped';}
 // Info toasts in the dashboard; warnings and errors also stay in the chat.
 function notice(s,level,message){const text=String(message||'').trim().slice(0,2000);if(!text)return;level=['warning','error'].includes(level)?level:'info';
  s._notices=[...(s._notices||[]),{id:randomUUID(),level,text,at:now()}].slice(-20);if(level!=='info')append(s,'system',text);if(level==='error')activity(s,`${s.title}: ${text}`,'error');}
 async function start(s){
  if(runners.get(s.id)?.alive)return runners.get(s.id);
  if(launches.has(s.id))return launches.get(s.id);
  const promise=(async()=>{
   for(const [key,thought] of subagentThoughts)if(thought.parentId===s.id)subagentThoughts.delete(key);
   const sessionDir=path.join(dataDir,'sessions',s.id);if(!s.native)await fs.mkdir(sessionDir,{recursive:true,mode:0o700});
   // Native sessions live in OMP's own session store, so they also appear in `omp --resume` and in the recent list.
   const pick=[...(s.modelSelector?['--model',s.modelSelector]:[]),...(s.thinkingChoice?['--thinking',s.thinkingChoice]:[])];
   const args=options.ompArgs??(s.native?['--mode','rpc-ui',...(s.sessionFile?['--resume',s.sessionFile]:[]),...pick]:['--mode','rpc-ui','--session-dir',sessionDir,'--continue',...pick]);
   const rpc=new RpcProcess(ompExecutable,[...ompPrefix,...args],s.cwd,f=>{if(!closing&&runners.get(s.id)===rpc)event(s,f);},(e,stopping)=>{if(runners.get(s.id)!==rpc)return;runners.delete(s.id);commands.delete(s.id);for(const k of ['_streamId','_compacting','_retry','_openUrl','_status','_widgets','_editorText','_task','_bash','_planReview','_planSupported','_goalSupported','_goalAvailable','uiRequests'])delete s[k];dropSteers(s);if(!closing){s.status=stopping?'paused':'error';s.error=stopping?undefined:e.message;void persist();}});
   runners.set(s.id,rpc);
   try{await rpc.ready;await rpc.send({type:'set_session_name',name:s.title});await rpc.send({type:'set_subagent_subscription',level:'events'});if(!s.modelSelector&&!s.native&&s.provider&&s.model!=='OMP default')await rpc.send({type:'set_model',provider:s.provider,modelId:s.model});
    // Per-session toggles live in the OMP process, so a restarted runner gets them back.
    for(const [key,value] of Object.entries(s.prefs||{}))await rpc.send(PREFS[key](value)).catch(e=>notice(s,'warning',e.message));
    await refresh(s,rpc);return rpc;}catch(e){runners.delete(s.id);rpc.kill();throw e;}
  })();launches.set(s.id,promise);try{return await promise;}finally{launches.delete(s.id);}
 }
 // The status reply can arrive after send() resolves, so stay silent until it shows up (or a few seconds pass).
 async function advisorStatus(s,rpc){s._silentAdvisorUntil=Date.now()+5000;try{await rpc.send({type:'prompt',message:'/advisor status'});}catch{s._silentAdvisorUntil=0;}}
 async function refresh(s,rpc){try{const state=await rpc.send({type:'get_state'});
  // OMP only emits session_settled right after a terminal agent_end; if async work finished later, nothing re-announces it.
  if(state?.isSettled===true&&s.status==='running'&&!s._compacting&&Date.now()-(s._lastEvent||0)>3000)settle(s);
  if(state){s.tps=typeof state.tokensPerSecond==='number'?state.tokensPerSecond:undefined;s.fast={enabled:!!state.fastModeEnabled,active:!!state.fastModeActive};if(typeof state.autoCompactionEnabled==='boolean')s.autoCompaction=state.autoCompactionEnabled;s.modes={steering:state.steeringMode,interrupt:state.interruptMode};}
  if(state){s._planSupported=typeof state.planMode?.enabled==='boolean';if(s._planSupported)s.planMode=state.planMode;else delete s.planMode;if(state.planReview)s._planReview=state.planReview;else delete s._planReview;}
  if(state){s._goalSupported=Object.hasOwn(state,'goalMode');s._goalAvailable=state.goalMode?.available===true;s.goal=goalView(state.goalMode?.goal);}
  if(state?.isSettled===true&&!s._advisorChecked&&s.status!=='running'){s._advisorChecked=true;await advisorStatus(s,rpc);}if(state?.model){s.model=state.model.id;s.provider=state.model.provider;}if(state?.thinkingLevel)s.thinking=state.thinkingLevel;if(typeof state?.isCompacting==='boolean')s._compacting=state.isCompacting;s.todos=Array.isArray(state?.todoPhases)?state.todoPhases:[];if(state?.sessionFile)s.sessionFile=state.sessionFile;const cu=state?.contextUsage;s.contextPercent=typeof cu?.percent==='number'?cu.percent:undefined;if(typeof cu?.tokens==='number')s.contextTokens=cu.tokens;if(typeof cu?.contextWindow==='number')s.contextWindow=cu.contextWindow;const subs=await rpc.send({type:'get_subagents'});const list=Array.isArray(subs?.subagents)?subs.subagents:[];s.subagents=list.length;s.subagentList=list.slice(-50).map(subagentView);}catch{}}
 // branch and handoff move OMP to a new session file; show that transcript instead of the old one.
 async function reload(s,rpc){await refresh(s,rpc);if(s.sessionFile)s.messages=await importMessages(s.sessionFile).catch(()=>s.messages);delete s._streamId;delete s._thinkId;}
 async function command(s,body,checkedImages,queuedId){
  const allowed=['prompt','steer','follow_up','edit_follow_up','cancel_follow_up','cancel_steer','edit_steer','send_follow_up','answer','abort','complete','compact','hide','set_model','advisor','plan_mode','plan_review','plan_approve','rename','pref','abort_retry','bash','abort_bash','stats','export','branch_messages','branch','handoff','login_providers','login'];if(!allowed.includes(body.type))throw error('Unsupported session command.');
  const prompting=['prompt','steer','follow_up'].includes(body.type);
  const images=prompting?(checkedImages??chatImages(body)):[];
  if(prompting&&s._task)throw error('Wait for the handoff to finish first.');
  if(body.type==='answer'){
   const rpc=runners.get(s.id),id=text(body.id,'Question ID',200),q=s.uiRequests?.find(q=>q.id===id);
   if(!rpc?.alive||!q)throw error('This question is no longer pending.');
   let reply={type:'extension_ui_response',id};
   if(body.cancelled===true)reply.cancelled=true;
   else if(q.method==='confirm'){if(typeof body.confirmed!=='boolean')throw error('Choose Yes, No, or Cancel.');reply.confirmed=body.confirmed;}
   else{if(typeof body.value!=='string'||body.value.length>20000)throw error('Answer must be text under 20,000 characters.');if(q.method==='select'&&!q.options.includes(body.value))throw error('Choose one of the listed options.');reply.value=body.value;}
   await rpc.reply(reply);s.uiRequests=s.uiRequests.filter(x=>x.id!==id);return s;
  }
  if(body.type==='send_follow_up'){
   const queue=s.queuedMessages||[];const i=queue.findIndex(q=>q.id===body.id);
   if(i<0)throw error('Queued message was already sent or removed.');
   const item=queue[i];const images=item.hasImage?chatImages({images:JSON.parse(await fs.readFile(queuedImageFile(item.id),'utf8'))}):[];
   const live=['running','queued'].includes(s.status);
   const result=await command(s,{type:live?'steer':'prompt',message:item.text,preview:item.imagePreview},images,item.id);
   if(result.status==='error')return result;
   s.queuedMessages=(s.queuedMessages||[]).filter(q=>q.id!==item.id);await persist();
   if(item.hasImage)await fs.rm(queuedImageFile(item.id),{force:true}).catch(()=>{});
   return s;
  }
  if(body.type==='edit_follow_up'||body.type==='cancel_follow_up'){
   const queue=s.queuedMessages||[];const i=queue.findIndex(q=>q.id===body.id);
   if(i<0)throw error('Queued message was already sent or removed.');
   if(body.type==='edit_follow_up'){const value=body.message;queue[i].text=queue[i].hasImage&&typeof value==='string'&&!value.trim()?'':text(value,'Message',200000);}
   else{const [item]=queue.splice(i,1);await persist();if(item.hasImage)await fs.rm(queuedImageFile(item.id),{force:true}).catch(()=>{});return s;}
   await persist();return s;
  }
  if(body.type==='cancel_steer'||body.type==='edit_steer'){
   const i=s.messages.findIndex(m=>m.id===body.id&&m.steer==='pending'),m=s.messages[i];
   if(!m)throw error('OMP already read this steer.');
   if(body.type==='edit_steer'&&m.hasImage)throw error('Steers with images can only be cancelled.');
   const rpc=runners.get(s.id);
   const r=rpc?.alive?await rpc.send({type:'remove_queued_message',message:m.hasImage&&m.text==='Image attached'?'':m.text,queue:'steering'}):null;
   if(!r?.removed)throw error('OMP already read this steer.');
   s.messages.splice(i,1);await persist();
   return body.type==='edit_steer'?command(s,{type:'steer',message:body.message}):s;
  }
  if(body.type==='set_model'){
   const {selector,thinking}=modelChoice(body);if(selector)s.modelSelector=selector;if(thinking)s.thinkingChoice=thinking;
   const rpc=runners.get(s.id);if(rpc?.alive){const i=selector.indexOf('/');if(selector)await rpc.send({type:'set_model',provider:selector.slice(0,i),modelId:selector.slice(i+1)});if(thinking)await rpc.send({type:'set_thinking_level',level:thinking});await refresh(s,rpc);}
   else{if(selector){const i=selector.indexOf('/');s.provider=selector.slice(0,i);s.model=selector.slice(i+1);}if(thinking)s.thinking=thinking;}
   await persist();return s;
  }
  const busy=()=>{if(['running','queued'].includes(s.status)||s._task||s._bash)throw error('Wait for OMP to finish first.');};
  if(['plan_mode','plan_review','plan_approve'].includes(body.type)){
   let request;
   if(body.type==='plan_mode'){
    if(typeof body.enabled!=='boolean')throw error('Plan mode enabled must be true or false.');
    if(body.workflow!==undefined&&!['parallel','iterative'].includes(body.workflow))throw error('Choose parallel or iterative planning.');
    request={type:'set_plan_mode',enabled:body.enabled,...(body.workflow?{workflow:body.workflow}:{})};
   }else if(body.type==='plan_approve'){
    const proposalId=text(body.proposalId,'Proposal ID',200);
    if(!['preserve','fresh','compact','refine'].includes(body.action))throw error('Choose an approval action or request refinement.');
    if(body.feedback!==undefined&&(typeof body.feedback!=='string'||body.feedback.length>20000))throw error('Feedback must be text under 20,000 characters.');
    if(body.action==='refine'&&!body.feedback?.trim())throw error('Refinement requires feedback describing what should change.');
    if(body.action!=='refine'&&body.feedback?.trim())throw error('Feedback is only supported for refinement.');
    if(body.executionModel!==undefined&&(typeof body.executionModel!=='string'||!/^[\w.~@+-]+\/[\w.~@:+\/-]+$/.test(body.executionModel)))throw error('Invalid execution model.');
    if(body.action==='refine'&&body.executionModel!==undefined)throw error('Refinement keeps the planning model; do not select an execution model.');
    if(s._planReview?.id!==proposalId)throw error('This plan is no longer pending. Reopen the current plan before approving.',409);
    request={type:'approve_plan',proposalId,action:body.action,...(body.feedback?.trim()?{feedback:body.feedback.trim()}:{}),...(body.executionModel?{executionModel:body.executionModel}:{})};
   }else request={type:'review_plan'};
   busy();const rpc=await start(s);
   if(!s._planSupported)throw error('This OMP build does not expose plan mode over RPC. Set OMP_BIN to an updated build or the patched checkout’s packages/coding-agent/src/cli.ts.',409);
   try{const result=await rpc.send(request);
    if(body.type==='plan_review')s._planReview=result?.proposal;
    if(body.type==='plan_approve'){if(s._planReview?.id===request.proposalId)delete s._planReview;if(body.action!=='refine'||request.feedback)s.status='running';}
    await refresh(s,rpc);await persist();return body.type==='plan_review'?{proposal:s._planReview}:s;
   }catch(e){throw error(e.message,e.code==='stale_proposal'?409:400);}
  }
  if(body.type==='rename'){const name=text(body.name,'Session name',120);const rpc=runners.get(s.id);if(rpc?.alive)await rpc.send({type:'set_session_name',name});s.title=name;await persist();return s;}
  if(body.type==='pref'){
   if(!Object.hasOwn(PREF_VALUES,body.key)||!PREF_VALUES[body.key].includes(body.value))throw error('Invalid session setting.');
   const rpc=await start(s);try{await rpc.send(PREFS[body.key](body.value));}catch(e){throw error(e.message);}
   (s.prefs??={})[body.key]=body.value;await refresh(s,rpc);await persist();return s;
  }
  if(body.type==='abort_retry'||body.type==='abort_bash'){const rpc=runners.get(s.id);if(rpc?.alive)await rpc.send({type:body.type});return s;}
  // Runs outside the session lock (timeout 0) so Stop, answers and other commands still get through while it works.
  if(body.type==='bash'){
   const cmd=text(body.command,'Command',20000);if(s._bash)throw error('A shell command is already running.');
   const rpc=await start(s);const msg=append(s,'tool','bash','tool-bash-'+randomUUID());msg.tool=shellRecord(cmd);msg.startedAt=now();msg.text=toolSummary(msg.tool);s._bash=msg.id;
   rpc.send({type:'bash',command:cmd},0).then(r=>Object.assign(msg.tool,shellRecord(cmd,r)),e=>{msg.tool.status='error';msg.tool.result=e.message;})
    .finally(()=>{msg.tool.ms=Date.now()-new Date(msg.startedAt).getTime();msg.text=toolSummary(msg.tool);delete s._bash;scheduleSave();});
   await persist();return s;
  }
  if(body.type==='stats'){const rpc=await start(s);return {stats:await rpc.send({type:'get_session_stats'})};}
  if(body.type==='export'){
   const rpc=await start(s);const dir=path.join(dataDir,'exports');await fs.mkdir(dir,{recursive:true,mode:0o700});
   const r=await rpc.send({type:'export_html',outputPath:path.join(dir,s.id+'.html')},120000);
   return {name:(s.title.replace(/[^\w.-]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'omp-session')+'.html',html:await fs.readFile(r?.path||path.join(dir,s.id+'.html'),'utf8')};
  }
  if(body.type==='branch_messages'){busy();const rpc=await start(s);const r=await rpc.send({type:'get_branch_messages'});return {messages:(Array.isArray(r?.messages)?r.messages:[]).map(m=>({entryId:String(m.entryId),text:String(m.text||'').slice(0,300)})).reverse()};}
  if(body.type==='branch'){
   busy();const rpc=await start(s);const r=await rpc.send({type:'branch',entryId:text(body.entryId,'Message',200)});if(r?.cancelled)throw error('An extension cancelled the branch.');
   await reload(s,rpc);append(s,'system','Branched into a new session from this point. The message you picked is back in the composer.');s.status='paused';await persist();return {session:s,text:String(r?.text||'')};
  }
  if(body.type==='handoff'){
   busy();const rpc=await start(s);const instructions=typeof body.instructions==='string'?body.instructions.trim().slice(0,5000):'';s._task='Writing the handoff…';
   rpc.send({type:'handoff',...(instructions?{customInstructions:instructions}:{})},0).then(async r=>{await reload(s,rpc);append(s,'system',`Handed off to a fresh session${r?.savedPath?`. Handoff document: ${r.savedPath}`:''}.`);},e=>append(s,'system',`Handoff failed: ${e.message}`))
    .finally(()=>{delete s._task;void persist();});
   await persist();return s;
  }
  if(body.type==='login_providers'){const rpc=await start(s);const r=await rpc.send({type:'get_login_providers'});return {providers:(Array.isArray(r?.providers)?r.providers:[]).map(p=>({id:String(p.id),name:String(p.name||p.id),available:p.available!==false,authenticated:!!p.authenticated}))};}
  // OAuth runs until the user finishes in the browser; the link arrives as open_url, pasted codes as input questions.
  if(body.type==='login'){
   const id=text(body.provider,'Provider',100);const rpc=await start(s);notice(s,'info',`Starting ${id} login…`);
   rpc.send({type:'login',providerId:id},0).then(()=>notice(s,'info',`Logged in to ${id}.`),e=>notice(s,'error',`Login to ${id} failed: ${e.message}`)).finally(()=>{delete s._openUrl;scheduleSave();});
   return s;
  }
  if(['hide','complete'].includes(body.type)&&s.queuedMessages?.length)throw error('Send or remove queued messages before closing this session.');
  if(body.type==='hide'){if(s.status==='running')throw error('Stop the session before removing it from the panel.');runners.get(s.id)?.kill();s.hidden=true;await persist();return s;}
  if(body.type==='complete'){if(!['review','paused','done','error'].includes(s.status))throw error('Stop or finish the session before marking it complete.');s.status='done';activity(s,`Completed ${s.title}`,'done');await persist();return s;}
  if(prompting){if(typeof body.message!=='string')throw error('Prompt is required.');body.message=images.length&&!body.message.trim()?'':text(body.message,'Prompt',200000);}
  const goalCommand=prompting&&/^\/(?:goal|fast)(?:\s|$)/.test(body.message);
  if(goalCommand&&body.message.startsWith('/goal')){
   await start(s);
   if(!s._goalSupported)throw error('This OMP build has no RPC goal mode. Set OMP_BIN to an updated build or the patched checkout’s packages/coding-agent/src/cli.ts; /goal was not sent to the model.',409);
   if(!s._goalAvailable)throw error('Goal mode is disabled in OMP. Enable goal.enabled in OMP settings; /goal was not sent to the model.',409);
  }
  if(body.type==='follow_up'&&['running','queued'].includes(s.status)){
   const item={id:randomUUID(),text:body.message,hasImage:!!images.length,imagePreview:images.length?body.preview:undefined,at:now()};
   if(images.length){await fs.mkdir(path.dirname(queuedImageFile(item.id)),{recursive:true,mode:0o700});await fs.writeFile(queuedImageFile(item.id),JSON.stringify(images),{mode:0o600});}
   (s.queuedMessages??=[]).push(item);await persist();return s;
  }
  if(body.type==='follow_up')body.type='prompt';
  if(body.type==='advisor'){
   if(!['on','off','status','model'].includes(body.action))throw error('Invalid advisor action.');
   const rpc=await start(s);
   if(body.action==='model'){
    // A running OMP reads its advisors only at startup, so the session is restarted (while idle) to pick up the new model.
    if(['running','queued'].includes(s.status))throw error('Wait for this turn to finish, then change the advisor model.');
    const where=await setAdvisorModel(text(body.model,'Advisor model',300));
    const prev=s.status;runners.get(s.id)?.kill();
    for(let i=0;i<50&&runners.has(s.id);i++)await new Promise(r=>setTimeout(r,100));
    const fresh=await start(s);s.status=prev;s.error=undefined;
    s._silentAdvisorUntil=Date.now()+5000;await fresh.send({type:'prompt',message:'/advisor on'});
    append(s,'system',`Advisor model set to ${body.model} (${where}).`);
    await advisorStatus(s,fresh);await persist();return s;
   }
   // The composer's advisor chip shows the result, so the on/off reply stays out of the chat.
   if(body.action!=='status'){s._silentAdvisorUntil=Date.now()+5000;await rpc.send({type:'prompt',message:`/advisor ${body.action}`});}
   await advisorStatus(s,rpc);await persist();return s;}
  if(body.type==='abort'&&!runners.has(s.id)){s.status='paused';await persist();return s;}
  if(body.type==='prompt'&&s.status==='running'&&!goalCommand)throw error('This session is running. Use Steer or Queue follow-up.');
  try{
   const rpc=await start(s);
   if(prompting&&/^\/plan(?:-review)?(?:\s|$)/.test(body.message)&&!s._planSupported)throw error('This OMP build has no RPC plan mode. Use an updated OMP build; /plan was not sent to the model.');
   const rpcType=goalCommand?'prompt':body.type;
   if(prompting){if(!goalCommand){if(body.type==='prompt')delete s._streamId;s.status='running';}s.error=undefined;const msg=append(s,'user',body.message||'Image attached',queuedId||randomUUID());if(body.type==='steer'&&!goalCommand)msg.steer='pending';if(images.length){msg.hasImage=true;if(body.preview)msg.imagePreview=body.preview;}}
   const id=randomUUID();
   const result=await rpc.send({type:rpcType,id,...(prompting?{message:body.message,...(images.length?{images}:{})}:{})},goalCommand?0:30000);
   // Only on acceptance: a rejected prompt (e.g. OMP busy) must not overwrite the live id, or the running turn's result would be ignored as stale.
   if(rpcType==='prompt')s._promptId=id;
   if(rpcType==='prompt'&&result?.agentInvoked===false&&!goalCommand)s.status='review';
   if(goalCommand){if(result?.agentInvoked===true)s.status='running';await refresh(s,rpc);}
   if(body.type==='abort'){s.status='paused';delete s.uiRequests;delete s._planReview;}
   await persist();return s;
  }catch(e){s.status='error';s.error=e.message;dropSteers(s);append(s,'system',e.message);await persist();return s;}
 }
 async function sendQueued(s){
  while(s.queuedMessages?.length&&s.status==='running'){
   const item=s.queuedMessages[0];
   const images=item.hasImage?chatImages({images:JSON.parse(await fs.readFile(queuedImageFile(item.id),'utf8'))}):[];
   s.status='review';
   await command(s,{type:'prompt',message:item.text,preview:item.imagePreview},images,item.id);
   if(s.status==='error'){s.messages=s.messages.filter(m=>m.id!==item.id);await persist();return;}
   if(closing)return;
   s.queuedMessages.shift();
   await persist();
   if(item.hasImage)await fs.rm(queuedImageFile(item.id),{force:true}).catch(()=>{});
   if(s.status==='review'&&s.queuedMessages.length)s.status='running';
   else break;
  }
 }
 function modelChoice(body){
  const raw=typeof body.model==='string'?body.model.trim():'';if(raw&&!/^[\w.~@+-]+\/[\w.~@:+\/-]+$/.test(raw))throw error('Invalid model.');
  const suffix=raw.includes(':')?raw.split(':').pop():'';
  const thinking=typeof body.thinking==='string'&&body.thinking?body.thinking:THINKING.includes(suffix)?suffix:'';if(thinking&&!THINKING.includes(thinking))throw error('Invalid thinking level.');
  return {selector:THINKING.includes(suffix)?raw.slice(0,-suffix.length-1):raw,thinking};
 }
 // OMP settings: `omp config list --json` has values, types and descriptions; the plain listing adds groups and enum options.
 let updateState={status:'idle'};
 const cleanUpdateOutput=(...parts)=>parts.filter(Boolean).join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().slice(-6000);
 async function runUpdate(startedAt){
  const bin=ompEntry,env={...process.env};
  if(path.isAbsolute(bin)){const key=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';env[key]=path.dirname(bin)+path.delimiter+(env[key]||'');}
  try{
   const {stdout,stderr}=await execOmp(['update'],{cwd:dataDir,env,timeout:20*60*1000,maxBuffer:8*1024*1024,windowsHide:true});
   updateState={status:'done',startedAt,finishedAt:now(),output:cleanUpdateOutput(stdout,stderr)||'OMP update finished without output.'};
   modelCache=undefined;configDefaults=undefined;
  }catch(e){updateState={status:'error',startedAt,finishedAt:now(),exitCode:typeof e.code==='number'?e.code:null,output:cleanUpdateOutput(e.stdout,e.stderr,e.killed?'Update timed out.':e.message)||'OMP update failed.'};}
 }
 // Matched on the last key segment's suffix, so thresholdTokens or redactSecrets are not treated as secrets.
 const SECRET=/(token|secret|password|apikey|api_key|credentials?)$/i;
 const isSecret=key=>SECRET.test(key.split('.').pop());
 async function configList(env){
  const run=args=>execOmp(args,{timeout:30000,maxBuffer:16*1024*1024,windowsHide:true,env:env?{...process.env,...env}:process.env});
  const [j,t]=await Promise.all([run(['config','list','--json']),run(['config','list'])]);
  const meta=new Map();let group='other';
  for(const line of t.stdout.split(/\r?\n/)){const g=line.match(/^\[(.+)\]$/);if(g){group=g[1];continue;}const m=line.match(/^\s{2}(\S+) = .* \(([^()]*)\)\s*$/);if(m&&!meta.has(m[1]))meta.set(m[1],{group,options:m[2].includes('|')?m[2].split('|'):undefined});}
  return {schema:JSON.parse(j.stdout),meta};
 }
 let configDefaults;
 async function settingDefaults(){
  // Listing against an empty agent directory yields OMP's built-in defaults.
  if(!configDefaults)configDefaults=(async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omp-web-defaults-'));try{return (await configList({PI_CODING_AGENT_DIR:dir})).schema;}finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}})().catch(e=>{configDefaults=undefined;throw e;});
  return configDefaults;
 }
 async function listSettings(){
  const [{schema,meta},defaults]=await Promise.all([configList(),settingDefaults().catch(()=>({}))]);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const settings=Object.entries(schema).map(([key,e])=>{const sensitive=!!e.redacted||isSecret(key);const d=defaults[key];const m=meta.get(key)||{};
   return {key,type:e.type,group:m.group||'other',options:m.options,description:e.description||'',sensitive,value:sensitive?undefined:e.value,isSet:e.value!==undefined&&e.value!==''&&e.value!==null,default:sensitive?undefined:d?.value,modified:d?!same(e.value,d.value):e.value!==undefined};});
  let file='';try{file=(await execOmp(['config','path'],{timeout:15000,windowsHide:true})).stdout.trim();}catch{}
  return {file,settings};
 }
 async function changeSetting(body,reset){
  const key=text(body.key,'Setting',200);const {schema}=await configList();const e=schema[key];if(!e)throw error('Unknown OMP setting.');
  let args;
  if(reset)args=['config','reset',key];
  else{const v=body.value;let out;
   if(e.type==='boolean'){if(typeof v!=='boolean')throw error('Expected true or false.');out=String(v);}
   else if(e.type==='number'){if(typeof v!=='number'||!isFinite(v))throw error('Expected a number.');out=String(v);}
   else if(e.type==='array'){if(!Array.isArray(v))throw error('Expected a list.');out=JSON.stringify(v);}
   else if(e.type==='record'){if(!v||typeof v!=='object'||Array.isArray(v))throw error('Expected an object.');out=JSON.stringify(v);}
   else{if(typeof v!=='string'||v.length>20000)throw error('Expected text.');out=v;}
   args=['config','set',key,out];}
  try{await execOmp(args,{timeout:30000,windowsHide:true});}
  catch(err){throw error(String(err.stderr||err.stdout||err.message).replace(/^Error:\s*/,'').trim().slice(0,500)||'OMP rejected the setting.');}
  modelCache=undefined;
  const all=await listSettings();return {...all,changed:key};
 }
// Installed + discoverable OMP plugins. `plugin list --json` is structured;
// `plugin discover` prints plain text even with --json, so parse its listing.
async function listPlugins(){
 const run=args=>execOmp(args,{cwd:dataDir,timeout:30000,maxBuffer:16*1024*1024,windowsHide:true});
 const [j,t]=await Promise.all([run(['plugin','list','--json']),run(['plugin','discover']).catch(()=>({stdout:''}))]);
 let installed;
 try{const d=JSON.parse(j.stdout);installed=[...(d.npm||[]),...(d.marketplace||[])].map(p=>{const e=p.entries?.[0]||{};return {id:String(p.id),version:e.version||'',scope:e.scope||p.scope||'',enabled:e.enabled!==false};}).filter(p=>p.id);}catch{throw error('Could not parse plugin list.');}
 const available=[];const lines=String(t.stdout||'').split(/\r?\n/);
 for(let i=0;i<lines.length;i++){const m=lines[i].match(/^\s{2}(\S+)\s*$/);if(!m||m[1].startsWith('-'))continue;const id=m[1];let description='';const n=lines[i+1];if(n&&/^ {4}\S/.test(n))description=n.trim().slice(0,500);available.push({id,description});}
 const descByBase=new Map(available.map(a=>[a.id.split('@')[0].toLowerCase(),a.description]));
 for(const p of installed)if(descByBase.get(p.id.split('@')[0].toLowerCase()))p.description=descByBase.get(p.id.split('@')[0].toLowerCase());
 return {plugins:installed,available};
}
async function pluginAction(body){
 const action=text(body.action,'Action',20).toLowerCase();
 if(!['install','uninstall','enable','disable'].includes(action))throw error('Unknown plugin action.');
 const id=text(body.id,'Plugin',200);
 // Installed ids are `name@marketplace`; install also accepts owner/repo or a path, so it keeps the broader charset.
 if(action==='install'){if(!/^[\w.~/:@+~-]{1,200}$/.test(id))throw error('Invalid plugin name.');}
 else if(!/^[\w.+-]+(@[\w.+-]+)?$/.test(id))throw error('Invalid plugin name.');
 let scope;
 if(body.scope!==undefined){scope=text(body.scope,'Scope',20).toLowerCase();if(scope!=='user'&&scope!=='project')throw error('Scope must be user or project.');}
 const args=['plugin',action,id,...(scope?['--scope',scope]:[])];
 try{await execOmp(args,{cwd:dataDir,timeout:20*60*1000,maxBuffer:16*1024*1024,windowsHide:true});}
 catch(err){throw error(cleanUpdateOutput(err.stderr,err.stdout,err.killed?'Plugin action timed out.':err.message)||`Could not ${action} the plugin.`);}
 return listPlugins();
}
 // Advisors come from WATCHDOG.yml (advisors[].model); without one OMP falls back to the 'advisor' model role.
 const agentDir=()=>process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent');
 async function watchdogFile(){for(const n of ['WATCHDOG.yml','WATCHDOG.yaml']){const f=path.join(agentDir(),n);try{return {file:f,text:await fs.readFile(f,'utf8')};}catch{}}return null;}
 async function advisorConfig(){
  const w=await watchdogFile();const m=w?.text.match(/^advisors:[\s\S]*?^\s+model:\s*["']?([^"'\s#]+)/m);
  let schema={};try{schema=(await configList()).schema;}catch{}
  const enabled=schema['advisor.enabled']?.value!==false;
  if(m)return {model:m[1],source:'WATCHDOG.yml',file:w.file,enabled};
  return {model:schema.modelRoles?.value?.advisor||'',source:'advisor role',file:w?.file,enabled};
 }
 async function setAdvisorModel(sel){
  if(!/^[\w.~@:/+-]+$/.test(sel))throw error('That does not look like a model selector.');
  const w=await watchdogFile();
  if(w&&/^advisors:[\s\S]*?^\s+model:/m.test(w.text)){
   // Only the first advisor's model line changes; comments and other advisors stay as written.
   const i=w.text.search(/^advisors:/m);const head=w.text.slice(0,i),tail=w.text.slice(i).replace(/^(\s+model:\s*)["']?[^"'\s#]+["']?/m,(_,a)=>a+sel);
   await fs.writeFile(w.file+'.tmp',head+tail);await fs.rename(w.file+'.tmp',w.file);return 'WATCHDOG.yml';
  }
  const {schema}=await configList();await changeSetting({key:'modelRoles',value:{...(schema.modelRoles?.value||{}),advisor:sel}},false);return 'advisor role';
 }
 let modelCache;
 async function listModels(){
  if(modelCache&&Date.now()-modelCache.at<10*60000)return modelCache.data;
  const {stdout}=await execOmp(['models','--json'],{timeout:60000,maxBuffer:64*1024*1024,windowsHide:true});
  const models=(JSON.parse(stdout).models||[]).filter(m=>!m.kind||m.kind==='chat').map(m=>({selector:m.selector||`${m.provider}/${m.id}`,provider:m.provider,id:m.id,name:m.name||m.id,reasoning:!!m.reasoning,thinking:Array.isArray(m.thinking)?m.thinking:[],contextWindow:m.contextWindow}));
  const roles={};let defaultThinking='';
  try{const cfg=await fs.readFile(path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent'),'config.yml'),'utf8');let inRoles=false;
   for(const line of cfg.split(/\r?\n/)){if(/^modelRoles:\s*$/.test(line)){inRoles=true;continue;}if(inRoles){const m=line.match(/^\s+([\w-]+):\s*(\S+)/);if(m){roles[m[1]]=m[2].replace(/^["']|["']$/g,'');continue;}if(/^\S/.test(line))inRoles=false;}
    const t=line.match(/^defaultThinkingLevel:\s*(\w+)/);if(t)defaultThinking=t[1];}}catch{}
  modelCache={at:Date.now(),data:{models,roles,defaultThinking,thinkingLevels:THINKING}};return modelCache.data;
 }
 async function ensureProject(dir,name){
  let p=store.projects.find(p=>samePath(p.path,dir));if(p)return p;
  let branch='workspace';try{branch=await git(dir,['branch','--show-current'])||'detached';}catch{}
  p={id:randomUUID(),name:String(name||'').trim().slice(0,80)||path.basename(dir)||dir,path:dir,description:'',branch,color:colors[store.projects.length%colors.length]};store.projects.push(p);activity(null,`Added project ${p.name}`);return p;
 }
 async function createSession(p,{title,prompt='',isolate=false,model,provider,native=false,sessionFile,messages=[],selector,thinking}){
  const id=randomUUID();let cwd=p.path;let branch=p.branch;let isolated=isolate;const notes=[];
  if(isolate){const wt=path.join(dataDir,'worktrees',id);const b='omp-web/'+id.slice(0,8);await fs.mkdir(path.dirname(wt),{recursive:true});
   try{await git(p.path,['worktree','add','-b',b,wt,'HEAD']);cwd=wt;branch=b;}catch(e){isolated=false;notes.push(`Worktree isolation skipped (needs a Git repository with at least one commit). Working directly in ${p.path}.`);}}
  const s={id,projectId:p.id,title,prompt,status:prompt?'queued':'paused',model:String(model||'OMP default'),provider:String(provider||''),branch,cwd,isolated,native,sessionFile,createdAt:now(),updatedAt:now(),tokens:0,cost:0,messages,todos:[]};
  if(selector){const i=selector.indexOf('/');s.modelSelector=selector;s.provider=selector.slice(0,i);s.model=selector.slice(i+1);}if(thinking){s.thinkingChoice=thinking;s.thinking=thinking;}
  for(const n of notes)append(s,'system',n);store.sessions.unshift(s);activity(s,sessionFile?`Resumed ${title}`:`Started ${title}`,'running');
  if(prompt)await command(s,{type:'prompt',message:prompt});else await persist();return s;
 }
 const ompSessionsDir=path.resolve(options.ompSessionsDir||process.env.OMP_SESSIONS_DIR||path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent'),'sessions'));
 const headCache=new Map();
 const insideSessions=(value,exts)=>{const file=path.resolve(text(value,'File',4000));const rel=path.relative(ompSessionsDir,file);if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||!exts.some(x=>file.endsWith(x)))throw error('Not an OMP session file.');return file;};
// Keyed by path so a growing transcript replaces its entry instead of adding one per poll.
const costCache=new Map();
async function transcriptCost(f,st){const hit=costCache.get(f);if(hit?.m===st.mtimeMs&&hit.s===st.size)return hit.c;let c=0;try{for(const l of (await fs.readFile(f,'utf8')).split('\n')){if(!l.includes('"cost"'))continue;try{c+=JSON.parse(l).message?.usage?.cost?.total||0;}catch{}}}catch{}costCache.set(f,{m:st.mtimeMs,s:st.size,c});return c;}
 async function background(file,live=false){
  const dir=file.replace(/\.jsonl$/,'');const scanned=await scanJobs(file);let entries=[];try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{}
  const subagents=[],jobs=[];
  await Promise.all(entries.filter(e=>e.isFile()).map(async e=>{const f=path.join(dir,e.name);let st;try{st=await fs.stat(f);}catch{return;}
   if(e.name.endsWith('.jsonl')){const name=e.name.slice(0,-6);let head={};try{head=await readSessionHead(f);}catch{}let result='';try{result=(await fs.readFile(path.join(dir,name+'.md'),'utf8')).slice(0,4000);}catch{}
    subagents.push({name,file:f,size:st.size,updatedAt:st.mtime.toISOString(),model:head.model||'',thinking:head.thinking||'',preview:head.preview||'',result,cost:await transcriptCost(f,st),advisor:name==='__advisor'||name.startsWith('__advisor.')});}
   else if(e.name.endsWith('.async.log')){jobs.push({name:e.name,file:f,size:st.size,updatedAt:st.mtime.toISOString()});}
  }));
  subagents.sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));jobs.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const byName=new Map(subagents.map(x=>[x.name,x]));
  let mtime=0;try{mtime=(await fs.stat(file)).mtimeMs;}catch{}const quiet=!live&&Date.now()-mtime>30*60e3;
  const tasks=scanned.map(j=>{const sub=byName.get(j.id);const status=j.status==='running'?(sub?.result?'done':quiet?'stale':'running'):j.status;return {...j,status,transcript:sub?.file||'',model:sub?.model||'',summary:sub?.result||'',cost:sub?.cost||0,updatedAt:sub?.updatedAt||j.finishedAt||j.startedAt};});
  const linked=new Set(tasks.map(t=>t.id));
  return {dir,tasks,subagents:subagents.filter(x=>!linked.has(x.name)),logs:jobs};
 }
 const sessionFileParam=value=>{const file=path.resolve(text(value,'Session file',4000));if(!file.endsWith('.jsonl')||!samePath(path.dirname(path.dirname(file)),ompSessionsDir))throw error('Not an OMP session file.');return file;};
 async function listNativeSessions(limit=200){
  const files=[];let dirs=[];try{dirs=await fs.readdir(ompSessionsDir,{withFileTypes:true});}catch{return [];}
  await Promise.all(dirs.filter(d=>d.isDirectory()).map(async d=>{const dir=path.join(ompSessionsDir,d.name);let entries=[];try{entries=await fs.readdir(dir);}catch{return;}
   await Promise.all(entries.filter(n=>n.endsWith('.jsonl')).map(async n=>{const file=path.join(dir,n);try{const st=await fs.stat(file);if(st.size>0)files.push({file,mtime:st.mtimeMs,size:st.size});}catch{}}));}));
  files.sort((a,b)=>b.mtime-a.mtime);
  return (await Promise.all(files.slice(0,limit).map(async f=>{
   const key=f.file+'|'+f.mtime;let head=headCache.get(key);if(!head){try{head=await readSessionHead(f.file);}catch{return null;}headCache.set(key,head);}
   const managed=store.sessions.find(s=>s.sessionFile&&samePath(s.sessionFile,f.file));
   return {file:f.file,title:head.title||head.preview.split('\n')[0].slice(0,80)||'Untitled session',cwd:head.cwd,id:head.id,preview:head.preview,createdAt:head.createdAt,updatedAt:new Date(f.mtime).toISOString(),size:f.size,managedId:managed?.id,model:head.model,thinking:head.thinking};
  }))).filter(Boolean);
 }
 async function browse(value){
  if(!value){
   const roots=[];const add=async(p,label)=>{if(p&&!roots.some(r=>samePath(r.path,p))&&await exists(p))roots.push({path:p,name:label||path.basename(p)||p});};
   await add(os.homedir(),'Home');for(const d of ['Documents/GitHub','Documents','Desktop','projects','code','src'])await add(path.join(os.homedir(),d));
   if(process.platform==='win32')for(const l of 'CDEFGHIJ')await add(l+':\\',l+':');else await add('/','/');
   const recent=[];for(const s of await listNativeSessions(120)){if(s.cwd&&!recent.some(r=>samePath(r.path,s.cwd))&&await exists(s.cwd))recent.push({path:s.cwd,name:path.basename(s.cwd)||s.cwd,lastUsed:s.updatedAt});if(recent.length>=12)break;}
   return {path:'',parent:null,roots,recent,dirs:[]};
  }
  const dir=await resolveDir(value);const entries=await fs.readdir(dir,{withFileTypes:true}).catch(e=>{throw error(`Cannot read directory: ${e.message}`);});
  const dirs=entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&!['node_modules','$RECYCLE.BIN','System Volume Information'].includes(e.name)).map(e=>({name:e.name,path:path.join(dir,e.name)})).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})).slice(0,1000);
  const parent=path.dirname(dir);return {path:dir,parent:parent===dir?null:parent,isGit:await exists(path.join(dir,'.git')),project:store.projects.find(p=>samePath(p.path,dir))?.id,dirs};
 }
 const lock=async(id,fn)=>{const previous=locks.get(id)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);locks.set(id,next);try{return await next;}finally{if(locks.get(id)===next)locks.delete(id);}};
 let refreshBusy=false;
 const refreshTimer=setInterval(async()=>{if(refreshBusy||closing)return;refreshBusy=true;try{await Promise.all([...runners].filter(([,r])=>r.alive).map(([id,r])=>refresh(store.sessions.find(s=>s.id===id),r)));await persist();}finally{refreshBusy=false;}},4000);refreshTimer.unref();
 const staticFiles=new Map();const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
 const digest=data=>createHash('sha1').update(data).digest('base64url').slice(0,12);
 const staticFile=async file=>{const st=await fs.stat(file);let c=staticFiles.get(file);if(c?.mtime!==st.mtimeMs||c.size!==st.size){const data=await fs.readFile(file);c={mtime:st.mtimeMs,size:st.size,data,hash:digest(data)};staticFiles.set(file,c);}return c;};
 const server=createServer(async(req,res)=>{
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});res.end(JSON.stringify(value));};
  try{
   const port=server.address()?.port;const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
   if(!hosts.has(req.headers.host))throw error('Invalid Host header.',403);
   const origin=req.headers.origin;const own=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
   if(origin&&!own.has(origin)&&!allowedOrigins.has(origin))throw error('Origin not allowed. Open the local dashboard or set OMP_ALLOWED_ORIGINS to the exact hosted origin.',403);
   if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Private-Network','true');}
   if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
   const url=new URL(req.url,`http://127.0.0.1:${port}`);
   if(!url.pathname.startsWith('/api/')){
    if(req.method!=='GET')throw error('Method not allowed.',405);
    const root=path.resolve(options.staticDir||path.join(path.dirname(fileURLToPath(import.meta.url)),'../local-dist'));
    let file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(file!==root&&!file.startsWith(root+path.sep))throw error('Invalid path.',403);
    if(url.pathname==='/')file=path.join(root,'app.html');
    let data,hash;try{({data,hash}=await staticFile(file));}catch{throw error('Dashboard files not found. Build with npm run build:local or use the prebuilt companion download.',404);}
    const ext=path.extname(file);
    if(ext==='.html'){const v={};for(const n of ['app.css','app.js'])v[n]=(await staticFile(path.join(root,n)).catch(()=>null))?.hash;data=Buffer.from(data.toString('utf8').replace(/(href|src)="\/(app\.(?:css|js))"/g,(m,a,n)=>v[n]?`${a}="/${n}?v=${v[n]}"`:m));hash=digest(data);}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.zip':'application/zip'};
    const headers={'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':csp,'Cache-Control':ext!=='.html'&&url.searchParams.get('v')===hash?'public, max-age=31536000, immutable':'no-cache',ETag:`"${hash}"`};
    if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers);res.end();return;}
    res.writeHead(200,headers);res.end(data);return;
   }
   const provided=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
   if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw error('Invalid connection token.',401);
   if(req.method==='GET'&&url.pathname==='/api/state'){json(store);return;}
   if(req.method==='GET'&&url.pathname==='/api/omp-sessions'){json({dir:ompSessionsDir,sessions:await listNativeSessions()});return;}
   if(req.method==='GET'&&url.pathname==='/api/omp-sessions/preview'){const file=sessionFileParam(url.searchParams.get('file'));let head;try{head=await readSessionHead(file);}catch{throw error('Session file not found.',404);}json({...head,file,contextTokens:await lastContext(file).catch(()=>undefined),messages:await importMessages(file,150)});return;}
   if(req.method==='GET'&&url.pathname==='/api/settings'){try{json(await listSettings());}catch(e){throw error(`Could not read OMP settings: ${e.message}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/plugins'){try{json(await listPlugins());}catch(e){throw error(`Could not read OMP plugins: ${e.message}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/omp-update'){json(updateState);return;}
   if(req.method==='GET'&&url.pathname==='/api/advisor'){json(await advisorConfig());return;}
   if(req.method==='GET'&&url.pathname==='/api/models'){try{json(await listModels());}catch(e){throw error(`Could not list OMP models: ${e.message}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/commands'){
    if(url.searchParams.has('path')){json({commands:await discoverCommands(await resolveDir(url.searchParams.get('path')))});return;}
    const s=store.sessions.find(s=>s.id===url.searchParams.get('session'));if(!s)throw error('Session not found.',404);
    await lock(s.id,async()=>{await start(s);await persist();});json({commands:commands.get(s.id)||[]});return;
   }
   if(req.method==='GET'&&url.pathname==='/api/background'){const file=insideSessions(url.searchParams.get('file'),['.jsonl']);const live=store.sessions.some(s=>s.sessionFile&&samePath(s.sessionFile,file)&&runners.has(s.id));const bg=await background(file,live);
    const own=store.sessions.find(s=>s.sessionFile&&samePath(s.sessionFile,file));json({...bg,live,agents:(own?.subagentList||[]).map(a=>({...a,thinking:subagentThoughts.get(own.id+':'+a.id)?.text||''}))});return;}
   if(req.method==='GET'&&url.pathname==='/api/transcript'){
    const file=insideSessions(url.searchParams.get('file'),['.jsonl']);let head;try{head=await readSessionHead(file);}catch{throw error('Transcript not found.',404);}let result='';try{result=(await fs.readFile(file.replace(/\.jsonl$/,'.md'),'utf8')).slice(0,20000);}catch{}
    const st=await fs.stat(file),messages=await importMessages(file,600);
    const thought=[...subagentThoughts.values()].find(t=>t.file&&samePath(t.file,file));
    const active=thought?runners.has(thought.parentId)&&thought.active:undefined;
    if(active&&thought.streaming&&thought.text&&!messages.some(m=>m.role==='thinking'&&m.sourceTimestamp!==undefined&&m.sourceTimestamp===thought.sourceTimestamp))messages.push({id:thought.id,role:'thinking',text:thought.text,at:thought.at,sourceTimestamp:thought.sourceTimestamp});
    json({...head,file,result,active,updatedAt:new Date(Math.max(st.mtimeMs,active?new Date(thought.at).getTime():0)).toISOString(),messages});return;
   }
   if(req.method==='GET'&&url.pathname==='/api/log'){const file=insideSessions(url.searchParams.get('file'),['.log']);const fh=await fs.open(file,'r').catch(()=>{throw error('Log not found.',404);});try{const {size}=await fh.stat();const n=Math.min(size,128*1024);const buf=Buffer.alloc(n);await fh.read(buf,0,n,size-n);json({file,size,text:buf.toString('utf8')});}finally{await fh.close();}return;}
   if(req.method==='GET'&&url.pathname==='/api/browse'){json(await browse(url.searchParams.get('path')||''));return;}
   if(req.method!=='POST')throw error('Route not found.',404);
   if(!String(req.headers['content-type']).startsWith('application/json'))throw error('JSON body required.',415);
   const cap=url.pathname==='/api/quick-start'||url.pathname==='/api/omp-sessions/resume'||/^\/api\/sessions\/[^/]+\/command$/.test(url.pathname)?48*1024*1024:256*1024;
   const buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>cap)throw error('Request body too large.',413);buffers.push(chunk);}let body;try{body=JSON.parse(Buffer.concat(buffers).toString());}catch{throw error('Invalid JSON.');}
   if(!body||typeof body!=='object'||Array.isArray(body))throw error('JSON object required.');
   if(url.pathname==='/api/projects'){
    const dir=await resolveDir(body.path);if(store.projects.some(p=>samePath(p.path,dir)))throw error('This directory is already registered.');
    const p=await ensureProject(dir,typeof body.name==='string'?body.name:'');p.description=String(body.description||'');await persist();json(p,201);return;
   }
   if(url.pathname==='/api/sessions'){
    const p=store.projects.find(p=>p.id===body.projectId);if(!p)throw error('Project not found.');const title=text(body.title,'Session title',120);const prompt=text(body.prompt,'Initial prompt',200000);
    json(await createSession(p,{title,prompt,isolate:body.isolate!==false,model:body.model,provider:body.provider}),201);return;
   }
   // One step: pick a folder, optionally type a prompt, go. The project is registered automatically.
   if(url.pathname==='/api/settings'){json(await changeSetting(body,false));return;}
   if(url.pathname==='/api/settings/reset'){json(await changeSetting(body,true));return;}
   if(url.pathname==='/api/plugins'){json(await pluginAction(body));return;}
   if(url.pathname==='/api/omp-update'){
    if(updateState.status==='running')throw error('OMP update is already running.',409);
    updateState={status:'running',startedAt:now()};void runUpdate(updateState.startedAt);json(updateState,202);return;
   }
   if(url.pathname==='/api/quick-start'){
    const dir=await resolveDir(body.path);const images=chatImages(body);const raw=typeof body.prompt==='string'?body.prompt.trim().slice(0,200000):'';const p=await ensureProject(dir);
    const title=(typeof body.title==='string'&&body.title.trim().slice(0,120))||raw.split('\n')[0].slice(0,70)||`New session · ${p.name}`;
    const {selector,thinking}=modelChoice(body);
    const s=await createSession(p,{title,prompt:'',isolate:body.isolate===true,native:true,selector,thinking});
    if(typeof body.advisor==='boolean')await lock(s.id,()=>command(s,{type:'advisor',action:body.advisor?'on':'off'}));
    json(images.length||raw?await lock(s.id,()=>command(s,{type:'prompt',message:raw,images,preview:body.preview},images)):s,201);return;
   }
   if(url.pathname==='/api/omp-sessions/resume'){
    const file=sessionFileParam(body.file);const images=chatImages(body);const message=typeof body.message==='string'?body.message.trim().slice(0,200000):'';
    const submitted=!!message||body.images!==undefined;
    const existing=store.sessions.find(s=>s.sessionFile&&samePath(s.sessionFile,file));
    store.archived=store.archived.filter(k=>k!=='f:'+file&&k!=='f:'+body.file);
    if(existing){existing.hidden=false;if(body.model||body.thinking)await lock(existing.id,()=>command(existing,{type:'set_model',model:body.model,thinking:body.thinking}));json(submitted?await lock(existing.id,()=>command(existing,{type:existing.status==='running'?'follow_up':'prompt',message,images,preview:body.preview},images)):(await persist(),existing));return;}
    let head;try{head=await readSessionHead(file);}catch{throw error('Session file not found.',404);}
    if(!head.cwd||!await exists(head.cwd))throw error(`The session's working directory no longer exists: ${head.cwd||'unknown'}`);
    const p=await ensureProject(await resolveDir(head.cwd));const title=(head.title||head.preview.split('\n')[0]||'Resumed session').slice(0,120);
    const messages=await importMessages(file).catch(()=>[]);const contextTokens=await lastContext(file).catch(()=>undefined);messages.push({id:randomUUID(),role:'system',text:'Resumed from OMP session history. Avoid prompting it here while the same session is open in a terminal.',at:now()});
    const {selector,thinking}=modelChoice(body);const s=await createSession(p,{title,native:true,sessionFile:file,messages,selector,thinking});s.contextTokens=contextTokens;
    // OMP resumes with the model saved in the transcript; show it until the runner reports its own state.
    if(!selector&&head.model?.includes('/')){const i=head.model.indexOf('/');s.provider=head.model.slice(0,i);s.model=head.model.slice(i+1);}if(!thinking&&head.thinking)s.thinking=head.thinking;
    json(submitted?await lock(s.id,()=>command(s,{type:'prompt',message,images,preview:body.preview},images)):s,201);return;
   }
   if(url.pathname==='/api/archive'){
    const key=typeof body.key==='string'?body.key:'';if(!/^[sf]:./.test(key)||key.length>4096)throw error('Invalid session key.');
    if(key.startsWith('s:')){const s=store.sessions.find(s=>s.id===key.slice(2));if(!s)throw error('Session not found.',404);if(body.archived!==false&&['running','queued'].includes(s.status))throw error('Stop the session before archiving it.');}
    const set=new Set(store.archived);if(body.archived===false)set.delete(key);else set.add(key);store.archived=[...set];await persist();json({archived:store.archived});return;
   }
   const match=url.pathname.match(/^\/api\/sessions\/([^/]+)\/command$/);
   if(match){const s=store.sessions.find(s=>s.id===match[1]);if(!s)throw error('Session not found.',404);json(await(body.type==='answer'?command(s,body):lock(s.id,()=>command(s,body))));return;}
   throw error('Route not found.',404);
  }catch(e){json({error:e.message},e.status||500);}
 });
 const close=async()=>{closing=true;clearInterval(refreshTimer);clearTimeout(eventSaveTimer);const stops=[...runners.values(),...commandProbes].map(r=>new Promise(resolve=>{r.child.once('close',resolve);if(!r.stopping)r.kill();}));for(const s of store.sessions){delete s._compacting;delete s.uiRequests;if(s.status==='running')s.status='paused';}await Promise.allSettled([...locks.values()]);await persist();await new Promise(r=>{server.close(r);server.closeAllConnections();});await Promise.all(stops);};
 await persist();return {server,store,token,close,flush:()=>saveChain};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=await createCompanion();const port=Number(process.env.OMP_WEB_PORT||4545);
 app.server.listen(port,'127.0.0.1',()=>{
  // The token travels in the URL fragment, which browsers never send to the server or in Referer headers.
  const link=`http://127.0.0.1:${port}/#token=${app.token}`;
  console.log(`\nOMP Control Room\n\nOpen: ${link}\nConnection token: ${app.token}\n\nYour provider credentials remain in OMP. Keep this process running.\n`);
  if(!process.env.OMP_WEB_NO_OPEN){const [cmd,args]=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',link]]:process.platform==='darwin'?['open',[link]]:['xdg-open',[link]];execFile(cmd,args,{windowsHide:true},()=>{});}
 });
 app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`\nPort ${port} is already in use: the companion is probably already running at http://127.0.0.1:${port}/\nClose it, or set OMP_WEB_PORT to use another port.\n`:`\nThe companion could not start: ${e.message}\n`);process.exit(1);});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
