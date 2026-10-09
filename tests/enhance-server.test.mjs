import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const exists = p => readFile(p).then(() => true, () => false);
const ompPids = async dir => (await readdir(dir)).filter(f => f.startsWith('omp-pid-')).map(f => Number(f.slice(8)));

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e1YAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Fake enhancer: records argv/stdin/pid, then behaves by the draft: HANG never exits, EMPTY answers nothing,
// anything else reads one file and answers "ENHANCED <first draft line>" inside a code fence.
const FAKE_ENHANCER = dir => `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = ${JSON.stringify(dir)};
writeFileSync(join(out, 'pid-' + process.pid), '');
writeFileSync(join(out, 'argv.json'), JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  writeFileSync(join(out, 'stdin.txt'), input, 'utf8');
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  if (input.includes('HANG')) { setInterval(() => {}, 1e9); return; }
  emit({ type: 'session', cwd: process.cwd() });
  if (input.includes('EMPTY')) return;
  emit({ type: 'tool_execution_start', toolName: 'read', args: { path: join(process.cwd(), 'src', 'a.js') } });
  const draft = input.split('<draft>\\n')[1].split('\\n')[0];
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '\`\`\`\\nENHANCED ' + draft + '\\n\`\`\`' }] } });
});`;

// Fake OMP session runner: records its pid; `prompt` drops a marker, then answers after 300 ms;
// get_state reports a session file that holds only a header (no user message).
const FAKE_OMP = (dir, { fail = false } = {}) => fail ? 'process.exit(1);' : `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = ${JSON.stringify(dir)};
writeFileSync(join(out, 'omp-pid-' + process.pid), '');
const file = join(out, 'native-' + process.pid + '.jsonl');
writeFileSync(file, JSON.stringify({ type: 'session', cwd: process.cwd(), id: 'x' }) + '\\n');
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
send({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'prompt') { writeFileSync(join(out, 'prompt-seen'), ''); setTimeout(() => send({ type: 'response', id: c.id, success: true, command: c.type, data: { agentInvoked: false } }), 300); continue; }
  const data = c.type === 'get_state' ? { todoPhases: [], sessionFile: file } : c.type === 'get_subagents' ? { subagents: [] } : {};
  send({ type: 'response', id: c.id, success: true, command: c.type, data });
}`;

