// OMP's own session history: the sessions folder, listing and validating its files, and a session's background
// jobs and subagents.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { error, text, samePath, replaceFile } from './util.mjs';
import { scanJobs, readSessionHead, cleanTitle } from './transcript.mjs';
export function createHistory(ctx){
 const {options,store}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const transcriptCost=(...args)=>ctx.transcriptCost(...args);
 const ompSessionsDir=path.resolve(options.ompSessionsDir||process.env.OMP_SESSIONS_DIR||path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent'),'sessions'));
 // Heads of OMP's session files by path, read again when a file's mtime or size moves. By path, not path+mtime: a transcript
 // that keeps growing replaces its entry instead of adding one per listing (every dashboard lists every 20 s, so a
 // long-running companion grew this without bound); files that left the folder drop theirs.
 const headCache=new Map();
 // Also kept on disk (dataDir/omp-session-heads.json): reading 1,400 heads from a cold disk took 40 s at start-up, while
 // reading only the files that changed since the last run costs little more than the listing's stats. Keyed by version and
 // sessions folder, so a head with other fields or another folder reads every file again.
 const headsFile=ctx.dataDir&&path.join(ctx.dataDir,'omp-session-heads.json'),HEADS_V=1;let headsDirty=false,headsTimer,headsWrite,headsClosed=false;
 // final: the companion is closing; later reads (a warm-up still running) stay in memory.
 async function flushHeads(final){if(final)headsClosed=true;clearTimeout(headsTimer);headsTimer=undefined;await headsWrite;if(!headsDirty||!headsFile)return;headsDirty=false;
  const tmp=`${headsFile}.${process.pid}.tmp`;headsWrite=(async()=>{try{await fs.writeFile(tmp,JSON.stringify({v:HEADS_V,dir:ompSessionsDir,heads:Object.fromEntries(headCache)}),{mode:0o600});await replaceFile(tmp,headsFile);}catch{await fs.rm(tmp,{force:true}).catch(()=>{});}})();await headsWrite;}
 const saveHeads=()=>{headsDirty=true;if(!headsFile||headsTimer||headsClosed)return;headsTimer=setTimeout(()=>void flushHeads(),5000);headsTimer.unref?.();};
 async function loadHeads(){if(!headsFile)return;let d;try{d=JSON.parse(await fs.readFile(headsFile,'utf8'));}catch{return;}
  if(d?.v!==HEADS_V||d.dir!==ompSessionsDir||!d.heads||typeof d.heads!=='object')return;
  for(const [f,c] of Object.entries(d.heads))if(typeof c?.mtime==='number'&&typeof c.size==='number'&&c.head&&typeof c.head==='object'&&!headCache.has(f))headCache.set(f,c);}
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
 // Every session file of every project folder, newest first (ties by path, so identical polls give identical ETags);
 // `limit` keeps the newest that many for callers that want a few (the folder picker's recent list).
 async function readNativeSessions(limit=Infinity){
  const files=[];let dirs=[];try{dirs=await fs.readdir(ompSessionsDir,{withFileTypes:true});}catch{return [];}
  await Promise.all(dirs.filter(d=>d.isDirectory()).map(async d=>{const dir=path.join(ompSessionsDir,d.name);let entries=[];try{entries=await fs.readdir(dir);}catch{return;}
   await Promise.all(entries.filter(n=>n.endsWith('.jsonl')).map(async n=>{const file=path.join(dir,n);try{const st=await fs.stat(file);if(st.size>0)files.push({file,mtime:st.mtimeMs,size:st.size});}catch{}}));}));
  const found=new Set(files.map(f=>f.file));for(const f of headCache.keys())if(!found.has(f)){headCache.delete(f);saveHeads();}
  files.sort((a,b)=>b.mtime-a.mtime||(a.file<b.file?-1:a.file>b.file?1:0));
  // Panel sessions by file, built once: matching each file against every session cost files × sessions path resolutions.
  // A hidden session (one the panel dropped) gives way to a visible one on the same file, which the dashboard merges the
  // row into; otherwise the file showed twice, as the visible panel session and as a history row.
  const managed=new Map();for(const s of store.sessions)if(s.sessionFile){const k=pathKey(s.sessionFile),had=managed.get(k);if(!had||(had.hidden&&!s.hidden))managed.set(k,s);}
  // Files by path key, for fork parents: OMP's header spells the parent's path its own way.
  const byKey=new Map(files.map(f=>[pathKey(f.file),f.file])),shown=head=>head.title||cleanTitle(head.preview).slice(0,80)||'Untitled session';
  const one=async f=>{
   let c=headCache.get(f.file);
   if(c?.mtime!==f.mtime||c.size!==f.size){let head;try{head=await readSessionHead(f.file);}catch{return null;}
    // No session header yet: OMP is still writing the file's first lines. Left out, and read again on the next listing.
    if(!head.id)return null;c={mtime:f.mtime,size:f.size,head};headCache.set(f.file,c);saveHeads();}
   const head=c.head,managedSession=managed.get(pathKey(f.file));
   const row={file:f.file,title:shown(head),named:!!head.title,cwd:head.cwd,id:head.id,preview:head.preview,createdAt:head.createdAt,updatedAt:new Date(f.mtime).toISOString(),size:f.size,managedId:managedSession?.id,model:head.model,thinking:head.thinking};
   if(head.parent){const pf=byKey.get(pathKey(head.parent)),ph=pf&&headCache.get(pf)?.head;row.parent=pf||head.parent;row.parentTitle=ph?shown(ph):path.basename(head.parent,'.jsonl');}
   return row;
  };
  // 32 heads at a time: a first listing reads every file's head and tail (up to 320 KB each), and 1,500 files' reads at
  // once held all of that in memory together.
  const list=Number.isFinite(limit)?files.slice(0,limit):files,rows=[];for(let i=0;i<list.length;i+=32)rows.push(...await Promise.all(list.slice(i,i+32).map(one)));
  // A parent read later in the same pass than its fork (forks are newer, so listed first) gets its title now.
  const titles=new Map(rows.filter(Boolean).map(r=>[r.file,r.title]));for(const r of rows)if(r?.parent&&titles.has(r.parent))r.parentTitle=titles.get(r.parent);
  return rows.filter(Boolean);
 }
 // The first listing reads every head the disk copy lacks (the first dashboard load's path), so it starts with the
 // companion; a request meanwhile waits for it rather than reading the same heads again, then lists from the cache.
 let warming=loadHeads().then(()=>readNativeSessions()).catch(()=>{});
 const listNativeSessions=async limit=>{if(warming){await warming;warming=undefined;}return readNativeSessions(limit);};
 return {background,sessionFileParam,ompSessionsDir,insideSessions,listNativeSessions,flushHeads};
}
