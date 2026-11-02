// Chat and tool-result images: size and format checks, token estimates, and the per-companion tool-image store
// (content-addressed files under the data dir, pruned to a byte cap, backed by OMP's blob store).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { error, replaceFile } from './util.mjs';
const MAX_IMAGE_BYTES=5*1024*1024;
export const IMAGE_EXT={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
// Prompt cost estimates: ~4 characters per text token; images as Anthropic bills them, (w×h)/750 after its
// 1568px / 1.15 MP downscale (the costliest common provider). The dashboard (app.js) uses the same formula.
export const textTokens=t=>Math.ceil(String(t||'').length/4);
const imageTokens=(w,h)=>{if(!(w>0&&h>0))return 1600;const k=Math.min(1,1568/Math.max(w,h),Math.sqrt(1.15e6/(w*h)));return Math.ceil(w*h*k*k/750);};
// Pixel size from the file header; null when the header can't be read (costed as the 1600-token maximum).
function imageSize({mimeType,data}){
 try{const b=Buffer.from(data,'base64');
  if(mimeType==='image/png')return [b.readUInt32BE(16),b.readUInt32BE(20)];
  if(mimeType==='image/gif')return [b.readUInt16LE(6),b.readUInt16LE(8)];
  if(mimeType==='image/webp'){const k=b.toString('ascii',12,16);
   if(k==='VP8X')return [1+b.readUIntLE(24,3),1+b.readUIntLE(27,3)];
   if(k==='VP8L'){const v=b.readUInt32LE(21);return [1+(v&0x3fff),1+((v>>>14)&0x3fff)];}
   if(k==='VP8 ')return [b.readUInt16LE(26)&0x3fff,b.readUInt16LE(28)&0x3fff];}
  if(mimeType==='image/jpeg')for(let i=2;i+9<b.length;){
   if(b[i]!==0xff||b[i+1]===0xff){i++;continue;}const m=b[i+1];
   if(m>=0xc0&&m<=0xcf&&m!==0xc4&&m!==0xc8&&m!==0xcc)return [b.readUInt16BE(i+7),b.readUInt16BE(i+5)];
   i+=m===0x01||(m>=0xd0&&m<=0xd8)?2:2+b.readUInt16BE(i+2);}
 }catch{}
 return null;
}
export const imagesTokens=images=>images.reduce((n,i)=>n+imageTokens(...(imageSize(i)||[])),0);
// Image bytes as chat attachments accept them: a header matching the PNG, JPEG, WebP or GIF type, at most 5 MB.
function imageBytesValid(mimeType,bytes){
 const valid=mimeType==='image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  :mimeType==='image/jpeg' ? bytes[0]===255&&bytes[1]===216&&bytes[2]===255
  :mimeType==='image/webp' ? bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'
  :mimeType==='image/gif'&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
 return !!bytes.length&&bytes.length<=MAX_IMAGE_BYTES&&valid;
}
// An image content part as chat attachments accept it (see imageBytesValid), sent as base64.
// Returns the decoded bytes, or the reason it was refused.
function checkImage(image){const data=image?.data;
 if(image?.type!=='image'||!Object.hasOwn(IMAGE_EXT,image.mimeType)||typeof data!=='string'||data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!data.length||data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))return {problem:'Use a PNG, JPEG, WebP or GIF image up to 5 MB.'};
 const bytes=Buffer.from(data,'base64');
 if(!imageBytesValid(image.mimeType,bytes))return {problem:'Image data does not match its file type or exceeds 5 MB.'};
 return {bytes};
}
// Images in a tool result (read of a .png/.jpg), at most 8: live results carry base64 ({mimeType,bytes} once checked);
// OMP's session files reference its blob store instead ("blob:sha256:<hex>" → {mimeType,blob}), checked when copied.
export const toolImages=content=>Array.isArray(content)?content.filter(c=>c?.type==='image').slice(0,8).map(c=>{
 const blob=Object.hasOwn(IMAGE_EXT,c.mimeType)&&typeof c.data==='string'&&/^blob:sha256:([0-9a-f]{64})$/.exec(c.data)?.[1];
 return blob?{mimeType:c.mimeType,blob}:{mimeType:c.mimeType,bytes:checkImage(c).bytes};}).filter(i=>i.blob||i.bytes):[];
