// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../engine/ops.js';

function solid(w, h, rgba) {
  const img = ops.makeImage(w, h);
  for (let i = 0; i < w * h; i++) img.data.set(rgba, i * 4);
  return img;
}

// Left half dark, right half light: a hard vertical edge.
function edge(w, h, a = 60, b = 190) {
  const img = ops.makeImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(x < w / 2 ? [a, a, a, 255] : [b, b, b, 255], (y * w + x) * 4);
  return img;
}

test('gaussian blur keeps the average and flat areas', () => {
  const p = new Float32Array(100 * 80).fill(42);
  const out = ops.gaussianBlur(p, 100, 80, 3);
  for (const v of out) assert.ok(Math.abs(v - 42) < 1e-3);
});

test('sharpen leaves flat areas alone and boosts edges', () => {
  const flat = solid(40, 30, [120, 130, 140, 255]);
  assert.deepEqual(ops.sharpen(flat, { amount: 2 }).data, flat.data);

  const img = edge(40, 30);
  const out = ops.sharpen(img, { amount: 1.5 });
  const px = (im, x) => im.data[(15 * 40 + x) * 4];
  assert.ok(px(out, 19) < px(img, 19), 'dark side of the edge gets darker');
  assert.ok(px(out, 20) > px(img, 20), 'light side of the edge gets lighter');
  assert.equal(px(out, 2), px(img, 2), 'far from the edge nothing changes');
  assert.equal(out.data[3], 255, 'alpha kept');
});

test('sharpen amount 0 changes nothing', () => {
  const img = edge(40, 30);
  assert.deepEqual(ops.sharpen(img, { amount: 0 }).data, img.data);
});

test('auto-enhance stretches a dull, dark photo', () => {
  const w = 64;
  const h = 64;
  const img = ops.makeImage(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = 40 + (i % 60); // only uses 40..99
    img.data.set([v + 10, v, v - 10, 255], i * 4);
  }
  const out = ops.autoEnhance(img);
  let min = 255;
  let max = 0;
  let sumIn = 0;
  let sumOut = 0;
  for (let j = 0; j < out.data.length; j += 4) {
    min = Math.min(min, out.data[j + 1]);
    max = Math.max(max, out.data[j + 1]);
    sumIn += img.data[j + 1];
    sumOut += out.data[j + 1];
  }
  assert.ok(max - min >= 140, `contrast widened (${min}..${max})`);
  assert.ok(sumOut > sumIn, 'brighter overall');
});

test('auto-enhance does not blow up a flat grey photo', () => {
  const img = solid(20, 20, [128, 128, 128, 255]);
  const out = ops.autoEnhance(img);
  for (let j = 0; j < out.data.length; j += 4) {
    assert.ok(Math.abs(out.data[j] - 128) < 40);
  }
});

test('auto-enhance ignores transparent pixels and keeps alpha', () => {
  const img = solid(10, 10, [0, 0, 0, 0]);
  img.data.set([100, 120, 140, 255], 0);
  const out = ops.autoEnhance(img);
  assert.equal(out.data[3], 255);
  assert.equal(out.data[7], 0);
});

test('resizePlane down and up keeps a constant plane', () => {
  const p = new Float32Array(200 * 100).fill(7);
  const small = ops.resizePlane(p, 200, 100, 32, 32);
  assert.equal(small.length, 32 * 32);
  for (const v of small) assert.ok(Math.abs(v - 7) < 1e-4);
  const big = ops.resizePlane(small, 32, 32, 300, 120);
  for (const v of big) assert.ok(Math.abs(v - 7) < 1e-4);
});

test('modelInput has the right shape and normalisation', () => {
  const img = solid(50, 40, [255, 255, 255, 255]);
  const x = ops.modelInput(img, 32);
  assert.equal(x.length, 3 * 32 * 32);
  assert.ok(Math.abs(x[0] - (1 - 0.485) / 0.229) < 1e-4);
});

test('refineMask follows the photo edge', () => {
  const w = 120;
  const h = 80;
  const img = edge(w, h, 20, 230);
  // A blurry, low-res guess that the right half is the subject.
  const size = 16;
  const pred = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pred[y * size + x] = 1 / (1 + Math.exp(-(x - 7.5) * 1.2));
  const mask = ops.refineMask(pred, size, img);
  assert.equal(mask.length, w * h);
  const row = 40 * w;
  assert.ok(mask[row + 10] < 20, 'background clear');
  assert.ok(mask[row + 110] > 235, 'subject solid');
  assert.ok(mask[row + 57] < 80 && mask[row + 62] > 175, `edge is sharp (${mask[row + 57]}, ${mask[row + 62]})`);
});

test('composite: transparent, colour and blur', () => {
  const w = 30;
  const h = 20;
  const img = edge(w, h, 50, 200);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 15; x < w; x++) mask[y * w + x] = 255;

  const t = ops.composite(img, mask, { type: 'transparent' });
  assert.equal(t.data[3], 0);
  assert.equal(t.data[(10 * w + 20) * 4 + 3], 255);

  const c = ops.composite(img, mask, { type: 'color', color: '#ff8000' });
  assert.deepEqual([...c.data.slice(0, 4)], [255, 128, 0, 255]);
  assert.deepEqual([...c.data.slice((10 * w + 20) * 4, (10 * w + 20) * 4 + 4)], [200, 200, 200, 255]);

  const b = ops.composite(img, mask, { type: 'blur' });
  // Background is uniform dark here; the bright subject must not bleed into it.
  assert.ok(b.data[(10 * w + 13) * 4] < 60, 'no halo from the subject');
  assert.equal(b.data[3], 255);
});

