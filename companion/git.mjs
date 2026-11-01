// Git for sessions and workspaces: git runs, diffs in OMP's line-numbered format, branch reads, worktree add/remove,
// and the Changes views (working tree, commits). Stateless: every function takes the folder it works on.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec, error, samePath } from './util.mjs';
export async function git(cwd,args){return (await exec('git',['-C',cwd,...args],{timeout:15000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();}
// Git runs for the Changes working-tree view and worktree finishing: errors carry git's own stderr.
export async function gitRun(cwd,args,{timeout=30000,maxBuffer=16*1024*1024,env}={}){try{return (await exec('git',['-C',cwd,...args],{timeout,maxBuffer,windowsHide:true,...(env?{env:{...process.env,...env}}:{})})).stdout;}catch(e){throw error(String(e.stderr||e.message).trim().split('\n').slice(-6).join('\n')||'git failed.',e.killed?504:400);}}
// `git diff` output in OMP's line-numbered diff format (" N|ctx" old N, "-N|old", "+N|new"; blank lines between hunks),
// so the dashboard renders it with the same diff view as edit-tool records. Paths are as git prints them (b/ side).
const unquoteGitPath=p=>/^".*"$/.test(p)?p.slice(1,-1).replace(/\\(["\\])/g,'$1').replace(/\\t/g,'\t').replace(/\\n/g,'\n'):p;
export function gitDiffFiles(out,{budget=2*1024*1024,perFile=200*1024}={}){
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
// The branch checked out in `dir` as `git branch --show-current` names it ('detached' for a detached HEAD, 'workspace'
// outside a repository), read from the repository's HEAD file. Dashboards ask for every project every 15 s, and starting
// git.exe for 30-odd projects at once stalled the event loop, and every OMP session in this process with it, for 150-250 ms
// each time. A HEAD that is neither a branch nor a commit (a reftable repository's placeholder, say) still asks git.
async function gitHead(dir){
 const is=(p,kind)=>fs.stat(p).then(st=>st[kind](),()=>false);
 for(let d=path.resolve(dir);;d=path.dirname(d)){
  const dotGit=path.join(d,'.git'),st=await fs.stat(dotGit).catch(()=>null);
  if(st?.isDirectory())return fs.readFile(path.join(dotGit,'HEAD'),'utf8');
  // A linked worktree's or a submodule's .git file names its git directory.
  if(st?.isFile()){const m=/^gitdir:(.+)$/m.exec(await fs.readFile(dotGit,'utf8'));return m?fs.readFile(path.join(path.resolve(d,m[1].trim()),'HEAD'),'utf8'):'';}
  if(await is(path.join(d,'HEAD'),'isFile')&&await is(path.join(d,'objects'),'isDirectory'))return fs.readFile(path.join(d,'HEAD'),'utf8');
  if(path.dirname(d)===d)return null;
 }
}
export const currentBranch=async dir=>{
 const head=await gitHead(dir).catch(()=>'');
 if(head===null)return 'workspace';
 const ref=/^ref: refs\/heads\/(.+?)\s*$/.exec(head);
 if(ref&&ref[1]!=='.invalid')return ref[1];
 if(/^[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$/.test(head))return 'detached';
 try{return await git(dir,['branch','--show-current'])||'detached';}catch{return 'workspace';}
};
// Checking out a whole repo can outlast git()'s 15 s on Windows: the same 746-file checkout measured 1-20 s from run to run.
// A timeout kills only the git.exe wrapper, so git finished the worktree anyway while the session reported it as skipped.
const WORKTREE_ADD_TIMEOUT=10*60000;
// Errors are user-facing sentences: why this folder can't get a worktree, or git's own error.
export async function addWorktree(root,wt,b){
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
// Removes an isolated session's worktree folder and its omp-web/ branch; false when Windows still holds the folder.
export async function removeWorktree(s,root){
 for(let i=0;i<20;i++){
  try{await git(root,['worktree','remove','--force',s.cwd]);break;}
  // On Windows `remove` can drop git's record and the files yet fail on the empty folder a dying process still holds;
  // retries then say "not a working tree". Once git no longer lists it, only the leftover folder remains.
  catch{if(!await worktreeListed(root,s.cwd)){await git(root,['worktree','prune']).catch(()=>{});await fs.rm(s.cwd,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});break;}if(i===19)return false;await new Promise(r=>setTimeout(r,50*(i+1)));}
 }
 await git(root,['branch','-D',s.branch]).catch(()=>{});return true;
}
// Changes › Working tree: the real `git diff` of the session's folder against the commit it started from (or HEAD),
// plus untracked files, in OMP's diff format with absolute paths.
export async function worktreeChanges(s,which){
 const cwd=s.cwd,q=['-c','core.quotepath=off'];
 try{await gitRun(cwd,['rev-parse','--is-inside-work-tree'],{timeout:10000});}catch{throw notGit();}
 let base='HEAD',label='HEAD';
 if(which==='start'&&s.baseSha){try{await gitRun(cwd,['cat-file','-e',s.baseSha+'^{commit}'],{timeout:10000});base=s.baseSha;label='session start';}catch{}}
 // No commit yet: compare with the empty tree, which shows staged files.
 if(base==='HEAD'&&!await gitRun(cwd,['rev-parse','--verify','HEAD'],{timeout:10000}).then(()=>true,()=>false)){base='4b825dc642cb6eb9a060e54bf8d69288fbee4904';label='empty repository';}
 const [diff,untracked]=await Promise.all([gitRun(cwd,[...q,'diff','--no-color','--no-ext-diff','--no-renames','--relative','--src-prefix=a/','--dst-prefix=b/','-U3',base,'--']),gitRun(cwd,[...q,'ls-files','--others','--exclude-standard','-z'])]);
 const files=gitDiffFiles(diff),extra=untracked.split('\0').filter(Boolean);let budget=2*1024*1024;
 for(const rel of extra.slice(0,200)){const d=budget>0?await untrackedDiff(path.join(cwd,rel)).catch(e=>`… (${e.code==='EISDIR'?'folder':'unreadable'})`):'… (diff omitted: too many changes)';budget-=d.length;files.push({path:rel,op:'create',diff:d});}
 return {cwd,base:label==='HEAD'?'HEAD':base.slice(0,12),baseLabel:label,untrackedOmitted:Math.max(0,extra.length-200),files:files.map(f=>({...f,path:path.join(cwd,f.path)}))};
}
const notGit=()=>error('This session’s folder is not a Git repository.',409);
// The repository root, spelled like the session folder (git's --show-toplevel resolves short names and symlinks).
async function gitTop(cwd){let prefix;try{prefix=(await gitRun(cwd,['rev-parse','--show-prefix'],{timeout:10000})).trim();}catch{throw notGit();}return path.resolve(cwd,...prefix.split('/').filter(Boolean).map(()=>'..'));}
// Changes › Commits: branch, upstream, ahead/behind and recent commits of the session's folder (its worktree when isolated).
// `session` marks commits made since the session started (baseSha..HEAD).
export async function gitLog(s,limit=50){
 const cwd=s.cwd,lines=o=>o.split('\n').filter(Boolean),opt={timeout:15000};
 const top=await gitTop(cwd);
 const head=await gitRun(cwd,['rev-parse','--verify','HEAD'],{timeout:10000}).then(o=>o.trim(),()=>'');
 const [branch,upstream,dirty]=await Promise.all([gitRun(cwd,['branch','--show-current'],opt).then(o=>o.trim(),()=>''),head?gitRun(cwd,['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}'],opt).then(o=>o.trim(),()=>''):'',gitRun(cwd,['status','--porcelain'],opt).then(o=>lines(o).length,()=>null)]);
 let ahead=0,behind=0,commits=[];
 if(head){
  if(upstream)[behind,ahead]=(await gitRun(cwd,['rev-list','--left-right','--count',`${upstream}...HEAD`],opt)).trim().split(/\s+/).map(Number);
  const mine=new Set(s.baseSha?await gitRun(cwd,['rev-list',`${s.baseSha}..HEAD`],opt).then(lines,()=>[]):[]);
  commits=lines(await gitRun(cwd,['log','--no-color',`--format=%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%s`,'-n',String(limit),'HEAD'],opt)).map(l=>{const [sha,short,author,date,parents,subject]=l.split('\x1f');return {sha,short,author,date,merge:parents.split(' ').length>1,subject,session:mine.has(sha)};});
 }
 return {cwd,top,branch,head:head.slice(0,12),upstream,ahead,behind,dirty,commits,limit};
}
// One commit's diff against its first parent (root commits: everything added), in OMP's diff format with absolute paths.
export async function gitCommit(s,sha){
 if(typeof sha!=='string'||!/^[0-9a-f]{4,64}$/i.test(sha))throw error('Choose a commit.');
 const cwd=s.cwd,top=await gitTop(cwd);
 try{await gitRun(cwd,['cat-file','-e',sha+'^{commit}'],{timeout:10000});}catch{throw error(`Commit ${sha.slice(0,12)} is not in this repository.`,404);}
 const [meta,diff]=await Promise.all([gitRun(cwd,['show','-s','--no-color','--format=%H%x1f%an%x1f%aI%x1f%B',sha],{timeout:15000}),gitRun(top,['-c','core.quotepath=off','show','--format=','--no-color','--no-ext-diff','--no-renames','-m','--first-parent','--src-prefix=a/','--dst-prefix=b/','-U3',sha,'--'],{timeout:30000})]);
 const [full,author,date,message]=meta.split('\x1f');
 return {cwd,top,sha:full.trim(),author,date,message:(message||'').trim(),files:gitDiffFiles(diff).map(f=>({...f,path:path.join(top,f.path)}))};
}
// Unknown (git failed) counts as still listed, so the worktree is retried rather than abandoned.
async function worktreeListed(root,dir){try{return (await git(root,['worktree','list','--porcelain'])).split(/\r?\n/).some(l=>l.startsWith('worktree ')&&samePath(l.slice(9),dir));}catch{return true;}}
