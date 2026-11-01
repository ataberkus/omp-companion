// Shared leaf helpers for every companion module: timestamps, HTTP-facing errors (error() carries the status the
// router answers with), input validation, paths and atomic file writes. Imports nothing from the companion.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const exec=promisify(execFile);
export const now=()=>new Date().toISOString();
export const error=(message,status=400)=>Object.assign(new Error(message),{status});
export function text(value,name,max=10000){if(typeof value!=='string'||!value.trim()||value.length>max)throw error(`${name} is required (maximum ${max} characters).`);return value.trim();}
export function contentText(content){if(typeof content==='string')return content;return Array.isArray(content)?content.filter(c=>c?.type==='text').map(c=>c.text).join('\n'):'';}
export const samePath=(a,b)=>{const n=v=>path.resolve(v||'');return process.platform==='win32'?n(a).toLowerCase()===n(b).toLowerCase():n(a)===n(b);};
export async function resolveDir(value){let dir=text(value,'Directory path',4000);if(dir==='~'||dir.startsWith('~/')||dir.startsWith('~\\'))dir=path.join(os.homedir(),dir.slice(2));if(!path.isAbsolute(dir))throw error('Use an absolute directory path.');let stat;try{dir=await fs.realpath(dir);stat=await fs.stat(dir);}catch{throw error('Directory does not exist on this machine.');}if(!stat.isDirectory())throw error('Path must be a directory.');return dir;}
export const exists=p=>fs.access(p).then(()=>true,()=>false);
export const clip=(v,n)=>{const s=typeof v==='string'?v:JSON.stringify(v??{},null,1);return s.length>n?s.slice(0,n)+`\n… (${s.length-n} more characters)`:s;};
// Leaves an already-current file untouched (opening it for write can fail with EPERM on Windows, e.g. under a
// restricted token); otherwise replaces it atomically so it is never missing or half-written. Errors propagate:
// a stale Enhance lockdown overlay must not be served.
export async function syncFile(file,content){
 if(await fs.readFile(file,'utf8').then(c=>c===content,()=>false))return;
 const tmp=`${file}.${process.pid}.tmp`;
 try{await fs.writeFile(tmp,content,{mode:0o600});await fs.rename(tmp,file);}
 catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}
}
// Windows: antivirus/indexers briefly lock workspace.json, making rename fail with EPERM/EACCES/EBUSY; retry like graceful-fs.
export const replaceFile=async(from,to)=>{for(let i=0;;i++){try{return await fs.rename(from,to);}catch(e){if(i>=20||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,50*(i+1)));}}};
