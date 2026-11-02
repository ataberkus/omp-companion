// Networking: Tailscale addresses and names, the port probe, and the Host/Origin gate for requests and the
// screen WebSocket.
import { connect } from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { exec, error } from './util.mjs';
// Tailscale's address ranges: IPv4 100.64.0.0/10 (CGNAT) and IPv6 fd7a:115c:a1e0::/48.
export const tailnetAddress=a=>/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(a)||/^fd7a:115c:a1e0:/i.test(a);
// This PC's MagicDNS name and tailnet addresses from `tailscale status --json`, or null (not installed, not running, logged out).
export async function tailscaleSelf(){
 const bins=process.platform==='win32'?['tailscale',path.join(process.env.ProgramFiles||'C:\\Program Files','Tailscale','tailscale.exe')]:process.platform==='darwin'?['tailscale','/Applications/Tailscale.app/Contents/MacOS/Tailscale']:['tailscale'];
 for(const bin of bins){
  let out;try{out=(await exec(bin,['status','--json','--peers=false'],{timeout:5000,maxBuffer:4*1024*1024,windowsHide:true})).stdout;}catch(e){if(e.code==='ENOENT')continue;return null;}
  try{
   const s=JSON.parse(out);if(s.BackendState!=='Running')return null;
   const name=String(s.Self?.DNSName||'').replace(/\.$/,'').toLowerCase(),ips=(s.Self?.TailscaleIPs||[]).filter(ip=>typeof ip==='string'&&tailnetAddress(ip));
   return {name:/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)?name:'',ips};
  }catch{return null;}
 }
 return null;
}
// Connect probe, not a bind: Windows lets 127.0.0.1:N bind beside another process's 0.0.0.0:N. No answer within timeoutMs counts as busy.
export function portBusy(port,host='127.0.0.1',timeoutMs=1000){return new Promise(resolve=>{const s=connect(port,host);const done=busy=>{clearTimeout(t);s.destroy();resolve(busy);};const t=setTimeout(()=>done(true),timeoutMs);s.once('connect',()=>done(true));s.once('error',()=>done(false));});}
export function createOriginCheck(ctx){
 const {options,publicHosts,allowedOrigins}=ctx;
 // This PC's Tailscale name and addresses, looked up at most once a minute; options.tailscale replaces the lookup (tests).
 // A known answer is used at once and refreshed in the background once a minute old: a phone on the MagicDNS name waited
 // for `tailscale status` once a minute. A refresh that finds nothing (tailscaled reconnecting, a timeout) keeps it until
 // the last good lookup is 5 minutes old; caching that null refused such phones for a minute. With no answer known
 // (Tailscale not running), a request waits for the lookup, as before.
 let tsCache=null,tsAt=0,tsGood=0,tsPending;
 const lookup=()=>tsPending??=(options.tailscale||tailscaleSelf)().catch(()=>null).then(v=>{const t=Date.now();if(v)tsGood=t;if(v||t-tsGood>=300000)tsCache=v;tsAt=t;tsPending=undefined;return tsCache;});
 const tailscale=()=>{if(Date.now()-tsAt<60000)return Promise.resolve(tsCache);if(!tsCache)return lookup();void lookup();return Promise.resolve(tsCache);};
 // Host/Origin gate for API requests and the screen WebSocket (CORS doesn't cover WebSockets, so its Origin check matters most),
 // against the address of the listener `srv` that took the request.
 // Bound to all interfaces (OMP_WEB_HOST=0.0.0.0): also accept this machine's adapter addresses, still rejecting DNS-rebinding names.
 // OMP_WEB_PUBLIC_HOSTS names are matched exactly too, so any other name (DNS rebinding) is still refused. So is this PC's own
 // MagicDNS name while the companion listens on its tailnet address: only the tailnet resolves it, to this PC.
 const networkInterfaces=options.networkInterfaces||os.networkInterfaces;// tests pass this PC's adapters
 async function checkOrigin(req,srv){
  const a=srv.address(),port=a?.port,wild=a&&['0.0.0.0','::'].includes(a.address),names=new Set(['127.0.0.1','localhost',...publicHosts]);
  if(wild){for(const list of Object.values(networkInterfaces()))for(const n of list||[])names.add(n.family==='IPv6'?`[${n.address}]`:n.address);}else if(a?.address)names.add(a.family==='IPv6'?`[${a.address}]`:a.address);
  const host=String(req.headers.host||'').toLowerCase(),origin=req.headers.origin;
  const allowed=()=>{const hosts=new Set([...names].map(n=>`${n}:${port}`));return {host:hosts.has(host),origin:!origin||allowedOrigins.has(origin)||hosts.has(origin.replace(/^http:\/\//,''))&&origin.startsWith('http://')};};
  let ok=allowed();
  // The MagicDNS name is only looked up when nothing else matched, so requests to 127.0.0.1 or a LAN address never wait for it.
  if(!(ok.host&&ok.origin)&&a&&(wild||tailnetAddress(a.address))){const ts=await tailscale();if(ts?.name&&(wild||ts.ips.includes(a.address))){names.add(ts.name);ok=allowed();}}
  if(!ok.host)throw error('Invalid Host header.',403);
  if(!ok.origin)throw error('Origin not allowed. Open the local dashboard or set OMP_ALLOWED_ORIGINS to the exact hosted origin.',403);
  return {origin,host};
 }
 return {checkOrigin};
}
