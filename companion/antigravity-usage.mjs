// Antigravity CLI quota: OMP's `omp usage --json` has no provider for antigravity-cli, so the companion asks Cloud Code
// Assist for the quotas Antigravity shows. The access token comes from OMP itself (`omp token antigravity-cli`), which
// owns the OAuth refresh, so no client credentials live in this repository. The endpoints and request body are the ones
// the Antigravity CLI's own language server uses (reverse-engineered from agy.exe: v1internal:retrieveUserQuotaSummary
// and v1internal:retrieveUserQuota).
const PROVIDER='antigravity-cli';
const PROJECT='default-cli-project';
const ENDPOINTS=['https://daily-cloudcode-pa.googleapis.com','https://daily-cloudcode-pa.sandbox.googleapis.com'];
const REQUEST_MS=12000;
const CACHE_MS=60000;
const OMP_MS=30000;
const HOUR=3600000,DAY=86400000,WEEK=7*DAY;
const WINDOWS={weekly:{id:'weekly',label:'Weekly',durationMs:WEEK},'5h':{id:'5h',label:'5 Hour',durationMs:5*HOUR},daily:{id:'daily',label:'Daily',durationMs:DAY}};
// The Summary endpoint lists quota groups by client version: a bare `antigravity` User-Agent only gets the Claude/GPT
// group, while 2.33.0 (the desktop app's own version; 2.0.0 is too old, anything newer answers the same) also gets
// the Gemini group, whose weekly limit is the one Antigravity shows.
const USER_AGENT='antigravity/2.33.0';
const clampFraction=v=>Number.isFinite(v)?Math.min(1,Math.max(0,v)):undefined;
const statusFor=f=>f===undefined?'unknown':f<=0?'exhausted':f<=0.1?'warning':'ok';
const percentAmount=f=>({unit:'percent',remainingFraction:f,usedFraction:1-f,remaining:f*100,used:(1-f)*100,limit:100});
const resetAt=t=>{const n=Date.parse(t);return Number.isFinite(n)?n:undefined;};
const cleanName=s=>String(s||'').replace(/\s+models?$/i,'').replace(/\s+and\s+/gi,' & ').trim();
// One row per quota window. The Summary endpoint reports every group's shared weekly and 5-hour limits.
function summaryRows(summary,covered){
 const rows=[];
 for(const group of Array.isArray(summary?.groups)?summary.groups:[]){
  if(group?.disabled===true)continue;
  const groupName=String(group?.displayName||'');
  if(/claude|gpt|3p/i.test(groupName))for(const m of ['claude','gpt','3p'])covered.add(m);
  if(/gemini/i.test(groupName))covered.add('gemini');
  const label=`${cleanName(groupName)||'Antigravity'} (shared)`;
  for(const b of Array.isArray(group?.buckets)?group.buckets:[]){
   if(b?.disabled===true)continue;
   const f=clampFraction(b?.remainingFraction);
   const win=WINDOWS[b?.window]||{id:String(b?.window||'current'),label:String(b?.displayName||'Window').replace(/\s*remaining$/i,'')};
   const at=resetAt(b?.resetTime);
   // A window that reports no remaining fraction stays visible as unknown; it must neither read as 0 % used nor vanish.
   rows.push({id:`${PROVIDER}:${groupName||'shared'}:${win.id}`,label,scope:{provider:PROVIDER,windowId:win.id,shared:true},
    window:{...win,...(at!==undefined?{resetsAt:at}:{})},...(f===undefined?{notes:['Antigravity reported no remaining quota for this window.']}:{amount:percentAmount(f)}),status:statusFor(f)});
  }
 }
 return rows;
}
// The Quota endpoint reports the current window per model. Models that share one quota become one row (the
// lowest remaining fraction), which is how Antigravity's Gemini group reads; per-model rows would drown the panel.
function modelRows(quota,covered){
 const families=new Map();
 for(const b of Array.isArray(quota?.buckets)?quota.buckets:[]){
  const id=String(b?.modelId||'');
  if(!id||/^tab[_-]/i.test(id))continue; // IDE tab-completion quota, not a chat model
  const f=clampFraction(b?.remainingFraction);if(f===undefined)continue;
  const family=/^gemini/i.test(id)?'gemini':/^claude|^gpt/i.test(id)?'3p':id.split(/[-_]/)[0].toLowerCase();
  if(covered.has(family))continue;
  const e=families.get(family)||{models:[],items:[]};
  e.models.push(id);e.items.push({f,at:resetAt(b?.resetTime)});families.set(family,e);
 }
 const rows=[];
 for(const [family,e] of families){
  const worst=e.items.reduce((a,b)=>b.f<a.f?b:a);
  const name=family==='gemini'?'Gemini models':family==='3p'?'Claude & GPT models':`${family[0]?.toUpperCase()||''}${family.slice(1)} models`;
  const label=e.models.length>1?`${name} (${e.models.length})`:name;
  rows.push({id:`${PROVIDER}:model:${family}`,label,scope:{provider:PROVIDER,windowId:'current',shared:true},
   window:{id:'current',label:'Current quota',...(worst.at!==undefined?{resetsAt:worst.at}:{})},amount:percentAmount(worst.f),status:statusFor(worst.f),
   notes:['Antigravity reported no weekly limit for these models; this is the current window only.']});
 }
 return rows;
}
// Pure mapping from the two Cloud Code Assist responses to OMP's usage-limit rows.
export function antigravityLimitRows(summary,quota){
 const covered=new Set();const rows=summaryRows(summary,covered);
 return [...rows,...modelRows(quota,covered)];
}

