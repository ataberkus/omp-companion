# Enhance Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ✨ Enhance button in every composer rewrites the draft into a concrete, project-aware prompt. It runs a one-shot read-only `omp -p` with the `enhance` role or the composer's model. On the New-session screen it first creates a *draft session* that is discarded if the user leaves without sending.

**Architecture:** The server runs each enhance as an in-memory job, following the existing `runCli`/`cliJobs` pattern. The job spawns `omp -p --mode json` with the draft on stdin and maps tool events to a progress step. The frontend polls the job, swaps the draft in with Undo, and drives draft-session discard from `route()`. Discard runs under the session lock and is guarded client-side against an in-flight send. Everything lives in the existing single files (`companion/server.mjs`, `local-dist/app.js`, `local-dist/app.css`), per repo convention.

**Tech Stack:** Node 22 ESM, no build step, `node:test`; frontend tests run `app.js` in `node:vm` against a stub DOM.

**Spec:** `docs/superpowers/specs/2026-10-10-enhance-prompt-design.md` (read it; this plan argues from it).

## Global Constraints

- No new npm dependencies. No shell: every process uses `spawn`/`execFile` with an argument array and `windowsHide: true`.
- The draft text never appears in argv; it goes only on the enhancer's stdin.
- Enhancer flags, verbatim: `-p --mode json --no-session --no-title --no-skills --no-extensions --no-lsp --tools=read,grep,glob --approval-mode=always-ask --max-time=120`, plus `--config=<overlay>`. The overlay is the spec §2 lockdown YAML, verbatim (`tools.xdev:false`, advisor/autolearn/context-management/memory/checkpoint/todo/ask off, `disabledProviders: [native, mcp-json]`). No `find`: OMP 18.8.6 aborts with exit 2 when it is requested.
- Limits: draft 1–20 000 chars; at most 3 running jobs (409 `Wait for the running enhance to finish.`); server kill at 150 s → `Enhance timed out.`; finished jobs dropped 5 min after finishing or on the first `GET` that reads them.
- Model order: `modelRoles.enhance` → `--model=@enhance` (no `--thinking`); else the session/composer selector + `--thinking=low`; else no model flag.
- Conversation tail: last 6 `user`/`assistant` messages, each truncated to 1 500 chars, wrapped in `<conversation>`, then `<draft>`.
- Copy: button `✨ Enhance` / `■ Cancel`; title `Rewrite this draft with project context (Ctrl+Shift+E)`; status `Enhancing with <model> · <step>…`; draft status `Draft · discarded if you leave without sending`; toasts `Prompt enhanced` + `Undo`, `Enhanced prompt ready` + `Use enhanced prompt`.
- Shortcut `Ctrl+Shift+E` / `Meta+Shift+E`, added to `RESERVED_KEYS`.
- Draft discard: under `lock(s.id, …)`; awaits `close` of both the enhance process and the OMP runner; worktree remove retried up to 20 times at 50 ms × attempt; if the worktree still fails, the session is hidden and kept with `draft: true` for startup cleanup.

## Review Focus

1. **A draft containing quotes, newlines, `--model=x`, or `@file`.** It must reach the enhancer byte-for-byte on stdin and never in argv. Pinned in Task 2 (`stdin round trip`).
2. **A non-English draft (Turkish `ğüşıöç`, emoji).** It must survive the UTF-8 stdin round trip and come back unmangled in the result. Pinned in Task 2.
3. **An enhancer that exits 0 with empty text or only a code fence.** This must be an error, never a blank replacement of the user's draft. Pinned in Task 1 (`cleanEnhanced`) and Task 2 (`empty result`).
4. **The session disappears while an enhance is polling** (discarded, removed in another tab). The client stops polling and shows at most one error toast, with no loop. Pinned in Task 4 (`poll 404`).
5. **The companion quits mid-enhance.** The enhance process is killed and `dataDir/enhance/<job>` with the user's images is deleted. Pinned in Task 2 (`close cleans up`).

---

