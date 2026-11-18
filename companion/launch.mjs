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
// The Antigravity CLI refuses a request that carries OMP's own system prompt: the account tier answers `⚠ API error
// (attempt 1): RESOURCE_EXHAUSTED (code 429)` for its text, not its size (the same prompt sent through a plain ACP client
// fails, while a short one and every other provider's answer pass). A session on an antigravity-cli model therefore sends
// the companion's own prompt, and a built-in tool set instead of the default one: the MCP/xd tool-route docs that come with
// the full set (`# xd:// Tool Devices`, `# Internal URLs`) hit the same refusal, `--tools` leaves them out.
// The agent keeps its file and shell tools; what it loses is the skills list, the MCP tool catalogue and plan-mode extras.
export const AGY_PROMPT='You are an autonomous coding agent working in the user\u2019s repository. Read the code before you change it, keep every change small and in the style of the file around it, and use bash for commands and tests. Verify a change with the project\u2019s own checks before you report it. Finish with a short report of what changed and what still needs attention, in the language the user writes in.';
export const AGY_TOOLS=['read','write','edit','bash','grep','glob'];
export function agySessionArgs(selector,launch){
 if(!/^antigravity-cli\//.test(selector||''))return [];
 // A system prompt or tool list the user chose for this session wins; a prompt alone still needs the tool list trimmed.
 // `--no-tools` stays tool-less rather than being given a list back.
 const tools=launch?.tools||launch?.noTools?[]:[`--tools=${AGY_TOOLS.join(',')}`];
 return [...(launch?.systemPrompt?[]:[`--system-prompt=${AGY_PROMPT}`]),...tools];
}

