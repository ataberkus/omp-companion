// OMP updates: `omp update` at startup and from Settings, then the matching SDK install (syncOmpSdk).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { cliEnv, syncOmpSdk } from './omp-sdk.mjs';
import { exec } from './util.mjs';
export const cleanUpdateOutput=(...parts)=>parts.filter(Boolean).join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().slice(-6000);
// `omp update` checks the release channel and installs only when a newer build exists. entry: native executable or a source checkout's cli.ts.
export async function updateOmp(entry,{cwd=os.homedir(),timeout=20*60*1000}={}){
 const source=/\.ts$/i.test(entry),env=cliEnv(entry);
 try{
  const {stdout,stderr}=await exec(source?'bun':entry,[...(source?[path.resolve(entry)]:[]),'update'],{cwd,env,timeout,maxBuffer:8*1024*1024,windowsHide:true});
  return {status:'done',output:cleanUpdateOutput(stdout,stderr)||'OMP update finished without output.'};
 }catch(e){return {status:'error',exitCode:typeof e.code==='number'?e.code:null,output:cleanUpdateOutput(e.stdout,e.stderr,e.killed?'Update timed out.':e.message)||'OMP update failed.'};}
}
export const defaultDataDir=()=>process.env.OMP_WEB_DATA_DIR||path.join(os.homedir(),'.omp-web');
// Opening the companion first brings OMP up to date, before any OMP process starts. A failed or timed-out update
// starts with the installed build. OMP_WEB_NO_UPDATE=1 skips it; a source checkout is updated with git instead.
// Sessions run OMP's SDK in this process and `omp update` replaces only the CLI, so the SDK release matching the CLI is
// installed next (syncOmpSdk). Whatever of the time budget the CLI update left goes to that install; one still
// running when the budget ends finishes in the background and counts from the next start.
export async function startupUpdate({entry=process.env.OMP_BIN||'omp',timeout=10*60*1000,log=console.log,dataDir=defaultDataDir()}={}){
 if(process.env.OMP_WEB_NO_UPDATE==='1')return {status:'skipped'};
 if(/\.ts$/i.test(entry)){log('OMP runs from a source checkout; skipping omp update.');return {status:'skipped'};}
 const deadline=Date.now()+timeout;
 log('Checking for OMP updates…');
 const result=await updateOmp(entry,{timeout});
 log(result.status==='done'?result.output:`OMP update failed; starting with the installed version.\n${result.output}`);
 // Older SDK copies are pruned only while no session can have loaded one, i.e. before the budget ends.
 let late=false,timer;
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const sync=syncOmpSdk({entry,dataDir,prune:()=>!late});
 const sdk=await Promise.race([sync,new Promise(resolve=>{timer=setTimeout(resolve,Math.max(0,deadline-Date.now()),null);})]).finally(()=>clearTimeout(timer));
 if(sdk){if(sdk.output)log(sdk.output);}
 else{late=true;log('Installing the matching OMP SDK continues in the background; sessions use it from the next start.');sync.then(r=>r.output&&log(r.output));}
 // sdkLate: a caller that can restart does so once it resolves installed (sessions loaded the older SDK meanwhile).
 return late?{...result,sdkLate:sync}:result;
}
