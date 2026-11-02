// This PC: PATH repair for OMP and Bun, terminals, shutdown and restart handoff, and opening files in an editor.
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { exec, error } from './util.mjs';
// Apps started from Explorer can get a PATH without the user's entries (Windows drops an oversized user Path), so the
// default install folders of OMP and Bun are appended when they exist and are missing: `omp` and `bun` still resolve.
// OMP's installer puts omp in PI_INSTALL_DIR when set, else %LOCALAPPDATA%\omp (Windows) or ~/.local/bin; `bun install -g`
// in ~/.bun/bin. Called again after the companion installs OMP (installOmp), so a folder created since start is picked up.
export function addInstallDirs(env=process.env,{home=os.homedir(),localAppData=env.LOCALAPPDATA,exists=existsSync,platform=process.platform}={}){
 const key=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';
 const dirs=String(env[key]||'').split(path.delimiter).filter(Boolean);
 const norm=d=>path.resolve(d).replace(/[\\/]+$/,'').toLowerCase();
 const have=new Set(dirs.map(norm));
 const add=[...new Set([env.PI_INSTALL_DIR,localAppData&&path.join(localAppData,'omp'),platform!=='win32'&&path.join(home,'.local','bin'),path.join(home,'.bun','bin')].filter(Boolean))].filter(d=>!have.has(norm(d))&&exists(d));
 if(add.length)env[key]=[...dirs,...add].join(path.delimiter);
 return add;
}
// The file `name` runs from when spawned without a shell (execFile): the first PATH folder holding it, with libuv's
// .com/.exe search on Windows. null when it is nowhere on PATH. `exists` decides whether a candidate file is there.
const isFile=p=>{try{return statSync(p).isFile();}catch{return false;}};
export function onPath(name,env=process.env,{exists=isFile,platform=process.platform}={}){
 const key=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';
 const exts=platform==='win32'&&!path.extname(name)?['.com','.exe']:[''];
 for(const dir of String(env[key]||'').split(path.delimiter).filter(Boolean))for(const ext of exts){const file=path.join(dir,name+ext);if(exists(file))return file;}
 return null;
}
// Opens a console window on this machine in `dir` (a phone using the panel opens it on the computer, not the phone).
// `dir` is only the working directory, never part of a command line. Windows: `start` gives the new cmd its own
// console window (a detached child has none, so cmd would read EOF and exit at once).
export function openTerminal(dir){
 const shell=process.env.ComSpec||'cmd.exe';
 const [cmd,args]=process.platform==='win32'?[shell,['/c','start','',shell]]:process.platform==='darwin'?['open',['-a','Terminal',dir]]:['x-terminal-emulator',[]];
 const child=spawn(cmd,args,{cwd:dir,detached:process.platform!=='win32',stdio:'ignore',windowsHide:true});
 return new Promise((resolve,reject)=>{child.once('error',e=>reject(error(`Could not open a terminal: ${e.message}`,500)));child.once('spawn',()=>{child.unref();resolve();});});
}
// Turns off the computer running the companion (a phone using the panel shuts down the computer, not the phone).
// Fixed argv, no shell. macOS asks System Events, which needs no sudo; Linux asks systemd/logind, which applies its polkit policy.
export function shutdownCommand(platform=process.platform){
 return platform==='win32'?['shutdown',['/s','/t','0']]:platform==='darwin'?['osascript',['-e','tell application "System Events" to shut down']]:['systemctl',['poweroff']];
}
// Resolves once the OS accepted the request: the command exits 0 (e.g. Windows says 1190 when a shutdown is already scheduled).
export function shutdownHost(){
 const [cmd,args]=shutdownCommand();
 const child=spawn(cmd,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});let stderr='';child.stderr.on('data',d=>{stderr+=d;});
 return new Promise((resolve,reject)=>{child.once('error',e=>reject(error(`Could not shut down this PC: ${e.message}`,500)));child.once('close',code=>code===0?resolve():reject(error(`Could not shut down this PC: ${stderr.trim().slice(-500)||`${cmd} exited with code ${code}.`}`,500)));});
}
// The note a restarting companion leaves for the next one (start.bat's loop): fresh for maxAgeMs, with its random token, if any,
// and the IDs of the sessions that were working (resume), which the next companion continues. A malformed list resumes nothing.
// Anything else (missing, stale, malformed) means a normal start.
export function restartHandoff(text,nowMs,maxAgeMs=2*60*1000){
 let v;try{v=JSON.parse(text);}catch{return null;}
 if(!v||typeof v!=='object'||!Number.isFinite(v.at)||v.at>nowMs||nowMs-v.at>maxAgeMs)return null;
 const out=typeof v.token==='string'&&/^[0-9a-f]{64}$/.test(v.token)?{token:v.token}:{};
 if(Array.isArray(v.resume)&&v.resume.length&&v.resume.length<=1000&&v.resume.every(id=>typeof id==='string'&&id&&id.length<=200))out.resume=[...new Set(v.resume)];
 return out;
}
// Editors that register a URL scheme taking file/<path>:<line>; opening a URL never goes through a shell.
export const EDITORS={vscode:'vscode','vscode-insiders':'vscode-insiders',cursor:'cursor',windsurf:'windsurf'};
export const EDITOR_CHOICES=['auto',...Object.keys(EDITORS),'reveal'];
export function editorUrl(scheme,file,line){
 const parts=file.replace(/\\/g,'/').split('/');
 const enc=parts.map((seg,i)=>i===0&&/^[A-Za-z]:$/.test(seg)?seg:encodeURIComponent(seg)).join('/');
 return `${scheme}://file${enc.startsWith('/')?'':'/'}${enc}${line?`:${line}`:''}`;
}
// Opens a URL with the OS handler (like the companion's own browser launch), or shows a file in its folder.
export function openWithOs(target,{reveal=false}={}){
 const [cmd,args]=reveal
  ?process.platform==='win32'?['explorer.exe',[`/select,"${target}"`]]:process.platform==='darwin'?['open',['-R',target]]:['xdg-open',[path.dirname(target)]]
  :process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',target]]:process.platform==='darwin'?['open',[target]]:['xdg-open',[target]];
 // Explorer wants /select,"<path>" as one verbatim argument; Windows paths cannot contain quotes.
 // No windowsHide: rundll32 forwards its own SW_HIDE to the handler, so a cold-started editor would get a hidden window.
 const child=spawn(cmd,args,{detached:process.platform!=='win32',stdio:'ignore',windowsVerbatimArguments:reveal&&process.platform==='win32'});
 return new Promise((resolve,reject)=>{child.once('error',e=>reject(error(`Could not open the editor: ${e.message}`,500)));child.once('spawn',()=>{child.unref();resolve();});});
}
let editorProbe;
// `auto` picks the first editor whose command line tool is on PATH, else shows the file in its folder.
export function detectEditor(){return editorProbe??=(async()=>{for(const [id,bin] of [['vscode','code'],['cursor','cursor'],['windsurf','windsurf'],['vscode-insiders','code-insiders']]){try{await exec(process.platform==='win32'?'where':'which',[bin],{timeout:5000,windowsHide:true});return id;}catch{}}return 'reveal';})();}
