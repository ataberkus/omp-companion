import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettings } from '../companion/settings.mjs';
import { sdkDrift } from '../companion/omp-sdk.mjs';

// The picker's list comes from the CLI (`omp models --json`); sessions run the SDK this process loaded. A CLI updated
// since the companion started offers models that SDK does not know, and picking one failed with "Model not found".
const cli = { models: [
  { provider: 'antigravity-cli', id: 'gemini-4-neon', kind: 'chat' },
  { provider: 'antigravity-cli', id: 'gemini-4-hydrogen', kind: 'chat' },
  { provider: 'google', id: 'imagine', kind: 'image' },
] };

async function settings(t, sdkModels) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-model-list-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  const calls = [];
  const api = createSettings({
    dataDir: dir, ompEntry: join(dir, 'no-such-omp'), ompSource: false, canRestart: false,
    execOmp: async args => { calls.push(args); return { stdout: JSON.stringify(cli) }; },
    omp: sdkModels === undefined ? {} : { sdkModels },
  });
  return { api, calls };
}

test('the model list keeps only models the loaded OMP SDK runs', async t => {
  const { api } = await settings(t, async () => ['antigravity-cli/gemini-4-hydrogen']);
  const list = await api.listModels();
  // The newer CLI's model the SDK lacks is gone; the image model was never listed.
  assert.deepEqual(list.models.map(m => m.selector), ['antigravity-cli/gemini-4-hydrogen']);
});

test('without an SDK list (Node runtime, or OMP not loaded yet) the CLI list stands', async t => {
  for (const sdkModels of [undefined, async () => null, async () => [], async () => { throw new Error('not loaded'); }]) {
    const { api } = await settings(t, sdkModels);
    assert.deepEqual((await api.listModels()).models.map(m => m.selector), ['antigravity-cli/gemini-4-neon', 'antigravity-cli/gemini-4-hydrogen']);
  }
});

test('an update the companion missed is installed and restarted into; a copy that failed to load is not retried', () => {
  // The CLI moved on (`omp update` in a terminal) while this process kept the SDK it loaded.
  assert.equal(sdkDrift('19.0.1', '19.0.0', undefined), true);
  assert.equal(sdkDrift('19.0.0', '19.0.0', undefined), false, 'same release: nothing to do');
  assert.equal(sdkDrift('18.9.0', '19.0.0', undefined), false, 'an older CLI: sessions already run its successor');
  // That copy could not load in this process (omp.mjs remembers it): restarting again would loop.
  assert.equal(sdkDrift('19.0.1', '19.0.0', '19.0.1'), false);
  // Not plain semver (a prerelease, a checkout): never treated as newer.
  assert.equal(sdkDrift('19.0.1-beta.2', '19.0.0', undefined), false);
  assert.equal(sdkDrift(undefined, '19.0.0', undefined), false);
  assert.equal(sdkDrift('19.0.1', undefined, undefined), false);
});
