import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';
import { pdfInfo, splitPdfRefs, withPdfRefs } from '../companion/pdfs.mjs';

// A two-page PDF with a document title, as far as the page-tree and /Info scan read one.
const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n'
  + '5 0 obj\n<< /Title (Quarterly \\(Q3\\) report) >>\nendobj\ntrailer\n<< /Root 1 0 R /Info 5 0 R >>\n%%EOF\n', 'latin1');
const data = bytes.toString('base64');
const id = createHash('sha256').update(bytes).digest('hex');

test('pdfInfo reads the page count and title; reference lines round-trip', () => {
  assert.deepEqual(pdfInfo(bytes), { pages: 2, title: 'Quarterly (Q3) report' });
  // UTF-16BE title, and an encrypted file whose title is not read.
  const utf16 = Buffer.from('%PDF-1.7\n9 0 obj\n<< /Title <FEFF00C9007400E9> >>\nendobj\ntrailer\n<< /Info 9 0 R >>\n', 'latin1');
  assert.equal(pdfInfo(utf16).title, 'Été');
  assert.ok(!pdfInfo(Buffer.concat([utf16, Buffer.from('<< /Encrypt 3 0 R >>')])).title, 'no title from an encrypted file');
  const meta = { id, name: 'report.pdf', pages: 2, bytes: bytes.length, path: join('C:', 'data', 'attachments', id + '.pdf') };
  const text = withPdfRefs('Summarize this', [meta]);
  assert.equal(text, `Summarize this\n\nAttached PDF: report.pdf (2 pages) — ${meta.path}`);
  const split = splitPdfRefs(text);
  assert.equal(split.text, 'Summarize this');
  assert.deepEqual(split.pdfs.map(p => [p.id, p.name, p.pages, p.path]), [[id, 'report.pdf', 2, meta.path]]);
});

test('PDF chat messages reach OMP as stored-file references, queue, refuse side questions and are served back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-pdf-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const sent = [];
  // Prompts never complete: the session stays running, so follow-ups queue.
  const omp = fakeOmp({ state: () => ({ todoPhases: [] }), prompt(c) { sent.push(c); return {}; }, followUp(c) { sent.push(c); return {}; }, steer(c) { sent.push(c); return {}; } });
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const post = async (path, body) => {
    const res = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  const command = body => post('/sessions/session/command', body);

  // Not a PDF, or no name: refused before anything is stored or sent.
  const [badStatus, bad] = await command({ type: 'prompt', message: 'x', pdfs: [{ data: Buffer.from('hello world!').toString('base64'), name: 'notes.pdf' }] });
  assert.equal(badStatus, 400);
  assert.equal(bad.error, 'notes.pdf is not a valid PDF.');
  assert.equal((await command({ type: 'prompt', message: 'x', pdfs: [{ data, name: '' }] }))[0], 400);
  assert.equal((await command({ type: 'prompt', message: '/btw what is this?', pdfs: [{ data, name: 'report.pdf' }] }))[1].error, 'Side questions cannot carry PDFs.');
  assert.equal(sent.length, 0);

  const [status, session] = await command({ type: 'prompt', message: 'Summarize this', pdfs: [{ data, name: 'report.pdf' }] });
  assert.equal(status, 200);
  const file = join(dir, 'attachments', id + '.pdf');
  assert.deepEqual(await readFile(file), bytes, 'stored under its content hash');
  assert.equal(sent[0].message, `Summarize this\n\nAttached PDF: report.pdf (2 pages) — ${file}`);
  assert.equal(sent[0].images, undefined);
  const user = session.messages.find(m => m.role === 'user');
  assert.equal(user.text, 'Summarize this');
  assert.deepEqual(user.pdfs.map(p => [p.id, p.name, p.pages, p.path]), [[id, 'report.pdf', 2, file]]);

  // While OMP works, a PDF-only follow-up waits in the queue with its PDF, then goes out with the reference line.
  const [, queued] = await command({ type: 'follow_up', message: '', pdfs: [{ data, name: 'again.pdf' }] });
  assert.equal(queued.queuedMessages.length, 1);
  assert.equal(queued.queuedMessages[0].text, '');
  assert.deepEqual(queued.queuedMessages[0].pdfs.map(p => p.name), ['again.pdf']);
  const [, flushed] = await command({ type: 'send_follow_up', id: queued.queuedMessages[0].id });
  assert.equal(flushed.queuedMessages.length, 0);
  assert.equal(sent.at(-1).message, `Attached PDF: again.pdf (2 pages) — ${file}`);

  // The stored file: by Bearer token, or by the path-scoped cookie a new tab carries; nothing else.
  const get = (path, headers = {}) => fetch(url + path, { headers });
  const ok = await get(`/attachment?id=${id}&name=report.pdf`, { Authorization: `Bearer ${app.token}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.match(ok.headers.get('content-disposition'), /^inline; .*filename\*=UTF-8''report\.pdf$/);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), bytes);
  assert.equal((await get(`/attachment?id=${id}`, { Cookie: `omp_attach=${encodeURIComponent(app.token)}` })).status, 200);
  assert.equal((await get(`/attachment?id=${id}`)).status, 401);
  assert.equal((await get(`/attachment?id=${id}`, { Cookie: 'omp_attach=wrong' })).status, 401);
  assert.equal((await get('/state', { Cookie: `omp_attach=${encodeURIComponent(app.token)}` })).status, 401, 'the cookie opens only attachments');

  // Clearing stored PDFs frees them; their chips then answer that the file is gone.
  const [, cleared] = await post('/storage/clear-attachments', {});
  assert.deepEqual(cleared.cleared, { count: 1, freed: bytes.length });
  const gone = await get(`/attachment?id=${id}`, { Authorization: `Bearer ${app.token}` });
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /no longer stored/);
});

test('composer drafts keep PDFs with their details, and send only names the dashboard lacks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-draft-pdf-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'a', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return [res.status, await res.json()];
  };
  const pdf = { pdf: { type: 'pdf', mimeType: 'application/pdf', data }, name: 'report.pdf', tokens: 3000 };
  const [status, saved] = await call('/draft', { key: 'session:a', text: '', pdfs: [pdf] });
  assert.equal(status, 200);
  assert.deepEqual(saved.pdfs, ['report.pdf']);
  const [, full] = await call('/draft?key=session:a');
  assert.deepEqual(full.pdfs, [{ ...pdf, pages: 2, bytes: bytes.length, title: 'Quarterly (Q3) report' }]);
  const [, known] = await call('/draft?key=session:a&have=report.pdf');
  assert.deepEqual(known.pdfs, [{ name: 'report.pdf', tokens: 3000, pages: 2, bytes: bytes.length, title: 'Quarterly (Q3) report' }]);
  // A text edit leaves the PDF; an empty list removes it and its file.
  await call('/draft', { key: 'session:a', text: 'now with text' });
  assert.deepEqual((await call('/draft?key=session:a&have=report.pdf'))[1].pdfs.map(p => p.name), ['report.pdf']);
  assert.equal((await call('/draft', { key: 'session:a', text: '', pdfs: [{ ...pdf, pdf: { ...pdf.pdf, data: 'aGVsbG8=' } }] }))[0], 400);
  await call('/draft', { key: 'session:a', text: '', pdfs: [] });
  assert.deepEqual((await call('/draft?key=session:a'))[1], { text: '', at: null, images: [] });
});
