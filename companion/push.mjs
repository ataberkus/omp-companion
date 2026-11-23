// Apple push for OMP Control (ios/): "needs input" and "plan ready for review" reach the phone even while the app is not
// running. Token-based APNs (a key from developer.apple.com → Keys) over HTTP/2. Off, silently, until configured:
//   APNS_KEY_ID, APNS_TEAM_ID, and APNS_KEY_FILE (path to the .p8) or APNS_KEY (its PEM text, "\n" allowed);
//   APNS_TOPIC defaults to the app's bundle ID, dev.omp.companion.
// The phone registers its device token with each companion it has paired (POST /api/push/register); they are kept in
// dataDir/push-devices.json, at most MAX_DEVICES, and dropped once Apple reports them gone.
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { connect, constants } from 'node:http2';
import { sign } from 'node:crypto';
import { now, error, replaceFile } from './util.mjs';
const MAX_DEVICES=20;
const HOSTS={production:'https://api.push.apple.com',development:'https://api.sandbox.push.apple.com'};
// The iOS app's own wording for a Face ID–locked phone (NotificationManager.scheduleLocalNotification).
const COPY={question:{redacted:'A session needs input',title:t=>`${t} needs input`},plan:{redacted:'A plan is ready for review',title:t=>`Plan review: ${t}`}};
function loadConfig(env=process.env){
 const keyId=env.APNS_KEY_ID?.trim(),teamId=env.APNS_TEAM_ID?.trim(),file=env.APNS_KEY_FILE?.trim();
 let pem=env.APNS_KEY?.replace(/\\n/g,'\n').trim();
 if(!pem&&file){try{pem=readFileSync(file,'utf8').trim();}catch(e){console.error('[apns] APNS_KEY_FILE unreadable:',e.message);}}
 if(!keyId||!teamId||!pem)return null;
 return {keyId,teamId,pem,topic:env.APNS_TOPIC?.trim()||'dev.omp.companion'};
}
// The device token is gone for good: delete it rather than retry.
export const deadToken=r=>r.status===410||(r.status===400&&(r.reason==='BadDeviceToken'||r.reason==='DeviceTokenNotForTopic'));
export async function createPush(ctx){
 const {dataDir}=ctx,file=path.join(dataDir,'push-devices.json');
 const config=loadConfig();
 const devices=new Map();
 try{for(const d of JSON.parse(await fs.readFile(file,'utf8')).devices||[])if(/^[0-9a-f]{64,200}$/.test(d?.token)&&HOSTS[d.environment]&&typeof d.hostRef==='string')devices.set(d.token,d);}catch{}
 // Writes queue behind each other, so the file always holds the newest registry.
 let saving=Promise.resolve();
 const save=()=>saving=saving.then(async()=>{const tmp=`${file}.${process.pid}.tmp`;try{await fs.writeFile(tmp,JSON.stringify({devices:[...devices.values()]}),{mode:0o600});await replaceFile(tmp,file);}catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});console.error('[apns] Could not save push devices:',e.message);}});
 // Apple wants the provider token refreshed at most every 20 minutes and accepts it for an hour.
 let jwt=null;
 const providerToken=()=>{
  if(jwt&&Date.now()-jwt.at<40*60_000)return jwt.value;
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned=`${b64({alg:'ES256',kid:config.keyId})}.${b64({iss:config.teamId,iat:Math.floor(Date.now()/1000)})}`;
  const value=`${unsigned}.${sign('sha256',Buffer.from(unsigned),{key:config.pem,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
  jwt={value,at:Date.now()};return value;
 };
 // One HTTP/2 connection per environment, as Apple asks; closed after 5 idle minutes, reopened on demand.
 const sessions=new Map();
 const session=env=>{
  const open=sessions.get(env);if(open&&!open.closed&&!open.destroyed)return open;
  const s=connect(HOSTS[env]),drop=()=>{if(sessions.get(env)===s)sessions.delete(env);};
  s.on('error',e=>{console.error('[apns]',env,e.message);drop();});s.on('close',drop);s.on('goaway',drop);
  s.setTimeout(5*60_000,()=>s.close());s.unref();sessions.set(env,s);return s;
 };
 const send=(env,token,payload,collapseId)=>new Promise((resolve,reject)=>{
  const req=session(env).request({':method':'POST',':path':`/3/device/${token}`,authorization:`bearer ${providerToken()}`,'apns-topic':config.topic,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(Math.floor(Date.now()/1000)+86_400),'apns-collapse-id':collapseId.slice(0,64),'content-type':'application/json'});
  let status=0,text='';req.setEncoding('utf8');
  req.on('response',h=>{status=Number(h[':status']);});req.on('data',c=>{text+=c;});
  req.on('end',()=>{let reason=null;try{reason=text?JSON.parse(text).reason??null:null;}catch{reason=text.slice(0,100)||null;}
   // An expired or refused provider token: make a new one next time.
   if(status===403)jwt=null;resolve({status,reason});});
  req.on('error',reject);
  req.setTimeout(5000,()=>{req.close(constants.NGHTTP2_CANCEL);reject(new Error('APNs timeout'));});
  req.end(JSON.stringify(payload));
 });
 // POST /api/push/register: {token, environment, hostRef, redact, name} adds or refreshes this phone; {token, remove:true} drops it.
 // hostRef is the phone's own id for this companion, echoed back as hostID so a tap opens the session on the right host.
 async function register(body){
  const token=typeof body.token==='string'?body.token.trim().toLowerCase():'';
  if(!/^[0-9a-f]{64,200}$/.test(token))throw error('token must be the hex APNs device token.');
  if(body.remove===true){if(devices.delete(token))await save();return {ok:true,configured:!!config};}
  if(!HOSTS[body.environment])throw error('environment must be development or production.');
  if(typeof body.hostRef!=='string'||!body.hostRef.trim()||body.hostRef.length>100)throw error('hostRef is required (maximum 100 characters).');
  if(body.name!=null&&(typeof body.name!=='string'||body.name.length>100))throw error('name must be text (maximum 100 characters).');
  devices.delete(token);devices.set(token,{token,environment:body.environment,hostRef:body.hostRef.trim(),redact:body.redact===true,...(body.name?.trim()?{name:body.name.trim()}:{}),at:now()});
  // The least recently registered phones go first (Map order: re-registering moves a phone to the end).
  for(const t of devices.keys()){if(devices.size<=MAX_DEVICES)break;devices.delete(t);}
  await save();return {ok:true,configured:!!config};
 }
 // An attention event worth waking the phone for: kind 'question' (a session asks) or 'plan' (a plan awaits review).
 // Never throws into the caller; failures are logged.
 function notify({sessionId,title,kind,detail}){
  if(!config||!devices.size||!COPY[kind])return;
  void (async()=>{
   let changed=false;
   await Promise.all([...devices.values()].map(async d=>{
    const copy=COPY[kind];
    const alert=d.redact?{title:copy.redacted,body:'Unlock OMP Control to view.'}:{title:copy.title(title||'Session'),body:String(detail||'').slice(0,300)||(kind==='plan'?'Plan ready for review':'Waiting for your answer')};
    const payload={aps:{alert,sound:'default','thread-id':sessionId},sessionID:sessionId,hostID:d.hostRef,kind};
    try{
     // The same identifier as the app's local notification for this event (omp-<session>-<kind>), so the two replace each other.
     const r=await send(d.environment,d.token,payload,`omp-${sessionId}-${kind}`);
     if(deadToken(r)){if(devices.get(d.token)===d){devices.delete(d.token);changed=true;}}
     else if(r.status!==200)console.error('[apns]',r.status,r.reason||'');
    }catch(e){console.error('[apns]',e.message);}
   }));
   if(changed)await save();
  })().catch(e=>console.error('[apns]',e.message));
 }
 return {push:{configured:!!config,register,notify}};
}
