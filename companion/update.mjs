// OMP updates: `omp update` at startup and from Settings, then the matching SDK install (syncOmpSdk). Without an OMP CLI
// both install it first with OMP's official installer (installOmp).
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { cliEnv, syncOmpSdk } from './omp-sdk.mjs';
import { addInstallDirs, onPath } from './system.mjs';
import { exec } from './util.mjs';
export const cleanUpdateOutput=(...parts)=>parts.filter(Boolean).join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().slice(-6000);
// OMP's official installer (https://omp.sh, from github.com/can1357/oh-my-pi) in its prebuilt-binary mode, which needs
// neither Bun nor git and installs where addInstallDirs looks: PI_INSTALL_DIR, else %LOCALAPPDATA%\omp\omp.exe (Windows,
// also added to the user Path) or ~/.local/bin/omp. Its default mode would `bun install -g`, which needs a newer Bun.
export function ompInstallCommand(platform=process.platform){
 if(platform==='win32')return ['powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',
  // Windows PowerShell 5.1: TLS 1.2 for omp.sh, and no progress bar (it slows Invoke-WebRequest down many times over).
  "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary"]];
 // Downloaded first, so a failed download fails here instead of piping nothing into sh (which would succeed).
 return ['sh',['-c','set -e; script=$(curl -fsSL --connect-timeout 10 --max-time 120 https://omp.sh/install); printf "%s\\n" "$script" | sh -s -- --binary']];
}
export const manualInstall=(platform=process.platform)=>platform==='win32'
 ?'Install it in PowerShell with: irm https://omp.sh/install.ps1 | iex, then restart the companion.'
 :'Install it in a terminal with: curl -fsSL https://omp.sh/install | sh, then restart the companion.';
// After the default install folders are (re)added to PATH: where `omp` runs from, or null. setup: {exists, home, localAppData, platform}.
export function findOmp(env=process.env,setup={}){addInstallDirs(env,setup);return onPath('omp',env,setup);}
let installing;
/**
 * Installs the OMP CLI with OMP's installer (setup.command, [cmd, args], replaces it in tests), then adds the folder it
 * installed into to PATH in env, so `omp` runs from this process without a restart. One install at a time: a call while one
 * runs (startup's, still going in the background, or Settings') gets that one. Never throws:
 * { status: 'installed'|'error', output, path?, summary? } (summary: one line saying what failed and how to install by hand).
 */
export function installOmp(options={}){
 return installing??=runInstall(options).finally(()=>{installing=undefined;});
}
async function runInstall({env=process.env,timeout=10*60*1000,command,...setup}){
 const platform=setup.platform||process.platform,[cmd,args]=command||ompInstallCommand(platform);
 const fail=(why,...output)=>{const summary=`OMP could not be installed automatically (${why}). ${manualInstall(platform)}`;return {status:'error',summary,output:cleanUpdateOutput(...output,summary)};};
 let output;
 try{const {stdout,stderr}=await exec(cmd,args,{cwd:setup.home||os.homedir(),env,timeout,maxBuffer:8*1024*1024,windowsHide:true});output=cleanUpdateOutput(stdout,stderr);}
 catch(e){return fail(e.killed?'the installer timed out':lastLine(e.stderr)||lastLine(e.stdout)||lastLine(e.message),e.stdout,e.stderr);}
 const file=findOmp(env,setup);
 if(!file)return fail('the installer finished, but omp is still not on PATH',output);
 return {status:'installed',path:file,output:cleanUpdateOutput(output,`Installed OMP: ${file}`)};
}
const lastLine=text=>cleanUpdateOutput(text).split('\n').map(l=>l.trim()).filter(Boolean).pop()?.slice(0,300);
// `omp update` checks the release channel and installs only when a newer build exists. entry: native executable or a source checkout's cli.ts.
// The default `omp` missing from PATH (and its install folders) is installed instead: Settings › Update installs OMP.
export async function updateOmp(entry,{cwd=os.homedir(),timeout=20*60*1000,env=process.env,setup={}}={}){
 if(entry==='omp'&&!findOmp(env,setup)){
  const r=await installOmp({env,timeout,...setup});
  return r.status==='installed'?{status:'done',output:r.output}:r;
 }
 const source=/\.ts$/i.test(entry);
 try{
  const {stdout,stderr}=await exec(source?'bun':entry,[...(source?[path.resolve(entry)]:[]),'update'],{cwd,env:cliEnv(entry,env),timeout,maxBuffer:8*1024*1024,windowsHide:true});
  return {status:'done',output:cleanUpdateOutput(stdout,stderr)||'OMP update finished without output.'};
 }catch(e){return {status:'error',exitCode:typeof e.code==='number'?e.code:null,output:cleanUpdateOutput(e.stdout,e.stderr,e.killed?'Update timed out.':e.message)||'OMP update failed.'};}
}
/**
 * What startup does about the OMP CLI `entry`: 'ready' (it runs), 'missing' (OMP_BIN names something that does not exist:
 * the user chose it, so nothing is installed elsewhere), 'opted-out' (the default `omp` is missing and
 * OMP_WEB_NO_INSTALL=1) or 'install' (the default `omp` is missing from PATH and its install folders).
 */
