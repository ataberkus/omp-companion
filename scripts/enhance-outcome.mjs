#!/usr/bin/env node
// Outcome check for ✨ Enhance: when a coding agent follows a prompt, is the user's request done completely and working?
// Not part of `npm test`: every run is a full `omp -p` agent with edit and bash rights, minutes each.
//
// For each draft in scripts/enhance-outcome.cases.json and each variant, it copies the repo into a fresh workspace (a git
// clone without remotes, or a plain copy without .env files), runs the agent there on the variant's prompt (the draft's
// conversation, if any, goes first as earlier session context), then runs the repo's test command, the draft's hidden
// checks (files the agent never saw, written only after it finished) and a blind outcome judge over the diff.
// A variant is `draft` (the raw draft, no enhancing) or the name of a variant in an enhance-compare results.json (--from).
//
//   node scripts/enhance-outcome.mjs --from DIR [--from DIR]... --variant draft --variant X1 [--variant ...]
//        [--only id,..] [--samples N] [--out DIR] [--concurrency 4] [--model provider/id] [--thinking level]
//        [--reuse DIR]... [--judge-model provider/id] [--keep-workspaces]
//   node scripts/enhance-outcome.mjs --report DIR    rebuild summary.md from DIR/results.json
// --samples runs every draft/variant pair N times (agents vary run to run). --reuse takes earlier agent runs whose input
// and setup match and only re-judges them when the judge changed. The first --variant is the reference in the summary.
//
// The agent runs with OMP's normal coding prompt and tools except MCP, skills, extensions, memory, autolearn and context
// files (the same for every variant), --approval-mode=yolo, in the workspace only. The source repos are only read; their
// git status is compared before and after.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_TIMEOUT_MS = 20 * 60e3, CHECK_TIMEOUT_MS = 10 * 60e3, JUDGE_TIMEOUT_MS = 5 * 60e3;
const die = msg => { console.error(msg); process.exit(1); };
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const ompEntry = process.env.OMP_BIN || 'omp', ompSource = /\.ts$/i.test(ompEntry);
const OMP = ompSource ? 'bun' : ompEntry, OMP_PREFIX = ompSource ? [path.resolve(ompEntry)] : [];

const argv = process.argv.slice(2), opt = { from: [], variants: [], reuse: [], concurrency: 4, samples: 1 };
for (let i = 0; i < argv.length; i++) {
 const a = argv[i], val = () => { const v = argv[++i]; if (v == null) die(`${a} needs a value.`); return v; };
 if (a === '--from') opt.from.push(val());
 else if (a === '--variant') opt.variants.push(val());
 else if (a === '--reuse') opt.reuse.push(val());
 else if (a === '--only') opt.only = val().split(',');
 else if (a === '--out') opt.out = val();
 else if (a === '--concurrency') opt.concurrency = Math.max(1, Number(val()) || 1);
 else if (a === '--samples') opt.samples = Math.max(1, Number(val()) || 1);
 else if (a === '--model') opt.model = val();
 else if (a === '--thinking') opt.thinking = val();
 else if (a === '--judge-model') opt.judgeModel = val();
 else if (a === '--keep-workspaces') opt.keep = true;
 else if (a === '--report') opt.report = val();
 else die(`Unknown argument ${a}. See the comment at the top of scripts/enhance-outcome.mjs.`);
}

// Everything that can start MCP servers, load skills/rules/context files or write outside the workspace is off.
const PROVIDERS = ['agent-plugins', 'agents', 'agents-md', 'claude', 'claude-md', 'claude-plugins', 'cline', 'codex', 'cursor', 'custom-context', 'gemini', 'github', 'mcp-json', 'native', 'omp-plugins', 'opencode', 'skillshare', 'ssh-json', 'vscode', 'windsurf'];
// Print mode ends the run when the agent yields, so a test run moved to a background job would never report back; in the
// companion's long-lived RPC sessions it would. Keeping every call in the foreground gives the same outcome here.
const AGENT_OVERLAY = `tools:\n  xdev: false\nadvisor:\n  enabled: false\nautolearn:\n  enabled: false\n  autoContinue: false\nmemory:\n  backend: "off"\ncheckpoint:\n  enabled: false\nask:\n  enabled: false\nasync:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\ndisabledProviders:\n${PROVIDERS.map(p => `  - ${p}\n`).join('')}`;
const AGENT_TOOLS = 'read,write,edit,bash,grep,glob';

