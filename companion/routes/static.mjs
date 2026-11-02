// Dashboard files from local-dist/ (or options.staticDir): cache-busted asset URLs, ETags, gzip and the page CSP.
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { error } from '../util.mjs';
export function createStatic(ctx){
 const {options,token,exposeToken}=ctx;
 // The page's own host as a ws: source too: older Safari doesn't count ws: under 'self' (the Screen page's WebSocket).
 const staticFiles=new Map();const csp=host=>`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' ws://${host}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
 const digest=data=>createHash('sha1').update(data).digest('base64url').slice(0,12);
 // Scripts, styles and icons gzipped (level 9) once per content hash, off the event loop. Phones reach the companion over
 // plain HTTP, where browsers offer only gzip and deflate, and loaded app.js and app.css raw (556 KB, 160 KB gzipped) on
 // every first visit and after every update. The page stays raw: it is small and carries the per-client token. A failed
 // gzip sends the file raw.
 // q=0 refuses a coding (RFC 9110 12.4.2): "gzip;q=0, identity" gets the file raw.
 const acceptsGzip=h=>String(h||'').split(',').some(p=>{const [c,...ps]=p.split(';').map(x=>x.trim().toLowerCase());return (c==='gzip'||c==='x-gzip')&&!ps.some(x=>/^q=0(?:\.0*)?$/.test(x));});
 const gz=new Map();const gzOf=(hash,data)=>{let p=gz.get(hash);if(!p){p=new Promise(r=>gzip(data,{level:9},(e,z)=>r(e?null:z)));gz.set(hash,p);if(gz.size>32)gz.delete(gz.keys().next().value);}return p;};
 const staticFile=async file=>{const st=await fs.stat(file);let c=staticFiles.get(file);if(c?.mtime!==st.mtimeMs||c.size!==st.size){const data=await fs.readFile(file);c={mtime:st.mtimeMs,size:st.size,data,hash:digest(data)};staticFiles.set(file,c);}return c;};
 const serveStatic=async({req,res,url,host})=>{
    if(req.method!=='GET')throw error('Method not allowed.',405);
    const root=path.resolve(options.staticDir||path.join(path.dirname(fileURLToPath(import.meta.url)),'../../local-dist'));
    let file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(file!==root&&!file.startsWith(root+path.sep))throw error('Invalid path.',403);
    if(url.pathname==='/')file=path.join(root,'app.html');
    let data,hash;try{({data,hash}=await staticFile(file));}catch{throw error('Dashboard files not found. Build with npm run build:local or use the prebuilt companion download.',404);}
    const ext=path.extname(file);
    if(ext==='.html'){const v={};for(const n of ['app.css','app.js','boot.js'])v[n]=(await staticFile(path.join(root,n)).catch(()=>null))?.hash;let html=data.toString('utf8').replace(/(href|src)="\/(app\.(?:css|js)|boot\.js)"/g,(m,a,n)=>v[n]?`${a}="/${n}?v=${v[n]}"`:m);if(exposeToken)html=html.replace('</head>',`<meta name="omp-token" content="${token}"/>\n</head>`);
     // The desktop app shows native notifications for this machine, so pages opened here skip the browser's own.
     if(options.desktop&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))html=html.replace('</head>','<meta name="omp-desktop" content="1"/>\n</head>');
     data=Buffer.from(html);hash=digest(data);}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.zip':'application/zip'};
    const headers={'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':csp(host),'Cache-Control':ext!=='.html'&&url.searchParams.get('v')===hash?'public, max-age=31536000, immutable':'no-cache',ETag:`"${hash}"`};
    // Each encoding has its own validator, so If-None-Match is compared once the encoding is chosen. Vary keeps CORS's Origin.
    let body=data;if(['.js','.css','.svg'].includes(ext)&&data.length>=1024){headers.Vary=[res.getHeader('Vary'),'Accept-Encoding'].filter(Boolean).join(', ');if(acceptsGzip(req.headers['accept-encoding'])){const z=await gzOf(hash,data);if(z&&z.length<data.length){body=z;headers['Content-Encoding']='gzip';headers.ETag=`"${hash}-gz"`;}}}
    if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers);res.end();return;}
    res.writeHead(200,headers);res.end(body);return;
   };
 return {digest,serveStatic};
}
