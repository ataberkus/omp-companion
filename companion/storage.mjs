// Disk use of isolated sessions' worktrees (Tools › Disk space): each worktree's size with what git tracks split from
// ignored and untracked output (node_modules, target/), its git state, and folders under <dataDir>/worktrees that no
// session uses any more. Cleanup runs only when asked: removing a worktree (folder and omp-web/ branch, as Finish
// worktree › Delete does), removing an orphan folder, or deleting a worktree's ignored files while keeping it.
// Walking 100+ GB of worktrees takes minutes, so scans and cleanups run one at a time in the background and the page
// polls GET /api/storage, which only returns what the last run found; dashboard polls of /api/state never measure.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exists, now, error, samePath } from './util.mjs';
import { git, gitRun, removeWorktreeFolder } from './git.mjs';
const CLEAN_TIMEOUT=10*60000;
export function createStorage(ctx){
 const {store,dataDir}=ctx;
 const worktreeStatus=(...args)=>ctx.worktreeStatus(...args);
 const deleteWorktree=(...args)=>ctx.deleteWorktree(...args);
 const worktreesDir=path.join(dataDir,'worktrees');
 const state={scannedAt:null,worktrees:[],orphans:[],results:[],error:''};
 let job=null,run=null;
 const busy=s=>['running','queued'].includes(s.status)||!!s._task||!!s._bash;
 const listed=s=>s.isolated&&s.branch?.startsWith('omp-web/')&&!s.worktreeRemoved;
 // Archived, hidden or done, nothing uncommitted and every commit already in the project's branch: removing loses nothing.
 const safe=r=>!r.error&&!r.busy&&(r.archived||r.hidden||r.status==='done')&&!r.dirty&&r.ahead===0&&!!r.base;
 // Bytes of every file under dir, symlinks and junctions not followed (a linked node_modules would count twice).
 // tracked: bytes of the files `git ls-files` lists (null outside git); linked: bytes of hardlinked files (a package
 // manager's store can share them), which deleting this folder alone does not free.
 async function measure(dir){
  let files=null;try{files=new Set((await gitRun(dir,['ls-files','-z'],{timeout:60000,maxBuffer:256*1024*1024})).split('\0').filter(Boolean));}catch{}
  let bytes=0,tracked=0,linked=0;const stack=[['',dir]];
  while(stack.length&&!ctx.closing){
   const [rel,abs]=stack.pop();
   const names=await fs.readdir(abs).catch(()=>[]);
   // A few lstats at a time: the libuv pool they share also serves saves and static files.
   for(let i=0;i<names.length;i+=16)await Promise.all(names.slice(i,i+16).map(async name=>{
    const r=rel?rel+'/'+name:name,p=path.join(abs,name);const st=await fs.lstat(p).catch(()=>null);
    if(!st||st.isSymbolicLink())return;
    if(st.isDirectory()){stack.push([r,p]);return;}
    if(!st.isFile())return;
    bytes+=st.size;if(files?.has(r))tracked+=st.size;if(st.nlink>1)linked+=st.size;
   }));
  }
  return {bytes,tracked:files?tracked:null,linked};
 }
 async function sessionRow(s){
  const p=store.projects.find(x=>x.id===s.projectId);
  const row={id:s.id,title:s.title,project:p?.name||'',cwd:s.cwd,branch:s.branch,status:s.status,archived:store.archived.includes('s:'+s.id),hidden:!!s.hidden,busy:busy(s)};
  try{const st=await worktreeStatus(s);Object.assign(row,{exists:st.exists,base:st.base,ahead:st.ahead,behind:st.behind,dirty:st.dirty});}
  catch(e){Object.assign(row,{error:e.message,exists:await exists(s.cwd)});}
  Object.assign(row,row.exists?await measure(s.cwd):{bytes:0,tracked:0,linked:0});
  row.safe=safe(row);return row;
 }
 // The repository a worktree folder belongs to, from its .git file (gitdir: <repo>/.git/worktrees/<name>), and the branch
 // it has checked out. root is null when that repository is gone (or bare); registered is false once git pruned its record.
 async function folderRepo(dir){
  const m=/^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(path.join(dir,'.git'),'utf8').catch(()=>''));
  if(!m)return {root:null,branch:'',registered:false};
  const gitdir=path.resolve(dir,m[1]);
  const common=path.resolve(gitdir,(await fs.readFile(path.join(gitdir,'commondir'),'utf8').catch(()=>'../..')).trim());
  const root=path.basename(common)==='.git'&&await exists(common)?path.dirname(common):null;
  const branch=/^ref: refs\/heads\/(.+)$/m.exec(await fs.readFile(path.join(gitdir,'HEAD'),'utf8').catch(()=>''))?.[1]||'';
  return {root,branch,registered:await exists(gitdir)};
 }
 // A worktree folder no listed session works in: one under <dataDir>/worktrees no session points to (kind 'unknown'), or
 // one whose session had its worktree removed while Windows held the folder (kind 'removed'). null when it is gone, in
 // use, being created, or not one of those.
 const removedOwner=dir=>store.sessions.find(s=>s.worktreeRemoved&&s.isolated&&s.branch?.startsWith('omp-web/')&&samePath(s.cwd,dir));
 async function orphanInfo(dir){
  dir=path.resolve(dir);
  if(!samePath(path.dirname(dir),worktreesDir)&&!removedOwner(dir))return null;
  if(!await fs.stat(dir).then(st=>st.isDirectory(),()=>false))return null;
  if([...ctx.creatingWorktrees].some(w=>samePath(w,dir)))return null;
  const owners=store.sessions.filter(s=>samePath(s.cwd,dir));
  if(owners.some(s=>!s.worktreeRemoved))return null;
  const s=owners[0],repo=await folderRepo(dir);
  const root=(s&&store.projects.find(p=>p.id===s.projectId)?.path)||repo.root;
  const dirty=repo.registered?await gitRun(dir,['status','--porcelain'],{timeout:15000}).then(o=>o.split('\n').filter(Boolean).length,()=>null):null;
  return {dir,name:path.basename(dir),kind:s?'removed':'unknown',...(s?{sessionId:s.id,title:s.title}:{}),root:root&&await exists(root)?root:null,branch:repo.branch,dirty};
 }
 const orphanDirs=async()=>{
  const under=(await fs.readdir(worktreesDir,{withFileTypes:true}).catch(()=>[])).filter(e=>e.isDirectory()).map(e=>path.join(worktreesDir,e.name));
  return [...under,...store.sessions.filter(s=>s.worktreeRemoved&&!under.some(d=>samePath(d,s.cwd))).map(s=>s.cwd)];
 };
 function start(kind,total,work){
  if(job)throw error(`Wait for the current ${job.kind==='scan'?'scan':'cleanup'} to finish.`,409);
  job={kind,done:0,total,startedAt:now()};state.results=[];state.error='';
  run=(async()=>{try{await work(job);}catch(e){state.error=e.message;}finally{job=null;}})();
  return view();
 }
 const view=()=>({job,...state});
 function scan(){
  return start('scan',0,async j=>{
   const sessions=store.sessions.filter(listed),folders=await orphanDirs();
   j.total=sessions.length+folders.length;
   const worktrees=[],orphans=[];state.worktrees=worktrees;state.orphans=orphans;
   for(const s of sessions){if(ctx.closing)return;worktrees.push(await sessionRow(s));j.done++;}
   for(const dir of folders){if(ctx.closing)return;const o=await orphanInfo(dir);if(o)orphans.push({...o,...await measure(o.dir)});j.done++;}
   state.scannedAt=now();
  });
 }
 const lostWork=st=>[st.dirty?`${st.dirty} uncommitted ${st.dirty===1?'change':'changes'}`:'',st.ahead?`${st.ahead} ${st.ahead===1?'commit':'commits'} not in ${st.base}`:'',st.base?'':`commits ${st.root} cannot be compared with (it is not on a branch)`].filter(Boolean);
 async function removeSession(id,confirm){
  const s=store.sessions.find(x=>x.id===id);
  if(!s)throw error('Session not found.',404);
  if(s.worktreeRemoved)return;
  if(busy(s))throw error('Wait for OMP to finish first.',409);
  const st=await worktreeStatus(s);
  const lost=lostWork(st);
  if(lost.length&&!confirm)throw error(`${s.branch} has ${lost.join(' and ')}, which removing it would lose. Confirm to remove it anyway.`,409);
  await deleteWorktree(s,st.root);
 }
 async function removeOrphan(dir,confirm){
  const o=await orphanInfo(dir);
  if(!o){if(!await exists(dir))return;throw error('A session uses this folder now.',409);}
  if(o.dirty&&!confirm)throw error(`${o.name} has ${o.dirty} uncommitted ${o.dirty===1?'change':'changes'}, which removing it would lose. Confirm to remove it anyway.`,409);
  // Branches stay: with no session to say which work they hold, deleting one could lose commits.
  if(o.root){
   if(!await removeWorktreeFolder(o.dir,o.root))throw error('Windows still holds the worktree folder. Close programs using it and try again.',409);
   await git(o.root,['worktree','prune']).catch(()=>{});
  }else await fs.rm(o.dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});
  if(await exists(o.dir))throw error('Windows still holds the worktree folder. Close programs using it and try again.',409);
 }
 const list=(v,what)=>{if(v===undefined)return [];if(!Array.isArray(v)||v.length>1000||v.some(x=>typeof x!=='string'||!x||x.length>4096))throw error(`${what} must be a list of strings.`);return [...new Set(v)];};
 // sessions: session IDs whose worktree and omp-web/ branch go; orphans: folder paths from the scan's orphans.
 // Without confirm, any with uncommitted changes or commits the project's branch lacks is refused instead.
 function remove({sessions,orphans,confirm}={}){
  const ids=list(sessions,'sessions'),dirs=list(orphans,'orphans').map(d=>path.isAbsolute(d)?path.resolve(d):'');
  if(dirs.some(d=>!d||(!samePath(path.dirname(d),worktreesDir)&&!removedOwner(d))))throw error('orphans must be worktree folders the scan listed.');
  if(!ids.length&&!dirs.length)throw error('Choose worktrees to remove.');
  return start('remove',ids.length+dirs.length,async j=>{
   const done=(key,rows,match,e)=>{const row=rows.find(match);state.results.push(e?{key,ok:false,error:e.message}:{key,ok:true,freed:row?.bytes||0});if(!e&&row)rows.splice(rows.indexOf(row),1);j.done++;};
   for(const id of ids){if(ctx.closing)return;try{await removeSession(id,confirm===true);done(id,state.worktrees,r=>r.id===id);}catch(e){done(id,state.worktrees,r=>r.id===id,e);}}
   for(const d of dirs){if(ctx.closing)return;try{await removeOrphan(d,confirm===true);done(d,state.orphans,r=>samePath(r.dir,d));}catch(e){done(d,state.orphans,r=>samePath(r.dir,d),e);}}
  });
 }
 // `git clean -fdX`: deletes only what .gitignore matches (dependencies, build output, also ignored local files such as
 // .env) in each worktree; tracked and untracked work, the folder and the branch stay. Re-measures each one.
 function clean({sessions}={}){
  const ids=list(sessions,'sessions');
  if(!ids.length)throw error('Choose worktrees to clean.');
  return start('clean',ids.length,async j=>{
   for(const id of ids){
    if(ctx.closing)return;
    try{
     const s=store.sessions.find(x=>x.id===id);
     if(!s||!listed(s))throw error('Only sessions in their own worktree can be cleaned this way.',409);
     if(busy(s))throw error('Wait for OMP to finish first.',409);
     if(!await exists(s.cwd))throw error('The worktree folder no longer exists.',409);
     const before=state.worktrees.find(r=>r.id===id)?.bytes;
     await gitRun(s.cwd,['clean','-fdX'],{timeout:CLEAN_TIMEOUT});
     const row=await sessionRow(s),i=state.worktrees.findIndex(r=>r.id===id);
     if(i>=0)state.worktrees[i]=row;
     state.results.push({key:id,ok:true,freed:before===undefined?0:Math.max(0,before-row.bytes)});
    }catch(e){state.results.push({key:id,ok:false,error:e.message});}
    j.done++;
   }
  });
 }
 return {storageView:view,scanStorage:scan,removeWorktrees:remove,cleanWorktrees:clean,get storageRun(){return run;}};
}
