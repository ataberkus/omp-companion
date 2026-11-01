// Slash commands: the list per live session, and probing a folder's commands with a short-lived OMP.
import { error } from './util.mjs';
export function createSlashCommands(ctx){
 const {omp}=ctx;
 // Slash commands per live session, from available_commands_update; served on demand, not in every /api/state poll.
 const commands=new Map();
 const subcommandList=v=>Array.isArray(v)?v.slice(0,50).filter(x=>typeof x?.name==='string'&&x.name.trim()).map(x=>({name:x.name.slice(0,60),description:String(x.description||'').slice(0,300),usage:String(x.usage||'').slice(0,160)})):[];
 const slashList=list=>[{name:'usage',description:"Show the selected model's provider quota, remaining usage and reset times",aliases:[],hint:'[show]',source:'companion'},{name:'btw',description:'Ask a side question about this session; the answer stays out of the conversation',aliases:[],hint:'<question>',source:'companion'},...list.slice(0,500).filter(c=>typeof c?.name==='string'&&c.name!=='usage'&&c.name!=='btw').map(c=>({name:c.name.slice(0,100),description:String(c.description||'').slice(0,300),aliases:Array.isArray(c.aliases)?c.aliases.filter(a=>typeof a==='string').slice(0,10):[],hint:String(c.input?.hint||'').slice(0,100),source:String(c.source||''),subcommands:subcommandList(c.subcommands)}))];
 const commandProbes=new Set();
 async function discoverCommands(dir){
  const probe=omp.start({cwd:dir,args:['--no-session'],onEvent:()=>{},onExit:()=>{}});
  commandProbes.add(probe);
  try{
   const list=await probe.commands();
   if(!Array.isArray(list))throw error('OMP did not provide its slash commands. Update OMP and try again.',502);
   return slashList(list);
  }finally{await stopProbe(probe);}
 }
 async function stopProbe(probe){await probe.kill();commandProbes.delete(probe);}
 return {commands,slashList,commandProbes,discoverCommands,stopProbe};
}