const textOf = content => (Array.isArray(content) ? content : []).filter(p => p?.type === 'text').map(p => p.text).join('');
function killTree(child) { if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); else child.kill('SIGKILL'); }
function sh(cmd, cwd, timeoutMs) {
 return new Promise(resolve => {
  const started = Date.now(), child = spawn('bash', ['-c', cmd], { cwd, windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' } });
  let out = ''; const add = b => { out = (out + b).slice(-60000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? null : code, timedOut, ms: Date.now() - started, out }); });
  child.on('error', e => { clearTimeout(timer); resolve({ code: null, error: e.message, ms: Date.now() - started, out }); });
 });
}
const tail = (s, n = 40) => String(s || '').split(/\r?\n/).filter(l => l.trim()).slice(-n).join('\n');
// Suites with fixed ports (kulup-video's server tests) collide when two workspaces of one repo run them at once: one run at
// a time per repo here, and one retry for a collision with another process (another harness, or an agent's own test run).
const repoLocks = new Map();
function repoSh(repo, cmd, cwd) {
 const run = async () => { let r = await sh(cmd, cwd, CHECK_TIMEOUT_MS); if (r.code !== 0 && /EADDRINUSE/.test(r.out)) { await new Promise(res => setTimeout(res, 5000)); r = await sh(cmd, cwd, CHECK_TIMEOUT_MS); } return r; };
 const next = (repoLocks.get(repo) || Promise.resolve()).then(run, run);
 repoLocks.set(repo, next.catch(() => {}));
 return next;
}

// ---------- workspaces ----------
async function makeWorkspace(srcDir, dest, copyDirs) {
 await fs.rm(dest, { recursive: true, force: true });
 await fs.mkdir(path.dirname(dest), { recursive: true });
 if (existsSync(path.join(srcDir, '.git'))) {
  await exec('git', ['clone', '-q', '--no-hardlinks', srcDir, dest]);
  await exec('git', ['remote', 'remove', 'origin'], { cwd: dest }).catch(() => {});
 } else {
  await fs.cp(srcDir, dest, { recursive: true, filter: s => !/^\.env(\..+)?$/.test(path.basename(s)) || path.basename(s) === '.env.example' });
  await exec('git', ['init', '-q'], { cwd: dest });
  await exec('git', ['add', '-A'], { cwd: dest });
  await exec('git', ['-c', 'user.email=outcome@local', '-c', 'user.name=outcome', 'commit', '-q', '-m', 'baseline', '--no-verify'], { cwd: dest });
 }
 for (const d of copyDirs || []) if (existsSync(path.join(srcDir, d)) && !existsSync(path.join(dest, d))) await fs.cp(path.join(srcDir, d), path.join(dest, d), { recursive: true });
 for (const f of await fs.readdir(dest)) if (/^\.env(\..+)?$/.test(f) && f !== '.env.example') await fs.rm(path.join(dest, f), { force: true });
}
async function diffOf(dir, ignore = []) {
 const leftovers = ignore.map(g => `:(exclude)${g}`), skip = ['--', '.', ':(exclude)**/bin/**', ':(exclude)**/obj/**', ':(exclude)node_modules/**', ...leftovers];
 // Leftover nested repos without a commit (apex's checkpoint fixtures) make a plain `git add -A` fail; excluding a
 // gitignored path (node_modules, bin) makes it fail too, so `add` only skips the leftovers and `diff` the rest.
 await exec('git', ['add', '-A', '--', '.', ...leftovers], { cwd: dir, maxBuffer: 64 << 20 });
 const stat = (await exec('git', ['diff', '--cached', '--stat', 'HEAD', ...skip], { cwd: dir, maxBuffer: 64 << 20 })).stdout;
 const diff = (await exec('git', ['diff', '--cached', 'HEAD', ...skip], { cwd: dir, maxBuffer: 64 << 20 })).stdout;
 await exec('git', ['reset', '-q'], { cwd: dir });
 return { stat, diff };
}
// Drops files matching a repo's `ignore` globs (leftovers of test runs, like apex's tests/.checkpoint-fixture-*) from a diff.
function dropIgnored(w, ignore) {
 if (!ignore?.length || !w.diff) return;
 const res = ignore.map(g => new RegExp(`^${g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}(/|$)`)), hit = p => res.some(r => r.test(p));
 w.diff = w.diff.split(/(?=^diff --git )/m).filter(s => { const m = s.match(/^diff --git a\/(\S+)/); return !m || !hit(m[1]); }).join('');
 w.stat = String(w.stat || '').split('\n').filter(l => { const m = l.match(/^\s*(\S+)\s+\|/); return !m || !hit(m[1]); }).join('\n');
}

