import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const MAX_REASSEMBLED=64*1024*1024;

export class RpcProcess {
 constructor(command,args,cwd,onEvent,onExit){
  this.pending=new Map();this.alive=true;this.stopping=false;this.chunk=null;
  this.child=spawn(command,args,{cwd,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.readyTimer=setTimeout(()=>{this.fail(new Error('OMP did not become ready within 30 seconds. Check your OMP installation.'));this.kill();},30000);
  this.stderr='';
  this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b.toString()).slice(-8000);});
  this.child.stdin.on('error',()=>{});
  this.child.on('error',e=>this.fail(e));
  this.child.on('exit',(code,signal)=>{this.alive=false;clearTimeout(this.readyTimer);const e=new Error(this.stderr.trim()||`OMP exited (${code??signal}).`);this.fail(e);onExit(e,this.stopping);});
  const handle=frame=>{
   if(frame.type==='ready'){clearTimeout(this.readyTimer);
    // Protocol v2 splits oversized frames into rpc_chunk sequences instead of truncating them. Stdin order puts this before any command.
    if(Array.isArray(frame.supportedProtocolVersions)&&frame.supportedProtocolVersions.includes(2))this.child.stdin.write(JSON.stringify({id:'negotiate',type:'negotiate_protocol',protocolVersion:2})+'\n');
    this.resolveReady();}
   if(frame.type==='response'&&this.pending.has(frame.id)){const p=this.pending.get(frame.id);clearTimeout(p.timer);this.pending.delete(frame.id);frame.success?p.resolve(frame.data):p.reject(Object.assign(new Error(frame.error||'OMP rejected the command.'),{code:frame.code}));}
   onEvent(frame);
  };
  const lines=createInterface({input:this.child.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{
   if(line.length>2*1024*1024){this.fail(new Error('OMP output frame exceeded the supported size.'));return;}
   let frame;try{frame=JSON.parse(line);}catch{return;}
   if(frame.type!=='rpc_chunk'){if(this.chunk){this.chunk=null;console.error('OMP interrupted a chunked frame; dropped it.');}handle(frame);return;}
   const whole=this.reassemble(frame);if(whole)handle(whole);
  });
 }
 // Returns the decoded frame once the last chunk arrives; invalid or interleaved sequences are dropped whole.
 reassemble(f){
  const c=this.chunk;
  const bad=msg=>{this.chunk=null;console.error(`OMP sent an invalid chunked frame (${msg}); dropped it.`);return null;};
  if(typeof f.chunkId!=='string'||!Number.isInteger(f.index)||!Number.isInteger(f.count)||f.count<1||!Number.isInteger(f.byteLength)||f.byteLength<0||f.byteLength>MAX_REASSEMBLED||typeof f.data!=='string')return bad('malformed chunk');
  if(f.index===0){if(c)console.error('OMP started a new chunked frame before finishing the previous one.');this.chunk={id:f.chunkId,count:f.count,byteLength:f.byteLength,parts:[],size:0};}
  else if(!c||c.id!==f.chunkId||c.count!==f.count||c.byteLength!==f.byteLength||c.parts.length!==f.index)return bad('out of sequence');
  const part=Buffer.from(f.data,'base64');const cur=this.chunk;cur.size+=part.length;if(cur.size>cur.byteLength)return bad('too long');cur.parts.push(part);
  if(cur.parts.length<cur.count)return null;
  this.chunk=null;if(cur.size!==cur.byteLength)return bad('length mismatch');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(cur.parts)));}catch{return bad('not UTF-8 JSON');}
 }
 fail(error){clearTimeout(this.readyTimer);this.rejectReady(error);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 // timeout 0 waits as long as OMP needs (bash, login, handoff).
 async send(command,timeout=30000){await this.ready;if(!this.alive||this.child.stdin.destroyed)throw new Error('OMP process is not running.');const id=randomUUID();return new Promise((resolve,reject)=>{const timer=timeout?setTimeout(()=>{this.pending.delete(id);reject(new Error(`OMP timed out while processing ${command.type}.`));},timeout):undefined;this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...command,id})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});});}
 async reply(frame){await this.ready;if(!this.alive||this.child.stdin.destroyed)throw new Error('OMP process is not running.');return new Promise((resolve,reject)=>this.child.stdin.write(JSON.stringify(frame)+'\n',e=>e?reject(e):resolve()));}
 kill(){this.stopping=true;this.child.stdin.end();this.child.kill('SIGTERM');const t=setTimeout(()=>{if(this.alive)this.child.kill('SIGKILL');},3000);t.unref();}
}
