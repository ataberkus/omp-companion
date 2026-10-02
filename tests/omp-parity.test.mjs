import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';

const { launchOptions, launchArgs, treeView, todoPhases } = internals;

test('launch options validate input and build --flag=value argv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-launch-'));
  try {
    assert.equal(await launchOptions(undefined), undefined);
    assert.equal(await launchOptions({ noLsp: false, tools: '' }), undefined);
    const o = await launchOptions({ approvalMode: 'write', noLsp: true, planYolo: true, planYoloInto: 'anthropic/claude-opus-5-5', prewalkInto: 'a/b', smol: ' x/y ', tools: 'read, bash', maxTime: '10m', addDirs: [dir], appendSystemPrompt: 'Be brief --yolo' });
    assert.deepEqual(launchArgs(o, true), ['--approval-mode=write', '--plan-yolo', '--no-lsp', '--smol=x/y', '--plan-yolo-into=anthropic/claude-opus-5-5', '--tools=read,bash', '--max-time=10m', `--add-dir=${o.addDirs[0]}`, '--append-system-prompt=Be brief --yolo']);
    // Plan-yolo only forces plan mode on a session's first launch; prewalk-into needs prewalk.
    assert.ok(!launchArgs(o, false).some(a => a.startsWith('--plan-yolo')));
    assert.ok(!launchArgs(o, true).some(a => a.startsWith('--prewalk')));
    for (const bad of [{ approvalMode: 'never' }, { noLsp: 'yes' }, { smol: '--yolo' }, { tools: 'read;rm' }, { maxTime: '5 minutes' }, { addDirs: ['relative/dir'] }, { systemPrompt: 'x'.repeat(8001) }, []])
      await assert.rejects(launchOptions(bad), undefined, JSON.stringify(bad));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('session tree keeps conversation nodes, indents at forks and marks the active path', () => {
  const msg = (id, parentId, role, text, children = [], label) => ({ entry: { id, parentId, type: 'message', message: { role, content: [{ type: 'text', text }] } }, children, label });
  const r = treeView({ leafId: 'a2', tree: [msg('u1', null, 'user', 'hi', [
    { entry: { id: 'm', parentId: 'u1', type: 'model_change' }, children: [msg('a1', 'm', 'assistant', 'first', [msg('u2', 'a1', 'user', 'left'), msg('u3', 'a1', 'user', 'right', [msg('a2', 'u3', 'assistant', 'done')], 'try 2')])] },
  ])] });
  assert.deepEqual(r.nodes.map(n => [n.id, n.depth, n.onPath, n.forks]), [['u1', 0, true, undefined], ['a1', 0, true, 2], ['u2', 1, false, undefined], ['u3', 1, true, undefined], ['a2', 1, true, undefined]]);
  assert.equal(r.nodes[3].label, 'try 2');
  assert.deepEqual(treeView(null), { leafId: null, nodes: [], truncated: false });
});

test('todo phases are validated before reaching OMP', () => {
  assert.deepEqual(todoPhases([{ name: 'P', tasks: [{ content: 'a', status: 'blocked', blocker: 'b', extra: 1 }] }]), [{ name: 'P', tasks: [{ content: 'a', status: 'blocked', blocker: 'b' }] }]);
  for (const bad of [null, [{ name: '', tasks: [] }], [{ name: 'P', tasks: [{ content: 'a', status: 'done' }] }], [{ name: 'P', tasks: [{ content: '', status: 'pending' }] }]])
    assert.throws(() => todoPhases(bad));
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-parity-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const nativeDir = join(dir, 'native'), log = join(dir, 'rpc.jsonl'), fake = join(dir, 'omp.mjs');
  await mkdir(join(nativeDir, 'proj'), { recursive: true });
  const other = join(nativeDir, 'proj', 'other.jsonl');
  await writeFile(other, [{ type: 'session', id: 'other', cwd: dir }, { type: 'title', title: 'Other work' }].map(l => JSON.stringify(l)).join('\n') + '\n');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const emit = f => process.stdout.write(JSON.stringify(f) + '\\n');
const reply = (c, data = {}) => emit({ type: 'response', id: c.id, command: c.type, success: true, data });
let todos = [], model = 'a', level = 'low';
emit({ type: 'ready' });
createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(c) + '\\n');
  if (c.type === 'get_state') return reply(c, { model: { provider: 'test', id: model }, thinkingLevel: level, todoPhases: todos, isSettled: true });
  if (c.type === 'get_subagents') return reply(c, { subagents: [] });
  if (c.type === 'get_tree') return reply(c, { leafId: 'a', tree: [{ entry: { id: 'u', type: 'message', message: { role: 'user', content: 'hello' } }, children: [{ entry: { id: 'a', parentId: 'u', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }, children: [] }] }] });
  if (c.type === 'get_last_assistant_text') return reply(c, { text: 'last words' });
  if (c.type === 'set_todos') { todos = c.phases; return reply(c, { todoPhases: todos }); }
  if (c.type === 'cycle_model') { model = 'b'; return reply(c, { model: { provider: 'test', id: model }, thinkingLevel: 'high', isScoped: true }); }
  if (c.type === 'cycle_thinking_level') return reply(c, null);
  if (c.type === 'new_session' || c.type === 'switch_session') { todos = []; return reply(c, { cancelled: false }); }
  if (c.type === 'prompt') { emit({ type: 'agent_start' }); return reply(c); }
  if (c.type === 'abort_and_prompt') { emit({ type: 'agent_start' }); return reply(c); }
  reply(c);
});
`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], activity: [], sessions: [{ id: 'session', title: 'Parity', cwd: dir, native: false, status: 'paused', model: 'OMP default', messages: [], todos: [], createdAt: at, updatedAt: at }] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: nativeDir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (route, body) => {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return [res.status, await res.json()];
  };
  return { dir, other, app, session: () => app.store.sessions[0], command: body => request('/sessions/session/command', body), request, sent: async () => (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l)) };
}

test('session RPC parity: tree, last reply, todos, cycling, new and switched sessions', async t => {
  const f = await fixture(t);
  const [, tree] = await f.command({ type: 'tree' });
  assert.deepEqual(tree.nodes.map(n => [n.kind, n.text, n.onPath]), [['user', 'hello', true], ['assistant', 'hi', true]]);
  assert.deepEqual((await f.command({ type: 'last_reply' }))[1], { text: 'last words' });

  const phases = [{ name: 'Work', tasks: [{ content: 'Ship it', status: 'in_progress' }] }];
  const [, withTodos] = await f.command({ type: 'todos', phases });
  assert.deepEqual(withTodos.todos, phases);
  assert.equal((await f.command({ type: 'todos', phases: [{ name: 'W', tasks: [{ content: 'x', status: 'nope' }] }] }))[0], 400);

  const [, cycled] = await f.command({ type: 'cycle_model' });
  assert.equal(cycled.modelSelector, 'test/b');
  assert.equal(cycled.thinkingChoice, 'high');
  assert.equal((await f.command({ type: 'cycle_thinking' }))[0], 400, 'A model without thinking levels reports why nothing changed');

  assert.equal((await f.command({ type: 'new_session' }))[0], 200);
  assert.equal(f.session().todos.length, 0);
  assert.equal((await f.command({ type: 'switch_session', file: join(f.dir, 'elsewhere.jsonl') }))[0], 400, 'Only files from the OMP session store are accepted');
  const [status, switched] = await f.command({ type: 'switch_session', file: f.other });
  assert.equal(status, 200);
  assert.equal(switched.title, 'Other work');
  const sent = await f.sent();
  assert.ok(sent.some(c => c.type === 'new_session'));
  assert.ok(sent.some(c => c.type === 'switch_session' && c.sessionPath === f.other));
});

test('launch options are stored per session and rejected while work is running; stop & send uses abort_and_prompt', async t => {
  const f = await fixture(t);
  assert.equal((await f.command({ type: 'launch', launch: { approvalMode: 'sometimes' } }))[0], 400);
  const [, launched] = await f.command({ type: 'launch', launch: { approvalMode: 'yolo', noLsp: true } });
  assert.deepEqual(launched.launch, { approvalMode: 'yolo', noLsp: true });
  assert.ok(launched.messages.some(m => m.role === 'system' && /Launch options updated/.test(m.text)));

  await f.command({ type: 'prompt', message: 'First task' });
  assert.equal(f.session().status, 'running');
  assert.equal((await f.command({ type: 'launch', launch: {} }))[0], 400);
  assert.equal((await f.command({ type: 'interrupt', message: '/compact' }))[0], 400, 'Slash commands cannot replace a running turn');
  const [, interrupted] = await f.command({ type: 'interrupt', message: 'Do this instead' });
  assert.equal(interrupted.status, 'running');
  assert.ok((await f.sent()).some(c => c.type === 'abort_and_prompt' && c.message === 'Do this instead'));
  assert.ok(interrupted.messages.some(m => m.role === 'user' && m.text === 'Do this instead'));
});

test('Tools page runs validated OMP CLI commands as background jobs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-cli-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  // ompBin() is `node`, so the first CLI arg names a script resolved against the job's cwd.
  const echo = `console.log(JSON.stringify(process.argv.slice(2)));`;
  for (const name of ['stats', 'commit', 'gc']) await writeFile(join(dir, name), echo);
  await writeFile(join(dir, 'ps'), 'setTimeout(() => {}, 60000);');
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (route, body) => {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return [res.status, await res.json()];
  };
  const finished = async id => {
    for (let i = 0; i < 200; i++) { const job = (await request('/cli'))[1].jobs.find(j => j.id === id); if (job.status !== 'running') return job; await new Promise(r => setTimeout(r, 25)); }
    throw new Error('job did not finish');
  };

  const [, catalog] = await request('/cli');
  assert.ok(catalog.tools.commit.actions.run.fields.some(x => x.name === 'dryRun'));
  assert.equal(catalog.tools.agents.actions.unpack.fields[0].arg, undefined, 'argv details stay on the server');

  const [code, job] = await request('/cli', { tool: 'stats', action: 'summary' });
  assert.equal(code, 202);
  assert.deepEqual(JSON.parse((await finished(job.id)).output), ['--summary']);

  const [, commit] = await request('/cli', { tool: 'commit', action: 'run', cwd: dir, values: { dryRun: true, context: 'why --push', model: 'test/m' } });
  const done = await finished(commit.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(JSON.parse(done.output), ['--dry-run', '--context=why --push', '--model=test/m']);

  const [, gc] = await request('/cli', { tool: 'gc', action: 'run', values: { days: 30, apply: false } });
  assert.deepEqual(JSON.parse((await finished(gc.id)).output), ['--cold-archive-after-days=30']);

  for (const bad of [
    { tool: 'nope', action: 'x' },
    { tool: 'stats', action: 'toString' },
    { tool: 'commit', action: 'run' },
    { tool: 'commit', action: 'run', cwd: dir, values: { model: '--yolo' } },
    { tool: 'gc', action: 'run', values: { days: -1 } },
    { tool: 'gc', action: 'run', values: { apply: 'yes' } },
    { tool: 'ps', action: 'info', values: { name: '--all' } },
    { tool: 'ps', action: 'info', values: {} },
    { tool: 'ssh', action: 'add', values: { name: 'a;b', host: 'h' } },
    { tool: 'setup', action: 'check', values: { component: 'rust' } },
    { tool: 'share', action: 'share', values: { session: join(dir, 'x.jsonl') } },
  ]) assert.equal((await request('/cli', bad))[0], 400, JSON.stringify(bad));

  const [, slow] = await request('/cli', { tool: 'ps', action: 'list' });
  assert.equal(slow.status, 'running');
  await request('/cli/stop', { id: slow.id });
  const stopped = await finished(slow.id);
  assert.equal(stopped.status, 'error');
  assert.match(stopped.output, /Stopped/);
  assert.equal((await request('/cli/stop', { id: 'missing' }))[0], 404);
});