// ---------- agent ----------
function agentInput(c, prompt) {
 const conv = (c.conversation || []).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n\n');
 return conv ? `Earlier in this session:\n\n${conv}\n\n---\n\n${prompt}` : prompt;
}
function runAgent(cwd, input, cfg) {
 const args = ['-p', '--mode', 'json', '--no-session', '--no-title', '--no-skills', '--no-extensions', '--no-rules', `--tools=${AGENT_TOOLS}`, '--approval-mode=yolo', `--config=${cfg.overlay}`, ...(cfg.model ? [`--model=${cfg.model}`] : []), ...(cfg.thinking ? [`--thinking=${cfg.thinking}`] : [])];
 return new Promise(resolve => {
  const started = Date.now(), r = { tools: [], answer: '', cost: 0, model: '', stop: '', errorMessage: '' };
  let stderr = '', timedOut = false;
  const child = spawn(OMP, [...OMP_PREFIX, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  child.stdin.on('error', () => {}); child.stdin.end(input, 'utf8');
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
   let f; try { f = JSON.parse(line); } catch { return; }
   if (f.type === 'tool_execution_start') r.tools.push({ name: f.toolName, args: JSON.stringify(f.args || {}).slice(0, 300) });
   else if (f.type === 'message_end' && f.message?.role === 'assistant') {
    const m = f.message; r.answer = textOf(m.content) || r.answer; r.stop = m.stopReason || ''; r.errorMessage = String(m.errorMessage || '').trim();
    r.cost += m.usage?.cost?.total || 0; r.model = `${m.provider}/${m.model}`;
   }
  });
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, AGENT_TIMEOUT_MS);
  child.on('close', code => { clearTimeout(timer); r.ms = Date.now() - started; r.error = timedOut ? 'timed out' : code !== 0 ? (r.errorMessage || tail(stderr, 3) || `exit ${code}`) : ''; resolve(r); });
  child.on('error', e => { clearTimeout(timer); r.ms = Date.now() - started; r.error = e.message; resolve(r); });
 });
}

