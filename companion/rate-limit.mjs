// Rate-limit resume: a session stopped by a provider limit continues by itself once the limit resets.

export function createRateLimit(ctx){
 const {append,notice,scheduleSave}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const command=(...args)=>ctx.command(...args);
 const lock=(...args)=>ctx.lock(...args);
 // Auto-approve: a run that OMP stopped on a provider 429 resumes once the provider's retry-after-ms wait is over, by
 // resending the last user message like the dashboard's Retry. The due time is persisted (rateLimitResume), so a
 // companion restart re-arms the wait instead of losing it; resumeTimers only holds the in-process timer.
 const resumeTimers=new Map();
 // The suffix OMP appends to provider errors (RETRY_AFTER_MS_SUFFIX in packages/ai oneshot-retry).
 function rateLimitHint(message){const text=String(message||''),m=/(?:^|\s)retry-after-ms=([0-9]+(?:\.[0-9]+)?)(?=\s|$)/i.exec(text);return m&&/\b429\b/.test(text)?{ms:Number(m[1]),from:Date.now()}:undefined;}
 const clockTime=d=>{const p=n=>String(n).padStart(2,'0'),t=`${p(d.getHours())}:${p(d.getMinutes())}`;return d.toDateString()===new Date().toDateString()?t:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${t}`;};
 function scheduleResume(s){
  const hint=s._rateLimit;delete s._rateLimit;
  if(!hint||!s.autoApprove)return;
  const at=new Date(hint.from+hint.ms);s.rateLimitResume={at:at.toISOString()};
  append(s,'system',`Rate limit reached; resuming automatically at ${clockTime(at)}.`);armResume(s);
 }
 function armResume(s){
  clearTimeout(resumeTimers.get(s.id));
  // setTimeout caps at ~24.8 days; resumeRateLimited re-arms when it fires early.
  const t=setTimeout(()=>{resumeTimers.delete(s.id);void resumeRateLimited(s);},Math.min(Math.max(0,Date.parse(s.rateLimitResume.at)-Date.now()),2**31-1));
  t.unref();resumeTimers.set(s.id,t);
 }
 // reason is shown in the chat; omitted when the user caused the cancel (a new message) or the wait no longer applies.
 function cancelResume(s,reason){
  clearTimeout(resumeTimers.get(s.id));resumeTimers.delete(s.id);
  if(!s.rateLimitResume)return;delete s.rateLimitResume;
  if(reason)append(s,'system',`Automatic resume cancelled: ${reason}.`);scheduleSave(s);
 }
 function resumeRateLimited(s){
  return lock(s.id,async()=>{
   const r=s.rateLimitResume;if(!r||ctx.closing)return;
   if(Date.parse(r.at)>Date.now())return armResume(s);
   if(!s.autoApprove||s.status!=='error'||s.hidden)return cancelResume(s);
   const last=[...s.messages].reverse().find(m=>m.role==='user');
   if(!last)return cancelResume(s,'no message to resend');
   if(last.hasImage)return cancelResume(s,'the last message had an image; reattach it and send it again');
   cancelResume(s);append(s,'system','Rate limit wait is over; resuming automatically.');
   try{await command(s,{type:'prompt',message:last.text});}catch(e){notice(s,'error',`Automatic resume failed: ${e.message}`);}
  });
 }
 return {rateLimitHint,scheduleResume,armResume,cancelResume};
}
