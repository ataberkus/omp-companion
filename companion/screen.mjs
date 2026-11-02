// Screen sharing: viewer input as helper commands, the helper process, and the single-viewer WebSocket
// (/api/screen/ws) with its ticket check.
import { STATUS_CODES } from 'node:http';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { now, error, syncFile } from './util.mjs';
import { SCREEN_HELPER } from './screen-helper.mjs';
// KeyboardEvent.code → Windows virtual-key code; 0x100 marks keys sent with the extended flag. A Map, so no viewer-sent
// name can reach Object.prototype. Codes are physical key positions: this PC's keyboard layout decides the character.
const SCREEN_KEYS=new Map(Object.entries({Backspace:8,Tab:9,Enter:13,NumpadEnter:0x10d,ShiftLeft:0xa0,ShiftRight:0xa1,ControlLeft:0xa2,ControlRight:0x1a3,AltLeft:0xa4,AltRight:0x1a5,MetaLeft:0x15b,MetaRight:0x15c,ContextMenu:0x15d,
 Pause:0x13,CapsLock:0x14,Escape:0x1b,Space:0x20,PageUp:0x121,PageDown:0x122,End:0x123,Home:0x124,ArrowLeft:0x125,ArrowUp:0x126,ArrowRight:0x127,ArrowDown:0x128,PrintScreen:0x12c,Insert:0x12d,Delete:0x12e,NumLock:0x190,ScrollLock:0x91,
 Semicolon:0xba,Equal:0xbb,Comma:0xbc,Minus:0xbd,Period:0xbe,Slash:0xbf,Backquote:0xc0,BracketLeft:0xdb,Backslash:0xdc,BracketRight:0xdd,Quote:0xde,IntlBackslash:0xe2,
 NumpadMultiply:0x6a,NumpadAdd:0x6b,NumpadSubtract:0x6d,NumpadDecimal:0x6e,NumpadDivide:0x16f,AudioVolumeMute:0x1ad,AudioVolumeDown:0x1ae,AudioVolumeUp:0x1af,MediaTrackNext:0x1b0,MediaTrackPrevious:0x1b1,MediaStop:0x1b2,MediaPlayPause:0x1b3}));
