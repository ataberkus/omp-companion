import { test } from 'node:test';
import assert from 'node:assert/strict';
import { antigravityLimitRows, addAntigravityCliUsage, parseAntigravityAccounts, antigravityCliToken } from '../companion/antigravity-usage.mjs';
import { modelUsage } from '../companion/session-views.mjs';

const WEEKLY = '2026-11-26T10:26:51Z', FIVE_HOURS = '2026-11-19T15:26:51Z', GEMINI = '2026-11-19T15:02:46Z';
const summary = { groups: [{ displayName: 'Claude and GPT models', buckets: [
  { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: WEEKLY, remainingFraction: 0.47 },
  { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: FIVE_HOURS, remainingFraction: 1 },
] }] };
const quota = { buckets: [
  { modelId: 'claude-opus-5-5-high', remainingFraction: 1, resetTime: FIVE_HOURS },
  { modelId: 'gemini-2.5-flash', remainingFraction: 0.9529724, resetTime: GEMINI },
  { modelId: 'gemini-3-flash', remainingFraction: 0.9529724, resetTime: GEMINI },
  { modelId: 'tab_flash_lite_preview', remainingFraction: 1 },
] };

test('Antigravity quota rows keep the shared weekly/5-hour limits and group Gemini models', () => {
  const rows = antigravityLimitRows(summary, quota);
  assert.deepEqual(rows.map(r => r.label), ['Claude & GPT (shared)', 'Claude & GPT (shared)', 'Gemini models (2)']);
  const [weekly, fiveHour, gemini] = rows;
  assert.equal(weekly.window.id, 'weekly');
  assert.equal(weekly.window.resetsAt, Date.parse(WEEKLY));
  assert.equal(weekly.amount.remainingFraction, 0.47);
  assert.equal(weekly.amount.usedFraction, 0.53);
  assert.equal(weekly.amount.remaining, 47);
  assert.equal(weekly.status, 'ok');
  assert.equal(fiveHour.window.id, '5h');
  assert.equal(fiveHour.window.resetsAt, Date.parse(FIVE_HOURS));
  assert.equal(gemini.window.resetsAt, Date.parse(GEMINI));
  assert.equal(gemini.amount.remainingFraction, 0.9529724);
  assert.ok(Math.abs(gemini.amount.usedFraction - 0.0470276) < 1e-9);
  // Claude/GPT is reported by the summary; the per-model quota must not add a second row for it.
  assert.ok(!rows.some(r => r.id.includes('model:3p')));
  // IDE tab-completion quota is not a chat model.
  assert.ok(!rows.some(r => r.label.includes('Tab')));
});

test('OMP account listing and token output are read without OAuth client credentials', () => {
  assert.deepEqual(parseAntigravityAccounts('1. user@example.com\n2. other@example.com\nnot an account\n1. user@example.com\n'), [
    { index: 1, identity: 'user@example.com' },
    { index: 2, identity: 'other@example.com' },
  ]);
  assert.equal(antigravityCliToken('ya29.token\n'), 'ya29.token');
  assert.equal(antigravityCliToken('{"access_token":"ya29.json"}'), 'ya29.json');
  assert.throws(() => antigravityCliToken(''));
  assert.throws(() => antigravityCliToken('warning\nmore'));
});

test('Antigravity usage asks OMP for the token and merges the quota before modelUsage', async () => {
  const calls = [];
  const execOmp = async (args, opts) => {
    calls.push({ args, opts });
    if (args.includes('--list')) return { stdout: '1. user@example.com\n' };
    if (args.includes('--account')) return { stdout: 'fresh\n' };
    throw new Error('unexpected ' + args.join(' '));
  };
  const fetches = [];
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init });
    if (url.endsWith('/v1internal:retrieveUserQuotaSummary')) return { ok: true, status: 200, json: async () => summary };
    if (url.endsWith('/v1internal:retrieveUserQuota')) return { ok: true, status: 200, json: async () => quota };
    throw new Error('unexpected ' + url);
  };
  const data = { reports: [{ provider: 'alpha', limits: [] }] };
  await addAntigravityCliUsage(data, { execOmp, fetchImpl, now: Date.now() + 10 * 60_000 });
  assert.deepEqual(data.reports.map(r => r.provider), ['alpha', 'antigravity-cli']);
  const report = data.reports[1];
  assert.equal(report.notes, undefined);
  assert.equal(report.metadata.email, 'user@example.com');
  assert.equal(report.metadata.projectId, 'default-cli-project');
  assert.deepEqual(report.limits.map(l => l.label), ['Claude & GPT (shared)', 'Claude & GPT (shared)', 'Gemini models (2)']);
  assert.deepEqual(calls.map(c => c.args), [
    ['token', 'antigravity-cli', '--list'],
    ['token', 'antigravity-cli', '--account', '1'],
  ]);
  const quotaCall = fetches.find(c => c.url.endsWith('/v1internal:retrieveUserQuota'));
  assert.equal(quotaCall.init.headers.Authorization, 'Bearer fresh');
  assert.equal(JSON.parse(quotaCall.init.body).project, 'default-cli-project');
  // OMP owns the refresh: no OAuth token endpoint and no client credentials are involved here.
  assert.ok(!fetches.some(c => c.url.includes('oauth2.googleapis.com')));
});