### Task 1: Pure enhance helpers + role lookup

**Files:**
- Modify: `companion/server.mjs`: add helpers above `export const internals` and add them to `internals`; extract role parsing out of `listModels()`.
- Test: `tests/enhance-server.test.mjs` (new)

**Interfaces:**
- Produces (all exported via `internals`):
  - `enhanceModel(roles: Record<string,string>, selector: string): { model: string|null, thinking: string|null, label: string }`. `roles.enhance` set → `{model:'@enhance', thinking:null, label:roles.enhance}`; else non-empty selector → `{model:selector, thinking:'low', label:selector}`; else `{model:null, thinking:null, label: roles.default || 'OMP default'}`.
  - `enhanceArgs({ model, thinking, overlay, system, images }: { model:string|null, thinking:string|null, overlay:string, system:string, images:string[] }): string[]`. The fixed flags from Global Constraints, then `--config=<overlay>`, optional `--model=`/`--thinking=`, `--append-system-prompt=<system>` (a **file path**; OMP reads file contents), then `@<image>` per image.
  - `enhanceInput(draft: string, messages: {role:string,text:string}[]): string` builds the stdin of spec §3.
  - `stepLabel(toolName: string, args: object, cwd: string): string`:
    - `read` → `reading <path relative to cwd>`;
    - `grep` → `searching "<pattern>"`;
    - `glob` → `listing <pattern>`;
    - `find` → `finding "<query ?? pattern>"` (kept for OMP builds that expose it; never requested);
    - other → the tool name.

    Truncated to 80 chars.
  - `cleanEnhanced(text: string): string`: trim; if the whole text is a single fenced block, return its inner text trimmed.
- Produces (closure-internal, used by Task 2): `async modelRoles(): Promise<{ roles: Record<string,string>, defaultThinking: string }>`. This is the `config.yml` parse moved out of `listModels()`, which now calls it.

- [ ] **Step 1: Write the failing tests** in `tests/enhance-server.test.mjs` (`import { internals } from '../companion/server.mjs'`):

```js
test('enhance model resolution order', () => {
  const { enhanceModel } = internals;
  assert.deepEqual(enhanceModel({ enhance: 'x/y:low', default: 'a/b' }, 'p/m'), { model: '@enhance', thinking: null, label: 'x/y:low' });
  assert.deepEqual(enhanceModel({ default: 'a/b' }, 'p/m'), { model: 'p/m', thinking: 'low', label: 'p/m' });
  assert.deepEqual(enhanceModel({ default: 'a/b' }, ''), { model: null, thinking: null, label: 'a/b' });
});
test('enhancer argv is fixed, read-only, and never carries the draft', () => {
  const a = internals.enhanceArgs({ model: '@enhance', thinking: null, overlay: 'O.yml', system: 'S.md', images: ['C:\\d i r\\image-1.png'] });
  assert.deepEqual(a.slice(0, 11), ['-p', '--mode', 'json', '--no-session', '--no-title', '--no-skills', '--no-extensions', '--no-lsp', '--tools=read,grep,glob', '--approval-mode=always-ask', '--max-time=120']);
  assert.ok(a.includes('--config=O.yml') && a.includes('--model=@enhance') && a.includes('--append-system-prompt=S.md'));
  assert.ok(!a.some(x => x.startsWith('--thinking')));
  assert.equal(a.at(-1), '@C:\\d i r\\image-1.png');
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
  assert.equal(internals.cleanEnhanced('```md\nDo X\n```'), 'Do X');
  assert.equal(internals.cleanEnhanced('```\n```'), '');
  assert.equal(internals.cleanEnhanced('  Do `x` here \n'), 'Do `x` here');
});
```