async function boot(t, { config = '', omp = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-enhance-'));
  const state = { app: null, base: '' };
  t.after(async () => { if (state.app) await state.app.close(); await rm(dir, { recursive: true, force: true }); });
  // Role lookup reads <agent dir>/config.yml: point it at this test's own copy, never the developer's.
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  await mkdir(join(dir, 'agent'), { recursive: true });
  await writeFile(join(dir, 'agent', 'config.yml'), config);
  const enh = join(dir, 'enh.mjs'), fakeOmp = join(dir, 'omp.mjs');
  await writeFile(enh, FAKE_ENHANCER(dir));
  await writeFile(fakeOmp, FAKE_OMP(dir, omp));
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [{ id: 'm1', role: 'user', text: 'earlier question', at: now }], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  const start = async () => {
    state.app = await createCompanion({ dataDir: dir, ompSessionsDir: dir, ompCommand: process.execPath, ompArgs: [fakeOmp], enhancePrefix: [enh] });
    state.app.server.listen(0, '127.0.0.1');
    await once(state.app.server, 'listening');
    state.base = `http://127.0.0.1:${state.app.server.address().port}/api`;
  };
  await start();
  const restart = async () => { await state.app.close(); await start(); };
  const call = async (path, body) => {
    const res = await fetch(state.base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const settle = async id => { for (let i = 0; i < 100; i++) { const r = await call('/enhance?id=' + id); if (r.body.status !== 'running') return r.body; await sleep(50); } throw new Error('enhance never finished'); };
  return { dir, state, call, settle, restart };
}

test('enhance model resolution order', () => {
  const { enhanceModel } = internals;
  assert.deepEqual(enhanceModel({ enhance: 'x/y:low', default: 'a/b' }, 'p/m'), { model: '@enhance', thinking: null, label: 'x/y:low' });
  assert.deepEqual(enhanceModel({ default: 'a/b' }, 'p/m'), { model: 'p/m', thinking: 'low', label: 'p/m' });
  assert.deepEqual(enhanceModel({ default: 'a/b' }, ''), { model: null, thinking: null, label: 'a/b' });
  assert.deepEqual(enhanceModel({}, ''), { model: null, thinking: null, label: 'OMP default' });
});

test('enhancer argv is fixed, read-only, and never carries the draft', () => {
  const a = internals.enhanceArgs({ model: '@enhance', thinking: null, overlay: 'O.yml', system: 'S.md', images: ['C:\\d i r\\image-1.png'] });
  assert.deepEqual(a.slice(0, 11), ['-p', '--mode', 'json', '--no-session', '--no-title', '--no-skills', '--no-extensions', '--no-lsp', '--tools=read,grep,glob', '--approval-mode=always-ask', '--max-time=120']);
  assert.ok(a.includes('--config=O.yml') && a.includes('--model=@enhance') && a.includes('--append-system-prompt=S.md'));
  assert.ok(!a.some(x => x.startsWith('--thinking')));
  assert.equal(a.at(-1), '@C:\\d i r\\image-1.png');
  const b = internals.enhanceArgs({ model: null, thinking: null, overlay: 'O.yml', system: 'S.md', images: [] });
  assert.ok(!b.some(x => x.startsWith('--model')));
  assert.ok(internals.enhanceArgs({ model: 'p/m', thinking: 'low', overlay: 'O', system: 'S', images: [] }).includes('--thinking=low'));
});

test('conversation tail keeps the last 6 user/assistant turns, truncated', () => {
  const msgs = [...Array(8)].map((_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: String(i).repeat(2000) })).concat({ role: 'tool', text: 'T' });
  const s = internals.enhanceInput('fix it', msgs);
  assert.match(s, /^<conversation>\nUser: 2{1500}\n/);
  assert.ok(!s.includes('T\n') && !s.includes('User: 0'));
  assert.ok(s.endsWith('<draft>\nfix it\n</draft>'));
  assert.equal(internals.enhanceInput('x', []), '<draft>\nx\n</draft>');
});

test('step labels and result cleanup', () => {
  assert.equal(internals.stepLabel('read', { path: '/p/src/a.js' }, '/p'), 'reading src/a.js');
  assert.equal(internals.stepLabel('grep', { pattern: 'foo' }, '/p'), 'searching "foo"');
  assert.equal(internals.stepLabel('glob', { pattern: '**/*.ts' }, '/p'), 'listing **/*.ts');
  assert.equal(internals.stepLabel('read', { path: '/p/' + 'x'.repeat(200) }, '/p').length, 80);
  assert.equal(internals.cleanEnhanced('```md\nDo X\n```'), 'Do X');
  assert.equal(internals.cleanEnhanced('```\n```'), '');
  assert.equal(internals.cleanEnhanced('  Do `x` here \n'), 'Do `x` here');
});

test('lockdown overlay pins every write-capable feature off and stops MCP discovery', () => {
  const o = internals.ENHANCE_OVERLAY;
  for (const line of ['tools:\n  xdev: false', 'advisor:\n  enabled: false', 'autolearn:\n  enabled: false\n  autoContinue: false', 'experimentalContextManagement: false', 'backend: "off"', 'checkpoint:\n  enabled: false', 'todo:\n  enabled: false', 'ask:\n  enabled: false', 'disabledProviders:\n  - native\n  - mcp-json']) assert.ok(o.includes(line), line);
});

test('stdin round trip: draft and images reach the enhancer, never argv', async t => {
  const { dir, call, settle } = await boot(t);
  const draft = 'fix "it" --model=x @evil\nğüşıöç 🚀';
  const start = await call('/enhance', { session: 'session', text: draft, images: [image] });
  assert.equal(start.status, 202);
  assert.equal(start.body.model, 'OMP default');
  const job = await settle(start.body.id);
  assert.equal(job.status, 'done');
  assert.equal(job.text, 'ENHANCED fix "it" --model=x @evil');
  assert.equal(job.step, 'reading src/a.js');
  const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8'));
  assert.ok(!argv.some(a => a.includes('fix "it"') || a.includes('ğüş')));
  assert.match(argv.at(-1), /^@.*enhance[\\/][^\\/]+[\\/]image-1\.png$/);
  assert.ok(argv.includes('--config=' + join(dir, 'enhance-overlay.yml')));
  const stdin = await readFile(join(dir, 'stdin.txt'), 'utf8');
  assert.match(stdin, /^<conversation>\nUser: earlier question\n<\/conversation>\n/);
  assert.ok(stdin.endsWith('<draft>\nfix "it" --model=x @evil\nğüşıöç 🚀\n</draft>'));
  assert.equal((await call('/enhance?id=' + start.body.id)).status, 404); // read once, then dropped
  assert.deepEqual(await readdir(join(dir, 'enhance')).catch(() => []), []); // images removed
});

test('empty result is an error, not a blank draft', async t => {
  const { call, settle } = await boot(t);
  const { body } = await call('/enhance', { session: 'session', text: 'EMPTY' });
  const job = await settle(body.id);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'The enhancer returned no text.');
});

test('requests need exactly one target and a real session', async t => {
  const { dir, call } = await boot(t);
  assert.equal((await call('/enhance', { text: 'x' })).status, 400);
  assert.equal((await call('/enhance', { text: 'x', session: 'session', path: dir })).status, 400);
  assert.equal((await call('/enhance', { text: 'x', session: 'nope' })).status, 404);
  assert.equal((await call('/enhance', { text: '   ', session: 'session' })).status, 400);
});

test('stop cancels, cap is 3, close cleans up', async t => {
  const { dir, state, call, settle } = await boot(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await call('/enhance', { session: 'session', text: 'HANG', images: [image] })).body.id);
  const fourth = await call('/enhance', { session: 'session', text: 'HANG' });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error, 'Wait for the running enhance to finish.');
  for (let i = 0; i < 100 && (await readdir(dir)).filter(f => f.startsWith('pid-')).length < 3; i++) await sleep(50);
  assert.equal((await call('/enhance/stop', { id: ids[0] })).status, 200);
  assert.equal((await settle(ids[0])).status, 'cancelled');
  const pids = (await readdir(dir)).filter(f => f.startsWith('pid-')).map(f => Number(f.slice(4)));
  assert.equal(pids.length, 3);
  await state.app.close(); state.app = null;
  assert.deepEqual(pids.filter(alive), []);
  assert.deepEqual(await readdir(join(dir, 'enhance')).catch(() => []), []);
});

