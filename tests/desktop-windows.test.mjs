import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
const app = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');

// Tauri's native drag-drop handler takes WebView2's drop target on Windows, and the page then never gets dragover or
// drop: project headings can't be reordered and images dropped on the composer don't attach. Every window the shell
// builds (the main window, same-origin popups and in-app browser windows) must turn it off.
test('every desktop window turns off the native drag-drop handler so HTML5 drag and drop reaches the dashboard', () => {
  const builders = [...main.matchAll(/WebviewWindowBuilder::new\(/g)].map(m => {
    const end = main.indexOf('.build()', m.index);
    assert.ok(end > m.index, 'a window builder chain ends in .build()');
    return main.slice(m.index, end);
  });
  assert.ok(builders.length >= 2, 'the main window and popups are built with WebviewWindowBuilder');
  for (const chain of builders) assert.match(chain, /\.disable_drag_drop_handler\(\)/, `window built without .disable_drag_drop_handler():\n${chain}`);
  // The dashboard side this unblocks: project headings are HTML5-draggable and the document handles the drop.
  assert.match(app, /proj \? ` draggable="true"/);
  for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) assert.match(app, new RegExp(`document\\.addEventListener\\('${type}'`));
});

// The body of `fn name(` up to its closing brace at column 0 (main.rs may be checked out with CRLF line endings).
function fnBody(name) {
  const start = main.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `main.rs defines fn ${name}`);
  const end = main.slice(start).search(/\r?\n\}\r?\n/);
  assert.ok(end > 0, `fn ${name} ends with a closing brace at column 0`);
  return main.slice(start, start + end);
}

// Chat links are <a target="_blank"> (new_window_handler); plain links navigate (nav_guard). Both must land in the same
// in-app browser, or a link would open in the app or in the default browser depending on its target.
test('web links leaving the dashboard open in the in-app browser from both the navigation and new-window paths', () => {
  const nav = fnBody('nav_guard');
  assert.match(nav, /if url\.as_str\(\) == "about:blank" \{\s*return true;\s*\}\s*open_in_app_browser\(&app, url\);\s*false/);
  assert.doesNotMatch(nav, /open_external/);
  const popup = fnBody('new_window_handler');
  assert.match(popup, /if !same_origin\(&url, port\) \{\s*open_in_app_browser\(&app, &url\);\s*return NewWindowResponse::Deny;/);
  assert.doesNotMatch(popup, /open_external/);
  // Only web links: other schemes stay refused, as open_external did.
  assert.match(fnBody('open_in_app_browser'), /if !matches!\(url\.scheme\(\), "http" \| "https"\) \{\s*return;/);
});

// Untrusted pages must never get the dashboard's guards: nav_guard would push every link out of the browser, and
// new_window_handler would give the page a popup-N window with an opener relationship. The browser sits inside the main
// window (a child webview), not in a window of its own.
test('the in-app browser is a child webview of the main window with its own guards and drag-drop setting', () => {
  const add = fnBody('add_browser');
  assert.match(add, /app\.get_window\("main"\)/);
  const start = add.indexOf('WebviewBuilder::new(BROWSER');
  assert.ok(start >= 0, 'the browser is built with WebviewBuilder under the BROWSER label');
  const chain = add.slice(start, add.indexOf('window.add_child(builder', start));
  assert.match(chain, /\.on_navigation\(browser_nav_guard\(\)\)/);
  assert.match(chain, /\.on_new_window\(browser_new_window_handler\(/);
  assert.doesNotMatch(chain, /nav_guard\(app|new_window_handler\(app\.clone\(\), port/);
  assert.match(chain, /\.disable_drag_drop_handler\(\)/);
  assert.match(chain, /\.on_document_title_changed\(/);
  // A second link reuses the open browser; a failure still opens the link somewhere, without a modal.
  const open = fnBody('open_in_app_browser');
  assert.match(open, /Some\(browser\) => browser\.navigate\(url\.clone\(\)\)/);
  assert.match(open, /Err\(_\) => open_external\(&app, &url\)/);
  assert.doesNotMatch(open, /WebviewWindowBuilder/);
  // Browsing stays in the browser for web schemes only; new windows load there too, never in popups.
  assert.match(fnBody('browser_nav_guard'), /matches!\(url\.scheme\(\), "http" \| "https"\) \|\| url\.as_str\(\) == "about:blank"/);
  assert.match(fnBody('browser_new_window_handler'), /open_in_app_browser\(&app, &url\);\s*NewWindowResponse::Deny/);
});

// The dashboard draws the browser's bar and the shell lays the browser right below it: the heights must agree, and every
// button must name an action the shell handles (it cancels the /__desktop/browser/<action> navigation and acts on it).
test('the dashboard browser bar matches the shell: same height, only actions the shell handles', async () => {
  const css = await readFile(new URL('../local-dist/app.css', import.meta.url), 'utf8');
  const bar = Number(main.match(/const BROWSER_BAR: f64 = ([\d.]+);/)?.[1]);
  assert.equal(Number(css.match(/\.browser-bar\{[^}]*height:(\d+)px/)?.[1]), bar);
  assert.match(css, /\.browser-bar\{[^}]*box-sizing:border-box/);
  const handled = new Set([...fnBody('browser_action').matchAll(/"(\w+)" =>/g)].map(m => m[1]));
  const buttons = [...app.matchAll(/btn\('(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(buttons.sort(), [...handled].sort());
  assert.match(fnBody('nav_guard'), /url\.path\(\)\.strip_prefix\("\/__desktop\/browser\/"\)[\s\S]*return false;/);
  assert.match(app, /location\.assign\(`\/__desktop\/browser\/\$\{act\}`\)/);
});

// tauri-plugin-opener's default init script cancels every <a target="_blank"> click and calls its open_url over IPC,
// which no window may use (the app grants no capabilities): chat links did nothing and never reached the new-window path.
test('the opener plugin injects no link-click script, so target="_blank" clicks reach the new-window handler', () => {
  assert.match(main, /\.plugin\(tauri_plugin_opener::Builder::new\(\)\.open_js_links_on_click\(false\)\.build\(\)\)/);
  assert.doesNotMatch(main, /tauri_plugin_opener::init\(\)/);
});