- [ ] **Step 2: Run** `node --test tests/enhance-server.test.mjs`. Expected: FAIL (`enhanceModel is not a function`).
- [ ] **Step 3: Implement** the five helpers, `modelRoles()`, and the `listModels()` refactor. Use `path.relative` for `read`; on Windows the test's `/p` paths still resolve.
- [ ] **Step 4: Run** `node --test tests/enhance-server.test.mjs` → PASS; `node --test tests/*.test.mjs` → all pass (`listModels` behaviour unchanged).
- [ ] **Step 5: Commit** `git add companion/server.mjs tests/enhance-server.test.mjs && git commit -m "Enhance: pure argv/input/model helpers"`.

---

### Task 2: Enhance jobs: routes, process, images, cleanup

**Files:**
- Modify: `companion/server.mjs`: inside `createCompanion`: job map, `startEnhance`, `stopEnhance`, routes, startup files, `close()` cleanup, 48 MB body cap for `/api/enhance`.
- Test: `tests/enhance-server.test.mjs`

**Interfaces:**
- Consumes: Task 1 helpers, `modelRoles()`, `chatImages`, `resolveDir`, `modelChoice`, `text`, `contentText`.
- Produces:
  - `POST /api/enhance { text, session? | path?, model?, thinking?, images?, preview? }` → `202 { id, model }`, where `model` is the label. Exactly one of `session`/`path` is required (400 otherwise); a `session` must exist (404).
  - `GET /api/enhance?id=` → `{ id, status:'running'|'done'|'error'|'cancelled', step, model, text?, error? }`; 404 for an unknown id. A finished job is deleted after this read.
  - `POST /api/enhance/stop { id }` → `{ status }`.
  - `async stopEnhance(job): Promise<void>`: kill and await the `close` event (no-op if already closed). Used by Task 3.
  - Job record: `{ id, sessionId|null, status, step, model, text, error, child, dir, finishedAt }` in `enhanceJobs: Map`.
  - New `createCompanion` option `enhancePrefix: string[]` (default `[]`), inserted after `ompPrefix` in the spawn args. Test seam, like `ompArgs`.
- Spawn: `spawn(ompExecutable, [...ompPrefix, ...enhancePrefix, ...enhanceArgs(…)], { cwd, stdio:['pipe','pipe','pipe'], windowsHide:true, env:{...process.env, NO_COLOR:'1', FORCE_COLOR:'0'} })`, then `child.stdin.end(enhanceInput(text, s?.messages ?? []), 'utf8')`.
  - cwd: the session's `cwd`, or `resolveDir(path)`.
  - Selector: for a session, `s.modelSelector` or `` `${s.provider}/${s.model}` `` when `s.model !== 'OMP default'`; for `path`, `modelChoice(body).selector`.
- Files written at startup (static, `0o600`):
  - `dataDir/enhance-overlay.yml` = the spec §2 lockdown YAML, verbatim (exported as `internals.ENHANCE_OVERLAY` so a test can parse-check its keys);
  - `dataDir/enhance-system.md` = the spec §3 system prompt, verbatim.
- Images go to `dataDir/enhance/<id>/image-<n>.<png|jpg|webp|gif>`. The directory is removed (`fs.rm` recursive, force) on every terminal state.
- Stdout: line JSON (`readline`):
  - `tool_execution_start` → `job.step = stepLabel(f.toolName, f.args, cwd)`;
  - `message_end` with `f.message.role === 'assistant'` → `job.text = contentText(f.message.content)`.
- On `close`:
  - cancelled/stopped → `cancelled`;
  - exit 0 and `cleanEnhanced(text)` non-empty → `done`;
  - exit 0 with empty text → `error: 'The enhancer returned no text.'`;
  - otherwise `error` = last non-empty stderr line, ANSI-stripped, or `OMP exited (<code>).`;
  - the 150 s timer → `error: 'Enhance timed out.'`.
- `close()` kills running enhance children (add them to the existing shutdown kill list) and removes their dirs.