// ---------- blind outcome judge ----------
const JUDGE_SYSTEM = `You review the result of a coding agent's work for a user. You get the user's own draft request (and the earlier conversation it refers to), an expert's note on what the request means, the diff the agent produced, the repository's test results before and after, hidden acceptance checks run afterwards, and the agent's final message. You do not see the prompt the agent was given. Judge only the outcome against what the user wanted.
Reply with ONLY one JSON object, no prose and no code fence:
{"complete":2|1|0,"missing":[],"extra":[],"broken":[],"works":true|false|null,"quality":1-5,"notes":"one sentence"}
- complete: 2 = every ask in the request is done, correctly and in every place it applies; 1 = partly done or done with a mistake; 0 = not done, or a different change.
- missing: short phrases for each ask that is not done, done wrong, or done in only some of the places it applies.
- extra: short phrases for each change the user did not ask for and the request does not need (a test for the requested change is fine unless the user excluded tests; edits to things the user said to leave alone count here; so does restructuring code just to test it: extracting or exporting internals, adding interfaces, injection or virtual members). Leave out what the change itself needs (imports, a helper the change uses, the test's own setup).
- broken: short phrases for each thing that now fails or behaves differently when it should not (tests that passed before and fail now, build errors, changed behaviour outside the request). Tests that already failed before the change, for reasons the request does not cover, count against nothing.
- works: whether the requested behaviour works as far as the evidence shows (tests, hidden checks, reading the diff); null when no code change was asked for.
- quality: would the user accept this as is, without asking for any fix? 5 = yes; 1 = unusable.
For a question, an explanation or an investigation, the outcome is mostly the agent's final message: complete = it answers exactly what was asked, correctly and grounded in the actual code, in the language the user wrote in; any file change the user did not ask for is extra. When the request leaves it open whether to explain or to fix, either is complete if correct and the user's limits are kept.`;
function judgeInput(c, w) {
 const conv = (c.conversation || []).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n\n');
 const diff = w.diff.length > 60000 ? w.diff.slice(0, 60000) + '\n[diff cut at 60000 chars]' : w.diff;
 const checks = (w.checks || []).map(k => `${k.name}: ${k.pass ? 'PASS' : 'FAIL'}${k.pass ? '' : `\n${tail(k.out, 25)}`}`).join('\n') || 'none';
 return `${conv ? `<conversation>\n${conv}\n</conversation>\n` : ''}<draft>\n${c.draft}\n</draft>\n<expert_note>\n${c.note}\n</expert_note>\n<diff_stat>\n${w.stat || '(no changes)'}\n</diff_stat>\n<diff>\n${diff || '(empty)'}\n</diff>\n<tests_before>\n${w.suiteBefore ? `exit ${w.suiteBefore.code}\n${tail(w.suiteBefore.out, 25)}` : 'no test command'}\n</tests_before>\n<tests_after>\n${w.suite ? `exit ${w.suite.code}\n${tail(w.suite.out, 25)}` : 'no test command'}\n</tests_after>\n<hidden_checks>\n${checks}\n</hidden_checks>\n<agent_final_message>\n${String(w.agent.answer || '').slice(-4000)}\n</agent_final_message>`;
}
function askJudge(input, cfg) {
 const args = ['-p', '--mode', 'json', '--no-session', '--no-title', '--no-skills', '--no-extensions', '--no-lsp', '--no-rules', '--no-tools', `--config=${cfg.overlay}`, `--append-system-prompt=${cfg.system}`, ...(cfg.model ? [`--model=${cfg.model}`] : []), '--thinking=medium'];
 return new Promise(resolve => {
  const child = spawn(OMP, [...OMP_PREFIX, ...args], { cwd: cfg.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
  let answer = ''; child.stdin.on('error', () => {}); child.stdin.end(input, 'utf8');
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', l => { try { const f = JSON.parse(l); if (f.type === 'message_end' && f.message?.role === 'assistant') answer = textOf(f.message.content); } catch {} });
  const timer = setTimeout(() => killTree(child), JUDGE_TIMEOUT_MS);
  child.on('close', () => { clearTimeout(timer); const m = answer.match(/\{[\s\S]*\}/); try { resolve(m ? JSON.parse(m[0]) : { error: 'judge gave no JSON' }); } catch { resolve({ error: 'judge gave bad JSON' }); } });
  child.on('error', e => { clearTimeout(timer); resolve({ error: e.message }); });
 });
}

// ---------- scoring and report ----------
function verdict(w) {
 const j = w.judge || {}, problems = [];
 if (w.agent.error) problems.push(`agent: ${w.agent.error}`);
 for (const k of w.checks || []) if (!k.pass) problems.push(`hidden check failed: ${k.name}`);
 if (w.suiteBefore && w.suite && w.suiteBefore.code === 0 && w.suite.code !== 0) problems.push('tests passed before, fail now');
 if (j.error) problems.push(`judge: ${j.error}`);
 else {
  if (j.complete !== 2) problems.push(`complete ${j.complete}/2${j.missing?.length ? `: ${j.missing.join('; ')}` : ''}`);
  if (j.extra?.length) problems.push(`extra: ${j.extra.join('; ')}`);
  if (j.broken?.length) problems.push(`broken: ${j.broken.join('; ')}`);
  if (j.works === false) problems.push('does not work');
 }
 return { success: !problems.length, problems };
}
const runsOf = (data, v, id) => { const x = data.results?.[v]?.[id]; return !x ? [] : Array.isArray(x) ? x.filter(Boolean) : [x]; };
async function writeReport(outDir, data) {
 const names = data.variants, rate = (v, id) => { const xs = runsOf(data, v, id); return xs.length ? xs.filter(x => x.verdict.success).length / xs.length : null; };
 const rows = names.map(v => {
  const xs = data.cases.flatMap(c => runsOf(data, v, c.id)), judged = xs.filter(x => x.judge && !x.judge.error);
  const mean = (a, f) => a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : NaN;
  let better = 0, worse = 0; for (const c of data.cases) { const a = rate(v, c.id), b = rate(names[0], c.id); if (a == null || b == null) continue; if (a > b) better++; else if (a < b) worse++; }
  return { v, runs: xs.length, better, worse, success: xs.filter(x => x.verdict.success).length, complete2: judged.filter(x => x.judge.complete === 2).length, extra: judged.filter(x => x.judge.extra?.length).length, broken: judged.filter(x => x.judge.broken?.length).length, hiddenFail: xs.filter(x => (x.checks || []).some(k => !k.pass)).length, testsBroke: xs.filter(x => x.suiteBefore?.code === 0 && x.suite && x.suite.code !== 0).length, quality: mean(judged, x => x.judge.quality), q5: judged.filter(x => x.judge.quality === 5).length, minutes: mean(xs, x => x.agent.ms / 60000), cost: xs.reduce((s, x) => s + x.agent.cost, 0) };
 });
 const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '–';
 const md = ['# Enhance outcome check', '', `${data.cases.length} drafts × ${data.samples || 1} run(s) · agent ${data.agentModel || 'default model'}${data.thinking ? ` · thinking ${data.thinking}` : ''} · ${data.ompVersion}`, '', `| | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`];
 const line = (label, f) => md.push(`| ${label} | ${rows.map(f).join(' | ')} |`);
 line('**done right** (complete, nothing extra or broken, checks pass)', r => `**${r.success} / ${r.runs}**`);
 line(`drafts better / worse than ${names[0]} (done-right rate)`, r => r.v === names[0] ? '–' : `${r.better} / ${r.worse}`);
 line('every ask done (judge)', r => r.complete2);
 line('unasked changes / broken behaviour', r => `${r.extra} / ${r.broken}`);
 line('hidden check failed / tests newly failing', r => `${r.hiddenFail} / ${r.testsBroke}`);
 line('outcome quality (mean / rated 5)', r => `${f1(r.quality)} / ${r.q5}`);
 line('agent minutes (mean) / agent cost', r => `${f1(r.minutes)} / $${r.cost.toFixed(2)}`);
 md.push('', `Source repos untouched: ${data.readOnly ? (data.readOnly.length ? `NO\n\n${data.readOnly.map(x => `- ${x}`).join('\n')}` : 'yes (git status unchanged)') : 'not checked'}`, '', '## Per draft', '', `| draft | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`);
 for (const c of data.cases) md.push(`| ${c.id} | ${names.map(v => { const xs = runsOf(data, v, c.id); if (!xs.length) return '–'; return xs.map(x => `${x.verdict.success ? '✅' : '⚠️'} q${x.judge?.quality ?? '?'}${x.verdict.problems.length ? ' ' + x.verdict.problems.join('; ').replace(/\|/g, '\\|').slice(0, 220) : ''}`).join('<br>'); }).join(' | ')} |`);
 await fs.writeFile(path.join(outDir, 'summary.md'), md.join('\n') + '\n');
 return md.slice(0, md.indexOf('## Per draft')).join('\n');
}

async function pool(items, n, fn) { let next = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } })); }

