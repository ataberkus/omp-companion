// Spend: transcript costs and per-model spend from OMP's stats.db, synced with `omp stats` in the background.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
export function createSpend(ctx){
 const {execOmp}=ctx;
// Keyed by path so a growing transcript replaces its entry instead of adding one per poll.
const costCache=new Map();
async function transcriptCost(f,st){const hit=costCache.get(f);if(hit?.m===st.mtimeMs&&hit.s===st.size)return hit.c;let c=0;try{for(const l of (await fs.readFile(f,'utf8')).split('\n')){if(!l.includes('"cost"'))continue;try{c+=JSON.parse(l).message?.usage?.cost?.total||0;}catch{}}}catch{}costCache.set(f,{m:st.mtimeMs,s:st.size,c});return c;}
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
