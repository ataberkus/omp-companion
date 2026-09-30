// OMP Control Room: sessions in the sidebar, the conversation in the middle, one composer that knows what "continue" means.
(() => {
  'use strict';
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
  const norm = p => String(p || '').replace(/\//g, '\\').toLowerCase();
  const ago = iso => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(s)) return '';
    if (s < 45) return 'now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    if (s < 86400 * 7) return Math.round(s / 86400) + 'd';
    return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  };
  const clock = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }; // numeric only, so the system's 12/24h choice stays
  // Bounded memo: a hit moves the key to the newest end, the oldest entry falls out past `cap`.
  function memo(cache, key, fn, cap = 400) {
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
    const v = fn();
    cache.set(key, v);
    if (cache.size > cap) cache.delete(cache.keys().next().value);
    return v;
  }
  const trim = (map, cap) => { while (map.size > cap) map.delete(map.keys().next().value); };
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmtTokens = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
  const STATUS = { queued: 'Starting', running: 'Working', review: 'Ready for review', paused: 'Idle', error: 'Error', done: 'Done', history: 'OMP history' };

  // ---------- markdown ----------
  const KEYWORDS = 'const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|import|from|export|default|class|extends|new|async|await|def|lambda|fn|pub|struct|enum|impl|trait|use|mut|match|type|interface|true|false|null|undefined|None|True|False|nil|self|this|public|private|protected|static|void|int|char|bool|float|double|auto|namespace|try|catch|except|finally|throw|raise|with|yield|in|of|not|and|or|is|package|func|go|defer|select|echo|then|fi|done|esac|foreach|param';
  const HASH_COMMENT = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|rb|ruby|ps1|powershell|pwsh|r|perl|dockerfile|make|makefile|conf|ini)$/i;
  function highlight(code, lang) {
    if (/^(diff|patch)$/i.test(lang || '')) {
      return code.split('\n').map(l => {
        const cls = l.startsWith('+') ? 'tok-add' : l.startsWith('-') ? 'tok-del' : l.startsWith('@@') ? 'tok-n' : '';
        return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
      }).join('\n');
    }
    const hash = HASH_COMMENT.test(lang || '');
    const re = new RegExp(String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/` + (hash ? String.raw`|#[^\n]*` : '') + String.raw`)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.)*`' + String.raw`)|\b(` + KEYWORDS + String.raw`)\b|\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)\b`, 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n';
      out += `<span class="tok-${cls}">${esc(m[0])}</span>`;
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  }

  function inline(src, breaks) {
    src = String(src).replace(/\u0000/g, ''); // NUL delimits the placeholder slots below
    const slots = [];
    const hold = html => `\u0000${slots.push(html) - 1}\u0000`;
    let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`));
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>`));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, u) => pre + hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = breaks ? s.replace(/\n/g, '<br>') : s.replace(/ {2,}\n/g, '<br>').replace(/\n/g, ' ');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
  }

  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const FENCE = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)/;
  const TABLE_SEP = /^(?=.*\|)\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const indentOf = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const cells = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

  // Rendering is pure in (text, breaks); cache it so every poll doesn't re-parse and re-highlight the whole thread.
  const mdCache = new Map();
  const md = (src, breaks = false) => memo(mdCache, (breaks ? '1' : '0') + String(src ?? ''), () => mdRaw(src, breaks), 800);
  function mdRaw(src, breaks = false) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    let out = '', i = 0;
    const isBlockStart = l => FENCE.test(l) || /^\s{0,3}#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST.test(l) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(FENCE))) {
        const fence = m[1], lang = m[2] || '';
        const body = [];
        i++;
        const close = new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        i++;
        const code = body.join('\n');
        out += `<div class="codeblock"><div class="bar"><span>${esc(lang || 'text')}</span><button class="copy" data-copy>Copy</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
        continue;
      }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out += '<hr>'; i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        const td = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${inline(c)}</${tag}>`;
        out += `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, j) => td('td', r[j] || '', j)).join('')}</tr>`).join('')}</tbody></table></div>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && (lines[i].trim() ? /^\s*>/.test(lines[i]) || !isBlockStart(lines[i]) : /^\s*>/.test(lines[i + 1] || ''))) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        out += `<blockquote>${md(body.join('\n'), breaks)}</blockquote>`;
        continue;
      }
      if (LIST.test(line)) {
        const block = [];
        const baseIndent = indentOf(line);
        const ordered = /\d/.test(line.match(LIST)[2]);
        const sameKind = l => { const m = l.match(LIST); return m && /\d/.test(m[2]) === ordered; };
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            const next = lines[i + 1];
            if (next && (indentOf(next) > baseIndent || (sameKind(next) && indentOf(next) === baseIndent))) { block.push(''); i++; continue; }
            break;
          }
          if (indentOf(l) < baseIndent) break;
          if (indentOf(l) === baseIndent && (LIST.test(l) ? !sameKind(l) : isBlockStart(l))) break;
          block.push(l); i++;
        }
        out += mdList(block, baseIndent, breaks);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i])) && !(lines[i].includes('|') && TABLE_SEP.test(lines[i + 1] || ''))) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out += `<p>${inline(para.join('\n').trim(), breaks)}</p>`;
    }
    return out;
  }
  function mdList(block, baseIndent, breaks) {
    const items = [];
    for (const l of block) {
      const m = l.match(LIST);
      if (m && indentOf(l) <= baseIndent + 1) items.push({ marker: m[2], lines: [m[3]], width: indentOf(l) + m[2].length + 1 });
      else if (items.length) items[items.length - 1].lines.push(l.replace(new RegExp(`^\\s{0,${items[items.length - 1].width}}`), ''));
    }
    const ordered = /\d/.test(items[0]?.marker || '');
    const start = ordered ? parseInt(items[0].marker, 10) : 1;
    const lis = items.map(it => {
      let text = it.lines.join('\n'), cls = '', box = '';
      const t = text.match(/^\[( |x|X)\]\s+/);
      if (t) { cls = ' class="task-item"'; box = `<input type="checkbox" disabled${t[1] === ' ' ? '' : ' checked'} aria-label="${t[1] === ' ' ? 'Not done' : 'Done'}"> `; text = text.slice(t[0].length); }
      let html = md(text, breaks);
      html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      return `<li${cls}>${box}${html}</li>`;
    }).join('');
    return ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${lis}</ol>` : `<ul>${lis}</ul>`;
  }

  // ---------- state & api ----------
  const KEY = 'omp-web-token';
  const S = {
    token: '', store: null, native: [], online: null, filter: 'all', search: '', groupBy: localStorage.getItem('omp-group-by') || 'time',
    previews: new Map(), home: { roots: null, recent: null, listing: null, filter: '', isolate: false, prompt: '' },
    pending: null, attachments: [], editQueue: null, queueOpen: null, busy: false, view: '', lastSig: '', nativeAt: 0,
    models: null, picker: null, nativeChoice: new Map(), expandAll: false,
    bg: new Map(), subs: new Map(), subParent: new Map(), sideOpen: true, sideTab: 'plan', finishedOpen: false, sideCounts: null, ompUpdate: { status: 'idle' },
    noticeSeen: new Map(), cmds: new Map(), cmdsLoading: new Set(), slash: null,
    planBusy: new Set(), planSubmitted: new Set(),
  };
  S.sideOpen = innerWidth > 1100;
  try { const v = localStorage.getItem('omp-side'); if (v && innerWidth > 1100) S.sideOpen = v === '1'; } catch {}
  S.home.model = ''; S.home.thinking = '';
  try { S.expandAll = localStorage.getItem('omp-expand-activity') === '1'; S.diffMode = localStorage.getItem('omp-diff-mode') || ''; } catch {}
  S.advReviews = true; S.advImportant = false;
  try { S.advReviews = localStorage.getItem('omp-adv-reviews') !== '0'; S.advImportant = localStorage.getItem('omp-adv-important') === '1'; } catch {}
  try { S.token = sessionStorage.getItem(KEY) || ''; } catch {}
  const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (hashToken) { S.token = hashToken; try { sessionStorage.setItem(KEY, hashToken); } catch {} history.replaceState(null, '', location.pathname); }

  async function api(p, body, { timeout = 30000 } = {}) {
    if (!S.token) throw Object.assign(new Error('Not connected.'), { auth: true });
    let res;
    try {
      res = await fetch('/api' + p, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) { throw new Error(e.name === 'TimeoutError' ? 'The companion did not answer in time.' : 'The companion is not reachable.'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { setToken(''); throw Object.assign(new Error('The connection token is no longer valid. Open the link printed by the companion.'), { auth: true }); }
    if (!res.ok) throw new Error(data.error || `The companion rejected the request (HTTP ${res.status}).`);
    return data;
  }
  function setToken(t) {
    S.token = t;
    try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch {}
    if (!t) { S.store = null; S.native = []; S.online = null; }
    route();
  }
  function toast(msg, kind = '', action) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    if (kind === 'err') el.setAttribute('role', 'alert');
    el.textContent = msg;
    if (action) { const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label; b.onclick = () => { el.remove(); action.run(); }; el.appendChild(b); }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
  }
  const copy = (text, label = 'Copied') => navigator.clipboard.writeText(text).then(() => toast(label), () => toast('Could not copy', 'err'));

  // ---------- data model ----------
  const panelSessions = () => (S.store?.sessions || []).filter(s => !s.hidden);
  const projectOf = s => S.store?.projects.find(p => p.id === s.projectId);
  const sessionModel = s => s.modelSelector || (s.provider && s.model && s.model !== 'OMP default' ? s.provider + '/' + s.model : '');
  const modelInfo = sel => S.models?.models.find(m => m.selector === sel);
  const modelName = sel => { if (!sel) return ''; const m = modelInfo(sel); return m ? m.name : sel.slice(sel.indexOf('/') + 1); };
  const modelLabel = (sel, thinking) => sel ? modelName(sel) + (thinking && thinking !== 'off' ? ' · ' + thinking : '') : '';
  const archivedKeys = () => new Set(S.store?.archived || []);
  function items() {
    const panel = panelSessions();
    const out = panel.map(s => {
      const p = projectOf(s);
      const model = sessionModel(s);
      return { key: 's:' + s.id, id: s.id, title: s.title, folder: p?.name || base(s.cwd), cwd: p?.path || s.cwd, status: s.status, needsReview: !!s.uiRequests?.length, updatedAt: s.updatedAt, panel: true, model, thinking: s.thinking, text: (s.title + ' ' + (p?.path || s.cwd) + ' ' + (s.prompt || '') + ' ' + model).toLowerCase() };
    });
    const ids = new Set(panel.map(s => s.id));
    for (const n of S.native) {
      if (n.managedId && ids.has(n.managedId)) continue;
      out.push({ key: 'f:' + n.file, file: n.file, title: n.title, folder: base(n.cwd), cwd: n.cwd, status: 'history', updatedAt: n.updatedAt, preview: n.preview, model: n.model || '', thinking: n.thinking, text: (n.title + ' ' + n.cwd + ' ' + n.preview + ' ' + (n.model || '')).toLowerCase() });
    }
    const arch = archivedKeys();
    for (const it of out) it.archived = arch.has(it.key);
    return out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }
  function current() {
    let h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch { /* malformed %-escape: route on the raw hash */ }
    if (h.startsWith('/s/')) return { kind: 'session', id: h.slice(3) };
    if (h.startsWith('/f/')) return { kind: 'native', file: h.slice(3) };
    if (h.startsWith('/sub/')) return { kind: 'sub', file: h.slice(5) };
    if (h.startsWith('/changes/')) return { kind: 'changes', parent: h.slice(9) };
    if (h === '/settings') return { kind: 'settings' };
    return { kind: 'home' };
  }
  const selKey = () => { const c = current(); return c.kind === 'session' ? 's:' + c.id : c.kind === 'native' ? 'f:' + c.file : ''; };
  const itemHash = key => key.startsWith('s:') ? '#/s/' + key.slice(2) : '#/f/' + encodeURIComponent(key.slice(2));
  const openItem = key => { location.hash = itemHash(key); };
  // Plain window.open (no noopener) so the new tab inherits sessionStorage, which holds the token.
  const openItemTab = key => window.open(location.pathname + location.search + itemHash(key), '_blank');
  const closeCtx = () => $('#ctxMenu')?.remove();

  // ---------- sidebar ----------
  function renderList() {
    const list = $('#list');
    if (!S.store) { list.innerHTML = ''; return; }
    const q = S.search.trim().toLowerCase();
    let all = items().filter(it => !q || q.split(/\s+/).every(w => it.text.includes(w)));
    if (S.filter === 'active') all = all.filter(it => it.needsReview || ['running', 'queued', 'review', 'error'].includes(it.status));
    if (S.filter === 'panel') all = all.filter(it => it.panel);
    all = S.filter === 'archived' ? all.filter(it => it.archived) : all.filter(it => !it.archived || it.needsReview || it.status === 'running' || it.status === 'queued');
    const groups = [];
    const add = (label, arr) => arr.length && groups.push([label, arr]);
    const working = all.filter(it => !it.needsReview && (it.status === 'running' || it.status === 'queued'));
    const review = all.filter(it => it.needsReview || it.status === 'review' || it.status === 'error');
    const rest = all.filter(it => !working.includes(it) && !review.includes(it));
    if (S.groupBy === 'project') {
      const by = new Map();
      for (const it of all) (by.get(it.cwd) || by.set(it.cwd, []).get(it.cwd)).push(it);
      for (const arr of by.values()) groups.push([arr[0].folder, arr, arr[0].cwd]);
      groups.sort((a, b) => Math.max(...b[1].map(i => +new Date(i.updatedAt))) - Math.max(...a[1].map(i => +new Date(i.updatedAt))));
    } else {
      add('Working now', working);
      add('Needs your review', review);
      const day = 86400000, startToday = new Date().setHours(0, 0, 0, 0);
      add('Today', rest.filter(it => new Date(it.updatedAt) >= startToday));
      add('Yesterday', rest.filter(it => { const t = new Date(it.updatedAt); return t < startToday && t >= startToday - day; }));
      add('Previous 7 days', rest.filter(it => { const t = new Date(it.updatedAt); return t < startToday - day && t >= startToday - 7 * day; }));
      add('Older', rest.filter(it => new Date(it.updatedAt) < startToday - 7 * day));
    }
    const sel = selKey();
    const html = groups.map(([label, arr, cwd]) => `<div class="group-label"${cwd ? ` title="${esc(cwd)}"` : ''}>${esc(label)}${cwd ? `<span class="gcount">${arr.length}</span>` : ''}</div>` + arr.map(it => `<div class="item-row">
      <button class="item ${it.status === 'history' ? 'history' : ''} ${it.key === sel ? 'sel' : ''}" data-key="${esc(it.key)}" title="${esc(it.title + '\n' + it.cwd)}"${it.key === sel ? ' aria-current="page"' : ''}>
        <span class="dot ${it.needsReview ? 'review' : it.status}"></span><span class="t">${esc(it.title)}</span><span class="ago">${esc(ago(it.updatedAt))}</span>
        <span></span><span class="m">${esc(it.folder)}${it.status !== 'history' ? ' · ' + esc(it.needsReview ? 'Waiting for answer' : STATUS[it.status] || it.status) : ''}${it.model ? ` · <span class="mdl">${esc(modelLabel(it.model, it.thinking))}</span>` : ''}</span>
      </button>${it.status === 'running' || it.status === 'queued' ? '' : `<button type="button" class="arch" data-archive="${esc(it.key)}" data-restore="${it.archived ? '1' : ''}" title="${it.archived ? 'Restore to sidebar' : 'Archive'}" aria-label="${it.archived ? 'Restore to sidebar' : 'Archive'}: ${esc(it.title)}">${it.archived ? ICON_RESTORE : ICON_ARCHIVE}</button>`}</div>`).join('')).join('') || `<div class="empty-list">${q ? 'No sessions match your search.' : S.filter === 'archived' ? 'No archived sessions.' : 'No sessions yet. Start one with “New session”.'}</div>`;
    setIfChanged(list, html); // rebuilding every poll would reset hover, focus and scroll
    document.querySelectorAll('#filters [data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === S.filter)));
    $('#groupBy')?.setAttribute('aria-pressed', String(S.groupBy === 'project'));
    $('#conn').className = 'conn ' + (S.online ? 'on' : S.online === false ? 'off' : '');
    $('#conn').title = S.online ? 'Connected to the local companion' : 'Companion not reachable';
  }

  const ICON_ARCHIVE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  const ICON_RESTORE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  async function setArchived(key, archived, undoable = true) {
    const prev = S.store.archived || [];
    S.store.archived = archived ? [...new Set([...prev, key])] : prev.filter(k => k !== key);
    renderList(); if (current().kind === 'home') renderHome();
    try {
      S.store.archived = (await api('/archive', { key, archived })).archived;
      renderList();
      if (undoable) toast(archived ? 'Session archived' : 'Session restored', '', { label: 'Undo', run: () => setArchived(key, !archived, false) });
    } catch (e) { S.store.archived = prev; renderList(); toast(e.message, 'err'); }
  }

  // ---------- views ----------
  const main = () => $('#main');
  function route() {
    document.getElementById('app').classList.remove('nav-open');
    if (!S.token) return renderConnect();
    const c = current();
    const view = c.kind + ':' + (c.id || c.file || c.parent || '');
    if (view !== S.view) {
      S.view = view; S.lastSig = ''; S.sideCounts = null; S.slash = null; build(c);
      // Per-file caches only matter for recently viewed sessions; keep them bounded.
      trim(S.previews, 20); trim(S.subs, 30); trim(S.bg, 30); trim(S.advTx, 60); trim(groupOpen, 2000); trim(rowOpen, 2000);
    }
    if (!S.models && !S.modelsLoading) { S.modelsLoading = true; ensureModels().then(() => { S.lastSig = ''; renderList(); update(); if (current().kind === 'home') renderHome(); }).catch(() => {}).finally(() => { S.modelsLoading = false; }); }
    update();
    renderList();
  }
  function build(c) {
    if (c.kind === 'home') return buildHome();
    if (c.kind === 'settings') return buildSettings();
    main().innerHTML = `
      <div class="topbar" id="topbar"></div>
      <div class="chat-plan" id="chatPlan" hidden></div>
      <div class="body"><div class="scroller" id="scroller"><div class="thread" id="thread"></div></div><aside class="tasks" id="tasks" hidden></aside></div>
      <div class="composer-wrap">
        <div class="extras" id="extras" hidden></div>
        <div class="questions" id="questions" aria-live="polite" hidden></div>
        <div class="queued-messages" id="queued" hidden></div>
        <div class="status-line" id="statusLine"></div>
        <div class="slash" id="slash" role="listbox" aria-label="Slash commands" hidden></div>
        <div class="composer">
          <textarea id="input" rows="1" aria-label="Message OMP" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list" aria-controls="slash"></textarea>
          <input id="imageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
          <div class="attach-preview" id="imagePreview" hidden></div>
          <div class="composer-bar"><span id="modelSlot"></span><button class="btn sm ghost attach-btn" data-act="attach" type="button" aria-label="Attach image" title="Attach image">＋ Image</button><span class="hint" id="hint"></span><span id="buttons" style="display:flex;gap:6px"></span></div>
        </div>
      </div>`;
    const input = $('#input');
    input.value = drafts.get(S.view) || '';
    autosize(input);
    if (c.kind === 'native' && !S.previews.has(c.file)) loadPreview(c.file);
    if (c.kind === 'sub') { $('.composer').hidden = true; loadSub(c.file, true); return; }
    if (c.kind === 'changes') { $('.composer-wrap').hidden = true; $('#thread').classList.add('wide'); return; }
    loadBg(bgFile(), true);
    setTimeout(() => { if ($('#questions')?.hidden) input.focus(); }, 0);
  }
  const drafts = new Map();
  const autosize = el => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px'; };

  async function loadPreview(file) {
    try { S.previews.set(file, await api('/omp-sessions/preview?file=' + encodeURIComponent(file))); }
    catch (e) { S.previews.set(file, { error: e.message, messages: [] }); }
    S.lastSig = ''; update();
  }

  function update() {
    const c = current();
    if (!S.token || c.kind === 'home' || c.kind === 'settings') return;
    if (c.kind === 'sub') { loadSub(c.file); renderSub(c.file); return; }
    if (c.kind === 'changes') { if (S.store) renderChanges(c); return; }
    if (!S.store) { $('#thread').innerHTML = '<div class="working"><span class="spinner"></span> Loading…</div>'; return; }
    loadBg(bgFile());
    if (c.kind === 'session') {
      const s = S.store.sessions.find(x => x.id === c.id);
      if (!s) { $('#thread').innerHTML = '<div class="history-note">This session is not in the panel anymore.</div>'; $('#topbar').innerHTML = ''; return; }
      renderChatPlan(s);
      renderSide(s);
      renderTopbarSession(s);
      loadAdvisorTx(s.sessionFile || '');
      renderThread(withAdvisor(s.messages, s.sessionFile), s.status, s.id, { compacting: s._compacting, lastActivityAt: s.lastActivityAt, retry: s._retry, task: s._task });
      renderExtras(s);
      showNotices(s);
      renderQuestions(s);
      renderQueue(s);
      renderComposer(s);
    } else {
      const n = S.native.find(x => x.file === c.file);
      const pv = S.previews.get(c.file);
      const managed = n?.managedId && panelSessions().find(s => s.id === n.managedId);
      if (managed) { location.replace('#/s/' + managed.id); return; }
      renderSide(null);
      renderChatPlan(null);
      renderTopbarNative(n, pv, c.file);
      if (!pv) $('#thread').innerHTML = '<div class="working"><span class="spinner"></span> Reading session history…</div>';
      else if (pv.error) $('#thread').innerHTML = `<div class="msg system err"><div class="bubble">${esc(pv.error)}</div></div>`;
      else { loadAdvisorTx(c.file); renderThread(withAdvisor(pv.messages, c.file), 'history', c.file); }
      renderExtras(null);
      renderQuestions(null);
      renderQueue(null);
      renderComposer(null, n || pv);
    }
  }

  // Typing only changes the composer (send button, hints); leave the thread and panels alone.
  function updateComposer() {
    const c = current();
    if (c.kind === 'session') { const s = S.store?.sessions.find(x => x.id === c.id); if (s) renderComposer(s); }
    else if (c.kind === 'native') renderComposer(null, S.native.find(x => x.file === c.file) || S.previews.get(c.file));
  }

  function contextMeta(tokens, win, pct) {
    if (typeof pct !== 'number' && tokens && win) pct = tokens / win * 100;
    if (typeof pct !== 'number' && !tokens) return '';
    const p = typeof pct === 'number' ? Math.min(100, Math.max(0, pct)) : null;
    const tip = `Context: ${tokens ? fmtTokens(tokens) : '?'}${win ? ' of ' + fmtTokens(win) : ''} tokens`;
    return `<span class="ctx ${p >= 85 ? 'hot' : p >= 65 ? 'warm' : ''}" title="${tip}">${p != null ? `<i><b style="width:${p.toFixed(1)}%"></b></i>${Math.round(p)}%` : 'context'} ${tokens ? fmtTokens(tokens) : ''}${win ? ' / ' + fmtTokens(win) : ''}</span>`;
  }
  function metaHtml(cwd, extra) {
    return `<div class="meta"><span class="path" data-copy-text="${esc(cwd)}" title="Copy ${esc(cwd)}">${esc(cwd)}</span>${extra}</div>`;
  }
  function renderTopbarSession(s) {
    const p = projectOf(s);
    const extra = [
      `<span class="pill ${s.status}">${s.status === 'running' ? '<span class="spinner" style="width:10px;height:10px"></span>' : ''}${esc(STATUS[s.status] || s.status)}</span>`,
      s.branch && s.branch !== 'workspace' ? `<span>⎇ ${esc(s.branch)}${s.isolated ? ' (worktree)' : ''}</span>` : '',
      sessionModel(s) ? `<span class="mdl-meta" data-act="model" title="Change model">◆ ${esc(modelLabel(sessionModel(s), s.thinking))}</span>` : '',
      s.tokens ? `<span>${fmtTokens(s.tokens)} tokens${s.cost ? ' · $' + s.cost.toFixed(2) : ''}</span>` : '',
      contextMeta(s.contextTokens, s.contextWindow || modelInfo(sessionModel(s))?.contextWindow, s.contextPercent),
      s.status === 'running' && s.tps ? `<span title="Output speed">${s.tps.toFixed(0)} tok/s</span>` : '',
      s.fast?.active ? '<span class="pill" title="Fast mode is active">⚡ Fast</span>' : '',
      s.goal?.objective ? `<span class="goal" title="${esc(`Goal (${s.goal.status}): ${s.goal.objective}`)}">🎯 ${esc(s.goal.objective.slice(0, 60))}</span>` : '',
    ].join('');
    const btn = [changesButton(s.messages, 's:' + s.id), sideButton()];
    if (s.status === 'running' || s.status === 'queued') btn.push(`<button class="btn sm danger" data-act="abort" aria-label="Stop">■ <span class="lbl">Stop</span></button>`);
    if (['review', 'paused', 'error'].includes(s.status) && s.messages.some(m => m.role === 'user')) btn.push(`<button class="btn sm" data-act="complete" aria-label="Mark done">✓ <span class="lbl">Mark done</span></button>`);
    const idle = s.status !== 'running' && s.status !== 'queued';
    const pref = (key, on, label, yes = true, no = false) => `<button data-pref="${key}" data-value="${esc(JSON.stringify(on ? no : yes))}" role="menuitemcheckbox" aria-checked="${!!on}"><span class="check">${on ? '✓' : ''}</span>${esc(label)}</button>`;
    const html = `<button class="btn sm ghost menu-btn" data-act="nav" aria-label="Open navigation">☰</button>
      <div class="title-block"><h1 title="${esc(s.title)}">${esc(s.title)}</h1>${metaHtml(p?.path || s.cwd, extra)}</div>
      <div class="actions">${btn.join('')}
        <div class="menu"><button class="btn sm ghost" data-act="menu" aria-label="More">⋯</button><div class="menu-pop">
          <button data-act="newHere">New session in this folder</button>
          <button data-copy-text="${esc(s.cwd)}">Copy working directory</button>
          ${s.sessionFile ? `<button data-copy-text="${esc(s.sessionFile)}">Copy OMP session file path</button>` : ''}
          ${s.sessionFile ? `<button data-copy-text="omp --resume &quot;${esc(s.sessionFile)}&quot;">Copy terminal resume command</button>` : ''}
          <button data-act="expandAll">${S.expandAll ? 'Collapse' : 'Expand'} tool activity by default</button>
          ${idle ? '<button data-act="compact">Compact context</button>' : ''}
          <button data-act="rename">Rename session…</button>
          ${idle ? '<button data-act="branch">Branch from an earlier message…</button><button data-act="handoff">Hand off to a fresh session…</button>' : ''}
          <button data-act="export">Export as HTML</button>
          <button data-act="stats">Session stats</button>
          <div class="menu-sep"></div>
          ${pref('fast', s.fast?.enabled, 'Fast mode')}
          ${pref('autoCompaction', s.autoCompaction !== false, 'Auto-compact when context is full')}
          ${pref('autoRetry', s.prefs?.autoRetry !== false, 'Retry failed requests automatically')}
          ${pref('steeringMode', s.modes?.steering === 'all', 'Deliver all steers at once', 'all', 'one-at-a-time')}
          ${pref('interruptMode', s.modes?.interrupt === 'wait', 'Hold steers until the turn ends', 'wait', 'immediate')}
          <div class="menu-sep"></div>
          <button data-act="login">Log in to a provider…</button>
          ${idle ? '<button class="danger" data-act="hide">Remove from panel</button>' : ''}
        </div></div>
      </div>`;
    setIfChanged($('#topbar'), html);
  }
  function renderTopbarNative(n, pv, file) {
    const title = n?.title || pv?.title || 'OMP session';
    const cwd = n?.cwd || pv?.cwd || '';
    const html = `<button class="btn sm ghost menu-btn" data-act="nav" aria-label="Open navigation">☰</button>
      <div class="title-block"><h1 title="${esc(title)}">${esc(title)}</h1>${metaHtml(cwd, `<span class="pill">OMP history</span>${n?.model ? `<span>◆ ${esc(modelLabel(n.model, n.thinking))}</span>` : ''}${contextMeta(pv?.contextTokens, modelInfo(n?.model || pv?.model)?.contextWindow)}${n ? `<span>last active ${esc(ago(n.updatedAt))} ago</span>` : ''}`)}</div>
      <div class="actions">${changesButton(pv?.messages || [], 'f:' + file)}${sideButton()}
        <button class="btn sm" data-act="newHere" aria-label="New session here">＋ <span class="lbl">New here</span></button>
        <div class="menu"><button class="btn sm ghost" data-act="menu" aria-label="More">⋯</button><div class="menu-pop">
          <button data-act="resumeOnly">Add to panel without a message</button>
          <button data-act="expandAll">${S.expandAll ? 'Collapse' : 'Expand'} tool activity by default</button>
          <button data-copy-text="${esc(cwd)}">Copy working directory</button>
          <button data-copy-text="${esc(file)}">Copy OMP session file path</button>
          <button data-copy-text="omp --resume &quot;${esc(file)}&quot;">Copy terminal resume command</button>
        </div></div>
      </div>`;
    setIfChanged($('#topbar'), html);
  }
  function setIfChanged(el, html) {
    if (el._html === html) return;
    const open = el.querySelector('.menu.open');
    swapHtml(el, html); el._html = html;
    if (open) el.querySelector('.menu')?.classList.add('open');
  }
  // Rebuilding innerHTML resets scroll offsets and <details> the renderers don't track themselves.
  // Carry them over, keyed by the nearest keyed ancestor plus the child-index path below it.
  const touched = new Set();
  const ANCHORS = ['rid', 'gid', 'remember', 'key'];
  function uiKey(root, n) {
    const path = [];
    for (; n && n !== root; n = n.parentElement) {
      const a = ANCHORS.find(k => n.dataset[k] != null);
      if (a) return { a, v: n.dataset[a], path };
      path.unshift([...n.parentElement.children].indexOf(n));
    }
    return { path };
  }
  function swapHtml(el, html) {
    const keep = [];
    for (const n of touched) {
      if (!n.isConnected) { touched.delete(n); continue; }
      if (el.contains(n) && n !== el) keep.push({ ...uiKey(el, n), top: n.scrollTop, left: n.scrollLeft, open: n.tagName === 'DETAILS' ? n.open : null });
    }
    el.innerHTML = html;
    for (const k of keep) {
      let n = k.a ? el.querySelector(`[data-${k.a}="${CSS.escape(k.v)}"]`) : el;
      for (const i of k.path) n = n?.children[i];
      if (!n) continue;
      if (k.open != null && n.tagName === 'DETAILS') n.open = k.open;
      n.scrollTop = k.top; n.scrollLeft = k.left;
      touched.add(n);
    }
  }

  // ---------- activity: tool calls and thinking ----------
  // Legacy server records look like "name  {args}" or "Done · name  output" / "Error · name  output".
  function parseTool(text) {
    const m = text.match(/^(Done|Error) · (\S+)\s{2}([\s\S]*)$/);
    if (m) return { kind: 'result', ok: m[1] === 'Done', name: m[2], body: m[3] };
    const i = text.indexOf('  ');
    return { kind: 'call', name: i > 0 ? text.slice(0, i) : text, body: i > 0 ? text.slice(i + 2) : '' };
  }
  const baseName = p => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const line1 = x => String(x || '').split('\n')[0];
  // One-line past-tense description of a tool call: k = summary bucket, v = verb, b = bold object, d = plain detail, c = code detail.
  function toolLine(t, a) {
    const n = t.name, p = a && (a.path || a.file_path || a.file || a.filePath), files = realFiles(t);
    if (n === 'read' && p) return { k: 'read', v: 'Read', b: baseName(p).replace(/:.*$/, ''), keys: [String(p).replace(/(?<=[^\\/]):[^\\/]*$/, '')] };
    if (files.length) return { k: 'edit', v: 'Edited', b: [...new Set(files.map(f => baseName(f.path)))].join(', '), keys: files.map(f => f.path) };
    if (['grep', 'glob', 'find'].includes(n)) return { k: 'search', v: 'Searched', d: line1(a?.pattern || a?.query || a?.path) };
    if (n === 'web_search') return { k: 'web', v: 'Searched the web for', d: line1(a?.query) };
    if (n === 'bash') return { k: 'run', v: 'Ran', c: line1(a?.command) };
    if (n === 'eval') return { k: 'run', v: 'Ran code', d: t.intent };
    if (n === 'task') return { k: 'task', v: 'Delegated', b: keyArg(n, a) || 'a task' };
    const verb = { todo: 'Updated the plan', write: 'Wrote', ask: 'Asked', fetch: 'Fetched', web_fetch: 'Fetched', wait: 'Waited' }[n];
    return verb ? { k: 'other', v: verb, d: t.intent || keyArg(n, a), name: n } : { k: 'other', v: 'Used', b: n, d: t.intent || keyArg(n, a), name: n };
  }
  const plural = (n, one, many) => n === 1 ? one : `${n} ${many}`;
  function groupPhrase(lines) {
    const by = new Map();
    for (const l of lines) { if (!by.has(l.k)) by.set(l.k, []); by.get(l.k).push(l); }
    const uniq = ls => new Set(ls.flatMap(l => l.keys)).size;
    const text = [...by].map(([k, ls]) => ({
      think: 'thought',
      search: 'searched code',
      web: 'searched the web',
      read: `read ${plural(uniq(ls), '1 file', 'files')}`,
      edit: `edited ${plural(uniq(ls), '1 file', 'files')}`,
      run: `ran ${plural(ls.length, 'a command', 'commands')}`,
      task: `delegated ${plural(ls.length, 'a task', 'tasks')}`,
      other: `used ${[...new Set(ls.map(l => l.name))].join(', ')}`,
    })[k]).join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  const fmtMs = ms => !ms && ms !== 0 ? '' : ms < 1000 ? ms + 'ms' : ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's';
  const argsCache = new Map();
  const parseArgs = s => { if (s && typeof s === 'object') return s; return memo(argsCache, String(s), () => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } }); };
  const shortPath = p => { const parts = String(p).split(/[\\/]/).filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : String(p); };
  function keyArg(name, a) {
    if (!a) return '';
    const p = a.path || a.file_path || a.file || a.filePath;
    if (p) return shortPath(p);
    if (typeof a.command === 'string') return a.command.split('\n')[0];
    if (Array.isArray(a.tasks)) return a.tasks.map(t => t?.name).filter(Boolean).join(', ');
    for (const k of ['pattern', 'query', 'url', 'glob', 'code', 'op', 'id']) if (typeof a[k] === 'string') return a[k].split('\n')[0];
    return '';
  }
  const extLang = p => (String(p || '').match(/\.(\w+)$/) || [])[1] || '';
  const looksDiff = s => /^(@@|[-+]{3} |\*\*\* Begin Patch)/m.test(s) && /^[-+]/m.test(s);
  function codeBox(label, code, lang, extra = '') {
    return `<div class="codeblock"><div class="bar"><span>${esc(label)}</span>${extra}<button class="copy" data-copy>Copy</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
  }
  function toolBody(t, a) {
    const out = [];
    const files = realFiles(t);
    for (const f of files) out.push(fileDiff(f));
    if (a) {
      const small = [];
      for (const [k, v] of Object.entries(a)) {
        if (k === 'i' || k === 'intent' || v === undefined || v === '') continue;
        if (files.length && (k === 'content' || (t.name === 'edit' && typeof v === 'string' && v.includes('\n')))) { out.push(`<details class="raw"><summary>Raw ${esc(k)}</summary>${codeBox(k, v, looksDiff(v) ? 'diff' : '')}</details>`); continue; }
        if (files.length && (k === 'path' || k === 'file_path')) continue;
        if (k === 'command' && typeof v === 'string') { out.push(codeBox(t.name === 'eval' ? 'code' : 'command', v, t.name === 'bash' ? 'bash' : '', a.async ? '<span class="tag">background</span>' : '')); continue; }
        if (k === 'tasks' && Array.isArray(v)) {
          out.push(`<div class="subtasks">${v.map(x => `<div class="subtask"><div><b>${esc(x?.name || 'task')}</b>${x?.description ? ` <span class="muted">${esc(x.description)}</span>` : ''}</div><button class="btn sm ghost" data-subname="${esc(x?.name || '')}">Open subagent →</button></div>`).join('')}</div>`);
          continue;
        }
        if (typeof v === 'string' && (v.includes('\n') || v.length > 120)) {
          const lang = /diff|patch/i.test(k) || looksDiff(v) || (t.name === 'edit' && /^[-+]/m.test(v)) ? 'diff' : extLang(a.path || a.file_path);
          out.push(codeBox(k, v, lang));
          continue;
        }
        if (v && typeof v === 'object') { out.push(codeBox(k, JSON.stringify(v, null, 2), 'json')); continue; }
        small.push(`<span><i>${esc(k)}</i> ${esc(String(v))}</span>`);
      }
      if (small.length) out.unshift(`<div class="kv">${small.join('')}</div>`);
    } else if (t.args && t.args !== '{}') out.push(codeBox('arguments', t.args, 'json'));
    if (t.result && !(files.length && t.status !== 'error')) out.push(`<div class="result ${t.status === 'error' ? 'bad' : ''}"><div class="bar"><span>${t.status === 'error' ? 'Error' : 'Output'}</span></div><pre>${looksDiff(t.result) ? highlight(t.result, 'diff') : esc(t.result)}</pre></div>`);
    if (t.result && files.length && t.status !== 'error') out.push(`<details class="raw"><summary>Tool output</summary><pre class="fd-raw">${esc(t.result)}</pre></details>`);
    return out.join('') || '<div class="muted" style="padding:4px 0">No details.</div>';
  }
  // Group state survives re-renders; values only exist when the user overrides the default.
  const groupOpen = new Map(), rowOpen = new Map(), bodyCache = new Map();
  const thinkTitle = text => {
    const line = String(text).split('\n').map(l => l.replace(/[*_#`>]/g, '').trim()).find(Boolean) || 'Thinking';
    return line.length > 110 ? line.slice(0, 110) + '…' : line;
  };
  function activityRow(m, live, lastInLive, L) {
    const rid = m.id;
    if (m.role === 'thinking') {
      const def = live && lastInLive;
      const open = rowOpen.has(rid) ? rowOpen.get(rid) : def;
      return `<details class="row think" data-rid="${esc(rid)}" data-def="${def ? 1 : 0}" ${open ? 'open' : ''}>
        <summary><span class="ln">Thought <span class="ds">${esc(thinkTitle(m.text))}</span></span>${def ? '<span class="spinner"></span>' : ''}</summary>
        <div class="row-body md thought">${md(m.text)}</div></details>`;
    }
    const t = m.tool;
    const a = parseArgs(t.args);
    const running = t.status === 'running' && live;
    const bad = t.status === 'error';
    const edits = realFiles(t).length ? diffStat(realFiles(t)) : null;
    const def = !!edits;
    const open = rowOpen.has(rid) ? rowOpen.get(rid) : def;
    const bg = a?.async === true;
    const tip = [t.intent, t.ms ? fmtMs(t.ms) : ''].filter(Boolean).join(' · ');
    return `<details class="row tool ${bad ? 'bad' : ''} ${edits ? 'edit' : ''}" data-rid="${esc(rid)}" data-def="${def ? 1 : 0}" ${open ? 'open' : ''}>
      <summary title="${esc(tip)}"><span class="ln">${esc(L.v)}${L.b ? ` <b>${esc(L.b)}</b>` : ''}${L.d ? ` <span class="ds">${esc(L.d)}</span>` : ''}${L.c ? ` <code>${esc(L.c.slice(0, 120))}</code>` : ''}</span>
      ${bg ? '<span class="tag">background</span>' : ''}${edits ? `<span class="fd-stat"><span class="plus">+${edits.adds}</span> <span class="minus">−${edits.dels}</span></span>` : ''}${running ? '<span class="spinner"></span>' : bad ? '<span class="bad">✕</span>' : ''}</summary>
      <div class="row-body">${memo(bodyCache, [rid, t.status, t.args?.length, t.result?.length, realFiles(t).map(f => f.path + ':' + (f.diff?.length || 0)).join(), diffMode()].join('|'), () => toolBody(t, a), 300)}</div></details>`;
  }
  function legacyTools(group) {
    // Pair legacy "call"/"result" text records into tool objects.
    const out = [];
    for (const g of group) {
      if (g.tool || g.role === 'thinking') { out.push(g); continue; }
      const p = parseTool(g.text || '');
      if (p.kind === 'result') {
        const call = [...out].reverse().find(x => x.tool && x.tool.name === p.name && !x.tool.result);
        if (call) { call.tool = { ...call.tool, result: p.body, status: p.ok ? 'done' : 'error' }; continue; }
        out.push({ ...g, tool: { name: p.name, intent: '', args: '', result: p.body, status: p.ok ? 'done' : 'error' } });
      } else out.push({ ...g, tool: { name: p.name, intent: '', args: p.body, status: 'done' } });
    }
    return out;
  }
  function activityBlock(group, live) {
    const rows = legacyTools(group);
    const gid = group[0].id;
    const lines = rows.map(r => r.tool ? toolLine(r.tool, parseArgs(r.tool.args)) : { k: 'think' });
    const failed = rows.filter(r => r.tool?.status === 'error').length;
    const changed = rows.flatMap(r => realFiles(r.tool));
    const cst = changed.length ? diffStat(changed) : null;
    const lastRow = rows[rows.length - 1];
    const now = live ? (lastRow.tool ? (lastRow.tool.intent || keyArg(lastRow.tool.name, parseArgs(lastRow.tool.args)) || lastRow.tool.name) : 'Thinking') : '';
    const def = S.expandAll || live;
    const open = groupOpen.has(gid) ? groupOpen.get(gid) : def;
    return `<details class="activity ${live ? 'live' : ''}" data-gid="${esc(gid)}" data-def="${def ? 1 : 0}" ${open ? 'open' : ''}>
      <summary>${live ? '<span class="spinner"></span>' : ''}<span class="lbl">${esc(groupPhrase(lines))}</span>${cst ? `<span class="fd-stat" title="${esc([...new Set(changed.map(f => f.path))].join('\n'))}"><span class="plus">+${cst.adds}</span> <span class="minus">−${cst.dels}</span></span>` : ''}${failed ? `<span class="bad">${failed} failed</span>` : ''}${live ? `<span class="now">${esc(now)}</span>` : ''}</summary>
      <div class="rows">${rows.map((r, j) => activityRow(r, live, j === rows.length - 1, lines[j])).join('')}</div></details>`;
  }

  function renderThread(messages, status, ownerId, opts = {}) {
    const pending = S.pending && S.pending.view === S.view && !S.pending.queued ? S.pending : null;
    const last = messages[messages.length - 1];
    const runningTools = messages.reduce((n, m) => n + (m.tool?.status === 'running' ? 1 : 0), 0);
    const liveOutput = messages.reduce((n, m) => n + (m.tool?.status === 'running' ? m.tool.result?.length || 0 : 0), 0);
    const steers = messages.filter(m => m.steer).map(m => m.id + m.steer).join();
    // Seconds since OMP last reported anything; bucketed so the quiet-turn notice ticks without re-rendering every poll.
    const idle = status === 'running' && opts.lastActivityAt ? Math.max(0, (Date.now() - new Date(opts.lastActivityAt)) / 1000) : 0;
    const sig = [ownerId, messages.length, last?.id, last?.text?.length, last?.tool?.status, runningTools, liveOutput, steers, status, opts.compacting, opts.retry?.attempt, opts.task, idle >= 20 ? Math.floor(idle / 10) : 0, pending?.text, pending?.imagePreview?.length, S.expandAll, diffMode(), S.advReviews, S.advImportant, opts.extra || ''].join('|');
    if (sig === S.lastSig) return;
    S.lastSig = sig;
    const scroller = $('#scroller');
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160 || !$('#thread').children.length;
    const parts = [];
    if (opts.head) parts.push(opts.head);
    else if (status === 'history') parts.push(`<div class="history-note">📜 Saved OMP session. Type below to continue it here. It picks up exactly where it left off.</div>`);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.adv) {
        const group = [];
        while (i < messages.length && messages[i].adv) group.push(messages[i++]);
        i--;
        parts.push(advisorReview(group));
        continue;
      }
      if (m.role === 'tool' || m.role === 'thinking') {
        const group = [];
        while (i < messages.length && !messages[i].adv && (messages[i].role === 'tool' || messages[i].role === 'thinking')) group.push(messages[i++]);
        i--;
        parts.push(activityBlock(group, status === 'running' && i === messages.length - 1));
        continue;
      }
      if (m.role === 'system') {
        const err = /error|fail|could not|cannot|not running|timed out|exited/i.test(m.text);
        parts.push(`<div class="msg system ${err ? 'err' : ''}"><div class="bubble">${esc(m.text)}</div></div>`);
        continue;
      }
      if (m.role === 'advisor') {
        const shown = (m.notes || []).filter(n => !S.advImportant || n.severity === 'concern' || n.severity === 'blocker');
        for (const note of shown) {
          const level = ['nit', 'concern', 'blocker'].includes(note.severity) ? note.severity : 'nit';
          parts.push(`<div class="msg advisor ${level}"><div class="who">Advisor${note.advisor ? ' · ' + esc(note.advisor) : ''}<span class="severity">${esc(level)}</span><time>${esc(clock(m.at))}</time></div><div class="bubble md">${md(note.note)}</div></div>`);
        }
        continue;
      }
      if (m.role === 'advisor-update') {
        parts.push(`<details class="advisor-update" data-key="upd:${esc(m.id)}"><summary>Session update <time>${esc(clock(m.at))}</time></summary><div class="md">${md(m.text)}</div></details>`);
        continue;
      }
      const user = m.role === 'user';
      const image = m.imagePreview ? images(m.imagePreview) : m.hasImage ? '<span class="msg-image-label">Image attached</span>' : '';
      const steer = user && m.steer === 'pending' ? '<span class="steer-state" title="OMP reads steers at the next tool or turn boundary">Steering · waiting for OMP</span>'
        : user && m.steer === 'dropped' ? '<span class="steer-state dropped" title="The turn ended before OMP read this steer">Not delivered</span>' : '';
      parts.push(`<div class="msg ${user ? 'user' : 'assistant'}${m.steer ? ' steer-' + esc(m.steer) : ''}" data-key="msg:${esc(m.id)}"><div class="who">${user ? 'You' : esc(opts.speaker || 'OMP')}${!user && m.model ? `<span class="who-model">${esc(modelName(m.model))}</span>` : ''}${steer}<time>${esc(clock(m.at))}</time></div>
        <div class="bubble md">${m.hasImage && m.text === 'Image attached' ? '' : md(m.text, user)}${image}</div></div>`);
    }
    if (pending && !messages.some(m => m.role === 'user' && m.text === pending.text && new Date(m.at) >= pending.at - 5000)) {
      parts.push(`<div class="msg user"><div class="who">You<time>sending…</time></div><div class="bubble md">${pending.text ? md(pending.text, true) : ''}${images(pending.imagePreview)}</div></div>`);
    }
    if (opts.compacting || opts.task || opts.retry || (status === 'running' && ((last?.role !== 'tool' && last?.role !== 'thinking') || idle >= 20)) || status === 'queued' || (pending && status !== 'history')) {
      let label = opts.task ? esc(opts.task) : opts.compacting ? 'Compacting context…' : status === 'queued' || pending ? 'Starting OMP…' : 'OMP is working…';
      if (opts.retry) label = `Retrying after an error (attempt ${+opts.retry.attempt} of ${+opts.retry.maxAttempts})${opts.retry.error ? ': ' + esc(opts.retry.error.slice(0, 200)) : ''} <button class="btn sm ghost" data-act="abortRetry">Stop retrying</button>`;
      if (!opts.compacting && !opts.retry && !opts.task && !pending && status === 'running' && idle >= 20) {
        const waitingOn = runningTools ? `Running ${runningTools === 1 ? 'a tool' : runningTools + ' tools'}` : last?.role === 'tool' ? 'Waiting for the model after the last tool call' : 'Waiting for the model';
        label = `${waitingOn} · no activity for ${idle < 60 ? Math.floor(idle) + 's' : Math.floor(idle / 60) + 'm ' + Math.floor(idle % 60) + 's'}`;
      }
      parts.push(`<div class="working${idle >= 120 && status === 'running' ? ' quiet' : ''}" role="status" title="${idle >= 120 ? 'OMP has not reported anything for a while. It may be waiting on a slow model response. Press Stop and resend if it never recovers.' : ''}"><span class="spinner"></span> ${label}</div>`);
    }
    if (opts.tail) parts.push(opts.tail);
    if (!messages.length && !pending && status !== 'history' && !opts.head) parts.push(`<div class="history-note">This session is ready. Send the first message below.</div>`);
    swapHtml($('#thread'), parts.join(''));
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  // ---------- diffs (GitHub / VS Code style) ----------
  // OMP diffs: " N|context" (old line N), "-N|removed" (old N), "+N|added" (new N); blank lines separate hunks.
  // OMP also routes some tool calls through `write` to virtual URIs (xd://…); those are not file changes.
  const realFiles = t => (t?.files || []).filter(f => !/^[a-z][\w+.-]+:\/\//i.test(f.path || ''));
  const diffCache = new Map();
  const parseDiff = diff => memo(diffCache, diff, () => parseDiffRaw(diff), 200);
  function parseDiffRaw(diff) {
    const hunks = [];
    let cur = null, delta = 0, adds = 0, dels = 0;
    for (const raw of String(diff || '').split('\n')) {
      const m = raw.match(/^([ +-])\s*(\d+)\|(.*)$/);
      if (!m) { if (cur && cur.lines.length) { hunks.push(cur); cur = null; } if (raw.startsWith('…')) hunks.push({ note: raw, lines: [] }); continue; }
      cur ??= { lines: [] };
      const n = +m[2], text = m[3];
      if (m[1] === ' ') cur.lines.push({ t: 'ctx', o: n, n: n + delta, text });
      else if (m[1] === '-') { cur.lines.push({ t: 'del', o: n, text }); delta--; dels++; }
      else { cur.lines.push({ t: 'add', n, text }); delta++; adds++; }
    }
    if (cur && cur.lines.length) hunks.push(cur);
    return { hunks, adds, dels };
  }
  // Pair removed/added runs so changed lines line up and get word-level marks.
  function blocks(lines) {
    const out = [];
    for (let i = 0; i < lines.length;) {
      if (lines[i].t === 'ctx') { out.push({ ctx: lines[i++] }); continue; }
      const del = [], add = [];
      while (i < lines.length && lines[i].t === 'del') del.push(lines[i++]);
      while (i < lines.length && lines[i].t === 'add') add.push(lines[i++]);
      out.push({ del, add });
    }
    return out;
  }
  function wordMarks(a, b) {
    // Common prefix/suffix; the middle is what changed.
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    if (p + s === 0 || (a.length - p - s > a.length * 0.7 && b.length - p - s > b.length * 0.7)) return null;
    return [[p, a.length - s], [p, b.length - s]];
  }
  function codeLine(text, lang, mark) {
    if (!mark || mark[0] === mark[1]) return highlight(text, lang) || ' ';
    return highlight(text.slice(0, mark[0]), lang) + `<mark>${highlight(text.slice(mark[0], mark[1]), lang)}</mark>` + highlight(text.slice(mark[1]), lang);
  }
  function diffTable(parsed, lang, mode) {
    const rows = [];
    parsed.hunks.forEach((h, hi) => {
      if (h.note) { rows.push(`<tr class="d-gap"><td colspan="${mode === 'split' ? 4 : 3}">${esc(h.note)}</td></tr>`); return; }
      if (hi > 0 || (h.lines[0] && (h.lines[0].o || h.lines[0].n) > 1)) {
        const f = h.lines[0];
        rows.push(`<tr class="d-gap"><td colspan="${mode === 'split' ? 4 : 3}">⋯ ${f ? `line ${f.o ?? f.n}` : ''}</td></tr>`);
      }
      for (const b of blocks(h.lines)) {
        if (b.ctx) {
          const c = codeLine(b.ctx.text, lang);
          rows.push(mode === 'split'
            ? `<tr><td class="ln">${b.ctx.o}</td><td class="cd">${c}</td><td class="ln">${b.ctx.n}</td><td class="cd">${c}</td></tr>`
            : `<tr><td class="ln">${b.ctx.o}</td><td class="ln">${b.ctx.n}</td><td class="cd">${c}</td></tr>`);
          continue;
        }
        const marks = b.del.map((d, i) => b.add[i] ? wordMarks(d.text, b.add[i].text) : null);
        if (mode === 'split') {
          for (let i = 0; i < Math.max(b.del.length, b.add.length); i++) {
            const d = b.del[i], a = b.add[i], m = marks[i];
            rows.push(`<tr>${d ? `<td class="ln del">${d.o}</td><td class="cd del">${codeLine(d.text, lang, m?.[0])}</td>` : '<td class="ln none"></td><td class="cd none"></td>'}${a ? `<td class="ln add">${a.n}</td><td class="cd add">${codeLine(a.text, lang, m?.[1])}</td>` : '<td class="ln none"></td><td class="cd none"></td>'}</tr>`);
          }
        } else {
          b.del.forEach((d, i) => rows.push(`<tr><td class="ln del">${d.o}</td><td class="ln del"></td><td class="cd del">${codeLine(d.text, lang, marks[i]?.[0])}</td></tr>`));
          b.add.forEach((a, i) => rows.push(`<tr><td class="ln add"></td><td class="ln add">${a.n}</td><td class="cd add">${codeLine(a.text, lang, marks[i]?.[1])}</td></tr>`));
        }
      }
    });
    return `<div class="diff-scroll"><table class="diff ${mode}" aria-label="${mode === 'split' ? 'Side-by-side' : 'Unified'} diff: old line, new line, code">${mode === 'split' ? '<colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup>' : '<colgroup><col class="c-ln"><col class="c-ln"><col></colgroup>'}<tbody>${rows.join('')}</tbody></table></div>`;
  }
  const diffMode = () => S.diffMode || (innerWidth > 1000 ? 'split' : 'unified');
  function fileDiff(f, opts = {}) {
    const parsed = parseDiff(f.diff);
    const lang = extLang(f.path);
    const created = f.op === 'write' || f.op === 'create' || (!parsed.dels && parsed.hunks.every(h => h.note || h.lines.every(l => l.t === 'add')) && parsed.hunks[0]?.lines[0]?.n === 1);
    // A brand-new file has nothing on the left, so split view would be half empty.
    const mode = created ? 'unified' : diffMode();
    const name = f.path ? shortPath(f.path) : 'file';
    return `<div class="filediff">
      <div class="fd-head"><span class="fd-op ${created ? 'add' : f.op === 'delete' ? 'del' : ''}">${created ? (f.op === 'write' ? 'W' : 'A') : f.op === 'delete' ? 'D' : 'M'}</span>
        <span class="fd-path" title="${esc(f.path)}">${esc(name)}</span>
        <span class="fd-stat"><span class="plus">+${parsed.adds}</span> <span class="minus">−${parsed.dels}</span></span>
        ${opts.meta || ''}
        ${created ? '' : `<span class="seg" role="group" aria-label="Diff layout"><button class="${mode === 'unified' ? 'on' : ''}" aria-pressed="${mode === 'unified'}" data-diffmode="unified" title="Inline">Unified</button><button class="${mode === 'split' ? 'on' : ''}" aria-pressed="${mode === 'split'}" data-diffmode="split" title="Side by side">Split</button></span>`}
        ${f.path ? `<button class="btn sm ghost" data-copy-text="${esc(f.path)}" title="Copy path">⧉</button>` : ''}
      </div>
      ${parsed.hunks.length ? diffTable(parsed, lang, mode) : `<pre class="fd-raw">${esc(f.diff)}</pre>`}
    </div>`;
  }
  const diffStat = files => files.reduce((s, f) => { const p = parseDiff(f.diff); s.adds += p.adds; s.dels += p.dels; return s; }, { adds: 0, dels: 0 });

  // ---------- review all changes in a session ----------
  function collectChanges(messages) {
    const byFile = new Map();
    for (const m of messages) for (const f of realFiles(m.tool)) {
      const key = f.path || '(unknown file)';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push({ ...f, at: m.at, intent: m.tool.intent });
    }
    return byFile;
  }
  function renderChanges(c) {
    const src = c.parent.startsWith('s:') ? S.store?.sessions.find(x => x.id === c.parent.slice(2)) : null;
    const file = c.parent.startsWith('f:') ? c.parent.slice(2) : '';
    const pv = file ? S.previews.get(file) : null;
    if (file && !pv) loadPreview(file);
    const messages = src ? src.messages : pv?.messages || [];
    const title = src?.title || S.native.find(n => n.file === file)?.title || pv?.title || 'Session';
    const back = src ? '#/s/' + src.id : '#/f/' + encodeURIComponent(file);
    const byFile = collectChanges(messages);
    const all = [...byFile.values()].flat();
    const tot = diffStat(all);
    setIfChanged($('#topbar'), `<button class="btn sm ghost menu-btn" data-act="nav" aria-label="Open navigation">☰</button>
      <div class="title-block"><div class="crumb"><a href="${esc(back)}">← ${esc(title)}</a> <span>/ changes</span></div>
        <h1>Changes</h1><div class="meta"><span>${byFile.size} ${byFile.size === 1 ? 'file' : 'files'} · ${all.length} ${all.length === 1 ? 'edit' : 'edits'}</span><span class="fd-stat"><span class="plus">+${tot.adds}</span> <span class="minus">−${tot.dels}</span></span>${pv && !src ? '<span>from the last 150 messages</span>' : ''}</div></div>
      <div class="actions"><span class="seg" role="group" aria-label="Diff layout"><button class="${diffMode() === 'unified' ? 'on' : ''}" aria-pressed="${diffMode() === 'unified'}" data-diffmode="unified">Unified</button><button class="${diffMode() === 'split' ? 'on' : ''}" aria-pressed="${diffMode() === 'split'}" data-diffmode="split">Split</button></span></div>`);
    const sig = ['changes', c.parent, messages.length, messages[messages.length - 1]?.id, diffMode()].join('|');
    if (sig === S.lastSig) return;
    S.lastSig = sig;
    if (!messages.length && file && !pv) { $('#thread').innerHTML = '<div class="working"><span class="spinner"></span> Reading session…</div>'; return; }
    if (!byFile.size) { $('#thread').innerHTML = '<div class="history-note">No file edits recorded in this session yet.</div>'; return; }
    const files = [...byFile];
    swapHtml($('#thread'), `<div class="changes-index">${files.map(([p, list], i) => { const st = diffStat(list); return `<a href="#" data-jump="fd-${i}"><span class="fd-path">${esc(shortPath(p))}</span><span class="muted">${list.length > 1 ? list.length + ' edits' : ''}</span><span class="fd-stat"><span class="plus">+${st.adds}</span> <span class="minus">−${st.dels}</span></span></a>`; }).join('')}</div>`
      + files.map(([p, list], i) => `<section class="change-file" id="fd-${i}">${list.map((f, j) => fileDiff(f, { meta: list.length > 1 ? `<span class="muted fd-when">edit ${j + 1}/${list.length} · ${esc(clock(f.at))}</span>` : `<span class="muted fd-when">${esc(clock(f.at))}</span>` })).join('')}</section>`).join(''));
  }

  // ---------- background tasks & plan (side panel) ----------
  function countTasks(s) {
    let total = 0, done = 0;
    for (const ph of s?.todos || []) for (const t of ph.tasks || []) { total++; if (t.status === 'completed') done++; }
    return { total, done };
  }
  function planPhases(s) {
    const icon = st => st === 'completed' ? '✓' : st === 'in_progress' ? '◉' : '○';
    return (s?.todos || []).map(ph => `<div class="phase"><b>${esc(ph.name || 'Tasks')}</b>${(ph.tasks || []).map(t => `<div class="task ${esc(t.status)}"><i>${icon(t.status)}</i><span>${esc(t.content)}</span></div>`).join('')}</div>`).join('');
  }
  function renderChatPlan(s) {
    const el = $('#chatPlan');
    const { total, done } = countTasks(s);
    const mode = s?.planMode, supported = mode?.available === true;
    const showPlan = s && (supported || s._planSupported === true && mode?.available !== false);
    el.hidden = !showPlan && !total;
    if (el.hidden) return;
    const active = (s?.todos || []).flatMap(ph => ph.tasks || []).filter(t => t.status === 'in_progress');
    const busy = S.planBusy.has(s?.id) || ['running', 'queued'].includes(s?.status) || s?._task || s?._bash;
    const proposal = s?._planReview, pending = proposal && !S.planSubmitted.has(s.id + ':' + proposal.id);
    const modeLabel = supported ? pending ? 'Awaiting approval · read-only' : mode.enabled ? 'On · read-only planning' : mode.paused ? 'Paused' : 'Off' : s?._planSupported === false ? 'Requires updated OMP RPC support' : mode?.available === false ? 'Disabled in OMP settings (plan.enabled)' : 'Enable read-only planning before your first prompt';
    setIfChanged(el, `${showPlan ? `<div class="native-plan"><span class="grow"><strong>Plan mode</strong> <span class="muted">${modeLabel}${supported && mode.workflow ? ' · ' + esc(mode.workflow) : ''}</span></span>${s._planSupported !== false && mode?.available !== false ? `<button class="btn sm" data-plan-toggle="${esc(s.id)}" ${supported ? `aria-pressed="${!!mode.enabled}"` : ''} title="Toggle native plan mode (Alt+Shift+P)" ${busy ? 'disabled' : ''}>${supported ? mode.enabled ? 'Turn off' : 'Turn on' : 'Enable plan mode'}</button>` : ''}${supported ? `<button class="btn sm ${pending ? 'primary' : 'ghost'}" data-plan-review="${esc(s.id)}" ${busy || !mode.enabled && !pending ? 'disabled' : ''}>${pending ? 'Review plan' : 'Reopen review'}</button>` : ''}</div>` : ''}${total ? `<button class="chat-plan-link" type="button" data-act="openPlan" title="Open task plan tab"><strong>Task plan <span>${done}/${total}</span></strong><span class="chat-plan-current">${active.length ? active.map(t => esc(t.content)).join(' · ') : 'No task in progress'}</span><span aria-hidden="true">→</span></button>` : ''}`);
  }
  const bgFile = () => {
    const c = current();
    if (c.kind === 'session') return S.store?.sessions.find(x => x.id === c.id)?.sessionFile || '';
    return c.kind === 'native' ? c.file : '';
  };
  // ---------- advisor ----------
  S.advTx = new Map();
  function advisorFiles(file) { return (S.bg.get(file)?.data?.subagents || []).filter(x => x.advisor); }
  async function loadAdvisorTx(file) {
    if (!S.advReviews) return;
    for (const a of advisorFiles(file)) {
      const e = S.advTx.get(a.file) || {};
      if (e.loading || (e.updatedAt === a.updatedAt && e.data) || (e.at && Date.now() - e.at < 4000)) continue;
      e.loading = true; S.advTx.set(a.file, e);
      try { e.data = await api('/transcript?file=' + encodeURIComponent(a.file)); e.updatedAt = a.updatedAt; } catch { }
      e.loading = false; e.at = Date.now();
      S.lastSig = ''; update();
    }
  }
  function withAdvisor(messages, file) {
    if (!file) return messages;
    if (!S.advReviews) return messages;
    const extra = [];
    for (const a of advisorFiles(file)) {
      const name = a.name === '__advisor' || a.name === '__advisor.default' ? '' : a.name.slice('__advisor.'.length);
      for (const m of S.advTx.get(a.file)?.data?.messages || []) if (['thinking', 'tool', 'assistant'].includes(m.role)) extra.push({ ...m, adv: name || 'advisor', id: 'adv-' + m.id });
    }
    if (!extra.length) return messages;
    const t = m => new Date(m.at).getTime() || 0;
    const since = messages.length ? t(messages[0]) : 0;
    return [...messages, ...extra.filter(m => t(m) >= since)].map((m, i) => [m, i]).sort((a, b) => t(a[0]) - t(b[0]) || a[1] - b[1]).map(x => x[0]);
  }
  function advisorReview(group) {
    if (!S.advReviews) return '';
    const thoughts = group.filter(m => m.role === 'thinking').length, tools = group.filter(m => m.role === 'tool').length, replies = group.filter(m => m.role === 'assistant');
    const who = [...new Set(group.map(m => m.adv))].join(', ');
    const open = rowOpen.get('adv:' + group[0].id);
    const bits = [thoughts ? `${thoughts} thought${thoughts === 1 ? '' : 's'}` : '', tools ? `${tools} tool call${tools === 1 ? '' : 's'}` : '', replies.length ? `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(' · ');
    const body = [];
    for (let i = 0; i < group.length; i++) {
      if (group[i].role === 'assistant') { body.push(`<div class="adv-reply md">${md(group[i].text)}</div>`); continue; }
      const g = [];
      while (i < group.length && group[i].role !== 'assistant') g.push(group[i++]);
      i--;
      body.push(activityBlock(g, false));
    }
    return `<details class="advisor-review" data-remember="adv:${esc(group[0].id)}" ${open ? 'open' : ''}><summary><span class="adv-icon">⚑</span> Advisor review${who && who !== 'advisor' ? ' · ' + esc(who) : ''} <span class="muted">${esc(bits)}</span><time>${esc(clock(group[0].at))}</time></summary><div class="adv-body">${body.join('')}</div></details>`;
  }
  function advisorChip(s) {
    const a = s.advisor;
    const label = !a ? 'Advisor' : !a.enabled ? 'Advisor off' : a.noModel ? 'Advisor: no model' : 'Advisor' + (a.model ? ' · ' + modelName(a.model.split(', ')[0]) : ' on');
    return `<button class="model-chip adv-chip ${a?.enabled && !a.noModel ? 'on' : ''}" data-act="advMenu" title="Advisor: a second model that reviews each turn">⚑ <span>${esc(label)}</span> ▾</button>`;
  }
  async function openAdvMenu(btn) {
    closeThinkMenu();
    try { S.advCfg = await api('/advisor'); } catch { }
    const c = current();
    const s = c.kind === 'session' && S.store?.sessions.find(x => x.id === c.id);
    if (!s) return;
    const a = s.advisor || {};
    const role = S.advCfg?.model;
    const files = advisorFiles(s.sessionFile || '');
    const pct = a.contextWindow ? Math.round(a.contextTokens / a.contextWindow * 100) : null;
    const el = document.createElement('div');
    el.id = 'thinkMenu'; el.className = 'think-menu adv-menu';
    el.innerHTML = `<div class="tm-head">Advisor</div>
      <label class="adv-toggle"><span>Show advisor reviews in chat</span><span class="switch"><input type="checkbox" data-advreviews ${S.advReviews ? 'checked' : ''}><span></span></span></label>
      <label class="adv-toggle"><span>Important notes only (concern + blocker)</span><span class="switch"><input type="checkbox" data-advimportant ${S.advImportant ? 'checked' : ''}><span></span></span></label>
      <label class="adv-toggle"><span>${a.enabled && !a.noModel ? 'On for this session' : a.noModel ? 'On, but no model set' : s.advisor ? 'Off for this session' : 'Status unknown'}</span><span class="switch"><input type="checkbox" data-advset ${a.enabled ? 'checked' : ''}><span></span></span></label>
      <div class="adv-info">${a.model ? `<div>Model <b>${esc(a.model)}</b></div>` : role ? `<div>Model <b>${esc(role)}</b> <span class="muted">from ${esc(S.advCfg.source)}</span></div>` : '<div>No advisor model set yet.</div>'}
        ${pct != null ? `<div>Context ${fmtTokens(a.contextTokens)} / ${fmtTokens(a.contextWindow)} (${pct}%)</div>` : ''}${typeof a.cost === 'number' ? `<div>Spend $${a.cost.toFixed(4)}</div>` : ''}${a.state && a.enabled ? `<div>State: ${esc(a.state)}</div>` : ''}</div>
      <button data-advact="model">◆ Change advisor model…</button>
      <button data-advact="status">↻ Refresh status</button>
      ${files.map(f => `<button data-sub="${esc(f.file)}">▸ Open ${esc(f.name === '__advisor' ? 'advisor' : f.name.slice(10))} transcript</button>`).join('')}
      <div class="adv-note">Changing the model updates ${S.advCfg?.source === 'WATCHDOG.yml' ? 'your <code>WATCHDOG.yml</code>' : 'the <code>advisor</code> model role'} (all sessions) and restarts this session's OMP while it is idle.</div>`;
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
    el.style.top = (r.top < el.offsetHeight + 12 ? r.bottom + 6 : r.top - el.offsetHeight - 6) + 'px';
  }
  async function advisorAction(action, model) {
    const c = current();
    if (c.kind !== 'session') return;
    closeThinkMenu();
    try { await api(`/sessions/${c.id}/command`, { type: 'advisor', action, model }); await refresh(); }
    catch (err) { toast(err.message, 'err'); }
  }
  async function loadBg(file, force) {
    if (!file) return;
    const e = S.bg.get(file) || {};
    const running = e.data && bgJobs(e.data).some(j => j.status === 'running');
    const live = current().kind === 'session' && ['running', 'queued'].includes(S.store?.sessions.find(x => x.id === current().id)?.status);
    const wait = live || running ? 3000 : 20000;
    if (e.loading || (!force && e.at && Date.now() - e.at < wait)) return;
    e.loading = true; S.bg.set(file, e);
    try { e.data = await api('/background?file=' + encodeURIComponent(file)); } catch (err) { e.error = err.message; }
    e.loading = false; e.at = Date.now();
    update();
  }
  function bgJobs(data) {
    if (!data) return [];
    const jobs = (data.tasks || []).map(j => ({ ...j }));
    // Live registry entries carry progress for subagents that are still working.
    for (const a of data.agents || []) {
      const j = jobs.find(x => x.id === a.id);
      const status = /run|pend|start|queue/i.test(a.status) ? 'running' : /fail|error|abort/i.test(a.status) ? 'error' : a.status ? 'done' : '';
      if (j) { if (status === 'running' && data.live) j.status = 'running'; j.live = a; }
      else if (a.id) jobs.push({ id: a.id, type: 'task', agent: a.agent, title: a.description || a.id, status: data.live ? status || 'running' : 'stale', startedAt: new Date(a.lastUpdate).toISOString(), transcript: a.sessionFile, live: a });
    }
    for (const x of data.subagents || []) if (!x.advisor) jobs.push({ id: x.name, type: 'task', agent: 'subagent', title: x.name, status: 'done', transcript: x.file, model: x.model, cost: x.cost, summary: x.result, startedAt: x.updatedAt, finishedAt: x.updatedAt });
    return jobs;
  }
  const since = iso => { const ms = Date.now() - new Date(iso).getTime(); return isFinite(ms) ? fmtMs(Math.max(0, Math.round(ms / 1000) * 1000)) : ''; };
  const firstLine = s => String(s || '').split('\n').map(l => l.trim()).find(l => l && !/^#/.test(l) && !(l.endsWith(':') && l.length < 48)) || '';
  function jobCard(j) {
    const running = j.status === 'running';
    const kind = j.type === 'bash' ? 'Bash' : j.agent && j.agent !== 'task' ? `Agent · ${j.agent}` : 'Subagent';
    const time = running ? since(j.startedAt) : fmtMs(j.durationMs) || (j.finishedAt ? ago(j.finishedAt) + ' ago' : '');
    const live = j.live?.progress || {};
    const liveLine = running ? [live.currentTool && `▸ ${live.currentTool}`, live.lastIntent || live.intent, live.toolCount && `${live.toolCount} tools`].filter(Boolean).join(' · ') : '';
    const desc = j.type === 'bash' ? '' : firstLine(j.title !== j.id ? j.title : j.task).replace(/^#+\s*/, '');
    const output = j.output || j.summary || '';
    return `<div class="job ${esc(j.status)}" data-key="job:${esc(j.id)}">
      <div class="job-top"><span class="dot ${running ? 'running' : j.status === 'error' ? 'error' : j.status === 'stale' ? 'paused' : 'done'}"></span><b title="${esc(j.id)}">${esc(j.type === 'bash' ? (j.title || j.id) : j.id)}</b><span class="dur">${esc(time)}</span></div>
      <div class="job-sub">${esc(kind)}${j.model ? ' · ' + esc(modelName(j.model)) : ''}${j.cost ? ' · $' + j.cost.toFixed(j.cost < 0.01 ? 4 : 2) : ''}${j.status === 'stale' ? ' · no longer tracked' : j.status === 'cancelled' ? ' · cancelled' : j.status === 'error' ? ' · failed' : ''}</div>
      ${desc ? `<div class="job-desc">${esc(desc.slice(0, 220))}</div>` : ''}
      ${liveLine ? `<div class="job-live">${esc(liveLine)}</div>` : ''}
      ${running && j.live?.thinking ? `<details class="job-out job-thought" data-key="job-thought:${esc(j.id)}" open><summary>Reasoning</summary><pre>${esc(j.live.thinking)}</pre></details>` : ''}
      ${j.command ? `<pre class="job-cmd">${esc(j.command.slice(0, 600))}${j.command.length > 600 ? `\n… ${j.command.length - 600} more characters` : ''}</pre>` : ''}
      ${output && !running ? `<details class="job-out"><summary>Output</summary><pre>${esc(output.slice(0, 6000))}${output.length > 6000 ? `\n… showing the first 6000 of ${output.length} characters${j.transcript ? '. Open the subagent for the full transcript.' : ''}` : ''}</pre></details>` : ''}
      ${j.transcript ? `<button class="btn sm ghost job-open" data-sub="${esc(j.transcript)}">${running ? 'Watch' : 'Open'} subagent →</button>` : ''}
    </div>`;
  }
  function renderSide(s) {
    const el = $('#tasks');
    if (!el) return;
    const file = bgFile();
    const e = file ? S.bg.get(file) : null;
    const jobs = bgJobs(e?.data);
    const advisors = (e?.data?.subagents || []).filter(x => x.advisor);
    const running = jobs.filter(j => j.status === 'running');
    const finished = jobs.filter(j => j.status !== 'running').sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)));
    const { total, done } = countTasks(s);
    S.sideCounts = { running: running.length, jobs: jobs.length, advisors: advisors.length, total };
    el.hidden = !(S.sideOpen && (total || jobs.length || advisors.length));
    const tab = total && S.sideTab === 'plan' ? 'plan' : 'activity';
    const shown = finished.slice(0, 60);
    setIfChanged(el, `<div class="side-head"><div class="side-tabs" role="group" aria-label="Session panel"><button type="button" class="${tab === 'plan' ? 'on' : ''}" aria-pressed="${tab === 'plan'}" data-act="sideTab" data-tab="plan" ${total ? '' : 'disabled'}>Plan${total ? ` <small>${done}/${total}</small>` : ''}</button><button type="button" class="${tab === 'activity' ? 'on' : ''}" aria-pressed="${tab === 'activity'}" data-act="sideTab" data-tab="activity">Activity${running.length ? ` <small>${running.length}</small>` : ''}</button></div><button class="btn sm ghost" data-act="closeSide" aria-label="Close panel">✕</button></div>
      ${tab === 'plan' ? `<div class="side-plan"><div class="side-plan-progress"><span>${done} of ${total} complete</span><progress value="${done}" max="${total}"></progress></div>${planPhases(s)}</div>` :
        `${jobs.length ? `<div class="side-sec"><div class="side-label">Running <span>${running.length}</span></div>${running.map(jobCard).join('') || '<div class="side-empty">Nothing running right now.</div>'}</div>
      ${finished.length ? `<details class="side-sec" ${S.finishedOpen ? 'open' : ''} data-finished><summary class="side-label">Finished <span>${finished.length}</span></summary>${shown.map(jobCard).join('')}${finished.length > shown.length ? `<div class="side-empty">and ${finished.length - shown.length} older</div>` : ''}</details>` : ''}` : `<div class="side-sec"><div class="side-empty">${e?.error ? 'Could not read background work: ' + esc(e.error) : 'No background work yet.'}</div></div>`}
      ${advisors.length ? `<div class="side-sec"><div class="side-label">Advisors <span>${advisors.length}</span></div>${advisors.map(x => `<div class="job"><div class="job-top"><b>${esc(x.name === '__advisor' ? 'Default' : x.name.slice('__advisor.'.length))}</b><span class="dur">${esc(ago(x.updatedAt))}</span></div>${x.model ? `<div class="job-sub">${esc(modelName(x.model))}</div>` : ''}<button class="btn sm ghost job-open" data-sub="${esc(x.file)}">Open transcript →</button></div>`).join('')}</div>` : ''}`}`);
  }
  function changesButton(messages, key) {
    const files = new Set();
    for (const m of messages) for (const f of realFiles(m.tool)) files.add(f.path);
    if (!files.size) return '';
    return `<a class="btn sm ghost" href="#/changes/${encodeURIComponent(key)}" title="Review every file this session changed" aria-label="${files.size} ${files.size === 1 ? 'file' : 'files'} changed">± <span class="lbl">${files.size} ${files.size === 1 ? 'file' : 'files'} changed</span></a>`;
  }
  function sideButton() {
    const c = S.sideCounts || {};
    if (!c.jobs && !c.advisors) return '';
    const bits = [c.running ? `<span class="badge live">${c.running} running</span>` : c.jobs ? `${c.jobs} background` : '', c.advisors ? `${c.advisors} advisor${c.advisors === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    return `<button class="btn sm ghost ${S.sideOpen && (S.sideTab === 'activity' || !c.total) ? 'on' : ''}" data-act="side" title="Background tasks and advisors" aria-label="Background tasks and advisors${bits ? ': ' + bits.replace(/<[^>]+>/g, '') : ''}">⧉ <span class="lbl">${bits}</span></button>`;
  }

  // ---------- subagent transcript ----------
  async function loadSub(file, force) {
    const e = S.subs.get(file) || {};
    if (e.loading || (!force && e.at && Date.now() - e.at < 4000)) return;
    if (e.data && e.data.active !== true && !force && Date.now() - new Date(e.data.updatedAt).getTime() > 120000 && e.at) return;
    e.loading = true; S.subs.set(file, e);
    try { e.data = await api('/transcript?file=' + encodeURIComponent(file)); e.error = ''; } catch (err) { e.error = err.message; }
    e.loading = false; e.at = Date.now();
    update();
  }
  function renderSub(file) {
    const e = S.subs.get(file);
    const parent = S.subParent.get(file);
    const name = base(file).replace(/\.jsonl$/, '');
    const advisor = name === '__advisor' || name.startsWith('__advisor.');
    const d = e?.data;
    const active = !advisor && d && (d.active ?? Date.now() - new Date(d.updatedAt).getTime() < 120000);
    setIfChanged($('#topbar'), `<button class="btn sm ghost menu-btn" data-act="nav" aria-label="Open navigation">☰</button>
      <div class="title-block"><div class="crumb">${parent ? `<a href="${esc(parent.hash)}">← ${esc(parent.title)}</a>` : '<a href="#/new">← Home</a>'} <span>/ ${advisor ? 'advisor' : 'subagent'}</span></div>
        <h1 title="${esc(name)}">◈ ${esc(advisor ? 'Advisor · ' + (name === '__advisor' ? 'Default' : name.slice('__advisor.'.length)) : name)}</h1>${metaHtml(d?.cwd || '', `<span class="pill ${active ? 'running' : ''}">${active ? 'Active' : advisor ? 'Advisor' : 'Subagent'}</span>${d?.model ? `<span>◆ ${esc(modelLabel(d.model, d.thinking))}</span>` : ''}${d ? `<span>updated ${esc(ago(d.updatedAt))} ago</span>` : ''}`)}</div>
      <div class="actions"><div class="menu"><button class="btn sm ghost" data-act="menu" aria-label="More">⋯</button><div class="menu-pop">
        <button data-copy-text="${esc(file)}">Copy transcript path</button>
        <button data-act="expandAll">${S.expandAll ? 'Collapse' : 'Expand'} tool activity by default</button></div></div></div>`);
    if (!e?.data) { $('#thread').innerHTML = e?.error ? `<div class="msg system err"><div class="bubble">${esc(e.error)}</div></div>` : `<div class="working"><span class="spinner"></span> Reading ${advisor ? 'advisor' : 'subagent'} transcript…</div>`; return; }
    let result = (d.result || '').trim();
    if (/^[[{]/.test(result)) result = '```json\n' + result + '\n```';
    const tail = result ? `<div class="sub-result"><div class="side-label">Result</div><div class="md">${md(result)}</div></div>` : '';
    renderThread(d.messages || [], active ? 'running' : 'history', file, { head: `<div class="history-note">Read-only transcript of ${advisor ? 'an advisor reviewing' : 'a subagent started by'} ${parent ? `<a href="${esc(parent.hash)}">${esc(parent.title)}</a>` : 'its parent session'}.</div>`, tail, extra: result.length, speaker: advisor ? 'Advisor' : 'OMP' });
    const line = $('#statusLine');
    setIfChanged(line, `<span class="grow">${advisor ? 'Advisors review the parent session. Manage them from the parent chat.' : 'Subagents run inside their parent session. To steer one, message the parent session.'}</span>${parent ? `<a class="btn sm" href="${esc(parent.hash)}">Back to parent</a>` : ''}`);
  }
  function openSub(file) {
    const c = current();
    if (c.kind === 'session' || c.kind === 'native') {
      const title = c.kind === 'session' ? S.store?.sessions.find(x => x.id === c.id)?.title : (S.native.find(n => n.file === c.file)?.title || S.previews.get(c.file)?.title);
      S.subParent.set(file, { hash: location.hash, title: title || 'Parent session' });
    }
    location.hash = '#/sub/' + encodeURIComponent(file);
  }

  // ---------- model picker ----------
  async function ensureModels() {
    if (!S.models) S.models = await api('/models');
    return S.models;
  }
  const splitSel = v => { const m = String(v || '').match(/^(.*?)(?::(off|minimal|low|medium|high|xhigh|max|auto))?$/); return { sel: m[1], thinking: m[2] || '' }; };
  function recentModels() {
    const seen = new Map();
    for (const it of items()) if (it.model && !seen.has(it.model)) seen.set(it.model, it.thinking || '');
    return [...seen].slice(0, 8);
  }
  // Higher version numbers first, so the latest models are at the top of each list.
  const newest = (a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
  const favs = () => { try { return JSON.parse(localStorage.getItem('omp-fav-models') || '[]'); } catch { return []; } };
  const toggleFav = sel => { const f = favs(), i = f.indexOf(sel); i >= 0 ? f.splice(i, 1) : f.unshift(sel); try { localStorage.setItem('omp-fav-models', JSON.stringify(f)); } catch {} };
  const thinkMem = () => { try { return JSON.parse(localStorage.getItem('omp-think-levels') || '{}'); } catch { return {}; } };
  const thinkGet = sel => sel ? thinkMem()[sel] : undefined;
  const thinkSet = (sel, th) => { if (!sel) return; try { const m = thinkMem(); m[sel] = th || ''; localStorage.setItem('omp-think-levels', JSON.stringify(m)); } catch {} };
  function pickerRows() {
    const P = S.picker, M = S.models;
    const q = P.q.trim().toLowerCase();
    const pool = M.models.filter(m => !P.provider || m.provider === P.provider);
    const row = (m, badge, thinking) => ({ sel: m.selector, name: m.name, provider: m.provider, badge, thinking: thinking || '', m });
    if (q) {
      const words = q.split(/\s+/);
      const hits = pool.filter(m => { const t = (m.name + ' ' + m.selector).toLowerCase(); return words.every(w => t.includes(w)); });
      const score = m => (m.name.toLowerCase().startsWith(q) ? 0 : m.id.toLowerCase().startsWith(q) ? 1 : 2) + (m.provider === 'openrouter' ? 0.5 : 0);
      const fav = new Set(favs());
      return [{ label: `${hits.length} match${hits.length === 1 ? '' : 'es'}`, rows: hits.sort((a, b) => fav.has(b.selector) - fav.has(a.selector) || score(a) - score(b) || newest(a, b)).slice(0, 300).map(m => row(m)) }];
    }
    const sections = [];
    if (!P.provider) {
      const def = splitSel(M.roles.default);
      if (P.ctx.allowDefault) sections.push({ label: 'Default', rows: [{ sel: '', name: 'OMP default', provider: def.sel ? modelLabel(def.sel, def.thinking) : 'from your OMP config', badge: '', isDefault: true, thinking: '', m: modelInfo(def.sel) }] });
      const fv = favs().map(sel => modelInfo(sel)).filter(Boolean).map(m => row(m));
      if (fv.length) sections.push({ label: '★ Favorites', rows: fv });
      const roles = Object.entries(M.roles || {}).filter(([r]) => !['image', 'vision'].includes(r)).map(([r, v]) => { const s = splitSel(v); const m = modelInfo(s.sel); return m && row(m, r, s.thinking); }).filter(Boolean);
      if (roles.length) sections.push({ label: 'Your OMP roles', rows: roles });
      const rec = recentModels().map(([sel, th]) => { const m = modelInfo(sel); return m && row(m, 'recent', th); }).filter(Boolean);
      if (rec.length) sections.push({ label: 'Recently used', rows: rec });
    }
    for (const prov of providerOrder()) {
      if (P.provider && prov !== P.provider) continue;
      const ms = pool.filter(m => m.provider === prov);
      if (ms.length) sections.push({ label: prov, rows: ms.sort(newest).map(m => row(m)) });
    }
    return sections;
  }
  function providerOrder() {
    const M = S.models;
    const pref = new Set(Object.values(M.roles || {}).map(v => splitSel(v).sel.split('/')[0]));
    const all = [...new Set(M.models.map(m => m.provider))];
    return all.sort((a, b) => (pref.has(b) - pref.has(a)) || (a === 'openrouter') - (b === 'openrouter') || a.localeCompare(b));
  }
  async function openPicker(ctx) {
    const t0 = ctx.thinking || thinkGet(ctx.model) || ''; S.picker = { ctx, q: '', provider: '', hi: 0, thinking: t0, thinkSel: ctx.model, mem: ctx.model ? { [ctx.model]: t0 } : {}, flat: [], opener: S.picker?.opener || document.activeElement };
    let el = $('#picker');
    if (!el) { el = document.createElement('div'); el.id = 'picker'; el.className = 'picker-wrap'; document.body.appendChild(el); }
    el.innerHTML = `<div class="picker" role="dialog" aria-modal="true" aria-label="Choose model"><div class="picker-search"><input id="pickerQ" aria-label="Search models" placeholder="Search ${S.models ? S.models.models.length : ''} models… (e.g. opus, gpt 6, gemini flash)" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="picker-provs" id="pickerProvs"></div><div class="picker-think" id="pickerThink"></div><div class="picker-list" id="pickerList"><div class="working"><span class="spinner"></span> Loading models…</div></div>
      <div class="picker-foot"><span>↑↓ to move · Enter to choose · hover to see reasoning levels</span></div></div>`;
    el.hidden = false;
    $('#pickerQ').focus();
    try { await ensureModels(); } catch (e) { $('#pickerList').innerHTML = `<div class="side-empty">${esc(e.message)}</div>`; return; }
    if (!S.picker) return;
    $('#pickerQ').placeholder = `Search ${S.models.models.length} models… (e.g. opus, gpt 6, gemini flash)`;
    S.picker.hi = -1;
    renderPicker();
  }
  function closePicker() {
    const opener = S.picker?.opener;
    S.picker = null; const el = $('#picker'); if (el) { el.hidden = true; el.innerHTML = ''; }
    // Return focus unless a pick already moved it somewhere on purpose.
    if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus();
  }
  function renderPicker() {
    const P = S.picker;
    if (!P || !S.models) return;
    const counts = new Map();
    for (const m of S.models.models) counts.set(m.provider, (counts.get(m.provider) || 0) + 1);
    $('#pickerProvs').innerHTML = `<button class="chip ${!P.provider ? 'sel' : ''}" data-prov="">All</button>` + providerOrder().map(p => `<button class="chip ${P.provider === p ? 'sel' : ''}" data-prov="${esc(p)}">${esc(p)} <small>${counts.get(p)}</small></button>`).join('');
    const sections = pickerRows();
    P.flat = sections.flatMap(s => s.rows);
    if (P.hi < 0) { const cur = P.flat.findIndex(r => r.sel === P.ctx.model); P.hi = cur >= 0 ? cur : 0; }
    P.hi = Math.min(P.hi, P.flat.length - 1);
    let n = 0;
    const fv = new Set(favs());
    $('#pickerList').innerHTML = sections.map(s => `<div class="picker-sec">${esc(s.label)}</div>` + s.rows.map(r => {
      const i = n++;
      const cur = r.sel === P.ctx.model && (r.isDefault || !r.thinking || r.thinking === P.ctx.thinking);
      return `<div class="picker-line"><button class="picker-row ${i === P.hi ? 'hi' : ''} ${cur ? 'cur' : ''}" data-pi="${i}"><span class="pn">${esc(r.name)}</span>${r.badge ? `<span class="tag">${esc(r.badge)}${r.thinking ? ' · ' + esc(r.thinking) : ''}</span>` : ''}
        <span class="pp">${esc(r.isDefault ? r.provider : r.sel)}</span><span class="pm">${r.m?.reasoning ? '✱' : ''}${r.m?.contextWindow ? ' ' + fmtTokens(r.m.contextWindow) : ''}</span></button>${r.isDefault ? '' : `<button type="button" class="fav ${fv.has(r.sel) ? 'on' : ''}" data-fav="${esc(r.sel)}" aria-pressed="${fv.has(r.sel)}" aria-label="Favorite ${esc(r.name)}" title="${fv.has(r.sel) ? 'Remove from favorites' : 'Add to favorites'}">${fv.has(r.sel) ? '★' : '☆'}</button>`}</div>`;
    }).join('')).join('') || '<div class="side-empty">No models match.</div>';
    renderThink();
    $('#pickerList .hi')?.scrollIntoView({ block: 'nearest' });
  }
  function renderThink() {
    const P = S.picker;
    const r = P.flat[P.hi];
    if (r && P.thinkSel !== r.sel) { if (P.thinkSel) P.mem[P.thinkSel] = P.thinking; P.thinkSel = r.sel; const m = P.mem[r.sel] ?? thinkGet(r.sel) ?? ''; P.thinking = (!m || (r.m?.thinking || []).includes(m)) ? m : ''; }
    const levels = r?.m?.thinking || [];
    const defLevel = r?.thinking || (r?.isDefault ? splitSel(S.models.roles.default).thinking : '') || S.models.defaultThinking || '';
    $('#pickerThink').innerHTML = !r ? '' : !r.m || !r.m.reasoning || !levels.length
      ? `<span class="muted">${r.m && !r.m.reasoning ? 'This model has no reasoning levels.' : 'Reasoning follows your OMP config.'}</span>`
      : `<span class="muted">Reasoning</span><button class="chip ${!P.thinking ? 'sel' : ''}" data-think="">Default${defLevel ? ` <small>${esc(defLevel)}</small>` : ''}</button>` + levels.map(l => `<button class="chip ${P.thinking === l ? 'sel' : ''}" data-think="${esc(l)}">${esc(l)}</button>`).join('');
  }
  function pickModel(i) {
    const P = S.picker;
    const r = P?.flat[i];
    if (!r) return;
    const levels = r.m?.thinking || [];
    const thinking = P.thinking && levels.includes(P.thinking) ? P.thinking : (r.thinking || '');
    const ctx = P.ctx;
    closePicker();
    ctx.apply(r.sel, thinking);
  }
  function modelChip(sel, thinking, fallback) {
    const levels = thinkLevels(sel);
    const label = sel ? (levels.length ? modelName(sel) : modelLabel(sel, thinking)) : levels.length ? (S.models?.roles?.default ? 'Default · ' + modelName(splitSel(S.models.roles.default).sel) : 'OMP default') : fallback;
    return `<button class="model-chip" data-act="model" title="Choose model">◆ <span>${esc(label)}</span> ▾</button>`
      + (levels.length ? `<button class="model-chip think-chip" data-act="thinkMenu" title="Reasoning level">✦ <span>${esc(thinking || 'default')}</span> ▾</button>` : '');
  }
  // Reasoning levels of a selector, or of the default role's model when no model is picked.
  const thinkLevels = sel => { const eff = sel || splitSel(S.models?.roles?.default || '').sel; if (!S.models) return []; const m = modelInfo(eff); return m ? (m.reasoning ? m.thinking || [] : []) : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']; };
  function openThinkMenu(btn) {
    closeThinkMenu();
    const ctx = pickerCtx();
    if (!ctx) return;
    const levels = thinkLevels(ctx.model);
    const def = splitSel(S.models?.roles?.default || '').thinking || S.models?.defaultThinking || '';
    const el = document.createElement('div');
    el.id = 'thinkMenu'; el.className = 'think-menu';
    el.innerHTML = `<div class="tm-head">Reasoning</div><button data-thinkset="" class="${!ctx.thinking ? 'sel' : ''}">Default${def ? ` <small>${esc(def)}</small>` : ''}</button>`
      + levels.map(l => `<button data-thinkset="${esc(l)}" class="${ctx.thinking === l ? 'sel' : ''}">${esc(l)}</button>`).join('');
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
    const below = r.top < el.offsetHeight + 12;
    el.style.top = (below ? r.bottom + 6 : r.top - el.offsetHeight - 6) + 'px';
    el._ctx = ctx;
  }
  const closeThinkMenu = () => $('#thinkMenu')?.remove();
  const defaultLabel = () => { const d = splitSel(S.models?.roles?.default || ''); return d.sel ? `Default · ${modelLabel(d.sel, d.thinking || S.models.defaultThinking)}` : 'OMP default'; };

  function renderQuestions(s) {
    const el = $('#questions'), questions = s?.uiRequests || [];
    el.hidden = !questions.length;
    if (!questions.length) { el.dataset.first = ''; setIfChanged(el, ''); return; }
    const first = el.dataset.first;
    setIfChanged(el, questions.map(q => `<section class="question" data-question="${esc(q.id)}" aria-label="OMP question">
      <strong>${esc(q.title)}</strong>
      ${q.method === 'select' ? `<div class="question-options">${q.options.map((option, i) => `<button type="button" data-uichoice="${esc(q.id)}" data-uivalue="${esc(option)}"><span>${esc(option)}</span>${q.optionDetails?.[i]?.description ? `<small>${esc(q.optionDetails[i].description)}</small>` : ''}</button>`).join('')}</div>` : ''}
      ${q.method === 'confirm' ? `<p>${esc(q.message)}</p><div class="question-actions"><button type="button" class="btn sm primary" data-uiconfirm="${esc(q.id)}" data-confirmed="true">Yes</button><button type="button" class="btn sm" data-uiconfirm="${esc(q.id)}" data-confirmed="false">No</button></div>` : ''}
      ${q.method === 'input' || q.method === 'editor' ? `<form data-uiform="${esc(q.id)}">${q.method === 'input' ? `<input name="answer" maxlength="20000" placeholder="${esc(q.placeholder || 'Your answer')}" aria-label="${esc(q.title)}">` : `<textarea name="answer" maxlength="20000" rows="3" aria-label="${esc(q.title)}">${esc(q.prefill || '')}</textarea>`}<div class="question-actions"><button class="btn sm primary" type="submit">Submit answer</button></div></form>` : ''}
      <button type="button" class="btn sm ghost question-cancel" data-uicancel="${esc(q.id)}">Cancel question</button>
    </section>`).join(''));
    el.dataset.first = questions[0].id;
    // Take focus for a new question, but never from a field the user is typing in.
    const a = document.activeElement, typing = a && /INPUT|TEXTAREA/.test(a.tagName) && a.value && !el.contains(a);
    if (first !== questions[0].id && !typing) el.querySelector('input,textarea,[data-uichoice]')?.focus();
  }

  async function answerQuestion(id, answer, control) {
    const c = current();
    if (c.kind !== 'session') return;
    const section = control.closest('.question');
    const controls = () => section.querySelectorAll('button,input,textarea');
    controls().forEach(el => { el.disabled = true; });
    try { await api(`/sessions/${c.id}/command`, { type: 'answer', id, ...answer }); }
    catch (e) { toast(e.message, 'err'); }
    await refresh();
    // A re-render replaces the section once the question clears; if it didn't, make it usable again.
    controls().forEach(el => { el.disabled = false; });
  }

  function renderQueue(s) {
    const el = $('#queued'), items = s?.queuedMessages || [];
    el.hidden = !items.length;
    if (!items.length) { setIfChanged(el, ''); return; }
    const waiting = !['running', 'queued'].includes(s.status);
    const when = waiting ? 'Sends after your next message' : 'Sends when OMP finishes';
    const editingAny = S.editQueue?.view === S.view && items.some(q => q.id === S.editQueue.id);
    const open = editingAny || (S.queueOpen === S.view && items.length > 1);
    const count = `${items.length} ${items.length === 1 ? 'message' : 'messages'} queued`;
    const toggle = items.length > 1 ? `<button class="btn sm ghost queued-toggle" data-qtoggle aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Show all'} queued messages" title="${open ? 'Collapse' : 'Show all'}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'}"/></svg></button>` : '';
    // Collapsed: one row like a chat app's queue: the count, the next message to go out, and its actions.
    if (!open) {
      const q = items[0];
      el.classList.add('compact');
      setIfChanged(el, `<div class="queued-row" title="${esc(when)}"><strong>${count}</strong><span class="queued-preview">${q.hasImage ? '<span class="queued-tag">[Image]</span> ' : ''}${esc(q.text)}</span>${queuedActions(q, waiting)}${toggle}</div>`);
      return;
    }
    el.classList.remove('compact');
    setIfChanged(el, `<div class="queued-head"><strong>${count}</strong><span>${when}</span>${toggle}</div>`
      + items.map((q, i) => {
        const editing = S.editQueue?.view === S.view && S.editQueue.id === q.id;
        return `<div class="queued-item"><span class="queued-number">${i + 1}</span><div class="queued-content">
          ${editing ? `<textarea data-qinput="${esc(q.id)}" rows="3" aria-label="Edit queued message">${esc(q.text)}</textarea>
            <div class="queued-edit-actions"><button class="btn sm primary" data-qsave="${esc(q.id)}">Save</button><button class="btn sm ghost" data-qclose>Cancel</button></div>`
          : `<div class="queued-text">${esc(q.text || (q.hasImage ? 'Image attached' : ''))}</div>${q.hasImage ? `<div class="queued-image">${[].concat(q.imagePreview || []).map(src => `<img src="${esc(src)}" alt="Queued image">`).join('')}<span>Image attached</span></div>` : ''}`}</div>
          ${queuedActions(q, waiting)}</div>`;
      }).join(''));
  }
  function queuedActions(q, waiting) {
    return `<div class="queued-actions"><button class="btn sm ghost" data-qsend="${esc(q.id)}" aria-label="${waiting ? 'Send now' : 'Steer now'}" title="${waiting ? 'Send now' : 'Steer now: redirect the current work with this message'}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg></button><button class="btn sm ghost" data-qedit="${esc(q.id)}" aria-label="Edit queued message" title="Edit queued message"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button><button class="btn sm ghost" data-qremove="${esc(q.id)}" aria-label="Remove queued message" title="Remove queued message">✕</button></div>`;
  }
  async function queuedAction(type, id, message) {
    const c = current();
    if (c.kind !== 'session') return;
    try {
      await api(`/sessions/${c.id}/command`, { type, id, ...(type === 'edit_follow_up' ? { message } : {}) });
      S.editQueue = null;
      await refresh();
    } catch (e) { toast(e.message, 'err'); await refresh(); }
  }

  function renderComposer(s, native) {
    const input = $('#input'), hint = $('#hint'), buttons = $('#buttons'), line = $('#statusLine');
    const attachment = attached().length > 0;
    renderAttachments();
    let placeholder, hintText, btns, status = '';
    const has = !!input.value.trim() || !!attachment;
    const choice = !s && native ? S.nativeChoice.get(current().file) : null;
    setIfChanged($('#modelSlot'), s ? modelChip(sessionModel(s), s.thinking, defaultLabel()) + advisorChip(s)
      : choice ? modelChip(choice.model, choice.thinking, 'Saved model')
      : modelChip(native?.model, native?.thinking, 'Saved model'));
    if (!s) {
      placeholder = 'Continue this session…';
      hintText = 'Enter to continue · Shift+Enter for a new line';
      btns = `<button class="btn primary" data-act="send" ${has && !S.busy ? '' : 'disabled'}>${S.busy ? 'Starting…' : 'Continue ↵'}</button>`;
      status = `<span class="grow">From OMP history${native?.cwd ? ' · ' + esc(native.cwd) : ''}. Don't continue it here while it's still open in a terminal.</span>`;
    } else if (s.status === 'running' || s.status === 'queued') {
      placeholder = 'Steer OMP while it works…';
      hintText = 'Enter steers now · Alt+Enter queues for later';
      btns = `<button class="btn" data-act="follow_up" ${has && !S.busy ? '' : 'disabled'} title="Send after OMP finishes (Alt+Enter)">Queue</button>
        <button class="btn primary" data-act="steer" ${has && !S.busy ? '' : 'disabled'} title="Redirect the current work at the next tool or turn boundary (Enter)">Steer ↵</button>
        <button class="btn danger" data-act="abort" title="Stop the current turn">■</button>`;
    } else {
      const fresh = !s.messages.some(m => m.role === 'user');
      placeholder = fresh ? 'What should OMP do?' : s.status === 'done' ? 'Send a message to reopen this session…' : 'Reply to continue…';
      hintText = 'Enter to send · Shift+Enter new line · / commands · !cmd shell';
      btns = `<button class="btn primary" data-act="send" ${has && !S.busy ? '' : 'disabled'}>${S.busy ? 'Sending…' : 'Send ↵'}</button>`;
      if (s.status === 'error') status = `<span class="grow">⚠ ${esc(s.error || 'OMP reported an error.')}</span><button class="btn sm" data-act="retry">Retry last message</button>`;
      else if (s.status === 'review') status = `<span class="grow">OMP finished. Review the result, reply to keep going, or mark it done.</span>`;
      else if (s.status === 'paused' && !fresh) status = `<span class="grow">Idle. Reply to continue from where it left off.</span>`;
    }
    if (s?._planReview) {
      status = `<span class="grow">Plan ready for review. Approval is required before implementation.</span><button class="btn sm primary" data-plan-review="${esc(s.id)}" ${S.planBusy.has(s.id) ? 'disabled' : ''}>Review plan</button>`;
      placeholder = 'Type feedback to keep planning without approving…';
    }
    if (s?._bash) btns = `<button class="btn danger" data-act="abortBash" title="Stop the shell command">■ Stop command</button>` + btns;
    // Extensions can pre-fill the composer (set_editor_text); apply each request once, after any unsent draft.
    if (s?._editorText && S.editorApplied !== s._editorText.id) { S.editorApplied = s._editorText.id; input.value = input.value.trim() ? input.value + '\n\n' + s._editorText.text : s._editorText.text; drafts.set(S.view, input.value); autosize(input); }
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    hint.textContent = hintText;
    setIfChanged(buttons, btns);
    line.className = 'status-line' + (s?.status === 'error' ? ' err' : '');
    setIfChanged(line, status);
  }

  // ---------- extension UI: links, widgets, status, notifications ----------
  const plain = v => String(v).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  function renderExtras(s) {
    const el = $('#extras'), parts = [];
    const link = s?._openUrl && S.urlDismissed !== s._openUrl.id ? s._openUrl : null;
    const safeUrl = link && /^(https?:|mailto:)/i.test(link.url);
    if (link) parts.push(`<div class="extra-link"><span class="grow">${esc(link.instructions || 'OMP needs you to open this link to continue.')}</span>${safeUrl ? `<a class="btn sm primary" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">Open link</a>` : `<code>${esc(link.url)}</code>`}<button class="btn sm ghost" data-copy-text="${esc(link.url)}">Copy</button><button class="btn sm ghost" data-act="dismissUrl" data-id="${esc(link.id)}" aria-label="Dismiss link">✕</button></div>`);
    for (const [key, lines] of Object.entries(s?._widgets || {})) parts.push(`<pre class="extra-widget" title="${esc(key)}">${esc(plain(lines.join('\n')))}</pre>`);
    const status = Object.entries(s?._status || {});
    if (status.length) parts.push(`<div class="extra-status">${status.map(([k, v]) => `<span title="${esc(k)}">${esc(plain(v))}</span>`).join('')}</div>`);
    el.hidden = !parts.length;
    setIfChanged(el, parts.join(''));
  }
  // Toast notifications that arrived since this session was last on screen; the first look only records where we are.
  function showNotices(s) {
    const list = s._notices || [], seen = S.noticeSeen.get(s.id);
    S.noticeSeen.set(s.id, list.length ? list[list.length - 1].id : '');
    if (seen === undefined) return;
    const from = list.findIndex(n => n.id === seen) + 1;
    for (const n of list.slice(from)) toast(n.text, n.level === 'info' ? '' : 'err');
  }

  // ---------- dialogs ----------
  function modal(title, body) {
    const returnFocus = document.activeElement;
    if (!closeModal()) return toast('Wait for the current dialog to finish.', 'err');
    const el = document.createElement('div');
    el.id = 'modal'; el.className = 'modal'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', title);
    el._returnFocus = returnFocus;
    el.innerHTML = `<div class="modal-card"><div class="modal-head"><strong>${esc(title)}</strong><button class="btn sm ghost" data-modal-close aria-label="Close">✕</button></div><div class="modal-body">${body}</div></div>`;
    document.body.appendChild(el);
    (el.querySelector('.modal-body textarea, .modal-body button:not([disabled])') || el.querySelector('[data-modal-close]')).focus();
  }
  const closeModal = () => { const el = $('#modal'); if (el?._planOwner && S.planBusy.has(el._planOwner)) return false; const focus = el?._returnFocus; el?.remove(); if (focus?.isConnected) focus.focus(); return true; };
  const sessionApi = body => api(`/sessions/${current().id}/command`, body);
  async function togglePlan(id) {
    const s = S.store?.sessions.find(x => x.id === id);
    if (!s || s._planSupported === false || s.planMode?.available === false) return toast('Plan mode requires updated OMP RPC support.', 'err');
    if (S.planBusy.has(id)) return;
    S.planBusy.add(id); update();
    try { await api(`/sessions/${id}/command`, { type: 'plan_mode', enabled: !s.planMode?.enabled }); await refresh(); }
    catch (e) { toast(e.message, 'err'); }
    finally { S.planBusy.delete(id); update(); }
  }
  async function openPlanReview(id) {
    if (S.planBusy.has(id)) return;
    const s = S.store?.sessions.find(x => x.id === id);
    if (!s?.planMode?.available) return toast('Plan review requires updated OMP RPC support.', 'err');
    S.planBusy.add(id); update();
    try {
      let proposal = s._planReview;
      if (!proposal || S.planSubmitted.has(id + ':' + proposal.id)) proposal = (await api(`/sessions/${id}/command`, { type: 'plan_review' })).proposal;
      if (!proposal) throw new Error('No plan is ready for review yet.');
      const owner = S.store?.sessions.find(x => x.id === id);
      if (owner) owner._planReview = proposal;
      if (current().kind !== 'session' || current().id !== id) return;
      const key = id + ':' + proposal.id;
      if (S.planSubmitted.has(key)) throw new Error('This proposal has already been submitted. Wait for the next plan.');
      const returnFocus = document.activeElement;
      modal(proposal.title || 'Review native plan', `<div class="plan-review-intro"><p>Read the plan before choosing how to continue. Closing this review does not approve or implement it.</p><p class="muted plan-review-path">${esc(proposal.planFilePath || '')}</p></div><article class="md plan-review-content" tabindex="0" aria-label="Proposed plan">${md(proposal.content || '')}</article><form data-plan-approval><fieldset><legend>Execution context</legend><label class="plan-context"><input type="radio" name="action" value="preserve" required><span><strong>Keep context</strong><small>Implement with the current conversation intact.</small></span></label><label class="plan-context"><input type="radio" name="action" value="fresh"><span><strong>Fresh context</strong><small>Start implementation in a fresh context with the plan.</small></span></label><label class="plan-context"><input type="radio" name="action" value="compact"><span><strong>Compact context</strong><small>Summarize the conversation before implementation.</small></span></label><label class="plan-context"><input type="radio" name="action" value="refine"><span><strong>Request refinement</strong><small>Stay in read-only planning and revise the plan using your feedback.</small></span></label></fieldset><label class="plan-feedback">Feedback <span class="muted">(required for refinement)</span><textarea name="feedback" rows="3" maxlength="20000" placeholder="What should change or guide implementation?"></textarea></label><div class="plan-model"><span>Execution model</span><button class="model-chip" type="button" data-plan-model>OMP default ▾</button></div><p class="plan-review-error" role="alert" hidden></p><div class="question-actions"><button class="btn" type="button" data-modal-close>Review later</button><button class="btn primary" type="submit">Confirm selected action</button></div></form>`);
      if ($('#modal')?._planOwner) return; // modal() refused: another plan review is still submitting
      const dialog = $('#modal'), form = dialog.querySelector('[data-plan-approval]');
      dialog.classList.add('plan-review-modal');
      dialog._planOwner = id; dialog._returnFocus = returnFocus;
      dialog.querySelector('.modal-body').scrollTop = 0;
      dialog.querySelector('.plan-review-content').focus({ preventScroll: true });
      let executionModel = '';
      dialog.querySelector('[data-plan-model]').onclick = () => openPicker({ model: splitSel(executionModel).sel, thinking: splitSel(executionModel).thinking, allowDefault: true, apply: (sel, th) => {
        if (!dialog.isConnected) return;
        executionModel = sel ? sel + (th ? ':' + th : '') : '';
        dialog.querySelector('[data-plan-model]').textContent = (sel ? modelLabel(sel, th) : 'OMP default') + ' ▾';
        dialog.querySelector('[data-plan-model]').focus();
      } });
      form.onsubmit = async e => {
        e.preventDefault();
        if (S.planBusy.has(id) || S.planSubmitted.has(key)) return;
        const action = form.elements.action.value, feedback = form.elements.feedback.value.trim();
        const error = form.querySelector('[role="alert"]');
        if (!action || action === 'refine' && !feedback) { error.hidden = false; error.textContent = !action ? 'Choose an execution context or request refinement.' : 'Add feedback describing the refinement.'; return; }
        if (action !== 'refine' && feedback) { error.hidden = false; error.textContent = 'Feedback is for Request refinement. Clear it to approve implementation.'; return; }
        const live = S.store?.sessions.find(x => x.id === id)?._planReview;
        if (!live || live.id !== proposal.id || live.content !== proposal.content) { error.hidden = false; error.textContent = 'This proposal is no longer current. Close this review and reopen the latest plan.'; return; }
        S.planBusy.add(id); error.hidden = true;
        dialog.querySelectorAll('button,input,textarea').forEach(x => x.disabled = true); update();
        try {
          await api(`/sessions/${id}/command`, { type: 'plan_approve', proposalId: proposal.id, action, ...(feedback ? { feedback } : {}), ...(executionModel && action !== 'refine' ? { executionModel } : {}) });
          S.planSubmitted.add(key);
          S.planBusy.delete(id);
          if ($('#modal') === dialog) closeModal();
          await refresh();
        } catch (err) { error.hidden = false; error.textContent = err.message; }
        finally { S.planBusy.delete(id); dialog.querySelectorAll('button,input,textarea').forEach(x => x.disabled = false); update(); }
      };
    } catch (e) { toast(e.message, 'err'); }
    finally { S.planBusy.delete(id); update(); }
  }
  async function openBranch() {
    try {
      const r = await sessionApi({ type: 'branch_messages' });
      if (!r.messages.length) return toast('There are no earlier messages to branch from.');
      const label = m => { const t = m.text || 'Image attached'; return t.length > 160 ? t.slice(0, 160) + '…' : t; };
      modal('Branch from an earlier message', `<p class="muted">OMP starts a new session with everything before the message you pick. That message goes back into the composer so you can change it.</p><div class="modal-list">${r.messages.map(m => `<button data-branch="${esc(m.entryId)}" title="${esc(m.text || '')}">${esc(label(m))}</button>`).join('')}</div>`);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function doBranch(entryId) {
    const buttons = document.querySelectorAll('#modal [data-branch]');
    if ([...buttons].some(b => b.disabled)) return;
    buttons.forEach(b => { b.disabled = true; });
    try {
      const r = await sessionApi({ type: 'branch', entryId });
      closeModal();
      await refresh(); S.lastSig = '';
      const input = $('#input');
      if (input && r.text) { input.value = r.text; drafts.set(S.view, r.text); autosize(input); input.focus(); }
      update(); toast('Branched into a new session');
    } catch (e) { toast(e.message, 'err'); buttons.forEach(b => { b.disabled = false; }); }
  }
  const openHandoff = () => modal('Hand off to a fresh session', `<form data-handoff><p class="muted">OMP writes a summary of this session, then continues in a fresh context that starts from that summary.</p><textarea name="instructions" rows="3" maxlength="5000" placeholder="Optional: what the handoff should focus on"></textarea><div class="question-actions"><button class="btn sm primary" type="submit">Hand off</button></div></form>`);
  async function exportHtml() {
    try {
      toast('Exporting…');
      const r = await sessionApi({ type: 'export' });
      const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }));
      const a = document.createElement('a'); a.href = url; a.download = r.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function showStats() {
    try {
      const { stats: x } = await sessionApi({ type: 'stats' });
      const t = x.tokens || {};
      const rows = [
        ['Messages', `${x.userMessages} from you · ${x.assistantMessages} from OMP · ${x.totalMessages} total`],
        ['Tool calls', x.toolCalls],
        ['Tokens', `${fmtTokens(t.total)} total · ${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out`],
        ['Cache', `${fmtTokens(t.cacheRead)} read · ${fmtTokens(t.cacheWrite)} written`],
        ...(t.reasoning ? [['Reasoning', fmtTokens(t.reasoning) + ' tokens']] : []),
        ['Cost', '$' + (x.cost || 0).toFixed(4)],
        ...(x.premiumRequests ? [['Premium requests', x.premiumRequests]] : []),
        ...(x.contextUsage?.tokens ? [['Context', `${fmtTokens(x.contextUsage.tokens)} of ${fmtTokens(x.contextUsage.contextWindow)}`]] : []),
        ...Object.entries(x.routedModels || {}).map(([m, n]) => [m, `${n} ${n === 1 ? 'turn' : 'turns'}`]),
      ];
      modal('Session stats', `<dl class="stats">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v ?? ''))}</dd>`).join('')}</dl>`);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function openLogin() {
    try {
      const { providers } = await sessionApi({ type: 'login_providers' });
      modal('Log in to a provider', providers.length
        ? `<div class="modal-list">${providers.map(p => `<button data-login="${esc(p.id)}" ${p.available ? '' : 'disabled'}>${esc(p.name)}${p.authenticated ? ' <small>✓ logged in</small>' : ''}</button>`).join('')}</div><p class="muted">A sign-in link appears above the composer once OMP starts the login.</p>`
        : '<p class="muted">OMP has no OAuth providers to log in to.</p>');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function sessionAction(body) {
    try { await sessionApi(body); await refresh(); return true; }
    catch (e) { toast(e.message, 'err'); return false; }
  }

  // ---------- slash command completion ----------
  async function loadCommands(key) {
    try { const r = await api('/commands?' + key); S.cmds.set(key, { at: Date.now(), list: r.commands }); }
    catch (e) { const failedBefore = S.cmds.get(key)?.error; S.cmds.set(key, { at: Date.now(), list: [], error: e.message }); if (!failedBefore) toast('Could not load slash commands: ' + e.message, 'err'); }
    finally { S.cmdsLoading.delete(key); }
    renderSlash();
  }
  function renderSlash() {
    const el = $('#slash'), input = $('#homePrompt') || $('#input'), c = current();
    if (!el) return;
    const m = (input?.value || '').match(/^\/(\S*)$/);
    const key = c.kind === 'session' ? 'session=' + encodeURIComponent(c.id)
      : c.kind === 'home' && S.home.listing ? 'path=' + encodeURIComponent(S.home.listing.path) : '';
    if (!key || !m) { S.slash = null; el.hidden = true; input?.removeAttribute('aria-activedescendant'); input?.setAttribute('aria-expanded', 'false'); return; }
    const cached = S.cmds.get(key);
    if ((!cached || Date.now() - cached.at > 30000) && !S.cmdsLoading.has(key)) {
      S.cmdsLoading.add(key); loadCommands(key);
    }
    const q = m[1].toLowerCase();
    const items = (cached?.list || []).filter(x => {
      const name = x.name.toLowerCase();
      return name.startsWith(q) || (name.startsWith('skill:') && name.startsWith(q, 6)) || x.aliases.some(a => a.toLowerCase().startsWith(q));
    });
    S.slash = items.length ? { items, hi: Math.min(S.slash?.hi || 0, items.length - 1) } : null;
    el.hidden = !S.slash && !S.cmdsLoading.has(key);
    el.innerHTML = S.slash ? items.map((x, i) => `<button type="button" id="slash-option-${i}" role="option" aria-selected="${i === S.slash.hi}" class="${i === S.slash.hi ? 'hi' : ''}" data-slash="${esc(x.name)}"><b>/${esc(x.name)}</b>${x.hint ? ` <span class="muted">${esc(x.hint)}</span>` : ''}${x.description ? `<small>${esc(x.description)}</small>` : ''}</button>`).join('') : S.cmdsLoading.has(key) ? '<div role="status">Loading commands…</div>' : '';
    if (S.slash) input.setAttribute('aria-activedescendant', 'slash-option-' + S.slash.hi);
    else input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', String(!el.hidden));
  }
  function pickSlash(name) {
    const input = $('#homePrompt') || $('#input');
    input.value = '/' + name + ' ';
    if (input.id === 'homePrompt') S.home.prompt = input.value;
    else drafts.set(S.view, input.value);
    autosize(input); renderSlash(); input.focus(); update();
  }

  // ---------- actions ----------
  // Message previews: one data URL (older saved messages) or a list.
  const safeImg = src => /^(data:image\/|blob:|https?:|\/)/i.test(String(src || ''));
  const images = list => [].concat(list || []).filter(safeImg).map(src => `<button type="button" class="msg-image-btn" aria-label="View attached image full size"><img class="msg-image" src="${esc(src)}" alt="Attached image"></button>`).join('');
  const attached = () => S.attachments.filter(a => a.view === S.view);
  const imagePayload = list => list.length ? { images: list.map(a => a.image), preview: list.map(a => a.preview) } : {};
  async function attachImage(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 25 * 1024 * 1024) return toast('Choose a PNG, JPEG, WebP or GIF under 25 MB.', 'err');
    if (attached().length >= 6) return toast('Attach up to 6 images per message.', 'err');
    const view = S.view;
    try {
      const bitmap = await createImageBitmap(file);
      let blob = file, mimeType = file.type, preview;
      try {
        const canvas = document.createElement('canvas');
        const draw = max => {
          const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        };
        if (file.size > 5 * 1024 * 1024) {
          draw(1568);
          blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
          if (!blob) throw new Error('Could not resize this image.');
          mimeType = 'image/jpeg';
        }
        draw(1024);
        preview = canvas.toDataURL('image/jpeg', .8);
      } finally { bitmap.close(); }
      if (blob.size > 5 * 1024 * 1024 || preview.length > 1024 * 1024) throw new Error('Image is too large to send.');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read this image.'));
        reader.readAsDataURL(blob);
      });
      if (S.view !== view) return;
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mimeType];
      const stem = (file.name || 'pasted-image').replace(/\.[A-Za-z0-9]+$/, '') || 'pasted-image';
      const name = `${stem}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      S.attachments.push({ view, image: { type: 'image', mimeType, data }, preview, name });
      update(); renderAttachments();
    } catch (e) { toast(e.message || 'Could not attach this image.', 'err'); }
  }

  async function send(kind) {
    const c = current();
    const input = $('#input');
    const text = input?.value.trim();
    const attachment = attached();
    if ((!text && !attachment.length) || S.busy) return;
    // "!command" runs in the session's shell (OMP's bash RPC); the output joins the conversation context.
    if (c.kind === 'session' && !attachment.length && /^!\S/.test(text)) {
      input.value = ''; drafts.delete(S.view); autosize(input);
      if (!await sessionAction({ type: 'bash', command: text.slice(1) })) { input.value = text; drafts.set(S.view, text); autosize(input); }
      return;
    }
    S.busy = true;
    S.pending = { view: S.view, text, imagePreview: attachment.map(a => a.preview), queued: kind === 'follow_up', at: Date.now() };
    S.attachments = S.attachments.filter(a => a.view !== S.view);
    input.value = ''; drafts.delete(S.view); autosize(input);
    S.lastSig = ''; update();
    let retryView = S.view;
    try {
      if (c.kind === 'native') {
        const ch = S.nativeChoice.get(c.file);
        const s = await api('/omp-sessions/resume', { file: c.file, message: text, ...imagePayload(attachment), ...(ch ? { model: ch.model, thinking: ch.thinking } : {}) });
        if (s.status === 'error') { retryView = 'session:' + s.id; await refresh(); location.hash = '#/s/' + s.id; throw new Error(s.error || 'OMP could not send this message.'); }
        await refresh();
        S.pending = { view: 'session:' + s.id, text, imagePreview: S.pending.imagePreview, at: S.pending.at };
        location.hash = '#/s/' + s.id;
      } else {
        const s = S.store?.sessions.find(x => x.id === c.id);
        if (!s) throw new Error('This session no longer exists.');
        const type = kind || (s.status === 'running' || s.status === 'queued' ? 'steer' : 'prompt');
        const response = await api(`/sessions/${c.id}/command`, { type, message: text, ...imagePayload(attachment) });
        if (response.status === 'error') throw new Error(response.error || 'OMP could not send this message.');
        if (type === 'follow_up') toast((response.queuedMessages?.length || 0) > (s.queuedMessages?.length || 0) ? 'Queued. Sends when OMP finishes' : 'OMP was already done, so this was sent now');
        await refresh();
      }
    } catch (e) {
      toast(e.message, 'err');
      if (text) { drafts.set(retryView, text); const target = S.view === retryView ? $('#input') : null; if (target && !target.value) { target.value = text; autosize(target); } }
      S.attachments.push(...attachment.map(a => ({ ...a, view: retryView })));
    } finally {
      S.busy = false; S.pending = null; S.lastSig = ''; update();
    }
  }
  async function sessionCommand(type) {
    const c = current();
    try { await api(`/sessions/${c.id}/command`, { type }); await refresh(); if (type === 'complete') toast('Marked done'); if (type === 'compact') toast('Context compacted'); return true; }
    catch (e) { toast(e.message, 'err'); return false; }
  }
  async function advisorCommand(action) {
    const c = current();
    try { await api(`/sessions/${c.id}/command`, { type: 'advisor', action }); await refresh(); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ---------- OMP settings ----------
  const GROUPS = [['model', 'Models'], ['interaction', 'Interaction & approvals'], ['context', 'Context & compaction'], ['tools', 'Tools'], ['tasks', 'Tasks & subagents'], ['appearance', 'Appearance'], ['shell', 'Shell'], ['files', 'Files'], ['memory', 'Memory'], ['providers', 'Providers'], ['other', 'Other'], ['internal', 'Advanced']];
  const groupLabel = g => (GROUPS.find(x => x[0] === g) || [g, g[0].toUpperCase() + g.slice(1)])[1];
  // Records that map a name to a model selector get the model picker instead of raw JSON.
  const MODEL_MAPS = new Set(['modelRoles', 'task.agentModelOverrides']);
  const human = key => { const last = key.split('.').pop().replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2'); return last[0].toUpperCase() + last.slice(1); };
  const fmtVal = v => v === undefined ? 'not set' : typeof v === 'string' ? v : JSON.stringify(v);
  const stringList = v => Array.isArray(v) && v.every(x => typeof x === 'string');
  S.set = { data: null, q: '', group: '', changed: false, error: '', plugins: null, pluginError: '' };

  function buildSettings() {
    main().innerHTML = `<div class="topbar"><button class="btn sm ghost menu-btn" data-act="nav" aria-label="Open navigation">☰</button>
      <div class="title-block"><h1>OMP settings</h1><div class="meta" id="setMeta"></div></div>
      <div class="actions"><button class="btn sm" data-act="ompUpdate">Update OMP</button><button class="btn sm ghost" data-act="setReload" title="Read the settings again" aria-label="Reload settings">↻ <span class="lbl">Reload</span></button></div></div>
      <div class="settings"><nav class="set-nav" id="setNav"></nav>
        <div class="set-main" id="setMain"><div class="update-status" id="updateStatus" role="status" aria-live="polite" hidden></div><div class="set-tools"><input id="setSearch" placeholder="Search settings and plugins… (e.g. approval, compaction, theme)" value="${esc(S.set.q)}" spellcheck="false" autocomplete="off">
          <label class="check"><input type="checkbox" id="setChanged" ${S.set.changed ? 'checked' : ''}> Changed only</label></div>
          <div id="setList"><div class="working"><span class="spinner"></span> Reading OMP settings…</div></div></div></div>`;
    renderUpdateStatus();refreshUpdater();loadSettings();
  }
  function renderUpdateStatus() {
    const el = $('#updateStatus');
    if (!el) return;
    const u = S.ompUpdate;
    $('[data-act="ompUpdate"]').disabled = u.status === 'running';
    el.hidden = u.status === 'idle';
    el.className = 'update-status' + (u.status === 'error' ? ' err' : '');
    if (!el.hidden) setIfChanged(el, u.status === 'running'
      ? '<span class="spinner"></span> Updating OMP… this may take several minutes.'
      : `<strong>OMP update ${u.status === 'error' ? 'failed' : 'command finished'}</strong><pre>${esc(u.output || '')}</pre>${u.status === 'done' ? '<small>New sessions use any installed update. Restart existing sessions to use it.</small>' : ''}`);
  }
  async function refreshUpdater() {
    try { S.ompUpdate = await api('/omp-update'); }
    catch (e) { if (S.ompUpdate.status !== 'running') S.ompUpdate = { status: 'error', output: e.message }; }
    if (current().kind === 'settings') renderUpdateStatus();
  }
  async function updateOmp() {
    if (S.ompUpdate.status === 'running') return;
    S.ompUpdate = { status: 'running' }; renderUpdateStatus();
    try { S.ompUpdate = await api('/omp-update', {}); }
    catch (e) { await refreshUpdater(); if (S.ompUpdate.status !== 'running') S.ompUpdate = { status: 'error', output: e.message }; }
    if (current().kind === 'settings') renderUpdateStatus();
  }

  async function loadSettings() {
    const [d, p] = await Promise.all([api('/settings').catch(e => ({ _error: e.message })), api('/plugins').catch(e => ({ _error: e.message })), ensureModels().catch(() => {})]);
    if (d._error) S.set.error = d._error; else { S.set.data = placeSettings(d); S.set.error = ''; }
    if (p._error) S.set.pluginError = p._error; else { S.set.plugins = p; S.set.pluginError = ''; }
    if (current().kind === 'settings') renderSettings();
  }
  // OMP files the model role map under "internal", but it is the setting people look for first.
  const placeSettings = d => { for (const x of d.settings) if (MODEL_MAPS.has(x.key)) x.group = x.key === 'modelRoles' ? 'model' : 'tasks'; d.settings.sort((a, b) => (b.key === 'modelRoles') - (a.key === 'modelRoles')); return d; };
  function settingsView() {
    const q = S.set.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (S.set.data?.settings || []).filter(x => (!S.set.changed || x.modified) && (!q.length || q.every(w => (x.key + ' ' + x.description + ' ' + human(x.key) + ' ' + (x.options || []).join(' ')).toLowerCase().includes(w))));
  }
  const settingGroups = d => GROUPS.map(g => g[0]).concat([...new Set(d.settings.map(x => x.group))].filter(g => !GROUPS.some(x => x[0] === g)));
  function renderSettingsChrome() {
    const d = S.set.data, plug = S.set.plugins?.plugins || [];
    const shown = d ? settingsView() : [];
    const changed = d ? d.settings.filter(x => x.modified).length : 0;
    $('#setMeta').innerHTML = `${d ? `<span>${d.settings.length} settings · ${changed} changed</span>${d.file ? `<span class="path" data-copy-text="${esc(d.file)}" title="Copy path">${esc(d.file)}</span>` : ''}` : ''}${S.set.plugins ? `<span>${plug.length} plugins</span>` : ''}`;
    $('#setNav').innerHTML = `<a href="#sg-plugins" data-setgroup="plugins">Plugins<span>${plug.filter(x => x.enabled).length}/${plug.length}</span></a>` + (d ? settingGroups(d).filter(g => d.settings.some(x => x.group === g)).map(g => {
      const n = shown.filter(x => x.group === g).length, m = d.settings.filter(x => x.group === g && x.modified).length;
      return `<a href="#" data-setgroup="${esc(g)}" class="${n ? '' : 'dim'}">${esc(groupLabel(g))}<span>${m ? `<i title="${m} changed">●</i>` : ''}${n}</span></a>`;
    }).join('') : '');
  }
  function renderSettings() {
    const d = S.set.data;
    if (!d && !S.set.plugins) { $('#setList').innerHTML = S.set.error ? `<div class="msg system err"><div class="bubble">${esc(S.set.error)}</div></div>` : ''; return; }
    renderSettingsChrome();
    const groups = d ? (() => { const by = new Map(settingGroups(d).map(g => [g, []])); for (const x of settingsView()) (by.get(x.group) || by.set(x.group, []).get(x.group)).push(x); return [...by].filter(([, list]) => list.length).map(([g, list]) => `<section class="set-group" id="sg-${esc(g)}"><h2>${esc(groupLabel(g))}${g === 'internal' ? ' <small>used by OMP itself; change with care</small>' : ''}</h2>${list.map(settingRow).join('')}</section>`).join(''); })() : (S.set.error ? `<div class="msg system err"><div class="bubble">${esc(S.set.error)}</div></div>` : '');
    $('#setList').innerHTML = pluginsSection() + (groups || (d ? '<div class="history-note">No settings match.</div>' : ''));
  }
  function settingRow(x) {
    return `<div class="set-row ${x.modified ? 'mod' : ''}" data-row="${esc(x.key)}">
      <div class="set-info"><div class="set-name">${x.key.includes('.') ? `<span class="set-parent">${esc(x.key.split('.').slice(0, -1).map(human).join(' › '))} ›</span>` : ''}${esc(human(x.key))}${x.modified ? '<span class="tag mod">changed</span>' : ''}</div><code class="set-key" data-copy-text="${esc(x.key)}" title="Copy key">${esc(x.key)}</code>
        ${x.description ? `<div class="set-desc${x.description.length > 220 ? ' long' : ''}" title="${x.description.length > 220 ? 'Click to expand' : ''}">${esc(x.description)}</div>` : ''}
        ${x.modified && !x.sensitive && x.default !== undefined ? `<div class="set-def">Default: <code>${esc(fmtVal(x.default).slice(0, 200))}</code></div>` : ''}</div>
      <div class="set-ctl">${settingControl(x)}${x.modified || (x.sensitive && x.isSet) ? `<button class="btn sm ghost" data-setreset="${esc(x.key)}" title="Remove from config.yml and use OMP's default">Reset</button>` : ''}</div></div>`;
  }
  function settingControl(x) {
    const k = esc(x.key), v = x.value;
    if (x.sensitive) return `<input type="password" data-set="${k}" data-kind="string" placeholder="${x.isSet ? '•••••• set. Type to replace' : 'Not set'}" autocomplete="new-password">`;
    if (x.type === 'boolean') return `<label class="switch"><input type="checkbox" data-set="${k}" data-kind="boolean" ${v ? 'checked' : ''}><span></span></label>`;
    if (x.type === 'enum' || x.options) {
      const opts = [...(x.options || [])];
      if (v !== undefined && !opts.includes(String(v))) opts.unshift(String(v));
      return `<select data-set="${k}" data-kind="string">${v === undefined ? '<option value="" selected>Not set</option>' : ''}${opts.map(o => `<option ${String(v) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    if (x.type === 'number') return `<input type="number" step="any" data-set="${k}" data-kind="number" value="${v ?? ''}" placeholder="Not set">`;
    if (x.type === 'record' && MODEL_MAPS.has(x.key)) {
      const entries = Object.entries(v || {});
      return `<div class="model-map">${entries.map(([name, sel]) => { const s = splitSel(sel); return `<div class="mm-row"><span class="mm-name">${esc(name)}</span><button class="model-chip" data-mmkey="${k}" data-mmname="${esc(name)}" title="${esc(sel)}">◆ <span>${esc(modelLabel(s.sel, s.thinking) || sel)}</span> ▾</button><button class="btn sm ghost" data-mmdel="${k}" data-mmname="${esc(name)}" title="Remove">✕</button></div>`; }).join('')}
        <form class="mm-add" data-mmadd="${k}"><input placeholder="${x.key === 'modelRoles' ? 'Add role (e.g. plan, commit)' : 'Add agent name'}" spellcheck="false"><button class="btn sm">Add…</button></form></div>`;
    }
    if (x.type === 'array' && (v === undefined || stringList(v))) return `<textarea data-set="${k}" data-kind="lines" rows="${Math.min(8, Math.max(2, (v || []).length + 1))}" placeholder="One per line" spellcheck="false">${esc((v || []).join('\n'))}</textarea>`;
    if (x.type === 'array' || x.type === 'record') return `<textarea data-set="${k}" data-kind="json" rows="${Math.min(10, Math.max(2, JSON.stringify(v ?? (x.type === 'array' ? [] : {}), null, 2).split('\n').length))}" spellcheck="false">${esc(JSON.stringify(v ?? (x.type === 'array' ? [] : {}), null, 2))}</textarea>`;
    return `<input data-set="${k}" data-kind="string" value="${esc(v ?? '')}" placeholder="Not set" spellcheck="false">`;
  }
  async function saveSetting(key, value, reset) {
    const row = document.querySelector(`[data-row="${CSS.escape(key)}"]`);
    row?.classList.add('saving');
    try {
      S.set.data = placeSettings(await api(reset ? '/settings/reset' : '/settings', reset ? { key } : { key, value }));
      const x = S.set.data.settings.find(s => s.key === key);
      if (row && x) { row.outerHTML = settingRow(x); const nr = document.querySelector(`[data-row="${CSS.escape(key)}"]`); nr?.classList.add('saved'); setTimeout(() => nr?.classList.remove('saved'), 1200); }
      toast(reset ? `Reset ${key}` : `Saved ${key}`);
      if (/^modelRoles$|^defaultThinkingLevel$|^enabledModels$|Providers$/.test(key)) { S.models = null; ensureModels().then(() => { if (current().kind === 'settings') renderSettings(); }, () => {}); }
      if (current().kind === 'settings') renderSettingsChrome();
    } catch (e) {
      toast(e.message, 'err');
      row?.classList.remove('saving');
      const x = S.set.data?.settings.find(s => s.key === key);
      if (row && x) row.outerHTML = settingRow(x);
    }
  }
  function settingInput(el) {
    const key = el.dataset.set, kind = el.dataset.kind;
    const x = S.set.data?.settings.find(s => s.key === key);
    if (!x) return;
    if (kind === 'boolean') return saveSetting(key, el.checked);
    const raw = el.value;
    if (kind === 'number') { if (raw.trim() === '') return x.value === undefined ? null : saveSetting(key, null, true); const n = Number(raw); if (!isFinite(n)) return toast('Enter a number', 'err'); return n === x.value ? null : saveSetting(key, n); }
    if (kind === 'lines') { const list = raw.split('\n').map(s => s.trim()).filter(Boolean); return JSON.stringify(list) === JSON.stringify(x.value || []) ? null : saveSetting(key, list); }
    if (kind === 'json') { let v; try { v = JSON.parse(raw); } catch { el.classList.add('bad'); return toast('That is not valid JSON', 'err'); } el.classList.remove('bad'); return JSON.stringify(v) === JSON.stringify(x.value) ? null : saveSetting(key, v); }
    if (x.sensitive) { if (!raw) return; el.value = ''; return saveSetting(key, raw); }
    if (raw === '' && x.value !== undefined) return saveSetting(key, null, true);
    if (raw !== (x.value ?? '')) return saveSetting(key, raw);
  }
  function pickMapModel(key, name) {
    const x = S.set.data?.settings.find(s => s.key === key);
    const cur = splitSel((x?.value || {})[name] || '');
    openPicker({ model: cur.sel, thinking: cur.thinking, allowDefault: false, apply: (sel, th) => saveSetting(key, { ...(x?.value || {}), [name]: sel + (th ? ':' + th : '') }) });
  }
  function pluginBase(id) { return String(id).split('@')[0]; }
  function pluginsSection() {
    const p = S.set.plugins;
    let inner;
    if (!p) inner = S.set.pluginError ? `<div class="msg system err"><div class="bubble">${esc(S.set.pluginError)}</div></div>` : '<div class="working"><span class="spinner"></span> Reading OMP plugins…</div>';
    else {
      const q = S.set.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const match = x => !q.length || q.every(w => (x.id + ' ' + (x.description || '') + ' ' + (x.version || '')).toLowerCase().includes(w));
      const installed = p.plugins.filter(match);
      const known = new Set(p.plugins.map(x => pluginBase(x.id).toLowerCase()));
      const avail = (p.available || []).filter(a => match(a) && !known.has(pluginBase(a.id).toLowerCase()));
      inner = `<form class="mm-add" data-plugininstall style="max-width:1000px;margin-bottom:10px"><input placeholder="Install a plugin… (e.g. owner/repo or name@version)" spellcheck="false" autocomplete="off"><button class="btn sm">Install</button></form>`
        + (installed.map(pluginRow).join('') || '<div class="history-note">No installed plugins match.</div>')
        + (avail.length ? '<div class="section-label" style="margin-top:10px">Available</div>' + avail.map(a => `<div class="set-row" data-plugin="${esc(a.id)}"><div class="set-info"><div class="set-name">${esc(pluginBase(a.id))}</div><code class="set-key" title="Plugin id">${esc(a.id)}</code>${a.description ? `<div class="set-desc">${esc(a.description)}</div>` : ''}</div><div class="set-ctl"><button class="btn sm" data-pluginaction="install" data-plugin="${esc(a.id)}">Install</button></div></div>`).join('') : '');
    }
    return `<section class="set-group" id="sg-plugins"><h2>Plugins</h2><p class="set-desc">Turning a plugin off doesn't affect copies of its skills installed elsewhere, such as <code>~/.agents/skills</code>. To turn a skill off everywhere, add its name to <code>skills.ignoredSkills</code>. Run <code>/reload-plugins</code> or restart sessions to apply changes.</p>${inner}</section>`;
  }
  function pluginRow(x) {
    return `<div class="set-row${x.enabled ? '' : ' mod'}" data-plugin="${esc(x.id)}"><div class="set-info"><div class="set-name">${esc(pluginBase(x.id))}${x.enabled ? '' : '<span class="tag mod">disabled</span>'}</div><code class="set-key" data-copy-text="${esc(x.id)}" title="Copy plugin id">${esc(x.id)}${x.version ? ` · ${esc(x.version)}` : ''}</code>${x.description ? `<div class="set-desc">${esc(x.description)}</div>` : ''}</div><div class="set-ctl"><label class="switch" title="${x.enabled ? 'Disable' : 'Enable'}"><input type="checkbox" data-plugin-toggle="${esc(x.id)}" ${x.enabled ? 'checked' : ''}><span></span></label><button class="btn sm ghost" data-pluginaction="uninstall" data-plugin="${esc(x.id)}" title="Uninstall this plugin">Remove</button></div></div>`;
  }
  async function savePlugin(action, id) {
    document.querySelector(`[data-plugin="${CSS.escape(id)}"]`)?.classList.add('saving');
    try {
      S.set.plugins = await api('/plugins', { action, id });
      S.set.pluginError = '';
      toast(action === 'install' ? `Installed ${id}` : action === 'uninstall' ? `Removed ${id}` : action === 'enable' ? `Enabled ${id}` : `Disabled ${id}`);
    } catch (e) { toast(e.message, 'err'); }
    if (current().kind === 'settings') renderSettings();
  }

  // ---------- home / new session ----------
  function buildHome() {
    main().innerHTML = `<div class="topbar"><button class="btn sm ghost menu-btn" data-act="nav" aria-label="Open navigation">☰</button><div class="title-block"><h1>New session</h1></div></div><div class="home"><div class="home-inner" id="home"></div></div>`;
    renderHome();
    if (!S.home.roots) api('/browse').then(r => { S.home.roots = r.roots; S.home.recent = r.recent; renderHome(); }).catch(e => toast(e.message, 'err'));
  }
  function renderHome() {
    const el = $('#home');
    if (!el) return;
    const h = S.home, l = h.listing;
    const f = h.filter.toLowerCase();
    const recentSessions = items().filter(it => !it.archived).slice(0, 5);
    el.innerHTML = `
      <div><h2>Where do you want to work?</h2></div>
      <p class="sub">Pick a folder, say what to do, press Enter. Earlier sessions are in the sidebar.</p>
      <div>
        <div class="section-label">Recent folders</div>
        <div class="chips">${(h.recent || []).map(r => `<button class="chip ${l && norm(l.path) === norm(r.path) ? 'sel' : ''}" data-go="${esc(r.path)}" title="${esc(r.path)}">${esc(r.name)} <small>${esc(ago(r.lastUsed))}</small></button>`).join('') || (h.roots ? '<span class="sub" style="margin:0">None yet</span>' : '<span class="spinner"></span>')}</div>
      </div>
      <div class="folder-box">
        <form class="folder-head" id="pathForm">
          ${l?.parent ? `<button type="button" class="btn sm" data-go="${esc(l.parent)}" title="Parent folder">↑</button>` : ''}
          <input id="pathInput" placeholder="Paste or type a folder path, e.g. C:\\Users\\you\\code\\app" value="${esc(l?.path || '')}" spellcheck="false">
          <button class="btn sm">Open</button>
        </form>
        ${l ? `
          <input class="folder-filter" id="folderFilter" placeholder="Filter ${l.dirs.length} subfolders…" value="${esc(h.filter)}">
          <div class="folder-list">${l.dirs.filter(d => d.name.toLowerCase().includes(f)).map(d => `<button data-go="${esc(d.path)}">${esc(d.name)}</button>`).join('') || '<div class="sub" style="padding:6px 8px;margin:0">No subfolders</div>'}</div>`
        : `<div style="padding:10px 12px" class="chips">${(h.roots || []).map(r => `<button class="chip" data-go="${esc(r.path)}">${esc(r.name)}</button>`).join('')}</div>`}
      </div>
      ${l ? `
      <div>
        <div class="picked" style="margin-bottom:8px"><span>Working in</span><b>${esc(base(l.path))}</b>${l.isGit ? '<span class="tag">git</span>' : ''}</div>
        <div class="composer home-composer">
          <div class="slash" id="slash" role="listbox" aria-label="Slash commands" hidden></div>
          <input id="imageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
          <div class="attach-preview" id="imagePreview" hidden></div>
          <textarea id="homePrompt" rows="3" aria-label="Initial prompt" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list" aria-controls="slash" placeholder="What should OMP do in ${esc(base(l.path))}? Type / for commands and skills (optional).">${esc(h.prompt)}</textarea>
          <div class="composer-bar">
            ${modelChip(h.model, h.thinking, defaultLabel())}
            <button class="btn sm ghost attach-btn" data-act="attach" type="button" aria-label="Attach image" title="Attach image">＋ Image</button>
            <span class="hint"><label class="check" title="Advisor: a second model that reviews each turn"><input type="checkbox" id="homeAdvisor" ${(h.advisor ?? S.advCfg?.enabled) ? 'checked' : ''}> Advisor</label>${l.isGit ? `<label class="check"><input type="checkbox" id="isolate" ${h.isolate ? 'checked' : ''}> Isolated git worktree</label>` : ''}</span>
            <button class="btn primary" data-act="start" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Starting…' : 'Start session ↵'}</button>
          </div>
        </div>
      </div>` : ''}
      ${recentSessions.length ? `<div><div class="section-label">Pick up where you left off</div><div class="session-list" style="margin:0">${recentSessions.map(it => `
        <button class="item ${it.status === 'history' ? 'history' : ''}" data-key="${esc(it.key)}"><span class="dot ${it.status}"></span><span class="t">${esc(it.title)}</span><span class="ago">${esc(ago(it.updatedAt))}</span><span></span><span class="m">${esc(it.folder)}${it.model ? ` · <span class="mdl">${esc(modelLabel(it.model, it.thinking))}</span>` : ''}</span></button>`).join('')}</div></div>` : ''}`;
    renderAttachments();
    renderSlash();
    if (!S.advCfg) api('/advisor').then(cfg => { S.advCfg = cfg; const cb = $('#homeAdvisor'); if (cb && S.home.advisor === undefined) cb.checked = !!cfg.enabled; }, () => { });
  }
  function renderAttachments() {
    const preview = $('#imagePreview');
    if (!preview) return;
    const list = attached();
    preview.hidden = !list.length;
    setIfChanged(preview, list.map(a => `<div class="attach-item"><img src="${esc(a.preview)}" alt="${esc(a.name)}" title="${esc(a.name)}"><button class="btn sm ghost" data-act="removeImage" data-name="${esc(a.name)}" type="button" aria-label="Remove ${esc(a.name)}">✕</button></div>`).join(''));
  }
  async function goFolder(dir) {
    if (!dir) return;
    try {
      S.home.listing = await api('/browse?path=' + encodeURIComponent(dir));
      S.home.filter = '';
      renderHome();
      $('#homePrompt')?.focus();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function startSession() {
    const l = S.home.listing;
    if (!l || S.busy) return;
    S.busy = true; renderHome();
    const attachment = attached();
    S.attachments = S.attachments.filter(a => a.view !== S.view);
    try {
      const s = await api('/quick-start', { path: l.path, prompt: S.home.prompt, isolate: S.home.isolate && l.isGit, model: S.home.model, thinking: S.home.thinking, ...(S.home.advisor === undefined ? {} : { advisor: S.home.advisor }), ...imagePayload(attachment) });
      S.home.prompt = '';
      await refresh();
      location.hash = '#/s/' + s.id;
    } catch (e) {
      S.attachments.push(...attachment.map(a => ({ ...a, view: S.view })));
      toast(e.message, 'err');
    }
    S.busy = false;
    if (current().kind === 'home') renderHome();
  }
  function newSession(dir) {
    if (dir) { S.home.listing = null; goFolder(dir); }
    if (location.hash !== '#/new') location.hash = '#/new'; else route();
  }

  // ---------- connect ----------
  function renderConnect() {
    S.view = 'connect';
    $('#list').innerHTML = '';
    main().innerHTML = `<div class="center"><form class="card" id="connectForm">
      <h2>Connect to your companion</h2>
      <p>Open the link printed by <code>node companion/server.mjs</code>, or paste its connection token here.</p>
      <input id="tokenInput" type="password" placeholder="Connection token" autocomplete="off" autofocus>
      <button class="btn primary">Connect</button>
    </form></div>`;
  }

  // ---------- polling ----------
  async function refresh() {
    try {
      S.store = await api('/state');
      S.online = true; S.fails = 0;
    } catch (e) { S.online = false; S.fails = (S.fails || 0) + 1; if (e.auth) return; }
    if (Date.now() - S.nativeAt > 20000) {
      S.nativeAt = Date.now();
      try { S.native = (await api('/omp-sessions')).sessions; } catch {}
    }
    renderList();
    update();
  }
  const refreshNative = () => { S.nativeAt = 0; return refresh(); };
  async function loop() {
    if (S.token) { await refresh(); if (current().kind === 'settings' && S.ompUpdate.status === 'running') await refreshUpdater(); }
    const busy = panelSessions().some(s => s.status === 'running' || s.status === 'queued');
    // Back off while the companion is unreachable instead of hammering it every second.
    setTimeout(loop, S.online === false ? Math.min(30000, 1000 * 2 ** S.fails) : document.hidden ? 8000 : busy ? 1200 : 3500);
  }

  // ---------- events ----------
  function pickerCtx() {
    const c = current();
    if (c.kind === 'home') return { model: S.home.model, thinking: S.home.thinking, allowDefault: true, apply: (sel, th) => { S.home.model = sel; S.home.thinking = th; thinkSet(sel, th); renderHome(); $('#homePrompt')?.focus(); } };
    if (c.kind === 'session') {
      const s = S.store?.sessions.find(x => x.id === c.id);
      if (!s) return null;
      return { model: sessionModel(s), thinking: s.thinking, allowDefault: false, apply: async (sel, th) => {
        try { await api(`/sessions/${s.id}/command`, { type: 'set_model', model: sel, thinking: th }); await refresh(); thinkSet(sel, th); }
        catch (err) { toast(err.message, 'err'); }
        $('#input')?.focus();
      } };
    }
    if (c.kind === 'native') {
      const n = S.native.find(x => x.file === c.file);
      const ch = S.nativeChoice.get(c.file) || { model: n?.model || '', thinking: n?.thinking || '' };
      return { model: ch.model, thinking: ch.thinking, allowDefault: false, apply: (sel, th) => { S.nativeChoice.set(c.file, { model: sel, thinking: th }); thinkSet(sel, th); update(); $('#input')?.focus(); } };
    }
    return null;
  }
  async function cycleRole(dir) {
    try { await ensureModels(); } catch (e) { toast(e.message, 'err'); return; }
    const ctx = pickerCtx();
    if (!ctx) return;
    const list = ['default', 'smol', 'slow'].map(name => [name, S.models.roles?.[name]])
      .filter(([, value]) => value && modelInfo(splitSel(value).sel));
    if (!list.length) { toast('No available default, smol, or slow models', 'err'); return; }
    const cur = ctx.model || splitSel(S.models.roles.default || '').sel;
    const curTh = ctx.thinking || (!ctx.model ? splitSel(S.models.roles.default || '').thinking : '');
    const i = list.findIndex(([, v]) => { const s = splitSel(v); return s.sel === cur && (s.thinking || '') === curTh; });
    const [, val] = list[i < 0 ? (dir < 0 ? list.length - 1 : 0) : (i + dir + list.length) % list.length];
    const s = splitSel(val);
    closePicker();
    ctx.apply(s.sel, s.thinking);
  }
  document.addEventListener('click', e => {
    const t = e.target;
    const planToggle = t.closest('[data-plan-toggle]'), planReview = t.closest('[data-plan-review]');
    if (planToggle) { togglePlan(planToggle.dataset.planToggle); return; }
    if (planReview) { openPlanReview(planReview.dataset.planReview); return; }
    if (t.closest('#picker')) {
      const fav = t.closest('[data-fav]');
      if (fav) { toggleFav(fav.dataset.fav); const top = $('#pickerList').scrollTop; renderPicker(); $('#pickerList').scrollTop = top; return; }
      const row = t.closest('[data-pi]'), prov = t.closest('[data-prov]'), th = t.closest('[data-think]');
      if (row) pickModel(+row.dataset.pi);
      else if (prov) { S.picker.provider = prov.dataset.prov; S.picker.hi = 0; renderPicker(); $('#pickerQ').focus(); }
      else if (th) { S.picker.thinking = th.dataset.think; const k = S.picker.flat[S.picker.hi]?.sel; if (k) S.picker.mem[k] = S.picker.thinking; renderThink(); $('#pickerQ').focus(); }
      else if (!t.closest('.picker')) closePicker();
      return;
    }
    if (t.closest('#modal')) {
      // The backdrop only dismisses a dialog with nothing typed into it.
      const dirty = [...t.closest('#modal').querySelectorAll('textarea,input:not([type=checkbox]):not([type=radio])')].some(f => f.value.trim());
      if ((t.id === 'modal' && !dirty) || t.closest('[data-modal-close]')) closeModal();
      const br = t.closest('[data-branch]'), lg = t.closest('[data-login]');
      if (br) doBranch(br.dataset.branch);
      if (lg) { closeModal(); sessionAction({ type: 'login', provider: lg.dataset.login }); }
      return;
    }
    const sl = t.closest('[data-slash]');
    if (sl) { pickSlash(sl.dataset.slash); return; }
    const pf = t.closest('[data-pref]');
    if (pf) { pf.closest('.menu')?.classList.remove('open'); sessionAction({ type: 'pref', key: pf.dataset.pref, value: JSON.parse(pf.dataset.value) }); return; }
    const choice = t.closest('[data-uichoice]');
    if (choice) { answerQuestion(choice.dataset.uichoice, { value: choice.dataset.uivalue }, choice); return; }
    const yesNo = t.closest('[data-uiconfirm]');
    if (yesNo) { answerQuestion(yesNo.dataset.uiconfirm, { confirmed: yesNo.dataset.confirmed === 'true' }, yesNo); return; }
    const cancelQuestion = t.closest('[data-uicancel]');
    if (cancelQuestion) { answerQuestion(cancelQuestion.dataset.uicancel, { cancelled: true }, cancelQuestion); return; }
    const qedit = t.closest('[data-qedit]');
    if (qedit) { S.editQueue = { view: S.view, id: qedit.dataset.qedit }; renderQueue(S.store.sessions.find(s => s.id === current().id)); $('#queued textarea')?.focus(); return; }
    if (t.closest('[data-qtoggle]')) { S.queueOpen = S.queueOpen === S.view ? null : S.view; renderQueue(S.store.sessions.find(s => s.id === current().id)); return; }
    const qclose = t.closest('[data-qclose]');
    if (qclose) { S.editQueue = null; renderQueue(S.store.sessions.find(s => s.id === current().id)); return; }
    const qsave = t.closest('[data-qsave]');
    const qsend = t.closest('[data-qsend]');
    if (qsend) { qsend.disabled = true; queuedAction('send_follow_up', qsend.dataset.qsend); return; }
    if (qsave) { queuedAction('edit_follow_up', qsave.dataset.qsave, $('#queued textarea')?.value); return; }
    const qremove = t.closest('[data-qremove]');
    if (qremove) { if (confirm('Remove this queued message? It has not been sent to OMP.')) queuedAction('cancel_follow_up', qremove.dataset.qremove); return; }
    const ld = t.closest('.set-desc.long');
    if (ld) { ld.classList.toggle('open'); return; }
    const aa = t.closest('[data-advact]');
    if (aa) {
      if (aa.dataset.advact === 'status') advisorAction('status');
      else { closeThinkMenu(); const role = splitSel(S.advCfg?.model || ''); openPicker({ model: role.sel, thinking: role.thinking, allowDefault: false, apply: (sel, th) => { thinkSet(sel, th); advisorAction('model', sel + (th ? ':' + th : '')); } }); }
      return;
    }
    const ts = t.closest('[data-thinkset]');
    if (ts) { const ctx = $('#thinkMenu')._ctx; closeThinkMenu(); ctx.apply(ctx.model, ts.dataset.thinkset); return; }
    if (!t.closest('#thinkMenu, [data-act="thinkMenu"], [data-act="advMenu"]')) closeThinkMenu();
    const sg = t.closest('[data-setgroup]');
    if (sg) { e.preventDefault(); document.getElementById('sg-' + sg.dataset.setgroup)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); return; }
    const sr = t.closest('[data-setreset]');
    if (sr) { saveSetting(sr.dataset.setreset, null, true); return; }
    const pa = t.closest('[data-pluginaction]');
    if (pa) { if (pa.dataset.pluginaction === 'uninstall' && !confirm(`Uninstall ${pa.dataset.plugin}?`)) return; savePlugin(pa.dataset.pluginaction, pa.dataset.plugin); return; }
    const mm = t.closest('[data-mmkey]');
    if (mm) { pickMapModel(mm.dataset.mmkey, mm.dataset.mmname); return; }
    const md = t.closest('[data-mmdel]');
    if (md) { const x = S.set.data?.settings.find(s => s.key === md.dataset.mmdel); const v = { ...(x?.value || {}) }; delete v[md.dataset.mmname]; saveSetting(md.dataset.mmdel, v); return; }
    const dm = t.closest('[data-diffmode]');
    if (dm) { S.diffMode = dm.dataset.diffmode; try { localStorage.setItem('omp-diff-mode', S.diffMode); } catch {} S.lastSig = ''; $('#topbar')._html = ''; update(); return; }
    const jump = t.closest('[data-jump]');
    if (jump) { e.preventDefault(); document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); return; }
    const sub = t.closest('[data-sub]');
    if (sub) { openSub(sub.dataset.sub); return; }
    const subName = t.closest('[data-subname]');
    if (subName) {
      const e2 = S.bg.get(bgFile());
      const j = bgJobs(e2?.data).find(x => x.id === subName.dataset.subname && x.transcript);
      if (j) openSub(j.transcript); else { toast('That subagent transcript is not available yet.'); loadBg(bgFile(), true); }
      return;
    }
    if (!t.closest('.menu')) document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
    const copyBtn = t.closest('[data-copy]');
    if (copyBtn) { copy(copyBtn.closest('.codeblock').querySelector('code').textContent, 'Code copied'); return; }
    const ct = t.closest('[data-copy-text]');
    if (ct) { copy(ct.dataset.copyText); ct.closest('.menu')?.classList.remove('open'); return; }
    const ar = t.closest('[data-archive]');
    if (ar) { e.preventDefault(); setArchived(ar.dataset.archive, !ar.dataset.restore); return; }
    const nt = t.closest('[data-newtab]');
    if (nt) { closeCtx(); openItemTab(nt.dataset.newtab); return; }
    closeCtx();
    // Messages and jobs also carry data-key (render keying); only session rows navigate.
    const item = t.closest('.item[data-key]');
    if (item) { openItem(item.dataset.key); return; }
    const go = t.closest('[data-go]');
    if (go) { goFolder(go.dataset.go); return; }
    const f = t.closest('[data-filter]');
    if (f) { S.filter = f.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('on', b === f)); renderList(); return; }
    const a = t.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act, c = current();
    if (act === 'nav') document.getElementById('app').classList.toggle('nav-open');
    else if (act === 'menu') a.closest('.menu').classList.toggle('open');
    else if (act === 'advisor') { a.closest('.menu')?.classList.remove('open'); advisorCommand(a.dataset.advisor); }
    else if (act === 'attach') $('#imageInput')?.click();
    else if (act === 'removeImage') { S.attachments = S.attachments.filter(x => x.name !== a.dataset.name); update(); renderAttachments(); $('#input')?.focus(); $('#homePrompt')?.focus(); }
    else if (act === 'send') send();
    else if (act === 'steer' || act === 'follow_up') send(act);
    else if (act === 'abort' || act === 'complete' || act === 'compact') sessionCommand(act);
    else if (act === 'abortRetry') sessionAction({ type: 'abort_retry' });
    else if (act === 'abortBash') sessionAction({ type: 'abort_bash' });
    else if (act === 'dismissUrl') { S.urlDismissed = a.dataset.id; update(); }
    else if (['rename', 'branch', 'handoff', 'export', 'stats', 'login'].includes(act)) {
      a.closest('.menu')?.classList.remove('open');
      if (act === 'rename') { const s = S.store.sessions.find(x => x.id === c.id); const name = prompt('Session name', s?.title || ''); if (name?.trim() && name.trim() !== s?.title) sessionAction({ type: 'rename', name: name.trim() }); }
      else ({ branch: openBranch, handoff: openHandoff, export: exportHtml, stats: showStats, login: openLogin })[act]();
    }
    else if (act === 'hide') { if (confirm('Remove this session from the panel? The OMP session file is kept, so you can continue it later from history.')) sessionCommand('hide').then(ok => { if (ok) { refreshNative(); location.hash = '#/new'; } }); }
    else if (['side', 'openPlan', 'sideTab', 'closeSide'].includes(act)) {
      const shown = S.sideCounts?.total && S.sideTab === 'plan' ? 'plan' : 'activity';
      S.sideOpen = act === 'closeSide' ? false : act === 'side' && S.sideOpen && shown === 'activity' ? false : true;
      if (act !== 'closeSide') S.sideTab = act === 'openPlan' ? 'plan' : act === 'sideTab' ? a.dataset.tab : 'activity';
      try { localStorage.setItem('omp-side', S.sideOpen ? '1' : '0'); } catch {}
      $('#topbar')._html = ''; update();
    }
    else if (act === 'expandAll') { S.expandAll = !S.expandAll; groupOpen.clear(); try { localStorage.setItem('omp-expand-activity', S.expandAll ? '1' : '0'); } catch {} a.closest('.menu')?.classList.remove('open'); S.lastSig = ''; $('#topbar')._html = ''; update(); }
    else if (act === 'ompUpdate') updateOmp();
    else if (act === 'setReload') { S.set.data = null; S.set.plugins = null; loadSettings(); }
    else if (act === 'advMenu') { $('#thinkMenu') ? closeThinkMenu() : openAdvMenu(t.closest('[data-act]')); }
    else if (act === 'thinkMenu') { $('#thinkMenu') ? closeThinkMenu() : openThinkMenu(t.closest('[data-act]')); }
    else if (act === 'model') { const ctx = pickerCtx(); if (ctx) openPicker(ctx); }
    else if (act === 'retry') {
      const s = S.store.sessions.find(x => x.id === c.id);
      const lastUser = [...s.messages].reverse().find(m => m.role === 'user');
      if (lastUser?.hasImage) { if (lastUser.text !== 'Image attached') $('#input').value = lastUser.text; update(); toast(attached().length ? 'Image is still attached; press Send to retry.' : 'Reattach the image before retrying.', 'err'); }
      else if (lastUser) { $('#input').value = lastUser.text; send('prompt'); }
    }
    else if (act === 'newHere') {
      const s = c.kind === 'session' ? S.store.sessions.find(x => x.id === c.id) : null;
      newSession(s ? projectOf(s)?.path || s.cwd : (S.native.find(n => n.file === c.file)?.cwd || S.previews.get(c.file)?.cwd));
    }
    else if (act === 'resumeOnly') api('/omp-sessions/resume', { file: c.file }).then(async s => { await refreshNative(); location.hash = '#/s/' + s.id; }).catch(err => toast(err.message, 'err'));
    else if (act === 'start') startSession();
  });
  document.addEventListener('auxclick', e => {
    const item = e.button === 1 && e.target.closest('.item[data-key]');
    if (item && !e.target.closest('[data-archive]')) { e.preventDefault(); openItemTab(item.dataset.key); }
  });
  document.addEventListener('contextmenu', e => {
    closeCtx();
    const item = e.target.closest('.item[data-key]');
    if (!item) return;
    e.preventDefault();
    const m = document.createElement('div');
    m.id = 'ctxMenu'; m.className = 'menu-pop ctx-menu';
    m.innerHTML = `<button data-newtab="${esc(item.dataset.key)}">Open in new tab</button>`;
    document.body.appendChild(m);
    m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 4) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 4) + 'px';
  });
  addEventListener('blur', closeCtx);
  addEventListener('resize', closeCtx);
  document.addEventListener('scroll', closeCtx, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtx(); });
  // Click any chat, queued or not-yet-sent image to see it full size.
  function openLightbox(src, alt) {
    if (!safeImg(src)) return;
    const returnFocus = document.activeElement;
    closeLightbox();
    const el = document.createElement('div');
    el.id = 'lightbox'; el.className = 'lightbox'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Image preview');
    el._returnFocus = returnFocus;
    el.innerHTML = `<img src="${esc(src)}" alt="${esc(alt || 'Image')}"><div class="lb-bar"><a class="btn sm" href="${esc(src)}" download="image">Download</a><button class="btn sm" data-lb-close>Close <kbd>Esc</kbd></button></div>`;
    document.body.appendChild(el);
    el.querySelector('[data-lb-close]').focus();
  }
  const closeLightbox = () => { const el = $('#lightbox'); if (!el) return; el.remove(); if (el._returnFocus?.isConnected) el._returnFocus.focus(); };
  document.addEventListener('click', e => {
    const lb = e.target.closest?.('#lightbox');
    if (lb) { if (e.target.tagName !== 'IMG' && !e.target.closest('a')) closeLightbox(); return; }
    const img = e.target.closest?.('.msg-image-btn')?.querySelector('img') || e.target.closest?.('img.msg-image, .attach-preview img, .queued-image img');
    if (img) { e.preventDefault(); e.stopPropagation(); openLightbox(img.src, img.alt); }
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#lightbox')) { e.stopPropagation(); closeLightbox(); } }, true);
  document.addEventListener('toggle', e => {
    const d = e.target;
    const remember = (map, key) => { if (!key) return; if (d.open === (d.dataset.def === '1')) map.delete(key); else map.set(key, d.open); };
    if (d.classList?.contains('activity')) remember(groupOpen, d.dataset.gid);
    else if (d.classList?.contains('row')) remember(rowOpen, d.dataset.rid);
    else if (d.hasAttribute?.('data-finished')) S.finishedOpen = d.open;
    else if (d.dataset?.remember) remember(rowOpen, d.dataset.remember);
    else if (d.tagName === 'DETAILS') touched.add(d);
  }, true);
  document.addEventListener('scroll', e => { if (e.target instanceof Element) touched.add(e.target); }, true);
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'input') { drafts.set(S.view, t.value); autosize(t); S.slash = null; renderSlash(); updateComposer(); }
    else if (t.id === 'search') { S.search = t.value; renderList(); }
    else if (t.id === 'setSearch') { S.set.q = t.value; renderSettings(); }
    else if (t.id === 'setChanged') { S.set.changed = t.checked; renderSettings(); }
    else if (t.id === 'pickerQ') { S.picker.q = t.value; S.picker.hi = 0; renderPicker(); }
    else if (t.id === 'homePrompt') { S.home.prompt = t.value; S.slash = null; renderSlash(); }
    else if (t.id === 'isolate') S.home.isolate = t.checked;
    else if (t.id === 'homeAdvisor') S.home.advisor = t.checked;
    else if (t.id === 'folderFilter') {
      S.home.filter = t.value;
      const pos = t.selectionStart;
      renderHome();
      const nf = $('#folderFilter'); nf.focus(); nf.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener('change', e => {
    if (e.target.matches?.('[data-advset]')) { advisorAction(e.target.checked ? 'on' : 'off'); return; }
    if (e.target.matches?.('[data-advreviews]')) { S.advReviews = e.target.checked; try { localStorage.setItem('omp-adv-reviews', S.advReviews ? '1' : '0'); } catch {} S.lastSig = ''; update(); return; }
    if (e.target.matches?.('[data-advimportant]')) { S.advImportant = e.target.checked; try { localStorage.setItem('omp-adv-important', S.advImportant ? '1' : '0'); } catch {} S.lastSig = ''; update(); return; }
    if (e.target.id === 'imageInput') { const files = [...(e.target.files || [])]; e.target.value = ''; files.forEach(attachImage); }
    else if (e.target.dataset?.pluginToggle) savePlugin(e.target.checked ? 'enable' : 'disable', e.target.dataset.pluginToggle);
    else if (e.target.dataset?.set) settingInput(e.target);
  });
  document.addEventListener('paste', e => {
    if (e.target.id !== 'input' && e.target.id !== 'homePrompt') return;
    const files = [...(e.clipboardData?.items || [])].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); files.forEach(attachImage); }
  });
  document.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.hasAttribute('data-handoff')) { const instructions = e.target.elements.instructions.value.trim(); closeModal(); sessionAction({ type: 'handoff', instructions }); return; }
    if (e.target.hasAttribute('data-uiform')) { answerQuestion(e.target.dataset.uiform, { value: e.target.elements.answer.value }, e.target); return; }
    if (e.target.dataset.mmadd) { const name = e.target.querySelector('input').value.trim(); if (!/^[\w.-]{1,60}$/.test(name)) return toast('Use letters, numbers, dots, dashes or underscores', 'err'); pickMapModel(e.target.dataset.mmadd, name); return; }
    if (e.target.hasAttribute('data-plugininstall')) { const v = e.target.querySelector('input').value.trim(); if (v) savePlugin('install', v); return; }
    if (e.target.id === 'pathForm') goFolder($('#pathInput').value.trim().replace(/^"|"$/g, ''));
    if (e.target.id === 'connectForm') {
      const t = $('#tokenInput').value.trim();
      if (!t) return;
      S.token = t;
      api('/state').then(() => { setToken(t); refreshNative(); toast('Connected'); }).catch(err => { S.token = ''; toast(err.message, 'err'); });
    }
  });
  document.addEventListener('mouseover', e => {
    const row = e.target.closest?.('#picker [data-pi]');
    if (!row || !S.picker || +row.dataset.pi === S.picker.hi) return;
    $('#pickerList .hi')?.classList.remove('hi');
    row.classList.add('hi'); S.picker.hi = +row.dataset.pi; renderThink();
  });
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition: Enter confirms a character, not the message
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'p') { e.preventDefault(); if (!S.picker && !$('#modal') && current().kind === 'session') togglePlan(current().id); return; }
    // Keep keyboard focus inside whichever dialog is on top.
    const dialog = $('#lightbox') || (S.picker ? $('#picker .picker') : $('#modal'));
    if (dialog && e.key === 'Tab') {
      const nodes = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')].filter(n => n.offsetParent !== null);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!dialog.contains(document.activeElement)) { e.preventDefault(); first?.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    // Ctrl+P cycles model roles from the composer (and closes the picker); elsewhere it stays the browser's Print.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && (S.picker || e.target.id === 'input' || e.target.id === 'homePrompt')) { e.preventDefault(); if (S.picker) { closePicker(); return; } cycleRole(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape' && $('#modal') && !S.picker) { e.stopPropagation(); closeModal(); return; }
    if (e.key === 'Escape' && $('#thinkMenu')) { closeThinkMenu(); return; }
    const t = e.target;
    if (S.picker) {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.picker.hi = Math.max(0, Math.min(S.picker.flat.length - 1, S.picker.hi + (e.key === 'ArrowDown' ? 1 : -1))); $('#pickerList .hi')?.classList.remove('hi'); const r = $(`#pickerList [data-pi="${S.picker.hi}"]`); r?.classList.add('hi'); r?.scrollIntoView({ block: 'nearest' }); renderThink(); return; }
      if (e.key === 'Enter' && !t.closest('[data-fav]')) { e.preventDefault(); pickModel(S.picker.hi); return; }
      return;
    }
    if ((t.id === 'input' || t.id === 'homePrompt') && S.slash) {
      const n = S.slash.items.length, hi = S.slash.items[S.slash.hi];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.slash.hi = (S.slash.hi + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderSlash(); $('#slash .hi')?.scrollIntoView({ block: 'nearest' }); return; }
      // Enter completes a partial name; on a full name it falls through and sends.
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && t.value !== '/' + hi.name)) { e.preventDefault(); pickSlash(hi.name); return; }
      if (e.key === 'Escape') { e.preventDefault(); S.slash = null; $('#slash').hidden = true; t.removeAttribute('aria-activedescendant'); return; }
    }
    if (t.id === 'input' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const s = current().kind === 'session' && S.store?.sessions.find(x => x.id === current().id);
      send(s && (s.status === 'running' || s.status === 'queued') ? (e.altKey ? 'follow_up' : 'steer') : undefined);
      return;
    }
    if (t.id === 'homePrompt' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startSession(); return; }
    if (t.id === 'folderFilter' && e.key === 'Enter') { e.preventDefault(); const first = $('.folder-list [data-go]'); if (first) goFolder(first.dataset.go); return; }
    if (t.id === 'search' && e.key === 'Enter') { const first = $('#list [data-key]'); if (first) openItem(first.dataset.key); return; }
    if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); return; }
    if (e.key === 'Escape') {
      document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); document.getElementById('app').classList.remove('nav-open');
      if (t.id === 'search') { t.value = ''; S.search = ''; renderList(); t.blur(); }
      else if (innerWidth <= 1100 && S.sideOpen && $('#tasks') && !$('#tasks').hidden) { S.sideOpen = false; $('#topbar')._html = ''; update(); }
      return;
    }
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(t.tagName)) { e.preventDefault(); $('#search').focus(); }
  });
  $('#newBtn').addEventListener('click', () => newSession());
  $('#groupBy').addEventListener('click', e => {
    S.groupBy = S.groupBy === 'project' ? 'time' : 'project';
    localStorage.setItem('omp-group-by', S.groupBy);
    e.currentTarget.classList.toggle('on', S.groupBy === 'project');
    renderList();
  });
  $('#groupBy').classList.toggle('on', S.groupBy === 'project');
  $('#scrim').addEventListener('click', () => document.getElementById('app').classList.remove('nav-open'));
  $('#disconnect').addEventListener('click', () => setToken(''));
  window.addEventListener('hashchange', () => {
    const planDialog = $('#modal.plan-review-modal');
    if (planDialog && (current().kind !== 'session' || current().id !== planDialog._planOwner)) { closePicker(); planDialog.remove(); }
    const t = new URLSearchParams(location.hash.slice(1)).get('token');
    if (t) { history.replaceState(null, '', location.pathname); setToken(t); refreshNative(); return; }
    route();
  });

  route();
  loop();
})();
