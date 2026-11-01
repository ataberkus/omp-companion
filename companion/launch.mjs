// Launch options a session starts OMP with (approval mode, role models, flags): validation and OMP arguments.
import { error, resolveDir } from './util.mjs';
export const MODEL_RE=/^[\w.~@+-]+\/[\w.~@:+\/-]+$/;
// Per-session OMP launch flags. Values are passed as `--flag=value`, so a value can never be read as another flag.
const APPROVAL_MODES=['always-ask','write','yolo'];
const LAUNCH_BOOLS={prewalk:'--prewalk',planYolo:'--plan-yolo',noTools:'--no-tools',noLsp:'--no-lsp',noPty:'--no-pty',noSkills:'--no-skills',noRules:'--no-rules',noExtensions:'--no-extensions',noTitle:'--no-title'};
const LAUNCH_MODELS={smol:'--smol',slow:'--slow',plan:'--plan',prewalkInto:'--prewalk-into',planYoloInto:'--plan-yolo-into'};
export async function launchOptions(v){
 if(v===undefined||v===null)return undefined;
 if(typeof v!=='object'||Array.isArray(v))throw error('Invalid launch options.');
 const o={};const list=(value,name,re,max)=>{const items=(Array.isArray(value)?value:String(value??'').split(',')).map(x=>String(x).trim()).filter(Boolean);if(items.length>max||items.some(x=>x.length>200||!re.test(x)))throw error(`Invalid ${name}.`);return items;};
 if(v.approvalMode){if(!APPROVAL_MODES.includes(v.approvalMode))throw error('Approval mode must be always-ask, write or yolo.');o.approvalMode=v.approvalMode;}
 for(const k of Object.keys(LAUNCH_BOOLS))if(v[k]===true)o[k]=true;else if(v[k]!==undefined&&v[k]!==false)throw error(`${k} must be true or false.`);
 for(const k of Object.keys(LAUNCH_MODELS))if(v[k]){if(typeof v[k]!=='string'||!MODEL_RE.test(v[k].trim()))throw error(`Invalid ${k} model.`);o[k]=v[k].trim();}
 if(v.tools){const t=list(v.tools,'tool list',/^[\w-]+$/,80);if(t.length)o.tools=t;}
 if(v.skills){const t=list(v.skills,'skill patterns',/^[\w*?.:@\/-]+$/,40);if(t.length)o.skills=t;}
 if(v.maxTime){const t=String(v.maxTime).trim();if(!/^\d{1,6}[smh]?$/.test(t))throw error('Max time looks like 600, 10m or 1h.');o.maxTime=t;}
 if(v.addDirs){const dirs=Array.isArray(v.addDirs)?v.addDirs:String(v.addDirs).split('\n');const out=[];for(const d of dirs.map(x=>String(x).trim()).filter(Boolean).slice(0,10))out.push(await resolveDir(d));if(out.length)o.addDirs=out;}
 for(const k of ['systemPrompt','appendSystemPrompt'])if(typeof v[k]==='string'&&v[k].trim()){if(v[k].length>8000)throw error('System prompts are limited to 8,000 characters here.');o[k]=v[k].trim();}
 else if(v[k]!==undefined&&typeof v[k]!=='string')throw error(`${k} must be text.`);
 return Object.keys(o).length?o:undefined;
}
// `--plan-yolo` forces plan mode at start, so it only applies to a session's first launch.
export function launchArgs(o,first){
 if(!o)return [];const a=[];
 if(o.approvalMode)a.push('--approval-mode='+o.approvalMode);
 for(const [k,f] of Object.entries(LAUNCH_BOOLS))if(o[k]&&(k!=='planYolo'||first))a.push(f);
 for(const [k,f] of Object.entries(LAUNCH_MODELS))if(o[k]&&(k!=='planYoloInto'||first&&o.planYolo)&&(k!=='prewalkInto'||o.prewalk))a.push(`${f}=${o[k]}`);
 if(o.tools)a.push('--tools='+o.tools.join(','));if(o.skills)a.push('--skills='+o.skills.join(','));if(o.maxTime)a.push('--max-time='+o.maxTime);
 for(const d of o.addDirs||[])a.push('--add-dir='+d);
 if(o.systemPrompt)a.push('--system-prompt='+o.systemPrompt);if(o.appendSystemPrompt)a.push('--append-system-prompt='+o.appendSystemPrompt);
 return a;
}