test('An unreadable Antigravity quota degrades to a note and never blocks the other providers', async () => {
  const execOmp = async args => args.includes('--list') ? { stdout: '1. user@example.com\n' } : { stdout: 'live' };
  const data = { reports: [{ provider: 'alpha', limits: [] }] };
  await addAntigravityCliUsage(data, { execOmp, fetchImpl: async () => { throw new Error('offline'); }, now: Date.now() + 20 * 60_000 });
  assert.deepEqual(data.reports.map(r => r.provider), ['alpha', 'antigravity-cli']);
  assert.deepEqual(data.reports[1].limits, []);
  assert.match(data.reports[1].notes[0], /^Antigravity CLI quota unavailable: /);

  // OMP reporting the provider itself wins; no second section is added.
  const reported = { reports: [{ provider: 'antigravity-cli', limits: [] }] };
  let called = false;
  await addAntigravityCliUsage(reported, { execOmp: async () => { called = true; return { stdout: '' }; }, fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(reported.reports.length, 1);

  // Not logged in: nothing is added and nothing throws.
  const none = { reports: [] };
  await addAntigravityCliUsage(none, { execOmp: async () => { throw new Error('not logged in'); }, fetchImpl: async () => { throw new Error('must not run'); }, now: Date.now() + 40 * 60_000 });
  assert.deepEqual(none.reports, []);
});

test('OMP without the account list still reports the one token it returns', async () => {
  const execOmp = async args => { if (args.includes('--list')) throw new Error('unknown option'); return { stdout: 'ya29.one\n' }; };
  const data = { reports: [] };
  await addAntigravityCliUsage(data, {
    execOmp,
    fetchImpl: async url => url.endsWith('Summary') ? { ok: true, status: 200, json: async () => summary } : { ok: true, status: 200, json: async () => quota },
    now: Date.now() + 30 * 60_000,
  });
  assert.equal(data.reports.length, 1);
  assert.equal(data.reports[0].metadata.projectId, 'default-cli-project');
  assert.equal(data.reports[0].metadata.email, undefined);
  assert.deepEqual(data.reports[0].limits.map(l => l.label), ['Claude & GPT (shared)', 'Claude & GPT (shared)', 'Gemini models (2)']);
});

// Cloud Code lists the Gemini group (and so its weekly limit) only for clients that identify a recent Antigravity
// version; the values below are what the Antigravity app itself showed for the same account.
const geminiSummary = { groups: [
  { displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.36780986, resetTime: '2026-11-25T00:00:08Z' },
    { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.7115745, resetTime: GEMINI },
  ] },
  summary.groups[0],
] };

test('The Gemini weekly limit Antigravity shows reaches the usage panel', async () => {
  const versionOf = ua => Number((String(ua).match(/^antigravity\/(\d+)\.(\d+)/) || []).slice(1).join('.') || 0);
  const fetchImpl = async (url, init) => {
    const recent = versionOf(init.headers['User-Agent']) >= 2.33;
    if (url.endsWith('/v1internal:retrieveUserQuotaSummary')) return { ok: true, status: 200, json: async () => (recent ? geminiSummary : summary) };
    return { ok: true, status: 200, json: async () => quota };
  };
  const data = { reports: [] };
  await addAntigravityCliUsage(data, { execOmp: async () => ({ stdout: 'ya29.one\n' }), fetchImpl, now: Date.now() + 60 * 60_000 });
  const view = modelUsage(data, 'antigravity-cli', 'claude-opus-5-5-high');
  const limits = view.providers[0].accounts[0].limits;
  const geminiWeekly = limits.find(l => l.label === 'Gemini (shared)' && l.detail.startsWith('Weekly'));
  assert.ok(geminiWeekly, 'Gemini weekly row is present');
  assert.ok(Math.abs(geminiWeekly.fraction - 0.63219014) < 1e-9, 'used fraction, not 0');
  assert.equal(geminiWeekly.resetsAt, Date.parse('2026-11-25T00:00:08Z'));
  const geminiFiveHour = limits.find(l => l.label === 'Gemini (shared)' && l.detail.startsWith('5 Hour'));
  assert.ok(Math.abs(geminiFiveHour.fraction - 0.2884255) < 1e-9);
  // The Gemini group replaces the per-model fallback row.
  assert.ok(!limits.some(l => l.label.startsWith('Gemini models')));
});

test('A window without a remaining fraction is shown as unknown, never as 0 or dropped', () => {
  const rows = antigravityLimitRows({ groups: [{ displayName: 'Gemini Models', buckets: [
    { window: 'weekly', displayName: 'Weekly Limit Remaining', remainingAmount: 12, resetTime: WEEKLY },
    { window: '5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.5, resetTime: FIVE_HOURS },
  ] }] }, undefined);
  assert.deepEqual(rows.map(r => [r.window.id, r.status]), [['weekly', 'unknown'], ['5h', 'ok']]);
  const data = { reports: [{ provider: 'antigravity-cli', limits: rows }] };
  const [weekly, fiveHour] = modelUsage(data, 'antigravity-cli', 'm').providers[0].accounts[0].limits;
  assert.equal(weekly.fraction, undefined);
  assert.equal(weekly.summary, 'Remaining quota unavailable');
  assert.equal(weekly.resetsAt, Date.parse(WEEKLY));
  assert.equal(fiveHour.fraction, 0.5);
});

test('Models without a weekly limit from the Summary are labelled as the current window only', () => {
  const [gemini] = antigravityLimitRows(undefined, quota);
  assert.equal(gemini.window.id, 'current');
  assert.match(gemini.notes[0], /no weekly limit/);
});
