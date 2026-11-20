// Video chat attachments: uploaded on their own (raw bytes, not JSON, so they can be far larger than the 48 MB message
// cap) before the message is sent, and stored by content like PDFs (<dataDir>/attachments/<sha256>.<ext>). A video never
// reaches the model as a content part: the composer adds a line naming its stored path ("Attached video: …"), and the
// agent handles the file with its own tools (ffmpeg, copying it into the repo).
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { error, exists, replaceFile } from './util.mjs';
import { attachmentDir, pdfName } from './pdfs.mjs';
export const MAX_VIDEO_BYTES=1024*1024*1024;
export const VIDEO_FILE=/^[0-9a-f]{64}\.(mp4|mov|webm|mkv|avi)$/;
const mb=n=>n>=1048576?(n/1048576).toFixed(n>=10485760?0:1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
// The container from the file's first bytes: ISO media (MP4, M4V, 3GP; QuickTime's ftyp/moov/mdat/wide/free first
// box), Matroska/WebM's EBML header, AVI's RIFF. A file renamed .mp4 that is none of them is refused.
export function videoExt(head){
 const box=head.toString('latin1',4,8),brand=head.toString('latin1',8,12);
 if(box==='ftyp')return brand==='qt  '?'mov':'mp4';
 if(['moov','mdat','wide','free','skip','pnot'].includes(box))return 'mov';
 if(head[0]===0x1a&&head[1]===0x45&&head[2]===0xdf&&head[3]===0xa3)return /webm/.test(head.toString('latin1',0,64))?'webm':'mkv';
 if(head.toString('latin1',0,4)==='RIFF'&&head.toString('latin1',8,12)==='AVI ')return 'avi';
 return null;
}
// Streams one upload to disk, hashing as it goes, then names it by content (the same video sent twice is stored once).
// Answers {id, name, bytes, path, ref}: ref is the line the composer adds for it. `name` is the file's own name as shown to the agent.
export async function storeVideo(dataDir,req,rawName){
 const name=pdfName(rawName).slice(0,300);
 if(!name)throw error('The video needs a name.');
 const declared=Number(req.headers['content-length']);
 if(declared>MAX_VIDEO_BYTES)throw error(`${name} is ${mb(declared)}; the limit is ${MAX_VIDEO_BYTES/1073741824} GB.`,413);
 const dir=attachmentDir(dataDir);await fs.mkdir(dir,{recursive:true,mode:0o700});
 const tmp=path.join(dir,`upload-${randomUUID()}.tmp`),out=createWriteStream(tmp,{mode:0o600}),hash=createHash('sha256');
 let size=0,head=Buffer.alloc(0);
 try{
  for await(const chunk of req){
   size+=chunk.length;
   if(size>MAX_VIDEO_BYTES)throw error(`${name} is over the ${MAX_VIDEO_BYTES/1073741824} GB limit.`,413);
   if(head.length<64)head=Buffer.concat([head,chunk.subarray(0,64-head.length)]);
   hash.update(chunk);
   if(!out.write(chunk))await new Promise((ok,fail)=>{out.once('drain',ok);out.once('error',fail);});
  }
  await new Promise((ok,fail)=>{out.end(ok);out.once('error',fail);});
  if(!size)throw error(`${name} is empty.`);
  const ext=videoExt(head);
  if(!ext)throw error(`${name} is not a video this companion recognizes (MP4, MOV, WebM, MKV or AVI).`,415);
  const id=hash.digest('hex'),file=path.join(dir,`${id}.${ext}`);
  if(await exists(file))await fs.rm(tmp,{force:true});else await replaceFile(tmp,file);
  const v={id,name,bytes:size,path:file};
  return {...v,ref:videoRef(v)};
 }catch(e){out.destroy();await fs.rm(tmp,{force:true}).catch(()=>{});throw e.status?e:error(`Could not store ${name}: ${e.message}`,500);}
}
// The line that hands a stored video to the agent; the composer adds it to the draft once the upload is done.
export const videoRef=v=>`Attached video: ${v.name} (${mb(v.bytes||0)}) — ${v.path}`;
