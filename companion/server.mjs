import { createServer, STATUS_CODES } from 'node:http';
import { connect } from 'node:net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { RpcProcess } from './rpc.mjs';
const exec=promisify(execFile);
const now=()=>new Date().toISOString();
// One work interval spans steering, questions, retries and queued continuations.
const startWork=s=>{if(!s.workStartedAt||s.workFinishedAt){s.workStartedAt=now();delete s.workFinishedAt;}};
const finishWork=(s,at=now())=>{if(s.workStartedAt&&!s.workFinishedAt)s.workFinishedAt=at;};
const colors=['#e8a16a','#93a9ee','#80bca4','#b59bd6'];
const error=(message,status=400)=>Object.assign(new Error(message),{status});
function text(value,name,max=10000){if(typeof value!=='string'||!value.trim()||value.length>max)throw error(`${name} is required (maximum ${max} characters).`);return value.trim();}
// One `ask` dialog question from OMP; null when malformed, since replies must echo its ids and labels exactly.
function askQuestion(x){
 if(typeof x?.id!=='string'||!Array.isArray(x.options)||x.options.some(o=>typeof o?.label!=='string'))return null;
 const q={id:x.id,question:String(x.question||'Question').slice(0,2000),multi:x.multi===true,options:x.options.map(o=>({label:o.label,...(o.description?{description:String(o.description).slice(0,500)}:{}),...(o.preview?{preview:String(o.preview).slice(0,4000)}:{})}))};
 if(x.header)q.header=String(x.header).slice(0,60);
 if(Number.isInteger(x.recommended)&&x.recommended>=0&&x.recommended<q.options.length)q.recommended=x.recommended;
 return q;
}
// Mirrors OMP's ask validation, so a bad reply is a 400 here instead of a failed tool call; every question needs an answer.
function askAnswers(q,answers){
 if(!Array.isArray(answers)||answers.length!==q.questions.length)throw error('Answer every question.');
 return q.questions.map((x,i)=>{
  const a=answers[i],name=x.question.length>80?x.question.slice(0,80)+'…':x.question;
  if(a?.id!==x.id)throw error('These answers belong to a different question.');
  const picked=Array.isArray(a.selectedOptions)?a.selectedOptions:[],labels=x.options.map(o=>o.label);
  if(picked.some(l=>!labels.includes(l))||new Set(picked).size!==picked.length)throw error(`Choose listed options for “${name}”.`);
  if(a.customInput!==undefined&&(typeof a.customInput!=='string'||a.customInput.length>20000))throw error('Answer must be text under 20,000 characters.');
  const custom=a.customInput?.trim()||'';
  if(!picked.length&&!custom)throw error(`Answer “${name}”.`);
  if(!x.multi&&(picked.length>1||(picked.length&&custom)))throw error(`“${name}” takes a single answer.`);
  return {id:x.id,selectedOptions:picked,...(custom?{customInput:custom}:{})};
 });
}
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
const MAX_IMAGE_BYTES=5*1024*1024;
// Prompt cost estimates: ~4 characters per text token; images as Anthropic bills them, (w×h)/750 after its
// 1568px / 1.15 MP downscale (the costliest common provider). The dashboard (app.js) uses the same formula.
const textTokens=t=>Math.ceil(String(t||'').length/4);
const imageTokens=(w,h)=>{if(!(w>0&&h>0))return 1600;const k=Math.min(1,1568/Math.max(w,h),Math.sqrt(1.15e6/(w*h)));return Math.ceil(w*h*k*k/750);};
// Pixel size from the file header; null when the header can't be read (costed as the 1600-token maximum).
function imageSize({mimeType,data}){
 try{const b=Buffer.from(data,'base64');
  if(mimeType==='image/png')return [b.readUInt32BE(16),b.readUInt32BE(20)];
  if(mimeType==='image/gif')return [b.readUInt16LE(6),b.readUInt16LE(8)];
  if(mimeType==='image/webp'){const k=b.toString('ascii',12,16);
   if(k==='VP8X')return [1+b.readUIntLE(24,3),1+b.readUIntLE(27,3)];
   if(k==='VP8L'){const v=b.readUInt32LE(21);return [1+(v&0x3fff),1+((v>>>14)&0x3fff)];}
   if(k==='VP8 ')return [b.readUInt16LE(26)&0x3fff,b.readUInt16LE(28)&0x3fff];}
  if(mimeType==='image/jpeg')for(let i=2;i+9<b.length;){
   if(b[i]!==0xff||b[i+1]===0xff){i++;continue;}const m=b[i+1];
   if(m>=0xc0&&m<=0xcf&&m!==0xc4&&m!==0xc8&&m!==0xcc)return [b.readUInt16BE(i+7),b.readUInt16BE(i+5)];
   i+=m===0x01||(m>=0xd0&&m<=0xd8)?2:2+b.readUInt16BE(i+2);}
 }catch{}
 return null;
}
const imagesTokens=images=>images.reduce((n,i)=>n+imageTokens(...(imageSize(i)||[])),0);
function chatImages(body){
 if(body.images===undefined)return [];
 if(!Array.isArray(body.images)||!body.images.length)throw error('Attach at least one image.');
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
// Opens a console window on this machine in `dir` (a phone using the panel opens it on the computer, not the phone).
// `dir` is only the working directory, never part of a command line. Windows: `start` gives the new cmd its own
// console window (a detached child has none, so cmd would read EOF and exit at once).
function openTerminal(dir){
 const shell=process.env.ComSpec||'cmd.exe';
 const [cmd,args]=process.platform==='win32'?[shell,['/c','start','',shell]]:process.platform==='darwin'?['open',['-a','Terminal',dir]]:['x-terminal-emulator',[]];
 const child=spawn(cmd,args,{cwd:dir,detached:process.platform!=='win32',stdio:'ignore',windowsHide:true});
 return new Promise((resolve,reject)=>{child.once('error',e=>reject(error(`Could not open a terminal: ${e.message}`,500)));child.once('spawn',()=>{child.unref();resolve();});});
}
// Turns off the computer running the companion (a phone using the panel shuts down the computer, not the phone).
// Fixed argv, no shell. macOS asks System Events, which needs no sudo; Linux asks systemd/logind, which applies its polkit policy.
function shutdownCommand(platform=process.platform){
 return platform==='win32'?['shutdown',['/s','/t','0']]:platform==='darwin'?['osascript',['-e','tell application "System Events" to shut down']]:['systemctl',['poweroff']];
}
// Resolves once the OS accepted the request: the command exits 0 (e.g. Windows says 1190 when a shutdown is already scheduled).
function shutdownHost(){
 const [cmd,args]=shutdownCommand();
 const child=spawn(cmd,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});let stderr='';child.stderr.on('data',d=>{stderr+=d;});
 return new Promise((resolve,reject)=>{child.once('error',e=>reject(error(`Could not shut down this PC: ${e.message}`,500)));child.once('close',code=>code===0?resolve():reject(error(`Could not shut down this PC: ${stderr.trim().slice(-500)||`${cmd} exited with code ${code}.`}`,500)));});
}
// The note a restarting companion leaves for the next one (start.bat's loop): fresh for maxAgeMs, with its random token, if any.
// Anything else (missing, stale, malformed) means a normal start.
function restartHandoff(text,nowMs,maxAgeMs=2*60*1000){
 let v;try{v=JSON.parse(text);}catch{return null;}
 if(!v||typeof v!=='object'||!Number.isFinite(v.at)||v.at>nowMs||nowMs-v.at>maxAgeMs)return null;
 return typeof v.token==='string'&&/^[0-9a-f]{64}$/.test(v.token)?{token:v.token}:{};
}
// Git runs for the Changes working-tree view and worktree finishing: errors carry git's own stderr.
async function gitRun(cwd,args,{timeout=30000,maxBuffer=16*1024*1024,env}={}){try{return (await exec('git',['-C',cwd,...args],{timeout,maxBuffer,windowsHide:true,...(env?{env:{...process.env,...env}}:{})})).stdout;}catch(e){throw error(String(e.stderr||e.message).trim().split('\n').slice(-6).join('\n')||'git failed.',e.killed?504:400);}}
// `git diff` output in OMP's line-numbered diff format (" N|ctx" old N, "-N|old", "+N|new"; blank lines between hunks),
// so the dashboard renders it with the same diff view as edit-tool records. Paths are as git prints them (b/ side).
const unquoteGitPath=p=>/^".*"$/.test(p)?p.slice(1,-1).replace(/\\(["\\])/g,'$1').replace(/\\t/g,'\t').replace(/\\n/g,'\n'):p;
function gitDiffFiles(out,{budget=2*1024*1024,perFile=200*1024}={}){
 const files=[];
 for(const chunk of String(out||'').split(/^diff --git /m).slice(1)){
  const lines=chunk.split('\n');let from='',to='',op='modify';const body=[];let o=0,n=0,inHunk=false,binary=false;
  for(const l of lines.slice(1)){
   if(!inHunk){
    if(l.startsWith('new file mode'))op='create';else if(l.startsWith('deleted file mode'))op='delete';
    else if(l.startsWith('--- '))from=l.slice(4);else if(l.startsWith('+++ '))to=l.slice(4);
    else if(l.startsWith('Binary files '))binary=true;
   }
   const h=l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
   if(h){if(body.length)body.push('');o=+h[1];n=+h[2];inHunk=true;continue;}
   if(!inHunk)continue;
   if(l.startsWith(' ')){body.push(` ${o}|${l.slice(1)}`);o++;n++;}
   else if(l.startsWith('-')){body.push(`-${o}|${l.slice(1)}`);o++;}
   else if(l.startsWith('+')){body.push(`+${n}|${l.slice(1)}`);n++;}
  }
  // Git ends ---/+++ paths that contain spaces with a tab.
  const side=to&&to!=='/dev/null'?to:from;let p=unquoteGitPath(side.replace(/\t$/,'')).replace(/^[ab]\//,'');
  if(!p){const m=lines[0].match(/^a\/(.*) b\/(.*)$/);p=m?m[2]:lines[0];}
  let diff=binary?'… (binary file)':body.join('\n');
  if(diff.length>perFile)diff=diff.slice(0,perFile)+'\n… (diff truncated)';
  if(budget<=0){files.push({path:p,op,diff:'… (diff omitted: too many changes)'});continue;}
  budget-=diff.length;files.push({path:p,op,diff});
 }
 return files;
}
// An untracked file as an all-added diff; binary or oversized files get a note instead of their bytes.
async function untrackedDiff(file,max=200*1024){
 const fh=await fs.open(file,'r');try{const {size}=await fh.stat();const buf=Buffer.alloc(Math.min(size,max));await fh.read(buf,0,buf.length,0);
  if(buf.includes(0))return '… (binary file)';
  const lines=buf.toString('utf8').replace(/\n$/,'').split('\n');return lines.map((l,i)=>`+${i+1}|${l}`).join('\n')+(size>max?'\n… (file truncated)':'');}
 finally{await fh.close();}
}
// Editors that register a URL scheme taking file/<path>:<line>; opening a URL never goes through a shell.
const EDITORS={vscode:'vscode','vscode-insiders':'vscode-insiders',cursor:'cursor',windsurf:'windsurf'};
const EDITOR_CHOICES=['auto',...Object.keys(EDITORS),'reveal'];
function editorUrl(scheme,file,line){
 const parts=file.replace(/\\/g,'/').split('/');
 const enc=parts.map((seg,i)=>i===0&&/^[A-Za-z]:$/.test(seg)?seg:encodeURIComponent(seg)).join('/');
 return `${scheme}://file${enc.startsWith('/')?'':'/'}${enc}${line?`:${line}`:''}`;
}
// Opens a URL with the OS handler (like the companion's own browser launch), or shows a file in its folder.
function openWithOs(target,{reveal=false}={}){
 const [cmd,args]=reveal
  ?process.platform==='win32'?['explorer.exe',[`/select,"${target}"`]]:process.platform==='darwin'?['open',['-R',target]]:['xdg-open',[path.dirname(target)]]
  :process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',target]]:process.platform==='darwin'?['open',[target]]:['xdg-open',[target]];
 // Explorer wants /select,"<path>" as one verbatim argument; Windows paths cannot contain quotes.
 // No windowsHide: rundll32 forwards its own SW_HIDE to the handler, so a cold-started editor would get a hidden window.
 const child=spawn(cmd,args,{detached:process.platform!=='win32',stdio:'ignore',windowsVerbatimArguments:reveal&&process.platform==='win32'});
 return new Promise((resolve,reject)=>{child.once('error',e=>reject(error(`Could not open the editor: ${e.message}`,500)));child.once('spawn',()=>{child.unref();resolve();});});
}
let editorProbe;
// `auto` picks the first editor whose command line tool is on PATH, else shows the file in its folder.
function detectEditor(){return editorProbe??=(async()=>{for(const [id,bin] of [['vscode','code'],['cursor','cursor'],['windsurf','windsurf'],['vscode-insiders','code-insiders']]){try{await exec(process.platform==='win32'?'where':'which',[bin],{timeout:5000,windowsHide:true});return id;}catch{}}return 'reveal';})();}
// One /btw topic as the dashboard shows it: the first question plus follow-ups, each with its (possibly streaming) answer.
const btwTurnView=t=>({question:String(t?.question||'').slice(0,20000),answer:String(t?.answer||'').slice(-100000),status:['running','complete','cancelled','error','interrupted'].includes(t?.status)?t.status:'error',...(t?.error?{error:String(t.error).slice(0,2000)}:{}),createdAt:Number(t?.createdAt)||0});
const btwView=r=>({id:String(r.id),...btwTurnView(r),followUps:(Array.isArray(r.followUps)?r.followUps:[]).slice(-50).map(btwTurnView)});
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
// `reasoning` is the level the session last ran with: the spawn's ":level" suffix, a level change, or the effort sent with a request ("auto" resolves there).
function scanModel(head,f){
 if(f.type==='model_change'&&f.model)head.model=String(f.model).replace(/:.*$/,'');
 else if(f.type==='thinking_level_change'&&f.thinkingLevel)head.thinking=head.reasoning=f.thinkingLevel;
 else if(f.type==='session_init'){const l=String(f.resolvedModel||'').split(':').pop();if(l!=='auto'&&THINKING.includes(l))head.reasoning=l;}
 else if(f.type==='message'&&f.message?.role==='assistant'){const m=f.message;if(m.provider&&m.model)head.model=`${m.provider}/${m.model}`;const e=m.requestControls?.effort?.topLevel;if(typeof e==='string'&&e)head.reasoning=e;}
}
async function readSessionHead(file){
 const fh=await fs.open(file,'r');try{const size=(await fh.stat()).size;const buf=Buffer.alloc(64*1024);const {bytesRead}=await fh.read(buf,0,buf.length,0);const head={title:'',cwd:'',id:'',createdAt:'',preview:'',model:'',thinking:'',reasoning:''};
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
  if(m.role==='user'){const v=contentText(m.content).trim(),hasImage=Array.isArray(m.content)&&m.content.some(c=>c?.type==='image'),agent=m.synthetic&&m.attribution==='agent';if(v||hasImage)out.push({id:f.id||randomUUID(),role:agent?'advisor-update':'user',text:v.slice(-100000)||'Image attached',hasImage,at,...(f.type==='message'&&f.id&&!agent?{entryId:String(f.id)}:{})});}
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

// Single parser for `omp usage --json`: the /usage chat snapshot and the live usage panel both render from this.
// Result is grouped by provider, the session's provider first, then the others in OMP's order.
function modelUsage(data,provider,model){
 if(!Array.isArray(data?.reports))throw new Error('OMP returned an invalid usage report.');
 const clean=v=>String(v??'').replace(/[\r\n\t`]/g,' ');
 const number=v=>Number.isFinite(v)?v:undefined;
 const amount=v=>v.toLocaleString('en-US',{maximumFractionDigits:2});
 const identity=(meta,fallback)=>[meta?.email||meta?.accountId||meta?.projectId||fallback,meta?.orgName||meta?.orgId,meta?.planType].filter(Boolean).map(clean).join(' · ');
 const without=Array.isArray(data.accountsWithoutUsage)?data.accountsWithoutUsage:[];
 const group=name=>{
 const accounts=data.reports.filter(r=>r.provider===name).map((r,i)=>{
  // One malformed report must not take the other providers' limits down with it.
  if(!Array.isArray(r.limits))return {name:identity(r.metadata,`Account ${i+1}`),notes:[],limits:[],unavailable:'invalid usage limits reported'};
  const limits=r.limits.map(limit=>{
   const a=limit.amount||{},used=number(a.used),cap=number(a.limit),left=number(a.remaining),leftFraction=number(a.remainingFraction);
   let fraction=number(a.usedFraction);
   if(fraction===undefined&&used!==undefined)fraction=cap>0?used/cap:a.unit==='percent'?used/100:undefined;
   if(fraction===undefined&&leftFraction!==undefined)fraction=1-leftFraction;
   if(fraction===undefined&&a.unit==='percent'&&left!==undefined)fraction=1-left/100;
   const remaining=left??(used!==undefined&&cap!==undefined?Math.max(0,cap-used):undefined);
   const values=[];
   if(remaining!==undefined&&a.unit!=='percent')values.push(`${amount(remaining)} ${clean(a.unit==='unknown'?'':a.unit)} remaining`.replace(/ +/g,' '));
   if(fraction!==undefined)values.push(`${(Math.max(0,1-fraction)*100).toFixed(1)}% remaining · ${(fraction*100).toFixed(1)}% used`);
   if(!values.length)values.push('Remaining quota unavailable');
   if(used!==undefined&&a.unit!=='percent')values.push(`${amount(used)}${cap!==undefined?' / '+amount(cap):''} ${clean(a.unit==='unknown'?'':a.unit)} used`);
   const scope=limit.scope||{},window=limit.window;
   const resets=Number.isFinite(window?.resetsAt)&&Number.isFinite(new Date(window.resetsAt).getTime());
   return {label:clean(limit.label||limit.id),detail:[window?.label,scope.modelId&&'model: '+scope.modelId,scope.tier&&'tier: '+scope.tier].filter(Boolean).map(clean).join(' · '),
    fraction,summary:values.join(' · '),resetsAt:resets?window.resetsAt:undefined,resetLabel:resets?clean(window.resetLabel||'Resets'):undefined,notes:(limit.notes||[]).map(clean)};
  });
  return {name:identity(r.metadata,`Account ${i+1}`),fetchedAt:Number.isFinite(new Date(r.fetchedAt).getTime())?new Date(r.fetchedAt).toISOString():undefined,notes:(r.notes||[]).map(clean),limits,unavailable:limits.length?undefined:'no limits reported'};
 });
 for(const a of without)if(a.provider===name)accounts.push({name:identity(a,'Account'),notes:[],limits:[],unavailable:'no usage data'});
 return {provider:clean(name),accounts,unavailable:accounts.length?undefined:`${clean(name)} did not report usage limits`};
 };
 const providers=[...new Set([provider,...data.reports.map(r=>r.provider),...without.map(a=>a.provider)].filter(p=>p&&typeof p==='string'))].map(group);
 return {provider:clean(provider),model:clean(model),providers};
}
function modelUsageText(u){
 const lines=[`Usage: ${u.provider}/${u.model}`,'All logged-in providers, the selected model\'s first; limits may be shared across models.'];
 for(const p of u.providers){
  lines.push('',`== ${p.provider} ==`);
  if(p.unavailable)lines.push(`Remaining quota unavailable: ${p.unavailable}.`);
  for(const a of p.accounts){
   lines.push('',a.name);
   if(a.fetchedAt)lines.push(`Fetched: ${a.fetchedAt}`);
   lines.push(...a.notes);
   if(a.unavailable)lines.push(`  Remaining quota unavailable: ${a.unavailable}.`);
   for(const l of a.limits){
    lines.push(`  ${l.label}${l.detail?' · '+l.detail:''}`,`    ${l.summary}`);
    if(l.resetsAt!==undefined)lines.push(`    ${l.resetLabel}: ${new Date(l.resetsAt).toISOString()}`);
    for(const note of l.notes)lines.push('    '+note);
   }
  }
 }
 return ['```text',...lines,'```'].join('\n');
}

const MODEL_RE=/^[\w.~@+-]+\/[\w.~@:+\/-]+$/;
// Per-session OMP launch flags. Values are passed as `--flag=value`, so a value can never be read as another flag.
const APPROVAL_MODES=['always-ask','write','yolo'];
const LAUNCH_BOOLS={prewalk:'--prewalk',planYolo:'--plan-yolo',noTools:'--no-tools',noLsp:'--no-lsp',noPty:'--no-pty',noSkills:'--no-skills',noRules:'--no-rules',noExtensions:'--no-extensions',noTitle:'--no-title'};
const LAUNCH_MODELS={smol:'--smol',slow:'--slow',plan:'--plan',prewalkInto:'--prewalk-into',planYoloInto:'--plan-yolo-into'};
async function launchOptions(v){
 if(v===undefined||v===null)return undefined;
 if(typeof v!=='object'||Array.isArray(v))throw error('Invalid launch options.');
 const o={};const list=(value,name,re,max)=>{const items=(Array.isArray(value)?value:String(value??'').split(',')).map(x=>String(x).trim()).filter(Boolean);if(items.length>max||items.some(x=>x.length>200||!re.test(x)))throw error(`Invalid ${name}.`);return items;};
 if(v.approvalMode){if(!APPROVAL_MODES.includes(v.approvalMode))throw error('Approval mode must be always-ask, write or yolo.');o.approvalMode=v.approvalMode;}
 for(const k of Object.keys(LAUNCH_BOOLS))if(v[k]===true)o[k]=true;else if(v[k]!==undefined&&v[k]!==false)throw error(`${k} must be true or false.`);
 for(const k of Object.keys(LAUNCH_MODELS))if(v[k]){if(typeof v[k]!=='string'||!MODEL_RE.test(v[k].trim()))throw error(`Invalid ${k} model.`);o[k]=v[k].trim();}
 if(v.tools){const t=list(v.tools,'tool list',/^[\w-]+$/,80);if(t.length)o.tools=t;}
 if(v.skills){const t=list(v.skills,'skill patterns',/^[\w*?.:@\/-]+$/,40);if(t.length)o.skills=t;}
 if(v.maxTime){const t=String(v.maxTime).trim();if(!/^\d{1,6}[smh]?$/.test(t))throw error('Max time looks like 600, 10m or 1h.');o.maxTime=t;}
 if(v.addDirs){const dirs=Array.isArray(v.addDirs)?v.addDirs:String(v.addDirs).split('\n');const out=[];for(const d of dirs.map(x=>String(x).trim()).filter(Boolean).slice(0,10))out.push(await resolveDir(d));if(out.length)o.addDirs=out;}
 for(const k of ['systemPrompt','appendSystemPrompt'])if(typeof v[k]==='string'&&v[k].trim()){if(v[k].length>8000)throw error('System prompts are limited to 8,000 characters here.');o[k]=v[k].trim();}
 else if(v[k]!==undefined&&typeof v[k]!=='string')throw error(`${k} must be text.`);
 return Object.keys(o).length?o:undefined;
}
// `--plan-yolo` forces plan mode at start, so it only applies to a session's first launch.
function launchArgs(o,first){
 if(!o)return [];const a=[];
 if(o.approvalMode)a.push('--approval-mode='+o.approvalMode);
 for(const [k,f] of Object.entries(LAUNCH_BOOLS))if(o[k]&&(k!=='planYolo'||first))a.push(f);
 for(const [k,f] of Object.entries(LAUNCH_MODELS))if(o[k]&&(k!=='planYoloInto'||first&&o.planYolo)&&(k!=='prewalkInto'||o.prewalk))a.push(`${f}=${o[k]}`);
 if(o.tools)a.push('--tools='+o.tools.join(','));if(o.skills)a.push('--skills='+o.skills.join(','));if(o.maxTime)a.push('--max-time='+o.maxTime);
 for(const d of o.addDirs||[])a.push('--add-dir='+d);
 if(o.systemPrompt)a.push('--system-prompt='+o.systemPrompt);if(o.appendSystemPrompt)a.push('--append-system-prompt='+o.appendSystemPrompt);
 return a;
}
// OMP's session tree, flattened for display. Indentation grows only where the conversation forks.
function treeView(r){
 const leaf=r?.leafId||null,parents=new Map(),nodes=[];const stack=(Array.isArray(r?.tree)?r.tree:[]).map(n=>[n,0]).reverse();
 while(stack.length&&nodes.length<3000){const [n,depth]=stack.pop();const e=n?.entry||{};parents.set(e.id,e.parentId);const kids=Array.isArray(n?.children)?n.children:[];
  const m=e.type==='message'?e.message||{}:null;let kind='',textv='';
  if(m?.role==='user'){kind='user';textv=contentText(m.content)||(Array.isArray(m.content)&&m.content.some(c=>c?.type==='image')?'Image attached':'');}
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
function entryPrompt(e){
 const m=e?.type==='message'?e.message:null;if(m?.role!=='user'||(m.synthetic&&m.attribution==='agent'))return null;
 const parts=Array.isArray(m.content)?m.content:[{type:'text',text:String(m.content??'')}];
 return {entryId:String(e.id),text:parts.filter(c=>c?.type==='text').map(c=>c.text).join(''),images:parts.filter(c=>c?.type==='image'&&typeof c.data==='string'&&typeof c.mimeType==='string').map(c=>({type:'image',mimeType:c.mimeType,data:c.data}))};
}
// From get_entries: entryId's prompt, or without one the newest prompt on OMP's active path (leaf back to the root).
function userPrompt(r,entryId){
 const byId=new Map((Array.isArray(r?.entries)?r.entries:[]).map(e=>[e?.id,e]));
 if(entryId!==undefined)return entryPrompt(byId.get(entryId));
 for(let id=r?.leafId,seen=new Set();id&&!seen.has(id);id=byId.get(id)?.parentId){seen.add(id);const p=entryPrompt(byId.get(id));if(p)return p;}
 return null;
}
const TODO_STATUS=['pending','in_progress','completed','abandoned','blocked'];
function todoPhases(v){
 if(!Array.isArray(v)||v.length>30)throw error('Todos must be a list of up to 30 phases.');
 const str=(x,n,name,req)=>{if(x===undefined&&!req)return undefined;if(typeof x!=='string'||(req&&!x.trim())||x.length>n)throw error(`Invalid todo ${name}.`);return x;};
 return v.map(p=>{if(!p||typeof p!=='object'||!Array.isArray(p.tasks)||p.tasks.length>200)throw error('Invalid todo phase.');
  return {name:str(p.name,200,'phase name',true),tasks:p.tasks.map(t=>{if(!t||!TODO_STATUS.includes(t.status))throw error('Invalid todo status.');const o={content:str(t.content,2000,'task',true),status:t.status};
   for(const k of ['blocker','details'])if(t[k]!==undefined)o[k]=str(t[k],4000,k);if(t.notes!==undefined){if(!Array.isArray(t.notes)||t.notes.length>50)throw error('Invalid todo notes.');o.notes=t.notes.map(x=>str(x,2000,'note',false));}return o;})};});
}

// OMP CLI commands the Tools page can run. Each action is a fixed argv prefix plus validated fields; nothing runs through a shell.
// Field types: bool (flag), text, int, select, model, dir, session, list (comma-separated, repeated flag).
const CLI_TOOLS={
 commit:{title:'Commit',description:'Generate a commit message with the commit model and update changelogs.',actions:{
  run:{label:'Commit staged and unstaged changes',args:['commit'],cwd:'required',long:true,confirm:'Commit the changes in this folder?',fields:[
   {name:'dryRun',type:'bool',flag:'--dry-run',label:'Dry run (preview the message, commit nothing)',default:true},
   {name:'push',type:'bool',flag:'--push',label:'Push after committing'},
   {name:'noChangelog',type:'bool',flag:'--no-changelog',label:'Skip changelog updates'},
   {name:'legacy',type:'bool',flag:'--legacy',label:'Legacy deterministic pipeline'},
   {name:'context',type:'textarea',flag:'--context',label:'Extra context for the model',max:4000},
   {name:'model',type:'model',flag:'--model',label:'Model override'}]}}},
 worktree:{title:'Worktrees',description:'Agent-managed git worktrees (clone-first when enabled).',actions:{
  list:{label:'List',args:['worktree','list'],cwd:'optional'},
  add:{label:'Add',args:['worktree','add'],cwd:'required',fields:[
   {name:'path',type:'text',positional:true,required:true,label:'Worktree path',placeholder:'../feature'},
   {name:'commit',type:'text',positional:true,label:'Commit-ish',placeholder:'origin/main'},
   {name:'branch',type:'text',flag:'--branch',label:'New branch',pattern:'^[\\w./-]+$'},
   {name:'forceBranch',type:'text',flag:'--force-branch',label:'Create or reset branch',pattern:'^[\\w./-]+$'},
   {name:'detach',type:'bool',flag:'--detach',label:'Detach HEAD'}]},
  clear:{label:'Clear',args:['worktree','clear'],cwd:'optional',confirm:'Remove agent-managed worktrees?',fields:[
   {name:'dryRun',type:'bool',flag:'--dry-run',label:'Dry run',default:true},
   {name:'all',type:'bool',flag:'--all',label:'Include live PR-checkout worktrees'}]}}},
 stats:{title:'Usage stats',description:'Token, cost and model usage across all OMP sessions.',actions:{
  summary:{label:'Summary',args:['stats','--summary'],long:true}}},
 share:{title:'Share session',description:'Upload a saved session as an encrypted link (or a secret GitHub gist).',actions:{
  share:{label:'Create share link',args:['share'],long:true,confirm:'Upload this session transcript? Anyone with the link can read it.',fields:[
   {name:'session',type:'session',positional:true,required:true,label:'Session'},
   {name:'gist',type:'bool',flag:'--gist',label:'Use a secret GitHub gist'}]}}},
 skill:{title:'Skills registry',description:'Search, install and manage skills from skills.omp.sh.',actions:{
  search:{label:'Search',args:['skill','search'],fields:[{name:'query',type:'text',positional:true,required:true,label:'Search for'},{name:'sort',type:'select',flag:'--sort',label:'Order',options:['','relevance','downloads','recent']}]},
  info:{label:'Info',args:['skill','info'],fields:[{name:'name',type:'text',positional:true,required:true,label:'Skill',placeholder:'@alice/pdf-tools'}]},
  list:{label:'Installed',args:['skill','list'],cwd:'optional'},
  install:{label:'Install',args:['skill','install'],cwd:'optional',long:true,fields:[{name:'spec',type:'text',positional:true,required:true,label:'Skill spec',placeholder:'@alice/pdf-tools@^1.2'},{name:'global',type:'bool',flag:'--global',label:'Install for every project (user-global)',default:true},{name:'yes',type:'bool',flag:'--yes',label:'Allow skills that ship scripts'}]},
  update:{label:'Update',args:['skill','update'],cwd:'optional',long:true,fields:[{name:'spec',type:'text',positional:true,label:'Skill (empty = all)'},{name:'global',type:'bool',flag:'--global',label:'User-global skills',default:true},{name:'yes',type:'bool',flag:'--yes',label:'Allow skills that ship scripts'}]},
  uninstall:{label:'Uninstall',args:['skill','uninstall'],cwd:'optional',confirm:'Uninstall this skill?',fields:[{name:'spec',type:'text',positional:true,required:true,label:'Skill'},{name:'global',type:'bool',flag:'--global',label:'User-global skills',default:true}]}}},
 plugin:{title:'Plugins (advanced)',description:'Plugin maintenance beyond the Settings page: link local plugins, doctor, features, upgrades and marketplaces.',actions:{
  doctor:{label:'Doctor',args:['plugin','doctor'],fields:[{name:'fix',type:'bool',flag:'--fix',label:'Attempt to fix issues'}]},
  upgrade:{label:'Upgrade',args:['plugin','upgrade'],long:true,fields:[{name:'name',type:'text',positional:true,label:'Plugin (empty = all)'},{name:'dryRun',type:'bool',flag:'--dry-run',label:'Dry run'}]},
  link:{label:'Link local',args:['plugin','link'],fields:[{name:'path',type:'dir',positional:true,required:true,label:'Plugin folder'}]},
  features:{label:'Features',args:['plugin','features'],fields:[{name:'name',type:'text',positional:true,required:true,label:'Plugin'},{name:'enable',type:'text',flag:'--enable',label:'Enable feature'},{name:'disable',type:'text',flag:'--disable',label:'Disable feature'}]},
  config:{label:'Config',args:['plugin','config'],fields:[{name:'name',type:'text',positional:true,required:true,label:'Plugin'},{name:'set',type:'text',flag:'--set',label:'Set key=value'}]},
  marketplace:{label:'Marketplaces',args:['plugin','marketplace'],fields:[{name:'action',type:'select',positional:true,label:'Action',options:['list','add','remove','update']},{name:'target',type:'text',positional:true,label:'Marketplace (owner/repo, URL or name)'}]}}},
 agents:{title:'Task agents',description:'Export the bundled task agents so you can customise them.',actions:{
  unpack:{label:'Unpack',args:['agents','unpack'],cwd:'optional',fields:[{name:'where',type:'select',label:'Destination',options:['--user','--project'],arg:true},{name:'force',type:'bool',flag:'--force',label:'Overwrite existing agent files'}]}}},
 ps:{title:'Background processes',description:'Daemon-supervised processes started by OMP (dev servers, watchers, relays).',actions:{
  list:{label:'List',args:['ps','list','--plain'],cwd:'optional',fields:[{name:'all',type:'bool',flag:'--all',label:'Include other projects and exited global services'}]},
  info:{label:'Info',args:['ps','info'],cwd:'optional',fields:[{name:'name',type:'text',positional:true,required:true,label:'Process'}]},
  logs:{label:'Logs',args:['ps','logs'],cwd:'optional',fields:[{name:'name',type:'text',positional:true,required:true,label:'Process'},{name:'lines',type:'int',flag:'--lines',label:'Lines',min:1,max:1000},{name:'grep',type:'text',flag:'--grep',label:'Filter (regex)'},{name:'head',type:'bool',flag:'--head',label:'From the beginning'}]},
  stop:{label:'Stop',args:['ps','stop'],cwd:'optional',confirm:'Stop this process?',fields:[{name:'name',type:'text',positional:true,required:true,label:'Process'},{name:'timeout',type:'int',flag:'--timeout',label:'Grace period (s)',min:0,max:600}]},
  kill:{label:'Kill',args:['ps','kill'],cwd:'optional',confirm:'Kill this process?',fields:[{name:'name',type:'text',positional:true,required:true,label:'Process'}]},
  restart:{label:'Restart',args:['ps','restart'],cwd:'optional',fields:[{name:'name',type:'text',positional:true,required:true,label:'Process'}]}}},
 gc:{title:'Storage cleanup',description:'Garbage-collect OMP storage. Runs as a dry run unless Apply is ticked.',actions:{
  run:{label:'Run',args:['gc'],long:true,fields:[
   {name:'apply',type:'bool',flag:'--apply',label:'Apply changes (otherwise dry run)'},
   {name:'blobs',type:'bool',flag:'--blobs',label:'Sweep unreferenced blobs'},
   {name:'archive',type:'bool',flag:'--archive',label:'Archive cold sessions'},
   {name:'wal',type:'bool',flag:'--wal',label:'Checkpoint database WAL files'},
   {name:'days',type:'int',flag:'--cold-archive-after-days',label:'Archive sessions older than (days)',min:0,max:3650},
   {name:'keepGlobal',type:'int',flag:'--retain-newest-global',label:'Always keep newest (global)',min:0,max:100000},
   {name:'keepCwd',type:'int',flag:'--retain-newest-per-cwd',label:'Always keep newest per folder',min:0,max:100000}],confirmIf:'apply',confirm:'Apply storage cleanup? Archived sessions leave the session list.'}}},
 ssh:{title:'SSH hosts',description:'Hosts the ssh tool can reach.',actions:{
  list:{label:'List',args:['ssh','list'],cwd:'optional'},
  add:{label:'Add',args:['ssh','add'],cwd:'optional',fields:[
   {name:'name',type:'text',positional:true,required:true,label:'Name',pattern:'^[\\w.-]+$'},
   {name:'host',type:'text',flag:'--host',required:true,label:'Host address'},
   {name:'user',type:'text',flag:'--user',label:'User'},
   {name:'port',type:'int',flag:'--port',label:'Port',min:1,max:65535},
   {name:'key',type:'text',flag:'--key',label:'Identity key path'},
   {name:'desc',type:'text',flag:'--desc',label:'Description'},
   {name:'compat',type:'bool',flag:'--compat',label:'Compatibility mode'},
   {name:'scope',type:'select',flag:'--scope',label:'Scope',options:['','user','project']}]},
  remove:{label:'Remove',args:['ssh','remove'],cwd:'optional',confirm:'Remove this SSH host?',fields:[{name:'name',type:'text',positional:true,required:true,label:'Name',pattern:'^[\\w.-]+$'},{name:'scope',type:'select',flag:'--scope',label:'Scope',options:['','user','project']}]}}},
 setup:{title:'Optional features',description:'Install or check dependencies for Python and speech features.',actions:{
  check:{label:'Check',args:['setup','--check'],fields:[{name:'component',type:'select',positional:true,required:true,label:'Component',options:['python','speech']}]},
  install:{label:'Install',args:['setup'],long:true,confirm:'Install this optional component?',fields:[{name:'component',type:'select',positional:true,required:true,label:'Component',options:['python','speech']}]}}},
 tinyModels:{title:'Tiny local models',description:'Small local models for session titles, memory and word completion.',actions:{
  list:{label:'List',args:['tiny-models','list']},
  download:{label:'Download',args:['tiny-models','download'],long:true,fields:[{name:'model',type:'text',positional:true,required:true,label:'Model key (or all)',placeholder:'lfm2.5-230m',pattern:'^[\\w.:-]+$'}]}}},
 find:{title:'Semantic find',description:'Describe a behaviour; get the files and line ranges that implement it.',actions:{
  find:{label:'Find',args:['find','--quiet'],cwd:'required',long:true,fields:[
   {name:'query',type:'text',positional:true,required:true,label:'What to find',max:2000},
   {name:'path',type:'text',positional:true,label:'Sub-folder (optional)'},
   {name:'keyword',type:'list',flag:'--keyword',label:'Extra keywords (comma-separated)'},
   {name:'hidden',type:'bool',flag:'--hidden',label:'Include dot-files'}]}}},
 grievances:{title:'Tool grievances',description:'Issues the auto-QA reported about tool behaviour.',actions:{
  list:{label:'List',args:['grievances','list'],fields:[{name:'limit',type:'int',flag:'--limit',label:'How many',min:1,max:1000},{name:'tool',type:'text',flag:'--tool',label:'Tool',pattern:'^[\\w-]+$'}]},
  clean:{label:'Clean',args:['grievances','clean'],confirm:'Delete these grievances?',fields:[{name:'id',type:'int',flag:'--id',label:'Grievance id',min:1,max:1e9},{name:'tool',type:'text',flag:'--tool',label:'Tool',pattern:'^[\\w-]+$'},{name:'all',type:'bool',flag:'--all',label:'Delete every grievance'}]},
  push:{label:'Push',args:['grievances','push'],long:true,confirm:'Send the recorded grievances to the OMP maintainers?'}}},
};
// The catalog the dashboard renders: no argv, only what the forms need.
const cliCatalog=()=>Object.fromEntries(Object.entries(CLI_TOOLS).map(([id,t])=>[id,{title:t.title,description:t.description,actions:Object.fromEntries(Object.entries(t.actions).map(([a,x])=>[a,{label:x.label,cwd:x.cwd,confirm:x.confirm,confirmIf:x.confirmIf,command:'omp '+x.args.join(' '),fields:(x.fields||[]).map(({flag,arg,...f})=>({...f,flag}))}]))}]));

// Enhance prompt: a one-shot read-only `omp -p` that rewrites a composer draft.
// `enhance` role (model[:thinking], set in Settings) wins; otherwise the composer's model at the Settings reasoning level
// (default low) so an xhigh session doesn't make every enhance slow.
function enhanceModel(roles,selector,thinking='low'){
 if(roles?.enhance)return {model:'@enhance',thinking:null,label:roles.enhance};
 if(selector)return {model:selector,thinking,label:selector};
 return {model:null,thinking,label:roles?.default||'OMP default'};
}
// The draft never goes in argv (stdin only): no quoting hazards and no Windows 32K command-line limit.
function enhanceArgs({model,thinking,overlay,system,images}){
 return ['-p','--mode','json','--no-session','--no-title','--no-skills','--no-extensions','--no-lsp','--tools=read,grep,glob','--approval-mode=always-ask','--max-time=120',
  `--config=${overlay}`,...(model?[`--model=${model}`]:[]),...(thinking?[`--thinking=${thinking}`]:[]),`--append-system-prompt=${system}`,...images.map(f=>'@'+f)];
}
function enhanceInput(draft,messages){
 const tail=messages.filter(m=>m.role==='user'||m.role==='assistant').slice(-6).map(m=>`${m.role==='user'?'User':'Assistant'}: ${String(m.text||'').slice(0,1500)}`);
 return (tail.length?`<conversation>\n${tail.join('\n')}\n</conversation>\n`:'')+`<draft>\n${draft}\n</draft>`;
}
function stepLabel(toolName,args,cwd){
 const a=args||{};let s;
 if(toolName==='read')s='reading '+(a.path?path.relative(cwd,path.resolve(cwd,String(a.path))).replace(/\\/g,'/'):'a file');
 else if(toolName==='grep')s=`searching "${a.pattern??''}"`;
 else if(toolName==='glob')s='listing '+(a.pattern??'files');
 else if(toolName==='find')s=`finding "${a.query??a.pattern??''}"`;
 else s=String(toolName||'working');
 return s.length>80?s.slice(0,79)+'…':s;
}
function cleanEnhanced(text){
 const t=String(text||'').trim();const m=t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
 // A lone opening fence (```, ```md) is no prompt at all.
 return /^```[\w-]*$/.test(t)?'':(m?m[1]:t).trim();
}
// modelRoles and defaultThinkingLevel straight from config.yml: cheap, so enhance needs no `omp models` call.
async function modelRoles(){
 const roles={};let defaultThinking='';
 try{const cfg=await fs.readFile(path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent'),'config.yml'),'utf8');let inRoles=false;
  for(const line of cfg.split(/\r?\n/)){if(/^modelRoles:\s*$/.test(line)){inRoles=true;continue;}if(inRoles){const m=line.match(/^\s+([\w-]+):\s*(\S+)/);if(m){roles[m[1]]=m[2].replace(/^["']|["']$/g,'');continue;}if(/^\S/.test(line))inRoles=false;}
   const t=line.match(/^defaultThinkingLevel:\s*(\w+)/);if(t)defaultThinking=t[1];}}catch{}
 return {roles,defaultThinking};
}
// Per-run lockdown for the enhancer. `--tools` alone is not exclusive: OMP force-adds manage_skill/learn (autolearn),
// context tools, memory tools, and xd:// `write` (device route to MCP); MCP tools also join any explicit list.
// Verified on OMP 18.8.6: with this overlay plus --approval-mode=always-ask only read/grep/glob remain and no MCP server starts.
const ENHANCE_OVERLAY=`tools:
  xdev: false
advisor:
  enabled: false
autolearn:
  enabled: false
  autoContinue: false
compaction:
  experimentalContextManagement: false
memory:
  backend: "off"
checkpoint:
  enabled: false
todo:
  enabled: false
ask:
  enabled: false
disabledProviders:
  - native
  - mcp-json
`;
const ENHANCE_SYSTEM=`You are a prompt enhancer for a coding agent working in this repository. Rewrite the user's draft into a clear, specific prompt that agent can act on.
- Keep the user's intent, scope and language. Do not add requirements they did not ask for.
- Look up only what the draft refers to: at most 6 tool calls. Name real files, symbols and commands you confirmed. Never invent paths.
- If images are attached, use what they show to make the prompt concrete; they stay attached to the final message, so refer to them rather than re-describing everything.
- Include acceptance criteria or a verification step only when the draft implies one.
- Output ONLY the rewritten prompt as plain Markdown. No preamble, no explanation, no code fence around the whole prompt.
`;
// Screen sharing (Windows): one helper process per viewer, Windows PowerShell compiling this C# with Add-Type (no install,
// no npm dependency). It captures one monitor (with the cursor), scales it to the viewer's width, and writes only the changed
// rectangle as a JPEG, one per frame credit the companion grants, so a slow link gets fewer frames instead of a growing queue.
// stdout: [u32 LE length][type][payload]; type 1 = u16 LE x,y,w,h,frameWidth,frameHeight + JPEG, type 2 = JSON text.
// stdin: one command per line (see screenCommands); EOF releases every key and button it holds down, then exits.
const SCREEN_HELPER=String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class OmpScreenHelper {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int size, flags; public IntPtr cursor; public POINT pos; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool icon; public int hotX, hotY; public IntPtr mask, color; }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

  static readonly object gate = new object();
  static Stream output;
  static int credits, monitor = -1, primary, maxWidth = 1280, quality = 60;
  static bool full = true, quit;
  static Rectangle[] screens;
  static readonly HashSet<int> keysDown = new HashSet<int>();
  static readonly bool[] buttonsDown = new bool[3];
  static readonly uint[] buttonFlags = { 2, 0x20, 8 };

  public static void Run() {
    // Physical pixels on scaled displays, for capture bounds, cursor position and input coordinates alike.
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    output = Console.OpenStandardOutput();
    LoadScreens();
    new Thread(ReadCommands) { IsBackground = true }.Start();
    CaptureLoop();
  }

  static void LoadScreens() {
    var all = Screen.AllScreens;
    lock (gate) {
      screens = new Rectangle[all.Length];
      for (int i = 0; i < all.Length; i++) { screens[i] = all[i].Bounds; if (all[i].Primary) primary = i; }
      if (monitor < 0 || monitor >= screens.Length) monitor = primary;
    }
  }

  static void EmitMonitors() {
    var list = new StringBuilder("{\"t\":\"monitors\",\"list\":[");
    lock (gate) {
      for (int i = 0; i < screens.Length; i++) list.AppendFormat("{0}{{\"w\":{1},\"h\":{2},\"primary\":{3}}}", i > 0 ? "," : "", screens[i].Width, screens[i].Height, i == primary ? "true" : "false");
      list.AppendFormat("],\"current\":{0}}}", monitor);
    }
    Emit(2, null, Encoding.UTF8.GetBytes(list.ToString()));
  }

  static void Emit(byte type, byte[] head, byte[] body) { Emit(type, head, body, body.Length); }
  static void Emit(byte type, byte[] head, byte[] body, int length) {
    int total = 1 + (head == null ? 0 : head.Length) + length;
    lock (output) {
      output.Write(BitConverter.GetBytes(total), 0, 4);
      output.WriteByte(type);
      if (head != null) output.Write(head, 0, head.Length);
      output.Write(body, 0, length);
      output.Flush();
    }
  }

  static void Status(string text) {
    Emit(2, null, Encoding.UTF8.GetBytes("{\"t\":\"status\",\"text\":\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\"}"));
  }

  static void CaptureLoop() {
    Bitmap raw = null, scaled = null; int[] prev = null, cur = null; string lastError = null;
    var jpeg = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Jpeg.Guid);
    var timer = Stopwatch.StartNew(); long lastFrame = -1000; int idle = 0;
    while (true) {
      Rectangle b; int mw, q; bool reset;
      lock (gate) {
        while (credits <= 0 && !quit) Monitor.Wait(gate);
        if (quit) return;
        b = screens[monitor]; mw = maxWidth; q = quality; reset = full; full = false;
      }
      // At most ~30 frames a second; an unchanged screen is checked less often the longer it stays still.
      long wait = Math.Max(33 - (timer.ElapsedMilliseconds - lastFrame), idle);
      if (wait > 0) Thread.Sleep((int)wait);
      int sw = Math.Min(b.Width, mw), sh = Math.Max(1, (int)Math.Round((double)b.Height * sw / b.Width));
      if (raw == null || raw.Width != b.Width || raw.Height != b.Height) { if (scaled != null && scaled != raw) scaled.Dispose(); if (raw != null) raw.Dispose(); raw = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppRgb); scaled = null; reset = true; }
      if (sw == b.Width) { if (scaled != null && scaled != raw) scaled.Dispose(); scaled = raw; }
      else if (scaled == null || scaled == raw || scaled.Width != sw || scaled.Height != sh) { if (scaled != null && scaled != raw) scaled.Dispose(); scaled = new Bitmap(sw, sh, PixelFormat.Format32bppRgb); reset = true; }
      try {
        using (var g = Graphics.FromImage(raw)) { g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size, CopyPixelOperation.SourceCopy); DrawCursor(g, b); }
        if (lastError != null) Status("");
        lastError = null;
      } catch (Exception e) {
        if (lastError != e.Message) Status("This PC's screen can't be captured right now (" + e.Message + "). Windows hides the sign-in screen and administrator prompts from other apps.");
        lastError = e.Message; lock (gate) full = true; Thread.Sleep(500); continue;
      }
      if (scaled != raw) using (var g = Graphics.FromImage(scaled)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.PixelOffsetMode = PixelOffsetMode.HighSpeed; g.CompositingQuality = CompositingQuality.HighSpeed; g.DrawImage(raw, new Rectangle(0, 0, sw, sh)); }
      int n = sw * sh;
      if (cur == null || cur.Length != n) { cur = new int[n]; prev = new int[n]; reset = true; }
      var data = scaled.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try { for (int y = 0; y < sh; y++) Marshal.Copy(data.Scan0 + y * data.Stride, cur, y * sw, sw); } finally { scaled.UnlockBits(data); }
      int x0 = 0, y0 = 0, x1 = sw, y1 = sh;
      if (!reset) {
        x0 = sw; y0 = sh; x1 = 0; y1 = 0;
        for (int y = 0; y < sh; y++) {
          int row = y * sw, l = 0, r = sw - 1;
          while (l < sw && cur[row + l] == prev[row + l]) l++;
          if (l == sw) continue;
          while (cur[row + r] == prev[row + r]) r--;
          if (y < y0) y0 = y;
          y1 = y + 1;
          if (l < x0) x0 = l;
          if (r + 1 > x1) x1 = r + 1;
        }
        if (x1 == 0) { idle = Math.Min(100, idle + 10); continue; }
        // JPEG works in 16-pixel blocks: aligned patches leave no seams next to unchanged areas.
        x0 &= ~15; y0 &= ~15; x1 = Math.Min(sw, (x1 + 15) & ~15); y1 = Math.Min(sh, (y1 + 15) & ~15);
      }
      idle = 0;
      var swap = prev; prev = cur; cur = swap;
      var rect = new Rectangle(x0, y0, x1 - x0, y1 - y0);
      var ms = new MemoryStream();
      using (var part = scaled.Clone(rect, PixelFormat.Format24bppRgb)) {
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);
        part.Save(ms, jpeg, ps);
      }
      var head = new byte[12];
      ushort[] fields = { (ushort)x0, (ushort)y0, (ushort)rect.Width, (ushort)rect.Height, (ushort)sw, (ushort)sh };
      for (int i = 0; i < 6; i++) BitConverter.GetBytes(fields[i]).CopyTo(head, i * 2);
      lock (gate) credits--;
      Emit(1, head, ms.GetBuffer(), (int)ms.Length);
      lastFrame = timer.ElapsedMilliseconds;
    }
  }

  static void DrawCursor(Graphics g, Rectangle b) {
    var ci = new CURSORINFO(); ci.size = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0) return;
    ICONINFO ii; if (!GetIconInfo(ci.cursor, out ii)) return;
    if (ii.mask != IntPtr.Zero) DeleteObject(ii.mask);
    if (ii.color != IntPtr.Zero) DeleteObject(ii.color);
    int x = ci.pos.x - b.X - ii.hotX, y = ci.pos.y - b.Y - ii.hotY;
    if (x >= b.Width || y >= b.Height || x < -128 || y < -128) return;
    IntPtr hdc = g.GetHdc();
    try { DrawIconEx(hdc, x, y, ci.cursor, 0, 0, 0, IntPtr.Zero, 3); } finally { g.ReleaseHdc(hdc); }
  }

  static void Send(INPUT input) { SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, uint data, int dx, int dy) {
    var i = new INPUT(); i.type = 0; i.u.mi.flags = flags; i.u.mi.data = data; i.u.mi.dx = dx; i.u.mi.dy = dy; Send(i);
  }
  static void Key(int vk, bool ext, bool down) {
    var i = new INPUT(); i.type = 1; i.u.ki.vk = (ushort)vk; i.u.ki.scan = (ushort)MapVirtualKey((uint)vk, 0);
    i.u.ki.flags = (ext ? 1u : 0u) | (down ? 0u : 2u); Send(i);
    lock (keysDown) { if (down) keysDown.Add(vk | (ext ? 0x10000 : 0)); else keysDown.Remove(vk | (ext ? 0x10000 : 0)); }
  }
  static void Unicode(ushort c) {
    var i = new INPUT(); i.type = 1; i.u.ki.scan = c; i.u.ki.flags = 4; Send(i);
    i.u.ki.flags = 6; Send(i);
  }

  // x and y are 0..65535 across the shared monitor; SendInput wants 0..65535 across the whole virtual desktop.
  static void MoveTo(int nx, int ny) {
    Rectangle b; lock (gate) b = screens[monitor];
    int px = b.X + (int)Math.Round((double)nx * (b.Width - 1) / 65535), py = b.Y + (int)Math.Round((double)ny * (b.Height - 1) / 65535);
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(2, GetSystemMetrics(78)), vh = Math.Max(2, GetSystemMetrics(79));
    Mouse(0x8001 | 0x4000, 0, (int)Math.Round((px - vx) * 65535.0 / (vw - 1)), (int)Math.Round((py - vy) * 65535.0 / (vh - 1)));
  }

  static void ReleaseAll() {
    for (int i = 0; i < 3; i++) if (buttonsDown[i]) { buttonsDown[i] = false; Mouse(buttonFlags[i] << 1, 0, 0, 0); }
    int[] keys; lock (keysDown) { keys = new int[keysDown.Count]; keysDown.CopyTo(keys); }
    foreach (var k in keys) Key(k & 0xffff, (k & 0x10000) != 0, false);
  }

  static void ReadCommands() {
    var input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    string line;
    while ((line = input.ReadLine()) != null && line != "q") {
      var a = line.Split(' ');
      try {
        switch (a[0]) {
          case "m": MoveTo(int.Parse(a[1]), int.Parse(a[2])); break;
          case "b": { int i = int.Parse(a[1]); bool down = a[2] == "1"; if (buttonsDown[i] == down) break; buttonsDown[i] = down; Mouse(down ? buttonFlags[i] : buttonFlags[i] << 1, 0, 0, 0); break; }
          case "w": { int dy = int.Parse(a[1]), dx = int.Parse(a[2]); if (dy != 0) Mouse(0x800, unchecked((uint)dy), 0, 0); if (dx != 0) Mouse(0x1000, unchecked((uint)dx), 0, 0); break; }
          case "k": Key(int.Parse(a[1]), a[2] == "1", a[3] == "1"); break;
          case "t": for (int i = 1; i < a.Length; i++) Unicode(Convert.ToUInt16(a[i], 16)); break;
          case "x": ReleaseAll(); break;
          case "f": lock (gate) { credits = Math.Min(4, credits + int.Parse(a[1])); Monitor.PulseAll(gate); } break;
          case "r": lock (gate) { full = true; Monitor.PulseAll(gate); } break;
          case "c":
            LoadScreens();
            lock (gate) { int m = int.Parse(a[1]); monitor = m < 0 || m >= screens.Length ? primary : m; maxWidth = int.Parse(a[2]); quality = int.Parse(a[3]); full = true; Monitor.PulseAll(gate); }
            EmitMonitors(); break;
        }
      } catch (Exception e) { Status("Screen helper: " + e.Message); }
    }
    ReleaseAll();
    lock (gate) { quit = true; Monitor.PulseAll(gate); }
  }
}
`;
// KeyboardEvent.code → Windows virtual-key code; 0x100 marks keys sent with the extended flag. A Map, so no viewer-sent
// name can reach Object.prototype. Codes are physical key positions: this PC's keyboard layout decides the character.
const SCREEN_KEYS=new Map(Object.entries({Backspace:8,Tab:9,Enter:13,NumpadEnter:0x10d,ShiftLeft:0xa0,ShiftRight:0xa1,ControlLeft:0xa2,ControlRight:0x1a3,AltLeft:0xa4,AltRight:0x1a5,MetaLeft:0x15b,MetaRight:0x15c,ContextMenu:0x15d,
 Pause:0x13,CapsLock:0x14,Escape:0x1b,Space:0x20,PageUp:0x121,PageDown:0x122,End:0x123,Home:0x124,ArrowLeft:0x125,ArrowUp:0x126,ArrowRight:0x127,ArrowDown:0x128,PrintScreen:0x12c,Insert:0x12d,Delete:0x12e,NumLock:0x190,ScrollLock:0x91,
 Semicolon:0xba,Equal:0xbb,Comma:0xbc,Minus:0xbd,Period:0xbe,Slash:0xbf,Backquote:0xc0,BracketLeft:0xdb,Backslash:0xdc,BracketRight:0xdd,Quote:0xde,IntlBackslash:0xe2,
 NumpadMultiply:0x6a,NumpadAdd:0x6b,NumpadSubtract:0x6d,NumpadDecimal:0x6e,NumpadDivide:0x16f,AudioVolumeMute:0x1ad,AudioVolumeDown:0x1ae,AudioVolumeUp:0x1af,MediaTrackNext:0x1b0,MediaTrackPrevious:0x1b1,MediaStop:0x1b2,MediaPlayPause:0x1b3}));
for(let i=0;i<26;i++)SCREEN_KEYS.set('Key'+String.fromCharCode(65+i),65+i);
for(let i=0;i<10;i++){SCREEN_KEYS.set('Digit'+i,48+i);SCREEN_KEYS.set('Numpad'+i,0x60+i);}
for(let i=1;i<=24;i++)SCREEN_KEYS.set('F'+i,0x6f+i);
// One viewer message as helper command lines; '' for anything malformed. Pointer positions are 0..1 across the shared monitor.
function screenCommands(m){
 if(!m||typeof m!=='object')return '';
 const num=(v,lo,hi)=>typeof v==='number'&&Number.isFinite(v)?Math.round(Math.min(hi,Math.max(lo,v))):null;
 const at=()=>{const x=num(typeof m.x==='number'?m.x*65535:NaN,0,65535),y=num(typeof m.y==='number'?m.y*65535:NaN,0,65535);return x===null||y===null?null:`m ${x} ${y}\n`;};
 const key=(code,down)=>{const k=SCREEN_KEYS.get(code);return k===undefined?'':`k ${k&0xff} ${k>>8} ${down?1:0}\n`;};
 switch(m.t){
  case 'ack':return 'f 1\n';
  case 'refresh':return 'r\n';
  case 'release':return 'x\n';
  case 'move':return at()||'';
  case 'button':{if(![0,1,2].includes(m.b)||typeof m.down!=='boolean')return '';const move=m.x===undefined&&m.y===undefined?'':at();return move===null?'':move+`b ${m.b} ${m.down?1:0}\n`;}
  case 'wheel':{const dy=num(m.dy??0,-2400,2400),dx=num(m.dx??0,-2400,2400);return dy===null||dx===null||!dy&&!dx?'':`w ${dy} ${dx}\n`;}
  case 'key':return typeof m.code==='string'&&typeof m.down==='boolean'?key(m.code,m.down):'';
  // Typed text goes as Unicode characters, independent of this PC's layout; line breaks and tabs press Enter and Tab.
  case 'text':{
   if(typeof m.text!=='string'||m.text.length>2000)return '';
   let out='',run=[];const flush=()=>{for(let i=0;i<run.length;i+=64)out+='t '+run.slice(i,i+64).join(' ')+'\n';run=[];};
   for(const ch of m.text.replace(/\r\n?/g,'\n')){
    if(ch==='\n'||ch==='\t'){flush();const c=ch==='\n'?'Enter':'Tab';out+=key(c,true)+key(c,false);}
    else if(ch>=' '&&ch!=='\x7f')for(let i=0;i<ch.length;i++)run.push(ch.charCodeAt(i).toString(16));
   }
   flush();return out;
  }
  case 'config':{const mon=num(m.monitor??-1,-1,63),w=num(m.width??1280,320,7680),q=num(m.quality??60,10,95);return mon===null||w===null||q===null?'':`c ${mon} ${w} ${q}\n`;}
 }
 return '';
}
// Tailscale's address ranges: IPv4 100.64.0.0/10 (CGNAT) and IPv6 fd7a:115c:a1e0::/48.
export const tailnetAddress=a=>/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(a)||/^fd7a:115c:a1e0:/i.test(a);
// This PC's MagicDNS name and tailnet addresses from `tailscale status --json`, or null (not installed, not running, logged out).
export async function tailscaleSelf(){
 const bins=process.platform==='win32'?['tailscale',path.join(process.env.ProgramFiles||'C:\\Program Files','Tailscale','tailscale.exe')]:process.platform==='darwin'?['tailscale','/Applications/Tailscale.app/Contents/MacOS/Tailscale']:['tailscale'];
 for(const bin of bins){
  let out;try{out=(await exec(bin,['status','--json','--peers=false'],{timeout:5000,maxBuffer:4*1024*1024,windowsHide:true})).stdout;}catch(e){if(e.code==='ENOENT')continue;return null;}
  try{
   const s=JSON.parse(out);if(s.BackendState!=='Running')return null;
   const name=String(s.Self?.DNSName||'').replace(/\.$/,'').toLowerCase(),ips=(s.Self?.TailscaleIPs||[]).filter(ip=>typeof ip==='string'&&tailnetAddress(ip));
   return {name:/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)?name:'',ips};
  }catch{return null;}
 }
 return null;
}
// Pure helpers, exported for tests.
export const internals={launchOptions,launchArgs,treeView,todoPhases,enhanceModel,enhanceArgs,enhanceInput,stepLabel,cleanEnhanced,ENHANCE_OVERLAY,gitDiffFiles,editorUrl,shutdownCommand,restartHandoff,screenCommands};
// Connect probe, not a bind: Windows lets 127.0.0.1:N bind beside another process's 0.0.0.0:N. No answer within timeoutMs counts as busy.
export function portBusy(port,host='127.0.0.1',timeoutMs=1000){return new Promise(resolve=>{const s=connect(port,host);const done=busy=>{clearTimeout(t);s.destroy();resolve(busy);};const t=setTimeout(()=>done(true),timeoutMs);s.once('connect',()=>done(true));s.once('error',()=>done(false));});}
const cleanUpdateOutput=(...parts)=>parts.filter(Boolean).join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().slice(-6000);
// `omp update` checks the release channel and installs only when a newer build exists. entry: native executable or a source checkout's cli.ts.
export async function updateOmp(entry,{cwd=os.homedir(),timeout=20*60*1000}={}){
 const source=/\.ts$/i.test(entry),env={...process.env};
 if(path.isAbsolute(entry)&&!source){const key=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';env[key]=path.dirname(entry)+path.delimiter+(env[key]||'');}
 try{
  const {stdout,stderr}=await exec(source?'bun':entry,[...(source?[path.resolve(entry)]:[]),'update'],{cwd,env,timeout,maxBuffer:8*1024*1024,windowsHide:true});
  return {status:'done',output:cleanUpdateOutput(stdout,stderr)||'OMP update finished without output.'};
 }catch(e){return {status:'error',exitCode:typeof e.code==='number'?e.code:null,output:cleanUpdateOutput(e.stdout,e.stderr,e.killed?'Update timed out.':e.message)||'OMP update failed.'};}
}
// Opening the companion first brings OMP up to date, before any OMP process starts. A failed or timed-out update
// starts with the installed build. OMP_WEB_NO_UPDATE=1 skips it; a source checkout is updated with git instead.
export async function startupUpdate({entry=process.env.OMP_BIN||'omp',timeout=10*60*1000,log=console.log}={}){
 if(process.env.OMP_WEB_NO_UPDATE==='1')return {status:'skipped'};
 if(/\.ts$/i.test(entry)){log('OMP runs from a source checkout; skipping omp update.');return {status:'skipped'};}
 log('Checking for OMP updates…');
 const result=await updateOmp(entry,{timeout});
 log(result.status==='done'?result.output:`OMP update failed; starting with the installed version.\n${result.output}`);
 return result;
}
// Leaves an already-current file untouched (opening it for write can fail with EPERM on Windows, e.g. under a
// restricted token); otherwise replaces it atomically so it is never missing or half-written. Errors propagate:
// a stale Enhance lockdown overlay must not be served.
async function syncFile(file,content){
 if(await fs.readFile(file,'utf8').then(c=>c===content,()=>false))return;
 const tmp=`${file}.${process.pid}.tmp`;
 try{await fs.writeFile(tmp,content,{mode:0o600});await fs.rename(tmp,file);}
 catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}
}
export async function createCompanion(options={}){
 // OMP_WEB_PASSWORD: a password you choose becomes the connection token, so the same Bearer check enforces it. It is never served in the page.
 const password=options.password??process.env.OMP_WEB_PASSWORD??'';
 if(password&&!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(password))throw new Error('OMP_WEB_PASSWORD must be printable ASCII without leading or trailing spaces (browsers cannot send other characters in the Authorization header).');
 const token=options.token||password||randomBytes(32).toString('hex');
 // OMP_WEB_NO_TOKEN=1 embeds the token in the served page: any device that can reach the port gets full control. A password turns it off.
 const exposeToken=!password&&(options.exposeToken??process.env.OMP_WEB_NO_TOKEN==='1');
 // OMP_WEB_PUBLIC_HOSTS: extra host names (a Tailscale MagicDNS name, say) accepted in Host and Origin by exact match on the port.
 const publicHosts=(options.publicHosts||String(process.env.OMP_WEB_PUBLIC_HOSTS||'').split(',')).map(h=>h.trim().toLowerCase()).filter(Boolean);
 for(const h of publicHosts)if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h))throw new Error(`OMP_WEB_PUBLIC_HOSTS: "${h}" is not a host name (give names like pc.tailnet.ts.net, without scheme or port).`);
 const dataDir=options.dataDir||process.env.OMP_WEB_DATA_DIR||path.join(os.homedir(),'.omp-web');
 // OMP_BIN may point at the native executable or a source checkout's cli.ts.
 const ompEntry=options.ompCommand||process.env.OMP_BIN||'omp',ompSource=/\.ts$/i.test(ompEntry);
 const ompExecutable=ompSource?'bun':ompEntry,ompPrefix=ompSource?[path.resolve(ompEntry)]:[];
 const execOmp=(args,opts)=>exec(ompExecutable,[...ompPrefix,...args],opts);
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const enhanceOverlay=path.join(dataDir,'enhance-overlay.yml'),enhanceSystem=path.join(dataDir,'enhance-system.md');
 await syncFile(enhanceOverlay,ENHANCE_OVERLAY);await syncFile(enhanceSystem,ENHANCE_SYSTEM);
 const stateFile=path.join(dataDir,'workspace.json');
 // A companion killed mid-save (console closed, Task Manager) leaves its ~30 MB workspace.json.<pid>.tmp behind; no later process reuses that name.
 // Only dead PIDs' files go: a live companion sharing this dir may be writing its own. Also the pre-PID shared workspace.json.tmp.
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
 for(const f of await fs.readdir(dataDir)){const m=/^workspace\.json\.(?:(\d+)\.)?tmp$/.exec(f);if(m&&!(m[1]&&alive(Number(m[1]))))await fs.rm(path.join(dataDir,f),{force:true}).catch(()=>{});}
 const queuedImageFile=id=>path.join(dataDir,'queued-images',id+'.json');
 let store;
 try{store=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error(`Cannot read workspace: ${e.message}`);store={projects:[],sessions:[],activity:[]};}
 // Sidebar keys ('s:<id>' or 'f:<native file>') the user archived; archiving only hides, it never deletes.
 store.archived=Array.isArray(store.archived)?store.archived.filter(k=>typeof k==='string'):[];
 // Sidebar keys the user pinned to the top; a key is never both pinned and archived.
 store.pinned=Array.isArray(store.pinned)?store.pinned.filter(k=>typeof k==='string'&&!store.archived.includes(k)):[];
 // Enhance reasoning level when no `enhance` role is set (Settings page); the role carries its own level.
 if(!THINKING.includes(store.enhanceThinking))store.enhanceThinking='low';
 // OAuth account the user chose per provider (provider id → OMP's account label); applied to sessions with /session pin.
 store.accountChoices=Object.fromEntries(Object.entries(store.accountChoices&&typeof store.accountChoices==='object'?store.accountChoices:{}).filter(([k,v])=>k&&typeof v==='string'&&v));
 // Composer drafts per dashboard view ('session:<id>' or 'native:<file>'), shared by every device using this companion.
 store.drafts=Object.fromEntries(Object.entries(store.drafts&&typeof store.drafts==='object'?store.drafts:{}).filter(([k,v])=>/^(session|native):./.test(k)&&typeof v?.text==='string'&&v.text&&typeof v.at==='number'));
 // Where "Open in editor" opens files (Settings › Open in editor).
 if(!EDITOR_CHOICES.includes(store.editor))store.editor='auto';
 for(const s of store.sessions){finishWork(s,s.updatedAt||now());delete s._streamId;delete s._thinkId;delete s._compacting;delete s.uiRequests;if(['running','queued'].includes(s.status)){s.status='paused';s.error=undefined;}for(const a of s.subagentList||[])if(/run|pend|start|queue/i.test(a.status))a.status='stopped';}
 const allowedOrigins=new Set(options.allowedOrigins||String(process.env.OMP_ALLOWED_ORIGINS||'').split(',').filter(Boolean));
 let eventSaveTimer;const scheduleSave=()=>{if(!eventSaveTimer)eventSaveTimer=setTimeout(()=>{eventSaveTimer=undefined;void persist();},300);};
 const runners=new Map();const launches=new Map();const locks=new Map();let closing=false;let pausing=0;let saveChain=Promise.resolve();
 // "Shut down PC when all work is done" (⋯ menu). Process-local, never saved: a restarted companion does not turn the PC off by itself.
 // firing: the /api/shutdown steps are running; error: the OS refused the last automatic attempt (shown by the panel).
 const autoShutdown={on:false,since:null,firing:false,error:null};
 const autoShutdownView=()=>({on:autoShutdown.on,since:autoShutdown.since,firing:autoShutdown.firing,error:autoShutdown.error});
 // A new id per process: a dashboard that asked for a restart knows the new companion answers once this changes.
 const instance=randomUUID(),canRestart=typeof options.restart==='function';
 // Only the current thought is live; completed messages remain in OMP's transcript.
 const subagentThoughts=new Map();
 // Windows: antivirus/indexers briefly lock workspace.json, making rename fail with EPERM/EACCES/EBUSY; retry like graceful-fs.
 const replaceFile=async(from,to)=>{for(let i=0;;i++){try{return await fs.rename(from,to);}catch(e){if(i>=20||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,50*(i+1)));}}};
 // One write in flight plus at most one queued; the queued one serializes when it starts, so it covers every caller that joined it.
 // Snapshotting per call instead pinned a full copy of the store (~40 MB) per pending save, and a slow disk ran the heap out.
 let lastSaved,nextSave;
 // Per-process temp name: a second companion on another port sharing this data dir would otherwise rename our shared workspace.json.tmp away before we do (ENOENT).
 const persist=()=>{if(nextSave)return nextSave;nextSave=saveChain=saveChain.catch(()=>{}).then(async()=>{nextSave=undefined;const snapshot=JSON.stringify(store,(key,value)=>key.startsWith('_')||key==='uiRequests'?undefined:value);if(snapshot===lastSaved)return;const tmp=`${stateFile}.${process.pid}.tmp`;try{await fs.writeFile(tmp,snapshot,{mode:0o600,flush:true});await replaceFile(tmp,stateFile);}catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}lastSaved=snapshot;});saveChain.catch(e=>console.error('Workspace save failed:',e.message));return saveChain;};
 const activity=(s,message,type='update')=>{store.activity.unshift({id:randomUUID(),projectId:s?.projectId,sessionId:s?.id,text:message,type,at:now()});store.activity=store.activity.slice(0,500);};
 // A session that needs the user (finished, failed, asked a question). The desktop host turns it into a Windows notification;
 // the dashboard derives its own notifications and title badge from /api/state.
 const attention=(s,kind,detail='')=>{if(closing||s.hidden)return;try{options.onAttention?.({id:s.id,title:s.title,kind,detail:String(detail||'').slice(0,300)});}catch(e){console.error('Attention hook failed:',e.message);}};
 const append=(s,role,value,id=randomUUID())=>{if(!value)return;const existing=s.messages.find(m=>m.id===id);if(existing)existing.text=value.slice(-100000);else s.messages.push({id,role,text:value.slice(-100000),at:now()});s.messages=s.messages.slice(-600);return s.messages.find(m=>m.id===id);};
 // Slash commands per live session, from available_commands_update; served on demand, not in every /api/state poll.
 const commands=new Map();
 const slashList=list=>[{name:'usage',description:"Show the selected model's provider quota, remaining usage and reset times",aliases:[],hint:'[show]',source:'companion'},{name:'btw',description:'Ask a side question about this session; the answer stays out of the conversation',aliases:[],hint:'<question>',source:'companion'},...list.slice(0,500).filter(c=>typeof c?.name==='string'&&c.name!=='usage'&&c.name!=='btw').map(c=>({name:c.name.slice(0,100),description:String(c.description||'').slice(0,300),aliases:Array.isArray(c.aliases)?c.aliases.filter(a=>typeof a==='string').slice(0,10):[],hint:String(c.input?.hint||'').slice(0,100),source:String(c.source||'')}))];
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
  }finally{await stopProbe(rpc);}
 }
 async function stopProbe(rpc){
  const stopped=new Promise(resolve=>rpc.child.once('close',resolve));
  if(!rpc.stopping)rpc.kill();
  if(rpc.child.exitCode===null&&rpc.child.signalCode===null)await stopped;
  commandProbes.delete(rpc);
 }
 // `/session pin` with no account lists "N. <label>[ (active)]" lines under "OAuth accounts for <provider>:".
 const accountLabels=out=>/^OAuth accounts for /.test(out)?out.split(/\r?\n/).map(l=>l.match(/^\d+\. (.+?)(?: \(active\))?$/)?.[1]).filter(Boolean):[];
 // OMP has no RPC that lists stored accounts, so a throwaway session selects one model per logged-in provider and reads
 // `/session pin`. RPC set_model does not change OMP's saved default model.
 async function probeAccounts(){
  const out=[];
  const rpc=new RpcProcess(ompExecutable,[...ompPrefix,...(options.ompArgs??['--mode','rpc-ui','--no-session'])],os.homedir(),f=>{if(f.type==='command_output')out.push(typeof f.text==='string'?f.text:contentText(f.content));},()=>{});
  commandProbes.add(rpc);
  try{
   const providers=(await rpc.send({type:'get_login_providers'}))?.providers;
   const models=(await rpc.send({type:'get_available_models'},60000))?.models;
   const list=[];
   for(const p of Array.isArray(providers)?providers.filter(p=>p.authenticated):[]){
    const m=Array.isArray(models)&&models.find(m=>m.provider===p.id);if(!m)continue;
    try{await rpc.send({type:'set_model',provider:m.provider,modelId:m.id});}catch{continue;}
    out.length=0;await rpc.send({type:'prompt',message:'/session pin'});
    const accounts=accountLabels(out.join('\n').trim());
    if(accounts.length)list.push({id:String(p.id),name:String(p.name||p.id),accounts});
   }
   return list;
  }finally{await stopProbe(rpc);}
 }
 // A probe takes seconds (an OMP start plus a model switch per provider), so the dialog is served from this cache,
 // filled at startup and refreshed in the background on every read. A login bumps the generation: a probe that
 // started before it may have missed the new account, so its result is dropped and another probe runs.
 let accountCache,accountProbe,accountGen=0;
 function refreshAccounts(){
  if(closing)return Promise.reject(error('The companion is closing.'));
  if(accountProbe)return accountProbe;
  const gen=accountGen;
  return accountProbe=probeAccounts().then(list=>{if(gen===accountGen)accountCache=list;return list;}).finally(()=>{accountProbe=undefined;if(gen!==accountGen&&!closing)refreshAccounts().catch(()=>{});});
 }
 async function listAccounts(){
  let list=accountCache;
  if(list)refreshAccounts().catch(()=>{});
  else while(!(list=accountCache))await refreshAccounts();
  return {providers:list.map(p=>({...p,selected:store.accountChoices[p.id]??null}))};
 }
 const accountsChanged=()=>{accountGen++;accountCache=undefined;refreshAccounts().catch(()=>{});};
 // Session toggles the dashboard can change; values are validated in command().
 const PREFS={fast:v=>({type:'set_fast_mode',enabled:v}),autoCompaction:v=>({type:'set_auto_compaction',enabled:v}),autoRetry:v=>({type:'set_auto_retry',enabled:v}),steeringMode:v=>({type:'set_steering_mode',mode:v}),followUpMode:v=>({type:'set_follow_up_mode',mode:v}),interruptMode:v=>({type:'set_interrupt_mode',mode:v})};
 const PREF_VALUES={fast:[true,false],autoCompaction:[true,false],autoRetry:[true,false],steeringMode:['one-at-a-time','all'],followUpMode:['one-at-a-time','all'],interruptMode:['immediate','wait']};
 // Auto-approve: a run that OMP stopped on a provider 429 resumes once the provider's retry-after-ms wait is over, by
 // resending the last user message like the dashboard's Retry. The due time is persisted (rateLimitResume), so a
 // companion restart re-arms the wait instead of losing it; resumeTimers only holds the in-process timer.
 const resumeTimers=new Map();
 // The suffix OMP appends to provider errors (RETRY_AFTER_MS_SUFFIX in packages/ai oneshot-retry).
 function rateLimitHint(message){const text=String(message||''),m=/(?:^|\s)retry-after-ms=([0-9]+(?:\.[0-9]+)?)(?=\s|$)/i.exec(text);return m&&/\b429\b/.test(text)?{ms:Number(m[1]),from:Date.now()}:undefined;}
 const clockTime=d=>{const p=n=>String(n).padStart(2,'0'),t=`${p(d.getHours())}:${p(d.getMinutes())}`;return d.toDateString()===new Date().toDateString()?t:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${t}`;};
 function scheduleResume(s){
  const hint=s._rateLimit;delete s._rateLimit;
  if(!hint||!s.autoApprove)return;
  const at=new Date(hint.from+hint.ms);s.rateLimitResume={at:at.toISOString()};
  append(s,'system',`Rate limit reached; resuming automatically at ${clockTime(at)}.`);armResume(s);
 }
 function armResume(s){
  clearTimeout(resumeTimers.get(s.id));
  // setTimeout caps at ~24.8 days; resumeRateLimited re-arms when it fires early.
  const t=setTimeout(()=>{resumeTimers.delete(s.id);void resumeRateLimited(s);},Math.min(Math.max(0,Date.parse(s.rateLimitResume.at)-Date.now()),2**31-1));
  t.unref();resumeTimers.set(s.id,t);
 }
 // reason is shown in the chat; omitted when the user caused the cancel (a new message) or the wait no longer applies.
 function cancelResume(s,reason){
  clearTimeout(resumeTimers.get(s.id));resumeTimers.delete(s.id);
  if(!s.rateLimitResume)return;delete s.rateLimitResume;
  if(reason)append(s,'system',`Automatic resume cancelled: ${reason}.`);scheduleSave();
 }
 function resumeRateLimited(s){
  return lock(s.id,async()=>{
   const r=s.rateLimitResume;if(!r||closing)return;
   if(Date.parse(r.at)>Date.now())return armResume(s);
   if(!s.autoApprove||s.status!=='error'||s.hidden)return cancelResume(s);
   const last=[...s.messages].reverse().find(m=>m.role==='user');
   if(!last)return cancelResume(s,'no message to resend');
   if(last.hasImage)return cancelResume(s,'the last message had an image; reattach it and send it again');
   cancelResume(s);append(s,'system','Rate limit wait is over; resuming automatically.');
   try{await command(s,{type:'prompt',message:last.text});}catch(e){notice(s,'error',`Automatic resume failed: ${e.message}`);}
  });
 }
 function settle(s,promptId=s._promptId,run=s._run){
  void lock(s.id,async()=>{
   if(s.status!=='running'||s._promptId!==promptId||s._run!==run||s._settled||s._interrupt||s.uiRequests?.length)return;
   // Completion and idle polling can report the same run before a queued prompt starts.
   s._settled=true;dropSteers(s);
   if(s._planReview||s.planMode?.reviewPending){s.status='review';finishWork(s);scheduleSave();attention(s,'review','Plan ready for review');return;}
   if(s.queuedMessages?.length)await sendQueued(s);
   else{s.status='review';activity(s,`${s.title} is ready for review`,'review');attention(s,'review');}
   if(s.status!=='running')finishWork(s);
   scheduleSave();
  }).catch(e=>{s.status='error';finishWork(s);s.error=`Could not send queued message: ${e.message}`;void persist();}).finally(checkAutoShutdown);
 }
 function event(s,f){
  // Ghost-text predictions arrive per keystroke; they are not session activity.
  if(f.type==='response'&&(f.command==='predict_word'||f.command==='predict_word_feedback'))return;
  // /btw side questions stream outside the transcript: kept on the session for the dashboard only (not persisted).
  if(f.type==='btw_record'&&f.record?.id){const r=btwView(f.record);s._btw=[r,...(s._btw||[]).filter(x=>x.id!==r.id)].slice(0,20);return;}
  if(f.type==='btw_delta'){const r=s._btw?.find(x=>x.id===f.recordId);if(r&&typeof f.delta==='string'){const t=r.followUps.at(-1)||r;t.answer=(t.answer+f.delta).slice(-100000);}return;}
  // The 4 s background refresh (get_state/get_subagents) is not an update: bumping on it made every idle live session
  // dirty, so the whole workspace.json (tens of MB) was rewritten every refresh.
  if(!(f.type==='response'&&(f.command==='get_state'||f.command==='get_subagents')))s.updatedAt=now();
  // Advisor toggles print command_output, which is not progress on the turn itself.
  if(f.type!=='response'&&f.type!=='command_output')s.lastActivityAt=now();
  if(f.type==='agent_start'){s._run=(s._run||0)+1;delete s._settled;delete s._interrupt;delete s._titling;cancelResume(s);startWork(s);s.status='running';s.error=undefined;}
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
   // Otherwise the first user message of a prompt's run is that prompt. OMP stores this exact message, timestamp included,
   // as its session entry; bindEntries turns the timestamp into the entry ID that branching from this message needs.
   else if(s._promptMsg&&!(f.message.synthetic&&f.message.attribution==='agent')){const m=s.messages.find(m=>m.id===s._promptMsg);if(m&&typeof f.message.timestamp==='number')m.ompAt=f.message.timestamp;delete s._promptMsg;}
  }
  // Once the prompt is in OMP's history (first assistant message of a run), ask OMP to title the session; at most once per run.
  // _titling is a deadline: a /rename cancelled by Stop prints nothing, so the flag must lapse on its own.
  if(f.type==='message_start'&&f.message?.role==='assistant'&&s.autoTitle&&!(s._titling>Date.now())&&s._titleRun!==s._run){s._titling=Date.now()+60000;s._titleRun=s._run;void runners.get(s.id)?.send({type:'prompt',message:'/rename'}).catch(()=>{delete s._titling;});}
  if(f.type==='message_end'){
   const m=f.message||{};if(m.role==='assistant'){const ct=usageTokens(m.usage);if(ct)s.contextTokens=ct;s._rateLimit=m.stopReason==='error'?rateLimitHint(m.errorMessage):undefined;if(m.stopReason==='error'&&s.status!=='paused'&&s.status!=='done'){s.status='error';s.error=m.errorMessage||'OMP provider failed.';append(s,'system',s.error);activity(s,`${s.title}: ${s.error}`,'error');attention(s,'error',s.error);}else if(m.stopReason==='aborted'&&!s._interrupt){s.status='paused';}const th=thinkingText(m.content);if(th)append(s,'thinking',th.slice(-40000),s._thinkId||randomUUID());const v=contentText(m.content);if(v){const msg=append(s,'assistant',v,s._streamId||randomUUID());if(msg&&m.provider&&m.model)msg.model=`${m.provider}/${m.model}`;}if(m.provider&&m.model){s.provider=m.provider;s.model=m.model;}delete s._streamId;delete s._thinkId;if(m.usage){s.tokens+=(m.usage.totalTokens||((m.usage.input||0)+(m.usage.output||0)));s.cost+=m.usage.cost?.total||0;}}
   if(m.role==='custom'){const card=advisorMessage(m,randomUUID(),now());if(card){const saved=append(s,'advisor',card.text,card.id);saved.notes=card.notes;}}
  }
  if(f.type==='tool_execution_start'){const tool=toolRecord(f.toolName,f.args,f.intent);const msg=append(s,'tool',toolSummary(tool),'tool-'+(f.toolCallId||randomUUID()));if(msg){msg.tool=tool;msg.startedAt=now();}}
  if(f.type==='tool_execution_end'){let msg=s.messages.find(m=>m.id==='tool-'+f.toolCallId);if(!msg){msg=append(s,'tool','tool','tool-'+(f.toolCallId||randomUUID()));msg.tool=toolRecord(f.toolName,{},'');}
   msg.tool.status=f.isError?'error':'done';msg.tool.result=clip(contentText(f.result?.content),8000);const files=editFiles(f.result?.details);if(files)msg.tool.files=files;msg.tool.ms=msg.startedAt?Date.now()-new Date(msg.startedAt).getTime():undefined;msg.text=toolSummary(msg.tool);}
  if(f.type==='command_output'){const text=typeof f.text==='string'?f.text:contentText(f.content);
   if(s._capture){s._capture.push(text);return;}
   // Our own background /rename reports back in chat text; keep it out of the transcript.
   if(s._titling>Date.now()&&/^(Session renamed to |Session name not changed|Could not generate a session title|Rename failed:)/.test(text)){delete s._titling;return;}
   const adv=parseAdvisorStatus(text);if(adv)s.advisor={enabled:adv.enabled??s.advisor?.enabled??adv.state==='running',...adv,at:now()};if(!(adv&&s._silentAdvisorUntil>Date.now()))append(s,adv?'system':'assistant',text);}
  if(f.type==='session_info_update'&&typeof f.title==='string'&&f.title.trim()){s.title=f.title.trim().slice(0,120);delete s.autoTitle;}
  // Correlated by command id: an aborted run's result can land after the next prompt started, and must not pause it.
  if(f.type==='prompt_result'&&f.agentInvoked!==false&&!(f.id&&f.id!==s._promptId)&&!(s._interrupt&&f.id!==s._interrupt)){
   if(f.id&&f.id===s._interrupt)delete s._interrupt;
   // A terminal prompt_result follows the run's last agent_end, so OMP has stopped retrying by now.
   if(f.status==='error'){s.status='error';s.error=f.error?.message||'OMP reported an error.';append(s,'system',s.error);activity(s,`${s.title}: ${s.error}`,'error');attention(s,'error',s.error);scheduleResume(s);}
   else if(f.status==='aborted'){s.status='paused';activity(s,`Stopped ${s.title}`,'paused');}
   else if(f.status==='completed'&&f.sessionSettled===true)settle(s);
   if(f.status==='error'||f.status==='aborted')finishWork(s);
   dropSteers(s);
  }
  if(f.type==='prompt_result'&&f.agentInvoked===false&&f.status==='error')notice(s,'error',f.error?.message||'OMP command failed.');
  if(f.type==='session_settled'){dropSteers(s);if(s.status==='running')settle(s);else if(!s.uiRequests?.length)finishWork(s);}
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
   else if(f.method==='ask'){
    const questions=Array.isArray(f.questions)?f.questions.map(askQuestion):[];
    if(questions.length&&!questions.includes(null)){const q={id:f.id,method:'ask',title:questions.length>1?`${questions.length} questions`:questions[0].question,questions};(s.uiRequests??=[]).push(q);attention(s,'question',q.title);}
    else void runners.get(s.id)?.reply({type:'extension_ui_response',id:f.id,cancelled:true}).catch(()=>{});
   }else if(['select','confirm','input','editor'].includes(f.method)){
    const approval=approvalPrompt(f);
    if(approval&&s.autoApprove)void autoApprove(s,runners.get(s.id),f.id,approval).catch(e=>notice(s,'error',`Auto-approve failed: ${e.message}`));
    else{
     const q={id:f.id,method:f.method,title:String(f.title||'Question').slice(0,500)};
     if(f.method==='select'){q.options=Array.isArray(f.options)?f.options.filter(x=>typeof x==='string').slice(0,100):[];q.optionDetails=Array.isArray(f.optionDetails)?f.optionDetails.slice(0,q.options.length).map(x=>({description:String(x?.description||'').slice(0,500)})):[];q.checked=Array.isArray(f.checkedIndices)?f.checkedIndices.filter(i=>Number.isInteger(i)&&i>=0&&i<q.options.length):[];}
     if(f.method==='confirm')q.message=String(f.message||'').slice(0,2000);
     if(f.method==='input')q.placeholder=String(f.placeholder||'').slice(0,500);
     if(f.method==='editor')q.prefill=String(f.prefill||'').slice(0,20000);
     // Kept so turning auto-approve on later can answer it; decided here from the untruncated title.
     if(approval)q._approval=approval;
     (s.uiRequests??=[]).push(q);attention(s,'question',q.title);
    }
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
  if(f.type==='auto_retry_start'&&s.status!=='paused'&&s.status!=='done'){s.status='running';s.error=undefined;s._retry={attempt:f.attempt,maxAttempts:f.maxAttempts,delayMs:f.delayMs,error:String(f.errorMessage||'').slice(0,1000),at:now()};}
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
  if(f.type==='response'&&f.success&&f.command==='prompt'&&f.data?.agentInvoked===true)s._promptId=f.id;
  if(f.type==='response'&&!f.success&&f.id===s._promptId){s.error=f.error;if(['prompt','steer','follow_up','abort_and_prompt'].includes(f.command)){s.status='error';delete s._interrupt;}}
  scheduleSave();
 }
 // OMP's tool-approval dialogs: select('Allow tool: …',['Approve','Deny']) from its tool wrapper and eval preludes, and the
 // computer tool's foreground-control confirm. Prompts listing provider safety checks always go to the user: OMP lets no
 // setting bypass them. Returns the reply Approve/Yes sends and the text recorded in the chat; undefined for anything else.
 function approvalPrompt(f){
  const title=String(f.title||'');
  if(f.method==='select'&&title.startsWith('Allow tool: ')&&!title.includes('\nProvider safety checks:\n')&&Array.isArray(f.options)&&f.options.length===2&&f.options[0]==='Approve'&&f.options[1]==='Deny')return {reply:{value:'Approve'},text:title};
  if(f.method==='confirm'&&title==='Allow foreground computer control?')return {reply:{confirmed:true},text:`${title}\n${String(f.message||'')}`};
 }
 // Removed from the pending list before replying, so a concurrent answer can't reply to the same dialog twice.
 async function autoApprove(s,rpc,id,approval){
  s.uiRequests=(s.uiRequests||[]).filter(q=>q.id!==id);
  await rpc.reply({type:'extension_ui_response',id,...approval.reply});
  append(s,'system',`Auto-approved: ${approval.text.slice(0,4000)}`);scheduleSave();
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
   const pick=[...(s.modelSelector?['--model',s.modelSelector]:[]),...(s.thinkingChoice?['--thinking',s.thinkingChoice]:[]),...launchArgs(s.launch,!s.messages.some(m=>m.role==='user'))];
   const args=options.ompArgs??(s.native?['--mode','rpc-ui',...(s.sessionFile?['--resume',s.sessionFile]:[]),...pick]:['--mode','rpc-ui','--session-dir',sessionDir,'--continue',...pick]);
   const rpc=new RpcProcess(ompExecutable,[...ompPrefix,...args],s.cwd,f=>{if(!closing&&runners.get(s.id)===rpc)event(s,f);},(e,stopping)=>{if(runners.get(s.id)!==rpc)return;runners.delete(s.id);commands.delete(s.id);for(const k of ['_streamId','_interrupt','_compacting','_retry','_openUrl','_status','_widgets','_editorText','_task','_bash','_planReview','_planSupported','_goalSupported','_goalAvailable','_btw','uiRequests'])delete s[k];dropSteers(s);if(!closing&&!pausing){finishWork(s);s.status=stopping?(s.status==='done'?'done':'paused'):'error';s.error=stopping?undefined:e.message;if(!stopping)attention(s,'error',e.message);void persist();}});
   runners.set(s.id,rpc);
   // OMP 18.10+ sends every ask question in one dialog, so multi-select choices stay visible until submitted; older builds reject the command and keep one select per toggle.
   try{await rpc.ready;if(!s.autoTitle)await rpc.send({type:'set_session_name',name:s.title});await rpc.send({type:'set_subagent_subscription',level:'events'});await rpc.send({type:'set_ask_dialog',enabled:true}).catch(()=>{});if(!s.modelSelector&&!s.native&&s.provider&&s.model!=='OMP default')await rpc.send({type:'set_model',provider:s.provider,modelId:s.model});
    // Per-session toggles live in the OMP process, so a restarted runner gets them back.
    for(const [key,value] of Object.entries(s.prefs||{}))await rpc.send(PREFS[key](value)).catch(e=>notice(s,'warning',e.message));
    await refresh(s,rpc);return rpc;}catch(e){runners.delete(s.id);rpc.kill();throw e;}
  })();launches.set(s.id,promise);try{return await promise;}finally{launches.delete(s.id);}
 }
 // The status reply can arrive after send() resolves, so stay silent until it shows up (or a few seconds pass).
 async function advisorStatus(s,rpc){s._silentAdvisorUntil=Date.now()+5000;try{await rpc.send({type:'prompt',message:'/advisor status'});}catch{s._silentAdvisorUntil=0;}}
 // Runs a local slash command and returns its output instead of adding it to the chat. OMP writes a command's
 // command_output frames before its response, so they all land while the capture is open.
 async function slashOutput(s,rpc,message){const out=s._capture=[];try{await rpc.send({type:'prompt',message});}finally{if(s._capture===out)delete s._capture;}return out.join('\n').trim();}
 // OMP rotates between a provider's OAuth accounts unless the session is pinned (/session pin applies to the current
 // model's provider and survives restarts of that session). Pins the account the user chose, once per runner and choice.
 async function applyAccount(s,rpc){
  const provider=s.provider,label=store.accountChoices[provider],key=provider+'\n'+label;
  if(!provider||!label||rpc.account===key)return;
  rpc.account=key;
  const out=await slashOutput(s,rpc,`/session pin ${label}`).catch(e=>e.message);
  if(out.startsWith('Pinned '))return;
  if(/streaming/i.test(out)){delete rpc.account;return;}
  notice(s,'warning',`Could not switch ${provider} to ${label}: ${out||'OMP did not answer.'}`);
 }
 async function refresh(s,rpc){const promptId=s._promptId,run=s._run;try{const state=await rpc.send({type:'get_state'});
  if(state){s.tps=typeof state.tokensPerSecond==='number'?state.tokensPerSecond:undefined;s.fast={enabled:!!state.fastModeEnabled,active:!!state.fastModeActive};if(typeof state.autoCompactionEnabled==='boolean')s.autoCompaction=state.autoCompactionEnabled;s.modes={steering:state.steeringMode,...(state.followUpMode?{followUp:state.followUpMode}:{}),interrupt:state.interruptMode};}
  if(state){s._planSupported=typeof state.planMode?.enabled==='boolean';if(s._planSupported)s.planMode=state.planMode;else delete s.planMode;if(state.planReview)s._planReview=state.planReview;else delete s._planReview;}
  if(state){s._goalSupported=Object.hasOwn(state,'goalMode');s._goalAvailable=state.goalMode?.available===true;s.goal=goalView(state.goalMode?.goal);s._skillImages=state.skillImages===true;}
  // Native quiescence is authoritative; unrelated events must not keep an idle run working.
  if(state?.isSettled===true&&state.isCompacting!==true&&s.status==='running')settle(s,promptId,run);
  // Likewise a streaming OMP is working whatever s.status says: a run reported aborted or failed can keep going
  // (e.g. Stop & send's own prompt_result reporting the interrupted run), and OMP rejects prompts while it streams.
  if(state?.isStreaming===true&&!['running','queued','done'].includes(s.status)){startWork(s);s.status='running';s.error=undefined;delete s._settled;}
  if(state?.isSettled===true&&!s._advisorChecked&&s.status!=='running'){s._advisorChecked=true;await advisorStatus(s,rpc);}if(state?.model){s.model=state.model.id;s.provider=state.model.provider;}if(state?.thinkingLevel)s.thinking=state.thinkingLevel;if(typeof state?.isCompacting==='boolean')s._compacting=state.isCompacting;s.todos=Array.isArray(state?.todoPhases)?state.todoPhases:[];if(state?.sessionFile)s.sessionFile=state.sessionFile;const cu=state?.contextUsage;s.contextPercent=typeof cu?.percent==='number'?cu.percent:undefined;if(typeof cu?.tokens==='number')s.contextTokens=cu.tokens;if(typeof cu?.contextWindow==='number')s.contextWindow=cu.contextWindow;const subs=await rpc.send({type:'get_subagents'});const list=Array.isArray(subs?.subagents)?subs.subagents:[];s.subagents=list.length;s.subagentList=list.slice(-50).map(subagentView);
  if(state?.isSettled===true&&s.messages?.some(m=>m.ompAt))await bindEntries(s,rpc);}catch{}}
 // Gives prompts typed in this panel their OMP entry ID once OMP has stored them (it is settled), matched by the exact
 // timestamp OMP echoed in message_start. Reads only entries newer than the last pass; one attempt per message.
 async function bindEntries(s,rpc){
  let r;try{r=await rpc.send({type:'get_entries',...(s._entryCursor?{since:s._entryCursor}:{})});}
  catch{if(s._entryCursor){delete s._entryCursor;return bindEntries(s,rpc);}for(const m of s.messages)delete m.ompAt;return;}
  const entries=Array.isArray(r?.entries)?r.entries:[];if(entries.length)s._entryCursor=String(entries.at(-1).id);
  const byTime=new Map();for(const e of entries){const p=entryPrompt(e),t=e.message?.timestamp;if(p&&typeof t==='number')byTime.set(t,byTime.has(t)?null:p.entryId);}
  for(const m of s.messages)if(m.ompAt){const id=byTime.get(m.ompAt);if(id)m.entryId=id;delete m.ompAt;}
 }
 // branch and handoff move OMP to a new session file; show that transcript instead of the old one.
 async function reload(s,rpc){await refresh(s,rpc);if(s.sessionFile)s.messages=await importMessages(s.sessionFile).catch(()=>s.messages);delete s._streamId;delete s._thinkId;delete s._promptMsg;delete s._entryCursor;}
 // `omp usage` for every logged-in provider (session's first), parsed once for both the /usage chat snapshot and GET /api/usage.
 async function providerUsage(s){
  const {provider,model}=s;if(!provider||!model)throw error('Select a model before checking /usage.');
  try{const {stdout}=await execOmp(['usage','--json'],{cwd:s.cwd,timeout:20000,maxBuffer:8*1024*1024,windowsHide:true});return modelUsage(JSON.parse(stdout),provider,model);}
  catch(e){throw error(`Could not read provider usage: ${String(e.stderr||e.message).trim()}`,502);}
 }
 async function command(s,body,checkedImages,queuedId){
  const allowed=['prompt','steer','follow_up','edit_follow_up','cancel_follow_up','cancel_steer','edit_steer','send_follow_up','answer','auto_approve','abort','complete','compact','hide','set_model','advisor','plan_mode','plan_review','plan_approve','rename','pref','abort_retry','bash','abort_bash','stats','export','branch_messages','branch','edit_last','regenerate','handoff','login_providers','login','tree','new_session','switch_session','interrupt','cycle_model','cycle_thinking','todos','last_reply','launch','predict_word','predict_word_feedback','discard','btw','btw_cancel','btw_history','subagent_cancel','subagent_steer','changes_worktree','worktree_status','worktree_finish'];if(!allowed.includes(body.type))throw error('Unsupported session command.');
  // Draft sessions (created by Enhance on New session) become normal on their first send. Cleared before any await,
  // so a discard can never act on a session whose first message is being dispatched; restored if nothing was sent.
  if(s.draft&&['prompt','steer','follow_up','interrupt','bash','send_follow_up'].includes(body.type)){
   delete s.draft;
   try{return await command(s,body,checkedImages,queuedId);}finally{if(!sent(s)){s.draft=true;scheduleSave();}}
  }
  if(body.type==='discard')return discardDraft(s);
  // Composer ghost text (OMP's spelling.autocomplete engine). Never starts OMP; any failure means no suggestion.
  if(body.type==='predict_word'||body.type==='predict_word_feedback'){
   const rpc=runners.get(s.id),draft=body.text,cursor=body.cursor;
   if(typeof draft!=='string'||draft.length>200000||!Number.isInteger(cursor)||cursor<0||cursor>draft.length)throw error('Invalid draft.');
   if(!rpc?.alive)return {suffix:null};
   if(body.type==='predict_word_feedback'){if(typeof body.suggestion!=='string'||!body.suggestion||body.suggestion.length>200)throw error('Invalid suggestion.');void rpc.send({type:body.type,text:draft,cursor,suggestion:body.suggestion,accepted:body.accepted===true}).catch(()=>{});return {};}
   // The first request can wait minutes while OMP's prediction daemon loads its engine.
   try{const r=await rpc.send({type:'predict_word',text:draft,cursor},155000);return {suffix:typeof r?.suffix==='string'&&r.suffix?r.suffix:null};}catch{return {suffix:null};}
  }
  // /btw typed in the composer goes to OMP's side-question channel instead of the transcript, running or not.
  if(['prompt','steer','follow_up','interrupt'].includes(body.type)&&typeof body.message==='string'&&/^\/btw(\s|$)/.test(body.message.trimStart())){
   if(checkedImages?.length||body.images?.length)throw error('Side questions cannot carry images.');
   return command(s,{type:'btw',question:body.message.trimStart().slice(4)});
  }
  if(body.type==='btw'){
   const question=text(body.question,'Side question',20000),recordId=body.recordId===undefined?undefined:text(body.recordId,'Topic',200);
   const rpc=await start(s);let r;
   try{r=await rpc.send({type:'btw',question,...(recordId?{recordId}:{})},60000);}catch(e){throw error(e.message,/still running/.test(e.message)?409:400);}
   // The btw_record frame normally lands first; keep it, since answer deltas may already have been added to it.
   if(r?.record?.id&&!s._btw?.some(x=>x.id===r.record.id))s._btw=[btwView(r.record),...(s._btw||[])].slice(0,20);
   return {record:s._btw?.find(x=>x.id===r?.record?.id)};
  }
  if(body.type==='btw_cancel'){const rpc=runners.get(s.id);if(!rpc?.alive)return {cancelled:false};const recordId=body.recordId===undefined?undefined:text(body.recordId,'Topic',200);const r=await rpc.send({type:'btw_cancel',...(recordId?{recordId}:{})});return {cancelled:r?.cancelled===true};}
  if(body.type==='btw_history'){const rpc=await start(s);const r=await rpc.send({type:'get_btw_history'});s._btw=(Array.isArray(r?.records)?r.records:[]).filter(x=>x?.id).slice(0,20).map(btwView);return {records:s._btw};}
  // Stop or steer one running subagent of this session (ids from get_subagents).
  if(body.type==='subagent_cancel'||body.type==='subagent_steer'){
   const id=text(body.id,'Subagent ID',200),rpc=runners.get(s.id);
   if(!s.subagentList?.some(a=>a.id===id))throw error('This subagent is not part of this session.',404);
   if(!rpc?.alive)throw error('OMP is no longer running.',409);
   if(body.type==='subagent_cancel'){const r=await rpc.send({type:'cancel_subagent',subagentId:id});await refresh(s,rpc);return {cancelled:r?.cancelled===true};}
   const message=text(body.message,'Message',20000);
   try{await rpc.send({type:'steer_subagent',subagentId:id,message},60000);}catch(e){throw error(e.message,409);}
   return {steered:true};
  }
  if(body.type==='changes_worktree')return worktreeChanges(s,body.base==='head'?'head':'start');
  if(body.type==='worktree_status')return worktreeStatus(s);
  if(body.type==='worktree_finish')return finishWorktree(s,body.action);
  const prompting=['prompt','steer','follow_up','interrupt'].includes(body.type);
  const images=prompting?(checkedImages??chatImages(body)):[];
  if(prompting&&s._task)throw error(`Wait for OMP to finish first (${s._task.replace(/…$/,'').toLowerCase()}).`);
  if(body.type==='answer'){
   const rpc=runners.get(s.id),id=text(body.id,'Question ID',200),q=s.uiRequests?.find(q=>q.id===id);
   if(!rpc?.alive||!q)throw error('This question is no longer pending.');
   let reply={type:'extension_ui_response',id};
   if(body.cancelled===true)reply.cancelled=true;
   else if(q.method==='ask')reply.answers=askAnswers(q,body.answers);
   else if(q.method==='confirm'){if(typeof body.confirmed!=='boolean')throw error('Choose Yes, No, or Cancel.');reply.confirmed=body.confirmed;}
   else{if(typeof body.value!=='string'||body.value.length>20000)throw error('Answer must be text under 20,000 characters.');if(q.method==='select'&&!q.options.includes(body.value))throw error('Choose one of the listed options.');reply.value=body.value;}
   await rpc.reply(reply);s.uiRequests=s.uiRequests.filter(x=>x.id!==id);return s;
  }
  // Approves OMP's tool-approval prompts as they arrive (approvalPrompt); turning it on also approves the ones already waiting.
  if(body.type==='auto_approve'){
   if(typeof body.enabled!=='boolean')throw error('Auto-approve must be true or false.');
   if(body.enabled){s.autoApprove=true;const rpc=runners.get(s.id);if(rpc?.alive)for(const q of (s.uiRequests||[]).filter(q=>q._approval))await autoApprove(s,rpc,q.id,q._approval);}
   else{delete s.autoApprove;cancelResume(s,'auto-approve turned off');}
   await persist();return s;
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
   const m=s.messages.find(m=>m.id===body.id);
   if(!m){if(body.type==='cancel_steer')return s;throw error('This steer is no longer available.');}
   if(m.steer==='dropped')throw error('This steer was not delivered.');
   if(body.type==='edit_steer'&&m.hasImage)throw error('Steers with images can only be cancelled.');
   const rpc=runners.get(s.id);
   const r=m.steer==='pending'&&rpc?.alive?await rpc.send({type:'remove_queued_message',message:m.hasImage&&m.text==='Image attached'?'':m.text,queue:'steering'}):null;
   if(!r?.removed){
    if(m.steer==='pending'&&!rpc?.alive)throw error('OMP is no longer running.');
    // Delivery can win the cancel request before its transcript echo arrives.
    if(m.steer==='pending')m.steer='received';
    if(body.type==='cancel_steer')notice(s,'info','OMP has already started delivering this steer; it can no longer be cancelled.');
    await persist();if(body.type==='edit_steer')throw error('OMP already read this steer.');
    return s;
   }
   // RPC events can reorder the transcript while removal is awaiting its reply.
   const i=s.messages.indexOf(m);if(i>=0)s.messages.splice(i,1);await persist();
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
  if(body.type==='rename'){const name=text(body.name,'Session name',120);const rpc=runners.get(s.id);if(rpc?.alive)await rpc.send({type:'set_session_name',name});s.title=name;delete s.autoTitle;await persist();return s;}
  if(body.type==='pref'){
   if(!Object.hasOwn(PREF_VALUES,body.key)||!PREF_VALUES[body.key].includes(body.value))throw error('Invalid session setting.');
   const rpc=await start(s);try{await rpc.send(PREFS[body.key](body.value));}catch(e){throw error(e.message);}
   (s.prefs??={})[body.key]=body.value;await refresh(s,rpc);await persist();return s;
  }
  if(body.type==='abort'||body.type==='abort_retry'){
   // Retry-only abort cancels backoff, but not an in-flight request or scheduled continuation.
   const rpc=runners.get(s.id);if(rpc?.alive)await rpc.send({type:'abort'});
   finishWork(s);s.status='paused';s.error=undefined;dropSteers(s);cancelResume(s,'session stopped');
   delete s._promptId;delete s._promptMsg;delete s._interrupt;delete s._retry;delete s._compacting;delete s.uiRequests;delete s._planReview;
   await persist();return s;
  }
  if(body.type==='abort_bash'){const rpc=runners.get(s.id);if(rpc?.alive)await rpc.send({type:body.type});return s;}
  if(body.type==='tree'){const rpc=await start(s);return treeView(await rpc.send({type:'get_tree'}));}
  if(body.type==='last_reply'){const rpc=await start(s);const r=await rpc.send({type:'get_last_assistant_text'});return {text:typeof r?.text==='string'?r.text:''};}
  if(body.type==='cycle_model'||body.type==='cycle_thinking'){
   const rpc=await start(s);const r=await rpc.send({type:body.type==='cycle_model'?'cycle_model':'cycle_thinking_level'});
   if(!r)throw error(body.type==='cycle_model'?'OMP has only one model to cycle through. Configure model roles or scoped models.':'This model has no thinking levels to cycle through.');
   // Remember the choice so a restarted runner keeps it.
   if(r.model?.provider&&r.model?.id){s.modelSelector=`${r.model.provider}/${r.model.id}`;if(r.thinkingLevel)s.thinkingChoice=r.thinkingLevel;}
   if(typeof r.level==='string')s.thinkingChoice=r.level;
   await refresh(s,rpc);await persist();return s;
  }
  if(body.type==='todos'){const phases=todoPhases(body.phases);const rpc=await start(s);const r=await rpc.send({type:'set_todos',phases});s.todos=Array.isArray(r?.todoPhases)?r.todoPhases:phases;await persist();return s;}
  if(body.type==='launch'){
   busy();const launch=await launchOptions(body.launch);
   if(JSON.stringify(launch??null)!==JSON.stringify(s.launch??null)){
    if(launch)s.launch=launch;else delete s.launch;
    // Launch flags are read at startup, so a live runner restarts (idle only) to apply them.
    if(runners.get(s.id)?.alive){const prev=s.status;runners.get(s.id).kill();for(let i=0;i<50&&runners.has(s.id);i++)await new Promise(r=>setTimeout(r,100));await start(s);s.status=prev;s.error=undefined;}
    append(s,'system',launch?'Launch options updated. OMP restarted with them.':'Launch options cleared. OMP restarted with its defaults.');
   }
   await persist();return s;
  }
  if(body.type==='compact'){
   busy();const rpc=await start(s);const instructions=typeof body.instructions==='string'?body.instructions.trim().slice(0,5000):'';s._task='Compacting context…';s._compacting=true;
   rpc.send({type:'compact',...(instructions?{customInstructions:instructions}:{})},0).then(async r=>{await refresh(s,rpc);append(s,'system',`Context compacted${typeof r?.tokensBefore==='number'?` (was ${r.tokensBefore.toLocaleString('en-US')} tokens)`:''}.`);},e=>append(s,'system',`Compaction failed: ${e.message}`))
    .finally(()=>{delete s._task;s._compacting=false;void persist();});
   await persist();return s;
  }
  if(body.type==='new_session'||body.type==='switch_session'){
   busy();let file;
   if(body.type==='switch_session'){file=sessionFileParam(body.file);const other=store.sessions.find(x=>x.id!==s.id&&!x.hidden&&x.sessionFile&&samePath(x.sessionFile,file));if(other)throw error(`That session is already open in the panel as “${other.title}”.`,409);}
   const rpc=await start(s);
   const r=await rpc.send(body.type==='new_session'?{type:'new_session'}:{type:'switch_session',sessionPath:file},60000);
   if(r?.cancelled)throw error('An extension cancelled the session change.');
   s.messages=[];s.todos=[];s.subagentList=[];delete s.contextTokens;delete s.contextPercent;await reload(s,rpc);
   if(body.type==='switch_session'){const head=await readSessionHead(file).catch(()=>null);if(head?.title)s.title=head.title.slice(0,120);}
   append(s,'system',body.type==='new_session'?'Started a fresh OMP session. The previous conversation stays in its own session file.':'Switched to another saved OMP session.');
   s.status='paused';await persist();return s;
  }
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
  // OMP's RPC has no in-place tree move (navigateTree is TUI and extension only): its `branch` copies the path up to just
  // before a user message into a new session file, keeping the old file intact. Edit last / Regenerate rewind with it too.
  if(body.type==='branch'||body.type==='edit_last'||body.type==='regenerate'){
   busy();const rpc=await start(s);const entryId=body.type==='branch'?text(body.entryId,'Message',200):undefined;
   const picked=userPrompt(await rpc.send({type:'get_entries'}),entryId);
   if(!picked&&entryId===undefined)throw error('OMP has no message of yours in this conversation yet.');
   const r=await rpc.send({type:'branch',entryId:entryId??picked.entryId});if(r?.cancelled)throw error('An extension cancelled the branch.');
   await reload(s,rpc);s.status='paused';
   if(body.type==='regenerate'){append(s,'system','Went back to before your last message in a new session and sent it again. The previous reply stays in the old session file.');return command(s,{type:'prompt',message:picked.text},picked.images);}
   append(s,'system',body.type==='branch'?'Branched into a new session from this point. The message you picked is back in the composer.':'Went back to before your last message in a new session. It is back in the composer to edit and resend.');
   await persist();return {session:s,text:typeof r?.text==='string'?r.text:picked?.text||'',images:picked?.images||[]};
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
   rpc.send({type:'login',providerId:id},0).then(()=>{notice(s,'info',`Logged in to ${id}.`);accountsChanged();},e=>notice(s,'error',`Login to ${id} failed: ${e.message}`)).finally(()=>{delete s._openUrl;scheduleSave();});
   return s;
  }
  if(['hide','complete'].includes(body.type)&&s.queuedMessages?.length)throw error('Send or remove queued messages before closing this session.');
  if(body.type==='hide'){if(s.status==='running')throw error('Stop the session before removing it from the panel.');runners.get(s.id)?.kill();s.hidden=true;await persist();return s;}
  if(body.type==='complete'){if(!['review','paused','done','error'].includes(s.status))throw error('Stop or finish the session before marking it complete.');s.status='done';cancelResume(s,'session marked complete');activity(s,`Completed ${s.title}`,'done');await persist();return s;}
  if(prompting){if(typeof body.message!=='string')throw error('Prompt is required.');body.message=images.length&&!body.message.trim()?'':text(body.message,'Prompt',200000);const full=contextError(s,body.message,images);if(full)throw error(full);}
  if(prompting&&/^\/usage(?:\s+show)?$/.test(body.message)){
   if(images.length)throw error('Remove image attachments before checking /usage.');
   const rpc=await start(s);await refresh(s,rpc);
   const report=modelUsageText(await providerUsage(s));
   append(s,'user',body.message,queuedId||randomUUID());append(s,'assistant',report);s.updatedAt=now();
   await persist();return s;
  }
  const slashCommand=prompting&&/^\/\S/.test(body.message);
  // OMP's own state decides whether it is busy; a drifted status would otherwise send a prompt OMP rejects.
  if(prompting&&!['running','queued'].includes(s.status)&&runners.get(s.id)?.alive){await refresh(s,runners.get(s.id));if(s.status==='running'&&body.type==='prompt'&&!slashCommand)body.type='steer';}
  if(body.type==='interrupt'){if(slashCommand)throw error('Run slash commands with Enter; Stop & send is for messages.');if(!['running','queued'].includes(s.status))body.type='prompt';}
  if(prompting&&images.length&&/^\/skill:/.test(body.message)){await start(s);if(!s._skillImages)throw error('This OMP build drops image attachments on /skill: commands. Set OMP_BIN to an updated build, or send the image in a normal message, then invoke the skill.');}
  if(prompting&&/^\/goal(?:\s|$)/.test(body.message)){
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
  if(body.type==='prompt'&&s.status==='running'&&!slashCommand)throw error('This session is running. Use Steer or Queue follow-up.');
  try{
   const rpc=await start(s);
   // Before the turn starts: OMP refuses to change the account mid-stream.
   if(prompting&&s.status!=='running')await applyAccount(s,rpc);
   if(prompting&&/^\/plan(?:-review)?(?:\s|$)/.test(body.message)&&!s._planSupported)throw error('This OMP build has no RPC plan mode. Use an updated OMP build; /plan was not sent to the model.');
   // Only prompt dispatch executes slash commands; steer would queue their literal text.
   // Stop & send: OMP aborts the turn and starts this prompt in one step (abort_and_prompt).
   const interrupt=body.type==='interrupt';
   const rpcType=slashCommand?'prompt':interrupt?'abort_and_prompt':body.type,wasRunning=['running','queued'].includes(s.status);
   // A message of the user's own supersedes a pending rate-limit resume; slash commands (say /usage) leave it armed.
   let msg;if(prompting){if(!slashCommand){cancelResume(s);if(body.type==='prompt'||interrupt)delete s._streamId;s.status='running';s.error=undefined;}msg=append(s,'user',body.message||'Image attached',queuedId||randomUUID());if(body.type==='steer'&&!slashCommand)msg.steer='pending';if(images.length){msg.hasImage=true;if(body.preview)msg.imagePreview=body.preview;}}
   const id=randomUUID();
   if((rpcType==='prompt'||interrupt)&&!slashCommand){s._promptId=id;s._promptMsg=msg.id;}
   if(interrupt){s._interrupt=id;delete s._retry;delete s._thinkId;}
   const result=await rpc.send({type:rpcType,id,...(prompting?{message:body.message,...(slashCommand&&wasRunning?{streamingBehavior:'steer'}:{}),...(images.length?{images}:{})}:{})},slashCommand?0:30000);
   // Local commands must not replace the active turn's result correlation.
   if(slashCommand&&(result?.agentInvoked===true||(!wasRunning&&result?.agentInvoked!==false)))s._promptId=id;
   if(rpcType==='prompt'&&result?.agentInvoked===false&&!slashCommand){s.status='review';delete s._promptMsg;}
   if(slashCommand){if(result?.agentInvoked===true)s.status='running';await refresh(s,rpc);}
   await persist();return s;
  }catch(e){if(slashCommand){await persist();throw error(e.message);}delete s._interrupt;delete s._promptMsg;s.status='error';s.error=e.message;dropSteers(s);append(s,'system',e.message);await persist();return s;}
 }
 // Room left in the session's context window, or null when the window is unknown (no runner state yet and the
 // model isn't in the cached model list, e.g. "OMP default"): then only the upload size limits images.
 function contextLeft(s){
  const sel=s.modelSelector||(s.provider&&s.model&&s.model!=='OMP default'?`${s.provider}/${s.model}`:'');
  const win=s.contextWindow||(sel&&modelCache?.data.models.find(m=>m.selector===sel)?.contextWindow);
  return win>0?{left:Math.max(0,win-(s.contextTokens||0)),win}:null;
 }
 function contextError(s,message,images){
  const c=images.length?contextLeft(s):null;if(!c)return '';
  const img=imagesTokens(images),txt=textTokens(message),n=v=>v.toLocaleString('en-US');
  return img+txt>c.left?`Not enough context left for this message: it needs about ${n(img+txt)} tokens (${images.length} ${images.length===1?'image':'images'} ≈ ${n(img)}, text ≈ ${n(txt)}), but only ${n(c.left)} of ${n(c.win)} tokens remain. Remove some images, or run /compact or start a new session.`:'';
 }
 async function sendQueued(s){
  while(s.queuedMessages?.length&&s.status==='running'){
   // Follow-up mode "all" delivers every queued message as one prompt, like OMP's own queue,
   // unless their combined text and images don't fit the context left; then they go one at a time.
   let batch=s.prefs?.followUpMode==='all'?s.queuedMessages.slice():[s.queuedMessages[0]];
   const load=async list=>{const out=[];for(const q of list)if(q.hasImage)out.push(...JSON.parse(await fs.readFile(queuedImageFile(q.id),'utf8')));return out;};
   let raw=await load(batch);if(batch.length>1&&contextError(s,batch.map(q=>q.text).join('\n\n'),raw)){batch=[batch[0]];raw=await load(batch);}
   const item=batch[0],images=raw.length?chatImages({images:raw}):[];
   const message=batch.length>1?batch.map(q=>q.text).filter(Boolean).join('\n\n'):item.text;
   const preview=batch.length>1?batch.flatMap(q=>[].concat(q.imagePreview??[])):item.imagePreview;
   s.status='review';
   // A message that alone no longer fits stays queued, holding back the ones behind it: the user can compact, edit or remove it.
   try{await command(s,{type:'prompt',message,preview:Array.isArray(preview)&&!preview.length?undefined:preview},images,item.id);}
   catch(e){notice(s,'error',`The next queued message was not sent and stays queued, with any queued after it. ${e.message}`);return;}
   if(s.status==='error'){s.messages=s.messages.filter(m=>m.id!==item.id);await persist();return;}
   if(closing)return;
   const sent=new Set(batch.map(q=>q.id));s.queuedMessages=s.queuedMessages.filter(q=>!sent.has(q.id));
   await persist();
   for(const q of batch)if(q.hasImage)await fs.rm(queuedImageFile(q.id),{force:true}).catch(()=>{});
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
 async function runUpdate(startedAt){
  const result=await updateOmp(ompEntry,{cwd:dataDir});
  updateState={...result,startedAt,finishedAt:now()};
  if(result.status==='done'){modelCache=undefined;configDefaults=undefined;}
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
// Mirrors OMP's serviceTierFamily(); `omp models --json` omits the api field, so custom OpenAI relays read as unsupported.
function fastCapable(m){if(m.provider==='openrouter')return /^(anthropic|google|openai)\//.test(m.id);return ['anthropic','openai','openai-codex','google','google-vertex'].includes(m.provider);}
 let modelCache;
 async function listModels(){
  if(modelCache&&Date.now()-modelCache.at<10*60000)return modelCache.data;
  const {stdout}=await execOmp(['models','--json'],{timeout:60000,maxBuffer:64*1024*1024,windowsHide:true});
  const models=(JSON.parse(stdout).models||[]).filter(m=>!m.kind||m.kind==='chat').map(m=>({selector:m.selector||`${m.provider}/${m.id}`,provider:m.provider,id:m.id,name:m.name||m.id,reasoning:!!m.reasoning,thinking:Array.isArray(m.thinking)?m.thinking:[],contextWindow:m.contextWindow,fast:fastCapable(m)}));
  const {roles,defaultThinking}=await modelRoles();
  modelCache={at:Date.now(),data:{models,roles,defaultThinking,thinkingLevels:THINKING}};return modelCache.data;
 }
 async function ensureProject(dir,name){
  let p=store.projects.find(p=>samePath(p.path,dir));if(p)return p;
  let branch='workspace';try{branch=await git(dir,['branch','--show-current'])||'detached';}catch{}
  p={id:randomUUID(),name:String(name||'').trim().slice(0,80)||path.basename(dir)||dir,path:dir,description:'',branch,color:colors[store.projects.length%colors.length]};store.projects.push(p);activity(null,`Added project ${p.name}`);return p;
 }
 // Checking out a whole repo can outlast git()'s 15 s on Windows: the same 746-file checkout measured 1-20 s from run to run.
 // A timeout kills only the git.exe wrapper, so git finished the worktree anyway while the session reported it as skipped.
 const WORKTREE_ADD_TIMEOUT=10*60000;
 // Errors are user-facing sentences: why this folder can't get a worktree, or git's own error.
 async function addWorktree(root,wt,b){
  try{await gitRun(root,['rev-parse','--is-inside-work-tree'],{timeout:15000});}
  catch(e){throw error(/not a git repository/i.test(e.message)?'this folder is not a Git repository.':`git could not read this folder: ${e.message}`);}
  // Inside a work tree, HEAD fails to resolve only while the current branch is unborn.
  try{await gitRun(root,['rev-parse','--verify','--quiet','HEAD^{commit}'],{timeout:15000});}catch{throw error('the repository has no commits yet, and a worktree needs at least one.');}
  await fs.mkdir(path.dirname(wt),{recursive:true});
  try{await gitRun(root,['worktree','add','-q','-b',b,wt,'HEAD'],{timeout:WORKTREE_ADD_TIMEOUT});}
  catch(e){
   // Drop whatever got created (folder, git's record, branch) so a failed attempt leaves nothing behind.
   await removeWorktree({cwd:wt,branch:b},root).catch(()=>{});
   throw error(e.status===504?`git worktree add did not finish within ${WORKTREE_ADD_TIMEOUT/60000} minutes.`:`git worktree add failed: ${e.message.replace(/\.?$/,'.')}`);
  }
 }
 async function createSession(p,{title,prompt='',isolate=false,model,provider,native=false,sessionFile,messages=[],selector,thinking,launch,draft=false}){
  const id=randomUUID();let cwd=p.path;let branch=p.branch;let isolated=isolate;const notes=[];
  if(isolate){const wt=path.join(dataDir,'worktrees',id);const b='omp-web/'+id.slice(0,8);
   try{await addWorktree(p.path,wt,b);cwd=wt;branch=b;}catch(e){isolated=false;notes.push(`Worktree isolation skipped: ${e.message} Working directly in ${p.path}.`);}}
  // Commit the session started from: the Changes working-tree view can diff against it, so the agent's own commits show too.
  const baseSha=await git(cwd,['rev-parse','--verify','HEAD']).catch(()=>undefined);
  const s={id,projectId:p.id,title,prompt,status:prompt?'queued':'paused',model:String(model||'OMP default'),provider:String(provider||''),branch,cwd,isolated,native,sessionFile,createdAt:now(),updatedAt:now(),tokens:0,cost:0,messages,todos:[],...(baseSha?{baseSha}:{}),...(launch?{launch}:{}),...(draft?{draft:true}:{})};
  if(selector){const i=selector.indexOf('/');s.modelSelector=selector;s.provider=selector.slice(0,i);s.model=selector.slice(i+1);}if(thinking){s.thinkingChoice=thinking;s.thinking=thinking;}
  for(const n of notes)append(s,'system',n);store.sessions.unshift(s);activity(s,sessionFile?`Resumed ${title}`:`Started ${title}`,'running');
  if(prompt)await command(s,{type:'prompt',message:prompt});else await persist();return s;
 }
 const sent=s=>s.messages.some(m=>m.role==='user'||m.id?.startsWith('tool-bash-'))||!!s.queuedMessages?.length;
 // Removes an Enhance-created session nobody sent anything to: enhance job, OMP process (awaited), its empty
 // session file, and its isolated worktree and branch. A worktree Windows still holds stays recorded for next startup.
 async function discardDraft(s){
  if(!s.draft||sent(s))return {discarded:false};
  // OMP's transcript is the truth: after a crash mid first send, workspace.json can still say draft with no messages.
  const recorded=s.sessionFile?(await importMessages(s.sessionFile).catch(()=>[])).some(m=>m.role==='user'):false;
  if(recorded){delete s.draft;await persist();return {discarded:false};}
  await Promise.allSettled([...enhanceJobs.values()].filter(j=>j.sessionId===s.id).map(stopEnhance));
  await stopRunner(s);
  // rmdir (not rm -r) only succeeds on an empty folder, so OMP's other sessions for the same cwd are never touched.
  if(s.sessionFile){await fs.rm(s.sessionFile,{force:true}).catch(()=>{});await fs.rmdir(path.dirname(s.sessionFile)).catch(()=>{});}
  let removed=true;
  const root=store.projects.find(p=>p.id===s.projectId)?.path;
  if(s.isolated&&root&&s.branch?.startsWith('omp-web/')){removed=await removeWorktree(s,root);if(!removed)console.error(`Could not remove draft worktree ${s.cwd}; will retry on next start.`);}
  if(removed){const i=store.sessions.indexOf(s);if(i>=0)store.sessions.splice(i,1);store.archived=store.archived.filter(k=>k!=='s:'+s.id);store.pinned=store.pinned.filter(k=>k!=='s:'+s.id);delete store.drafts['session:'+s.id];}
  else s.hidden=true;
  await persist();return {discarded:true};
 }
 // Removes an isolated session's worktree folder and its omp-web/ branch; false when Windows still holds the folder.
 async function removeWorktree(s,root){
  for(let i=0;i<20;i++){
   try{await git(root,['worktree','remove','--force',s.cwd]);break;}
   // On Windows `remove` can drop git's record and the files yet fail on the empty folder a dying process still holds;
   // retries then say "not a working tree". Once git no longer lists it, only the leftover folder remains.
   catch{if(!await worktreeListed(root,s.cwd)){await git(root,['worktree','prune']).catch(()=>{});await fs.rm(s.cwd,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});break;}if(i===19)return false;await new Promise(r=>setTimeout(r,50*(i+1)));}
  }
  await git(root,['branch','-D',s.branch]).catch(()=>{});return true;
 }
 // Kills the session's OMP process and waits for it to exit, so Windows lets go of its working directory.
 async function stopRunner(s){const rpc=runners.get(s.id);if(rpc){const stopped=new Promise(r=>rpc.child.once('close',r));if(!rpc.stopping)rpc.kill();if(rpc.child.exitCode===null&&rpc.child.signalCode===null)await stopped;}}
 // Changes › Working tree: the real `git diff` of the session's folder against the commit it started from (or HEAD),
 // plus untracked files, in OMP's diff format with absolute paths.
 async function worktreeChanges(s,which){
  const cwd=s.cwd,q=['-c','core.quotepath=off'];
  try{await gitRun(cwd,['rev-parse','--is-inside-work-tree'],{timeout:10000});}catch{throw error('This session’s folder is not a Git repository.',409);}
  let base='HEAD',label='HEAD';
  if(which==='start'&&s.baseSha){try{await gitRun(cwd,['cat-file','-e',s.baseSha+'^{commit}'],{timeout:10000});base=s.baseSha;label='session start';}catch{}}
  // No commit yet: compare with the empty tree, which shows staged files.
  if(base==='HEAD'&&!await gitRun(cwd,['rev-parse','--verify','HEAD'],{timeout:10000}).then(()=>true,()=>false)){base='4b825dc642cb6eb9a060e54bf8d69288fbee4904';label='empty repository';}
  const [diff,untracked]=await Promise.all([gitRun(cwd,[...q,'diff','--no-color','--no-ext-diff','--no-renames','--relative','--src-prefix=a/','--dst-prefix=b/','-U3',base,'--']),gitRun(cwd,[...q,'ls-files','--others','--exclude-standard','-z'])]);
  const files=gitDiffFiles(diff),extra=untracked.split('\0').filter(Boolean);let budget=2*1024*1024;
  for(const rel of extra.slice(0,200)){const d=budget>0?await untrackedDiff(path.join(cwd,rel)).catch(e=>`… (${e.code==='EISDIR'?'folder':'unreadable'})`):'… (diff omitted: too many changes)';budget-=d.length;files.push({path:rel,op:'create',diff:d});}
  return {cwd,base:label==='HEAD'?'HEAD':base.slice(0,12),baseLabel:label,untrackedOmitted:Math.max(0,extra.length-200),files:files.map(f=>({...f,path:path.join(cwd,f.path)}))};
 }
 const worktreeRoot=s=>{const root=store.projects.find(p=>p.id===s.projectId)?.path;if(!s.isolated||!root||!s.branch?.startsWith('omp-web/'))throw error('Only sessions in their own worktree can be finished this way.',409);return root;};
 // What finishing an isolated session would do: the branch checked out in the project folder is the merge target.
 async function worktreeStatus(s){
  const root=worktreeRoot(s),lines=o=>o.split('\n').filter(Boolean),here=await exists(s.cwd);
  const [base,rootDirty,remotes,dirty,upstream]=await Promise.all([gitRun(root,['branch','--show-current'],{timeout:10000}).then(o=>o.trim()),gitRun(root,['status','--porcelain','--untracked-files=no'],{timeout:15000}).then(o=>lines(o).length),gitRun(root,['remote'],{timeout:10000}).then(lines),
   here?gitRun(s.cwd,['status','--porcelain'],{timeout:15000}).then(o=>lines(o).length):null,here?gitRun(s.cwd,['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}'],{timeout:10000}).then(o=>o.trim(),()=>''):'']);
  let ahead=0,behind=0,commits=[];
  if(base){[behind,ahead]=(await gitRun(root,['rev-list','--left-right','--count',`${base}...${s.branch}`],{timeout:15000})).trim().split(/\s+/).map(Number);commits=lines(await gitRun(root,['log','--format=%h %s','-n','20',`${base}..${s.branch}`],{timeout:15000}));}
  return {root,cwd:s.cwd,exists:here,branch:s.branch,base,ahead,behind,commits,dirty,rootDirty,remote:remotes.includes('origin')?'origin':remotes[0]||'',upstream};
 }
 // Merge (merge commit or fast-forward) / squash into the project's branch, rebase onto it, push it, or delete worktree and branch.
 // A failed merge or rebase is undone so neither folder is left mid-conflict.
 async function finishWorktree(s,action){
  if(!['merge','squash','rebase','push','delete'].includes(action))throw error('Choose merge, squash, rebase, push or delete.');
  if(['running','queued'].includes(s.status)||s._task||s._bash)throw error('Wait for OMP to finish first.');
  const st=await worktreeStatus(s),{root,branch,base}=st;
  if(['merge','squash','rebase'].includes(action)&&!base)throw error(`${root} is not on a branch (detached HEAD). Check out the branch to merge into first.`,409);
  if(action==='merge'||action==='squash'){
   if(!st.ahead)throw error(`${branch} has no commits that ${base} lacks. Commit the work in the worktree first.`,409);
   if(st.rootDirty)throw error(`${root} has uncommitted changes. Commit or stash them before merging.`,409);
   try{if(action==='merge')await gitRun(root,['merge','--no-edit',branch]);else{await gitRun(root,['merge','--squash',branch]);await gitRun(root,['commit','-m',`${s.title}\n\nSquashed from ${branch}.`]);}}
   catch(e){await gitRun(root,action==='merge'?['merge','--abort']:['reset','--merge']).catch(()=>{});throw error(`Merge failed and was undone: ${e.message}`,409);}
   activity(s,`Merged ${branch} into ${base}${action==='squash'?' (squashed)':''}`,'done');
  }
  if(action==='rebase'){
   if(!st.exists)throw error('The worktree folder no longer exists.',409);
   if(st.dirty)throw error('The worktree has uncommitted changes. Commit them before rebasing.',409);
   try{await gitRun(s.cwd,['rebase',base]);}catch(e){await gitRun(s.cwd,['rebase','--abort']).catch(()=>{});throw error(`Rebase failed and was undone: ${e.message}`,409);}
   activity(s,`Rebased ${branch} onto ${base}`,'update');
  }
  if(action==='push'){
   if(!st.remote)throw error('This repository has no remote to push to.',409);
   await gitRun(st.exists?s.cwd:root,['push','-u',st.remote,branch],{timeout:120000,env:{GIT_TERMINAL_PROMPT:'0'}});
   activity(s,`Pushed ${branch} to ${st.remote}`,'update');
  }
  if(action==='delete'){
   await stopRunner(s);
   if(!await removeWorktree(s,root))throw error('Windows still holds the worktree folder. Close programs using it and try again.',409);
   // The session's folder is gone, so it leaves the panel; its OMP transcript stays in history.
   s.hidden=true;s.status='done';s.worktreeRemoved=now();delete store.drafts['session:'+s.id];
   activity(s,`Deleted worktree and branch ${branch}`,'done');await persist();return {action,deleted:true};
  }
  await persist();return {action,...await worktreeStatus(s)};
 }
 // Files edited (edit/write tool records) by two active sessions that share a folder rather than separate worktrees.
 // Set as _overlaps on both sessions before each /api/state reply.
 function markOverlaps(){
  const key=p=>process.platform==='win32'?p.toLowerCase():p;
  const active=store.sessions.filter(s=>!s.hidden&&!s.isolated&&['running','queued','review'].includes(s.status)).map(s=>{const files=new Map();for(const m of s.messages||[])for(const f of m.tool?.files||[])if(typeof f?.path==='string'&&f.path){const abs=path.resolve(s.cwd,f.path);files.set(key(abs),abs);}return {s,files};});
  for(const s of store.sessions)delete s._overlaps;
  for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
   const a=active[i],b=active[j],shared=[...a.files.keys()].filter(k=>b.files.has(k)).map(k=>a.files.get(k));if(!shared.length)continue;
   (a.s._overlaps??=[]).push({id:b.s.id,title:b.s.title,files:shared.slice(0,20),count:shared.length});(b.s._overlaps??=[]).push({id:a.s.id,title:a.s.title,files:shared.slice(0,20),count:shared.length});
  }
 }
 // Unknown (git failed) counts as still listed, so the worktree is retried rather than abandoned.
 async function worktreeListed(root,dir){try{return (await git(root,['worktree','list','--porcelain'])).split(/\r?\n/).some(l=>l.startsWith('worktree ')&&samePath(l.slice(9),dir));}catch{return true;}}
 const ompSessionsDir=path.resolve(options.ompSessionsDir||process.env.OMP_SESSIONS_DIR||path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent'),'sessions'));
 const headCache=new Map();
 const insideSessions=(value,exts)=>{const file=path.resolve(text(value,'File',4000));const rel=path.relative(ompSessionsDir,file);if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||!exts.some(x=>file.endsWith(x)))throw error('Not an OMP session file.');return file;};
// Keyed by path so a growing transcript replaces its entry instead of adding one per poll.
const costCache=new Map();
async function transcriptCost(f,st){const hit=costCache.get(f);if(hit?.m===st.mtimeMs&&hit.s===st.size)return hit.c;let c=0;try{for(const l of (await fs.readFile(f,'utf8')).split('\n')){if(!l.includes('"cost"'))continue;try{c+=JSON.parse(l).message?.usage?.cost?.total||0;}catch{}}}catch{}costCache.set(f,{m:st.mtimeMs,s:st.size,c});return c;}
// `omp stats` is what ingests new transcripts into ~/.omp/stats.db. After heavy use it reparses every grown session file and
// can take minutes, so it runs in the background (one at a time) and /api/spend answers from whatever the DB already holds.
const statsSync={running:null,error:''};
function syncStats(){
 statsSync.running??=execOmp(['stats','--summary'],{timeout:30*60000,maxBuffer:16*1024*1024,windowsHide:true})
  .then(()=>{statsSync.error='';},e=>{statsSync.error=(e.killed?'omp stats ran for 30 minutes and was stopped.':String(e.stderr||e.message).trim()).slice(0,500)||'omp stats failed.';})
  .finally(()=>{statsSync.running=null;});
}
// Spend per model from OMP's hourly rollups; `sync` starts an ingest unless one is already running.
async function spend(sync){
 if(sync)syncStats();
 const file=path.join(os.homedir(),'.omp','stats.db');
 let rows=[];
 if(await fs.access(file).then(()=>true,()=>false)){
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
  try{rows=db.prepare("SELECT bucket AS at,provider||'/'||model AS model,TOTAL(cost_total) AS cost FROM message_rollup GROUP BY bucket,provider,model ORDER BY bucket").all();}finally{db.close();}
 }
 return {rows,syncing:!!statsSync.running,syncError:statsSync.error};
}
 // `liveSince`: when the jobs still running now started at the earliest. Async jobs die with the OMP process that spawned them,
 // so a job from before it is not running even though its transcript never recorded an end. Infinity: a companion session
 // with no OMP process has none running. Undefined (a file the companion does not run): fall back to transcript quiet time.
 async function background(file,liveSince,registry=[]){
  const dir=file.replace(/\.jsonl$/,'');const scanned=await scanJobs(file);let entries=[];try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{}
  const subagents=[],jobs=[];
  await Promise.all(entries.filter(e=>e.isFile()).map(async e=>{const f=path.join(dir,e.name);let st;try{st=await fs.stat(f);}catch{return;}
   if(e.name.endsWith('.jsonl')){const name=e.name.slice(0,-6);let head={};try{head=await readSessionHead(f);}catch{}let result='';try{result=(await fs.readFile(path.join(dir,name+'.md'),'utf8')).slice(0,4000);}catch{}
    subagents.push({name,file:f,size:st.size,startedAt:head.createdAt||'',updatedAt:st.mtime.toISOString(),model:head.model||'',thinking:head.reasoning||'',preview:head.preview||'',result,cost:await transcriptCost(f,st),advisor:name==='__advisor'||name.startsWith('__advisor.')});}
   else if(e.name.endsWith('.async.log')){jobs.push({name:e.name,file:f,size:st.size,updatedAt:st.mtime.toISOString()});}
  }));
  subagents.sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));jobs.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const byName=new Map(subagents.map(x=>[x.name,x]));
  let mtime=0;try{mtime=(await fs.stat(file)).mtimeMs;}catch{}const quiet=liveSince===undefined&&Date.now()-mtime>30*60e3;
  const tasks=scanned.map(j=>{const sub=byName.get(j.id);const gone=liveSince===undefined?quiet:Date.parse(j.startedAt)<liveSince;const status=j.status==='running'?(sub?.result?'done':gone?'stale':'running'):j.status;return {...j,status,transcript:sub?.file||'',model:sub?.model||'',thinking:sub?.thinking||'',summary:sub?.result||'',cost:sub?.cost||0,updatedAt:sub?.updatedAt||j.finishedAt||j.startedAt};});
  // Registry entries (running subagents) take model, level, cost and start time from their own transcript, like task jobs.
  const agents=await Promise.all(registry.map(async a=>{let sub=a.sessionFile&&subagents.find(x=>samePath(x.file,a.sessionFile));
   if(!sub&&a.sessionFile){let head={};try{head=await readSessionHead(insideSessions(a.sessionFile,['.jsonl']));}catch{}sub={model:head.model||'',thinking:head.reasoning||'',startedAt:head.createdAt||''};}
   return {...a,model:sub?.model||'',thinkingLevel:sub?.thinking||'',cost:sub?.cost||0,result:sub?.result||'',startedAt:sub?.startedAt||''};}));
  const linked=new Set(tasks.map(t=>t.id)),linkedFiles=agents.map(a=>a.sessionFile).filter(Boolean);
  return {dir,tasks,agents,subagents:subagents.filter(x=>!linked.has(x.name)&&!linkedFiles.some(f=>samePath(f,x.file))),logs:jobs};
 }
 const sessionFileParam=value=>{const file=path.resolve(text(value,'Session file',4000));if(!file.endsWith('.jsonl')||!samePath(path.dirname(path.dirname(file)),ompSessionsDir))throw error('Not an OMP session file.');return file;};
 // Tools page: each run is a background job the dashboard polls; stdin is closed so a prompt fails instead of hanging.
 const cliJobs=[];const cliProcs=new Map();
 // Enhance jobs: one read-only `omp -p` per click; the dashboard polls GET /api/enhance until it settles.
 const enhanceJobs=new Map();
 const IMAGE_EXT={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
 async function startEnhance(body){
  const draft=text(body.text,'Draft',200000);
  if(!!body.session===!!body.path)throw error('Choose a session or a folder to enhance in.');
  const s=body.session?store.sessions.find(x=>x.id===body.session):null;
  if(body.session&&!s)throw error('Session not found.',404);
  // Node reports a missing cwd as `spawn omp ENOENT`, which reads like OMP itself is missing.
  if(s&&(!s.cwd||!await exists(s.cwd)))throw error(`The session's working directory no longer exists: ${s.cwd||'unknown'}`);
  const cwd=s?s.cwd:await resolveDir(body.path);
  const images=chatImages(body);
  if([...enhanceJobs.values()].filter(j=>j.status==='running').length>=3)throw error('Wait for the running enhance to finish.',409);
  const selector=s?(s.modelSelector||(s.provider&&s.model&&s.model!=='OMP default'?`${s.provider}/${s.model}`:'')):modelChoice(body).selector;
  const pick=enhanceModel((await modelRoles()).roles,selector,store.enhanceThinking);
  const id=randomUUID(),dir=path.join(dataDir,'enhance',id);
  const files=[];
  if(images.length){await fs.mkdir(dir,{recursive:true,mode:0o700});for(const [i,img] of images.entries()){const f=path.join(dir,`image-${i+1}.${IMAGE_EXT[img.mimeType]||'png'}`);await fs.writeFile(f,Buffer.from(img.data,'base64'),{mode:0o600});files.push(f);}}
  const job={id,sessionId:s?.id||null,status:'running',step:'',model:pick.label,text:'',error:'',dir};
  const child=spawn(ompExecutable,[...ompPrefix,...(options.enhancePrefix||[]),...enhanceArgs({model:pick.model,thinking:pick.thinking,overlay:enhanceOverlay,system:enhanceSystem,images:files})],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'}});
  job.child=child;enhanceJobs.set(id,job);
  let stderr='',answer='';
  child.stdin.on('error',()=>{});child.stdin.end(enhanceInput(draft,s?.messages??[]),'utf8');
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-8000);});
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{let f;try{f=JSON.parse(line);}catch{return;}
   if(f.type==='tool_execution_start')job.step=stepLabel(f.toolName,f.args,cwd);
   else if(f.type==='message_end'&&f.message?.role==='assistant')answer=contentText(f.message.content);});
  const timer=setTimeout(()=>{job.timedOut=true;child.kill();},150000);timer.unref();
  job.closed=new Promise(resolve=>{let done=false;const finish=async(code,err)=>{if(done)return;done=true;clearTimeout(timer);
   const out=cleanEnhanced(answer);
   if(job.timedOut)Object.assign(job,{status:'error',error:'Enhance timed out.'});
   else if(job.stopped)job.status='cancelled';
   else if(code===0&&!err&&out)Object.assign(job,{status:'done',text:out});
   else if(code===0&&!err)Object.assign(job,{status:'error',error:'The enhancer returned no text.'});
   // OMP prints the error first and a "Run `omp …`" hint after it; skip warnings (e.g. MCP connect failures).
   else Object.assign(job,{status:'error',error:err?.message||stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/).map(l=>l.trim()).find(l=>l&&!/^warning:/i.test(l))||`OMP exited (${code}).`});
   delete job.child;job.finishedAt=now();
   await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
   setTimeout(()=>{if(enhanceJobs.get(id)===job)enhanceJobs.delete(id);},5*60000).unref();
   resolve();};
   child.on('error',e=>finish(null,e));child.on('close',code=>finish(code));});
  return {id,model:job.model};
 }
 // Resolves once the enhancer process has exited and its image folder is gone.
 async function stopEnhance(job){if(job.child){job.stopped=true;job.child.kill();}await job.closed;}
 const stopAllEnhance=()=>Promise.allSettled([...enhanceJobs.values()].map(stopEnhance));
 async function cliArgs(body){
  const tool=CLI_TOOLS[body.tool],spec=tool&&Object.hasOwn(tool.actions,body.action)?tool.actions[body.action]:null;
  if(!spec||!Object.hasOwn(CLI_TOOLS,body.tool))throw error('Unknown OMP command.');
  const values=body.values&&typeof body.values==='object'&&!Array.isArray(body.values)?body.values:{};
  const args=[...spec.args];
  for(const f of spec.fields||[]){
   let v=values[f.name];if(typeof v==='string')v=v.trim();
   if(v===undefined||v===null||v===''||v===false){if(f.required)throw error(`${f.label} is required.`);continue;}
   if(f.type==='bool'){if(v!==true)throw error(`${f.label} must be on or off.`);args.push(f.flag);continue;}
   let out;
   if(f.type==='int'){if(!Number.isInteger(v)||v<(f.min??0)||v>(f.max??1e9))throw error(`${f.label} must be a whole number${f.max!==undefined?` from ${f.min??0} to ${f.max}`:''}.`);out=String(v);}
   else if(f.type==='select'){if(!f.options.includes(v))throw error(`Choose a valid ${f.label.toLowerCase()}.`);out=v;}
   else if(f.type==='model'){if(typeof v!=='string'||!MODEL_RE.test(v))throw error('Invalid model.');out=v;}
   else if(f.type==='dir')out=await resolveDir(v);
   else if(f.type==='session')out=sessionFileParam(v);
   else{if(typeof v!=='string'||v.length>(f.max||500)||v.includes('\0')||(f.type!=='textarea'&&/[\r\n]/.test(v)))throw error(`${f.label} is too long or has invalid characters.`);
    if(f.pattern&&!new RegExp(f.pattern).test(v))throw error(`${f.label} has invalid characters.`);out=v;}
   if(f.arg){args.push(out);continue;}
   if(f.positional){if(out.startsWith('-'))throw error(`${f.label} cannot start with "-".`);args.push(out);}
   else if(f.type==='list')for(const x of out.split(',').map(x=>x.trim()).filter(Boolean))args.push(`${f.flag}=${x}`);
   else args.push(`${f.flag}=${out}`);
  }
  const cwd=body.cwd?await resolveDir(body.cwd):spec.cwd==='required'?(()=>{throw error('Pick a folder to run this in.');})():dataDir;
  return {spec,args,cwd};
 }
 async function runCli(body){
  const {spec,args,cwd}=await cliArgs(body);
  if(cliJobs.filter(j=>j.status==='running').length>=4)throw error('Four OMP commands are already running. Wait for one to finish.',409);
  const job={id:randomUUID(),tool:body.tool,action:body.action,command:'omp '+args.join(' '),cwd,status:'running',output:'',startedAt:now()};
  cliJobs.unshift(job);cliJobs.splice(30);
  const child=spawn(ompExecutable,[...ompPrefix,...args],{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'}});
  cliProcs.set(job.id,child);
  const add=b=>{job.output=(job.output+b.toString()).slice(-200000);};
  child.stdout.on('data',add);child.stderr.on('data',add);
  const timer=setTimeout(()=>{job.timedOut=true;child.kill();},spec.long?30*60000:3*60000);
  const finish=(code,err)=>{if(job.status!=='running')return;clearTimeout(timer);cliProcs.delete(job.id);job.output=[job.output,err?.message,job.timedOut?'Timed out.':job.stopped?'Stopped.':''].filter(Boolean).join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().slice(-200000)||'(no output)';job.exitCode=code;job.status=code===0&&!err?'done':'error';job.finishedAt=now();};
  child.on('error',e=>finish(null,e));child.on('close',code=>finish(code));
  return job;
 }
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
 const refreshTimer=setInterval(async()=>{if(refreshBusy||closing)return;refreshBusy=true;try{await Promise.all([...runners].filter(([,r])=>r.alive).map(([id,r])=>refresh(store.sessions.find(s=>s.id===id),r)));await persist();}catch(e){console.error('Background refresh failed:',e.message);}finally{refreshBusy=false;}checkAutoShutdown();},4000);refreshTimer.unref();
 // Fill the account cache shortly after startup, so the first Choose provider accounts… opens instantly.
 const accountTimer=setTimeout(()=>refreshAccounts().catch(()=>{}),1000);accountTimer.unref();
 // The page's own host as a ws: source too: older Safari doesn't count ws: under 'self' (the Screen page's WebSocket).
 const staticFiles=new Map();const csp=host=>`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' ws://${host}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
 const digest=data=>createHash('sha1').update(data).digest('base64url').slice(0,12);
 const staticFile=async file=>{const st=await fs.stat(file);let c=staticFiles.get(file);if(c?.mtime!==st.mtimeMs||c.size!==st.size){const data=await fs.readFile(file);c={mtime:st.mtimeMs,size:st.size,data,hash:digest(data)};staticFiles.set(file,c);}return c;};
 // This PC's Tailscale name and addresses, looked up at most once a minute; options.tailscale replaces the lookup (tests).
 let tsCache=null,tsAt=0,tsPending;
 const tailscale=()=>Date.now()-tsAt<60000?Promise.resolve(tsCache):tsPending??=(options.tailscale||tailscaleSelf)().catch(()=>null).then(v=>{tsCache=v;tsAt=Date.now();tsPending=undefined;return v;});
 // Host/Origin gate for API requests and the screen WebSocket (CORS doesn't cover WebSockets, so its Origin check matters most).
 // Bound to all interfaces (OMP_WEB_HOST=0.0.0.0): also accept this machine's adapter addresses, still rejecting DNS-rebinding names.
 // OMP_WEB_PUBLIC_HOSTS names are matched exactly too, so any other name (DNS rebinding) is still refused. So is this PC's own
 // MagicDNS name while the companion listens on its tailnet address: only the tailnet resolves it, to this PC.
 async function checkOrigin(req){
  const a=server.address(),port=a?.port,wild=a&&['0.0.0.0','::'].includes(a.address),names=new Set(['127.0.0.1','localhost',...publicHosts]);
  if(wild){for(const list of Object.values(os.networkInterfaces()))for(const n of list||[])names.add(n.family==='IPv6'?`[${n.address}]`:n.address);}else if(a?.address)names.add(a.family==='IPv6'?`[${a.address}]`:a.address);
  const host=String(req.headers.host||'').toLowerCase(),origin=req.headers.origin;
  const allowed=()=>{const hosts=new Set([...names].map(n=>`${n}:${port}`));return {host:hosts.has(host),origin:!origin||allowedOrigins.has(origin)||hosts.has(origin.replace(/^http:\/\//,''))&&origin.startsWith('http://')};};
  let ok=allowed();
  // The MagicDNS name is only looked up when nothing else matched, so requests to 127.0.0.1 or a LAN address never wait for it.
  if(!(ok.host&&ok.origin)&&a&&(wild||tailnetAddress(a.address))){const ts=await tailscale();if(ts?.name&&(wild||ts.ips.includes(a.address))){names.add(ts.name);ok=allowed();}}
  if(!ok.host)throw error('Invalid Host header.',403);
  if(!ok.origin)throw error('Origin not allowed. Open the local dashboard or set OMP_ALLOWED_ORIGINS to the exact hosted origin.',403);
  return {origin,host};
 }
 // ---------- screen sharing ----------
 // Off unless turned on: OMP_WEB_SCREEN=1, or the desktop app's tray item (setScreen). Seeing and controlling the PC takes the
 // same token and Host/Origin checks as the API: POST /api/screen/ticket (token) returns a 30-second, single-use ticket bound to
 // the caller's address, which opens the WebSocket at /api/screen/ws (browsers can't put an Authorization header on one).
 // One viewer at a time: a new one replaces the previous, so two devices never fight over the mouse.
 const screenSupported=Boolean(options.screenCommand)||process.platform==='win32';
 let screenOn=screenSupported&&Boolean(options.screen??process.env.OMP_WEB_SCREEN==='1'),viewer=null;
 const screenTickets=new Map();
 const screenOff=()=>error(options.desktop?'Screen sharing is off. Turn on "Allow screen sharing and control" in the OMP Control Room tray menu on this PC.':'Screen sharing is off. Start the companion with OMP_WEB_SCREEN=1 on this PC to allow it.',409);
 const peer=a=>String(a||'').replace(/^::ffff:/,'');
 const wsSend=(socket,op,data)=>{
  if(socket.destroyed||!socket.writable)return;const n=data.length,h=Buffer.alloc(n<126?2:n<65536?4:10);h[0]=0x80|op;
  if(n<126)h[1]=n;else if(n<65536){h[1]=126;h.writeUInt16BE(n,2);}else{h[1]=127;h.writeBigUInt64BE(BigInt(n),2);}
  socket.cork();socket.write(h);socket.write(data);socket.uncork();
 };
 const wsClose=(socket,code,reason)=>{const r=Buffer.from(String(reason)).subarray(0,123),p=Buffer.alloc(2+r.length);p.writeUInt16BE(code);r.copy(p,2);wsSend(socket,8,p);socket.end();setTimeout(()=>socket.destroy(),2000).unref();};
 // notify=false: a takeover, where onScreen reports the new viewer right after (no "nobody is viewing" in between).
 function dropViewer(code=1000,reason='',notify=true){
  const v=viewer;if(!v)return;viewer=null;clearInterval(v.ping);
  if(!v.socket.destroyed)wsClose(v.socket,code,reason);
  const h=v.helper;if(h&&h.exitCode===null){h.stdin.end('x\nq\n');const t=setTimeout(()=>h.kill(),3000);t.unref();h.once('exit',()=>clearTimeout(t));}
  if(notify)try{options.onScreen?.(null);}catch(e){console.error('Screen hook failed:',e.message);}
 }
 // Commands wait in `queue` until the helper exists; frame credits start with the viewer's first config, so no frame is captured at the wrong size.
 const toHelper=(v,s)=>{if(!s)return;if(v.helper)v.helper.stdin.write(s);else v.queue+=s;};
 function startHelper(v){
  const [cmd,args]=options.screenCommand||[path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:OMP_SCREEN_SOURCE)) -ReferencedAssemblies System.Drawing,System.Windows.Forms; [OmpScreenHelper]::Run()']];
  const source=path.join(dataDir,'screen-helper.cs');
  return (options.screenCommand?Promise.resolve():syncFile(source,SCREEN_HELPER)).then(()=>{
   if(viewer!==v)return;
   const h=v.helper=spawn(cmd,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,OMP_SCREEN_SOURCE:source}});
   let out=Buffer.alloc(0),err='';
   h.stdin.on('error',()=>{});h.stderr.on('data',d=>{err=(err+d).slice(-2000);});
   h.stdout.on('data',d=>{
    out=out.length?Buffer.concat([out,d]):d;
    while(out.length>=4){
     const n=out.readUInt32LE(0);if(n>64*1024*1024){h.kill();return;}if(out.length<4+n)break;
     const msg=out.subarray(4,4+n);out=out.subarray(4+n);
     if(viewer===v)msg[0]===1?wsSend(v.socket,2,msg):wsSend(v.socket,1,msg.subarray(1));
    }
   });
   h.on('error',e=>{err=e.message;});
   h.on('close',code=>{if(viewer===v)dropViewer(1011,`Screen capture stopped (${err.trim().split('\n').pop()||`exit code ${code}`}).`);});
   h.stdin.write(v.queue);v.queue='';
  });
 }
 function startViewer(socket,head,address){
  if(viewer)dropViewer(4001,'Another device is now viewing this PC.',false);
  const v={socket,address:peer(address),since:now(),lastSeen:Date.now(),buf:Buffer.from(head),queue:'',started:false};
  viewer=v;socket.setNoDelay(true);
  socket.on('close',()=>{if(viewer===v)dropViewer();});
  socket.on('data',d=>{v.lastSeen=Date.now();v.buf=v.buf.length?Buffer.concat([v.buf,d]):d;readViewer(v);});
  // Browsers answer pings by themselves: a viewer that stops answering (phone asleep, network gone) frees the PC after 45 s.
  v.ping=setInterval(()=>{if(Date.now()-v.lastSeen>45000)dropViewer(1001,'The viewer stopped answering.');else wsSend(socket,9,Buffer.alloc(0));},15000);v.ping.unref();
  try{options.onScreen?.({address:v.address});}catch(e){console.error('Screen hook failed:',e.message);}
  startHelper(v).catch(e=>{if(viewer===v)dropViewer(1011,`Screen capture could not start: ${e.message}`);});
  readViewer(v);
 }
 // Client frames are masked; only small, unfragmented text messages are accepted (input events and acks).
 function readViewer(v){
  while(viewer===v&&v.buf.length>=2){
   const b=v.buf,op=b[0]&15;let n=b[1]&127,off=2;
   if(!(b[0]&0x80)||!(b[1]&0x80)||n===127)return dropViewer(1002,'Unsupported WebSocket frame.');
   if(n===126){if(b.length<4)return;n=b.readUInt16BE(2);off=4;}
   if(n>65536)return dropViewer(1009,'Message too large.');
   if(b.length<off+4+n)return;
   const mask=b.subarray(off,off+4),data=Buffer.from(b.subarray(off+4,off+4+n));for(let i=0;i<n;i++)data[i]^=mask[i&3];
   v.buf=b.subarray(off+4+n);
   if(op===8)return dropViewer();
   if(op===9){wsSend(v.socket,10,data);continue;}
   if(op!==1)continue;
   let m;try{m=JSON.parse(data.toString('utf8'));}catch{continue;}
   toHelper(v,screenCommands(m));
   if(m?.t==='config'&&!v.started){v.started=true;toHelper(v,'f 2\n');}
  }
 }
 // The desktop app's tray turns screen sharing on and off at runtime; turning it off ends a running view at once.
 const setScreen=on=>{screenOn=screenSupported&&Boolean(on);if(!screenOn){screenTickets.clear();dropViewer(4002,'Screen sharing was turned off on this PC.');}return screenOn;};
 const server=createServer(async(req,res)=>{
 // Big JSON (the viewed session's messages, transcripts, settings) goes out gzipped when the client accepts it; zlib runs off the event loop.
 const send=(status,headers,body)=>{if(body.length<1024||!/\bgzip\b/.test(req.headers['accept-encoding']||'')){res.writeHead(status,headers);res.end(body);return;}gzip(body,{level:1},(e,z)=>{if(res.headersSent)return;res.writeHead(status,e?headers:{...headers,'Content-Encoding':'gzip'});res.end(e?body:z);});};
 const json=(value,status=200)=>send(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'},JSON.stringify(value));
  try{
   const {origin,host}=await checkOrigin(req),port=server.address()?.port;
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
    if(ext==='.html'){const v={};for(const n of ['app.css','app.js'])v[n]=(await staticFile(path.join(root,n)).catch(()=>null))?.hash;let html=data.toString('utf8').replace(/(href|src)="\/(app\.(?:css|js))"/g,(m,a,n)=>v[n]?`${a}="/${n}?v=${v[n]}"`:m);if(exposeToken)html=html.replace('</head>',`<meta name="omp-token" content="${token}"/>\n</head>`);
     // The desktop app shows native notifications for this machine, so pages opened here skip the browser's own.
     if(options.desktop&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))html=html.replace('</head>','<meta name="omp-desktop" content="1"/>\n</head>');
     data=Buffer.from(html);hash=digest(data);}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.zip':'application/zip'};
    const headers={'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':csp(host),'Cache-Control':ext!=='.html'&&url.searchParams.get('v')===hash?'public, max-age=31536000, immutable':'no-cache',ETag:`"${hash}"`};
    if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers);res.end();return;}
    res.writeHead(200,headers);res.end(data);return;
   }
   const provided=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
   if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw error(password?'Wrong password.':'Invalid connection token.',401);
   if(req.method==='GET'&&url.pathname==='/api/state'){
    markOverlaps();
    // Draft texts can be large: polls carry only their timestamps, and the dashboard fetches a changed draft by key.
    const drafts=Object.fromEntries(Object.entries(store.drafts).map(([k,v])=>[k,v.at]));
    if(!url.searchParams.has('session')){json({...store,drafts,instance,canRestart,autoShutdown:autoShutdownView()});return;}
    // ?session=<id> (the dashboard's polls): messages and /btw answers only for that session, no activity log; ETag so unchanged polls send nothing.
    const id=url.searchParams.get('session'),body=JSON.stringify({...store,drafts,instance,canRestart,autoShutdown:autoShutdownView(),activity:undefined,sessions:store.sessions.map(s=>s.id===id?s:{...s,messages:undefined,_btw:undefined})}),tag=`"${digest(body)}"`;
    if(req.headers['if-none-match']===tag){res.writeHead(304,{ETag:tag,'Cache-Control':'no-store'});res.end();return;}
    send(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',ETag:tag},body);return;
   }
   if(req.method==='GET'&&url.pathname==='/api/draft'){const d=store.drafts[url.searchParams.get('key')];json({text:d?.text??'',at:d?.at??null});return;}
   if(req.method==='GET'&&url.pathname==='/api/omp-sessions'){json({dir:ompSessionsDir,sessions:await listNativeSessions()});return;}
   if(req.method==='GET'&&url.pathname==='/api/omp-sessions/preview'){const file=sessionFileParam(url.searchParams.get('file'));let head;try{head=await readSessionHead(file);}catch{throw error('Session file not found.',404);}json({...head,file,contextTokens:await lastContext(file).catch(()=>undefined),messages:await importMessages(file,150)});return;}
   if(req.method==='GET'&&url.pathname==='/api/settings'){try{json(await listSettings());}catch(e){throw error(`Could not read OMP settings: ${e.message}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/plugins'){try{json(await listPlugins());}catch(e){throw error(`Could not read OMP plugins: ${e.message}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/omp-update'){json(updateState);return;}
   if(req.method==='GET'&&url.pathname==='/api/advisor'){json(await advisorConfig());return;}
   if(req.method==='GET'&&url.pathname==='/api/cli'){json({tools:cliCatalog(),jobs:cliJobs});return;}
   if(req.method==='GET'&&url.pathname==='/api/enhance'){const job=enhanceJobs.get(url.searchParams.get('id'));if(!job)throw error('Enhance not found.',404);
    if(job.status!=='running')enhanceJobs.delete(job.id);
    json({id:job.id,status:job.status,step:job.step,model:job.model,...(job.status==='done'?{text:job.text}:{}),...(job.error?{error:job.error}:{})});return;}
   if(req.method==='GET'&&url.pathname==='/api/spend'){try{json(await spend(url.searchParams.get('sync')==='1'));}catch(e){throw error(`Could not read OMP usage stats: ${String(e.stderr||e.message).trim()}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/models'){try{json(await listModels());}catch(e){throw error(`Could not list OMP models: ${e.message}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/usage'){
    const s=store.sessions.find(s=>s.id===url.searchParams.get('session'));if(!s)throw error('Session not found.',404);
    // Sessions on "OMP default" have no provider until OMP reports its model, as /usage resolves it.
    if(!s.provider||!s.model)await lock(s.id,async()=>{const rpc=await start(s);await refresh(s,rpc);await persist();});
    json({...await providerUsage(s),updatedAt:now()});return;
   }
   if(req.method==='GET'&&url.pathname==='/api/accounts'){try{json(await listAccounts());}catch(e){throw error(`Could not list provider accounts: ${e.message}`,502);}return;}
   if(req.method==='GET'&&url.pathname==='/api/commands'){
    if(url.searchParams.has('path')){json({commands:await discoverCommands(await resolveDir(url.searchParams.get('path')))});return;}
    const s=store.sessions.find(s=>s.id===url.searchParams.get('session'));if(!s)throw error('Session not found.',404);
    await lock(s.id,async()=>{await start(s);await persist();});json({commands:commands.get(s.id)||[]});return;
   }
   if(req.method==='GET'&&url.pathname==='/api/background'){const file=insideSessions(url.searchParams.get('file'),['.jsonl']);const owned=store.sessions.filter(s=>s.sessionFile&&samePath(s.sessionFile,file));const runner=owned.map(s=>runners.get(s.id)).find(Boolean);const live=!!runner;
    const own=owned[0];const bg=await background(file,runner?runner.startedAt:owned.length?Infinity:undefined,(own?.subagentList||[]).map(a=>({...a,thinking:subagentThoughts.get(own.id+':'+a.id)?.text||''})));json({...bg,live});return;}
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
   if(req.method==='GET'&&url.pathname==='/api/screen'){json({supported:screenSupported,enabled:screenOn,desktop:Boolean(options.desktop),viewer:viewer&&{address:viewer.address,since:viewer.since}});return;}
   if(req.method!=='POST')throw error('Route not found.',404);
   if(!String(req.headers['content-type']).startsWith('application/json'))throw error('JSON body required.',415);
   const cap=url.pathname==='/api/quick-start'||url.pathname==='/api/omp-sessions/resume'||url.pathname==='/api/enhance'||/^\/api\/sessions\/[^/]+\/command$/.test(url.pathname)?48*1024*1024:256*1024;
   const buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>cap)throw error(cap>256*1024?'This message is too large to upload: text and images together must stay under 48 MB. Remove some images and try again.':'Request body too large.',413);buffers.push(chunk);}let body;try{body=JSON.parse(Buffer.concat(buffers).toString());}catch{throw error('Invalid JSON.');}
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
   if(url.pathname==='/api/cli'){json(await runCli(body),202);return;}
   if(url.pathname==='/api/cli/stop'){const job=cliJobs.find(j=>j.id===body.id);if(!job)throw error('Command not found.',404);const child=cliProcs.get(job.id);if(child){job.stopped=true;child.kill();}json(job);return;}
   if(url.pathname==='/api/enhance'){json(await startEnhance(body),202);return;}
   if(url.pathname==='/api/enhance/settings'){if(!THINKING.includes(body.thinking))throw error('Unknown reasoning level.');store.enhanceThinking=body.thinking;await persist();json({thinking:store.enhanceThinking});return;}
   // The label is OMP's own account label from GET /api/accounts; OMP matches it when the next prompt pins the session.
   if(url.pathname==='/api/accounts'){const provider=text(body.provider,'Provider',100),account=text(body.account,'Account',300);if(/[\r\n]/.test(account))throw error('Invalid account.');store.accountChoices[provider]=account;await persist();json({provider,account});return;}
   if(url.pathname==='/api/terminal'){const dir=await resolveDir(body.path);await openTerminal(dir);json({path:dir});return;}
   if(url.pathname==='/api/screen/ticket'){
    if(!screenSupported)throw error('Screen sharing works when the companion runs on Windows.',409);
    if(!screenOn)throw screenOff();
    for(const [k,t] of screenTickets)if(t.expires<Date.now())screenTickets.delete(k);
    if(screenTickets.size>=20)throw error('Too many screen requests. Try again in a minute.',429);
    const ticket=randomBytes(32).toString('hex');screenTickets.set(ticket,{expires:Date.now()+30000,address:req.socket.remoteAddress});json({ticket});return;
   }
   // Pauses and saves sessions first, like a quit: the OS may kill this process before any signal handler runs.
   // If the OS refuses, the panel keeps working and the paused sessions can be continued.
   if(url.pathname==='/api/shutdown'){await shutdownPc();json({ok:true});return;}
   // Arms or cancels "Shut down PC when all work is done"; arming while nothing is working shuts down right away.
   if(url.pathname==='/api/shutdown/auto'){
    if(typeof body.on!=='boolean')throw error('Choose on or off.');
    if(autoShutdown.firing&&!body.on)throw error('The PC is already shutting down.',409);
    if(body.on&&!autoShutdown.on)Object.assign(autoShutdown,{on:true,since:now(),error:null});else if(!body.on)Object.assign(autoShutdown,{on:false,since:null});
    checkAutoShutdown();json(autoShutdownView());return;
   }
   // options.restart (start.bat's loop, see the entry point below) prepares the relaunch and returns the step that stops
   // this process; it runs once the reply is sent. Sessions are paused and saved first, as on quit.
   if(url.pathname==='/api/restart'){
    if(!options.restart)throw error('Restart works when the companion runs from start.bat, which starts it again. Stop it and start it yourself.',409);
    await pauseSessions();const relaunch=await options.restart();json({ok:true});if(relaunch)res.once('finish',()=>void relaunch());return;
   }
   // Composer drafts (debounced from every device); an empty text clears the view's draft.
   if(url.pathname==='/api/draft'){
    const key=typeof body.key==='string'&&/^(session|native):./.test(body.key)&&body.key.length<=4200?body.key:null;if(!key)throw error('Invalid draft key.');
    if(typeof body.text!=='string'||body.text.length>200000)throw error('Draft must be text under 200,000 characters.');
    if(body.text)store.drafts[key]={text:body.text,at:Date.now()};else delete store.drafts[key];
    // Oldest drafts go first past 200, so an abandoned pile cannot grow workspace.json without bound.
    const keys=Object.keys(store.drafts);if(keys.length>200)for(const k of keys.sort((a,b)=>store.drafts[a].at-store.drafts[b].at).slice(0,keys.length-200))delete store.drafts[k];
    scheduleSave();json({key,at:store.drafts[key]?.at??null});return;
   }
   if(url.pathname==='/api/editor'){if(!EDITOR_CHOICES.includes(body.editor))throw error('Unknown editor.');store.editor=body.editor;await persist();json({editor:store.editor});return;}
   // Open in editor: a file from a diff or tool call, relative paths resolved against the session folder.
   if(url.pathname==='/api/open-file'){
    let file=text(body.path,'File path',4000);const line=Number.isInteger(body.line)&&body.line>0?body.line:undefined;
    if(!path.isAbsolute(file)){if(typeof body.cwd!=='string'||!path.isAbsolute(body.cwd))throw error('Use an absolute file path.');file=path.resolve(body.cwd,file);}
    let stat;try{file=await fs.realpath(file);stat=await fs.stat(file);}catch{throw error('File does not exist on this machine.',404);}
    if(!stat.isFile())throw error('Path must be a file.');
    const editor=store.editor==='auto'?await detectEditor():store.editor;
    await (options.openExternal||openWithOs)(editor==='reveal'?file:editorUrl(EDITORS[editor],file,line),{reveal:editor==='reveal'});
    json({path:file,editor});return;
   }
   if(url.pathname==='/api/enhance/stop'){const job=enhanceJobs.get(body.id);if(!job)throw error('Enhance not found.',404);await stopEnhance(job);json({status:job.status});return;}
   if(url.pathname==='/api/omp-update'){
    if(updateState.status==='running')throw error('OMP update is already running.',409);
    updateState={status:'running',startedAt:now()};void runUpdate(updateState.startedAt);json(updateState,202);return;
   }
   if(url.pathname==='/api/quick-start'){
    const dir=await resolveDir(body.path);const images=chatImages(body);const raw=typeof body.prompt==='string'?body.prompt.trim().slice(0,200000):'';const p=await ensureProject(dir);
    const title=(typeof body.title==='string'&&body.title.trim().slice(0,120))||raw.split('\n')[0].slice(0,70)||`New session · ${p.name}`;
    const {selector,thinking}=modelChoice(body);const launch=await launchOptions(body.launch);
    if(body.autoApprove!==undefined&&typeof body.autoApprove!=='boolean')throw error('Auto-approve must be true or false.');
    const s=await createSession(p,{title,prompt:'',isolate:body.isolate===true,native:true,selector,thinking,launch,draft:body.draft===true});
    // A title cut from the prompt is a placeholder: OMP's RPC mode never auto-titles, so /rename asks it to (see event()).
    if(!(typeof body.title==='string'&&body.title.trim())&&!launch?.noTitle)s.autoTitle=true;
    if(typeof body.advisor==='boolean')await lock(s.id,()=>command(s,{type:'advisor',action:body.advisor?'on':'off'}));
    // Before the first prompt, so approval prompts from the first turn are already answered.
    if(body.autoApprove===true)await lock(s.id,()=>command(s,{type:'auto_approve',enabled:true}));
    if(body.fast===true)await lock(s.id,()=>command(s,{type:'pref',key:'fast',value:true})).catch(e=>notice(s,'warning',e.message));
    json(images.length||raw?await lock(s.id,()=>command(s,{type:'prompt',message:raw,images,preview:body.preview},images)):s,201);return;
   }
   if(url.pathname==='/api/omp-sessions/resume'){
    const file=sessionFileParam(body.file);const images=chatImages(body);const message=typeof body.message==='string'?body.message.trim().slice(0,200000):'';
    const submitted=!!message||body.images!==undefined;
    const existing=store.sessions.find(s=>s.sessionFile&&samePath(s.sessionFile,file));
    const gone=k=>k!=='f:'+file&&k!=='f:'+body.file;store.archived=store.archived.filter(gone);store.pinned=store.pinned.filter(gone);
    if(existing){existing.hidden=false;if(body.model||body.thinking)await lock(existing.id,()=>command(existing,{type:'set_model',model:body.model,thinking:body.thinking}));if(typeof body.advisor==='boolean')await lock(existing.id,()=>command(existing,{type:'advisor',action:body.advisor?'on':'off'}));json(submitted?await lock(existing.id,()=>command(existing,{type:existing.status==='running'?'follow_up':'prompt',message,images,preview:body.preview},images)):(await persist(),existing));return;}
    let head;try{head=await readSessionHead(file);}catch{throw error('Session file not found.',404);}
    if(!head.cwd||!await exists(head.cwd))throw error(`The session's working directory no longer exists: ${head.cwd||'unknown'}`);
    const p=await ensureProject(await resolveDir(head.cwd));const title=(head.title||head.preview.split('\n')[0]||'Resumed session').slice(0,120);
    const messages=await importMessages(file).catch(()=>[]);const contextTokens=await lastContext(file).catch(()=>undefined);messages.push({id:randomUUID(),role:'system',text:'Resumed from OMP session history. Avoid prompting it here while the same session is open in a terminal.',at:now()});
    const {selector,thinking}=modelChoice(body);const launch=await launchOptions(body.launch);const s=await createSession(p,{title,native:true,sessionFile:file,messages,selector,thinking,launch});s.contextTokens=contextTokens;
    if(!head.title&&!launch?.noTitle)s.autoTitle=true;
    // OMP resumes with the model saved in the transcript; show it until the runner reports its own state.
    if(!selector&&head.model?.includes('/')){const i=head.model.indexOf('/');s.provider=head.model.slice(0,i);s.model=head.model.slice(i+1);}if(!thinking&&head.thinking)s.thinking=head.thinking;
    if(typeof body.advisor==='boolean')await lock(s.id,()=>command(s,{type:'advisor',action:body.advisor?'on':'off'}));
    json(submitted?await lock(s.id,()=>command(s,{type:'prompt',message,images,preview:body.preview},images)):s,201);return;
   }
   if(url.pathname==='/api/archive'||url.pathname==='/api/pin'){
    const field=url.pathname==='/api/pin'?'pinned':'archived',other=field==='pinned'?'archived':'pinned',on=body[field]!==false;
    const key=typeof body.key==='string'?body.key:'';if(!/^[sf]:./.test(key)||key.length>4096)throw error('Invalid session key.');
    if(key.startsWith('s:')){const s=store.sessions.find(s=>s.id===key.slice(2));if(!s)throw error('Session not found.',404);
     if(field==='archived'&&on&&['running','queued'].includes(s.status))throw error('Stop the session before archiving it.');
     // Archiving a session that is ready for review completes it and stops its OMP process.
     if(field==='archived'&&on&&s.status==='review'){await lock(s.id,()=>command(s,{type:'complete'}));runners.get(s.id)?.kill();}}
    // Pinning and archiving exclude each other: setting one clears the other.
    const set=new Set(store[field]);if(on){set.add(key);store[other]=store[other].filter(k=>k!==key);}else set.delete(key);store[field]=[...set];await persist();json({archived:store.archived,pinned:store.pinned});return;
   }
   const match=url.pathname.match(/^\/api\/sessions\/([^/]+)\/command$/);
   // Answers, auto-approve, ghost text, side questions, subagent controls and read-only git views must get through while a command holds the lock.
   const unlocked=['answer','auto_approve','predict_word','predict_word_feedback','btw','btw_cancel','btw_history','subagent_cancel','subagent_steer','changes_worktree','worktree_status'];
   if(match){const s=store.sessions.find(s=>s.id===match[1]);if(!s)throw error('Session not found.',404);json(await(unlocked.includes(body.type)?command(s,body):lock(s.id,()=>command(s,body))));return;}
   throw error('Route not found.',404);
  }catch(e){json({error:e.message},e.status||500);}
 });
 // The screen WebSocket: same Host/Origin gate as every request, then a ticket that only the token could buy (POST /api/screen/ticket).
 server.on('upgrade',async(req,socket,head)=>{
  socket.on('error',()=>{});
  try{
   await checkOrigin(req);
   const url=new URL(req.url,'http://localhost');
   if(url.pathname!=='/api/screen/ws')throw error('Route not found.',404);
   if(closing)throw error('The companion is closing.',503);
   if(!screenOn)throw screenOff();
   const id=url.searchParams.get('ticket')||'',t=screenTickets.get(id);screenTickets.delete(id);
   if(!t||t.expires<Date.now()||t.address!==req.socket.remoteAddress)throw error('Screen ticket missing or expired. Open the Screen page again.',401);
   const key=String(req.headers['sec-websocket-key']||'');
   if(String(req.headers.upgrade).toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||!/^[A-Za-z0-9+/]{22}==$/.test(key))throw error('WebSocket handshake required.',400);
   socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`);
   startViewer(socket,head,req.socket.remoteAddress);
  }catch(e){const status=e.status||500;socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${e.message}`);}
 });
 // Every session stops as on quit: running ones become paused, the rest keep their status; workspace.json is saved.
 const pauseSessions=async()=>{pausing++;try{const stops=[...runners.values()].map(r=>new Promise(resolve=>{r.child.once('close',resolve);if(!r.stopping)r.kill();}));for(const s of store.sessions){finishWork(s);delete s._compacting;delete s.uiRequests;if(s.status==='running')s.status='paused';}await Promise.allSettled([...locks.values()]);await persist();await Promise.all(stops);}finally{pausing--;}};
 const shutdownPc=async()=>{await pauseSessions();await (options.shutdownHost||shutdownHost)();};
 // Work left: a running or queued turn, or a compaction/handoff/shell command in progress. Queued messages of a running
 // session are covered by its status (and by the session lock while settle() dispatches them); those of a stopped session
 // only go out with the user's next message, so they must not hold the shutdown forever. The panel's isWorking matches.
 const workPending=()=>store.sessions.some(s=>['running','queued'].includes(s.status)||s._task||s._bash);
 // Runs after every settled turn and every background refresh (which catches stops, failures and exits). A held lock or a
 // starting runner means a prompt is mid-flight, so it waits for the next check. Fires at most once per arming.
 function checkAutoShutdown(){
  if(!autoShutdown.on||autoShutdown.firing||closing||pausing||locks.size||launches.size||workPending())return;
  autoShutdown.firing=true;
  void shutdownPc().catch(e=>{autoShutdown.error={message:e.message,at:now()};console.error('Automatic shutdown failed:',e.message);}).finally(()=>Object.assign(autoShutdown,{on:false,since:null,firing:false}));
 }
 // The screen viewer goes first: an open WebSocket would keep server.close() waiting forever.
 const close=async()=>{closing=true;clearInterval(refreshTimer);clearTimeout(accountTimer);dropViewer(1001,'The companion is closing.');for(const c of cliProcs.values())c.kill();clearTimeout(eventSaveTimer);const enhanceStops=stopAllEnhance();const probeStops=[...commandProbes].map(r=>new Promise(resolve=>{r.child.once('close',resolve);if(!r.stopping)r.kill();}));const sessionStops=pauseSessions();await new Promise(r=>{server.close(r);server.closeAllConnections();});await sessionStops;await Promise.all(probeStops);await enhanceStops;};
 // Drafts left by a closed tab or a crash: the in-tab draft text is gone, so the session would come back empty.
 for(const s of store.sessions.filter(x=>x.draft))await discardDraft(s).catch(e=>console.error('Draft cleanup failed:',e.message));
 // A rate-limit resume saved before a restart: re-armed; one already due fires right away.
 for(const s of store.sessions)if(s.rateLimitResume)armResume(s);
