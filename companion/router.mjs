// HTTP API dispatch: Host/Origin and token checks, CORS, gzip, the JSON body, then the route tables in routes/.
import { timingSafeEqual } from 'node:crypto';
import { gzip } from 'node:zlib';
import { error } from './util.mjs';
import { sessionRoutes } from './routes/sessions.mjs';
import { historyRoutes } from './routes/history.mjs';
import { workspaceRoutes } from './routes/workspace.mjs';
import { settingsRoutes } from './routes/settings.mjs';
import { toolRoutes } from './routes/tools.mjs';
import { systemRoutes } from './routes/system.mjs';
export function createRouter(ctx){
 const {serveStatic,token,password,checkOrigin}=ctx;
 const routes={...sessionRoutes(ctx),...historyRoutes(ctx),...workspaceRoutes(ctx),...settingsRoutes(ctx),...toolRoutes(ctx),...systemRoutes(ctx)};
 async function onRequest(req,res,srv){
 // Big JSON (the viewed session's messages, transcripts, settings) goes out gzipped when the client accepts it; zlib runs off the event loop.
 // Level 2 under Bun (the desktop app's runtime), 1 under Node: Bun's level 1 made bodies 28-45% larger than Node's (a
 // 2.7 MB first poll: 1095 vs 853 KB), and its level 2 matches Node's 1 for less CPU. Loopback replies are compressed
 // too: tailscale serve, SSH tunnels and reverse proxies all arrive from 127.0.0.1.
 const send=(status,headers,body)=>{if(body.length<1024||!/\bgzip\b/.test(req.headers['accept-encoding']||'')){res.writeHead(status,headers);res.end(body);return;}gzip(body,{level:process.versions.bun?2:1},(e,z)=>{if(res.headersSent)return;res.writeHead(status,e?headers:{...headers,'Content-Encoding':'gzip'});res.end(e?body:z);});};
 const json=(value,status=200)=>send(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'},JSON.stringify(value));
  try{
   const {origin,host}=await checkOrigin(req,srv),port=srv.address()?.port;
   if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Private-Network','true');}
   if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
   const url=new URL(req.url,`http://127.0.0.1:${port}`);
   if(!url.pathname.startsWith('/api/')){await serveStatic({req,res,url,host});return;}
   const provided=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
   if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw error(password?'Wrong password.':'Invalid connection token.',401);
   if(req.method==='GET'&&routes['GET '+url.pathname]){await routes['GET '+url.pathname]({req,res,url,send,json});return;}
   if(req.method!=='POST')throw error('Route not found.',404);
   if(!String(req.headers['content-type']).startsWith('application/json'))throw error('JSON body required.',415);
   const cap=url.pathname==='/api/quick-start'||url.pathname==='/api/omp-sessions/resume'||url.pathname==='/api/enhance'||url.pathname==='/api/draft'||/^\/api\/sessions\/[^/]+\/command$/.test(url.pathname)?48*1024*1024:256*1024;
   const buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>cap)throw error(cap>256*1024?'This message is too large to upload: text and images together must stay under 48 MB. Remove some images and try again.':'Request body too large.',413);buffers.push(chunk);}let body;try{body=JSON.parse(Buffer.concat(buffers).toString());}catch{throw error('Invalid JSON.');}
   if(!body||typeof body!=='object'||Array.isArray(body))throw error('JSON object required.');
   const route=routes['POST '+url.pathname]??(/^\/api\/sessions\/[^/]+\/command$/.test(url.pathname)?routes['POST /api/sessions/:id/command']:undefined);
   if(route){await route({req,res,url,body,send,json});return;}
   throw error('Route not found.',404);
  }catch(e){json({error:e.message},e.status||500);}
}
 return {onRequest};
}
