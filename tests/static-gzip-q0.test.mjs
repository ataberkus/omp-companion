// Accept-Encoding that refuses gzip (q=0) gets app.js raw; gzip with q>0 still gets it gzipped.
import { test } from 'node:test';import assert from 'node:assert/strict';import { once } from 'node:events';import { get } from 'node:http';import { mkdtemp, rm, writeFile } from 'node:fs/promises';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';import { fakeOmp } from './fake-omp.mjs';
const request=(port,path,headers={})=>new Promise((res,rej)=>get({host:'127.0.0.1',port,path,headers},r=>{r.resume();r.on('end',()=>res(r));}).on('error',rej));
test('gzip;q=0 is not gzip', async t => {
  const dir=await mkdtemp(join(tmpdir(),'f3t-'));await writeFile(join(dir,'workspace.json'),JSON.stringify({projects:[],sessions:[],activity:[]}));
  const app=await createCompanion({dataDir:dir,omp:fakeOmp()});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const port=app.server.address().port;
  for(const ae of ['gzip;q=0','gzip;q=0, identity','identity;q=1, gzip; q=0.0'])assert.equal((await request(port,'/app.js',{'Accept-Encoding':ae})).headers['content-encoding'],undefined,ae);
  for(const ae of ['gzip','gzip;q=0.5, identity','gzip, deflate, br, zstd','x-gzip'])assert.equal((await request(port,'/app.js',{'Accept-Encoding':ae})).headers['content-encoding'],'gzip',ae);
});