// closeScreen: the desktop host rebinds the server (LAN toggle), which an open screen WebSocket would block; the viewer reconnects if still allowed.
await persist();return {server,store,token,password:Boolean(password),close,flush:()=>saveChain,setScreen,closeScreen:()=>dropViewer(1001,'The companion changed its network access.')};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.OMP_WEB_PORT||4545);const host=process.env.OMP_WEB_HOST||'127.0.0.1';const wild=host==='0.0.0.0'||host==='::';
 const inUse=`\nPort ${port} is already in use: the companion is probably already running at http://127.0.0.1:${port}/\nClose it, or set OMP_WEB_PORT to use another port.\n`;
 // Probe before createCompanion: it pauses running sessions and saves workspace.json, which would clobber the live companion's state.
 if(await portBusy(port)){console.error(inUse);process.exit(1);}
 // start.bat sets OMP_WEB_RESTART_EXIT and starts the companion again when it exits with that code (Restart companion).
 const restartExit=Number(process.env.OMP_WEB_RESTART_EXIT)||0;
 const handoffFile=path.join(process.env.OMP_WEB_DATA_DIR||path.join(os.homedir(),'.omp-web'),'restart.json');
 let handoff=null;
 if(restartExit){handoff=restartHandoff(await fs.readFile(handoffFile,'utf8').catch(()=>''),Date.now());await fs.rm(handoffFile,{force:true});}
 // A restart skips the OMP update check (Settings has one-click omp update) and keeps the token, so open panels reconnect.
 if(!handoff)await startupUpdate();
 const app=await createCompanion({
  ...(handoff?.token&&!process.env.OMP_WEB_PASSWORD?{token:handoff.token}:{}),
  ...(restartExit?{restart:async()=>{
   // A password is the token, so only a random per-launch token is handed over; it never outlives the restart.
   await fs.mkdir(path.dirname(handoffFile),{recursive:true,mode:0o700});
   await fs.writeFile(handoffFile,JSON.stringify({at:Date.now(),...(app.password?{}:{token:app.token})}),{mode:0o600});
   // Exit with the restart code even if close() fails, so start.bat still starts the companion again.
   return async()=>{try{await app.close();}finally{process.exit(restartExit);}};
  }}:{}),
  // Remote control should never be silent on the PC itself.
  onScreen:v=>console.log(v?`Screen: ${v.address} is now viewing and controlling this PC.`:'Screen: the viewer disconnected.'),
 });
 app.server.listen(port,host,async()=>{
  // The token travels in the URL fragment, which browsers never send to the server or in Referer headers. A password is never printed.
  const frag=process.env.OMP_WEB_NO_TOKEN==='1'||app.password?'':`#token=${app.token}`;
  const link=`http://${wild?'127.0.0.1':host}:${port}/${frag}`;
  const lan=wild?Object.values(os.networkInterfaces()).flat().filter(n=>n.family==='IPv4'&&!n.internal).map(n=>`http://${n.address}:${port}/${frag}`):[];
  const extra=String(process.env.OMP_WEB_PUBLIC_HOSTS||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean).map(h=>`http://${h}:${port}/${frag}`);
  // This PC's MagicDNS name works without OMP_WEB_PUBLIC_HOSTS while the companion listens on its tailnet address.
  const ts=wild||tailnetAddress(host)?await tailscaleSelf():null;
  const tailnet=ts?.name&&(wild||ts.ips.includes(host))?[`http://${ts.name}:${port}/${frag}`]:[];
  const auth=app.password?'Password required (OMP_WEB_PASSWORD).\n':frag?`Connection token: ${app.token}\n`:'No token required: anyone who can reach this port has full control.\n';
  const screen=process.env.OMP_WEB_SCREEN!=='1'?'':process.platform==='win32'?'Screen sharing is on (OMP_WEB_SCREEN=1): the password or token also lets a device see and control this PC.\n':'OMP_WEB_SCREEN is ignored: screen sharing works on Windows only.\n';
  console.log(`\nOMP Control Room\n\nOpen: ${link}\n${lan.map(l=>`LAN:  ${l}\n`).join('')}${tailnet.map(l=>`Tailscale: ${l}\n`).join('')}${extra.map(l=>`Host: ${l}\n`).join('')}${auth}${screen}\nYour provider credentials remain in OMP. Keep this process running.\n`);
  // After a restart the dashboard that asked for it reconnects by itself, so no second browser tab.
  if(!process.env.OMP_WEB_NO_OPEN&&!handoff){const [cmd,args]=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',link]]:process.platform==='darwin'?['open',[link]]:['xdg-open',[link]];execFile(cmd,args,{windowsHide:true},()=>{});}
 });
 app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?inUse:`\nThe companion could not start: ${e.message}\n`);process.exit(1);});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