test('a configured enhance role is used and reported', async t => {
  const { dir, call, settle } = await boot(t, { config: 'modelRoles:\n  default: a/b\n  enhance: fast/model:low\n' });
  const { body } = await call('/enhance', { session: 'session', text: 'go' });
  assert.equal(body.model, 'fast/model:low');
  await settle(body.id);
  const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--model=@enhance') && !argv.some(a => a.startsWith('--thinking')));
});

test('discard sent while the first prompt holds the lock keeps the session', async t => {
  const { dir, call } = await boot(t);
  const { body: s } = await call('/quick-start', { path: dir, draft: true });
  assert.equal(s.draft, true);
  await call('/commands?session=' + s.id); // starts OMP
  const sending = call(`/sessions/${s.id}/command`, { type: 'prompt', message: 'hi' });
  for (let i = 0; i < 100 && !(await exists(join(dir, 'prompt-seen'))); i++) await sleep(20);
  const [r1, r2] = await Promise.all([sending, call(`/sessions/${s.id}/command`, { type: 'discard' })]);
  assert.equal(r1.status, 200);
  assert.deepEqual(r2.body, { discarded: false });
  const kept = (await call('/state')).body.sessions.find(x => x.id === s.id);
  assert.ok(kept && !kept.draft && kept.messages.some(m => m.role === 'user'));
});

test('lone discard removes the session, its empty session file and only after OMP exited', async t => {
  const { dir, call } = await boot(t);
  const { body: s } = await call('/quick-start', { path: dir, draft: true });
  await call('/commands?session=' + s.id);
  const [pid] = await ompPids(dir);
  const file = join(dir, `native-${pid}.jsonl`);
  assert.ok(await exists(file));
  assert.deepEqual((await call(`/sessions/${s.id}/command`, { type: 'discard' })).body, { discarded: true });
  assert.equal(alive(pid), false, 'OMP process had exited before discard answered');
  assert.equal(await exists(file), false);
  assert.equal((await call('/state')).body.sessions.some(x => x.id === s.id), false);
  // Normal sessions are never discarded.
  assert.deepEqual((await call('/sessions/session/command', { type: 'discard' })).body, { discarded: false });
});

test('isolated draft: worktree and branch removed; leftover drafts cleaned on startup', async t => {
  const { dir, call, restart } = await boot(t);
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const git = (...a) => exec('git', ['-C', repo, ...a]);
  await git('init', '-q'); await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const { body: s } = await call('/quick-start', { path: repo, isolate: true, draft: true });
  assert.match(s.branch, /^omp-web\//);
  await call('/commands?session=' + s.id);
  assert.deepEqual((await call(`/sessions/${s.id}/command`, { type: 'discard' })).body, { discarded: true });
  assert.ok(!(await git('worktree', 'list')).stdout.includes(s.id));
  assert.ok(!(await git('branch')).stdout.includes('omp-web/'));
  // A draft left behind by a closed tab or crash is removed on the next start, worktree included.
  const { body: left } = await call('/quick-start', { path: repo, isolate: true, draft: true });
  await restart();
  assert.equal((await call('/state')).body.sessions.some(x => x.id === left.id), false);
  assert.ok(!(await git('worktree', 'list')).stdout.includes(left.id));
  assert.ok(!(await git('branch')).stdout.includes('omp-web/'));
});

test('a first send that fails before recording a message restores the draft marker', async t => {
  const { dir, call } = await boot(t, { omp: { fail: true } });
  const { body: s } = await call('/quick-start', { path: dir, draft: true });
  const sent = await call(`/sessions/${s.id}/command`, { type: 'prompt', message: 'hi' });
  assert.equal(sent.body.status, 'error');
  const after = (await call('/state')).body.sessions.find(x => x.id === s.id);
  assert.equal(after.draft, true);
  assert.ok(!after.messages.some(m => m.role === 'user'));
  assert.deepEqual((await call(`/sessions/${s.id}/command`, { type: 'discard' })).body, { discarded: true });
});
