// HTTP routes for the Tools page, Enhance prompt and Spend page.
import { error } from '../util.mjs';
import { cliCatalog } from '../cli-tools.mjs';
export function toolRoutes(ctx){
 const {spend,enhanceJobs,stopEnhance,cliJobs,cliProcs,startEnhance,runCli}=ctx;
 return {
   'GET /api/cli':async({json})=>{json({tools:cliCatalog(),jobs:cliJobs});return;},
   'GET /api/enhance':async({url,json})=>{const job=enhanceJobs.get(url.searchParams.get('id'));if(!job)throw error('Enhance not found.',404);
    if(job.status!=='running')enhanceJobs.delete(job.id);
    json({id:job.id,status:job.status,step:job.step,model:job.model,...(job.status==='done'?{text:job.text}:{}),...(job.error?{error:job.error}:{})});return;},
   'GET /api/spend':async({url,json})=>{try{json(await spend(url.searchParams.get('sync')==='1'));}catch(e){throw error(`Could not read OMP usage stats: ${String(e.stderr||e.message).trim()}`,502);}return;},
   'POST /api/cli':async({body,json})=>{json(await runCli(body),202);return;},
   'POST /api/cli/stop':async({body,json})=>{const job=cliJobs.find(j=>j.id===body.id);if(!job)throw error('Command not found.',404);const child=cliProcs.get(job.id);if(child){job.stopped=true;child.kill();}json(job);return;},
   'POST /api/enhance':async({body,json})=>{json(await startEnhance(body),202);return;},
   'POST /api/enhance/stop':async({body,json})=>{const job=enhanceJobs.get(body.id);if(!job)throw error('Enhance not found.',404);await stopEnhance(job);json({status:job.status});return;},
 };
}