export function chatImages(body){
 if(body.images===undefined)return [];
 if(!Array.isArray(body.images)||!body.images.length)throw error('Attach at least one image.');
 const images=body.images.map(image=>{const {problem}=checkImage(image);if(problem)throw error(problem);return {type:'image',mimeType:image.mimeType,data:image.data};});
 // preview: one data URL or one per image; stored on the message as-is.
 const previews=body.preview===undefined?[]:[].concat(body.preview);
 if(previews.length>images.length||previews.some(p=>!imagePreview(p)))throw error('Invalid image preview.');
 return images;
}
// A small JPEG/PNG data URL the dashboard shows for an attached image (attachImage), at most 1 MB.
const imagePreview=p=>typeof p==='string'&&p.length<=1024*1024&&/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(p);
// The dashboard's UPLOAD_MAX: base64 image data and previews one composer can hold, under the 48 MB request cap.
const DRAFT_IMAGES_MAX=45*1024*1024;
// The images attached in a composer draft, as attachImage made them: an image as chat attachments accept it (checkImage),
// its preview, a name unique in the draft and its token estimate. Each gets an ID from its view and content, so saving
// the same attachments again (say after a failed send) names the same file.
export function draftImages(list,key){
 if(!Array.isArray(list))throw error('Draft images must be a list.');
 const names=new Set();let bytes=0;
 return list.map(a=>{
  const {problem}=checkImage(a?.image);if(problem)throw error(problem);
  if(!imagePreview(a.preview))throw error('Invalid image preview.');
  if(typeof a.name!=='string'||!a.name||a.name.length>300||names.has(a.name))throw error('Each draft image needs its own name (maximum 300 characters).');
  if(!Number.isInteger(a.tokens)||a.tokens<0||a.tokens>1e6)throw error('Invalid image token estimate.');
  names.add(a.name);bytes+=a.image.data.length+a.preview.length;
  if(bytes>DRAFT_IMAGES_MAX)throw error(`Draft images must stay under ${DRAFT_IMAGES_MAX/1048576} MB together.`);
  const entry={image:{type:'image',mimeType:a.image.mimeType,data:a.image.data},preview:a.preview,name:a.name,tokens:a.tokens};
  return {id:createHash('sha256').update(key).update('\0').update(JSON.stringify(entry)).digest('hex'),entry};
 });
}
export function createToolImages(ctx){
 const {options,dataDir}=ctx;
 // Defined by modules created after this one: called through ctx once they exist.
 const agentDir=(...args)=>ctx.agentDir(...args);
 // Tool-result images (say a read of a .jpg) are files named by their content hash; messages keep only {mimeType,id}, so
 // /api/state polls and workspace.json stay small. The folder holds at most toolImageCap bytes: least recently stored go first.
 // Images from OMP's session files are copied from its blob store, which names them by the same SHA-256.
 const toolImageDir=path.join(dataDir,'tool-images'),toolImageCap=options.toolImageCap??256*1024*1024;
 const imageWrites=new Map();let pruneTimer;
 const stashImages=list=>list.map(({mimeType,bytes,blob})=>{
  const id=(blob||createHash('sha256').update(bytes).digest('hex'))+'.'+IMAGE_EXT[mimeType];
  if(!imageWrites.has(id))imageWrites.set(id,saveImage(id,mimeType,bytes,blob).catch(e=>console.error('Could not store a tool image:',e.message)).finally(()=>imageWrites.delete(id)));
  return {mimeType,id};});
 async function saveImage(id,mimeType,bytes,blob){
  const file=path.join(toolImageDir,id),t=new Date();
  try{await fs.utimes(file,t,t);return;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(blob){bytes=await ompBlob(blob,mimeType);if(!bytes)return;}
  await fs.mkdir(toolImageDir,{recursive:true,mode:0o700});
  const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,bytes,{mode:0o600});await replaceFile(tmp,file);
  clearTimeout(pruneTimer);pruneTimer=setTimeout(()=>pruneImages().catch(e=>{if(e.code!=='ENOENT')console.error('Could not prune tool images:',e.message);}),500);pruneTimer.unref?.();
 }
 // The image OMP's blob store holds under a SHA-256, if it is still there (OMP's cleanup sweeps unreferenced blobs) and valid.
 async function ompBlob(hex,mimeType){
  const source=path.join(agentDir(),'blobs',hex);
  try{if((await fs.stat(source)).size>MAX_IMAGE_BYTES)return null;const bytes=await fs.readFile(source);return imageBytesValid(mimeType,bytes)?bytes:null;}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
 }
 async function pruneImages(){
  const files=[];
  for(const name of await fs.readdir(toolImageDir)){if(imageWrites.has(name.split('.').slice(0,2).join('.')))continue;try{const st=await fs.stat(path.join(toolImageDir,name));files.push({name,size:st.size,at:st.mtimeMs});}catch{}}
  let total=files.reduce((n,f)=>n+f.size,0);files.sort((a,b)=>a.at-b.at);
  for(const f of files){if(total<=toolImageCap)break;await fs.rm(path.join(toolImageDir,f.name),{force:true}).catch(()=>{});total-=f.size;}
 }
return {toolImageDir,toolImageCap,imageWrites,stashImages,ompBlob};
}
