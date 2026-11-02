// OMP Control Room companion: the entry point (`node companion/server.mjs`, `bun companion/server.mjs`, start.bat)
// and createCompanion(), which wires the modules beside this file into one companion per call. The domain code
// lives in those modules; this file keeps the public API (createCompanion, internals and the helpers re-exported below).
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { ompHost } from './omp.mjs';
import { exec, syncFile } from './util.mjs';
import { createToolImages } from './images.mjs';
import { todoPhases } from './session-views.mjs';
import { treeView } from './transcript.mjs';
import { addInstallDirs, shutdownCommand, restartHandoff, editorUrl } from './system.mjs';
import { gitDiffFiles } from './git.mjs';
import { launchOptions, launchArgs } from './launch.mjs';
import { ENHANCE_OVERLAY, ENHANCE_SYSTEM, ENHANCE_GUARD } from './enhance-prompts.mjs';
import { createEnhance, enhanceModel, enhanceArgs, enhanceInput, stepLabel, cleanEnhanced } from './enhance.mjs';
import { createScreen, screenCommands } from './screen.mjs';
import { createOriginCheck, tailnetAddress, tailscaleSelf, portBusy } from './network.mjs';
import { updateOmp, defaultDataDir, startupUpdate } from './update.mjs';
import { createCliJobs } from './cli-tools.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { openStore } from './store.mjs';
import { createDrafts } from './drafts.mjs';
import { createMessages } from './messages.mjs';
import { createSlashCommands } from './slash-commands.mjs';
import { createAccounts } from './accounts.mjs';
import { createRateLimit } from './rate-limit.mjs';
import { createRunner } from './runner.mjs';
import { createSessionCommand } from './session-command.mjs';
import { createSettings } from './settings.mjs';
import { createPlugins } from './plugins.mjs';
import { createSync } from './sync.mjs';
import { createHistory } from './history.mjs';
import { createSpend } from './spend.mjs';
import { busySessions, createLifecycle } from './lifecycle.mjs';
import { createStatic } from './routes/static.mjs';
import { createRouter } from './router.mjs';
export { addInstallDirs, busySessions, portBusy, startupUpdate, tailnetAddress, tailscaleSelf, updateOmp };
addInstallDirs();
// Pure helpers, exported for tests.
export const internals={launchOptions,launchArgs,treeView,todoPhases,enhanceModel,enhanceArgs,enhanceInput,stepLabel,cleanEnhanced,ENHANCE_OVERLAY,ENHANCE_SYSTEM,ENHANCE_GUARD,gitDiffFiles,editorUrl,shutdownCommand,restartHandoff,screenCommands};
export async function createCompanion(options={}){
 // OMP_WEB_PASSWORD: a password you choose becomes the connection token, so the same Bearer check enforces it. It is never served in the page.
 const password=options.password??process.env.OMP_WEB_PASSWORD??'';
 if(password&&!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(password))throw new Error('OMP_WEB_PASSWORD must be printable ASCII without leading or trailing spaces (browsers cannot send other characters in the Authorization header).');
 const token=options.token||password||randomBytes(32).toString('hex');
 // OMP_WEB_NO_TOKEN=1 embeds the token in the served page: any device that can reach the port gets full control. A password turns it off.
 const exposeToken=!password&&(options.exposeToken??process.env.OMP_WEB_NO_TOKEN==='1');
 // OMP_WEB_PUBLIC_HOSTS: extra host names (a Tailscale MagicDNS name, say) accepted in Host and Origin by exact match on the port.
 const publicHosts=(options.publicHosts||String(process.env.OMP_WEB_PUBLIC_HOSTS||'').split(',')).map(h=>h.trim().toLowerCase()).filter(Boolean);
 for(const h of publicHosts)if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h))throw new Error(`OMP_WEB_PUBLIC_HOSTS: "${h}" is not a host name (give names like pc.tailnet.ts.net, without scheme or port).`);
 const dataDir=options.dataDir||defaultDataDir();
 // OMP_BIN may point at the native executable or a source checkout's cli.ts. Sessions run OMP in-process (its SDK: the
 // checkout's, else the newest SDK copy startupUpdate installed in dataDir, else the bundled @oh-my-pi/pi-coding-agent);
 // the CLI still runs updates, usage, enhance and the Tools page.
 const ompEntry=options.ompCommand||process.env.OMP_BIN||'omp',ompSource=/\.ts$/i.test(ompEntry);
 const ompExecutable=ompSource?'bun':ompEntry,ompPrefix=ompSource?[path.resolve(ompEntry)]:[];
 const execOmp=(args,opts)=>exec(ompExecutable,[...ompPrefix,...args],opts);
 const omp=options.omp||ompHost(ompEntry,{dataDir});omp.warm?.();
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const enhanceOverlay=path.join(dataDir,'enhance-overlay.yml'),enhanceSystem=path.join(dataDir,'enhance-system.md'),enhanceGuard=path.join(dataDir,'enhance-guard.mjs');
 await syncFile(enhanceOverlay,ENHANCE_OVERLAY);await syncFile(enhanceSystem,ENHANCE_SYSTEM);await syncFile(enhanceGuard,ENHANCE_GUARD);
 // Shared state of this companion. Each module below adds its functions (and getters for state it owns); a module
 // calls one created after it through ctx. Kept per companion: tests run several in one process.
 const ctx={options,password,token,exposeToken,publicHosts,dataDir,ompEntry,ompSource,ompExecutable,ompPrefix,execOmp,omp,enhanceOverlay,enhanceSystem,enhanceGuard};
 const use=api=>Object.defineProperties(ctx,Object.getOwnPropertyDescriptors(api));
 use(await openStore(ctx));
 use(await createDrafts(ctx));
 const allowedOrigins=new Set(options.allowedOrigins||String(process.env.OMP_ALLOWED_ORIGINS||'').split(',').filter(Boolean));
 const runners=new Map();const launches=new Map();const locks=new Map();ctx.closing=false;ctx.pausing=0;
 // A new id per process: a dashboard that asked for a restart knows the new companion answers once this changes.
 const instance=randomUUID(),canRestart=typeof options.restart==='function';
 // Only the current thought is live; completed messages remain in OMP's transcript.
 const subagentThoughts=new Map();
 Object.assign(ctx,{allowedOrigins,runners,launches,locks,instance,canRestart,subagentThoughts});
 use(createToolImages(ctx));
 use(createMessages(ctx));
 use(createSlashCommands(ctx));
 use(createAccounts(ctx));
 use(createRateLimit(ctx));
 use(createRunner(ctx));
 use(createSessionCommand(ctx));
 use(createSettings(ctx));
 use(createPlugins(ctx));
 use(createEnhance(ctx));
 use(createWorkspaces(ctx));
 use(createSync(ctx));
 use(createHistory(ctx));
 use(createSpend(ctx));
 use(createCliJobs(ctx));
 use(createOriginCheck(ctx));
 use(createScreen(ctx));
 use(createStatic(ctx));
 use(createLifecycle(ctx));
 use(createRouter(ctx));
 const {store,persist,saveNow,commandProbes,armResume,resumeAfterRestart,discardDraft,restartWhenIdle,cliProcs,stopAllEnhance,refreshTimer,accountTimer,setScreen,dropViewer,onRequest,pauseSessions,onUpgrade}=ctx;
 // serve(): one more listener for this companion (the desktop app's tailnet address), sharing its sessions, token and screen;
 // Host/Origin follow the address each listener is bound to. close() closes every one.
 const servers=new Set();
 const serve=()=>{const srv=createServer((req,res)=>onRequest(req,res,srv));srv.on('upgrade',(req,socket,head)=>onUpgrade(req,socket,head,srv));servers.add(srv);return srv;};
 const server=serve();
 // The screen viewer goes first: an open WebSocket would keep server.close() waiting forever. Resolves with the IDs of the
 // visible sessions it paused (pauseSessions): the desktop app's update quit hands them to the new version to resume.
 const close=async()=>{ctx.closing=true;clearInterval(refreshTimer);clearTimeout(accountTimer);dropViewer(1001,'The companion is closing.');for(const c of cliProcs.values())c.kill();clearTimeout(ctx.saveTimer);const enhanceStops=stopAllEnhance();const probeStops=[...commandProbes].map(r=>r.kill());const sessionStops=pauseSessions();await Promise.all([...servers].filter(s=>s.listening).map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));const paused=await sessionStops;await Promise.all(probeStops);await enhanceStops;await ctx.branchRun;return paused;};
 // Drafts left by a closed tab or a crash: the in-tab draft text is gone, so the session would come back empty.
 for(const s of store.sessions.filter(x=>x.draft))await discardDraft(s).catch(e=>console.error('Draft cleanup failed:',e.message));
 // A rate-limit resume saved before a restart: re-armed; one already due fires right away.
 for(const s of store.sessions)if(s.rateLimitResume)armResume(s);
 // Sessions that were working when the last companion restarted or the desktop app updated (options.resume, from the restart
 // or update note) carry on; a rate-limit wait is re-armed above instead. Normal starts, quits and crash recovery pass none, so they stay paused.
 {const resume=new Set(Array.isArray(options.resume)?options.resume:[]);
  for(const s of store.sessions)if(resume.has(s.id)&&s.status==='paused'&&!s.hidden&&!s.rateLimitResume)void resumeAfterRestart(s).catch(e=>console.error('Automatic resume failed:',e.message));}