// Dark "text" bars on light, uneven paper, blurred like a zoomed photo.
function blurryText(w, h, { light = false } = {}) {
  const ink = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bar = y > h * 0.3 && y < h * 0.7 && x % 40 < 12 && x > 20 && x < w - 20;
    ink[y * w + x] = bar ? 1 : 0;
  }
  const blurred = ops.gaussianBlur(ink, w, h, 4);
  const img = ops.makeImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const paper = 200 * (0.6 + 0.4 * (x / w)); // light falls off to the left
    const v = light ? 30 + 200 * blurred[i] : paper * (1 - 0.6 * blurred[i]);
    img.data.set([v, v * 0.97, v * 0.9, 255], i * 4);
  }
  return img;
}

function contrastAcross(img, row) {
  // Gap brightness minus bar brightness (bars span x % 40 < 12).
  const w = img.width;
  const at = (x) => img.data[(row * w + x) * 4];
  const bars = [];
  const gaps = [];
  for (let x = 60; x < w - 60; x += 40) {
    gaps.push(at(x + 6));
    bars.push(at(x + 26));
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return mean(gaps) - mean(bars);
}

test('enhanceText: whiter paper, darker ink, more contrast', () => {
  const img = blurryText(1200, 200);
  const before = contrastAcross(img, 100);
  for (const mode of ['color', 'bw']) {
    const out = ops.enhanceText(img, { mode, strength: 0.5 });
    assert.equal(out.width, 1200, 'big photos keep their size');
    const after = contrastAcross(out, 100);
    assert.ok(after > before * 1.5, `${mode}: contrast ${before.toFixed(0)} -> ${after.toFixed(0)}`);
    // Paper far from text is white on both the dark and light side.
    assert.ok(out.data[(10 * 1200 + 5) * 4] > 235, `${mode}: dark-side paper turns white`);
    assert.ok(out.data[(10 * 1200 + 1190) * 4] > 235, `${mode}: light-side paper white`);
  }
});

test('enhanceText: light text on dark stays light on dark', () => {
  const img = blurryText(1200, 200, { light: true });
  const out = ops.enhanceText(img, { mode: 'bw', strength: 0.5 });
  assert.ok(out.data[(10 * 1200 + 600) * 4] < 30, 'background dark');
  assert.ok(contrastAcross(out, 100) < -150, 'bars bright');
});

test('enhanceText: small photos are enlarged 2x', () => {
  const img = blurryText(300, 80);
  const out = ops.enhanceText(img, { mode: 'bw', strength: 0.5 });
  assert.equal(out.width, 600);
  assert.equal(out.height, 160);
});

test('upscale2x keeps flat areas and doubles size', () => {
  const p = new Float32Array(10 * 6).fill(0.3);
  const out = ops.upscale2x(p, 10, 6);
  assert.equal(out.length, 20 * 12);
  for (const v of out) assert.ok(Math.abs(v - 0.3) < 1e-5);
});

test('placeOnScene: no halo from the old background, scene fills the rest', () => {
  // Dark subject (square) shot against a white wall; the mask has soft,
  // slightly too wide edges like a real AI mask.
  const w = 200;
  const h = 160;
  const img = ops.makeImage(w, h);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= 60 && x < 140 && y >= 40;
      img.data.set(inside ? [60, 40, 30, 255] : [245, 245, 245, 255], (y * w + x) * 4);
      const dist = Math.max(60 - x, x - 139, 40 - y, 0);
      mask[y * w + x] = Math.max(0, 255 - dist * 40); // ~6 px soft tail outside
    }
  }
  // A dark green scene of a different size and shape.
  const scene = ops.makeImage(300, 300);
  for (let i = 0; i < 300 * 300; i++) scene.data.set([20, 70, 30, 255], i * 4);

  const out = ops.placeOnScene(img, mask, scene);
  assert.equal(out.width, w);
  assert.equal(out.height, h);
  const px = (x, y) => [...out.data.slice((y * w + x) * 4, (y * w + x) * 4 + 3)];
  // Just outside the subject, where the mask is faint: no white glow.
  for (const x of [56, 57, 58]) {
    const [r, g, b] = px(x, 100);
    assert.ok(r < 90 && g < 110 && b < 80, `no halo at x=${x}: ${[r, g, b]}`);
  }
  // Far away: the scene (slightly darkened near the subject is fine).
  const [r, g, b] = px(5, 5);
  assert.ok(Math.abs(r - 20) < 12 && Math.abs(g - 70) < 12 && Math.abs(b - 30) < 12, `scene shows: ${[r, g, b]}`);
  // Middle of the subject: still the subject, only gently colour matched.
  const [sr, sg] = px(100, 120);
  assert.ok(Math.abs(sr - 60) < 25 && Math.abs(sg - 40) < 25, `subject kept: ${[sr, sg]}`);
});

test('coverScene fills the frame without stretching', () => {
  const scene = ops.makeImage(100, 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) scene.data.set([x * 2, y * 2, 0, 255], (y * 100 + x) * 4);
  const [r, g] = ops.coverScene(scene, 50, 100); // tall frame: crops the sides
  assert.equal(r.length, 50 * 100);
  assert.ok(r[0] > 40 && r[49] < 160, 'only the middle columns are used');
  assert.ok(g[0] < 5 && g[99 * 50] > 190, 'full height kept');
});
