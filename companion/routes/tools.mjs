// HTTP routes for the Tools page, Enhance prompt and Spend page.
import { error } from '../util.mjs';
import { cliCatalog } from '../cli-tools.mjs';
export function toolRoutes(ctx){
 const {spend,enhanceJobs,stopEnhance,cliJobs,cliProcs,startEnhance,runCli,cliRev,bumpCliRev}=ctx;
 return {
   // revs=1: each job carries its revision, and one named in have=<id>.<rev>,… comes back as {id,rev,unchanged:true};
   // catalog=0 leaves out the tools, which only change with the companion. Without revs=1, the reply as before.
   'GET /api/cli':async({url,json})=>{const q=url.searchParams;if(q.get('revs')!=='1'){json({tools:cliCatalog(),jobs:cliJobs});return;}
    const have=new Set((q.get('have')||'').split(',').filter(Boolean));
    json({...(q.get('catalog')==='0'?{}:{tools:cliCatalog()}),jobs:cliJobs.map(j=>{const rev=cliRev(j);return have.has(j.id+'.'+rev)?{id:j.id,rev,unchanged:true}:{...j,rev};})});return;},
   'GET /api/enhance':async({url,json})=>{const job=enhanceJobs.get(url.searchParams.get('id'));if(!job)throw error('Enhance not found.',404);
    if(job.status!=='running')enhanceJobs.delete(job.id);
    json({id:job.id,status:job.status,step:job.step,model:job.model,...(job.status==='done'?{text:job.text}:{}),...(job.error?{error:job.error}:{})});return;},
   'GET /api/spend':async({url,json})=>{try{json(await spend(url.searchParams.get('sync')==='1'));}catch(e){throw error(`Could not read OMP usage stats: ${String(e.stderr||e.message).trim()}`,502);}return;},
   'POST /api/cli':async({body,json})=>{json(await runCli(body),202);return;},
   'POST /api/cli/stop':async({body,json})=>{const job=cliJobs.find(j=>j.id===body.id);if(!job)throw error('Command not found.',404);const child=cliProcs.get(job.id);if(child){job.stopped=true;bumpCliRev(job);child.kill();}json(job);return;},
   'POST /api/enhance':async({body,json})=>{json(await startEnhance(body),202);return;},
   'POST /api/enhance/stop':async({body,json})=>{const job=enhanceJobs.get(body.id);if(!job)throw error('Enhance not found.',404);await stopEnhance(job);json({status:job.status});return;},
 };
}
