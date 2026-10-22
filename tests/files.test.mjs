// Checks the hosting rules: every file under GitHub's 100 MB limit, nothing
// loaded from other servers, and the offline list matches real files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('every file is under 100 MB (GitHub limit)', () => {
  for (const f of walk(root)) assert.ok(statSync(f).size < 100 * 1024 * 1024, f);
});

test('progress-bar byte sizes match the real files', () => {
  const src = read('engine/worker.js');
  const modnet = Number(src.match(/modnet\.onnx'[^}]*bytes: (\d+)/)[1]);
  assert.equal(modnet, statSync(join(root, 'models/modnet.onnx')).size);
  const model = Number(src.match(/u2netp\.onnx'[^}]*bytes: (\d+)/)[1]);
  const wasm = Number(src.match(/simd-threaded\.wasm'[^}]*bytes: (\d+)/)[1]);
  assert.equal(model, statSync(join(root, 'models/u2netp.onnx')).size);
  assert.equal(wasm, statSync(join(root, 'vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm')).size);
});

test('CSP blocks other servers', () => {
  const html = read('index.html');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /https?:/);
  assert.doesNotMatch(html, /style="/, 'inline styles would be blocked by the CSP');
});

test('our code never mentions other servers', () => {
  for (const p of ['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.webmanifest', 'engine/engine.js', 'engine/worker.js', 'engine/ops.js']) {
    assert.doesNotMatch(read(p), /https?:\/\//, p);
  }
});

test('offline list only names files that exist', () => {
  const sw = read('sw.js');
  const list = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const p of list) if (p !== './') assert.ok(statSync(join(root, p)).isFile(), p);
  for (const p of ['app.js', 'style.css', 'engine/ops.js', 'engine/worker.js', 'engine/engine.js']) assert.ok(list.includes(p), `${p} cached for offline`);
});
