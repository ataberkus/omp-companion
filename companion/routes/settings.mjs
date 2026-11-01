// HTTP routes for OMP configuration: settings, plugins, MCP servers, updates, advisor, models and accounts.
import { now, error, text } from '../util.mjs';
export function settingsRoutes(ctx){
 const {store,persist,listAccounts,runUpdate,listSettings,changeSetting,listPlugins,pluginAction,listMcp,mcpAction,advisorConfig,listModels}=ctx;
 return {
   'GET /api/settings':async({json})=>{try{json(await listSettings());}catch(e){throw error(`Could not read OMP settings: ${e.message}`,502);}return;},
   'GET /api/plugins':async({json})=>{try{json(await listPlugins());}catch(e){throw error(`Could not read OMP plugins: ${e.message}`,502);}return;},
   'GET /api/mcp':async({json})=>{try{json(await listMcp());}catch(e){throw error(`Could not read OMP MCP servers: ${e.message}`,502);}return;},
   'GET /api/omp-update':async({json})=>{json(ctx.updateState);return;},
   'GET /api/advisor':async({json})=>{json(await advisorConfig());return;},
   'GET /api/models':async({json})=>{try{json(await listModels());}catch(e){throw error(`Could not list OMP models: ${e.message}`,502);}return;},
   'GET /api/accounts':async({json})=>{try{json(await listAccounts());}catch(e){throw error(`Could not list provider accounts: ${e.message}`,502);}return;},
   'POST /api/settings':async({body,json})=>{json(await changeSetting(body,false));return;},
   'POST /api/settings/reset':async({body,json})=>{json(await changeSetting(body,true));return;},
   'POST /api/plugins':async({body,json})=>{json(await pluginAction(body));return;},
   'POST /api/mcp':async({body,json})=>{json(await mcpAction(body));return;},
   // The label is OMP's own account label from GET /api/accounts; OMP matches it when the next prompt pins the session.
   'POST /api/accounts':async({body,json})=>{const provider=text(body.provider,'Provider',100),account=text(body.account,'Account',300);if(/[\r\n]/.test(account))throw error('Invalid account.');store.accountChoices[provider]=account;await persist([]);json({provider,account});return;},
   'POST /api/omp-update':async({json})=>{
    if(ctx.updateState.status==='running')throw error('OMP update is already running.',409);
    ctx.updateState={status:'running',startedAt:now()};void runUpdate(ctx.updateState.startedAt);json(ctx.updateState,202);return;
   },
 };
}
