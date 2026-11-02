// Workspaces (projects) and the sessions in them: colours, branches, creating and discarding sessions, finishing
// isolated worktrees, overlapping edits, and the folder browser.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { exists, now, error, samePath, resolveDir } from './util.mjs';
import { importMessages } from './transcript.mjs';
import { git, gitRun, currentBranch, addWorktree, removeWorktree } from './git.mjs';
// Project colours: hues spread around the wheel at one lightness/chroma, readable on dark and light surfaces.
export const colors=['oklch(.74 .14 50)','oklch(.72 .13 265)','oklch(.74 .12 165)','oklch(.7 .15 310)','oklch(.78 .13 95)','oklch(.7 .14 20)','oklch(.74 .11 215)','oklch(.72 .15 135)','oklch(.7 .14 345)','oklch(.74 .1 240)'];
export const projectColor=v=>typeof v==='string'&&(/^#[0-9a-f]{6}$/i.test(v)||/^oklch\(\s*[\d.]+%?\s+[\d.]+\s+[\d.]+\s*\)$/.test(v))?v:null;
export function createWorkspaces(ctx){
 const {command,append,store,dataDir,activity,persist,scheduleSave,unreadEdits,runners,enhanceJobs,stopEnhance,dropDraft}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const listNativeSessions=(...args)=>ctx.listNativeSessions(...args);
 async function ensureProject(dir,name){
  let p=store.projects.find(p=>samePath(p.path,dir));if(p)return p;
  const branch=await currentBranch(dir);
  // The least-used colour, first in palette order on ties, so neighbours in the sidebar rarely share one.
  const used=c=>store.projects.filter(x=>x.color===c).length,color=colors.reduce((a,c)=>used(c)<used(a)?c:a,colors[0]);
  p={id:randomUUID(),name:String(name||'').trim().slice(0,80)||path.basename(dir)||dir,path:dir,description:'',branch,color};store.projects.push(p);activity(null,`Added project ${p.name}`);return p;
 }
 // The branch checked out in a project folder, read again from git: `git checkout` outside the panel changes it. Sessions
 // working directly in the folder (not in their own worktree) carry the same branch. True when anything changed.
 async function refreshBranch(p){
  if(!await exists(p.path))return false;
  const branch=await currentBranch(p.path);let changed=false;
  if(p.branch!==branch){p.branch=branch;changed=true;}
  for(const s of store.sessions)if(s.projectId===p.id&&!s.isolated&&s.branch!==branch){s.branch=branch;changed=true;}
  return changed;
 }
 // At most every 15 s, from dashboard polls; never blocks the poll, and saves only when a branch changed.
 // close() awaits the run in flight: a git child still sitting in a project folder holds it open on Windows.
 let branchesAt=0,branchRun=null;
 function refreshBranches(){
  if(ctx.closing||Date.now()-branchesAt<15000)return;branchesAt=Date.now();
  branchRun=Promise.all(store.projects.filter(p=>!p.hidden).map(p=>refreshBranch(p).catch(()=>false))).then(r=>{if(r.some(Boolean)&&!ctx.closing)scheduleSave([],true);});
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
  if(prompt)await command(s,{type:'prompt',message:prompt});else await persist(s);return s;
 }
 const sent=s=>s.messages.some(m=>m.role==='user'||m.id?.startsWith('tool-bash-'))||!!s.queuedMessages?.length;
 // Removes an Enhance-created session nobody sent anything to: enhance job, OMP process (awaited), its empty
 // session file, and its isolated worktree and branch. A worktree Windows still holds stays recorded for next startup.
 async function discardDraft(s){
  if(!s.draft||sent(s))return {discarded:false};
  // OMP's transcript is the truth: after a crash mid first send, workspace.json can still say draft with no messages.
  const recorded=s.sessionFile?(await importMessages(s.sessionFile).catch(()=>[])).some(m=>m.role==='user'):false;
  if(recorded){delete s.draft;await persist(s);return {discarded:false};}
  await Promise.allSettled([...enhanceJobs.values()].filter(j=>j.sessionId===s.id).map(stopEnhance));
  await stopRunner(s);
  // rmdir (not rm -r) only succeeds on an empty folder, so OMP's other sessions for the same cwd are never touched.
  if(s.sessionFile){await fs.rm(s.sessionFile,{force:true}).catch(()=>{});await fs.rmdir(path.dirname(s.sessionFile)).catch(()=>{});}
  let removed=true;
  const root=store.projects.find(p=>p.id===s.projectId)?.path;
  if(s.isolated&&root&&s.branch?.startsWith('omp-web/')){removed=await removeWorktree(s,root);if(!removed)console.error(`Could not remove draft worktree ${s.cwd}; will retry on next start.`);}
  if(removed){const i=store.sessions.indexOf(s);if(i>=0)store.sessions.splice(i,1);store.archived=store.archived.filter(k=>k!=='s:'+s.id);store.pinned=store.pinned.filter(k=>k!=='s:'+s.id);dropDraft('session:'+s.id);}
  else s.hidden=true;
  await persist(s);return {discarded:true};
 }
 // Stops the session's OMP and waits until it has let go, so Windows releases its working directory.
 async function stopRunner(s){await runners.get(s.id)?.kill();}
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
 // With commit, merge/squash first commit the worktree's uncommitted changes on its branch.
 // A failed merge or rebase is undone so neither folder is left mid-conflict.
 async function finishWorktree(s,action,{commit=false}={}){
  if(!['merge','squash','rebase','push','delete'].includes(action))throw error('Choose merge, squash, rebase, push or delete.');
  if(['running','queued'].includes(s.status)||s._task||s._bash)throw error('Wait for OMP to finish first.');
  let st=await worktreeStatus(s);const {root,branch,base}=st;
  if(['merge','squash','rebase'].includes(action)&&!base)throw error(`${root} is not on a branch (detached HEAD). Check out the branch to merge into first.`,409);
  if(action==='merge'||action==='squash'){
   if(st.rootDirty)throw error(`${root} has uncommitted changes. Commit or stash them before merging.`,409);
   if(commit&&st.exists&&st.dirty){
    const head=(await gitRun(s.cwd,['branch','--show-current'],{timeout:10000})).trim();
    if(head!==branch)throw error(`The worktree has ${head||'a detached HEAD'} checked out, not ${branch}. Commit its changes by hand.`,409);
    try{await gitRun(s.cwd,['add','-A']);await gitRun(s.cwd,['commit','-m',s.title||`Work from ${branch}`]);}
    catch(e){throw error(`Committing the worktree failed: ${e.message}`,409);}
    activity(s,`Committed worktree changes on ${branch}`,'update');
    st=await worktreeStatus(s);
   }
   if(!st.ahead)throw error(`${branch} has no commits that ${base} lacks. Commit the work in the worktree first.`,409);
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
   s.hidden=true;s.status='done';s.worktreeRemoved=now();dropDraft('session:'+s.id);
   activity(s,`Deleted worktree and branch ${branch}`,'done');await persist(s);return {action,deleted:true};
  }
  await persist(s);return {action,...await worktreeStatus(s)};
 }
 // Files edited (edit/write tool records) by two active sessions that share a folder rather than separate worktrees.
 // Set as _overlaps on both sessions before each /api/state reply. A transcript nothing has read yet contributes the
 // records store.mjs noted at startup (unreadEdits) instead of being read here.
 function markOverlaps(){
  const key=p=>process.platform==='win32'?p.toLowerCase():p;
  const active=store.sessions.filter(s=>!s.hidden&&!s.isolated&&['running','queued','review'].includes(s.status)).map(s=>{const files=new Map(),kept=unreadEdits(s);
   const add=list=>{for(const f of list)if(typeof f?.path==='string'&&f.path){const abs=path.resolve(s.cwd,f.path);files.set(key(abs),abs);}};
   if(kept)add(kept);else for(const m of s.messages||[])add(m.tool?.files||[]);return {s,files};});
  for(const s of store.sessions)delete s._overlaps;
  for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
   const a=active[i],b=active[j],shared=[...a.files.keys()].filter(k=>b.files.has(k)).map(k=>a.files.get(k));if(!shared.length)continue;
   (a.s._overlaps??=[]).push({id:b.s.id,title:b.s.title,files:shared.slice(0,20),count:shared.length});(b.s._overlaps??=[]).push({id:a.s.id,title:a.s.title,files:shared.slice(0,20),count:shared.length});
  }
 }
 async function browse(value){
  if(!value){
   const roots=[];const add=async(p,label)=>{if(p&&!roots.some(r=>samePath(r.path,p))&&await exists(p))roots.push({path:p,name:label||path.basename(p)||p});};
   await add(os.homedir(),'Home');for(const d of ['Documents/GitHub','Documents','Desktop','projects','code','src'])await add(path.join(os.homedir(),d));
   if(process.platform==='win32')for(const l of 'CDEFGHIJ')await add(l+':\\',l+':');else await add('/','/');
   // Registered workspaces first (most recently used first), then folders from OMP's history. Worktrees the panel made for
   // isolated sessions are not folders anyone picks; their sessions belong to the project they were made from.
   const wtRoot=path.join(dataDir,'worktrees'),inWorktrees=p=>{const r=path.relative(wtRoot,p);return r===''||(!!r&&!r.startsWith('..')&&!path.isAbsolute(r));};
   const lastUse=p=>store.sessions.filter(s=>s.projectId===p.id).reduce((a,s)=>s.updatedAt>a?s.updatedAt:a,'');
   const recent=[];const addRecent=async(p,name,lastUsed,projectId)=>{if(p&&!inWorktrees(p)&&!recent.some(r=>samePath(r.path,p))&&await exists(p))recent.push({path:p,name:name||path.basename(p)||p,lastUsed,...(projectId?{project:projectId}:{})});};
   for(const p of store.projects.filter(p=>!p.hidden).map(p=>({p,at:lastUse(p)})).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,8).map(x=>x.p))await addRecent(p.path,p.name,lastUse(p)||undefined,p.id);
   for(const s of await listNativeSessions(120)){if(recent.length>=12)break;await addRecent(s.cwd,'',s.updatedAt);}
   return {path:'',parent:null,roots,recent,dirs:[]};
  }
  const dir=await resolveDir(value);const entries=await fs.readdir(dir,{withFileTypes:true}).catch(e=>{throw error(`Cannot read directory: ${e.message}`);});
  const dirs=entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&!['node_modules','$RECYCLE.BIN','System Volume Information'].includes(e.name)).map(e=>({name:e.name,path:path.join(dir,e.name)})).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})).slice(0,1000);
  const parent=path.dirname(dir);return {path:dir,parent:parent===dir?null:parent,isGit:await exists(path.join(dir,'.git')),project:store.projects.find(p=>samePath(p.path,dir))?.id,dirs};
 }
 return {sent,browse,discardDraft,worktreeStatus,finishWorktree,ensureProject,refreshBranch,refreshBranches,createSession,markOverlaps,get branchRun(){return branchRun;}};
}
