// With a git that rejects --porcelain=v2 (before 2.11), gitLog still counts uncommitted changes. A stand-in git on PATH
// refuses v2 the way 1.8-2.10 do and runs the real one otherwise.
import { test } from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs/promises';import * as path from 'node:path';import * as os from 'node:os';import {execFileSync} from 'node:child_process';
import { gitLog } from '../companion/git.mjs';
test('gitLog counts changes when porcelain v2 is refused', { skip: process.platform === 'win32' }, async t => {
  const repo=await fs.mkdtemp(path.join(os.tmpdir(),'f2t-'));t.after(()=>fs.rm(repo,{recursive:true,force:true}));
  const g=(...a)=>execFileSync('git',['-C',repo,...a]);g('init','-q','-b','main');g('config','user.email','a@b');g('config','user.name','a');
  await fs.writeFile(path.join(repo,'a.txt'),'1\n');g('add','.');g('commit','-qm','one');await fs.writeFile(path.join(repo,'a.txt'),'2\n');await fs.writeFile(path.join(repo,'new.txt'),'n\n');
  const real=execFileSync('sh',['-c','command -v git']).toString().trim(),bin=await fs.mkdtemp(path.join(os.tmpdir(),'f2git-'));t.after(()=>fs.rm(bin,{recursive:true,force:true}));
  await fs.writeFile(path.join(bin,'git'),`#!/bin/sh\nfor a in "$@"; do case "$a" in --porcelain=v2) echo "error: option porcelain takes no value" >&2; exit 129;; esac; done\nexec '${real}' "$@"\n`,{mode:0o755});
  const PATH=process.env.PATH;process.env.PATH=bin+path.delimiter+PATH;t.after(()=>{process.env.PATH=PATH;});
  const r=await gitLog({cwd:repo},5);assert.equal(r.branch,'main');assert.equal(r.commits.length,1);assert.equal(r.dirty,2);
});