- [ ] **Step 1: Write the failing tests.** Copy the `createCompanion` + fake-OMP harness from `tests/archive.test.mjs:36-58`. Add a fake enhancer `enh.mjs` passed as `enhancePrefix: [enh]`. It writes `process.argv.slice(2)` and its stdin (UTF-8) to `argv.json`/`stdin.txt` in the test dir, then branches on the stdin:
  - contains `HANG` → `setInterval(()=>{},1e9)`;
  - contains `EMPTY` → exit 0 with no assistant message;
  - otherwise → emit `{type:'tool_execution_start',toolName:'read',args:{path:'<cwd>/src/a.js'}}`, then `{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'```\nENHANCED ' + <draft line> + '\n```'}]}}`, exit 0.

  The tests:

```js
test('stdin round trip: draft and images reach the enhancer, never argv', async () => {
  const draft = 'fix "it" --model=x @evil\nğüşıöç 🚀';
  const { id, model } = await post('/enhance', { session: 'session', text: draft, images: [image] }); // image from chat-image.test.mjs
  const job = await until(() => get('/enhance?id=' + id), j => j.status !== 'running');
  assert.equal(job.status, 'done'); assert.equal(job.text, 'ENHANCED ' + draft.split('\n')[0]);
  assert.equal(model, 'OMP default');
  const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8'));
  assert.ok(!argv.some(a => a.includes('fix "it"')));
  assert.match(argv.at(-1), /^@.*enhance[\\/].+[\\/]image-1\.png$/);
  assert.match(await readFile(join(dir, 'stdin.txt'), 'utf8'), /<draft>\nfix "it" --model=x @evil\nğüşıöç 🚀\n<\/draft>$/);
  assert.equal((await get('/enhance?id=' + id)).status, undefined); // dropped after read (404 body)
});
test('empty result is an error, not a blank draft', async () => {
  const { id } = await post('/enhance', { session: 'session', text: 'EMPTY' });
  assert.deepEqual(pick(await until(…), ['status', 'error']), { status: 'error', error: 'The enhancer returned no text.' });
});
test('stop cancels, cap is 3, close cleans up', async () => {
  const ids = []; for (let i = 0; i < 3; i++) ids.push((await post('/enhance', { session: 'session', text: 'HANG' })).id);
  assert.equal((await postRaw('/enhance', { session: 'session', text: 'HANG' })).status, 409);
  await post('/enhance/stop', { id: ids[0] });
  assert.equal((await until(() => get('/enhance?id=' + ids[0]), j => j.status !== 'running')).status, 'cancelled');
  await app.close(); // remaining 2 HANG jobs
  assert.deepEqual(await readdir(join(dir, 'enhance')).catch(() => []), []);
  // enh.mjs also writes its pid to pid-<n>; assert every pid is dead (process.kill(pid, 0) throws)
});
```

- [ ] **Step 2: Run** `node --test tests/enhance-server.test.mjs` → FAIL (404 on `/api/enhance`).
- [ ] **Step 3: Implement** the job map, routes, spawn, event mapping, image files, timers and `close()` integration per the Interfaces block.
- [ ] **Step 4: Run** `node --test tests/enhance-server.test.mjs` → PASS; full suite passes.
- [ ] **Step 5: Commit** `git commit -am "Enhance: one-shot read-only omp jobs with progress, cancel and cleanup"` (add the test file).

---

### Task 3: Draft sessions on the server

**Files:**
- Modify: `companion/server.mjs`: `createSession` (accept `draft`), the `/api/quick-start` route (pass `body.draft === true`), `command()` (draft clear/restore + `discard`), new `discardDraft(s)`, startup cleanup before `createCompanion` returns.
- Test: `tests/enhance-server.test.mjs`

