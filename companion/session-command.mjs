// Session commands from the dashboard (POST /api/sessions/:id/command): prompts, queues, models, preferences,
// accounts, worktree actions and the rest, plus queued-message dispatch.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { unhostedMessage } from './command-hosts.mjs';
import { now, error, text, samePath } from './util.mjs';
import { textTokens, imagesTokens, chatImages } from './images.mjs';
import { finishWork, askAnswers, btwView, modelUsage, modelUsageText, todoPhases } from './session-views.mjs';
import { THINKING, toolSummary, shellRecord, readSessionHead, treeView, userPrompt } from './transcript.mjs';
import { worktreeChanges, gitLog, gitCommit } from './git.mjs';
import { launchOptions } from './launch.mjs';
export function createSessionCommand(ctx){
 const {start,append,notice,store,refresh,dataDir,execOmp,activity,persist,scheduleSave,runners,accountsChanged,autoApprove,cancelResume,dropSteers,reload,advisorStatus}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const sent=(...args)=>ctx.sent(...args);
 const discardDraft=(...args)=>ctx.discardDraft(...args);
 const worktreeStatus=(...args)=>ctx.worktreeStatus(...args);
 const finishWorktree=(...args)=>ctx.finishWorktree(...args);
 const sessionFileParam=(...args)=>ctx.sessionFileParam(...args);
 const setAdvisorModel=(...args)=>ctx.setAdvisorModel(...args);
 const queuedImageFile=id=>path.join(dataDir,'queued-images',id+'.json');
 // Session toggles the dashboard can change; values are validated in command().
 const PREF_VALUES={fast:[true,false],autoCompaction:[true,false],autoRetry:[true,false],steeringMode:['one-at-a-time','all'],followUpMode:['one-at-a-time','all'],interruptMode:['immediate','wait'],slowMode:[true,false],cacheWarming:['off','streaming','idle']};
 // Runs a local slash command and returns its output instead of adding it to the chat. OMP emits a command's
 // command_output events before the prompt resolves, so they all land while the capture is open.
 async function slashOutput(s,runner,message){const out=s._capture=[];try{await runner.prompt({message});}finally{if(s._capture===out)delete s._capture;}return out.join('\n').trim();}
 // OMP rotates between a provider's OAuth accounts unless the session is pinned (/session pin applies to the current
 // model's provider and survives restarts of that session). Pins the account the user chose, once per runner and choice.
 async function applyAccount(s,runner){
  const provider=s.provider,label=store.accountChoices[provider],key=provider+'\n'+label;
  if(!provider||!label||runner.account===key)return;
  runner.account=key;
  const out=await slashOutput(s,runner,`/session pin ${label}`).catch(e=>e.message);
  if(out.startsWith('Pinned '))return;
  if(/streaming/i.test(out)){delete runner.account;return;}
  notice(s,'warning',`Could not switch ${provider} to ${label}: ${out||'OMP did not answer.'}`);
 }
 // `omp usage` for every logged-in provider (session's first), parsed once for both the /usage chat snapshot and GET /api/usage.
 async function providerUsage(s){
  const {provider,model}=s;if(!provider||!model)throw error('Select a model before checking /usage.');
  try{const {stdout}=await execOmp(['usage','--json'],{cwd:s.cwd,timeout:20000,maxBuffer:8*1024*1024,windowsHide:true});return modelUsage(JSON.parse(stdout),provider,model);}
  catch(e){throw error(`Could not read provider usage: ${String(e.stderr||e.message).trim()}`,502);}
 }
 async function command(s,body,checkedImages,queuedId){
  const allowed=['prompt','steer','follow_up','edit_follow_up','cancel_follow_up','cancel_steer','edit_steer','send_follow_up','answer','auto_approve','abort','stop_commands','complete','compact','hide','set_model','advisor','plan_mode','plan_review','plan_approve','rename','pref','abort_retry','bash','abort_bash','stats','export','branch_messages','branch','edit_last','regenerate','handoff','login_providers','login','tree','new_session','switch_session','interrupt','cycle_model','cycle_thinking','todos','last_reply','launch','predict_word','predict_word_feedback','discard','btw','btw_cancel','btw_history','subagent_cancel','subagent_steer','changes_worktree','git_log','git_commit','worktree_status','worktree_finish'];if(!allowed.includes(body.type))throw error('Unsupported session command.');
  // Draft sessions (created by Enhance on New session) become normal on their first send. Cleared before any await,
  // so a discard can never act on a session whose first message is being dispatched; restored if nothing was sent.
  if(s.draft&&['prompt','steer','follow_up','interrupt','bash','send_follow_up'].includes(body.type)){
   delete s.draft;
   try{return await command(s,body,checkedImages,queuedId);}finally{if(!sent(s)){s.draft=true;scheduleSave(s);}}
  }
  if(body.type==='discard')return discardDraft(s);
  // Composer ghost text (OMP's spelling.autocomplete engine). Never starts OMP; any failure means no suggestion.
  if(body.type==='predict_word'||body.type==='predict_word_feedback'){
   const runner=runners.get(s.id),draft=body.text,cursor=body.cursor;
   if(typeof draft!=='string'||draft.length>200000||!Number.isInteger(cursor)||cursor<0||cursor>draft.length)throw error('Invalid draft.');
   if(!runner?.alive)return {suffix:null};
   if(body.type==='predict_word_feedback'){if(typeof body.suggestion!=='string'||!body.suggestion||body.suggestion.length>200)throw error('Invalid suggestion.');void runner.predictFeedback(draft,cursor,body.suggestion,body.accepted===true).catch(()=>{});return {};}
   // The first request can wait minutes while OMP's prediction daemon loads its engine.
   try{const r=await runner.predictWord(draft,cursor);return {suffix:typeof r?.suffix==='string'&&r.suffix?r.suffix:null};}catch{return {suffix:null};}
  }
  // /btw typed in the composer goes to OMP's side-question channel instead of the transcript, running or not.
  if(['prompt','steer','follow_up','interrupt'].includes(body.type)&&typeof body.message==='string'&&/^\/btw(\s|$)/.test(body.message.trimStart())){
   if(checkedImages?.length||body.images?.length)throw error('Side questions cannot carry images.');
   return command(s,{type:'btw',question:body.message.trimStart().slice(4)});
  }
  if(body.type==='btw'){
   const question=text(body.question,'Side question',20000),recordId=body.recordId===undefined?undefined:text(body.recordId,'Topic',200);
   const runner=await start(s);let r;
   try{r=await runner.btw(question,recordId);}catch(e){throw error(e.message,/still running/.test(e.message)?409:400);}
   // The btw_record frame normally lands first; keep it, since answer deltas may already have been added to it.
   if(r?.record?.id&&!s._btw?.some(x=>x.id===r.record.id))s._btw=[btwView(r.record),...(s._btw||[])].slice(0,20);
   return {record:s._btw?.find(x=>x.id===r?.record?.id)};
  }
  if(body.type==='btw_cancel'){const runner=runners.get(s.id);if(!runner?.alive)return {cancelled:false};const recordId=body.recordId===undefined?undefined:text(body.recordId,'Topic',200);const r=await runner.btwCancel(recordId);return {cancelled:r?.cancelled===true};}
  if(body.type==='btw_history'){const runner=await start(s);const r=await runner.btwHistory();s._btw=(Array.isArray(r?.records)?r.records:[]).filter(x=>x?.id).slice(0,20).map(btwView);return {records:s._btw};}
  // Stop or steer one running subagent of this session (ids from subagents()).
  if(body.type==='subagent_cancel'||body.type==='subagent_steer'){
   const id=text(body.id,'Subagent ID',200),runner=runners.get(s.id);
   if(!s.subagentList?.some(a=>a.id===id))throw error('This subagent is not part of this session.',404);
   if(!runner?.alive)throw error('OMP is no longer running.',409);
   if(body.type==='subagent_cancel'){const r=await runner.cancelSubagent(id);await refresh(s,runner);return {cancelled:r?.cancelled===true};}
   const message=text(body.message,'Message',20000);
   try{await runner.steerSubagent(id,message);}catch(e){throw error(e.message,409);}
   return {steered:true};
  }
  if(body.type==='changes_worktree')return worktreeChanges(s,body.base==='head'?'head':'start');
  if(body.type==='git_log')return gitLog(s);
  if(body.type==='git_commit')return gitCommit(s,body.sha);
  if(body.type==='worktree_status')return worktreeStatus(s);
  if(body.type==='worktree_finish')return finishWorktree(s,body.action,{commit:body.commit===true});
  const prompting=['prompt','steer','follow_up','interrupt'].includes(body.type);
  const images=prompting?(checkedImages??chatImages(body)):[];
  if(prompting&&s._task)throw error(`Wait for OMP to finish first (${s._task.replace(/…$/,'').toLowerCase()}).`);
  if(body.type==='answer'){
   const runner=runners.get(s.id),id=text(body.id,'Question ID',200),q=s.uiRequests?.find(q=>q.id===id);
   if(!runner?.alive||!q)throw error('This question is no longer pending.');
   // A panel takes terminal input (one key or bracketed paste per string) and its size in cells (custom-ui.mjs clamps it),
   // and stays until its component is done; Close aborts it.
   if(q.method==='custom'){
    if(body.cancelled===true){runner.answer(id,{cancelled:true});s.uiRequests=s.uiRequests.filter(x=>x.id!==id);return s;}
    if(body.resize!==undefined){const columns=body.resize?.columns,rows=body.resize?.rows;if(!Number.isFinite(columns)||!Number.isFinite(rows))throw error('Panel size must be numeric columns and rows.');runner.answer(id,{resize:{columns,rows}});return s;}
    const keys=[].concat(body.input??[]);
    if(!keys.length||keys.length>500||keys.some(k=>typeof k!=='string'||!k)||keys.join('').length>20000)throw error('Panel input must be keys under 20,000 characters.');
    runner.answer(id,{input:keys});return s;
   }
   const reply={};
   if(body.cancelled===true)reply.cancelled=true;
   else if(q.method==='ask')reply.answers=askAnswers(q,body.answers);
   else if(q.method==='confirm'){if(typeof body.confirmed!=='boolean')throw error('Choose Yes, No, or Cancel.');reply.confirmed=body.confirmed;}
   else{if(typeof body.value!=='string'||body.value.length>20000)throw error('Answer must be text under 20,000 characters.');if(q.method==='select'&&!q.options.includes(body.value))throw error('Choose one of the listed options.');reply.value=body.value;}
   runner.answer(id,reply);s.uiRequests=s.uiRequests.filter(x=>x.id!==id);return s;
  }
  // Approves OMP's tool-approval prompts as they arrive (approvalPrompt); turning it on also approves the ones already waiting.
  if(body.type==='auto_approve'){
   if(typeof body.enabled!=='boolean')throw error('Auto-approve must be true or false.');
   if(body.enabled){s.autoApprove=true;const runner=runners.get(s.id);if(runner?.alive)for(const q of (s.uiRequests||[]).filter(q=>q._approval))await autoApprove(s,runner,q.id,q._approval);}
   else{delete s.autoApprove;cancelResume(s,'auto-approve turned off');}
   await persist(s);return s;
  }
  if(body.type==='send_follow_up'){
   const queue=s.queuedMessages||[];const i=queue.findIndex(q=>q.id===body.id);
   if(i<0)throw error('Queued message was already sent or removed.');
   const item=queue[i];const images=item.hasImage?chatImages({images:JSON.parse(await fs.readFile(queuedImageFile(item.id),'utf8'))}):[];
   const live=['running','queued'].includes(s.status);
   const result=await command(s,{type:live?'steer':'prompt',message:item.text,preview:item.imagePreview},images,item.id);
   if(result.status==='error')return result;
   s.queuedMessages=(s.queuedMessages||[]).filter(q=>q.id!==item.id);await persist(s);
   if(item.hasImage)await fs.rm(queuedImageFile(item.id),{force:true}).catch(()=>{});
   return s;
  }
  if(body.type==='edit_follow_up'||body.type==='cancel_follow_up'){
   const queue=s.queuedMessages||[];const i=queue.findIndex(q=>q.id===body.id);
   if(i<0)throw error('Queued message was already sent or removed.');
   if(body.type==='edit_follow_up'){const value=body.message;queue[i].text=queue[i].hasImage&&typeof value==='string'&&!value.trim()?'':text(value,'Message',200000);}
   else{const [item]=queue.splice(i,1);await persist(s);if(item.hasImage)await fs.rm(queuedImageFile(item.id),{force:true}).catch(()=>{});return s;}
   await persist(s);return s;
  }
  if(body.type==='cancel_steer'||body.type==='edit_steer'){
   const m=s.messages.find(m=>m.id===body.id);
   if(!m){if(body.type==='cancel_steer')return s;throw error('This steer is no longer available.');}
   if(m.steer==='dropped')throw error('This steer was not delivered.');
   if(body.type==='edit_steer'&&m.hasImage)throw error('Steers with images can only be cancelled.');
   const runner=runners.get(s.id);
   const r=m.steer==='pending'&&runner?.alive?await runner.removeQueued(m.hasImage&&m.text==='Image attached'?'':m.text,'steering'):null;
   if(!r?.removed){
    if(m.steer==='pending'&&!runner?.alive)throw error('OMP is no longer running.');
    // Delivery can win the cancel request before its transcript echo arrives.
    if(m.steer==='pending')m.steer='received';
    if(body.type==='cancel_steer')notice(s,'info','OMP has already started delivering this steer; it can no longer be cancelled.');
    await persist(s);if(body.type==='edit_steer')throw error('OMP already read this steer.');
    return s;
   }
   // RPC events can reorder the transcript while removal is awaiting its reply.
   const i=s.messages.indexOf(m);if(i>=0)s.messages.splice(i,1);await persist(s);
   return body.type==='edit_steer'?command(s,{type:'steer',message:body.message}):s;
  }
  if(body.type==='set_model'){
   const {selector,thinking}=modelChoice(body);
   // The live model's own levels (OMP would otherwise clamp silently); another model is checked by OMP when it applies.
   const live=runners.get(s.id)?.alive&&s._thinkingLevels?.length&&(!selector||selector===`${s.provider}/${s.model}`);
   if(live&&thinking&&thinking!=='auto'&&!s._thinkingLevels.includes(thinking))throw error(`${s.model} has no ${thinking} reasoning level; it offers ${s._thinkingLevels.join(', ')}.`,409);
   if(selector)s.modelSelector=selector;if(thinking)s.thinkingChoice=thinking;
   const runner=runners.get(s.id);if(runner?.alive){const i=selector.indexOf('/');if(selector)await runner.setModel(selector.slice(0,i),selector.slice(i+1));if(thinking)await runner.setThinking(thinking);await refresh(s,runner);}
   else{if(selector){const i=selector.indexOf('/');s.provider=selector.slice(0,i);s.model=selector.slice(i+1);}if(thinking)s.thinking=thinking;}
   await persist(s);return s;
  }
  const busy=()=>{if(['running','queued'].includes(s.status)||s._task||s._bash)throw error('Wait for OMP to finish first.');};
  if(['plan_mode','plan_review','plan_approve'].includes(body.type)){
   let call;
   if(body.type==='plan_mode'){
    if(typeof body.enabled!=='boolean')throw error('Plan mode enabled must be true or false.');
    if(body.workflow!==undefined&&!['parallel','iterative'].includes(body.workflow))throw error('Choose parallel or iterative planning.');
    call=runner=>runner.setPlanMode(body.enabled,body.workflow);
   }else if(body.type==='plan_approve'){
    const proposalId=text(body.proposalId,'Proposal ID',200);
    if(!['preserve','fresh','compact','refine','save'].includes(body.action))throw error('Choose an approval action or request refinement.');
    if(body.feedback!==undefined&&(typeof body.feedback!=='string'||body.feedback.length>20000))throw error('Feedback must be text under 20,000 characters.');
    if(body.action==='refine'&&!body.feedback?.trim())throw error('Refinement requires feedback describing what should change.');
    if(body.action!=='refine'&&body.feedback?.trim())throw error('Feedback is only supported for refinement.');
    if(body.executionModel!==undefined&&(typeof body.executionModel!=='string'||!/^[\w.~@+-]+\/[\w.~@:+\/-]+$/.test(body.executionModel)))throw error('Invalid execution model.');
    if(body.action==='refine'&&body.executionModel!==undefined)throw error('Refinement keeps the planning model; do not select an execution model.');
    if(body.action==='save'&&body.executionModel!==undefined)throw error('Save and quit does not run the plan; do not select an execution model.');
    if(body.savePath!==undefined&&(body.action!=='save'||typeof body.savePath!=='string'||body.savePath.length>1000))throw error('A save path is only for Save and quit, as text under 1,000 characters.');
    if(s._planReview?.id!==proposalId)throw error('This plan is no longer pending. Reopen the current plan before approving.',409);
    const request={proposalId,action:body.action,...(body.feedback?.trim()?{feedback:body.feedback.trim()}:{}),...(body.executionModel?{executionModel:body.executionModel}:{}),...(body.savePath?.trim()?{savePath:body.savePath.trim()}:{})};
    call=runner=>runner.approvePlan(request);
   }else call=runner=>runner.reviewPlan();
   busy();const runner=await start(s);
   if(!s._planSupported)throw error('This OMP build does not expose plan mode over RPC. Set OMP_BIN to an updated build or the patched checkout’s packages/coding-agent/src/cli.ts.',409);
   try{const result=await call(runner);
    if(body.type==='plan_review')s._planReview=result?.proposal;
    if(body.type==='plan_approve'){if(s._planReview?.id===body.proposalId)delete s._planReview;if(body.action!=='refine'&&body.action!=='save'||body.feedback?.trim())s.status='running';}
    // Save and quit (OMP's TUI): the plan was saved and OMP started a fresh session, as the ⋯ menu's new session does.
    if(body.type==='plan_approve'&&body.action==='save'){
     if(result?.sessionChanged){s.messages=[];s.todos=[];s.subagentList=[];delete s.contextTokens;delete s.contextPercent;await reload(s,runner);}
     append(s,'system',result?.note||'Saved the plan.');s.status='paused';await persist(s);return s;
    }
    await refresh(s,runner);await persist(s);return body.type==='plan_review'?{proposal:s._planReview}:s;
   }catch(e){throw error(e.message,e.code==='stale_proposal'?409:400);}
  }
  if(body.type==='rename'){const name=text(body.name,'Session name',120);const runner=runners.get(s.id);if(runner?.alive)await runner.setSessionName(name);s.title=name;delete s.autoTitle;await persist(s);return s;}
  if(body.type==='pref'){
   if(!Object.hasOwn(PREF_VALUES,body.key)||!PREF_VALUES[body.key].includes(body.value))throw error('Invalid session setting.');
   const runner=await start(s);try{await runner.setPref(body.key,body.value);}catch(e){throw error(e.message);}
   // Slow mode belongs to the live model (Anthropic's is OMP's global config), so it is not replayed on restarts.
   if(body.key!=='slowMode')(s.prefs??={})[body.key]=body.value;await refresh(s,runner);await persist(s);return s;
  }
  if(body.type==='abort'||body.type==='abort_retry'){
   // Retry-only abort cancels backoff, but not an in-flight request or scheduled continuation.
   const runner=runners.get(s.id);if(runner?.alive)await runner.abort();
   finishWork(s);s.status='paused';s.error=undefined;dropSteers(s);cancelResume(s,'session stopped');
   delete s._promptId;delete s._promptMsg;delete s._interrupt;delete s._retry;delete s._compacting;delete s.uiRequests;delete s._planReview;
   await persist(s);return s;
  }
  if(body.type==='abort_bash'){const runner=runners.get(s.id);if(runner?.alive)await runner.abortBash();return s;}
  if(body.type==='stop_commands'){const runner=runners.get(s.id);if(runner?.alive)await runner.stopCommands(typeof body.run==='string'?body.run:undefined);return s;}
  if(body.type==='tree'){const runner=await start(s);return treeView(await runner.tree());}
  if(body.type==='last_reply'){const runner=await start(s);const r=await runner.lastAssistantText();return {text:typeof r?.text==='string'?r.text:''};}
  if(body.type==='cycle_model'||body.type==='cycle_thinking'){
   const runner=await start(s);const r=body.type==='cycle_model'?await runner.cycleModel():await runner.cycleThinking();
   if(!r)throw error(body.type==='cycle_model'?'OMP has only one model to cycle through. Configure model roles or scoped models.':'This model has no thinking levels to cycle through.');
   // Remember the choice so a restarted runner keeps it.
   if(r.model?.provider&&r.model?.id){s.modelSelector=`${r.model.provider}/${r.model.id}`;if(r.thinkingLevel)s.thinkingChoice=r.thinkingLevel;}
   if(typeof r.level==='string')s.thinkingChoice=r.level;
   await refresh(s,runner);await persist(s);return s;
  }
  if(body.type==='todos'){const phases=todoPhases(body.phases);const runner=await start(s);const r=await runner.setTodos(phases);s.todos=Array.isArray(r?.todoPhases)?r.todoPhases:phases;await persist(s);return s;}
  if(body.type==='launch'){
   busy();const launch=await launchOptions(body.launch);
   if(JSON.stringify(launch??null)!==JSON.stringify(s.launch??null)){
    if(launch)s.launch=launch;else delete s.launch;
    // Launch flags are read at startup, so a live runner restarts (idle only) to apply them.
    if(runners.get(s.id)?.alive){const prev=s.status;runners.get(s.id).kill();for(let i=0;i<50&&runners.has(s.id);i++)await new Promise(r=>setTimeout(r,100));await start(s);s.status=prev;s.error=undefined;}
    append(s,'system',launch?'Launch options updated. OMP restarted with them.':'Launch options cleared. OMP restarted with its defaults.');
   }
   await persist(s);return s;
  }
  if(body.type==='compact'){
   busy();const runner=await start(s);const instructions=typeof body.instructions==='string'?body.instructions.trim().slice(0,5000):'';s._task='Compacting context…';s._compacting=true;
   runner.compact(instructions||undefined).then(async r=>{await refresh(s,runner);append(s,'system',`Context compacted${typeof r?.tokensBefore==='number'?` (was ${r.tokensBefore.toLocaleString('en-US')} tokens)`:''}.`);},e=>append(s,'system',`Compaction failed: ${e.message}`))
    .finally(()=>{delete s._task;s._compacting=false;void persist(s);});
   await persist(s);return s;
  }
  if(body.type==='new_session'||body.type==='switch_session'){
   busy();let file;
   if(body.type==='switch_session'){file=sessionFileParam(body.file);const other=store.sessions.find(x=>x.id!==s.id&&!x.hidden&&x.sessionFile&&samePath(x.sessionFile,file));if(other)throw error(`That session is already open in the panel as “${other.title}”.`,409);}
   const runner=await start(s);
   const r=body.type==='new_session'?await runner.newSession():await runner.switchSession(file);
   if(r?.cancelled)throw error('An extension cancelled the session change.');
   s.messages=[];s.todos=[];s.subagentList=[];delete s.contextTokens;delete s.contextPercent;await reload(s,runner);
   if(body.type==='switch_session'){const head=await readSessionHead(file).catch(()=>null);if(head?.title)s.title=head.title.slice(0,120);}
   append(s,'system',body.type==='new_session'?'Started a fresh OMP session. The previous conversation stays in its own session file.':'Switched to another saved OMP session.');
   s.status='paused';await persist(s);return s;
  }
  // Runs outside the session lock (timeout 0) so Stop, answers and other commands still get through while it works.
  if(body.type==='bash'){
   const cmd=text(body.command,'Command',20000);if(s._bash)throw error('A shell command is already running.');
   const runner=await start(s);const msg=append(s,'tool','bash','tool-bash-'+randomUUID());msg.tool=shellRecord(cmd);msg.startedAt=now();msg.text=toolSummary(msg.tool);s._bash=msg.id;
   runner.bash(cmd).then(r=>Object.assign(msg.tool,shellRecord(cmd,r)),e=>{msg.tool.status='error';msg.tool.result=e.message;})
    .finally(()=>{msg.tool.ms=Date.now()-new Date(msg.startedAt).getTime();msg.text=toolSummary(msg.tool);delete s._bash;scheduleSave(s);});
   await persist(s);return s;
  }
  if(body.type==='stats'){const runner=await start(s);return {stats:await runner.sessionStats()};}
  if(body.type==='export'){
   const runner=await start(s);const dir=path.join(dataDir,'exports');await fs.mkdir(dir,{recursive:true,mode:0o700});
   const r=await runner.exportHtml(path.join(dir,s.id+'.html'));
   return {name:(s.title.replace(/[^\w.-]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'omp-session')+'.html',html:await fs.readFile(r?.path||path.join(dir,s.id+'.html'),'utf8')};
  }
  if(body.type==='branch_messages'){busy();const runner=await start(s);const r=await runner.branchMessages();return {messages:(Array.isArray(r?.messages)?r.messages:[]).map(m=>({entryId:String(m.entryId),text:String(m.text||'').slice(0,300)})).reverse()};}
  // OMP's host API has no in-place tree move (navigateTree is TUI and extension only): its `branch` copies the path up to just
  // before a user message into a new session file, keeping the old file intact. Edit last / Regenerate rewind with it too.
  if(body.type==='branch'||body.type==='edit_last'||body.type==='regenerate'){
   busy();const runner=await start(s);const entryId=body.type==='branch'?text(body.entryId,'Message',200):undefined;
   const picked=userPrompt(await runner.entries(),entryId);
   if(!picked&&entryId===undefined)throw error('OMP has no message of yours in this conversation yet.');
   const r=await runner.branch(entryId??picked.entryId);if(r?.cancelled)throw error('An extension cancelled the branch.');
   await reload(s,runner);s.status='paused';
   if(body.type==='regenerate'){append(s,'system','Went back to before your last message in a new session and sent it again. The previous reply stays in the old session file.');return command(s,{type:'prompt',message:picked.text},picked.images);}
   append(s,'system',body.type==='branch'?'Branched into a new session from this point. The message you picked is back in the composer.':'Went back to before your last message in a new session. It is back in the composer to edit and resend.');
   await persist(s);return {session:s,text:typeof r?.text==='string'?r.text:picked?.text||'',images:picked?.images||[]};
  }
  if(body.type==='handoff'){
   busy();const runner=await start(s);const instructions=typeof body.instructions==='string'?body.instructions.trim().slice(0,5000):'';s._task='Writing the handoff…';
   runner.handoff(instructions||undefined).then(async r=>{await reload(s,runner);append(s,'system',`Handed off to a fresh session${r?.savedPath?`. Handoff document: ${r.savedPath}`:''}.`);},e=>append(s,'system',`Handoff failed: ${e.message}`))
    .finally(()=>{delete s._task;void persist(s);});
   await persist(s);return s;
  }
  if(body.type==='login_providers'){const runner=await start(s);const r=await runner.loginProviders();return {providers:(Array.isArray(r?.providers)?r.providers:[]).map(p=>({id:String(p.id),name:String(p.name||p.id),available:p.available!==false,authenticated:!!p.authenticated}))};}
  // OAuth runs until the user finishes in the browser; the link arrives as open_url, pasted codes as input questions.
  if(body.type==='login'){
   const id=text(body.provider,'Provider',100);const runner=await start(s);notice(s,'info',`Starting ${id} login…`);
   runner.login(id).then(()=>{notice(s,'info',`Logged in to ${id}.`);accountsChanged();},e=>notice(s,'error',`Login to ${id} failed: ${e.message}`)).finally(()=>{delete s._openUrl;scheduleSave(s);});
   return s;
  }
  if(['hide','complete'].includes(body.type)&&s.queuedMessages?.length)throw error('Send or remove queued messages before closing this session.');
  if(body.type==='hide'){if(s.status==='running')throw error('Stop the session before removing it from the panel.');runners.get(s.id)?.kill();s.hidden=true;await persist(s);return s;}
  if(body.type==='complete'){if(!['review','paused','done','error'].includes(s.status))throw error('Stop or finish the session before marking it complete.');s.status='done';cancelResume(s,'session marked complete');activity(s,`Completed ${s.title}`,'done');await persist(s);return s;}
  if(prompting){if(typeof body.message!=='string')throw error('Prompt is required.');body.message=images.length&&!body.message.trim()?'':text(body.message,'Prompt',200000);const full=contextError(s,body.message,images);if(full)throw error(full);}
  if(prompting&&/^\/usage(?:\s+show)?$/.test(body.message)){
   if(images.length)throw error('Remove image attachments before checking /usage.');
   const runner=await start(s);await refresh(s,runner);
   const report=modelUsageText(await providerUsage(s));
   append(s,'user',body.message,queuedId||randomUUID());append(s,'assistant',report);s.updatedAt=now();
   await persist(s);return s;
  }
  const slashCommand=prompting&&/^\/\S/.test(body.message);
  // OMP's own state decides whether it is busy; a drifted status would otherwise send a prompt OMP rejects.
  if(prompting&&!['running','queued'].includes(s.status)&&runners.get(s.id)?.alive){await refresh(s,runners.get(s.id));if(s.status==='running'&&body.type==='prompt'&&!slashCommand)body.type='steer';}
  if(body.type==='interrupt'){if(slashCommand)throw error('Run slash commands with Enter; Stop & send is for messages.');if(!['running','queued'].includes(s.status))body.type='prompt';}
  if(prompting&&images.length&&/^\/skill:/.test(body.message)){await start(s);if(!s._skillImages)throw error('This OMP build drops image attachments on /skill: commands. Set OMP_BIN to an updated build, or send the image in a normal message, then invoke the skill.');}
  if(prompting&&/^\/goal(?:\s|$)/.test(body.message)){
   await start(s);
   if(!s._goalSupported)throw error('This OMP build has no goal mode the companion can host (see the companion log); /goal was not sent to the model.',409);
   if(!s._goalAvailable)throw error('Goal mode is disabled in OMP. Enable goal.enabled in OMP settings; /goal was not sent to the model.',409);
  }
  // OMP built-ins that only its terminal UI runs, and the companion does not host: rejected, never sent as text.
  const slashName=prompting?body.message.match(/^\/([^\s:]+)/)?.[1]:undefined;
  if(slashName&&!['goal','plan','plan-review'].includes(slashName)){await start(s);if(s._unhosted?.includes(slashName))throw error(unhostedMessage(slashName),409);}
  if(body.type==='follow_up'&&['running','queued'].includes(s.status)){
   const item={id:randomUUID(),text:body.message,hasImage:!!images.length,imagePreview:images.length?body.preview:undefined,at:now()};
   if(images.length){await fs.mkdir(path.dirname(queuedImageFile(item.id)),{recursive:true,mode:0o700});await fs.writeFile(queuedImageFile(item.id),JSON.stringify(images),{mode:0o600});}
   (s.queuedMessages??=[]).push(item);await persist(s);return s;
  }
  if(body.type==='follow_up')body.type='prompt';
  if(body.type==='advisor'){
   if(!['on','off','status','model'].includes(body.action))throw error('Invalid advisor action.');
   const runner=await start(s);
   if(body.action==='model'){
    // A running OMP reads its advisors only at startup, so the session is restarted (while idle) to pick up the new model.
    if(['running','queued'].includes(s.status))throw error('Wait for this turn to finish, then change the advisor model.');
    const where=await setAdvisorModel(text(body.model,'Advisor model',300));
    const prev=s.status;runners.get(s.id)?.kill();
    for(let i=0;i<50&&runners.has(s.id);i++)await new Promise(r=>setTimeout(r,100));
    const fresh=await start(s);s.status=prev;s.error=undefined;
    s._silentAdvisorUntil=Date.now()+5000;await fresh.prompt({message:'/advisor on'});
    append(s,'system',`Advisor model set to ${body.model} (${where}).`);
    await advisorStatus(s,fresh);await persist(s);return s;
   }
   // The composer's advisor chip shows the result, so the on/off reply stays out of the chat.
   if(body.action!=='status'){s._silentAdvisorUntil=Date.now()+5000;await runner.prompt({message:`/advisor ${body.action}`});}
   await advisorStatus(s,runner);await persist(s);return s;}
  if(body.type==='prompt'&&s.status==='running'&&!slashCommand)throw error('This session is running. Use Steer or Queue follow-up.');
  try{
   const runner=await start(s);
   // Before the turn starts: OMP refuses to change the account mid-stream.
   if(prompting&&s.status!=='running')await applyAccount(s,runner);
   if(prompting&&/^\/plan(?:-review)?(?:\s|$)/.test(body.message)&&!s._planSupported)throw error('This OMP build has no RPC plan mode. Use an updated OMP build; /plan was not sent to the model.');
   // Only prompt dispatch executes slash commands; steer would queue their literal text.
   // Stop & send: OMP aborts the turn and starts this prompt in one step (interrupt).
   const interrupt=body.type==='interrupt';
   const kind=slashCommand?'prompt':interrupt?'interrupt':body.type,wasRunning=['running','queued'].includes(s.status);
   // A message of the user's own supersedes a pending rate-limit resume; slash commands (say /usage) leave it armed.
   let msg;if(prompting){if(!slashCommand){cancelResume(s);if(body.type==='prompt'||interrupt){delete s._streamId;delete s._thinkId;}s.status='running';s.error=undefined;}msg=append(s,'user',body.message||'Image attached',queuedId||randomUUID());if(body.type==='steer'&&!slashCommand)msg.steer='pending';if(images.length){msg.hasImage=true;if(body.preview)msg.imagePreview=body.preview;}}
   const id=randomUUID();
   if((kind==='prompt'||interrupt)&&!slashCommand){s._promptId=id;s._promptMsg=msg.id;}
   if(interrupt){s._interrupt=id;delete s._retry;}
   const input={id,...(prompting?{message:body.message,...(slashCommand&&wasRunning?{streamingBehavior:'steer'}:{}),...(images.length?{images}:{})}:{})};
   const result=kind==='prompt'?await runner.prompt(input,slashCommand?0:30000):kind==='steer'?await runner.steer(input):kind==='follow_up'?await runner.followUp(input):await runner.interrupt(input);
   // Local commands must not replace the active turn's result correlation.
   if(slashCommand&&(result?.agentInvoked===true||(!wasRunning&&result?.agentInvoked!==false)))s._promptId=id;
   if(kind==='prompt'&&result?.agentInvoked===false&&!slashCommand){s.status='review';delete s._promptMsg;}
   if(slashCommand){
    if(result?.agentInvoked===true)s.status='running';
    // The command replaced the transcript (/fork, /clear): show the session as OMP now has it.
    if(result?.sessionChanged){await reload(s,runner);if(result.note)append(s,'system',result.note);}else await refresh(s,runner);
    if(result?.failed)throw new Error(`/${slashName} failed; see its output above.`);
   }
   await persist(s);return s;
  }catch(e){if(slashCommand){await persist(s);throw error(e.message);}delete s._interrupt;delete s._promptMsg;s.status='error';s.error=e.message;dropSteers(s);append(s,'system',e.message);await persist(s);return s;}
 }
 // Room left in the session's context window, or null when the window is unknown (no runner state yet and the
 // model isn't in the cached model list, e.g. "OMP default"): then only the upload size limits images.
 function contextLeft(s){
  const sel=s.modelSelector||(s.provider&&s.model&&s.model!=='OMP default'?`${s.provider}/${s.model}`:'');
  const win=s.contextWindow||(sel&&ctx.modelCache?.data.models.find(m=>m.selector===sel)?.contextWindow);
  return win>0?{left:Math.max(0,win-(s.contextTokens||0)),win}:null;
 }
 function contextError(s,message,images){
  const c=images.length?contextLeft(s):null;if(!c)return '';
  const img=imagesTokens(images),txt=textTokens(message),n=v=>v.toLocaleString('en-US');
  return img+txt>c.left?`Not enough context left for this message: it needs about ${n(img+txt)} tokens (${images.length} ${images.length===1?'image':'images'} ≈ ${n(img)}, text ≈ ${n(txt)}), but only ${n(c.left)} of ${n(c.win)} tokens remain. Remove some images, or run /compact or start a new session.`:'';
 }
 async function sendQueued(s){
  while(s.queuedMessages?.length&&s.status==='running'){
   // Follow-up mode "all" delivers every queued message as one prompt, like OMP's own queue,
   // unless their combined text and images don't fit the context left; then they go one at a time.
   let batch=s.prefs?.followUpMode==='all'?s.queuedMessages.slice():[s.queuedMessages[0]];
   const load=async list=>{const out=[];for(const q of list)if(q.hasImage)out.push(...JSON.parse(await fs.readFile(queuedImageFile(q.id),'utf8')));return out;};
   let raw=await load(batch);if(batch.length>1&&contextError(s,batch.map(q=>q.text).join('\n\n'),raw)){batch=[batch[0]];raw=await load(batch);}
   const item=batch[0],images=raw.length?chatImages({images:raw}):[];
   const message=batch.length>1?batch.map(q=>q.text).filter(Boolean).join('\n\n'):item.text;
   const preview=batch.length>1?batch.flatMap(q=>[].concat(q.imagePreview??[])):item.imagePreview;
   s.status='review';
   // A message that alone no longer fits stays queued, holding back the ones behind it: the user can compact, edit or remove it.
   try{await command(s,{type:'prompt',message,preview:Array.isArray(preview)&&!preview.length?undefined:preview},images,item.id);}
   catch(e){notice(s,'error',`The next queued message was not sent and stays queued, with any queued after it. ${e.message}`);return;}
   if(s.status==='error'){s.messages=s.messages.filter(m=>m.id!==item.id);await persist(s);return;}
   if(ctx.closing)return;
   const sent=new Set(batch.map(q=>q.id));s.queuedMessages=s.queuedMessages.filter(q=>!sent.has(q.id));
   await persist(s);
   for(const q of batch)if(q.hasImage)await fs.rm(queuedImageFile(q.id),{force:true}).catch(()=>{});
   if(s.status==='review'&&s.queuedMessages.length)s.status='running';
   else break;
  }
 }
 function modelChoice(body){
  const raw=typeof body.model==='string'?body.model.trim():'';if(raw&&!/^[\w.~@+-]+\/[\w.~@:+\/-]+$/.test(raw))throw error('Invalid model.');
  const suffix=raw.includes(':')?raw.split(':').pop():'';
  const thinking=typeof body.thinking==='string'&&body.thinking?body.thinking:THINKING.includes(suffix)?suffix:'';if(thinking&&!THINKING.includes(thinking))throw error('Invalid thinking level.');
  return {selector:THINKING.includes(suffix)?raw.slice(0,-suffix.length-1):raw,thinking};
 }
 return {command,sendQueued,providerUsage,modelChoice};
}