// `omp token antigravity-cli --list` prints one line per OAuth account: "1. user@example.com".
export function parseAntigravityAccounts(stdout){
 const accounts=[],seen=new Set();
 for(const line of String(stdout||'').split(/\r?\n/)){
  const m=line.match(/^\s*(\d+)\.\s+(.+?)\s*$/);if(!m)continue;
  const index=Number(m[1]),identity=m[2].trim();
  if(!Number.isInteger(index)||index<1||!identity||seen.has(identity))continue;
  seen.add(identity);accounts.push({index,identity});
 }
 return accounts;
}
// The token command prints the raw access token; a JSON-shaped reply is accepted too, so a future OMP stays compatible.
export function antigravityCliToken(stdout){
 const text=String(stdout||'').trim();
 if(!text)throw new Error('OMP returned no token');
 if(text.startsWith('{'))try{
  const j=JSON.parse(text),t=j.access_token||j.accessToken||j.token||j.credentials?.access_token;
  if(typeof t==='string'&&t)return t;
 }catch{}
 if(/\s/.test(text))throw new Error('OMP returned an unexpected token');
 return text;
}
const omp=async(execOmp,args)=>{const {stdout}=await execOmp(args,{timeout:OMP_MS,maxBuffer:1024*1024,windowsHide:true});return stdout;};
// OMP 19 lists the provider's OAuth accounts; before that flag one token still covers the single account it returns.
async function accountsFor(execOmp){
 if(typeof execOmp!=='function')return [];
 try{const accounts=parseAntigravityAccounts(await omp(execOmp,['token','antigravity-cli','--list']));if(accounts.length)return accounts;}catch{}
 try{return [{index:null,identity:'',token:antigravityCliToken(await omp(execOmp,['token','antigravity-cli']))}];}catch{return [];}
}
async function tokenFor(account,execOmp){
 if(account.token)return account.token;
 const args=['token','antigravity-cli',...(account.index?['--account',String(account.index)]:[])];
 return antigravityCliToken(await omp(execOmp,args));
}
function metadataFor(account){
 const identity=String(account.identity||'').trim(),mail=identity.match(/[^\s()]+@[^\s()]+/)?.[0];
 return {projectId:PROJECT,...(mail?{email:mail}:identity?{accountId:identity}:{})};
}

async function rpc(rpcPath,body,token,fetchImpl){
 let failure;
 for(const base of ENDPOINTS){
  let res;
  try{res=await fetchImpl(base+rpcPath,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','User-Agent':USER_AGENT},body:JSON.stringify(body),signal:AbortSignal.timeout(REQUEST_MS)});}
  catch(e){failure=e;continue;}
  if(res.ok)return await res.json();
  failure=new Error(`${rpcPath} returned HTTP ${res.status}`);
  // The sandbox endpoint differs from production, not from an authentication or argument refusal.
  if(res.status<500&&res.status!==429)break;
 }
 throw failure;
}

async function reportsFor(accounts,{execOmp,fetchImpl,now}){
 const reports=[];
 await Promise.all(accounts.map(async account=>{
  const metadata=metadataFor(account);
  try{
   const token=await tokenFor(account,execOmp);
   const [summary,quota]=await Promise.allSettled([
    rpc('/v1internal:retrieveUserQuotaSummary',{project:PROJECT},token,fetchImpl),
    rpc('/v1internal:retrieveUserQuota',{project:PROJECT},token,fetchImpl)]);
   if(summary.status==='rejected'&&quota.status==='rejected')throw summary.reason||quota.reason;
   const limits=antigravityLimitRows(summary.status==='fulfilled'?summary.value:undefined,quota.status==='fulfilled'?quota.value:undefined);
   if(!limits.length)throw new Error(summary.status==='rejected'?String(summary.reason?.message||summary.reason):'no quota reported');
   reports.push({provider:PROVIDER,fetchedAt:now,metadata,limits});
  }catch(e){
   reports.push({provider:PROVIDER,fetchedAt:now,metadata,limits:[],notes:[`Antigravity CLI quota unavailable: ${String(e?.message||e).slice(0,300)}`]});
  }
 }));
 return reports.sort((a,b)=>String(a.metadata.email||a.metadata.accountId||'').localeCompare(String(b.metadata.email||b.metadata.accountId||'')));
}

// One short-lived cache: the panel polls every 2 minutes and /usage can be asked in between.
let cache;
export async function antigravityCliReports(options={}){
 const now=options.now??Date.now();
 if(!options.accounts&&cache&&now-cache.at<CACHE_MS)return cache.reports;
 const accounts=options.accounts??await accountsFor(options.execOmp);
 if(!accounts.length)return [];
 const reports=await reportsFor(accounts,{execOmp:options.execOmp,fetchImpl:options.fetchImpl??fetch,now});
 if(!options.accounts)cache={at:now,reports};
 return reports;
}

// Merge the reports into `omp usage --json` before modelUsage(). Never throws: /usage keeps every other provider
// when Antigravity quota cannot be read, and an OMP version that ships its own provider is left untouched.
export async function addAntigravityCliUsage(data,options={}){
 try{
  if(!data||typeof data!=='object')return data;
  if(data.reports?.some?.(r=>r?.provider===PROVIDER)||data.accountsWithoutUsage?.some?.(a=>a?.provider===PROVIDER))return data;
  const reports=await antigravityCliReports(options);
  if(!reports.length)return data;
  data.reports=Array.isArray(data.reports)?data.reports:[];
  data.reports.push(...reports);
 }catch{}
 return data;
}
