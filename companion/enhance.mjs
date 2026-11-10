// Enhance prompt: model choice, argv and stdin for the one-shot read-only `omp -p`, output cleanup, and the
// per-companion jobs the dashboard polls.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { exists, now, error, text, contentText, resolveDir } from './util.mjs';
import { IMAGE_EXT, chatImages } from './images.mjs';
import { ENHANCE_MODES, ENHANCE_LOOKUP_ENV } from './enhance-prompts.mjs';
// Enhance prompt: a one-shot read-only `omp -p` that rewrites a composer draft.
// An `enhance` role (model[:thinking] in OMP's config.yml modelRoles) wins unless the cached model list shows its model is not
// available (OMP would fail the run with `Model "@enhance" not found`); otherwise the enhancer runs on the composer's model at
// the composer's reasoning level (none: OMP's default).
// shortcut: only an exact provider/id role is checked, against the model list already cached (no `omp models` wait); patterns
// and aliases go to OMP as-is.
export function enhanceModel(roles,selector,thinking='',available){
 const sel=roles?.enhance?.replace(/:(?:off|minimal|low|medium|high|xhigh|max|auto|inherit)$/,'');
 if(roles?.enhance&&!(available&&/^[^/,\s]+\/[^,\s]+$/.test(sel)&&!available.includes(sel)))return {model:'@enhance',thinking:null,label:roles.enhance};
 if(selector)return {model:selector,thinking:thinking||null,label:selector};
 return {model:null,thinking:thinking||null,label:roles?.default||'OMP default'};
}
// The draft never goes in argv (stdin only): no quoting hazards and no Windows 32K command-line limit.
// --system-prompt replaces OMP's coding-agent prompt; the guard extension (-e loads even under --no-extensions) confines
// lookups to the repository and the lookup budget.
export function enhanceArgs({model,thinking,overlay,system,guard,images}){
 return ['-p','--mode','json','--no-session','--no-title','--no-skills','--no-extensions','--no-rules','--no-lsp','--tools=read,grep,glob','--approval-mode=always-ask','--max-time=240',
  `--config=${overlay}`,`-e`,guard,...(model?[`--model=${model}`]:[]),...(thinking?[`--thinking=${thinking}`]:[]),`--system-prompt=${system}`,...images.map(f=>'@'+f)];
}
// The last 6 turns, each run of assistant messages reduced to its last (the reply the user saw). Clips keep both ends: the
// start holds the ask or context, the end of a reply its options and question; the latest reply gets the most room.
// Tag lookalikes inside messages are defused so quoted text cannot close <conversation> or open a <draft>.
// An image-only draft: the images are the request.
const ENHANCE_IMAGE_ONLY='(No text: the attached images are the whole draft. Write the prompt they ask for.)';
export function enhanceInput(draft,messages){
 const chat=messages.filter(m=>m.role==='user'||m.role==='assistant'),tail=chat.filter((m,i)=>m.role==='user'||chat[i+1]?.role!=='assistant').slice(-6);
 const latest=tail.findLastIndex(m=>m.role==='assistant'),clip=(t,n)=>t.length>n?`${t.slice(0,n/2)}\n[…]\n${t.slice(-n/2)}`:t;
 const defuse=t=>t.replace(/<(\/?)(conversation|draft)>/gi,'‹$1$2›');
 const lines=tail.map((m,i)=>`${m.role==='user'?'User':'Assistant'}: ${defuse(clip(String(m.text||''),i===latest?6000:1500))}`);
 return (lines.length?`<conversation>\n${lines.join('\n')}\n</conversation>\n`:'')+`<draft>\n${draft?defuse(String(draft)):ENHANCE_IMAGE_ONLY}\n</draft>`;
}
export function stepLabel(toolName,args,cwd){
 const a=args||{};let s;
 if(toolName==='read')s='reading '+(a.path?path.relative(cwd,path.resolve(cwd,String(a.path))).replace(/\\/g,'/'):'a file');
 else if(toolName==='grep')s=`searching "${a.pattern??''}"`;
 else if(toolName==='glob')s='listing '+(a.pattern??'files');
 else if(toolName==='find')s=`finding "${a.query??a.pattern??''}"`;
 else s=String(toolName||'working');
 return s.length>80?s.slice(0,79)+'…':s;
}
// Unwraps a prompt the model fenced as a whole (```markdown … ```), not one that merely starts with a code block.
export function cleanEnhanced(text){
 const t=String(text||'').trim(),lines=t.split('\n'),open=lines[0].match(/^(`{3,}|~{3,})\s*([^`]*)$/);
 if(!open)return t;
 const closes=l=>new RegExp(`^\\${open[1][0]}{${open[1].length},}\\s*$`).test(l.trim()),end=lines.findIndex((l,i)=>i>0&&closes(l));
 const wraps=end===-1||end===lines.length-1||/^(markdown|md)$/i.test(open[2].trim())&&closes(lines.at(-1));
 return wraps?lines.slice(1,end===-1?undefined:-1).join('\n').trim():t;
}
// modelRoles and defaultThinkingLevel straight from config.yml: cheap, so enhance needs no `omp models` call.
export async function modelRoles(){
 const roles={};let defaultThinking='';
 try{const cfg=await fs.readFile(path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.omp','agent'),'config.yml'),'utf8');let inRoles=false;
  for(const line of cfg.split(/\r?\n/)){if(/^modelRoles:\s*$/.test(line)){inRoles=true;continue;}if(inRoles){const m=line.match(/^\s+([\w-]+):\s*(\S+)/);if(m){roles[m[1]]=m[2].replace(/^["']|["']$/g,'');continue;}if(/^\S/.test(line))inRoles=false;}
   const t=line.match(/^defaultThinkingLevel:\s*(\w+)/);if(t)defaultThinking=t[1];}}catch{}
 return {roles,defaultThinking};
}
export function createEnhance(ctx){
 const {options,store,dataDir,ompExecutable,ompPrefix,enhanceOverlay,enhanceSystems,enhanceGuard,modelChoice}=ctx;
 // Enhance jobs: one read-only `omp -p` per click; the dashboard polls GET /api/enhance until it settles.
 const enhanceJobs=new Map();
 async function startEnhance(body){
 // A draft may be only images (as a prompt may): no text, at least one image; chatImages validates them below.
 const imageOnly=typeof body.text==='string'&&!body.text.trim()&&Array.isArray(body.images)&&body.images.length>0;
 const draft=imageOnly?'':text(body.text,'Draft',200000);
  // mode: full | notest | fast (ENHANCE_MODES); without one, the mode picked in Settings › Enhance.
  const mode=body.mode??store.enhanceMode;
  if(!Object.hasOwn(ENHANCE_MODES,mode))throw error('Unknown enhance mode.');
  if(!!body.session===!!body.path)throw error('Choose a session or a folder to enhance in.');
  const s=body.session?store.sessions.find(x=>x.id===body.session):null;
  if(body.session&&!s)throw error('Session not found.',404);
  // Node reports a missing cwd as `spawn omp ENOENT`, which reads like OMP itself is missing.
  if(s&&(!s.cwd||!await exists(s.cwd)))throw error(`The session's working directory no longer exists: ${s.cwd||'unknown'}`);
  const cwd=s?s.cwd:await resolveDir(body.path);
  const images=chatImages(body);
  if([...enhanceJobs.values()].filter(j=>j.status==='running').length>=3)throw error('Wait for the running enhance to finish.',409);
  const choice=s?null:modelChoice(body);
  const selector=s?(s.modelSelector||(s.provider&&s.model&&s.model!=='OMP default'?`${s.provider}/${s.model}`:'')):choice.selector;
  const pick=enhanceModel((await modelRoles()).roles,selector,s?(s.thinking||s.thinkingChoice||''):choice.thinking,ctx.modelCache?.data.models.map(m=>m.selector));
  const id=randomUUID(),dir=path.join(dataDir,'enhance',id);
  const files=[];
  if(images.length){await fs.mkdir(dir,{recursive:true,mode:0o700});for(const [i,img] of images.entries()){const f=path.join(dir,`image-${i+1}.${IMAGE_EXT[img.mimeType]||'png'}`);await fs.writeFile(f,Buffer.from(img.data,'base64'),{mode:0o600});files.push(f);}}
  const job={id,sessionId:s?.id||null,status:'running',step:'',model:pick.label,mode,text:'',error:'',dir};
  const child=spawn(ompExecutable,[...ompPrefix,...(options.enhancePrefix||[]),...enhanceArgs({model:pick.model,thinking:pick.thinking,overlay:enhanceOverlay,system:enhanceSystems[mode],guard:enhanceGuard,images:files})],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0',[ENHANCE_LOOKUP_ENV]:String(ENHANCE_MODES[mode].lookups)}});
  job.child=child;enhanceJobs.set(id,job);
  let stderr='',answer='';
  child.stdin.on('error',()=>{});child.stdin.end(enhanceInput(draft,s?.messages??[]),'utf8');
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-8000);});
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{let f;try{f=JSON.parse(line);}catch{return;}
   if(f.type==='tool_execution_start')job.step=stepLabel(f.toolName,f.args,cwd);
   else if(f.type==='message_end'&&f.message?.role==='assistant')answer=contentText(f.message.content);});
  const timer=setTimeout(()=>{job.timedOut=true;child.kill();},270000);timer.unref();
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
  return {id,model:job.model,mode};
 }
 // Resolves once the enhancer process has exited and its image folder is gone.
 async function stopEnhance(job){if(job.child){job.stopped=true;job.child.kill();}await job.closed;}
 const stopAllEnhance=()=>Promise.allSettled([...enhanceJobs.values()].map(stopEnhance));
 return {enhanceJobs,stopEnhance,startEnhance,stopAllEnhance};
}
