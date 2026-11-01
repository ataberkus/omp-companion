// Session transcript and activity-log writes: appending messages (unread steers stay last), notices, the
// activity log and attention hooks.
import { randomUUID } from 'node:crypto';
import { now } from './util.mjs';
export function createMessages(ctx){
 const {options,store,scheduleSave}=ctx;
 const activity=(s,message,type='update')=>{store.activity.unshift({id:randomUUID(),projectId:s?.projectId,sessionId:s?.id,text:message,type,at:now()});store.activity=store.activity.slice(0,500);};
 // A session that needs the user (finished, failed, asked a question). The desktop host turns it into a Windows notification;
 // the dashboard derives its own notifications and title badge from /api/state.
 const attention=(s,kind,detail='')=>{if(ctx.closing||s.hidden)return;try{options.onAttention?.({id:s.id,title:s.title,kind,detail:String(detail||'').slice(0,300)});}catch(e){console.error('Attention hook failed:',e.message);}};
// Steers OMP hasn't read stay at the end of the transcript: the turn's activity keeps arriving before them, so a steer sent
// mid-thought doesn't split the live activity group, and its echo moves it to where OMP actually read it.
const unreadSteer=m=>m.role==='user'&&(m.steer==='pending'||m.steer==='received');
const place=(s,m)=>{let i=s.messages.length;while(i>0&&unreadSteer(s.messages[i-1]))i--;s.messages.splice(i,0,m);};
const append=(s,role,value,id=randomUUID())=>{if(!value)return;const existing=s.messages.find(m=>m.id===id);if(existing)existing.text=value.slice(-100000);else{const m={id,role,text:value.slice(-100000),at:now()};if(role==='user')s.messages.push(m);else place(s,m);}s.messages=s.messages.slice(-600);return s.messages.find(m=>m.id===id);};
 // OMP forgets steers it never read once the turn ends; flag them so the user can resend.
 function dropSteers(s){for(const m of s.messages)if(m.steer==='pending')m.steer='dropped';}
 // Info toasts in the dashboard; warnings and errors also stay in the chat.
 function notice(s,level,message){const text=String(message||'').trim().slice(0,2000);if(!text)return;level=['warning','error'].includes(level)?level:'info';
  s._notices=[...(s._notices||[]),{id:randomUUID(),level,text,at:now()}].slice(-20);if(level!=='info'){append(s,'system',text);scheduleSave(s,true);}if(level==='error')activity(s,`${s.title}: ${text}`,'error');}
 return {append,place,notice,activity,attention,dropSteers};
}