async function main() {
 if (opt.report) { const dir = path.resolve(opt.report), data = JSON.parse(await fs.readFile(path.join(dir, 'results.json'), 'utf8')); for (const v of data.variants) for (const c of data.cases) for (const x of runsOf(data, v, c.id)) x.verdict = verdict(x); console.log(await writeReport(dir, data)); return; }
 if (!opt.variants.length) die('Give at least one --variant (draft, or a variant name from a --from results.json).');
 const spec = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/enhance-outcome.cases.json'), 'utf8'));
 const compareCases = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/enhance-compare.cases.json'), 'utf8'));
 let cases = spec.cases.map(o => ({ ...compareCases.find(c => c.id === o.id), ...o })).filter(c => c.draft);
 if (opt.only) cases = cases.filter(c => opt.only.includes(c.id));
 if (!cases.length) die('No drafts selected.');
 const froms = []; for (const d of opt.from) froms.push(JSON.parse(await fs.readFile(path.join(path.resolve(d), 'results.json'), 'utf8')));
 const promptOf = (v, c) => { if (v === 'draft') return c.draft; for (const f of froms) { const x = f.results?.[v]?.[c.id]; if (x && !x.run.error && x.run.text) return x.run.text; } return null; };
 const outDir = path.resolve(opt.out || path.join(os.tmpdir(), 'omp-enhance-outcome', new Date().toISOString().replace(/[:.]/g, '-')));
 const work = path.join(os.tmpdir(), 'omp-enhance-outcome-work', path.basename(outDir));
 await fs.mkdir(outDir, { recursive: true });
 const overlay = path.join(outDir, 'agent-overlay.yml'); await fs.writeFile(overlay, AGENT_OVERLAY);
 const jdir = path.join(outDir, 'judge'); await fs.mkdir(jdir, { recursive: true }); await fs.writeFile(path.join(jdir, 'system.md'), JUDGE_SYSTEM);
 const reposRoot = path.resolve(ROOT, '..'), repoDir = r => path.join(reposRoot, r);
 const ompVersion = (await exec(OMP, [...OMP_PREFIX, '--version']).then(r => r.stdout.trim(), () => 'omp ?'));
 const prevs = []; for (const d of opt.reuse) prevs.push(JSON.parse(await fs.readFile(path.join(path.resolve(d), 'results.json'), 'utf8')));
 const data = { started: new Date().toISOString(), ompVersion, agentModel: opt.model || null, thinking: opt.thinking || null, samples: opt.samples, variants: opt.variants, cases, results: {}, baselines: {} };
 // Saves are serialized and atomic (temp file + rename): a killed run keeps its last complete results.json.
 let saving = Promise.resolve();
 const save = () => (saving = saving.then(async () => { const f = path.join(outDir, 'results.json'); await fs.writeFile(f + '.tmp', JSON.stringify(data, null, 1)); await fs.rename(f + '.tmp', f); }));
 const before = {}; for (const r of new Set(cases.map(c => c.repo))) before[r] = existsSync(path.join(repoDir(r), '.git')) ? (await exec('git', ['status', '--porcelain'], { cwd: repoDir(r) })).stdout : null;

 // Each repo's test command on an untouched workspace, once.
 for (const r of new Set(cases.map(c => c.repo))) {
  const rs = spec.repos[r] || {}; if (!rs.test) continue;
  const old = prevs.map(p => p.baselines?.[r]).find(Boolean);
  if (old) { data.baselines[r] = old; continue; }
  const dir = path.join(work, '_baseline', r); await makeWorkspace(repoDir(r), dir, rs.copy);
  console.log(`baseline tests ${r}…`); data.baselines[r] = await sh(rs.test, dir, CHECK_TIMEOUT_MS); console.log(`  exit ${data.baselines[r].code} in ${(data.baselines[r].ms / 1000).toFixed(0)}s`);
  if (!opt.keep) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
 }
 await save();

 // Agent runs are reused from --reuse dirs when the agent's input and setup match; their judge verdicts are redone
 // when the judge changed. The `ignore` globs of a repo drop test-run leftovers from the diff the judge sees.
 const judgeModel = opt.judgeModel || opt.model || null, JUDGE_KEY = sha(JUDGE_SYSTEM + (judgeModel || '') + 'medium');
 const jobs = [], rejudge = [];
 for (const c of cases) for (const v of opt.variants) {
  const prompt = promptOf(v, c); if (prompt == null) { console.log(`skip ${v}/${c.id}: no rewrite in --from results`); continue; }
  const rs = spec.repos[c.repo] || {};
  const key = sha(JSON.stringify([agentInput(c, prompt), opt.model || '', opt.thinking || '', AGENT_OVERLAY, c.checks || [], { test: rs.test, copy: rs.copy }]));
  const olds = prevs.flatMap(p => runsOf(p, v, c.id)).filter(o => o.key === key && !o.agent.error).slice(0, opt.samples);
  const slots = (data.results[v] ||= {})[c.id] = [];
  olds.forEach((o, s) => { slots[s] = o; if (o.judgeKey !== JUDGE_KEY || !o.judge || o.judge.error || o.note !== c.note) rejudge.push({ c, w: o }); });
  for (let s = olds.length; s < opt.samples; s++) jobs.push({ c, v, s, prompt, key });
 }
 console.log(`${jobs.length} agent runs and ${rejudge.length} re-judged (${opt.variants.join(', ')}) on ${cases.length} drafts → ${outDir}`);
 const judgeCfg = { overlay, system: path.join(jdir, 'system.md'), model: judgeModel, cwd: jdir };
 const judge = async (c, w) => { dropIgnored(w, (spec.repos[c.repo] || {}).ignore); w.judge = await askJudge(judgeInput(c, w), judgeCfg); w.judgeKey = JUDGE_KEY; w.note = c.note; w.verdict = verdict(w); };
 await pool(rejudge, opt.concurrency * 2, async ({ c, w }) => { await judge(c, w); await save(); });
 let n = 0;
 await pool(jobs, opt.concurrency, async ({ c, v, s, prompt, key }) => {
  const rs = spec.repos[c.repo] || {}, dir = path.join(work, v, s ? `${c.id}-s${s + 1}` : c.id);
  const w = { key, prompt };
  try {
   await makeWorkspace(repoDir(c.repo), dir, rs.copy);
   w.agent = await runAgent(dir, agentInput(c, prompt), { overlay, model: opt.model, thinking: opt.thinking });
   Object.assign(w, await diffOf(dir, rs.ignore));
   // Hidden checks: written after the agent finished, so it could not see or game them.
   w.checks = [];
   for (const k of c.checks || []) {
    for (const [rel, content] of Object.entries(k.files || {})) { await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fs.writeFile(path.join(dir, rel), content); }
    const res = await repoSh(c.repo, k.cmd, dir); w.checks.push({ name: k.name, pass: res.code === 0, out: tail(res.out, 60) });
    for (const rel of Object.keys(k.files || {})) await fs.rm(path.join(dir, rel), { force: true });
   }
   w.suiteBefore = data.baselines[c.repo] ? { code: data.baselines[c.repo].code, out: tail(data.baselines[c.repo].out, 60) } : null;
   if (rs.test) { const r = await repoSh(c.repo, rs.test, dir); w.suite = { code: r.code, out: tail(r.out, 60), ms: r.ms }; }
   await judge(c, w);
  } catch (e) { w.agent ||= { tools: [], answer: '', cost: 0, ms: 0 }; w.agent.error ||= `harness: ${e.message}`; w.diff ||= ''; w.judge ||= { error: 'not judged' }; w.verdict = verdict(w); }
  data.results[v][c.id][s] = w;
  console.log(`[${++n}/${jobs.length}] ${v} ${c.id}${opt.samples > 1 ? ` #${s + 1}` : ''}: ${w.verdict.success ? 'done right' : w.verdict.problems.join('; ').slice(0, 200)} · ${(w.agent.ms / 60000).toFixed(1)} min · $${w.agent.cost.toFixed(2)}`);
  await save();
  if (!opt.keep) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
 });
 data.readOnly = [];
 for (const [r, s] of Object.entries(before)) if (s != null && (await exec('git', ['status', '--porcelain'], { cwd: repoDir(r) })).stdout !== s) data.readOnly.push(`${r}: git status changed`);
 await save();
 console.log(await writeReport(outDir, data));
 console.log(`\n${path.join(outDir, 'summary.md')}`);
}
main().catch(e => die(e.stack || String(e)));
