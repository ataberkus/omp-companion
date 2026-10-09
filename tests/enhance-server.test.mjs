import { test } from 'node:test';
import assert from 'node:assert/strict';
import { internals } from '../companion/server.mjs';

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
