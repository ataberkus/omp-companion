// OMP plugins and MCP servers: listing them and installing, removing, enabling or disabling one.
import * as os from 'node:os';
import { error, text } from './util.mjs';
import { cleanUpdateOutput } from './update.mjs';
export function createPlugins(ctx){
 const {omp,store,dataDir,execOmp}=ctx;
// Installed + discoverable OMP plugins. `plugin list --json` is structured;
// `plugin discover` prints plain text even with --json, so parse its listing.
async function listPlugins(){
 const run=args=>execOmp(args,{cwd:dataDir,timeout:30000,maxBuffer:16*1024*1024,windowsHide:true});
 const [j,t]=await Promise.all([run(['plugin','list','--json']),run(['plugin','discover']).catch(()=>({stdout:''}))]);
 let installed;
 try{const d=JSON.parse(j.stdout);installed=[...(d.npm||[]),...(d.marketplace||[])].map(p=>{const e=p.entries?.[0]||{};return {id:String(p.id),version:e.version||'',scope:e.scope||p.scope||'',enabled:e.enabled!==false};}).filter(p=>p.id);}catch{throw error('Could not parse plugin list.');}
 const available=[];const lines=String(t.stdout||'').split(/\r?\n/);
 for(let i=0;i<lines.length;i++){const m=lines[i].match(/^\s{2}(\S+)\s*$/);if(!m||m[1].startsWith('-'))continue;const id=m[1];let description='';const n=lines[i+1];if(n&&/^ {4}\S/.test(n))description=n.trim().slice(0,500);available.push({id,description});}
 const descByBase=new Map(available.map(a=>[a.id.split('@')[0].toLowerCase(),a.description]));
 for(const p of installed)if(descByBase.get(p.id.split('@')[0].toLowerCase()))p.description=descByBase.get(p.id.split('@')[0].toLowerCase());
 return {plugins:installed,available};
}
async function pluginAction(body){
 const action=text(body.action,'Action',20).toLowerCase();
 if(!['install','uninstall','enable','disable'].includes(action))throw error('Unknown plugin action.');
 const id=text(body.id,'Plugin',200);
 // Installed ids are `name@marketplace`; install also accepts owner/repo or a path, so it keeps the broader charset.
 if(action==='install'){if(!/^[\w.~/:@+~-]{1,200}$/.test(id))throw error('Invalid plugin name.');}
 else if(!/^[\w.+-]+(@[\w.+-]+)?$/.test(id))throw error('Invalid plugin name.');
 let scope;
 if(body.scope!==undefined){scope=text(body.scope,'Scope',20).toLowerCase();if(scope!=='user'&&scope!=='project')throw error('Scope must be user or project.');}
 const args=['plugin',action,id,...(scope?['--scope',scope]:[])];
 try{await execOmp(args,{cwd:dataDir,timeout:20*60*1000,maxBuffer:16*1024*1024,windowsHide:true});}
 catch(err){throw error(cleanUpdateOutput(err.stderr,err.stdout,err.killed?'Plugin action timed out.':err.message)||`Could not ${action} the plugin.`);}
 return listPlugins();
}
// MCP servers from OMP's own discovery and config writer (mcp-config.mjs, through the OMP host). User-level configs are
// read once; project configs (.omp/mcp.json, .mcp.json, ...) depend on the folder, so each visible project adds its own.
const mcpScopes=()=>[{cwd:os.homedir()},...store.projects.filter(p=>!p.hidden).map(p=>({cwd:p.path,project:{id:p.id,name:p.name,path:p.path}}))];
async function listMcp(){if(!omp.mcpServers)throw new Error('this OMP build cannot list them.');return omp.mcpServers(mcpScopes());}
async function mcpAction(body){
 const action=text(body.action,'Action',20).toLowerCase();
 if(action!=='enable'&&action!=='disable')throw error('Unknown MCP server action.');
 const name=text(body.name,'Server',100);
 let cwd=os.homedir(),project=false;
 if(body.project!==undefined&&body.project!==null){const p=store.projects.find(p=>p.id===body.project&&!p.hidden);if(!p)throw error('Project not found.',404);cwd=p.path;project=true;}
 if(!omp.setMcpEnabled)throw error('This OMP build cannot change MCP servers.',502);
 try{await omp.setMcpEnabled({cwd,project,name,enabled:action==='enable'});}
 catch(e){throw error(e.status?e.message:`Could not ${action} the MCP server: ${e.message}`,e.status||400);}
 try{return await listMcp();}catch(e){throw error(`Could not read OMP MCP servers: ${e.message}`,502);}
}
 return {listPlugins,pluginAction,listMcp,mcpAction};
}
