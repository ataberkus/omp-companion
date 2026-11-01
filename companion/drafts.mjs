// Composer drafts per dashboard view ('session:<id>' or 'native:<file>'), shared by every device using this companion:
// store.drafts[key] = {text,images,at}, where images holds only each attached image's {id,name,mimeType,tokens}. The
// image data and preview live in drafts/<id>.json, so workspace.json and /api/state polls stay small. A draft of images
// alone has no text.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { error, exists, replaceFile } from './util.mjs';
import { IMAGE_EXT, draftImages } from './images.mjs';
export async function createDrafts(ctx){
 const {store,dataDir,scheduleSave}=ctx;
 // Defined by a module created after this one: called through ctx once it exists.
 const lock=(...args)=>ctx.lock(...args);
 const draftDir=path.join(dataDir,'drafts'),draftImageFile=id=>path.join(draftDir,id+'.json');
 const draftMeta=i=>typeof i?.id==='string'&&/^[0-9a-f]{64}$/.test(i.id)&&typeof i.name==='string'&&!!i.name&&Object.hasOwn(IMAGE_EXT,i.mimeType)&&Number.isInteger(i.tokens)&&i.tokens>=0;
 // A session view whose session was removed (a discarded draft session) or lost its folder (worktree deleted) has no
 // composer left: a draft for it would only hold its images on disk until 200 newer drafts pushed it out.
 const draftGone=key=>{const id=/^session:(.+)$/.exec(key)?.[1];if(id===undefined)return false;const s=store.sessions.find(x=>x.id===id);return !s||!!s.worktreeRemoved;};
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
 {const files=new Set(await fs.readdir(draftDir).catch(()=>[]));
  store.drafts=Object.fromEntries(Object.entries(store.drafts&&typeof store.drafts==='object'?store.drafts:{}).flatMap(([k,v])=>{
   if(!/^(session|native):./.test(k)||draftGone(k)||typeof v?.text!=='string'||typeof v.at!=='number')return [];
   const images=(Array.isArray(v.images)?v.images:[]).filter(i=>draftMeta(i)&&files.has(i.id+'.json')).map(({id,name,mimeType,tokens})=>({id,name,mimeType,tokens}));
   return v.text||images.length?[[k,{text:v.text,images,at:v.at}]]:[];}));
  // Image files no draft refers to (its draft was saved over or cleared before a crash) and dead companions' temp files go.
  const kept=new Set(Object.values(store.drafts).flatMap(d=>d.images.map(i=>i.id+'.json')));
  for(const f of files){const m=/^[0-9a-f]{64}\.json(?:\.(\d+)\.tmp)?$/.exec(f);if(m&&(m[1]?!alive(Number(m[1])):!kept.has(f)))await fs.rm(path.join(draftDir,f),{force:true}).catch(()=>{});}}
 // Per-process temp name, as for workspace.json: a second companion sharing this data dir never renames ours away.
 const writeImage=async(id,entry)=>{const file=draftImageFile(id),tmp=`${file}.${process.pid}.tmp`;
  try{await fs.writeFile(tmp,JSON.stringify(entry),{mode:0o600});await replaceFile(tmp,file);}catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}};
 // Draft saves and removals run one at a time per view ('draft:<key>'), so an image file is removed only once no newer
 // save of that view refers to it. Image IDs include the view, so no other view's draft shares a file.
 const sweepDraftImages=(key,ids)=>{const keep=new Set((store.drafts[key]?.images??[]).map(i=>i.id));return Promise.all(ids.filter(id=>!keep.has(id)).map(id=>fs.rm(draftImageFile(id),{force:true}).catch(()=>{})));};
 // Removes a view's draft now and its image files once earlier saves of that view are done.
 const dropDraft=key=>{const d=store.drafts[key];if(!d)return;delete store.drafts[key];scheduleSave([]);if(d.images.length)void lock('draft:'+key,()=>sweepDraftImages(key,d.images.map(i=>i.id)));};
 // A view's draft with its images' data and previews; images named in `have` (the dashboard has them) come without.
 async function readDraft(key,have){
  const d=store.drafts[key],images=[];
  for(const i of d?.images??[]){if(have.has(i.name)){images.push({name:i.name,mimeType:i.mimeType,tokens:i.tokens});continue;}try{images.push(JSON.parse(await fs.readFile(draftImageFile(i.id),'utf8')));}catch{}}
  return {text:d?.text??'',at:d?.at??null,images};
 }
 // A save from a dashboard (debounced from every device). images, when given, replaces the attached images ([] removes
 // them); without it they stay. A draft with neither text nor images is cleared. Answers with the draft's timestamp and
 // the names of the images it now holds, so a dashboard that left them out learns whether they match.
 async function saveDraft(body){
  const key=typeof body.key==='string'&&/^(session|native):./.test(body.key)&&body.key.length<=4200?body.key:null;if(!key)throw error('Invalid draft key.');
  if(typeof body.text!=='string'||body.text.length>200000)throw error('Draft must be text under 200,000 characters.');
  const images=body.images===undefined?null:draftImages(body.images,key);
  if(draftGone(key))throw error('Session not found.',404);
  const saved=await lock('draft:'+key,async()=>{
   const old=store.drafts[key];
   if(images?.length){await fs.mkdir(draftDir,{recursive:true,mode:0o700});for(const {id,entry} of images)if(!await exists(draftImageFile(id)))await writeImage(id,entry);}
   const meta=images?images.map(({id,entry})=>({id,name:entry.name,mimeType:entry.image.mimeType,tokens:entry.tokens})):old?.images??[];
   // Removed while the images were written (dropDraft has cleared its draft): store nothing, keep none of the files.
   if(draftGone(key)){await sweepDraftImages(key,meta.map(i=>i.id));throw error('Session not found.',404);}
   // Strictly later than the last save, so every change gets a timestamp the other devices see as new.
   if(body.text||meta.length)store.drafts[key]={text:body.text,images:meta,at:Math.max(Date.now(),(old?.at??0)+1)};else delete store.drafts[key];
   // Oldest drafts go first past 200, so an abandoned pile cannot grow workspace.json and drafts/ without bound.
   const keys=Object.keys(store.drafts);if(keys.length>200)for(const k of keys.sort((a,b)=>store.drafts[a].at-store.drafts[b].at).slice(0,keys.length-200))dropDraft(k);
   scheduleSave([]);
   await sweepDraftImages(key,(old?.images??[]).map(i=>i.id));
   const d=store.drafts[key];return {at:d?.at??null,images:(d?.images??[]).map(i=>i.name)};
  });
  return {key,...saved};
 }
 return {dropDraft,readDraft,saveDraft};
}
