// Pure views of OMP runner state as the panel stores it on a session: work timers, ask/answer dialogs, advisor
// status, /btw, subagent, goal and loop summaries, model usage and todo phases.
import { now, error } from './util.mjs';
// One work interval spans steering, questions, retries and queued continuations.
export const startWork=s=>{if(!s.workStartedAt||s.workFinishedAt){s.workStartedAt=now();delete s.workFinishedAt;}};
export const finishWork=(s,at=now())=>{if(s.workStartedAt&&!s.workFinishedAt)s.workFinishedAt=at;};
// One `ask` dialog question from OMP; null when malformed, since replies must echo its ids and labels exactly.
export function askQuestion(x){
 if(typeof x?.id!=='string'||!Array.isArray(x.options)||x.options.some(o=>typeof o?.label!=='string'))return null;
 const q={id:x.id,question:String(x.question||'Question').slice(0,2000),multi:x.multi===true,options:x.options.map(o=>({label:o.label,...(o.description?{description:String(o.description).slice(0,500)}:{}),...(o.preview?{preview:String(o.preview).slice(0,4000)}:{})}))};
 if(x.header)q.header=String(x.header).slice(0,60);
 if(Number.isInteger(x.recommended)&&x.recommended>=0&&x.recommended<q.options.length)q.recommended=x.recommended;
 return q;
}
// Mirrors OMP's ask validation, so a bad reply is a 400 here instead of a failed tool call; every question needs an answer.
export function askAnswers(q,answers){
 if(!Array.isArray(answers)||answers.length!==q.questions.length)throw error('Answer every question.');
 return q.questions.map((x,i)=>{
  const a=answers[i],name=x.question.length>80?x.question.slice(0,80)+'…':x.question;
  if(a?.id!==x.id)throw error('These answers belong to a different question.');
  const picked=Array.isArray(a.selectedOptions)?a.selectedOptions:[],labels=x.options.map(o=>o.label);
  if(picked.some(l=>!labels.includes(l))||new Set(picked).size!==picked.length)throw error(`Choose listed options for “${name}”.`);
  if(a.customInput!==undefined&&(typeof a.customInput!=='string'||a.customInput.length>20000))throw error('Answer must be text under 20,000 characters.');
  const custom=a.customInput?.trim()||'';
  if(!picked.length&&!custom)throw error(`Answer “${name}”.`);
  if(!x.multi&&(picked.length>1||(picked.length&&custom)))throw error(`“${name}” takes a single answer.`);
  return {id:x.id,selectedOptions:picked,...(custom?{customInput:custom}:{})};
 });
}
export function parseAdvisorStatus(text){
 const t=String(text||'').trim();const num=v=>v===undefined?undefined:Number(String(v).replace(/[^\d]/g,''))||0;
 if(/^Advisor (is )?disabled\./.test(t))return {enabled:false};
 if(/^Advisor enabled\.$/.test(t))return {enabled:true};
 if(/no model is assigned to the 'advisor' role/.test(t))return {enabled:true,noModel:true};
 let m=t.match(/^Advisor is enabled \(([^)]+)\)\.(?: Context: ([\d.,\s\u00a0]+) \/ ([\d.,\s\u00a0]+) tokens)?[\s\S]*?\$(\d+(?:\.\d+)?)/);
 if(m)return {enabled:true,model:m[1],contextTokens:num(m[2]),contextWindow:num(m[3]),cost:Number(m[4])||0};
 // OMP prints this only when no advisor runtime is live; after '/advisor off' it can still read "running", so it says nothing about on/off.
 if((m=t.match(/^Advisor "([^"]+)" is ([^.]+)\./)))return {name:m[1],state:m[2]};
 if((m=t.match(/^Advisors enabled \((\d+)\):/))){const models=[...t.matchAll(/\u2022 [^(\[\n]+\(([^)]+)\)/g)].map(x=>x[1]);const c=t.match(/\$([\d.]+)\.\s*$/);return {enabled:true,count:Number(m[1]),model:models.join(', '),cost:c?Number(c[1]):undefined};}
 return null;
}
// One /btw topic as the dashboard shows it: the first question plus follow-ups, each with its (possibly streaming) answer.
const btwTurnView=t=>({question:String(t?.question||'').slice(0,20000),answer:String(t?.answer||'').slice(-100000),status:['running','complete','cancelled','error','interrupted'].includes(t?.status)?t.status:'error',...(t?.error?{error:String(t.error).slice(0,2000)}:{}),createdAt:Number(t?.createdAt)||0});
export const btwView=r=>({id:String(r.id),...btwTurnView(r),followUps:(Array.isArray(r.followUps)?r.followUps:[]).slice(-50).map(btwTurnView)});
// Keep only what the dashboard shows from OMP's subagent registry entries.
export const subagentView=e=>{const p=e?.progress||{};const pick=o=>Object.fromEntries(Object.entries(o||{}).filter(([,v])=>['string','number','boolean'].includes(typeof v)).map(([k,v])=>[k,typeof v==='string'?v.slice(0,300):v]));
 return {id:String(e?.id||p.id||''),agent:String(e?.agent||''),description:String(e?.description||p.description||'').slice(0,300),status:String(e?.status||p.status||''),sessionFile:e?.sessionFile||'',...(e?.remote===true?{remote:true}:{}),parentToolCallId:e?.parentToolCallId||'',lastUpdate:e?.lastUpdate||Date.now(),progress:pick(p)};};
export const goalView=g=>g?{objective:String(g.objective||'').slice(0,500),status:String(g.status||''),tokensUsed:g.tokensUsed,tokenBudget:g.tokenBudget}:undefined;
// /loop's state (loop-host.mjs): running (repeating its prompt), waiting (for the next prompt) or paused (by Stop).
export const loopView=v=>v&&['running','waiting','paused'].includes(v.state)?{state:v.state,description:String(v.description||'').slice(0,300),...(typeof v.prompt==='string'?{prompt:v.prompt.slice(0,2000)}:{})}:undefined;

// Single parser for `omp usage --json`: the /usage chat snapshot and the live usage panel both render from this.
// Result is grouped by provider, the session's provider first, then the others in OMP's order.
export function modelUsage(data,provider,model){
 if(!Array.isArray(data?.reports))throw new Error('OMP returned an invalid usage report.');
 const clean=v=>String(v??'').replace(/[\r\n\t`]/g,' ');
 const number=v=>Number.isFinite(v)?v:undefined;
 const amount=v=>v.toLocaleString('en-US',{maximumFractionDigits:2});
 const identity=(meta,fallback)=>[meta?.email||meta?.accountId||meta?.projectId||fallback,meta?.orgName||meta?.orgId,meta?.planType].filter(Boolean).map(clean).join(' · ');
 const without=Array.isArray(data.accountsWithoutUsage)?data.accountsWithoutUsage:[];
 const group=name=>{
 const accounts=data.reports.filter(r=>r.provider===name).map((r,i)=>{
  // One malformed report must not take the other providers' limits down with it.
  if(!Array.isArray(r.limits))return {name:identity(r.metadata,`Account ${i+1}`),notes:[],limits:[],unavailable:'invalid usage limits reported'};
  const limits=r.limits.map(limit=>{
   const a=limit.amount||{},used=number(a.used),cap=number(a.limit),left=number(a.remaining),leftFraction=number(a.remainingFraction);
   let fraction=number(a.usedFraction);
   if(fraction===undefined&&used!==undefined)fraction=cap>0?used/cap:a.unit==='percent'?used/100:undefined;
   if(fraction===undefined&&leftFraction!==undefined)fraction=1-leftFraction;
   if(fraction===undefined&&a.unit==='percent'&&left!==undefined)fraction=1-left/100;
   const remaining=left??(used!==undefined&&cap!==undefined?Math.max(0,cap-used):undefined);
   const values=[];
   if(remaining!==undefined&&a.unit!=='percent')values.push(`${amount(remaining)} ${clean(a.unit==='unknown'?'':a.unit)} remaining`.replace(/ +/g,' '));
   if(fraction!==undefined)values.push(`${(Math.max(0,1-fraction)*100).toFixed(1)}% remaining · ${(fraction*100).toFixed(1)}% used`);
   if(!values.length)values.push('Remaining quota unavailable');
   if(used!==undefined&&a.unit!=='percent')values.push(`${amount(used)}${cap!==undefined?' / '+amount(cap):''} ${clean(a.unit==='unknown'?'':a.unit)} used`);
   const scope=limit.scope||{},window=limit.window;
   const resets=Number.isFinite(window?.resetsAt)&&Number.isFinite(new Date(window.resetsAt).getTime());
   return {label:clean(limit.label||limit.id),detail:[window?.label,scope.modelId&&'model: '+scope.modelId,scope.tier&&'tier: '+scope.tier].filter(Boolean).map(clean).join(' · '),
    fraction,summary:values.join(' · '),resetsAt:resets?window.resetsAt:undefined,resetLabel:resets?clean(window.resetLabel||'Resets'):undefined,notes:(limit.notes||[]).map(clean)};
  });
  return {name:identity(r.metadata,`Account ${i+1}`),fetchedAt:Number.isFinite(new Date(r.fetchedAt).getTime())?new Date(r.fetchedAt).toISOString():undefined,notes:(r.notes||[]).map(clean),limits,unavailable:limits.length?undefined:'no limits reported'};
 });
 for(const a of without)if(a.provider===name)accounts.push({name:identity(a,'Account'),notes:[],limits:[],unavailable:'no usage data'});
 return {provider:clean(name),accounts,unavailable:accounts.length?undefined:`${clean(name)} did not report usage limits`};
 };
 const providers=[...new Set([provider,...data.reports.map(r=>r.provider),...without.map(a=>a.provider)].filter(p=>p&&typeof p==='string'))].map(group);
 return {provider:clean(provider),model:clean(model),providers};
}
export function modelUsageText(u){
 const lines=[`Usage: ${u.provider}/${u.model}`,'All logged-in providers, the selected model\'s first; limits may be shared across models.'];
 for(const p of u.providers){
  lines.push('',`== ${p.provider} ==`);
  if(p.unavailable)lines.push(`Remaining quota unavailable: ${p.unavailable}.`);
  for(const a of p.accounts){
   lines.push('',a.name);
   if(a.fetchedAt)lines.push(`Fetched: ${a.fetchedAt}`);
   lines.push(...a.notes);
   if(a.unavailable)lines.push(`  Remaining quota unavailable: ${a.unavailable}.`);
   for(const l of a.limits){
    lines.push(`  ${l.label}${l.detail?' · '+l.detail:''}`,`    ${l.summary}`);
    if(l.resetsAt!==undefined)lines.push(`    ${l.resetLabel}: ${new Date(l.resetsAt).toISOString()}`);
    for(const note of l.notes)lines.push('    '+note);
   }
  }
 }
 return ['```text',...lines,'```'].join('\n');
}
const TODO_STATUS=['pending','in_progress','completed','abandoned','blocked'];
export function todoPhases(v){
 if(!Array.isArray(v)||v.length>30)throw error('Todos must be a list of up to 30 phases.');
 const str=(x,n,name,req)=>{if(x===undefined&&!req)return undefined;if(typeof x!=='string'||(req&&!x.trim())||x.length>n)throw error(`Invalid todo ${name}.`);return x;};
 return v.map(p=>{if(!p||typeof p!=='object'||!Array.isArray(p.tasks)||p.tasks.length>200)throw error('Invalid todo phase.');
  return {name:str(p.name,200,'phase name',true),tasks:p.tasks.map(t=>{if(!t||!TODO_STATUS.includes(t.status))throw error('Invalid todo status.');const o={content:str(t.content,2000,'task',true),status:t.status};
   for(const k of ['blocker','details'])if(t[k]!==undefined)o[k]=str(t[k],4000,k);if(t.notes!==undefined){if(!Array.isArray(t.notes)||t.notes.length>50)throw error('Invalid todo notes.');o.notes=t.notes.map(x=>str(x,2000,'note',false));}return o;})};});
}
