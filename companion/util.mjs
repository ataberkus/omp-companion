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
// OMP's antigravity-cli provider relays the Antigravity CLI's own request failures ("⚠ API error (attempt N): RESOURCE_EXHAUSTED
// (code 429): …") as reply text, so a quota or provider failure reads as an answer. A reply whose text is only those lines is
// that failure, its last line the CLI's final attempt. Thinking beside it changes nothing; a tool call or image means the model
// acted, and a line quoted among other text is an answer.
// Antigravity answers 429 for a request carrying OMP's own system prompt, by its text rather than its size: the same prompt
// through a plain ACP client fails, a short one passes, and any other provider answers. Retrying does not clear it.
const AGY_ERROR=/^⚠ API error \(attempt \d+\): /;
const AGY_QUOTA_HINT=' Antigravity rejects this client\u2019s system prompt at the account tier: sign in to Google models with an API key, or choose another provider for this session.';
export function antigravityFailure(m){
 if(m?.provider!=='antigravity-cli'||!Array.isArray(m.content)||m.content.some(b=>!['text','thinking','redactedThinking'].includes(b?.type)))return;
 const lines=contentText(m.content).split('\n').map(l=>l.trim()).filter(Boolean);
 if(!lines.length||!lines.every(l=>AGY_ERROR.test(l)))return;
 const why=lines.at(-1).slice(2);
 return `Antigravity CLI: ${why}${/RESOURCE_EXHAUSTED/.test(why)?AGY_QUOTA_HINT:''}`;
}
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
