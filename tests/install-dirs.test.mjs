import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join, sep } from 'node:path';
import { addInstallDirs } from '../companion/server.mjs';

// Drive letters can't appear in a POSIX PATH (its delimiter is ':'), so the folders hang off this system's root.
const root = process.platform === 'win32' ? 'C:\\' : '/', system = join(root, 'Windows');
const home = join(root, 'Users', 'me'), local = join(home, 'AppData', 'Local');
const ompDir = join(local, 'omp'), bunDir = join(home, '.bun', 'bin');

test('a PATH without the user entries gets the OMP and Bun install folders that exist', () => {
  const env = { Path: [system, join(system, 'system32')].join(delimiter) };
  assert.deepEqual(addInstallDirs(env, { home, localAppData: local, exists: () => true }), [ompDir, bunDir]);
  assert.equal(env.Path, [system, join(system, 'system32'), ompDir, bunDir].join(delimiter));
});

test('folders already on PATH (any case, trailing slash) or not installed are left out', () => {
  const env = { PATH: [ompDir.toUpperCase() + sep, system].join(delimiter) };
  const before = env.PATH;
  assert.deepEqual(addInstallDirs(env, { home, localAppData: local, exists: d => d !== bunDir }), []);
  assert.equal(env.PATH, before);
});
