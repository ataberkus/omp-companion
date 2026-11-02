// Tools page: the OMP CLI commands it offers, their validated argv, and the background jobs it polls.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { now, error, resolveDir } from './util.mjs';
import { MODEL_RE } from './launch.mjs';
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
export const cliCatalog=()=>Object.fromEntries(Object.entries(CLI_TOOLS).map(([id,t])=>[id,{title:t.title,description:t.description,actions:Object.fromEntries(Object.entries(t.actions).map(([a,x])=>[a,{label:x.label,cwd:x.cwd,confirm:x.confirm,confirmIf:x.confirmIf,command:'omp '+x.args.join(' '),fields:(x.fields||[]).map(({flag,arg,...f})=>({...f,flag}))}]))}]));
export function createCliJobs(ctx){
 const {dataDir,ompExecutable,ompPrefix,sessionFileParam}=ctx;
 // Tools page: each run is a background job the dashboard polls; stdin is closed so a prompt fails instead of hanging.
 const cliJobs=[];const cliProcs=new Map();
 // Each job's revision, bumped with every change to it: a poll naming the revision it holds gets that job back as
 // unchanged instead of its output (up to 200 KB) again. Kept beside the job, so replies without revs=1 stay as they were.
 const cliRevs=new WeakMap(),bumpCliRev=job=>{cliRevs.set(job,(cliRevs.get(job)||0)+1);},cliRev=job=>cliRevs.get(job)||0;
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
  cliJobs.unshift(job);cliJobs.splice(30);bumpCliRev(job);
  const child=spawn(ompExecutable,[...ompPrefix,...args],{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'}});
  cliProcs.set(job.id,child);
  const add=b=>{job.output=(job.output+b.toString()).slice(-200000);bumpCliRev(job);};
  child.stdout.on('data',add);child.stderr.on('data',add);
  const timer=setTimeout(()=>{job.timedOut=true;bumpCliRev(job);child.kill();},spec.long?30*60000:3*60000);
  const finish=(code,err)=>{if(job.status!=='running')return;clearTimeout(timer);cliProcs.delete(job.id);job.output=[job.output,err?.message,job.timedOut?'Timed out.':job.stopped?'Stopped.':''].filter(Boolean).join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().slice(-200000)||'(no output)';job.exitCode=code;job.status=code===0&&!err?'done':'error';job.finishedAt=now();bumpCliRev(job);};
  child.on('error',e=>finish(null,e));child.on('close',code=>finish(code));
  return job;
 }
 return {cliJobs,cliProcs,runCli,cliRev,bumpCliRev};
}