// closeScreen: the desktop host rebinds the server (LAN toggle), which an open screen WebSocket would block; the viewer reconnects if still allowed.
// flush: runs any batched save now and resolves once everything changed so far is on disk.
await persist();return {server,serve,store,token,password:Boolean(password),close,flush:saveNow,setScreen,restartWhenIdle,closeScreen:()=>dropViewer(1001,'The companion changed its network access.')};
}
const mainEntry=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
// Sessions run OMP's SDK, which needs Bun: started by Node, the companion runs itself under Bun with the same arguments
// and passes Bun's exit code on (start.bat's restart code included). Ctrl+C reaches both; the child does the shutdown.
if(mainEntry&&!process.versions.bun){
 const child=spawn('bun',[fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit'});
 process.on('SIGINT',()=>{});process.on('SIGTERM',()=>child.kill('SIGTERM'));
 child.on('error',e=>{console.error(e.code==='ENOENT'?'\nThe companion needs Bun to run OMP sessions, and bun was not found on PATH. Install it from https://bun.sh and try again.\n':`\nCould not start Bun: ${e.message}\n`);process.exit(1);});
 child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
}
if(mainEntry&&process.versions.bun){
 const port=Number(process.env.OMP_WEB_PORT||4545);const host=process.env.OMP_WEB_HOST||'127.0.0.1';const wild=host==='0.0.0.0'||host==='::';
 const inUse=`\nPort ${port} is already in use: the companion is probably already running at http://127.0.0.1:${port}/\nClose it, or set OMP_WEB_PORT to use another port.\n`;
 // Probe before createCompanion: it pauses running sessions and saves workspace.json, which would clobber the live companion's state.
 if(await portBusy(port)){console.error(inUse);process.exit(1);}
 // start.bat sets OMP_WEB_RESTART_EXIT and starts the companion again when it exits with that code (Restart companion).
 const restartExit=Number(process.env.OMP_WEB_RESTART_EXIT)||0;
 const handoffFile=path.join(process.env.OMP_WEB_DATA_DIR||path.join(os.homedir(),'.omp-web'),'restart.json');
 let handoff=null;
 if(restartExit){handoff=restartHandoff(await fs.readFile(handoffFile,'utf8').catch(()=>''),Date.now());await fs.rm(handoffFile,{force:true});}
 // A restart skips the OMP update check (Settings has one-click omp update) and keeps the token, so open panels reconnect.
 const update=handoff?null:await startupUpdate();
 const app=await createCompanion({
  ...(handoff?.token&&!process.env.OMP_WEB_PASSWORD?{token:handoff.token}:{}),
  // Sessions that were working when the restart began; createCompanion resumes those it still has.
  ...(handoff?.resume?{resume:handoff.resume}:{}),
  ...(restartExit?{restart:async resume=>{
   // A password is the token, so only a random per-launch token is handed over; it never outlives the restart.
   await fs.mkdir(path.dirname(handoffFile),{recursive:true,mode:0o700});
   await fs.writeFile(handoffFile,JSON.stringify({at:Date.now(),...(app.password?{}:{token:app.token}),...(resume?.length?{resume}:{})}),{mode:0o600});
   // Exit with the restart code even if close() fails, so start.bat still starts the companion again.
   return async()=>{try{await app.close();}finally{process.exit(restartExit);}};
  }}:{}),
  // Remote control should never be silent on the PC itself.
  onScreen:v=>console.log(v?`Screen: ${v.address} is now viewing and controlling this PC.`:'Screen: the viewer disconnected.'),
 });
 update?.sdkLate?.then(r=>r.status==='installed'&&app.restartWhenIdle());
 app.server.listen(port,host,async()=>{
  // The token travels in the URL fragment, which browsers never send to the server or in Referer headers. A password is never printed.
  const frag=process.env.OMP_WEB_NO_TOKEN==='1'||app.password?'':`#token=${app.token}`;
  const link=`http://${wild?'127.0.0.1':host}:${port}/${frag}`;
  const lan=wild?Object.values(os.networkInterfaces()).flat().filter(n=>n.family==='IPv4'&&!n.internal).map(n=>`http://${n.address}:${port}/${frag}`):[];
  const extra=String(process.env.OMP_WEB_PUBLIC_HOSTS||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean).map(h=>`http://${h}:${port}/${frag}`);
  // This PC's MagicDNS name works without OMP_WEB_PUBLIC_HOSTS while the companion listens on its tailnet address.
  const ts=wild||tailnetAddress(host)?await tailscaleSelf():null;
  const tailnet=ts?.name&&(wild||ts.ips.includes(host))?[`http://${ts.name}:${port}/${frag}`]:[];
  const auth=app.password?'Password required (OMP_WEB_PASSWORD).\n':frag?`Connection token: ${app.token}\n`:'No token required: anyone who can reach this port has full control.\n';
  const screen=process.env.OMP_WEB_SCREEN!=='1'?'':process.platform==='win32'?'Screen sharing is on (OMP_WEB_SCREEN=1): the password or token also lets a device see and control this PC.\n':'OMP_WEB_SCREEN is ignored: screen sharing works on Windows only.\n';
  console.log(`\nOMP Control Room\n\nOpen: ${link}\n${lan.map(l=>`LAN:  ${l}\n`).join('')}${tailnet.map(l=>`Tailscale: ${l}\n`).join('')}${extra.map(l=>`Host: ${l}\n`).join('')}${auth}${screen}\nYour provider credentials remain in OMP. Keep this process running.\n`);
  // After a restart the dashboard that asked for it reconnects by itself, so no second browser tab.
  if(!process.env.OMP_WEB_NO_OPEN&&!handoff){const [cmd,args]=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',link]]:process.platform==='darwin'?['open',[link]]:['xdg-open',[link]];execFile(cmd,args,{windowsHide:true},()=>{});}
 });
 app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?inUse:`\nThe companion could not start: ${e.message}\n`);process.exit(1);});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