**Interfaces:**
- Consumes: `stopEnhance(job)` (Task 2), `lock`, `runners`, `git(cwd,args)`, `importMessages`, `persist`.
- Produces:
  - `s.draft: true` on sessions created by `POST /api/quick-start { …, draft: true }`. It is persisted, so it survives restarts.
  - `const sent = s => s.messages.some(m => m.role === 'user' || m.id?.startsWith('tool-bash-')) || !!s.queuedMessages?.length`.
  - In `command()`, right after the `allowed` check and before any `await`:

    ```js
    if(s.draft&&['prompt','steer','follow_up','interrupt','bash','send_follow_up'].includes(body.type)){
     delete s.draft;
     try{return await command(s,body,checkedImages,queuedId);}
     finally{if(!sent(s))s.draft=true;}
    }
    ```

    This implements the spec's synchronous clear. Restoring on failure is what makes the client's post-failure discard (spec §5) effective.
  - `'discard'` is added to `allowed` and routed under the lock (the default branch at the `/command` route). It returns `{ discarded: boolean }`.
  - `async discardDraft(s): Promise<{discarded:boolean}>`:
    - A no-op unless `s.draft && !sent(s)`.
    - Otherwise, in order:
      1. `await stopEnhance` for each job with `sessionId === s.id`.
      2. Stop the runner and await `close` (pattern at server.mjs `discoverCommands` `finally`).
      3. If `s.sessionFile` exists and `importMessages` finds no `user` message, `fs.rm` it.
      4. If `s.isolated && s.branch?.startsWith('omp-web/')`, retry `git(project.path, ['worktree','remove','--force', s.cwd])` up to 20 times at 50 ms × attempt; then `git(project.path, ['branch','-D', s.branch])`, ignoring failure.
      5. Worktree removed (or not isolated) → splice the session out of `store.sessions` and drop `store.archived` `s:<id>`; else set `s.hidden = true` and keep `draft`.
      6. `persist()`.
  - Startup: after the store loads and before `return`, `for (const s of store.sessions.filter(x => x.draft)) await discardDraft(s)`.

- [ ] **Step 1: Write the failing tests.** Same harness; the fake OMP is the `archive.test.mjs` one, recording its pid. Prompts are answered by the fake with `{agentInvoked:true}`:

```js
test('discard sent while the first prompt holds the lock keeps the session', async () => {
  // fake OMP: on `prompt`, write <dir>/prompt-seen, then reply {agentInvoked:true} after 300 ms
  const s = await post('/quick-start', { path: dir, draft: true });
  await get('/commands?session=' + s.id); // starts OMP
  const sending = post(`/sessions/${s.id}/command`, { type: 'prompt', message: 'hi' });
  await until(() => exists(join(dir, 'prompt-seen'))); // prompt is inside the lock, draft already cleared
  const [r1, r2] = await Promise.all([sending, post(`/sessions/${s.id}/command`, { type: 'discard' })]);
  assert.equal(r2.discarded, false);
  const kept = (await get('/state')).sessions.find(x => x.id === s.id);
  assert.ok(kept && !kept.draft && kept.messages.some(m => m.role === 'user'));
});
test('lone discard removes the session after its OMP process exited', async () => {
  const s = await post('/quick-start', { path: dir, draft: true }); await get('/commands?session=' + s.id);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.equal((await post(`/sessions/${s.id}/command`, { type: 'discard' })).discarded, true);
  assert.throws(() => process.kill(pid, 0)); // already dead when discard returned
  assert.equal((await get('/state')).sessions.some(x => x.id === s.id), false);
});
test('isolated draft: worktree and branch removed; leftover drafts cleaned on startup', async () => {
  // git init repo with one commit in `repo`; quick-start { path: repo, isolate: true, draft: true }; start; discard
  assert.ok(!(await exec('git', ['-C', repo, 'worktree', 'list'])).stdout.includes('omp-web'));
  assert.ok(!(await exec('git', ['-C', repo, 'branch'])).stdout.includes('omp-web/'));
  // second draft, app.close(), new createCompanion on same dataDir → the session is gone from /state
});
test('a first send that fails before recording a message restores the draft marker', async () => {
  // separate createCompanion whose ompArgs fake exits with code 1 before `ready`:
  // quick-start {draft:true}; prompt → response.status === 'error', no user message;
  // /state shows draft: true, and a following discard returns { discarded: true }
});
```

