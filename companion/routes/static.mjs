// Dashboard files from local-dist/ (or options.staticDir): cache-busted asset URLs, ETags, gzip and the page CSP.
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { error } from '../util.mjs';
import { acceptsGzip, varyEncoding, tagMatches } from '../compress.mjs';
export function createStatic(ctx){
 const {options,token,exposeToken}=ctx;
 // The page's own host as a ws: source too: older Safari doesn't count ws: under 'self' (the Screen page's WebSocket).
 const staticFiles=new Map();const csp=host=>`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' ws://${host}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
 const digest=data=>createHash('sha1').update(data).digest('base64url').slice(0,12);
 // Scripts, styles and icons gzipped (level 9) once per content hash, off the event loop. Phones reach the companion over
 // plain HTTP, where browsers offer only gzip and deflate, and loaded app.js and app.css raw (556 KB, 160 KB gzipped) on
 // every first visit and after every update. The page stays raw: it is small and carries the per-client token. A failed
 // gzip sends the file raw. acceptsGzip: q=0 refuses gzip (compress.mjs).
 const gz=new Map();const gzOf=(hash,data)=>{let p=gz.get(hash);if(!p){p=new Promise(r=>gzip(data,{level:9},(e,z)=>r(e?null:z)));gz.set(hash,p);if(gz.size>32)gz.delete(gz.keys().next().value);}return p;};
 const readFile=async file=>{const st=await fs.stat(file);let c=staticFiles.get(file);if(c?.mtime!==st.mtimeMs||c.size!==st.size){const data=await fs.readFile(file);c={mtime:st.mtimeMs,size:st.size,data,hash:digest(data)};staticFiles.set(file,c);}return c;};
 // A vendored stylesheet (KaTeX's) names its fonts by relative url(): served with ?v=<hash> on each, so the fonts are
 // cached for good like the scripts, and with font-display:swap, so a slow link shows formulas in a fallback face
 // instead of blank. Rebuilt when the sheet or any font it names changes.
 const vendorCss=new Map(),FONT_URL=/url\(([\w./-]+\.woff2)\)/g;
 const staticFile=async file=>{
  const c=await readFile(file);
  if(path.extname(file)!=='.css'||!file.split(path.sep).includes('vendor'))return c;
  const src=c.data.toString('utf8'),refs=[...new Set([...src.matchAll(FONT_URL)].map(m=>m[1]))];
  const versions=await Promise.all(refs.map(r=>readFile(path.resolve(path.dirname(file),r)).then(x=>x.hash,()=>null)));
  const key=c.hash+':'+versions.join(),v=vendorCss.get(file);if(v?.key===key)return v;
  const at=new Map(refs.map((r,i)=>[r,versions[i]]));
  const data=Buffer.from(src.replace(FONT_URL,(m,r)=>at.get(r)?`url(${r}?v=${at.get(r)})`:m).replace(/font-display:block/g,'font-display:swap'));
  const out={key,data,hash:digest(data)};vendorCss.set(file,out);return out;};
 // Files the page names by root path get ?v=<their hash>: the stylesheet, scripts and fonts (the page's own @font-face
 // rules and their preloads), so each is cached for good and fetched again only once it changed.
 const VERSIONED=/(href="|src="|url\()\/(app\.(?:css|js)|boot\.js|fonts\/[\w.-]+\.woff2)(?=[")])/g;
 const KATEX=['vendor/katex/katex.min.css','vendor/katex/katex.min.js','vendor/katex/contrib/copy-tex.min.js'];
 const serveStatic=async({req,res,url,host})=>{
    if(req.method!=='GET')throw error('Method not allowed.',405);
    const root=path.resolve(options.staticDir||path.join(path.dirname(fileURLToPath(import.meta.url)),'../../local-dist'));
    let file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(file!==root&&!file.startsWith(root+path.sep))throw error('Invalid path.',403);
    if(url.pathname==='/')file=path.join(root,'app.html');
    let data,hash;try{({data,hash}=await staticFile(file));}catch{throw error('Dashboard files not found. Build with npm run build:local or use the prebuilt companion download.',404);}
    const ext=path.extname(file);
    if(ext==='.html'){let html=data.toString('utf8');const names=[...new Set([...html.matchAll(VERSIONED)].map(m=>m[2]))];
     const v=Object.fromEntries(await Promise.all(names.map(async n=>[n,(await staticFile(path.join(root,n)).catch(()=>null))?.hash])));
     html=html.replace(VERSIONED,(m,a,n)=>v[n]?`${a}/${n}?v=${v[n]}`:m);
     // KaTeX loads the first time a message has math (app.js); its files' versions ride along, so it is cached for good too.
     const k=await Promise.all(KATEX.map(n=>staticFile(path.join(root,n)).then(x=>x.hash,()=>'')));
     if(k.some(Boolean))html=html.replace('</head>',`<meta name="omp-katex" content="${k.join(' ')}"/>\n</head>`);
     if(exposeToken)html=html.replace('</head>',`<meta name="omp-token" content="${token}"/>\n</head>`);
     // The desktop app shows native notifications for this machine, so pages opened here skip the browser's own.
     if(options.desktop&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))html=html.replace('</head>','<meta name="omp-desktop" content="1"/>\n</head>');
     data=Buffer.from(html);hash=digest(data);}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.zip':'application/zip'};
    const headers={'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':csp(host),'Cache-Control':ext!=='.html'&&url.searchParams.get('v')===hash?'public, max-age=31536000, immutable':'no-cache',ETag:`"${hash}"`};
    // Each encoding has its own validator, so If-None-Match is compared once the encoding is chosen. Vary keeps CORS's Origin.
    let body=data;if(['.js','.css','.svg'].includes(ext)&&data.length>=1024){headers.Vary=varyEncoding(res);if(acceptsGzip(req.headers['accept-encoding'])){const z=await gzOf(hash,data);if(z&&z.length<data.length){body=z;headers['Content-Encoding']='gzip';headers.ETag=`"${hash}-gz"`;}}}
    if(tagMatches(req.headers['if-none-match'],headers.ETag)){res.writeHead(304,headers);res.end();return;}
    res.writeHead(200,headers);res.end(body);return;
   };
 return {digest,serveStatic};
}
