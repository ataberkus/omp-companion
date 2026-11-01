// HTTP routes for workspaces and this PC's files: projects, sidebar layout, the folder browser, terminals and
// opening files in an editor.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { error, text, samePath, resolveDir } from '../util.mjs';
import { openTerminal, EDITORS, EDITOR_CHOICES, editorUrl, openWithOs, detectEditor } from '../system.mjs';
import { projectColor } from '../workspaces.mjs';
export function workspaceRoutes(ctx){
 const {options,store,browse,uiKeys,persist,scheduleSave,ensureProject,refreshBranch}=ctx;
 return {
   'GET /api/browse':async({url,json})=>{json(await browse(url.searchParams.get('path')||''));return;},
   'POST /api/projects':async({body,json})=>{
    const dir=await resolveDir(body.path);if(store.projects.some(p=>samePath(p.path,dir)))throw error('This directory is already registered.');
    const p=await ensureProject(dir,typeof body.name==='string'?body.name:'');p.description=String(body.description||'');await persist([]);json(p,201);return;
   },
   // Workspace settings from the sidebar: rename, colour, hide/show, re-read the branch. `path` registers a folder known
   // only from OMP's history first. Hiding never touches sessions or files; hidden workspaces show under Archived.
   'POST /api/projects/update':async({body,json})=>{
    let p=typeof body.id==='string'?store.projects.find(p=>p.id===body.id):null;
    if(!p&&typeof body.path==='string'){const dir=await resolveDir(body.path);p=await ensureProject(dir);}
    if(!p)throw error('Project not found.',404);
    if(body.name!==undefined)p.name=text(body.name,'Workspace name',80);
    if(body.color!==undefined){const c=projectColor(body.color);if(!c)throw error('Unknown colour.');p.color=c;}
    if(body.hidden!==undefined){if(typeof body.hidden!=='boolean')throw error('hidden must be true or false.');if(body.hidden)p.hidden=true;else delete p.hidden;}
    if(body.refreshBranch===true)await refreshBranch(p);
    await persist([]);json(p);return;
   },
   // Sidebar layout (project order, collapsed groups), shared by every device; each field replaces the saved list.
   'POST /api/ui':async({body,json})=>{
    for(const k of ['groupOrder','collapsed'])if(body[k]!==undefined){const v=uiKeys(body[k]);if(!v)throw error(`${k} must be a list of group keys.`);store.ui[k]=v;}
    scheduleSave([]);json(store.ui);return;
   },
   'POST /api/terminal':async({body,json})=>{const dir=await resolveDir(body.path);await openTerminal(dir);json({path:dir});return;},
   'POST /api/editor':async({body,json})=>{if(!EDITOR_CHOICES.includes(body.editor))throw error('Unknown editor.');store.editor=body.editor;await persist([]);json({editor:store.editor});return;},
   // Open in editor: a file from a diff or tool call, relative paths resolved against the session folder.
   'POST /api/open-file':async({body,json})=>{
    let file=text(body.path,'File path',4000);const line=Number.isInteger(body.line)&&body.line>0?body.line:undefined;
    if(!path.isAbsolute(file)){if(typeof body.cwd!=='string'||!path.isAbsolute(body.cwd))throw error('Use an absolute file path.');file=path.resolve(body.cwd,file);}
    let stat;try{file=await fs.realpath(file);stat=await fs.stat(file);}catch{throw error('File does not exist on this machine.',404);}
    if(!stat.isFile())throw error('Path must be a file.');
    const editor=store.editor==='auto'?await detectEditor():store.editor;
    await (options.openExternal||openWithOs)(editor==='reveal'?file:editorUrl(EDITORS[editor],file,line),{reveal:editor==='reveal'});
    json({path:file,editor});return;
   },
 };
}
