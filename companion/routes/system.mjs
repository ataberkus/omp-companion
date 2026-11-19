// HTTP routes for this PC: screen sharing status and tickets, shutdown, automatic shutdown and restart.
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { tailnetAddress } from '../network.mjs';
import { now, error } from '../util.mjs';
export function systemRoutes(ctx){
 const {options,autoShutdown,autoShutdownView,checkAutoShutdown,screenSupported,screenTickets,screenOff,shutdownPc,pauseSessions}=ctx;
 return {
   'GET /api/tailscale':async({req,json})=>{
    const ts=ctx.tailscaleLookup?await ctx.tailscaleLookup():null;
    const port=req.socket?.localPort||null;
    const ifaces=(options.networkInterfaces||os.networkInterfaces)();
    const ipv4s=[],ipv6s=[],lan=[];
    for(const list of Object.values(ifaces))for(const n of list||[]){
     if(!n||n.internal)continue;
     if(tailnetAddress(n.address)){if(n.family==='IPv6'||n.family===6)ipv6s.push(n.address);else ipv4s.push(n.address);}
     else if((n.family==='IPv4'||n.family===4)&&!lan.includes(n.address))lan.push(n.address);
    }
    for(const ip of ts?.ips||[]){if(ip.includes(':')){if(!ipv6s.includes(ip))ipv6s.push(ip);}else if(!ipv4s.includes(ip))ipv4s.push(ip);}
    const tailnetUrls=[];
    if(ts?.name&&port)tailnetUrls.push(`http://${ts.name}:${port}`);
    for(const ip of ipv4s)if(port)tailnetUrls.push(`http://${ip}:${port}`);
    for(const ip of ipv6s)if(port)tailnetUrls.push(`http://[${ip}]:${port}`);
    json({port,host:req.headers.host||'',tailscale:ts,tailnetUrls,lanUrls:port?lan.map(ip=>`http://${ip}:${port}`):[]});return;
   },
   'GET /api/screen':async({json})=>{json({supported:screenSupported,enabled:ctx.screenOn,desktop:Boolean(options.desktop),viewer:ctx.viewer&&{address:ctx.viewer.address,since:ctx.viewer.since}});return;},
   'POST /api/screen/ticket':async({req,json})=>{
    if(!screenSupported)throw error('Screen sharing works when the companion runs on Windows.',409);
    if(!ctx.screenOn)throw screenOff();
    for(const [k,t] of screenTickets)if(t.expires<Date.now())screenTickets.delete(k);
    if(screenTickets.size>=20)throw error('Too many screen requests. Try again in a minute.',429);
    const ticket=randomBytes(32).toString('hex');screenTickets.set(ticket,{expires:Date.now()+30000,address:req.socket.remoteAddress});json({ticket});return;
   },
   // Pauses and saves sessions first, like a quit: the OS may kill this process before any signal handler runs.
   // If the OS refuses, the panel keeps working and the paused sessions can be continued.
   'POST /api/shutdown':async({json})=>{await shutdownPc();json({ok:true});return;},
   // Arms or cancels "Shut down PC when all work is done"; arming while nothing is working shuts down right away.
   'POST /api/shutdown/auto':async({body,json})=>{
    if(typeof body.on!=='boolean')throw error('Choose on or off.');
    if(autoShutdown.firing&&!body.on)throw error('The PC is already shutting down.',409);
    if(body.on&&!autoShutdown.on)Object.assign(autoShutdown,{on:true,since:now(),error:null});else if(!body.on)Object.assign(autoShutdown,{on:false,since:null});
    checkAutoShutdown();json(autoShutdownView());return;
   },
   // options.restart (start.bat's loop, see the entry point below, or the desktop app's host) prepares the relaunch and returns the step that stops
   // this process; it runs once the reply is sent. Sessions are paused and saved first, as on quit; the IDs of those that
   // were working go to options.restart, so the next companion resumes them.
   'POST /api/restart':async({res,json})=>{
    if(!options.restart)throw error('Restart works when the companion runs from start.bat or the desktop app, which start it again. Stop it and start it yourself.',409);
    const resume=await pauseSessions();const relaunch=await options.restart(resume);json({ok:true});if(relaunch)res.once('finish',()=>void relaunch());return;
   },
 };
}
