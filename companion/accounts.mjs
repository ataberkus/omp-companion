// Provider OAuth accounts as OMP lists them, cached and refreshed in the background.
import * as os from 'node:os';
import { error, contentText } from './util.mjs';
export function createAccounts(ctx){
 const {omp,store,commandProbes,stopProbe}=ctx;
 // `/session pin` with no account lists "N. <label>[ (active)]" lines under "OAuth accounts for <provider>:".
 const accountLabels=out=>/^OAuth accounts for /.test(out)?out.split(/\r?\n/).map(l=>l.match(/^\d+\. (.+?)(?: \(active\))?$/)?.[1]).filter(Boolean):[];
 // OMP has no call that lists stored accounts, so a throwaway session selects one model per logged-in provider and reads
 // `/session pin`. Its setModel does not change OMP's saved default model.
 async function probeAccounts(){
  const out=[];
  const probe=omp.start({cwd:os.homedir(),args:['--no-session'],onEvent:f=>{if(f.type==='command_output')out.push(typeof f.text==='string'?f.text:contentText(f.content));},onExit:()=>{}});
  commandProbes.add(probe);
  try{
   const providers=(await probe.loginProviders())?.providers;
   const models=(await probe.availableModels())?.models;
   const list=[];
   for(const p of Array.isArray(providers)?providers.filter(p=>p.authenticated):[]){
    const m=Array.isArray(models)&&models.find(m=>m.provider===p.id);if(!m)continue;
    try{await probe.setModel(m.provider,m.id);}catch{continue;}
    out.length=0;await probe.prompt({message:'/session pin'});
    const accounts=accountLabels(out.join('\n').trim());
    if(accounts.length)list.push({id:String(p.id),name:String(p.name||p.id),accounts});
   }
   return list;
  }finally{await stopProbe(probe);}
 }
 // A probe takes seconds (an OMP start plus a model switch per provider), so the dialog is served from this cache,
 // filled at startup and refreshed in the background on every read. A login bumps the generation: a probe that
 // started before it may have missed the new account, so its result is dropped and another probe runs.
 let accountCache,accountProbe,accountGen=0;
 function refreshAccounts(){
  if(ctx.closing)return Promise.reject(error('The companion is closing.'));
  if(accountProbe)return accountProbe;
  const gen=accountGen;
  return accountProbe=probeAccounts().then(list=>{if(gen===accountGen)accountCache=list;return list;}).finally(()=>{accountProbe=undefined;if(gen!==accountGen&&!ctx.closing)refreshAccounts().catch(()=>{});});
 }
 async function listAccounts(){
  let list=accountCache;
  if(list)refreshAccounts().catch(()=>{});
  else while(!(list=accountCache))await refreshAccounts();
  return {providers:list.map(p=>({...p,selected:store.accountChoices[p.id]??null}))};
 }
 const accountsChanged=()=>{accountGen++;accountCache=undefined;refreshAccounts().catch(()=>{});};
 // Fill the account cache shortly after startup, so the first Choose provider accounts… opens instantly.
 const accountTimer=setTimeout(()=>refreshAccounts().catch(()=>{}),1000);accountTimer.unref();
 return {listAccounts,accountsChanged,accountTimer};
}
