// OMP settings, models and updates: config list/set/reset, advisor model, the model list, and `omp update` runs
// from Settings.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncOmpSdk } from './omp-sdk.mjs';
import { now, error, text } from './util.mjs';
import { THINKING } from './transcript.mjs';
import { modelRoles } from './enhance.mjs';
import { cleanUpdateOutput, updateOmp } from './update.mjs';
export function createSettings(ctx){
 const {dataDir,ompEntry,ompSource,execOmp,canRestart}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const restartWhenIdle=(...args)=>ctx.restartWhenIdle(...args);
 ctx.updateState={status:'idle'};
 async function runUpdate(startedAt){
  const result=await updateOmp(ompEntry,{cwd:dataDir});
  // `omp update` replaced only the CLI: install the matching SDK for sessions, which load OMP once per companion start.
  const sdk=result.status==='done'&&!ompSource?await syncOmpSdk({entry:ompEntry,dataDir}):null;
  if(sdk?.status==='installed')restartWhenIdle();
  const note=sdk?.status==='installed'?`${sdk.output} ${canRestart?'The companion restarts by itself once no session is working.':'Restart the companion to run new sessions on it.'}`:sdk?.status==='error'?sdk.output:'';
  ctx.updateState={...result,output:cleanUpdateOutput(result.output,note),startedAt,finishedAt:now()};
  if(result.status==='done'){modelCache=undefined;configDefaults=undefined;}
 }
 // Matched on the last key segment's suffix, so thresholdTokens or redactSecrets are not treated as secrets.
 const SECRET=/(token|secret|password|apikey|api_key|credentials?)$/i;
 const isSecret=key=>SECRET.test(key.split('.').pop());
 // OMP settings: `omp config list --json` has values, types and descriptions; the plain listing adds groups and enum options.
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
 return {agentDir,setAdvisorModel,runUpdate,listSettings,changeSetting,advisorConfig,listModels,get modelCache(){return modelCache;}};
}
