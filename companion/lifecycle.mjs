// Companion lifecycle: background refresh of live sessions, pausing every session, PC shutdown (now or when all
// work is done), the restart after an SDK update, and the busy count the desktop app's quit and update prompts use.
import { now } from './util.mjs';
import { finishWork } from './session-views.mjs';
import { shutdownHost } from './system.mjs';
// Sessions the desktop app's quit and update prompts count as still working: the dashboard's "In panel" set (not hidden),
// with a turn running or queued. review and paused wait for the user, so they don't count.
export const busySessions=sessions=>sessions.filter(s=>!s.hidden&&(s.status==='running'||s.status==='queued')).length;
export function createLifecycle(ctx){
 const {options,store,refresh,locks,persist,scheduleSave,runners,launches,canRestart}=ctx;
 // "Shut down PC when all work is done" (⋯ menu). Process-local, never saved: a restarted companion does not turn the PC off by itself.
 // firing: the /api/shutdown steps are running; error: the OS refused the last automatic attempt (shown by the panel).
 const autoShutdown={on:false,since:null,firing:false,error:null};
 const autoShutdownView=()=>({on:autoShutdown.on,since:autoShutdown.since,firing:autoShutdown.firing,error:autoShutdown.error});
 // Each live session refreshes on its own: one whose OMP holds its command queue (/compact, a handoff, a login waiting
 // for the user) answers get_state only once that ends, and must not hold back every other session's todos, context
 // use and settle check meanwhile. A session keeps at most one refresh in flight.
 const refreshing=new Set();
 // Refreshed state (todos, context use, model) lives in workspace.json and is saved lazily. A transcript change it makes
 // (bindEntries, a settle, a rebuilt history) schedules its own session: naming every live session here made each save
 // serialize every live transcript (megabytes each) just to find most of them unchanged, every 5 s.
 const refreshTimer=setInterval(()=>{if(ctx.closing)return;
  for(const [id,r] of runners){const s=r.alive&&!refreshing.has(id)&&store.sessions.find(x=>x.id===id);if(!s)continue;
   refreshing.add(id);void refresh(s,r).then(()=>{if(!ctx.closing)scheduleSave([],true);},e=>console.error('Background refresh failed:',e.message)).finally(()=>{refreshing.delete(id);checkAutoShutdown();checkAutoRestart();});}
  checkAutoShutdown();checkAutoRestart();},4000);refreshTimer.unref();
 // Every session stops as on quit: running (or queued) ones become paused, the rest keep their status; workspace.json is saved.
 // Resolves with the IDs of the visible sessions it paused: the ones a restart, or the desktop app's update, resumes. close()
 // resolves with them too; shutdown and a plain quit ignore them.
 const pauseSessions=async()=>{ctx.pausing++;try{const paused=[];const stops=[...runners.values()].map(r=>r.kill());for(const s of store.sessions){finishWork(s);delete s._compacting;delete s.uiRequests;if(['running','queued'].includes(s.status)){if(!s.hidden)paused.push(s.id);s.status='paused';}}await Promise.allSettled([...locks.values()]);await persist();await Promise.all(stops);return paused;}finally{ctx.pausing--;}};
 const shutdownPc=async()=>{await pauseSessions();await (options.shutdownHost||shutdownHost)();};
 // Work left: a running or queued turn, or a compaction/handoff/shell command in progress. Queued messages of a running
 // session are covered by its status (and by the session lock while settle() dispatches them); those of a stopped session
 // only go out with the user's next message, so they must not hold the shutdown forever. The panel's isWorking matches.
 const workPending=()=>store.sessions.some(s=>['running','queued'].includes(s.status)||s._task||s._bash);
 // Runs after every settled turn and every background refresh (which catches stops, failures and exits). A held lock or a
 // starting runner means a prompt is mid-flight, so it waits for the next check. Fires at most once per arming.
 function checkAutoShutdown(){
  if(!autoShutdown.on||autoShutdown.firing||ctx.closing||ctx.pausing||locks.size||launches.size||workPending())return;
  autoShutdown.firing=true;
  void shutdownPc().catch(e=>{autoShutdown.error={message:e.message,at:now()};console.error('Automatic shutdown failed:',e.message);}).finally(()=>Object.assign(autoShutdown,{on:false,since:null,firing:false}));
 }
 // A newly installed OMP SDK loads only in a new process: restart (start.bat's loop, the desktop app) once no work is running, so nothing is cut off.
 let restartPending=false;
 function restartWhenIdle(){if(canRestart){restartPending=true;checkAutoRestart();}}
 function checkAutoRestart(){
  if(!restartPending||autoShutdown.firing||ctx.closing||ctx.pausing||locks.size||launches.size||workPending())return;
  restartPending=false;console.log('Restarting the companion to run the updated OMP.');
  void (async()=>{const resume=await pauseSessions();const relaunch=await options.restart(resume);await relaunch?.();})().catch(e=>console.error('Automatic restart failed:',e.message));
 }
 return {autoShutdown,autoShutdownView,checkAutoShutdown,restartWhenIdle,refreshTimer,shutdownPc,pauseSessions};
}