- [ ] **Step 2: Run** → FAIL (`discard` → `Unsupported session command.`).
- [ ] **Step 3: Implement** per the Interfaces block. Keep `discardDraft` lock-free internally; the route already holds the lock, and startup has no concurrency.
- [ ] **Step 4: Run** `node --test tests/enhance-server.test.mjs` → PASS; full suite passes.
- [ ] **Step 5: Commit** `git commit -am "Enhance: draft sessions discarded under the session lock"`.

---

### Task 4: Composer Enhance in sessions and history views

**Files:**
- Modify: `local-dist/app.js`:
  - the `build()` composer markup: add `<span id="enhanceSlot"></span>` after the `attach-btn`;
  - `renderComposer`: button, read-only textarea, Send disabled, status line;
  - new enhance functions near the ghost-text block;
  - `send()`: early return while enhancing;
  - global keydown: shortcut next to Ctrl+P;
  - `RESERVED_KEYS`: add `ctrl+shift+e`, `meta+shift+e`.
- Modify: `local-dist/app.css`: `.enhance-btn` uses the `.btn sm ghost` look; nothing new unless needed for the running state.
- Test: `tests/enhance.test.mjs` (new). Copy the `boot()` harness from `tests/frontend-interaction.test.mjs:11-66`; add `enhanceSlot` to the element ids, and change `setTimeout` to push callbacks to a `timers` array that the test runs.

**Interfaces:**
- Consumes: Task 2 routes.
- Produces (Task 5 relies on these):
  - `S.enhance: Map<view, { id, original, model, step }>`.
  - `async startEnhance(view: string, body: object, original: string): Promise<void>`: POSTs `/enhance`, stores the job, renders, then `pollEnhance(view)`. On a POST error: toast `e.message`, `'err'`.
  - `pollEnhance(view)`: `GET /enhance?id=`.
    - `running` → update `step`, re-render if `S.view === view`, `setTimeout(() => pollEnhance(view), 500)`;
    - `done` → `applyEnhanced(view, job.original, r.text)`;
    - `error` / HTTP error → one `toast(msg,'err')`;
    - `cancelled` → silent.

    Every terminal path deletes `S.enhance.get(view)` first.
  - `applyEnhanced(view, original, text)`:
    - On the view with `input.value === original` → `replaceDraft(input, text)` + `toast('Prompt enhanced', '', { label: 'Undo', run: () => replaceDraft(input, original) })`.
    - On the view, draft changed → `toast('Enhanced prompt ready', '', { label: 'Use enhanced prompt', run: () => replaceDraft($('#input'), text) })`.
    - Off the view and `(drafts.get(view) ?? '') === original` → `drafts.set(view, text)`; otherwise drop it.
  - `replaceDraft(input, text)`: `focus()`, `select()`, `document.execCommand?.('insertText', false, text)`; if that returns falsy, `input.value = text`. Then `drafts.set`, `autosize`, `updateComposer()`, caret at end.
  - `enhanceCurrent()`, used by the button and the shortcut:
    - If `S.enhance.has(S.view)`, cancel: `POST /enhance/stop`, delete the entry, update.
    - Draft empty or `/^[/!]/` → return.
    - `session` view → body `{ session: id, ...imagePayload(attached()) }`, plus fire-and-forget `api('/commands?session=' + id)` to start OMP.
    - `native` view → body `{ path: cwd, model, thinking }` (from `S.nativeChoice`), `...imagePayload(attached())`.
    - `home` → `enhanceFromHome()` (Task 5).
  - `renderComposer`, while `S.enhance.has(S.view)`:
    - `input.readOnly = true`;
    - Send/Steer/Queue disabled;
    - status = `Enhancing with ${modelName(job.model)} · ${job.step || 'starting'}…`;
    - `#enhanceSlot` = `■ Cancel` (`data-act="enhance"`).

    Otherwise `✨ Enhance`, disabled when the draft is empty or starts with `/` or `!`.

