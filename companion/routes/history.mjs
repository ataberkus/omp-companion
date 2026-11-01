// HTTP routes for OMP's session history: listing and previewing session files, background jobs, subagent
// transcripts, job logs and tool-result images.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { error, text, samePath } from '../util.mjs';
import { IMAGE_EXT } from '../images.mjs';
import { readSessionHead, lastContext, importMessages } from '../transcript.mjs';
export function historyRoutes(ctx){
 const {background,store,runners,subagentThoughts,toolImageDir,imageWrites,stashImages,ompBlob,sessionFileParam,ompSessionsDir,insideSessions,listNativeSessions}=ctx;
 return {
   'GET /api/omp-sessions':async({json})=>{json({dir:ompSessionsDir,sessions:await listNativeSessions()});return;},
   'GET /api/omp-sessions/preview':async({url,json})=>{const file=sessionFileParam(url.searchParams.get('file'));let head;try{head=await readSessionHead(file);}catch{throw error('Session file not found.',404);}json({...head,file,contextTokens:await lastContext(file).catch(()=>undefined),messages:await importMessages(file,150,stashImages)});return;},
   // A tool-result image by the ID its message carries (see stashImages); content-addressed, so it never changes. One pruned
   // from tool-images is still served from OMP's blob store while OMP keeps it.
   'GET /api/tool-image':async({res,url})=>{const id=url.searchParams.get('id')||'';const m=/^([0-9a-f]{64})\.(png|jpg|webp|gif)$/.exec(id);if(!m)throw error('Invalid image ID.');
    const type=Object.keys(IMAGE_EXT).find(k=>IMAGE_EXT[k]===m[2]);
    await imageWrites.get(id);let data;try{data=await fs.readFile(path.join(toolImageDir,id));}catch{data=await ompBlob(m[1],type).catch(()=>null);}
    if(!data)throw error('This image is no longer stored.',404);
    res.writeHead(200,{'Content-Type':type,'Content-Length':data.length,'Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"});res.end(data);return;},
   // Also a session's current file outside OMP's sessions folder: a collab guest's replica of the host's transcript.
   'GET /api/background':async({url,json})=>{const asked=path.resolve(text(url.searchParams.get('file'),'File',4000));const file=store.sessions.some(s=>runners.has(s.id)&&s.sessionFile&&samePath(s.sessionFile,asked)&&asked.endsWith('.jsonl'))?asked:insideSessions(asked,['.jsonl']);const owned=store.sessions.filter(s=>s.sessionFile&&samePath(s.sessionFile,file));const runner=owned.map(s=>runners.get(s.id)).find(Boolean);const live=!!runner;
    const own=owned[0];const bg=await background(file,runner?runner.startedAt:owned.length?Infinity:undefined,(own?.subagentList||[]).map(a=>({...a,thinking:subagentThoughts.get(own.id+':'+a.id)?.text||''})));json({...bg,live});return;},
   'GET /api/transcript':async({url,json})=>{
    // A transcript in OMP's sessions folder, or one a running session's subagent roster keeps elsewhere (a collab guest's
    // copy of the host's), brought up to date first.
    let file;try{file=insideSessions(url.searchParams.get('file'),['.jsonl']);}catch(e){const asked=path.resolve(text(url.searchParams.get('file'),'File',4000));
     const owner=asked.endsWith('.jsonl')&&store.sessions.find(s=>runners.has(s.id)&&s.subagentList?.some(a=>a.sessionFile&&samePath(a.sessionFile,asked)));if(!owner)throw e;
     let kept;try{kept=await runners.get(owner.id).subagentTranscript(asked);}catch(x){throw error(x.message,404);}if(!kept)throw e;file=asked;}
    let head;try{head=await readSessionHead(file);}catch{throw error('Transcript not found.',404);}let result='';try{result=(await fs.readFile(file.replace(/\.jsonl$/,'.md'),'utf8')).slice(0,20000);}catch{}
    const st=await fs.stat(file),messages=await importMessages(file,600,stashImages);
    const thought=[...subagentThoughts.values()].find(t=>t.file&&samePath(t.file,file));
    const active=thought?runners.has(thought.parentId)&&thought.active:undefined;
    if(active&&thought.streaming&&thought.text&&!messages.some(m=>m.role==='thinking'&&m.sourceTimestamp!==undefined&&m.sourceTimestamp===thought.sourceTimestamp))messages.push({id:thought.id,role:'thinking',text:thought.text,at:thought.at,sourceTimestamp:thought.sourceTimestamp});
    json({...head,file,result,active,updatedAt:new Date(Math.max(st.mtimeMs,active?new Date(thought.at).getTime():0)).toISOString(),messages});return;
   },
   'GET /api/log':async({url,json})=>{const file=insideSessions(url.searchParams.get('file'),['.log']);const fh=await fs.open(file,'r').catch(()=>{throw error('Log not found.',404);});try{const {size}=await fh.stat();const n=Math.min(size,128*1024);const buf=Buffer.alloc(n);await fh.read(buf,0,n,size-n);json({file,size,text:buf.toString('utf8')});}finally{await fh.close();}return;},
 };
}
