import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { maskArgs, maskUrl, serverView } from '../companion/mcp-config.mjs';
import { fakeOmp } from './fake-omp.mjs';

async function boot(t, mcp) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-mcp-'));
  const omp = Object.assign(fakeOmp(), mcp);
  const app = await createCompanion({ dataDir: dir, ompSessionsDir: dir, ompCommand: process.execPath, omp });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  return { dir, call };
}

test('MCP servers are listed per scope and toggled in the scope they come from', async t => {
  const scopes = [], toggles = [];
  const { dir, call } = await boot(t, {
    async mcpServers(s) { scopes.push(s); return { servers: [], userFile: 'u/mcp.json', projectConfig: true, warnings: [] }; },
    async setMcpEnabled(o) { toggles.push(o); if (o.name === 'ghost') throw Object.assign(new Error('MCP server "ghost" is not configured.'), { status: 404 }); },
  });
  const proj = join(dir, 'proj'), hidden = join(dir, 'hidden');
  await mkdir(proj); await mkdir(hidden);
  const [, p] = await call('/projects', { path: proj });
  const [, h] = await call('/projects', { path: hidden });
  await call('/projects/update', { id: h.id, hidden: true });

  const [status, empty] = await call('/mcp');
  assert.equal(status, 200);
  assert.deepEqual(empty.servers, []);
  // User configs once from home, then each visible project's own configs; hidden projects are left out.
  assert.deepEqual(scopes.at(-1), [{ cwd: homedir() }, { cwd: proj, project: { id: p.id, name: 'proj', path: proj } }]);

  assert.equal((await call('/mcp', { action: 'disable', name: 'alpha' }))[0], 200);
  assert.equal((await call('/mcp', { action: 'enable', name: 'gamma', project: p.id }))[0], 200);
  assert.deepEqual(toggles, [
    { cwd: homedir(), project: false, name: 'alpha', enabled: false },
    { cwd: proj, project: true, name: 'gamma', enabled: true },
  ]);
  assert.equal((await call('/mcp', { action: 'disable', name: 'ghost' }))[0], 404);
  assert.equal((await call('/mcp', { action: 'disable', name: 'gamma', project: h.id }))[0], 404);
  assert.equal((await call('/mcp', { action: 'remove', name: 'gamma' }))[0], 400);
  assert.equal((await call('/mcp', { action: 'enable' }))[0], 400);
  assert.equal(toggles.length, 3);
});

test('an unreadable MCP config is a 502 in the OMP read-error style', async t => {
  const { call } = await boot(t, { async mcpServers() { throw new Error("JSON Parse error: Expected '}'"); } });
  const [status, body] = await call('/mcp');
  assert.equal(status, 502);
  assert.equal(body.error, "Could not read OMP MCP servers: JSON Parse error: Expected '}'");
});

test('MCP server views never carry secret values', () => {
  assert.equal(maskUrl('https://user:pw@example.com/mcp?key=abc&x=1'), 'https://•••@example.com/mcp?key=•••&x=•••');
  assert.deepEqual(maskArgs(['srv.js', '--api-key', 'k1', '--token=k2', '--port', '80', 'https://h/x?t=k3']), ['srv.js', '--api-key', '•••', '--token=•••', '--port', '80', 'https://h/x?t=•••']);
  const gates = { isProviderEnabled: () => true, isUserSourceEnabled: () => true };
  const ctx = { denied: new Set(), forced: new Set(), disabledIds: [], projectConfig: true, gates };
  const v = serverView({ name: 'a', command: 'node', env: { GH_TOKEN: 's1' }, headers: { Authorization: 's2' }, _source: { provider: 'native', path: 'p', level: 'user' } }, ctx);
  assert.deepEqual([v.env, v.headers, v.writable, v.state, v.enabled], [['GH_TOKEN'], ['Authorization'], true, 'active', true]);
  assert.ok(!JSON.stringify(v).includes('s1') && !JSON.stringify(v).includes('s2'));
});

test('MCP server state follows OMP: denylist beats allowlist, allowlist beats enabled: false', () => {
  const gates = { isProviderEnabled: () => true, isUserSourceEnabled: () => true };
  const src = { provider: 'claude', providerName: 'Claude Code', path: 'c.json', level: 'user' };
  const view = (s, o = {}) => serverView({ _source: src, command: 'x', ...s }, { denied: new Set(), forced: new Set(), disabledIds: [], projectConfig: true, gates, ...o });
  assert.equal(view({ name: 'a', enabled: false }).enabled, false);
  assert.equal(view({ name: 'a', enabled: false }, { forced: new Set(['a']) }).enabled, true);
  assert.equal(view({ name: 'a' }, { denied: new Set(['a']), forced: new Set(['a']) }).enabled, false);
  assert.equal(view({ name: 'a' }).writable, false);
  // Switched on but its source is not loaded: shown as on, but not active.
  const off = view({ name: 'a' }, { gates: { isProviderEnabled: () => true, isUserSourceEnabled: () => false } });
  assert.deepEqual([off.enabled, off.state], [true, 'disabled']);
  const proj = serverView({ name: 'p', command: 'x', _source: { provider: 'mcp-json', path: '.mcp.json', level: 'project' } }, { denied: new Set(), forced: new Set(), disabledIds: [], projectConfig: false, gates });
  assert.deepEqual([proj.enabled, proj.state, proj.writable], [true, 'disabled', true]);
});