for(let i=0;i<26;i++)SCREEN_KEYS.set('Key'+String.fromCharCode(65+i),65+i);
for(let i=0;i<10;i++){SCREEN_KEYS.set('Digit'+i,48+i);SCREEN_KEYS.set('Numpad'+i,0x60+i);}
for(let i=1;i<=24;i++)SCREEN_KEYS.set('F'+i,0x6f+i);
// One viewer message as helper command lines; '' for anything malformed. Pointer positions are 0..1 across the shared monitor.
export function screenCommands(m){
 if(!m||typeof m!=='object')return '';
 const num=(v,lo,hi)=>typeof v==='number'&&Number.isFinite(v)?Math.round(Math.min(hi,Math.max(lo,v))):null;
 const at=()=>{const x=num(typeof m.x==='number'?m.x*65535:NaN,0,65535),y=num(typeof m.y==='number'?m.y*65535:NaN,0,65535);return x===null||y===null?null:`m ${x} ${y}\n`;};
 const key=(code,down)=>{const k=SCREEN_KEYS.get(code);return k===undefined?'':`k ${k&0xff} ${k>>8} ${down?1:0}\n`;};
 switch(m.t){
  case 'ack':return 'f 1\n';
  case 'refresh':return 'r\n';
  case 'release':return 'x\n';
  case 'move':return at()||'';
  case 'button':{if(![0,1,2].includes(m.b)||typeof m.down!=='boolean')return '';const move=m.x===undefined&&m.y===undefined?'':at();return move===null?'':move+`b ${m.b} ${m.down?1:0}\n`;}
  case 'wheel':{const dy=num(m.dy??0,-2400,2400),dx=num(m.dx??0,-2400,2400);return dy===null||dx===null||!dy&&!dx?'':`w ${dy} ${dx}\n`;}
  case 'key':return typeof m.code==='string'&&typeof m.down==='boolean'?key(m.code,m.down):'';
  // Typed text goes as Unicode characters, independent of this PC's layout; line breaks and tabs press Enter and Tab.
  case 'text':{
   if(typeof m.text!=='string'||m.text.length>2000)return '';
   let out='',run=[];const flush=()=>{for(let i=0;i<run.length;i+=64)out+='t '+run.slice(i,i+64).join(' ')+'\n';run=[];};
   for(const ch of m.text.replace(/\r\n?/g,'\n')){
    if(ch==='\n'||ch==='\t'){flush();const c=ch==='\n'?'Enter':'Tab';out+=key(c,true)+key(c,false);}
    else if(ch>=' '&&ch!=='\x7f')for(let i=0;i<ch.length;i++)run.push(ch.charCodeAt(i).toString(16));
   }
   flush();return out;
  }
  case 'config':{const mon=num(m.monitor??-1,-1,63),w=num(m.width??1280,320,7680),q=num(m.quality??60,10,95);return mon===null||w===null||q===null?'':`c ${mon} ${w} ${q}\n`;}
 }
 return '';
}
export function createScreen(ctx){
 const {options,dataDir,checkOrigin}=ctx;
 // ---------- screen sharing ----------
 // Off unless turned on: OMP_WEB_SCREEN=1, or the desktop app's tray item (setScreen). Seeing and controlling the PC takes the
 // same token and Host/Origin checks as the API: POST /api/screen/ticket (token) returns a 30-second, single-use ticket bound to
 // the caller's address, which opens the WebSocket at /api/screen/ws (browsers can't put an Authorization header on one).
 // One viewer at a time: a new one replaces the previous, so two devices never fight over the mouse.
 const screenSupported=Boolean(options.screenCommand)||process.platform==='win32';
 let screenOn=screenSupported&&Boolean(options.screen??process.env.OMP_WEB_SCREEN==='1'),viewer=null;
 const screenTickets=new Map();
 const screenOff=()=>error(options.desktop?'Screen sharing is off. Turn on "Allow screen sharing and control" in the OMP Control Room tray menu on this PC.':'Screen sharing is off. Start the companion with OMP_WEB_SCREEN=1 on this PC to allow it.',409);
 const peer=a=>String(a||'').replace(/^::ffff:/,'');
 const wsSend=(socket,op,data)=>{
  if(socket.destroyed||!socket.writable)return;const n=data.length,h=Buffer.alloc(n<126?2:n<65536?4:10);h[0]=0x80|op;
  if(n<126)h[1]=n;else if(n<65536){h[1]=126;h.writeUInt16BE(n,2);}else{h[1]=127;h.writeBigUInt64BE(BigInt(n),2);}
  socket.cork();socket.write(h);socket.write(data);socket.uncork();
 };
 const wsClose=(socket,code,reason)=>{const r=Buffer.from(String(reason)).subarray(0,123),p=Buffer.alloc(2+r.length);p.writeUInt16BE(code);r.copy(p,2);wsSend(socket,8,p);socket.end();setTimeout(()=>socket.destroy(),2000).unref();};
 // notify=false: a takeover, where onScreen reports the new viewer right after (no "nobody is viewing" in between).
 function dropViewer(code=1000,reason='',notify=true){
  const v=viewer;if(!v)return;viewer=null;clearInterval(v.ping);
  if(!v.socket.destroyed)wsClose(v.socket,code,reason);
  const h=v.helper;if(h&&h.exitCode===null){h.stdin.end('x\nq\n');const t=setTimeout(()=>h.kill(),3000);t.unref();h.once('exit',()=>clearTimeout(t));}
  if(notify)try{options.onScreen?.(null);}catch(e){console.error('Screen hook failed:',e.message);}
 }
 // Commands wait in `queue` until the helper exists; frame credits start with the viewer's first config, so no frame is captured at the wrong size.
 const toHelper=(v,s)=>{if(!s)return;if(v.helper)v.helper.stdin.write(s);else v.queue+=s;};
 function startHelper(v){
  const [cmd,args]=options.screenCommand||[path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:OMP_SCREEN_SOURCE)) -ReferencedAssemblies System.Drawing,System.Windows.Forms; [OmpScreenHelper]::Run()']];
  const source=path.join(dataDir,'screen-helper.cs');
  return (options.screenCommand?Promise.resolve():syncFile(source,SCREEN_HELPER)).then(()=>{
   if(viewer!==v)return;
   const h=v.helper=spawn(cmd,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,OMP_SCREEN_SOURCE:source}});
   let out=Buffer.alloc(0),err='';
   h.stdin.on('error',()=>{});h.stderr.on('data',d=>{err=(err+d).slice(-2000);});
   h.stdout.on('data',d=>{
    out=out.length?Buffer.concat([out,d]):d;
    while(out.length>=4){
     const n=out.readUInt32LE(0);if(n>64*1024*1024){h.kill();return;}if(out.length<4+n)break;
     const msg=out.subarray(4,4+n);out=out.subarray(4+n);
     if(viewer===v)msg[0]===1?wsSend(v.socket,2,msg):wsSend(v.socket,1,msg.subarray(1));
    }
   });
   h.on('error',e=>{err=e.message;});
   h.on('close',code=>{if(viewer===v)dropViewer(1011,`Screen capture stopped (${err.trim().split('\n').pop()||`exit code ${code}`}).`);});
   h.stdin.write(v.queue);v.queue='';
  });
 }
 function startViewer(socket,head,address){
  if(viewer)dropViewer(4001,'Another device is now viewing this PC.',false);
  const v={socket,address:peer(address),since:now(),lastSeen:Date.now(),buf:Buffer.from(head),queue:'',started:false};
  viewer=v;socket.setNoDelay(true);
  socket.on('close',()=>{if(viewer===v)dropViewer();});
  socket.on('data',d=>{v.lastSeen=Date.now();v.buf=v.buf.length?Buffer.concat([v.buf,d]):d;readViewer(v);});
  // Browsers answer pings by themselves: a viewer that stops answering (phone asleep, network gone) frees the PC after 45 s.
  v.ping=setInterval(()=>{if(Date.now()-v.lastSeen>45000)dropViewer(1001,'The viewer stopped answering.');else wsSend(socket,9,Buffer.alloc(0));},15000);v.ping.unref();
  try{options.onScreen?.({address:v.address});}catch(e){console.error('Screen hook failed:',e.message);}
  startHelper(v).catch(e=>{if(viewer===v)dropViewer(1011,`Screen capture could not start: ${e.message}`);});
  readViewer(v);
 }
 // Client frames are masked; only small, unfragmented text messages are accepted (input events and acks).
 function readViewer(v){
  while(viewer===v&&v.buf.length>=2){
   const b=v.buf,op=b[0]&15;let n=b[1]&127,off=2;
   if(!(b[0]&0x80)||!(b[1]&0x80)||n===127)return dropViewer(1002,'Unsupported WebSocket frame.');
   if(n===126){if(b.length<4)return;n=b.readUInt16BE(2);off=4;}
   if(n>65536)return dropViewer(1009,'Message too large.');
   if(b.length<off+4+n)return;
   const mask=b.subarray(off,off+4),data=Buffer.from(b.subarray(off+4,off+4+n));for(let i=0;i<n;i++)data[i]^=mask[i&3];
   v.buf=b.subarray(off+4+n);
   if(op===8)return dropViewer();
   if(op===9){wsSend(v.socket,10,data);continue;}
   if(op!==1)continue;
   let m;try{m=JSON.parse(data.toString('utf8'));}catch{continue;}
   toHelper(v,screenCommands(m));
   if(m?.t==='config'&&!v.started){v.started=true;toHelper(v,'f 2\n');}
  }
 }
 // The desktop app's tray turns screen sharing on and off at runtime; turning it off ends a running view at once.
 const setScreen=on=>{screenOn=screenSupported&&Boolean(on);if(!screenOn){screenTickets.clear();dropViewer(4002,'Screen sharing was turned off on this PC.');}return screenOn;};
 // The screen WebSocket: same Host/Origin gate as every request, then a ticket that only the token could buy (POST /api/screen/ticket).
 async function onUpgrade(req,socket,head,srv){
  socket.on('error',()=>{});
  try{
   await checkOrigin(req,srv);
   const url=new URL(req.url,'http://localhost');
   if(url.pathname!=='/api/screen/ws')throw error('Route not found.',404);
   if(ctx.closing)throw error('The companion is closing.',503);
   if(!screenOn)throw screenOff();
   const id=url.searchParams.get('ticket')||'',t=screenTickets.get(id);screenTickets.delete(id);
   if(!t||t.expires<Date.now()||t.address!==req.socket.remoteAddress)throw error('Screen ticket missing or expired. Open the Screen page again.',401);
   const key=String(req.headers['sec-websocket-key']||'');
   if(String(req.headers.upgrade).toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||!/^[A-Za-z0-9+/]{22}==$/.test(key))throw error('WebSocket handshake required.',400);
   socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`);
   startViewer(socket,head,req.socket.remoteAddress);
  // Destroyed 2 s later as in wsClose: a peer that went offline never closes its side, which would keep the socket open forever.
  }catch(e){const status=e.status||500;socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${e.message}`);setTimeout(()=>socket.destroy(),2000).unref();}
 }
 return {setScreen,screenSupported,screenTickets,screenOff,dropViewer,onUpgrade,get viewer(){return viewer;},get screenOn(){return screenOn;}};
}