- [ ] **Step 1: Write the failing tests** (`tests/enhance.test.mjs`). Extend the copied harness with:
  - `click(target)` → `fire('click', { target })`;
  - `el(id)`;
  - `runTimers()`: run and flush queued `setTimeout` callbacks until none remain, max 20 rounds;
  - `toastAction(label)`: find the last toast node's `.toast-act` with that label and call its `onclick`;
  - `seq(list)`: a route function returning the next item per call.

  The stub keys routes by path without the query string, so one `/enhance` route serves POST (has a body) and GET (no body).

```js
test('Enhance replaces the draft, Undo restores it, Send is blocked meanwhile', async () => {
  const polls = seq([{ status: 'running', step: 'reading src/a.js' }, { status: 'done', text: 'Better' }]);
  const b = await boot({ sessions: [session], routes: { '/enhance': body => body ? { id: 'j', model: 'a/b' } : polls() } });
  b.input.value = 'fix it'; await b.fire('input', { target: b.input });
  await b.click(b.act('enhance'));
  assert.equal(b.input.readOnly, true);
  assert.match(b.el('statusLine').innerHTML, /Enhancing with .* · reading src\/a\.js…/);
  await b.key('Enter'); assert.ok(!b.calls.some(c => c.body?.type === 'prompt'));
  await b.runTimers();
  assert.equal(b.input.value, 'Better'); assert.equal(b.input.readOnly, false);
  b.toastAction('Undo'); assert.equal(b.input.value, 'fix it');
  assert.ok(b.calls.some(c => c.url.startsWith('/api/commands?session=')));
});
test('edited draft is not overwritten; the offer toast applies it', async () => { /* change input before 'done' → value kept, 'Use enhanced prompt' → 'Better' */ });
test('Ctrl+Shift+E starts and cancels; slash and shell drafts are ignored', async () => { /* '/' draft → no /enhance call; second press → POST /enhance/stop {id:'j'} */ });
test('poll 404 stops polling with one error toast', async () => { /* GET throws {error:'Not found'} → S.enhance cleared, exactly one 'err' toast, no further timers */ });
```

- [ ] **Step 2: Run** `node --test tests/enhance.test.mjs` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** the new tests → PASS; full suite passes (the existing frontend tests must not need changes beyond new element ids).
- [ ] **Step 5: Commit** `git commit -am "Enhance: composer button, progress, undo and shortcut"` (add the test file).

---

### Task 5: New-session Enhance and draft discard on navigation

**Files:**
- Modify: `local-dist/app.js`:
  - the home composer bar (next to **Start session**): `enhanceButton()` markup;
  - new `enhanceFromHome()`;
  - `route()`: capture `prev = S.view` before reassigning; call `leaveDraft(prev, c)`;
  - `send()` and the `!cmd` branch: in-flight markers and the post-send discard;
  - `renderComposer`: the draft status line.
- Test: `tests/enhance.test.mjs`

**Interfaces:**
- Consumes: `startEnhance`, `S.enhance` (Task 4); `POST /api/quick-start { draft:true }`, `discard` (Task 3).
- Produces:
  - `async enhanceFromHome()`:
    - Guard: `S.home.listing`, a non-empty trimmed `S.home.prompt`, `!S.busy`.
    - Then: `S.busy = true`; `quick-start` with `startSession()`'s body **minus `prompt` and images**, plus `draft:true`.
    - On error: toast and restore; draft and attachments untouched.
    - On success:
      1. fire-and-forget `api('/commands?session=' + s.id)`;
      2. `view = 'session:' + s.id`;
      3. move `attached()` items to `view`;
      4. `drafts.set(view, S.home.prompt)`;
      5. clear `S.home.prompt`;
      6. `await refresh()`;
      7. `location.hash = '#/s/' + s.id`;
      8. `startEnhance(view, { session: s.id, ...imagePayload(moved) }, text)`.
  - `leaveDraft(prev: string, c)`:
    - Applies only when `prev` is `session:<id>` of a session with `draft` and `c.kind` is `home`, `session`, or `native`.
    - If `S.pending?.view === prev || S.sendingBash === prev` → `S.discardAfterSend.add(prev)` and return.
    - Else `discardView(prev)`.
  - `discardView(view)`:
    - delete `S.enhance` entry, `drafts`, and attachments for the view;
    - `api('/sessions/<id>/command', { type:'discard' }).then(refresh).catch(() => {})`.
  - `S.sendingBash: string|null` is set around the `!cmd` `sessionAction` call.
  - `S.discardAfterSend: Set<string>`. In `send()`'s `finally` (and after the bash call), if the set has that view and `S.view !== view`: remove it and `discardView(view)`.
  - Status line when `s.draft && !S.enhance.has(S.view)`: `Draft · discarded if you leave without sending`.

