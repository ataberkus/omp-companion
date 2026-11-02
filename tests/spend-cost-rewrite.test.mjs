// A transcript copy that starts over in place (collab-host restart(): writeFile '' then appendFile, same inode and
// header) and is next costed once it is at least as long as before is summed whole, not from the old offset; appends
// still take the incremental path.
import { test } from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs/promises';import * as path from 'node:path';import * as os from 'node:os';
import { createSpend } from '../companion/spend.mjs';
const whole=async f=>{let c=0;for(const l of (await fs.readFile(f,'utf8')).split('\n')){if(!l.includes('"cost"'))continue;try{c+=JSON.parse(l).message?.usage?.cost?.total||0;}catch{}}return c;};
const header=JSON.stringify({type:'session',version:3,id:'abc',timestamp:'2026-01-01T00:00:00Z',cwd:'/x/y/z'})+'\n';
const line=(c,i)=>JSON.stringify({type:'message',id:'m'+i,timestamp:`2026-01-01T00:00:${String(i).padStart(2,'0')}Z`,message:{role:'assistant',usage:{cost:{total:c}}}})+'\n';
test('an in-place restart of a transcript copy is costed whole', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'f1t-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {transcriptCost}=createSpend({execOmp:async()=>({})}),f=path.join(dir,'agent.jsonl'),cost=async()=>transcriptCost(f,await fs.stat(f));
  await fs.writeFile(f,header+[1,1,1,1,1].map(line).join(''));assert.equal(await cost(),5);const ino=(await fs.stat(f)).ino;
  await fs.appendFile(f,[10,10,10,10,10].map((c,i)=>line(c,i+5)).join(''));
  await fs.writeFile(f,'');await fs.appendFile(f,header+[3,3,3,3,3,3,3].map((c,i)=>line(c,i+20)).join(''));
  assert.equal((await fs.stat(f)).ino,ino);assert.equal(await cost(),await whole(f));
  await fs.appendFile(f,line(100,40));assert.equal(await cost(),await whole(f));
});
test('appends are still summed from the offset', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'f1t-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {transcriptCost}=createSpend({execOmp:async()=>({})}),f=path.join(dir,'agent.jsonl'),cost=async()=>transcriptCost(f,await fs.stat(f));
  await fs.writeFile(f,header+[1,1,1,1,1,1,1,1].map(line).join(''));assert.equal(await cost(),8);
  // A same-length edit far before the offset is not seen (only the new bytes are read); the appended line is.
  const s=await fs.readFile(f,'utf8');await fs.writeFile(f,s.replace('"total":1}','"total":9}'),{flag:'r+'});await fs.appendFile(f,line(100,99));
  assert.equal(await cost(),108);
});
