import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { addInstallDirs } from '../companion/server.mjs';

const home = join('C:', 'Users', 'me'), local = join(home, 'AppData', 'Local');
const ompDir = join(local, 'omp'), bunDir = join(home, '.bun', 'bin');

test('a PATH without the user entries gets the OMP and Bun install folders that exist', () => {
  const env = { Path: ['C:\\Windows', 'C:\\Windows\\system32'].join(delimiter) };
  assert.deepEqual(addInstallDirs(env, { home, localAppData: local, exists: () => true }), [ompDir, bunDir]);
  assert.equal(env.Path, ['C:\\Windows', 'C:\\Windows\\system32', ompDir, bunDir].join(delimiter));
});

test('folders already on PATH (any case, trailing slash) or not installed are left out', () => {
  const env = { PATH: [ompDir.toUpperCase() + '\\', 'C:\\Windows'].join(delimiter) };
  const before = env.PATH;
  assert.deepEqual(addInstallDirs(env, { home, localAppData: local, exists: d => d !== bunDir }), []);
  assert.equal(env.PATH, before);
});
