// HTTP routes for sessions: dashboard state polls, drafts, starting, resuming, pinning and archiving sessions,
// provider usage, slash commands, and session commands.
import { randomUUID } from 'node:crypto';
import { exists, now, error, text, samePath, resolveDir } from '../util.mjs';
import { chatImages } from '../images.mjs';
import { readSessionHead, lastContext, importMessages } from '../transcript.mjs';
import { launchOptions } from '../launch.mjs';
export function sessionRoutes(ctx){
 const {command,start,lock,notice,store,commands,refresh,digest,persist,scheduleSave,runners,autoShutdownView,instance,canRestart,stashImages,unread,readTranscript,discoverCommands,needsBackfill,backfillEntries,fileEntries,providerUsage,modelChoice,sessionFileParam,ensureProject,refreshBranches,createSession,markOverlaps,transcriptDelta,storeDelta,readDraft,saveDraft}=ctx;
 const archiveOrPin=async({url,body,json})=>{
    const field=url.pathname==='/api/pin'?'pinned':'archived',other=field==='pinned'?'archived':'pinned',on=body[field]!==false;
    const key=typeof body.key==='string'?body.key:'';if(!/^[sf]:./.test(key)||key.length>4096)throw error('Invalid session key.');
    if(key.startsWith('s:')){const s=store.sessions.find(s=>s.id===key.slice(2));if(!s)throw error('Session not found.',404);
     if(field==='archived'&&on&&['running','queued'].includes(s.status))throw error('Stop the session before archiving it.');
     // Archiving a session that is ready for review completes it and stops its OMP process.
     if(field==='archived'&&on&&s.status==='review'){await lock(s.id,()=>command(s,{type:'complete'}));runners.get(s.id)?.kill();}}
    // Pinning and archiving exclude each other: setting one clears the other.
    const set=new Set(store[field]);if(on){set.add(key);store[other]=store[other].filter(k=>k!==key);}else set.delete(key);store[field]=[...set];await persist([]);json({archived:store.archived,pinned:store.pinned});return;
   };
 return {
   'GET /api/state':async({req,res,url,send,json})=>{
    markOverlaps();refreshBranches();
    // Draft texts can be large: polls carry only their timestamps, and the dashboard fetches a changed draft by key.
    const drafts=Object.fromEntries(Object.entries(store.drafts).map(([k,v])=>[k,v.at]));
    // Without ?session: the whole store, every transcript included (read for this reply only when nothing has read it yet).
    if(!url.searchParams.has('session')){json({...store,drafts,instance,canRestart,autoShutdown:autoShutdownView(),sessions:store.sessions.map(s=>unread(s)?{...s,messages:readTranscript(s)}:s)});return;}
    // ?session=<id> (the dashboard's polls): messages and /btw answers only for that session, no activity log; ETag so unchanged polls send nothing.
    // A viewed session with no OMP process running gets its prompts' entry IDs from the session file (live ones from refresh).
    {const s=store.sessions.find(x=>x.id===url.searchParams.get('session'));if(s?.sessionFile&&!runners.get(s.id)?.alive&&needsBackfill(s))void lock(s.id,async()=>{if(!runners.get(s.id)?.alive&&needsBackfill(s))await backfillEntries(s,()=>fileEntries(s.sessionFile));}).catch(()=>{});}
    const id=url.searchParams.get('session'),since=url.searchParams.get('since'),od=url.searchParams.get('od')==='1',viewed=store.sessions.find(s=>s.id===id);
    const top={...store,drafts,instance,canRestart,autoShutdown:autoShutdownView(),activity:undefined};
    // store=<epoch>.<rev>, or empty while it holds none: the session list and the rest of the store as changes (storeDelta),
    // the viewed transcript as changes after since=<epoch>.<rev> (transcriptDelta; with od=1, a changed order as an edit of
    // the one held) or whole in tx.messages, its /btw answers in btw.
    const sx=url.searchParams.has('store')?storeDelta({...top,sessions:undefined},url.searchParams.get('store')):null;
    let body;
    if(sx!==null){const tx=viewed&&transcriptDelta(viewed,since??'',od),t=viewed&&(tx?.delta?tx.tx:{...(tx?.tx||{session:viewed.id}),messages:viewed.messages});
     body=`{"sx":${sx}${t?`,"tx":${JSON.stringify(t)}`:''}${viewed?._btw?`,"btw":${JSON.stringify(viewed._btw)}`:''}}`;}
    // Without store (a page loaded from an older companion): the whole list. With since, the viewed transcript as deltas.
    else{const tx=since!==null&&viewed?transcriptDelta(viewed,since,od):null;
     body=JSON.stringify({...top,...(tx?{tx:tx.tx}:{}),sessions:store.sessions.map(s=>s.id===id?(tx?.delta?{...s,messages:undefined}:{...s,messages:s.messages}):{...s,messages:undefined,_btw:undefined})});}
    const tag=`"${digest(body)}"`;
    if(req.headers['if-none-match']===tag){res.writeHead(304,{ETag:tag,'Cache-Control':'no-store'});res.end();return;}
    send(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',ETag:tag},body);return;
   },
   // A view's draft with its images' data and previews; images named in ?have= (the dashboard has them) come without.
   'GET /api/draft':async({url,json})=>{json(await readDraft(url.searchParams.get('key'),new Set(url.searchParams.getAll('have'))));return;},
   'GET /api/usage':async({url,json})=>{
    const s=store.sessions.find(s=>s.id===url.searchParams.get('session'));if(!s)throw error('Session not found.',404);
    // Sessions on "OMP default" have no provider until OMP reports its model, as /usage resolves it.
    if(!s.provider||!s.model)await lock(s.id,async()=>{const runner=await start(s);await refresh(s,runner);await persist(s);});
    json({...await providerUsage(s),updatedAt:now()});return;
   },
   'GET /api/commands':async({url,json})=>{
    if(url.searchParams.has('path')){json({commands:await discoverCommands(await resolveDir(url.searchParams.get('path')))});return;}
    const s=store.sessions.find(s=>s.id===url.searchParams.get('session'));if(!s)throw error('Session not found.',404);
    await lock(s.id,async()=>{await start(s);await persist(s);});json({commands:commands.get(s.id)||[]});return;
   },
   'POST /api/sessions':async({body,json})=>{
    const p=store.projects.find(p=>p.id===body.projectId);if(!p)throw error('Project not found.');const title=text(body.title,'Session title',120);const prompt=text(body.prompt,'Initial prompt',200000);
    json(await createSession(p,{title,prompt,isolate:body.isolate!==false,model:body.model,provider:body.provider}),201);return;
   },
   // Composer drafts (debounced from every device), with their images (see drafts.mjs).
   'POST /api/draft':async({body,json})=>{json(await saveDraft(body));return;},
   // One step: pick a folder, optionally type a prompt, go. The project is registered automatically.
   'POST /api/quick-start':async({body,json})=>{
    const dir=await resolveDir(body.path);const images=chatImages(body);const raw=typeof body.prompt==='string'?body.prompt.trim().slice(0,200000):'';const p=await ensureProject(dir);
    const title=(typeof body.title==='string'&&body.title.trim().slice(0,120))||raw.split('\n')[0].slice(0,70)||`New session · ${p.name}`;
    const {selector,thinking}=modelChoice(body);const launch=await launchOptions(body.launch);
    if(body.autoApprove!==undefined&&typeof body.autoApprove!=='boolean')throw error('Auto-approve must be true or false.');
    const s=await createSession(p,{title,prompt:'',isolate:body.isolate===true,native:true,selector,thinking,launch,draft:body.draft===true});
    // A title cut from the prompt is a placeholder: OMP's RPC mode never auto-titles, so /rename asks it to (see event()).
    if(!(typeof body.title==='string'&&body.title.trim())&&!launch?.noTitle)s.autoTitle=true;
    if(typeof body.advisor==='boolean')await lock(s.id,()=>command(s,{type:'advisor',action:body.advisor?'on':'off'}));
    // Before the first prompt, so approval prompts from the first turn are already answered.
    if(body.autoApprove===true)await lock(s.id,()=>command(s,{type:'auto_approve',enabled:true}));
    if(body.fast===true)await lock(s.id,()=>command(s,{type:'pref',key:'fast',value:true})).catch(e=>notice(s,'warning',e.message));
    json(images.length||raw?await lock(s.id,()=>command(s,{type:'prompt',message:raw,images,preview:body.preview},images)):s,201);return;
   },
   'POST /api/omp-sessions/resume':async({body,json})=>{
    const file=sessionFileParam(body.file);const images=chatImages(body);const message=typeof body.message==='string'?body.message.trim().slice(0,200000):'';
    const submitted=!!message||body.images!==undefined;
    const existing=store.sessions.find(s=>s.sessionFile&&samePath(s.sessionFile,file));
    const gone=k=>k!=='f:'+file&&k!=='f:'+body.file;store.archived=store.archived.filter(gone);store.pinned=store.pinned.filter(gone);
   if(existing){existing.hidden=false;if(body.model||body.thinking)await lock(existing.id,()=>command(existing,{type:'set_model',model:body.model,thinking:body.thinking}));if(typeof body.advisor==='boolean')await lock(existing.id,()=>command(existing,{type:'advisor',action:body.advisor?'on':'off'}));json(submitted?await lock(existing.id,()=>command(existing,{type:existing.status==='running'?'follow_up':'prompt',message,images,preview:body.preview},images)):(await persist(existing),existing));return;}
    let head;try{head=await readSessionHead(file);}catch{throw error('Session file not found.',404);}
    if(!head.cwd||!await exists(head.cwd))throw error(`The session's working directory no longer exists: ${head.cwd||'unknown'}`);
    const p=await ensureProject(await resolveDir(head.cwd));const title=(head.title||head.preview.split('\n')[0]||'Resumed session').slice(0,120);
    const imported={},messages=await importMessages(file,400,stashImages,imported).catch(()=>[]);const contextTokens=await lastContext(file).catch(()=>undefined);messages.push({id:randomUUID(),role:'system',text:'Resumed from OMP session history. Avoid prompting it here while the same session is open in a terminal.',at:now()});
    const {selector,thinking}=modelChoice(body);const launch=await launchOptions(body.launch);const s=await createSession(p,{title,native:true,sessionFile:file,messages,selector,thinking,launch});s.contextTokens=contextTokens;if(imported.promptTrimmed)s.promptTrimmed=true;
    if(!head.title&&!launch?.noTitle)s.autoTitle=true;
    // OMP resumes with the model saved in the transcript; show it until the runner reports its own state.
    if(!selector&&head.model?.includes('/')){const i=head.model.indexOf('/');s.provider=head.model.slice(0,i);s.model=head.model.slice(i+1);}if(!thinking&&head.thinking)s.thinking=head.thinking;
    if(typeof body.advisor==='boolean')await lock(s.id,()=>command(s,{type:'advisor',action:body.advisor?'on':'off'}));
    json(submitted?await lock(s.id,()=>command(s,{type:'prompt',message,images,preview:body.preview},images)):s,201);return;
   },
   'POST /api/archive':archiveOrPin,'POST /api/pin':archiveOrPin,
   'POST /api/sessions/:id/command':async({url,body,json})=>{
   const match=url.pathname.match(/^\/api\/sessions\/([^/]+)\/command$/);
   // Answers, auto-approve, ghost text, side questions, subagent controls and read-only git views must get through while a command holds the lock.
   const unlocked=['answer','auto_approve','stop_commands','predict_word','predict_word_feedback','btw','btw_cancel','btw_history','subagent_cancel','subagent_steer','changes_worktree','git_log','git_commit','worktree_status','editor_text_applied'];
   // Commands answer with the session; one whose transcript nothing has read yet gets it read for the reply only (deferTranscript).
   // ?lean=1 (the dashboard, whose polls carry the transcript) leaves out the transcript and /btw answers and reads nothing:
   // every prompt sent got the whole transcript back (600 messages: ~0.7-0.9 MB gzipped) before the dashboard polled.
   if(match){const s=store.sessions.find(s=>s.id===match[1]);if(!s)throw error('Session not found.',404);const r=await(unlocked.includes(body.type)?command(s,body):lock(s.id,()=>command(s,body)));
    json(r!==s?r:url.searchParams.get('lean')==='1'?{...s,messages:undefined,_btw:undefined}:unread(s)?{...s,messages:readTranscript(s)}:r);return;}
   },
 };
}
