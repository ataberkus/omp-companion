// Workspace persistence: workspace.json plus one transcript file per session under the data dir. Loads and
// normalizes the store at startup, reads transcripts on first use, and serializes saves (persist, scheduleSave).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { now, replaceFile } from './util.mjs';
import { finishWork } from './session-views.mjs';
import { EDITOR_CHOICES } from './system.mjs';
import { colors, projectColor } from './workspaces.mjs';
export async function openStore(ctx){
 const {dataDir}=ctx;
 const stateFile=path.join(dataDir,'workspace.json');
 // Each session's transcript (s.messages: ~99% of the bytes, 100+ MB with a few hundred sessions) is its own transcripts/<id>.json;
 // workspace.json keeps the rest (well under 1 MB). One file for everything meant every event's save stringified ~100 MB
 // (~300 ms of CPU) and rewrote it with flush (seconds each), back to back: 100% disk while sessions streamed.
 const transcriptDir=path.join(dataDir,'transcripts');
 const transcriptFile=id=>path.join(transcriptDir,(/^[\w-]{1,100}$/.test(id)?id:createHash('sha256').update(String(id)).digest('hex'))+'.json');
 // A companion killed mid-save (console closed, Task Manager) leaves its <file>.<pid>.tmp behind; no later process reuses that name.
 // Only dead PIDs' files go: a live companion sharing this dir may be writing its own. Also the pre-PID shared workspace.json.tmp.
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
 for(const f of await fs.readdir(dataDir)){const m=/^workspace\.json\.(?:(\d+)\.)?tmp$/.exec(f);if(m&&!(m[1]&&alive(Number(m[1]))))await fs.rm(path.join(dataDir,f),{force:true}).catch(()=>{});}
 for(const f of await fs.readdir(transcriptDir).catch(()=>[])){const m=/\.json\.(\d+)\.tmp$/.exec(f);if(m&&!alive(Number(m[1])))await fs.rm(path.join(transcriptDir,f),{force:true}).catch(()=>{});}
 let store;
 try{store=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error(`Cannot read workspace: ${e.message}`);store={projects:[],sessions:[],activity:[]};}
 // Transcripts as last written, by session ID: a digest of each one's JSON, so a save rewrites only those that changed (the
 // JSON itself, kept for that comparison, cost as much memory as the transcripts). A workspace.json from before the split
 // still embeds them; those sessions have no entry here, so the first save moves them out.
 const savedTranscripts=new Map(),textDigest=text=>createHash('sha1').update(text).digest('base64');
 // The same digests as saved with workspace.json (persist), for the startup check below; kept out of the store, which
 // /api/state sends.
 const recorded=store.transcriptDigests&&typeof store.transcriptDigests==='object'?store.transcriptDigests:{};delete store.transcriptDigests;
 // Every transcript is read and checked at startup (one that does not parse stops the companion), eight at a time, but kept
 // only once something reads it: 400 sessions' transcripts held at once cost more memory than the rest of the companion
 // (~400 MB parsed for 160 MB of files) and slowed every garbage collection. Until then s.messages reads it from disk on
 // first use (deferTranscript). Parsing them all took most of a start (0.5-1 s for 100+ MB): a file whose bytes match the
 // digest recorded when it was written is that valid JSON, so only the others are parsed (a changed, truncated or older file).
 // Review sessions' edit/write tool file records ({path}) are noted on the way, so those are always parsed: markOverlaps
 // checks them on every poll, and reading s.messages for that read and kept every review transcript. An unread transcript
 // is this file. Only review sessions: running and queued ones load paused (below), and nothing makes a session active
 // again without reading its transcript (start, a prompt, a resume). Walked as markOverlaps walks s.messages, so data it
 // would trip over leaves no entry and markOverlaps reads the transcript then, as before.
 const editsAtStart=new WeakMap(),noteEdits=(s,list)=>{try{const out=[];for(const m of list||[])for(const f of m.tool?.files||[])if(typeof f?.path==='string'&&f.path)out.push({path:f.path});editsAtStart.set(s,out);}catch{}};
 for(let i=0;i<store.sessions.length;i+=8)await Promise.all(store.sessions.slice(i,i+8).map(async s=>{if(Array.isArray(s.messages))return;s.messages=[];
  try{const raw=await fs.readFile(transcriptFile(s.id)),sum=textDigest(raw);
   if(sum!==recorded[s.id]||s.status==='review'){const list=JSON.parse(raw.toString('utf8'));if(s.status==='review')noteEdits(s,list);}
   savedTranscripts.set(s.id,sum);deferTranscript(s);}
  catch(e){if(e.code!=='ENOENT')throw new Error(`Cannot read the transcript of session ${s.id}: ${e.message}`);}}));
 // Sidebar keys ('s:<id>' or 'f:<native file>') the user archived; archiving only hides, it never deletes.
 store.archived=Array.isArray(store.archived)?store.archived.filter(k=>typeof k==='string'):[];
 // Sidebar keys the user pinned to the top; a key is never both pinned and archived.
 store.pinned=Array.isArray(store.pinned)?store.pinned.filter(k=>typeof k==='string'&&!store.archived.includes(k)):[];
 // Enhance follows the composer's reasoning level now; drop the old Settings-page level.
 delete store.enhanceThinking;
 // OAuth account the user chose per provider (provider id → OMP's account label); applied to sessions with /session pin.
 store.accountChoices=Object.fromEntries(Object.entries(store.accountChoices&&typeof store.accountChoices==='object'?store.accountChoices:{}).filter(([k,v])=>k&&typeof v==='string'&&v));
 // Where "Open in editor" opens files (Settings › Open in editor).
 if(!EDITOR_CHOICES.includes(store.editor))store.editor='auto';
 // Sidebar layout shared by every device: project-group order and collapsed group keys (`cwd || label`). null = not saved
 // yet, so the first dashboard to load uploads the order its browser kept before this was synced.
 const uiKeys=v=>Array.isArray(v)?[...new Set(v.filter(k=>typeof k==='string'&&k&&k.length<=4096))].slice(0,500):null;
 store.ui={groupOrder:uiKeys(store.ui?.groupOrder),collapsed:uiKeys(store.ui?.collapsed)};
 for(const p of store.projects){if(!projectColor(p.color))p.color=colors[store.projects.indexOf(p)%colors.length];if(p.hidden!==true)delete p.hidden;}
 for(const s of store.sessions){finishWork(s,s.updatedAt||now());delete s._streamId;delete s._thinkId;delete s._compacting;delete s.uiRequests;if(['running','queued'].includes(s.status)){s.status='paused';s.error=undefined;}for(const a of s.subagentList||[])if(/run|pend|start|queue/i.test(a.status))a.status='stopped';}
 // Event saves are batched: within 300 ms when a session's status changed, else within 5 s (streamed text, tool output,
 // refreshed state), which only a crash can lose; OMP's own session file still has the turn. Quit and pause save everything.
 // Scopes as in persist(); the batch saves their union. saveNow runs a pending batch at once.
 let saveTimer,saveDue=Infinity,saveScope;
 const scheduleSave=(scope,lazy=false)=>{saveScope=widen(saveScope,scope);const due=Date.now()+(lazy?5000:300);if(due>=saveDue)return;
  clearTimeout(saveTimer);saveDue=due;saveTimer=setTimeout(saveNow,due-Date.now());};
 const saveNow=()=>{clearTimeout(saveTimer);const scope=saveScope;saveTimer=saveScope=undefined;saveDue=Infinity;return scope?persist(scope===true?undefined:[...scope]):saveChain;};
 let saveChain=Promise.resolve();
 // A transcript not read since startup: the first read of s.messages (or a new value for it) reads it from disk, and from
 // then on it is an ordinary array. Not enumerable until then, so a summary or workspace.json never reads it. Its file is
 // what was last saved, so saves skip it (unread).
 function deferTranscript(s){Object.defineProperty(s,'messages',{configurable:true,enumerable:false,get(){const list=readTranscript(s);holdTranscript(s,list);return list;},set(list){holdTranscript(s,list);}});}
 function holdTranscript(s,list){editsAtStart.delete(s);Object.defineProperty(s,'messages',{value:list,writable:true,enumerable:true,configurable:true});}
 function unread(s){return !!Object.getOwnPropertyDescriptor(s,'messages')?.get;}
 // The file records noted at startup while the transcript is unread; null once read or replaced, or when none were noted.
 function unreadEdits(s){return unread(s)?editsAtStart.get(s)??null:null;}
 function readTranscript(s){try{return JSON.parse(readFileSync(transcriptFile(s.id),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw new Error(`Cannot read the transcript of session ${s.id}: ${e.message}`);}}
 // Save scope: the sessions whose transcripts may have changed; undefined = all of them, [] = workspace.json only.
 // Scopes union: true = every session, else a Set of sessions.
 function widen(acc,scope){if(scope===undefined||acc===true)return true;acc??=new Set();for(const s of [scope].flat())acc.add(s);return acc;}
 const omit=(key,value)=>key.startsWith('_')||key==='uiRequests'?undefined:value;
 // Per-process temp name: a second companion on another port sharing this data dir would otherwise rename our shared temp file away before we do (ENOENT).
 const writeAtomic=async(file,data)=>{const tmp=`${file}.${process.pid}.tmp`;try{await fs.writeFile(tmp,data,{mode:0o600,flush:true});await replaceFile(tmp,file);}catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}};
 // One write in flight plus at most one queued; the queued one covers every caller that joined it (the union of their scopes)
 // and serializes when it starts. Snapshotting per call instead pinned a full copy of the store (~40 MB) per pending save,
 // and a slow disk ran the heap out. Everything is serialized at one instant, so the files on disk match one state.
 // Transcripts are written before workspace.json lists their session, and deleted only once it no longer does.
 // A failed save's scope joins the next one.
 let lastSaved,nextSave,nextScope;
 const persist=scope=>{nextScope=widen(nextScope,scope);if(nextSave)return nextSave;nextSave=saveChain=saveChain.catch(()=>{}).then(async()=>{
  const scoped=nextScope;nextSave=nextScope=undefined;
  try{
   const sessions=new Set(store.sessions),ids=new Set(store.sessions.map(s=>s.id)),changed=[];
   for(const s of sessions)if(!unread(s)&&(scoped===true||scoped.has(s)||!savedTranscripts.has(s.id))){const text=JSON.stringify(s.messages||[],omit),sum=textDigest(text);if(sum!==savedTranscripts.get(s.id))changed.push([s.id,text,sum]);}
   // Each transcript's digest as it is on disk once this save is done, for the next startup's check. A write that fails or
   // races another companion only makes the file differ from it, and that file is parsed.
   const due=new Map(changed.map(([id,,sum])=>[id,sum])),transcriptDigests={};for(const id of ids){const d=due.get(id)??savedTranscripts.get(id);if(d)transcriptDigests[id]=d;}
   const snapshot=JSON.stringify({...store,transcriptDigests},function(key,value){return key==='messages'&&sessions.has(this)?undefined:omit(key,value);});
   const gone=[...savedTranscripts.keys()].filter(id=>!ids.has(id));
   if(changed.length)await fs.mkdir(transcriptDir,{recursive:true,mode:0o700});
   // A few at a time: the first save after an upgrade writes every transcript (hundreds of flushed files). All settle
   // before a failure is reported, so no write of this save overlaps the next one's.
   const settled=async writes=>{const failed=(await Promise.allSettled(writes)).find(r=>r.status==='rejected');if(failed)throw failed.reason;};
   const writeTranscripts=async()=>{for(let i=0;i<changed.length;i+=8)await settled(changed.slice(i,i+8).map(async([id,text,sum])=>{await writeAtomic(transcriptFile(id),text);savedTranscripts.set(id,sum);}));};
   const writeIndex=async()=>{if(snapshot!==lastSaved){await writeAtomic(stateFile,snapshot);lastSaved=snapshot;}};
   // A transcript reaches disk before workspace.json first lists its session; otherwise both are written at once.
   if(changed.some(([id])=>!savedTranscripts.has(id))){await writeTranscripts();await writeIndex();}else await settled([writeTranscripts(),writeIndex()]);
   for(const id of gone){await fs.rm(transcriptFile(id),{force:true});savedTranscripts.delete(id);}
  }catch(e){nextScope=widen(nextScope,scoped===true?undefined:[...scoped]);throw e;}
 });saveChain.catch(e=>console.error('Workspace save failed:',e.message));return saveChain;};
 return {store,uiKeys,persist,saveNow,scheduleSave,unread,unreadEdits,readTranscript,get saveTimer(){return saveTimer;}};
}
