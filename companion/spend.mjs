// Spend: transcript costs and per-model spend from OMP's stats.db, synced with `omp stats` in the background.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
export function createSpend(ctx){
 const {execOmp}=ctx;
// Keyed by path so a growing transcript replaces its entry instead of adding one per poll. Session files only grow, so a
// changed one is summed from where the last read ended, like scanJobs: complete lines add onto the running sum in file
// order (the same float a full read gives) and the offset stays at the last newline; a partial last line counts, as in a
// full read, only if it parses. A file that shrank, or whose inode or first bytes changed (rewritten), is read whole again.
const costCache=new Map();
const addCosts=(c,text)=>{for(const l of text.split('\n')){if(!l.includes('"cost"'))continue;try{c+=JSON.parse(l).message?.usage?.cost?.total||0;}catch{}}return c;};
async function transcriptCost(f,st){const hit=costCache.get(f);if(hit?.m===st.mtimeMs&&hit.s===st.size)return hit.total;
 const e={m:st.mtimeMs,s:st.size,ino:st.ino,first:Buffer.alloc(0),c:0,off:0,total:0};
 try{const fh=await fs.open(f,'r');try{
  const first=Buffer.alloc(Math.min(64,st.size));e.first=first.subarray(0,(await fh.read(first,0,first.length,0)).bytesRead);
  if(hit&&hit.ino===st.ino&&st.size>=hit.off&&e.first.subarray(0,hit.first.length).equals(hit.first)){e.c=hit.c;e.off=hit.off;}
  const buf=Buffer.alloc(st.size-e.off),{bytesRead}=await fh.read(buf,0,buf.length,e.off),end=buf.lastIndexOf(10,bytesRead-1);
  e.c=addCosts(e.c,buf.toString('utf8',0,end+1));e.off+=end+1;e.total=addCosts(e.c,buf.toString('utf8',end+1,bytesRead));
 }finally{await fh.close();}}catch{e.c=e.off=e.total=0;}
 costCache.set(f,e);return e.total;}
// `omp stats` is what ingests new transcripts into ~/.omp/stats.db. After heavy use it reparses every grown session file and
// can take minutes, so it runs in the background (one at a time) and /api/spend answers from whatever the DB already holds.
const statsSync={running:null,error:''};
function syncStats(){
 statsSync.running??=execOmp(['stats','--summary'],{timeout:30*60000,maxBuffer:16*1024*1024,windowsHide:true})
  .then(()=>{statsSync.error='';},e=>{statsSync.error=(e.killed?'omp stats ran for 30 minutes and was stopped.':String(e.stderr||e.message).trim()).slice(0,500)||'omp stats failed.';})
  .finally(()=>{statsSync.running=null;});
}
// Spend per model from OMP's hourly rollups; `sync` starts an ingest unless one is already running.
async function spend(sync){
 if(sync)syncStats();
 const file=path.join(os.homedir(),'.omp','stats.db');
 let rows=[];
 if(await fs.access(file).then(()=>true,()=>false)){
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
  try{rows=db.prepare("SELECT bucket AS at,provider||'/'||model AS model,TOTAL(cost_total) AS cost FROM message_rollup GROUP BY bucket,provider,model ORDER BY bucket").all();}finally{db.close();}
 }
 return {rows,syncing:!!statsSync.running,syncError:statsSync.error};
}
 return {spend,transcriptCost};
}
