// PDF chat attachments: format and size checks, page count and title from the file itself, token estimates, the
// content-addressed store under <dataDir>/attachments, and the reference lines that hand each stored file to the agent.
// A PDF never reaches the model as a content part: the prompt names its stored path ("Attached PDF: …"), and OMP's read
// tool extracts its text when the agent opens it. Those lines are the message's record of its PDFs: the transcript
// shows them as chips (splitPdfRefs) wherever the message comes from (sent here, echoed by OMP, imported from a file).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { error, exists, replaceFile } from './util.mjs';
export const MAX_PDF_BYTES=20*1024*1024;
const MAX_PDFS=20;
// The dashboard's UPLOAD_MAX: base64 data one composer can hold, images and PDFs together, under the 48 MB request cap.
export const DRAFT_ATTACH_MAX=45*1024*1024;
// Prompt cost estimate (the dashboard's pdfTokens is the same): 1,500 tokens a page, or a quarter of the ~4 bytes a token
// when the page count can't be read; never more than the context left, since the agent reads a long file in parts.
export const pdfTokens=(p,left)=>{const t=p.pages>0?p.pages*1500:Math.ceil((p.bytes||0)/16);return left==null?t:Math.min(t,left);};
const mb=n=>n>=1048576?(n/1048576).toFixed(n>=10485760?0:1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
// A file name as the dashboard shows it and the prompt quotes it: one line, no path separators.
export const pdfName=n=>typeof n==='string'?n.replace(/[\\/\u0000-\u001f\u007f]+/g,'_').trim():'';
// Latin-1 text of a byte range, for short windows only: the whole file is never turned into a string.
const latin=(b,from,to)=>b.toString('latin1',Math.max(0,from),Math.min(b.length,to));
// A PDF string object's bytes as text: UTF-16BE or UTF-8 with their byte-order marks, otherwise PDFDocEncoding (≈ Latin-1).
function pdfString(raw){
 const b=Buffer.from(raw,'latin1');
 const s=b[0]===0xfe&&b[1]===0xff?new TextDecoder('utf-16be').decode(b.subarray(2)):b[0]===0xef&&b[1]===0xbb&&b[2]===0xbf?b.subarray(3).toString('utf8'):raw;
 return s.replace(/[\u0000-\u001f\u007f]+/g,' ').trim().slice(0,200);
}
// The literal "(…)" or hex "<…>" string starting at s[i].
function readString(s,i){
 if(s[i]==='<'){const e=s.indexOf('>',i);if(e<0)return null;const hex=s.slice(i+1,e).replace(/[^0-9A-Fa-f]/g,'');return Buffer.from(hex+(hex.length%2?'0':''),'hex').toString('latin1');}
 let out='',depth=0;
 for(let j=i+1;j<s.length;j++){const c=s[j];
  if(c==='\\'){const n=s[++j];const o=/^[0-7]{1,3}/.exec(s.slice(j,j+3));
   if(o){out+=String.fromCharCode(parseInt(o[0],8)&255);j+=o[0].length-1;}else out+={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'}[n]??(n==='\r'||n==='\n'?'':n);continue;}
  if(c==='(')depth++;else if(c===')'){if(!depth)return out;depth--;}
  out+=c;}
 return null;
}
// Page count and title, read without a PDF library: the largest /Count of a /Type /Pages node (the page tree's root),
// and /Title of the trailer's /Info dictionary. Either is null when the file keeps it in a compressed object stream or
// is encrypted; the file is still attached, only its chip says less.
export function pdfInfo(b){
 let pages=null;
 for(let i=b.indexOf('/Type');i>=0;i=b.indexOf('/Type',i+5)){
  if(!/^\/Type\s*\/Pages(?![A-Za-z])/.test(latin(b,i,i+32)))continue;
  const from=Math.max(b.lastIndexOf('obj',i),i-4096),end=b.indexOf('endobj',i),to=end<0||end>i+4096?i+4096:end;
  const m=/\/Count\s+(\d+)/.exec(latin(b,from,to));if(m)pages=Math.max(pages??0,Number(m[1]));
 }
 let title=null;
 const info=b.lastIndexOf('/Info');
 if(info>=0&&b.lastIndexOf('/Encrypt')<0){
  const r=/^\/Info\s+(\d+)\s+(\d+)\s+R/.exec(latin(b,info,info+40));
  if(r){
   let at=-1;const head=`${r[1]} ${r[2]} obj`;
   for(let i=b.indexOf(head);i>=0;i=b.indexOf(head,i+1))if(i===0||!/[0-9]/.test(latin(b,i-1,i)))at=i;
   if(at>=0){const w=latin(b,at,at+4096),t=/\/Title\s*([(<])/.exec(w.slice(0,Math.max(0,w.indexOf('endobj'))||w.length));if(t){const raw=readString(w,t.index+t[0].length-1);if(raw!==null)title=pdfString(raw)||null;}}
  }
 }
 return {pages:pages>0&&pages<1e6?pages:null,title};
}
// One PDF as the dashboard sends it ({data: base64, name}): at most 20 MB, starting with %PDF-. Encrypted or damaged
// files pass (reading them is the agent's job); anything else renamed .pdf does not. Returns the decoded bytes, or why not.
export function checkPdf(p){
 const name=pdfName(p?.name),data=p?.data;
 if(!name||name.length>300)return {problem:'Each PDF needs a name (maximum 300 characters).'};
 if(typeof data!=='string'||!data.length||data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))return {problem:`${name} is not a valid PDF.`};
 const size=data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);
 if(size>MAX_PDF_BYTES)return {problem:`${name} is ${mb(size)}; the limit is ${MAX_PDF_BYTES/1048576} MB.`};
 const bytes=Buffer.from(data,'base64');
 if(bytes.toString('latin1',0,5)!=='%PDF-')return {problem:`${name} is not a valid PDF.`};
 return {name,bytes};
}
// body.pdfs of a chat request: [{data, name}]. Each comes back with its bytes, page count and title.
export function chatPdfs(body){
 if(body.pdfs===undefined)return [];
 if(!Array.isArray(body.pdfs)||!body.pdfs.length||body.pdfs.length>MAX_PDFS)throw error(`Attach between 1 and ${MAX_PDFS} PDFs.`);
 return body.pdfs.map(p=>{const {problem,name,bytes}=checkPdf(p);if(problem)throw error(problem);return {name,bytes,...pdfInfo(bytes)};});
}
// The PDFs attached in a composer draft, as attachPdf made them: {pdf:{type:'pdf',mimeType,data}, name, tokens}. The page
// count, size and title are read here again. `used` is what the draft's images already take of DRAFT_ATTACH_MAX. Each
// gets an ID from its view and content, so saving the same attachments again names the same file.
export function draftPdfs(list,key,used=0,names=new Set()){
 if(!Array.isArray(list))throw error('Draft PDFs must be a list.');
 let total=used;
 return list.map(a=>{
  if(a?.pdf?.type!=='pdf'||a.pdf.mimeType!=='application/pdf')throw error('Invalid draft PDF.');
  const {problem,bytes}=checkPdf({data:a.pdf.data,name:a.name});if(problem)throw error(problem);
  if(a.name!==pdfName(a.name)||names.has(a.name))throw error('Each draft attachment needs its own name (maximum 300 characters).');
  if(!Number.isInteger(a.tokens)||a.tokens<0||a.tokens>1e7)throw error('Invalid PDF token estimate.');
  names.add(a.name);total+=a.pdf.data.length;
  if(total>DRAFT_ATTACH_MAX)throw error(`Draft attachments must stay under ${DRAFT_ATTACH_MAX/1048576} MB together.`);
  const {pages,title}=pdfInfo(bytes);
  const entry={pdf:{type:'pdf',mimeType:'application/pdf',data:a.pdf.data},name:a.name,tokens:a.tokens,pages,bytes:bytes.length,title};
  return {id:createHash('sha256').update(key).update('\0').update(JSON.stringify(entry)).digest('hex'),entry};
 });
}
// Sent PDFs live in <dataDir>/attachments/<sha256>.pdf, named by content (the same file sent twice is stored once) and
// kept until cleared from Tools › Disk space. Returns what a message keeps of each: {id, name, pages, bytes, title, path}.
export const attachmentDir=dataDir=>path.join(dataDir,'attachments');
export async function storePdfs(dataDir,list){
 const dir=attachmentDir(dataDir),out=[];
 if(list.length)await fs.mkdir(dir,{recursive:true,mode:0o700});
 for(const p of list){
  const id=createHash('sha256').update(p.bytes).digest('hex'),file=path.join(dir,id+'.pdf');
  if(!await exists(file)){const tmp=`${file}.${process.pid}.tmp`;
   try{await fs.writeFile(tmp,p.bytes,{mode:0o600});await replaceFile(tmp,file);}
   catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw error(`Could not store ${p.name}: ${e.message}`,500);}}
  out.push({id,name:p.name,pages:p.pages,bytes:p.bytes.length,...(p.title?{title:p.title}:{}),path:file});
 }
 return out;
}
// The line that hands a stored PDF to the agent, and its inverse. The page count, or the size when it is unknown, keeps
// the token estimate (pdfTokens) available to anything that reads the message back.
const REF=/^Attached PDF: (.+) \((?:(\d+) pages?|(\d+(?:\.\d+)?) (KB|MB))\) — (.*[\\/]([0-9a-f]{64})\.pdf)$/;
export const pdfRef=p=>`Attached PDF: ${p.name} (${p.pages>0?`${p.pages} ${p.pages===1?'page':'pages'}`:mb(p.bytes||0)}) — ${p.path}`;
export const withPdfRefs=(text,pdfs)=>pdfs?.length?[String(text||'').trimEnd(),pdfs.map(pdfRef).join('\n')].filter(Boolean).join('\n\n'):String(text||'');
// A message's own text and the PDFs its trailing "Attached PDF:" lines name.
export function splitPdfRefs(value){
 const lines=String(value??'').split('\n'),pdfs=[];let i=lines.length;
 while(i>0){const l=lines[i-1].replace(/\r$/,'');if(!l.trim()&&pdfs.length){i--;continue;}const m=REF.exec(l);if(!m)break;
  pdfs.unshift({id:m[6],name:m[1],pages:m[2]?Number(m[2]):null,bytes:m[3]?Math.round(Number(m[3])*(m[4]==='MB'?1048576:1024)):undefined,path:m[5]});i--;}
 return pdfs.length?{text:lines.slice(0,i).join('\n').trimEnd(),pdfs}:{text:String(value??''),pdfs};
}
// A user message's shown text: its own, else what it carried.
export const attachedText=(text,hasImage,pdfs)=>text||(hasImage?'Image attached':pdfs?.length?'PDF attached':'');