export function ompSetup(entry,{env=process.env,...setup}={}){
 if(entry!=='omp'){
  const named=path.isAbsolute(entry)||/[\\/]/.test(entry);
  return (named?(setup.exists||existsSync)(path.resolve(entry)):onPath(entry,env,setup))?'ready':'missing';
 }
 if(findOmp(env,setup))return 'ready';
 return env.OMP_WEB_NO_INSTALL==='1'?'opted-out':'install';
}
export const defaultDataDir=()=>process.env.OMP_WEB_DATA_DIR||path.join(os.homedir(),'.omp-web');
// Opening the companion first brings OMP up to date, before any OMP process starts. A failed or timed-out update
// starts with the installed build. OMP_WEB_NO_UPDATE=1 skips it; a source checkout is updated with git instead.
// Without OMP (OMP_BIN unset, `omp` neither on PATH nor in its install folders) it installs OMP instead of updating,
// unless OMP_WEB_NO_INSTALL=1; a failed install starts without the CLI.
// Sessions run OMP's SDK in this process and `omp update` replaces only the CLI, so the SDK release matching the CLI is
// installed next (syncOmpSdk). Whatever of the time budget the CLI step left goes to that install; one still
// running when the budget ends finishes in the background and counts from the next start. So does an OMP install,
// with its SDK install after it. setup: installOmp's and ompSetup's injectables (tests).
export async function startupUpdate({entry=process.env.OMP_BIN||'omp',timeout=10*60*1000,log=console.log,dataDir=defaultDataDir(),env=process.env,setup={}}={}){
 if(env.OMP_WEB_NO_UPDATE==='1')return {status:'skipped'};
 const deadline=Date.now()+timeout,platform=setup.platform||process.platform;
 const untilDeadline=promise=>{let timer;return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(resolve,Math.max(0,deadline-Date.now()),null);})]).finally(()=>clearTimeout(timer));};
 const sdkSync=prune=>syncOmpSdk({entry,dataDir,prune,env});
 const state=ompSetup(entry,{env,...setup});
 if(state==='missing'){const output=`OMP_BIN is set to ${entry}, which does not exist. Point OMP_BIN at the omp executable or a checkout's cli.ts, or unset it to use (or install) omp from PATH.`;log(output);return {status:'error',output};}
 if(/\.ts$/i.test(entry)){log('OMP runs from a source checkout; skipping omp update.');return {status:'skipped'};}
 if(state==='opted-out'){const output=`omp was not found on PATH, and OMP_WEB_NO_INSTALL=1 turns off installing it. Updates, usage and the Tools page need it. ${manualInstall(platform)}`;log(output);return {status:'skipped',output};}
 let result;
 if(state==='install'){
  log('omp was not found on PATH; installing OMP (this happens once)…');
  const install=installOmp({env,...setup});
  const done=await untilDeadline(install);
  if(!done){
   log('Installing OMP continues in the background; the companion starts without the OMP CLI until it finishes.');
   // Resolves with the SDK install result (sdkLate below), so a caller that can restart picks up a newer SDK.
   const late=install.then(async r=>{
    if(r.status!=='installed'){log(r.summary);return r;}
    log(r.output);
    const sdk=await sdkSync(()=>false);if(sdk.output)log(sdk.output);return sdk;
   });
   return {status:'skipped',output:'Installing OMP continues in the background.',sdkLate:late};
  }
  if(done.status!=='installed'){log(done.summary);return done;}
  log(done.output);result=done; // A fresh install is the latest release: no `omp update`.
 }else{
  log('Checking for OMP updates…');
  result=await updateOmp(entry,{timeout,env,setup});
  log(result.status==='done'?result.output:`OMP update failed; starting with the installed version.\n${result.output}`);
 }
 // Older SDK copies are pruned only while no session can have loaded one, i.e. before the budget ends.
 let late=false;
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const sync=sdkSync(()=>!late);
 const sdk=await untilDeadline(sync);
 if(sdk){if(sdk.output)log(sdk.output);}
 else{late=true;log('Installing the matching OMP SDK continues in the background; sessions use it from the next start.');sync.then(r=>r.output&&log(r.output));}
 // sdkLate: a caller that can restart does so once it resolves installed (sessions loaded the older SDK meanwhile).
 return late?{...result,sdkLate:sync}:result;
}
