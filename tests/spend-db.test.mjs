// spend() reads OMP's stats.db with the runtime's own SQLite (bun:sqlite under Bun, where the companion runs; node:sqlite
// under Node) and groups hourly rollups per bucket and provider/model; a missing stats.db is no rows, not an error.
import { test } from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs/promises';import * as path from 'node:path';import * as os from 'node:os';
import { createSpend } from '../companion/spend.mjs';
const openDb=async f=>{if(process.versions.bun){const {Database}=await import('bun:sqlite');return new Database(f);}const {DatabaseSync}=await import('node:sqlite');return new DatabaseSync(f);};
test('per-model spend is grouped from message_rollup', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spend-db-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const statsFile=path.join(dir,'stats.db'),db=await openDb(statsFile);
  try{
    db.exec('CREATE TABLE message_rollup(bucket INTEGER,provider TEXT,model TEXT,cost_total REAL)');
    const ins=db.prepare('INSERT INTO message_rollup VALUES(?,?,?,?)');
    for(const r of [[2000,'openai','gpt-5',0.5],[1000,'anthropic','opus',1.25],[1000,'anthropic','opus',0.75],[1000,'openai','gpt-5',2],[2000,'openai','gpt-5',null]])ins.run(...r);
    ins.finalize?.();
  }finally{db.close();}
  const {spend}=createSpend({execOmp:async()=>({}),statsFile});
  const res=await spend(false);
  assert.deepEqual(res.rows.map(r=>({...r})).sort((a,b)=>a.at-b.at||a.model.localeCompare(b.model)),[{at:1000,model:'anthropic/opus',cost:2},{at:1000,model:'openai/gpt-5',cost:2},{at:2000,model:'openai/gpt-5',cost:0.5}]);
  assert.equal(res.syncing,false);assert.equal(res.syncError,'');
});
test('a missing stats.db gives no rows', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spend-db-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {spend}=createSpend({execOmp:async()=>({}),statsFile:path.join(dir,'stats.db')});
  assert.deepEqual(await spend(false),{rows:[],syncing:false,syncError:''});
});
