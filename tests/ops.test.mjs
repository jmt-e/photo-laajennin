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