- [ ] **Step 1: Write the failing tests:**

```js
test('New-session Enhance creates a draft session, moves draft and images, enhances there', async () => {
  // boot hash '#/new' with listing; S.home.prompt = 'fix it'; one attachment staged on 'home:'
  // routes['/quick-start'] → { id: 'n' }; assert body.draft === true && !('prompt' in body) && !body.images
  // assert calls include '/api/commands?session=n', hash === '#/s/n', /enhance body.session === 'n' with images, drafts for 'session:n' = 'fix it'
});
test('leaving a draft for New session or another session discards; Settings does not', async () => {
  // session { id:'d', draft:true }; go('#/settings') → no discard; go('#/s/d'); go('#/new') → one POST {type:'discard'}
});
test('a send in flight defers discard; a failed send discards after it settles', async () => {
  // '/sessions/d/command' prompt route returns a deferred; press Enter; go('#/new') → no discard yet;
  // reject the deferred → exactly one discard call afterwards. Repeat with a resolving send → still one discard call (server decides).
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** `node --test tests/*.test.mjs` → all pass.
- [ ] **Step 5: Commit** `git commit -am "Enhance: start a draft session from New session; discard it on leave"`.

---

### Task 6: Docs and live smoke

**Files:**
- Modify: `README.md`: Features "Smart composer" bullet (one clause) and a short paragraph after the ghost-text paragraph:
  - what Enhance reads;
  - the `enhance` role in *Settings › modelRoles*;
  - Undo;
  - the draft-session rule;
  - cost/latency: one model call with up to 6 file lookups.

- [ ] **Step 1:** Write the README text.
- [ ] **Step 2: Smoke run.** Start an isolated, loopback-only companion: `OMP_WEB_HOST=127.0.0.1 OMP_WEB_NO_TOKEN= OMP_WEB_DATA_DIR=<tmp> OMP_WEB_PORT=4599 OMP_WEB_NO_OPEN=1 node companion/server.mjs`. Then run spec §7 smoke items 1–6 in a browser tab. Expected: each observed and screenshotted.
  - Item 4: set `modelRoles.enhance` to a bogus model, then restore the user's config afterwards.
  - Item 6: in a scratch git repo under `%TEMP%`, never in a user project.
  - **Lockdown check (required)** against the real OMP, with the overlay file the companion wrote. In a scratch repo containing `note.txt` and an `AGENTS.md` sentinel, pipe a prompt asking the model to:
    1. create `probe.txt`;
    2. save a managed skill `enh-probe-skill`;
    3. call any MCP or device tool;
    4. read `note.txt`;
    5. quote the sentinel;
    6. list its tools.

    Expected:
    - the only `tool_execution_start` names are `read`/`grep`/`glob`;
    - `probe.txt` absent;
    - no `enh-probe-skill` under `~/.omp/agent/managed-skills`;
    - no `MCP server` lines on stderr;
    - a project `.mcp.json` whose server writes a marker file leaves no marker;
    - the sentinel is quoted.

    Delete the scratch repo and any probe skill afterwards.
- [ ] **Step 3: Clean up:**
  - the temp data dir and scratch repo;
  - any `~/.omp/agent/sessions/-tmp-…` folder the smoke created;
  - the restored `modelRoles`.
- [ ] **Step 4: Commit** `git commit -am "Document Enhance prompt"`.
