import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export class RpcProcess {
 constructor(command,args,cwd,onEvent,onExit){
  this.pending=new Map();this.alive=true;this.stopping=false;
  this.child=spawn(command,args,{cwd,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.readyTimer=setTimeout(()=>{this.fail(new Error('OMP did not become ready within 30 seconds. Check your OMP installation.'));this.kill();},30000);
  this.stderr='';
  this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b.toString()).slice(-8000);});
  this.child.stdin.on('error',()=>{});
  this.child.on('error',e=>this.fail(e));
  this.child.on('exit',(code,signal)=>{this.alive=false;clearTimeout(this.readyTimer);const e=new Error(this.stderr.trim()||`OMP exited (${code??signal}).`);this.fail(e);onExit(e,this.stopping);});
  const lines=createInterface({input:this.child.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{
   if(line.length>2*1024*1024){this.fail(new Error('OMP output frame exceeded the supported size.'));return;}
   let frame;try{frame=JSON.parse(line);}catch{return;}
   if(frame.type==='ready'){clearTimeout(this.readyTimer);this.resolveReady();}
   if(frame.type==='response'&&this.pending.has(frame.id)){const p=this.pending.get(frame.id);clearTimeout(p.timer);this.pending.delete(frame.id);frame.success?p.resolve(frame.data):p.reject(new Error(frame.error||'OMP rejected the command.'));}
   onEvent(frame);
  });
 }
 fail(error){clearTimeout(this.readyTimer);this.rejectReady(error);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 async send(command){await this.ready;if(!this.alive||this.child.stdin.destroyed)throw new Error('OMP process is not running.');const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`OMP timed out while processing ${command.type}.`));},30000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...command,id})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});});}
 async reply(frame){await this.ready;if(!this.alive||this.child.stdin.destroyed)throw new Error('OMP process is not running.');return new Promise((resolve,reject)=>this.child.stdin.write(JSON.stringify(frame)+'\n',e=>e?reject(e):resolve()));}
 kill(){this.stopping=true;this.child.stdin.end();this.child.kill('SIGTERM');const t=setTimeout(()=>{if(this.alive)this.child.kill('SIGKILL');},3000);t.unref();}
}
