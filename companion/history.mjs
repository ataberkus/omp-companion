// OMP's own session history: the sessions folder, listing and validating its files, and a session's background
// jobs and subagents.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { error, text, samePath } from './util.mjs';
import { scanJobs, readSessionHead } from './transcript.mjs';
export function createHistory(ctx){
 const {options,store}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const transcriptCost=(...args)=>ctx.transcriptCost(...args);
 const ompSessionsDir=path.resolve(options.ompSessionsDir||process.env.OMP_SESSIONS_DIR||path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent'),'sessions'));
 // Heads of OMP's session files by path, read again when a file's mtime or size moves. By path, not path+mtime: a transcript
 // that keeps growing replaces its entry instead of adding one per listing (every dashboard lists every 20 s, so a
 // long-running companion grew this without bound); files that left the folder drop theirs.
 const headCache=new Map();
 // Subagent transcripts' heads and results (.md) by folder, then name, each read again when its own file's mtime or size
 // moves: every dashboard viewing a live session calls background() every 3 s, and it read and parsed 320 KB of every
 // subagent transcript each time. A folder's entries are rebuilt from its listing, so files that left drop theirs; the
 // 32 folders viewed last are kept. A failed read is not kept, so the next call tries again.
 const subagentCache=new Map();
 const pathKey=p=>{const r=path.resolve(p);return process.platform==='win32'?r.toLowerCase():r;};
 const insideSessions=(value,exts)=>{const file=path.resolve(text(value,'File',4000));const rel=path.relative(ompSessionsDir,file);if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||!exts.some(x=>file.endsWith(x)))throw error('Not an OMP session file.');return file;};
 // `liveSince`: when the jobs still running now started at the earliest. Async jobs die with the OMP process that spawned them,
 // so a job from before it is not running even though its transcript never recorded an end. Infinity: a companion session
 // with no OMP process has none running. Undefined (a file the companion does not run): fall back to transcript quiet time.
 async function background(file,liveSince,registry=[]){
  const dir=file.replace(/\.jsonl$/,'');const scanned=await scanJobs(file);let entries=[];try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{}
  const subagents=[],jobs=[],known=subagentCache.get(dir),seen=new Map();
  await Promise.all(entries.filter(e=>e.isFile()).map(async e=>{const f=path.join(dir,e.name);let st;try{st=await fs.stat(f);}catch{return;}
   if(e.name.endsWith('.jsonl')){const name=e.name.slice(0,-6),md=path.join(dir,name+'.md');let c=known?.get(name);
    if(!c?.head||c.mtime!==st.mtimeMs||c.size!==st.size){let head;try{head=await readSessionHead(f);}catch{}c={mtime:st.mtimeMs,size:st.size,head,md:c?.md};}
    const ms=await fs.stat(md).catch(()=>null);let r=ms&&c.md?.mtime===ms.mtimeMs&&c.md.size===ms.size?c.md:undefined;
    if(ms&&!r)try{r={mtime:ms.mtimeMs,size:ms.size,result:(await fs.readFile(md,'utf8')).slice(0,4000)};}catch{}
    c={...c,md:r};seen.set(name,c);const head=c.head||{},result=r?.result||'';
    subagents.push({name,file:f,size:st.size,startedAt:head.createdAt||'',updatedAt:st.mtime.toISOString(),model:head.model||'',thinking:head.reasoning||'',preview:head.preview||'',result,cost:await transcriptCost(f,st),advisor:name==='__advisor'||name.startsWith('__advisor.')});}
   else if(e.name.endsWith('.async.log')){jobs.push({name:e.name,file:f,size:st.size,updatedAt:st.mtime.toISOString()});}
  }));
  subagentCache.delete(dir);if(seen.size){subagentCache.set(dir,seen);if(subagentCache.size>32)subagentCache.delete(subagentCache.keys().next().value);}
  // Names break ties: the lists fill in completion order, and an order that changes between identical polls changes the ETag.
  subagents.sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||(a.name<b.name?-1:a.name>b.name?1:0));jobs.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||(a.name<b.name?-1:a.name>b.name?1:0));
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
 async function readNativeSessions(limit=200){
  const files=[];let dirs=[];try{dirs=await fs.readdir(ompSessionsDir,{withFileTypes:true});}catch{return [];}
  await Promise.all(dirs.filter(d=>d.isDirectory()).map(async d=>{const dir=path.join(ompSessionsDir,d.name);let entries=[];try{entries=await fs.readdir(dir);}catch{return;}
   await Promise.all(entries.filter(n=>n.endsWith('.jsonl')).map(async n=>{const file=path.join(dir,n);try{const st=await fs.stat(file);if(st.size>0)files.push({file,mtime:st.mtimeMs,size:st.size});}catch{}}));}));
  const found=new Set(files.map(f=>f.file));for(const f of headCache.keys())if(!found.has(f))headCache.delete(f);
  files.sort((a,b)=>b.mtime-a.mtime||(a.file<b.file?-1:a.file>b.file?1:0));
  // Panel sessions by file, built once: matching each of up to 200 files against every session cost files × sessions path resolutions.
  const managed=new Map();for(const s of store.sessions)if(s.sessionFile){const k=pathKey(s.sessionFile);if(!managed.has(k))managed.set(k,s);}
  return (await Promise.all(files.slice(0,limit).map(async f=>{
   let c=headCache.get(f.file);if(c?.mtime!==f.mtime||c.size!==f.size){try{c={mtime:f.mtime,size:f.size,head:await readSessionHead(f.file)};}catch{return null;}headCache.set(f.file,c);}
   const head=c.head,managedSession=managed.get(pathKey(f.file));
   return {file:f.file,title:head.title||head.preview.split('\n')[0].slice(0,80)||'Untitled session',cwd:head.cwd,id:head.id,preview:head.preview,createdAt:head.createdAt,updatedAt:new Date(f.mtime).toISOString(),size:f.size,managedId:managedSession?.id,model:head.model,thinking:head.thinking};
  }))).filter(Boolean);
 }
 // The first listing reads up to 200 heads (~125 ms for 150 files) on the first dashboard load's path, so it starts with
 // the companion; a request meanwhile waits for it rather than reading the same heads again, then lists from the cache.
 let warming=readNativeSessions().catch(()=>{});
 const listNativeSessions=async limit=>{if(warming){await warming;warming=undefined;}return readNativeSessions(limit);};
 return {background,sessionFileParam,ompSessionsDir,insideSessions,listNativeSessions};
}
