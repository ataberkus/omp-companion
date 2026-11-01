import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
const app = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');

// Tauri's native drag-drop handler takes WebView2's drop target on Windows, and the page then never gets dragover or
// drop: project headings can't be reordered and images dropped on the composer don't attach. Every window the shell
// builds (the main window and same-origin popups) must turn it off.
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
