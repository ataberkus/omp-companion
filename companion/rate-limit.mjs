// Automatic resume: a session stopped by a provider limit, or by a connection that dropped before the provider answered,
// continues by itself.

// Waits before each automatic resend after a lost connection; their count is the most it resends in a row.
const CONNECTION_DELAYS=[5000,15000,45000];
export function createRateLimit(ctx){
 const {append,notice,scheduleSave}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const command=(...args)=>ctx.command(...args);
 const lock=(...args)=>ctx.lock(...args);
 // Auto-approve only, by resending the last user message like the dashboard's Retry:
 // - a run OMP stopped on a provider 429, once the provider's retry-after-ms wait is over (rateLimitResume);
 // - a run whose connection dropped before any response and that OMP did not retry itself (its retry is off): up to
 //   three resends, CONNECTION_DELAYS after each failure (connectionResume, with its attempt number).
 // The due time is persisted, so a companion restart re-arms the wait instead of losing it; resumeTimers only holds the
 // in-process timer.
 const resumeTimers=new Map();
 const due=s=>s.rateLimitResume||s.connectionResume;
 // The suffix OMP appends to provider errors (RETRY_AFTER_MS_SUFFIX in packages/ai oneshot-retry).
 function rateLimitHint(message){const text=String(message||''),m=/(?:^|\s)retry-after-ms=([0-9]+(?:\.[0-9]+)?)(?=\s|$)/i.exec(text);return m&&/\b429\b/.test(text)?{ms:Number(m[1]),from:Date.now()}:undefined;}
 // A transport failure before the provider answered (OMP's ConnectionLostBeforeResponseError and socket errors) is
 // transient. A provider's own 4xx (bar 408) or request validation error judged the request itself, so it stays an error.
 function connectionHint(message){
  const text=String(message||''),status=Number(/^\s*(\d{3})\b/.exec(text)?.[1]);
  if((status>=400&&status<500&&status!==408)||/invalid_request_error/i.test(text))return undefined;
  return /\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\b|socket hang up|before any response/i.test(text)||undefined;
 }
 const clockTime=d=>{const p=n=>String(n).padStart(2,'0'),t=`${p(d.getHours())}:${p(d.getMinutes())}`;return d.toDateString()===new Date().toDateString()?t:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${t}`;};
 // Called once a run ended in error for good (its terminal prompt_result).
 function scheduleResume(s){
  const hint=s._rateLimit,lost=s._connectionLost;delete s._rateLimit;delete s._connectionLost;
  if(!s.autoApprove||due(s))return;
  if(hint){
   const at=new Date(hint.from+hint.ms);s.rateLimitResume={at:at.toISOString()};
   append(s,'system',`Rate limit reached; resuming automatically at ${clockTime(at)}.`);armResume(s);
  }else if(lost){
   const attempt=(s._connectionAttempt||0)+1,max=CONNECTION_DELAYS.length;
   if(attempt>max){append(s,'system',`Connection lost again after ${max} automatic resends; use Retry last message to try again.`);return;}
   const wait=CONNECTION_DELAYS[attempt-1];s.connectionResume={at:new Date(Date.now()+wait).toISOString(),attempt};
   append(s,'system',`Connection lost before the provider answered; resending automatically in ${wait/1000} s (attempt ${attempt} of ${max}).`);armResume(s);
  }
 }
 function armResume(s){
  clearTimeout(resumeTimers.get(s.id));
  // setTimeout caps at ~24.8 days; resume re-arms when it fires early.
  const t=setTimeout(()=>{resumeTimers.delete(s.id);void resume(s);},Math.min(Math.max(0,Date.parse(due(s).at)-Date.now()),2**31-1));
  t.unref();resumeTimers.set(s.id,t);
 }
 // reason is shown in the chat; omitted when the user caused the cancel (a new message) or the wait no longer applies.
 function cancelResume(s,reason){
  clearTimeout(resumeTimers.get(s.id));resumeTimers.delete(s.id);
  if(!due(s))return;delete s.rateLimitResume;delete s.connectionResume;
  if(reason)append(s,'system',`Automatic resume cancelled: ${reason}.`);scheduleSave(s);
 }
 function resume(s){
  return lock(s.id,async()=>{
   const r=due(s);if(!r||ctx.closing)return;
   if(Date.parse(r.at)>Date.now())return armResume(s);
   if(!s.autoApprove||s.status!=='error'||s.hidden)return cancelResume(s);
   const last=[...s.messages].reverse().find(m=>m.role==='user');
   if(!last)return cancelResume(s,'no message to resend');
   if(last.hasImage)return cancelResume(s,'the last message had an image; reattach it and send it again');
   const connection=!s.rateLimitResume,attempt=Number.isInteger(r.attempt)&&r.attempt>0?r.attempt:1;
   cancelResume(s);
   append(s,'system',connection?`Resending automatically (attempt ${attempt} of ${CONNECTION_DELAYS.length}).`:'Rate limit wait is over; resuming automatically.');
   // The resend keeps the count of resends in a row (command resets it for any other message).
   if(connection)s._connectionAttempt=attempt;
   try{await command(s,{type:'prompt',message:last.text,...(connection?{resume:true}:{})});}catch(e){notice(s,'error',`Automatic resume failed: ${e.message}`);}
  });
 }
 return {rateLimitHint,connectionHint,scheduleResume,armResume,cancelResume};
}
