// Live sessions: starting OMP for a session, its event stream, settling turns, refreshing state, entry IDs from
// the session file, and the per-session lock.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { now, error, contentText, samePath, clip } from './util.mjs';
import { toolImages } from './images.mjs';
import { startWork, finishWork, askQuestion, parseAdvisorStatus, btwView, subagentView, goalView, loopView } from './session-views.mjs';
import { advisorMessage, tanMessage, collabPrompt, thinkingText, toolRecord, editFiles, toolSummary, readTail, usageTokens, importMessages, entryMessages, entryPrompt } from './transcript.mjs';
import { launchArgs } from './launch.mjs';
// What a session resumed after a restart is told: its interrupted turn is in OMP's session file, so it carries on from there.
const RESTART_PROMPT='Continue where you left off; the companion was restarted.';
export function createRunner(ctx){
 const {omp,append,place,notice,commands,locks,dataDir,activity,persist,scheduleSave,runners,launches,subagentThoughts,stashImages,attention,slashList,rateLimitHint,scheduleResume,cancelResume,dropSteers}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const sendQueued=(...args)=>ctx.sendQueued(...args);
 const checkAutoShutdown=(...args)=>ctx.checkAutoShutdown(...args);
 const command=(...args)=>ctx.command(...args);
 // A restart (Restart companion, or the automatic one after an OMP update) ended the turns of the sessions that were
 // working: OMP is relaunched on each one's session file and asked to carry on. Queued at once, so the reloaded panel
 // shows them working while OMP starts; a session that cannot resume stays paused with a note.
 function resumeAfterRestart(s){
  s.status='queued';s.error=undefined;append(s,'system','Companion restarted; resuming this session.');
  return lock(s.id,async()=>{
   if(ctx.closing||s.status!=='queued')return;
   try{
    await start(s);if(ctx.closing)return;
    // command() reports a failed send as the session's error instead of throwing.
    const r=await command(s,{type:'prompt',message:RESTART_PROMPT});
    if(r?.status==='error')throw new Error(r.error||'OMP did not accept the prompt.');
   }catch(e){if(ctx.closing)return;finishWork(s);s.status='paused';s.error=undefined;notice(s,'error',`Automatic resume failed: ${e.message}`);await persist(s);}
  });
 }
 function settle(s,promptId=s._promptId,run=s._run){
  void lock(s.id,async()=>{
   if(s.status!=='running'||s._promptId!==promptId||s._run!==run||s._settled||s._interrupt||s.uiRequests?.length)return;
   // Completion and idle polling can report the same run before a queued prompt starts.
   s._settled=true;dropSteers(s);
   if(s._planReview||s.planMode?.reviewPending){s.status='review';finishWork(s);scheduleSave(s);attention(s,'review','Plan ready for review');return;}
   if(s.queuedMessages?.length)await sendQueued(s);
   else{s.status='review';activity(s,`${s.title} is ready for review`,'review');attention(s,'review');}
   if(s.status!=='running')finishWork(s);
   scheduleSave(s);
  }).catch(e=>{s.status='error';finishWork(s);s.error=`Could not send queued message: ${e.message}`;void persist(s);}).finally(checkAutoShutdown);
 }
 // A streamed thought or reply grows its own message, the last one bar unread steers: looked up from the end, since deltas
 // are most of OMP's event stream and a 600-message transcript scanned from the front cost three scans per delta. Exact:
 // the id is a fresh randomUUID, so it appears once. The copy keeps the 600 cap and backfillEntries' identity check.
 function streamDelta(s,role,key,delta){
  const id=s[key]??=randomUUID(),list=s.messages;let m;
  for(let i=list.length-1;i>=0;i--)if(list[i].id===id){m=list[i];break;}
  const value=(m?.text||'')+delta;
  if(!m||!value){append(s,role,value,id);return;}
  m.text=value.slice(-100000);s.messages=list.slice(-600);
 }
 function event(s,f){
  // /btw side questions stream outside the transcript: kept on the session for the dashboard only (not persisted).
  if(f.type==='btw_record'&&f.record?.id){const r=btwView(f.record);s._btw=[r,...(s._btw||[]).filter(x=>x.id!==r.id)].slice(0,20);return;}
  if(f.type==='btw_delta'){const r=s._btw?.find(x=>x.id===f.recordId);if(r&&typeof f.delta==='string'){const t=r.followUps.at(-1)||r;t.answer=(t.answer+f.delta).slice(-100000);}return;}
  s.updatedAt=now();
  const status=s.status;
  // Advisor toggles print command_output, which is not progress on the turn itself.
  if(f.type!=='command_output')s.lastActivityAt=now();
  // A run whose last message never ended (abort, crash) must not stream the next thought or reply into the old one.
  if(f.type==='agent_start'){s._run=(s._run||0)+1;delete s._settled;delete s._interrupt;delete s._titling;delete s._thinkId;delete s._streamId;cancelResume(s);startWork(s);s.status='running';s.error=undefined;}
  if(f.type==='auto_compaction_start')s._compacting=true;
  if(f.type==='auto_compaction_end'){
   s._compacting=!!f.willRetry;
   if(!f.willRetry)append(s,'system',f.aborted?'Context compaction stopped.':f.skipped?'Context compaction skipped.':f.errorMessage?`Context compaction failed: ${f.errorMessage}`:'Context compacted.');
  }
  if(f.type==='message_update'&&f.assistantMessageEvent?.type==='thinking_delta'){
   streamDelta(s,'thinking','_thinkId',f.assistantMessageEvent.delta);
  }
  if(f.type==='message_update'&&f.assistantMessageEvent?.type==='text_delta'){
   streamDelta(s,'assistant','_streamId',f.assistantMessageEvent.delta);
  }
  if(f.type==='message_start'&&f.message?.role==='user'&&f.mirrored){
   // A collab host's own prompt, mirrored into a guest's session: shown as it arrives. Its timestamp binds it to the
   // replica's entry (bindEntries), as a local prompt's does.
   const said=contentText(f.message.content).trim(),hasImage=Array.isArray(f.message.content)&&f.message.content.some(c=>c?.type==='image');
   if((said||hasImage)&&!(f.message.synthetic&&f.message.attribution==='agent')){const msg=append(s,'user',said||'Image attached');if(msg){if(hasImage)msg.hasImage=true;if(typeof f.message.timestamp==='number')msg.ompAt=f.message.timestamp;}}
  }
  else if(f.type==='message_start'&&f.message?.role==='user'){
   // Steers wait for a tool/turn boundary; OMP echoes them when read, so place them where the agent actually saw them.
   const said=contentText(f.message.content).trim(),i=s.messages.findIndex(m=>m.steer&&(m.text.trim()===said||(m.hasImage&&m.text==='Image attached'&&!said)));
   if(i>=0){const [m]=s.messages.splice(i,1);delete m.steer;m.at=now();if(typeof f.message.timestamp==='number')m.ompAt=f.message.timestamp;place(s,m);}
   // Otherwise the first user message of a prompt's run is that prompt. OMP stores this exact message, timestamp included,
   // as its session entry; bindEntries turns the timestamp into the entry ID that branching from this message needs.
   else if(s._promptMsg&&!(f.message.synthetic&&f.message.attribution==='agent')){const m=s.messages.find(m=>m.id===s._promptMsg);if(m&&typeof f.message.timestamp==='number')m.ompAt=f.message.timestamp;delete s._promptMsg;}
  }
  // Once the prompt is in OMP's history (first assistant message of a run), ask OMP to title the session; at most once per run.
  // _titling is a deadline: a /rename cancelled by Stop prints nothing, so the flag must lapse on its own.
  if(f.type==='message_start'&&f.message?.role==='assistant'&&!f.mirrored&&s.autoTitle&&!(s._titling>Date.now())&&s._titleRun!==s._run){s._titling=Date.now()+60000;s._titleRun=s._run;const runner=runners.get(s.id);if(runner)void runner.prompt({message:'/rename'}).catch(()=>{delete s._titling;});}
  if(f.type==='message_end'){
   const m=f.message||{};if(m.role==='assistant'){const ct=usageTokens(m.usage);if(ct)s.contextTokens=ct;s._rateLimit=m.stopReason==='error'?rateLimitHint(m.errorMessage):undefined;if(m.stopReason==='error'&&s.status!=='paused'&&s.status!=='done'){s.status='error';s.error=m.errorMessage||'OMP provider failed.';append(s,'system',s.error);activity(s,`${s.title}: ${s.error}`,'error');attention(s,'error',s.error);}else if(m.stopReason==='aborted'&&!s._interrupt){s.status='paused';}const th=thinkingText(m.content);if(th)append(s,'thinking',th.slice(-40000),s._thinkId||randomUUID());const v=contentText(m.content);if(v){const msg=append(s,'assistant',v,s._streamId||randomUUID());if(msg&&m.provider&&m.model)msg.model=`${m.provider}/${m.model}`;}if(m.provider&&m.model){s.provider=m.provider;s.model=m.model;}delete s._streamId;delete s._thinkId;if(m.usage&&!f.mirrored){s.tokens+=(m.usage.totalTokens||((m.usage.input||0)+(m.usage.output||0)));s.cost+=m.usage.cost?.total||0;}}
   // A collab guest's prompt (collab-prompt): on the host, and in guests' sessions mirrored from it. A guest's own prompt,
   // already shown when sent (and forwarded, never run here), is the one it echoes: it takes the author, nothing is added.
   const prompt=m.role==='custom'&&collabPrompt(m,randomUUID(),now());
   if(prompt){const own=f.mirrored&&[...s.messages].reverse().find(x=>x.role==='user'&&!x.from&&!x.entryId&&!x.ompAt&&x.text.trim()===prompt.text.trim());
    if(own){own.from=prompt.from;if(own.steer){s.messages.splice(s.messages.indexOf(own),1);delete own.steer;own.at=now();place(s,own);}}
    else{const msg=append(s,'user',prompt.text,prompt.id);if(msg){msg.from=prompt.from;if(prompt.hasImage)msg.hasImage=true;}}}
   else if(m.role==='custom'){const card=advisorMessage(m,randomUUID(),now());if(card){const saved=append(s,'advisor',card.text,card.id);saved.notes=card.notes;}const tan=tanMessage(m,randomUUID(),now());if(tan)append(s,'system',tan.text,tan.id);}
  }
  if(f.type==='tool_execution_start'){const tool=toolRecord(f.toolName,f.args,f.intent);const msg=append(s,'tool',toolSummary(tool),'tool-'+(f.toolCallId||randomUUID()));if(msg){msg.tool=tool;msg.startedAt=now();}}
  if(f.type==='tool_execution_end'){let msg=s.messages.find(m=>m.id==='tool-'+f.toolCallId);if(!msg){msg=append(s,'tool','tool','tool-'+(f.toolCallId||randomUUID()));msg.tool=toolRecord(f.toolName,{},'');}
   msg.tool.status=f.isError?'error':'done';msg.tool.result=clip(contentText(f.result?.content),8000);const images=toolImages(f.result?.content);if(images.length)msg.tool.images=stashImages(images);const files=editFiles(f.result?.details);if(files)msg.tool.files=files;msg.tool.ms=msg.startedAt?Date.now()-new Date(msg.startedAt).getTime():undefined;msg.text=toolSummary(msg.tool);}
  if(f.type==='command_output'){const text=typeof f.text==='string'?f.text:contentText(f.content);
   if(s._capture){s._capture.push(text);return;}
   // Our own background /rename reports back in chat text; keep it out of the transcript.
   if(s._titling>Date.now()&&/^(Session renamed to |Session name not changed|Could not generate a session title|Rename failed:)/.test(text)){delete s._titling;return;}
   const adv=parseAdvisorStatus(text);if(adv)s.advisor={enabled:adv.enabled??s.advisor?.enabled??adv.state==='running',...adv,at:now()};if(!(adv&&s._silentAdvisorUntil>Date.now()))append(s,adv?'system':'assistant',text);}
  if(f.type==='session_info_update'&&typeof f.title==='string'&&f.title.trim()){s.title=f.title.trim().slice(0,120);delete s.autoTitle;}
  // Correlated by command id: an aborted run's result can land after the next prompt started, and must not pause it.
  if(f.type==='prompt_result'&&f.agentInvoked!==false&&!(f.id&&f.id!==s._promptId)&&!(s._interrupt&&f.id!==s._interrupt)){
   if(f.id&&f.id===s._interrupt)delete s._interrupt;
   // A terminal prompt_result follows the run's last agent_end, so OMP has stopped retrying by now.
   if(f.status==='error'){s.status='error';s.error=f.error?.message||'OMP reported an error.';append(s,'system',s.error);activity(s,`${s.title}: ${s.error}`,'error');attention(s,'error',s.error);scheduleResume(s);}
   else if(f.status==='aborted'){s.status='paused';activity(s,`Stopped ${s.title}`,'paused');}
   else if(f.status==='completed'&&f.sessionSettled===true)settle(s);
   if(f.status==='error'||f.status==='aborted')finishWork(s);
   dropSteers(s);
  }
  if(f.type==='prompt_result'&&f.agentInvoked===false&&f.status==='error')notice(s,'error',f.error?.message||'OMP command failed.');
  if(f.type==='session_settled'){dropSteers(s);if(s.status==='running')settle(s);else if(!s.uiRequests?.length)finishWork(s);}
  if(f.type==='subagent_progress'||f.type==='subagent_lifecycle'){const p=f.payload||f;const id=p.progress?.id||p.id||p.subagentId;
   if(id){s.subagentList??=[];const prev=s.subagentList.find(x=>x.id===id);const next=subagentView({...prev,...p,id,progress:p.progress||prev?.progress,status:p.status||p.progress?.status||p.phase||prev?.status});if(prev)Object.assign(prev,next);else s.subagentList.push(next);s.subagentList=s.subagentList.slice(-50);
    const key=s.id+':'+id;let thought=subagentThoughts.get(key);
    if(!thought||p.status==='started'||(thought.file&&next.sessionFile&&!samePath(thought.file,next.sessionFile))){thought={parentId:s.id,text:'',at:now(),streaming:false};subagentThoughts.set(key,thought);if(subagentThoughts.size>256)subagentThoughts.delete(subagentThoughts.keys().next().value);}
    thought.file=next.sessionFile||thought.file;thought.active=/run|pend|start|queue/i.test(next.status);if(!thought.active)thought.streaming=false;
   }}
  if(f.type==='subagent_event'){const p=f.payload||{},e=p.event;const thought=subagentThoughts.get(s.id+':'+p.id);
   if(thought&&e?.message?.role==='assistant'&&['message_start','message_update','message_end'].includes(e.type)){
    if(e.type==='message_start'||!thought.id)thought.id='sub-think-'+randomUUID();
    thought.text=thinkingText(e.message.content).slice(-40000);thought.at=now();thought.sourceTimestamp=e.message.timestamp;thought.streaming=e.type!=='message_end';
   }}
  if(f.type==='extension_ui_request'&&f.id){
   if(f.method==='cancel')s.uiRequests=(s.uiRequests||[]).filter(q=>q.id!==f.targetId);
   // A component shown through ctx.ui.custom (an extension's panel, the bash tool's `pty: true` terminal): repainted under one id until withdrawn.
   else if(f.method==='custom'){const lines=Array.isArray(f.lines)?f.lines.slice(-80).map(l=>String(l).slice(0,4000)):[];const prev=s.uiRequests?.find(q=>q.id===f.id);if(prev)prev.lines=lines;else{const q={id:f.id,method:'custom',title:'Interactive panel',lines};(s.uiRequests??=[]).push(q);attention(s,'question',q.title);}}
   else if(f.method==='ask'){
    const questions=Array.isArray(f.questions)?f.questions.map(askQuestion):[];
    if(questions.length&&!questions.includes(null)){const q={id:f.id,method:'ask',title:questions.length>1?`${questions.length} questions`:questions[0].question,questions};(s.uiRequests??=[]).push(q);attention(s,'question',q.title);}
    else{try{runners.get(s.id)?.answer(f.id,{cancelled:true});}catch{}}
   }else if(['select','confirm','input','editor'].includes(f.method)){
    const approval=approvalPrompt(f);
    if(approval&&s.autoApprove)void autoApprove(s,runners.get(s.id),f.id,approval).catch(e=>notice(s,'error',`Auto-approve failed: ${e.message}`));
    else{
     const q={id:f.id,method:f.method,title:String(f.title||'Question').slice(0,500)};
     if(f.method==='select'){q.options=Array.isArray(f.options)?f.options.filter(x=>typeof x==='string').slice(0,100):[];q.optionDetails=Array.isArray(f.optionDetails)?f.optionDetails.slice(0,q.options.length).map(x=>({description:String(x?.description||'').slice(0,500)})):[];q.checked=Array.isArray(f.checkedIndices)?f.checkedIndices.filter(i=>Number.isInteger(i)&&i>=0&&i<q.options.length):[];}
     if(f.method==='confirm')q.message=String(f.message||'').slice(0,2000);
     if(f.method==='input'){q.placeholder=String(f.placeholder||'').slice(0,500);if(f.secret===true)q.secret=true;}
     if(f.method==='editor')q.prefill=String(f.prefill||'').slice(0,20000);
     // Kept so turning auto-approve on later can answer it; decided here from the untruncated title.
     if(approval)q._approval=approval;
     (s.uiRequests??=[]).push(q);attention(s,'question',q.title);
    }
   }else if(f.method==='notify')notice(s,f.notifyType,f.message);
   else if(f.method==='setStatus'){s._status??={};const key=String(f.statusKey||'').slice(0,80);if(f.statusText)s._status[key]=String(f.statusText).slice(0,300);else delete s._status[key];}
   // collab-qr (collab-host.mjs) is a QR code: cut short it would not scan, and the largest one (version 40) needs 94 lines.
   else if(f.method==='setWidget'){s._widgets??={};const key=String(f.widgetKey||'').slice(0,80);if(Array.isArray(f.widgetLines)&&f.widgetLines.length)s._widgets[key]=f.widgetLines.slice(0,key==='collab-qr'?100:40).map(l=>String(l).slice(0,500));else delete s._widgets[key];}
   else if(f.method==='set_editor_text')s._editorText={id:f.id,text:String(f.text??'').slice(0,200000)};
   // Login flows: the browser can't be opened for the user without a click, so the dashboard shows the link.
   else if(f.method==='open_url'){const url=[f.launchUrl,f.url].find(u=>typeof u==='string'&&/^https?:\/\//i.test(u));if(url)s._openUrl={id:f.id,url:url.slice(0,4000),instructions:String(f.instructions||'').slice(0,1000)};}
   else if(f.method!=='setTitle'){try{runners.get(s.id)?.answer(f.id,{cancelled:true});}catch{}}
  }
  if(f.type==='tool_execution_update'){const msg=s.messages.find(m=>m.id==='tool-'+f.toolCallId);const out=contentText(f.partialResult?.content);if(msg?.tool?.status==='running'){if(out)msg.tool.result=out.length>8000?'…'+out.slice(-8000):out;const images=toolImages(f.partialResult?.content);if(images.length)msg.tool.images=stashImages(images);}}
  if(f.type==='extension_error')notice(s,'error',`Extension ${path.basename(String(f.extensionPath||'extension'))} failed${f.event?` in ${f.event}`:''}: ${f.error}`);
  if(f.type==='notice')notice(s,f.level,f.source?`${f.source}: ${f.message}`:f.message);
  // A hosted command replaced the transcript outside a command (a collab room ended or resynced): show it as OMP has it.
  if(f.type==='session_replaced')void lock(s.id,async()=>{const runner=runners.get(s.id);if(!runner?.alive)return;await reload(s,runner);if(f.note)append(s,'system',String(f.note).slice(0,2000));scheduleSave(s);}).catch(e=>notice(s,'error',`Could not reload the session: ${e.message}`));
  if(f.type==='loop_state'){const v=loopView(f.loop);if(v)s._loop=v;else delete s._loop;}
  // /loop re-sends its prompt as the next user message; loop.mode = reset first started a fresh (empty) OMP session.
  if(f.type==='loop_iteration'&&typeof f.text==='string'){
   if(f.fresh){s.messages=[];s.todos=[];s.subagentList=[];delete s.contextTokens;delete s.contextPercent;delete s._entryCursor;append(s,'system',String(f.note||'').slice(0,2000));const runner=runners.get(s.id);if(runner?.alive)void refresh(s,runner);}
   delete s._streamId;delete s._thinkId;const msg=append(s,'user',f.text);if(msg){s._promptMsg=msg.id;if(typeof f.id==='string')s._promptId=f.id;}
  }
  // A hosted command still working after its run returned (/cleanse, /omfg): the dashboard offers Stop for it.
  if(f.type==='command_run'){const key=String(f.key||'').slice(0,80);s._commandRuns??={};if(f.active)s._commandRuns[key]=String(f.label||key).slice(0,200);else delete s._commandRuns[key];}
  if(f.type==='auto_retry_start'&&s.status!=='paused'&&s.status!=='done'){s.status='running';s.error=undefined;s._retry={attempt:f.attempt,maxAttempts:f.maxAttempts,delayMs:f.delayMs,error:String(f.errorMessage||'').slice(0,1000),at:now()};}
  if(f.type==='auto_retry_end'){delete s._retry;if(!f.success)append(s,'system',`Retries stopped after attempt ${f.attempt}${f.finalError?`: ${f.finalError}`:'.'}`);}
  if(f.type==='retry_fallback_applied')append(s,'system',`Switched from ${f.from} to fallback model ${f.to}${f.reason?` (${f.reason})`:''}.`);
  if(f.type==='model_changed'){const runner=runners.get(s.id);if(runner)void refresh(s,runner);}
  if(f.type==='thinking_level_changed'&&f.thinkingLevel)s.thinking=f.thinkingLevel;
  if(f.type==='ttsr_triggered'&&Array.isArray(f.rules)&&f.rules.length)append(s,'system',`Rule applied: ${f.rules.map(r=>r?.name||r?.id||'rule').join(', ')}`);
  if(f.type==='irc_message'){const v=contentText(f.message?.content);if(v)append(s,'system',v);}
  if(f.type==='todo_auto_clear')s.todos=[];
  if(f.type==='goal_updated')s.goal=goalView(f.goal);
  if(f.type==='plan_mode_changed'){s.planMode=f.planMode;s._planSupported=true;}
  if(f.type==='plan_review')s._planReview=f.proposal;
  if(f.type==='plan_review_clear'&&s._planReview?.id===f.proposalId)delete s._planReview;
  if(f.type==='available_commands_update'&&Array.isArray(f.commands))commands.set(s.id,slashList(f.commands));
  // A prompt OMP accepted and then failed (say, the provider rejected it).
  if(f.type==='prompt_error'&&f.id===s._promptId){s.error=f.error;s.status='error';delete s._interrupt;}
  // Streaming deltas, tool output and the like arrive many times a second: batched lazily unless the status moved.
  scheduleSave(s,s.status===status);
 }
 // OMP's tool-approval dialogs: select('Allow tool: …',['Approve','Deny']) from its tool wrapper and eval preludes, and the
 // computer tool's foreground-control confirm. Prompts listing provider safety checks always go to the user: OMP lets no
 // setting bypass them. Returns the reply Approve/Yes sends and the text recorded in the chat; undefined for anything else.
 function approvalPrompt(f){
  const title=String(f.title||'');
  if(f.method==='select'&&title.startsWith('Allow tool: ')&&!title.includes('\nProvider safety checks:\n')&&Array.isArray(f.options)&&f.options.length===2&&f.options[0]==='Approve'&&f.options[1]==='Deny')return {reply:{value:'Approve'},text:title};
  if(f.method==='confirm'&&title==='Allow foreground computer control?')return {reply:{confirmed:true},text:`${title}\n${String(f.message||'')}`};
 }
 // Removed from the pending list before replying, so a concurrent answer can't reply to the same dialog twice.
 async function autoApprove(s,runner,id,approval){
  s.uiRequests=(s.uiRequests||[]).filter(q=>q.id!==id);
  runner.answer(id,approval.reply);
  append(s,'system',`Auto-approved: ${approval.text.slice(0,4000)}`);scheduleSave(s);
 }
 async function start(s){
  if(runners.get(s.id)?.alive)return runners.get(s.id);
  if(launches.has(s.id))return launches.get(s.id);
  const promise=(async()=>{
   for(const [key,thought] of subagentThoughts)if(thought.parentId===s.id)subagentThoughts.delete(key);
   const sessionDir=path.join(dataDir,'sessions',s.id);if(!s.native)await fs.mkdir(sessionDir,{recursive:true,mode:0o700});
   // Native sessions live in OMP's own session store, so they also appear in `omp --resume` and in the recent list.
   const pick=[...(s.modelSelector?['--model',s.modelSelector]:[]),...(s.thinkingChoice?['--thinking',s.thinkingChoice]:[]),...launchArgs(s.launch,!s.messages.some(m=>m.role==='user'))];
   const args=s.native?[...(s.sessionFile?['--resume',s.sessionFile]:[]),...pick]:['--session-dir',sessionDir,'--continue',...pick];
   const runner=omp.start({cwd:s.cwd,args,onEvent:f=>{if(!ctx.closing&&runners.get(s.id)===runner)event(s,f);},onExit:(e,stopping)=>{if(runners.get(s.id)!==runner)return;runners.delete(s.id);commands.delete(s.id);for(const k of ['_streamId','_thinkId','_interrupt','_compacting','_retry','_openUrl','_status','_widgets','_commandRuns','_editorText','_task','_bash','_planReview','_planSupported','_goalSupported','_goalAvailable','_unhosted','_thinkingLevels','_slow','_cacheWarming','_btw','_loop','uiRequests'])delete s[k];dropSteers(s);if(!ctx.closing&&!ctx.pausing){finishWork(s);s.status=stopping?(s.status==='done'?'done':'paused'):'error';s.error=stopping?undefined:e.message;if(!stopping)attention(s,'error',e.message);void persist(s);}}});
   runners.set(s.id,runner);
   try{await runner.ready;if(!s.autoTitle)await runner.setSessionName(s.title);if(!s.modelSelector&&!s.native&&s.provider&&s.model!=='OMP default')await runner.setModel(s.provider,s.model);
    // Per-session toggles live in the OMP session, so a restarted runner gets them back.
    for(const [key,value] of Object.entries(s.prefs||{}))await runner.setPref(key,value).catch(e=>notice(s,'warning',e.message));
    await refresh(s,runner);return runner;}catch(e){runners.delete(s.id);runner.kill();throw e;}
  })();launches.set(s.id,promise);try{return await promise;}finally{launches.delete(s.id);}
 }
 // The status reply can arrive after the prompt resolves, so stay silent until it shows up (or a few seconds pass).
 async function advisorStatus(s,runner){s._silentAdvisorUntil=Date.now()+5000;try{await runner.prompt({message:'/advisor status'});}catch{s._silentAdvisorUntil=0;}}
 async function refresh(s,runner){const promptId=s._promptId,run=s._run;try{const state=await runner.state();
  if(state){s.tps=typeof state.tokensPerSecond==='number'?state.tokensPerSecond:undefined;s.fast={enabled:!!state.fastModeEnabled,active:!!state.fastModeActive};if(typeof state.autoCompactionEnabled==='boolean')s.autoCompaction=state.autoCompactionEnabled;s.modes={steering:state.steeringMode,...(state.followUpMode?{followUp:state.followUpMode}:{}),interrupt:state.interruptMode};}
  if(state){s._planSupported=typeof state.planMode?.enabled==='boolean';if(s._planSupported)s.planMode=state.planMode;else delete s.planMode;if(state.planReview)s._planReview=state.planReview;else delete s._planReview;}
  if(state){s._goalSupported=Object.hasOwn(state,'goalMode');s._goalAvailable=state.goalMode?.available===true;s.goal=goalView(state.goalMode?.goal);s._skillImages=state.skillImages===true;s._unhosted=Array.isArray(state.unhostedCommands)?state.unhostedCommands:[];const loop=loopView(state.loop);if(loop)s._loop=loop;else delete s._loop;}
  // The live model's reasoning levels and its /slow and cache-warming state (OMP's get_state fields).
  if(state){s._thinkingLevels=Array.isArray(state.thinkingLevels)?state.thinkingLevels.filter(l=>typeof l==='string').slice(0,20):undefined;s._slow=typeof state.slowModeSupported==='boolean'?{supported:state.slowModeSupported,enabled:!!state.slowModeEnabled,scope:state.slowModeScope||null}:undefined;s._cacheWarming=['off','streaming','idle'].includes(state.cacheWarming)?state.cacheWarming:undefined;}
  // Native quiescence is authoritative; unrelated events must not keep an idle run working.
  if(state?.isSettled===true&&state.isCompacting!==true&&s.status==='running')settle(s,promptId,run);
  // Likewise a streaming OMP is working whatever s.status says: a run reported aborted or failed can keep going
  // (e.g. Stop & send's own prompt_result reporting the interrupted run), and OMP rejects prompts while it streams.
  if(state?.isStreaming===true&&!['running','queued','done'].includes(s.status)){startWork(s);s.status='running';s.error=undefined;delete s._settled;}
  if(state?.isSettled===true&&!s._advisorChecked&&s.status!=='running'){s._advisorChecked=true;await advisorStatus(s,runner);}if(state?.model){s.model=state.model.id;s.provider=state.model.provider;}if(state?.thinkingLevel)s.thinking=state.thinkingLevel;if(typeof state?.isCompacting==='boolean')s._compacting=state.isCompacting;s.todos=Array.isArray(state?.todoPhases)?state.todoPhases:[];if(state?.sessionFile)s.sessionFile=state.sessionFile;const cu=state?.contextUsage;s.contextPercent=typeof cu?.percent==='number'?cu.percent:undefined;if(typeof cu?.tokens==='number')s.contextTokens=cu.tokens;if(typeof cu?.contextWindow==='number')s.contextWindow=cu.contextWindow;const subs=await runner.subagents();const list=Array.isArray(subs?.subagents)?subs.subagents:[];s.subagents=list.length;s.subagentList=list.slice(-50).map(subagentView);
  if(state?.isSettled===true&&s.messages?.some(m=>m.ompAt)){await bindEntries(s,runner);scheduleSave(s,true);}
  if(state?.isSettled===true&&needsBackfill(s))await backfillEntries(s,async()=>{const r=await runner.entries();return {entries:r?.entries,leafId:r?.leafId};});}catch{}}
 // A prompt recorded without OMP's entry ID: sent before the companion bound prompts, or a binding that failed.
 // Slash commands and steers OMP hasn't read are not session entries; nor are collab prompts (custom entries, `from`).
 const unbound=m=>m.role==='user'&&!m.entryId&&!m.ompAt&&!m.steer&&!m.from&&!/^\/\S/.test(m.text);
 const needsBackfill=s=>!s._backfilled&&!s._promptMsg&&!['running','queued'].includes(s.status)&&!!s.messages?.some(unbound);
 // Such prompts can't be matched to OMP's entries by anything but their text, so the transcript is rebuilt from OMP's own
 // entries on its active path instead (once per companion run), which carry every prompt's entry ID. The companion's notes
 // are kept in time order. read() gives OMP's entries and leaf: from the live runner, or the session file when none runs.
 async function backfillEntries(s,read){
  s._backfilled=true;const before=s.messages;
  const r=await read().catch(()=>null),entries=Array.isArray(r?.entries)?r.entries:[],byId=new Map(entries.map(e=>[e?.id,e])),path=new Set();
  for(let id=r?.leafId;id&&!path.has(id);id=byId.get(id)?.parentId)path.add(id);
  const rebuilt=entryMessages(entries.filter(e=>path.has(e?.id)),400,stashImages);
  // A message sent (or any transcript change) while reading wins; the rebuild is dropped and tried again later.
  if(!rebuilt.some(m=>m.entryId))return;
  if(s.messages!==before||['running','queued'].includes(s.status)){s._backfilled=false;return;}
  const t=m=>new Date(m.at).getTime()||0;
  s.messages=[...rebuilt,...before.filter(m=>m.role==='system')].sort((a,b)=>t(a)-t(b)).slice(-600);delete s._entryCursor;scheduleSave(s);
 }
 // The session file's entries and the leaf OMP resumes from when it loads them: the last entry, unless a model_usage entry
 // names another active leaf (OMP's own rule).
 async function fileEntries(file){
  const entries=[];for(const line of (await readTail(file,12*1024*1024)).split('\n')){let f;try{f=JSON.parse(line);}catch{continue;}if(f?.id&&f.type!=='session')entries.push(f);}
  const own=e=>e.type==='model_usage'&&e.activeLeafId!==undefined?e.activeLeafId:e.id,ids=new Set(entries.map(e=>e.id));
  let leafId=entries.length?own(entries.at(-1)):null;
  if(leafId!==null&&!ids.has(leafId))leafId=entries.findLast(e=>own(e)===e.id)?.id??null;
  return {entries,leafId};
 }
 // Gives prompts typed in this panel their OMP entry ID once OMP has stored them (it is settled), matched by the exact
 // timestamp OMP echoed in message_start. Reads only entries newer than the last pass; one attempt per message.
 async function bindEntries(s,runner){
  let r;try{r=await runner.entries(s._entryCursor);}
  catch{if(s._entryCursor){delete s._entryCursor;return bindEntries(s,runner);}for(const m of s.messages)delete m.ompAt;return;}
  const entries=Array.isArray(r?.entries)?r.entries:[];if(entries.length)s._entryCursor=String(entries.at(-1).id);
  const byTime=new Map();for(const e of entries){const p=entryPrompt(e),t=e.message?.timestamp;if(p&&typeof t==='number')byTime.set(t,byTime.has(t)?null:p.entryId);}
  for(const m of s.messages)if(m.ompAt){const id=byTime.get(m.ompAt);if(id)m.entryId=id;delete m.ompAt;}
 }
 // branch and handoff move OMP to a new session file; show that transcript instead of the old one. The file comes from
 // get_state directly: refresh() swallows errors, and re-importing the old file would keep the replaced thread on screen.
 async function reload(s,runner){
  const file=(await runner.state().catch(e=>{throw error(`OMP switched sessions but could not report its new session file: ${e.message}`);}))?.sessionFile;
  if(!file)throw error('OMP switched sessions but did not report its new session file.');
  s.sessionFile=file;await refresh(s,runner);
  // OMP writes a new session's file lazily (after its first reply): none yet is an empty transcript.
  s.messages=await importMessages(file,400,stashImages).catch(e=>{if(e.code==='ENOENT')return [];throw error(`Could not read OMP's new session file: ${e.message}`);});
  delete s._streamId;delete s._thinkId;delete s._promptMsg;delete s._entryCursor;}
 const lock=async(id,fn)=>{const previous=locks.get(id)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);locks.set(id,next);try{return await next;}finally{if(locks.get(id)===next)locks.delete(id);}};
 return {start,lock,refresh,autoApprove,reload,advisorStatus,needsBackfill,backfillEntries,fileEntries,resumeAfterRestart};
}
