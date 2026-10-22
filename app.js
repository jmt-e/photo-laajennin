import { engine } from './engine/engine.js';

const MAX_SIDE = 2048; // keeps Safari fast and within its memory limits
const MAX_HISTORY = 10; // each step is ~12 MB at full size

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'),
  stage: $('stage'),
  empty: $('empty'),
  frame: $('frame'),
  after: $('after'),
  before: $('before'),
  divider: $('divider'),
  tagBefore: $('tag-before'),
  tagAfter: $('tag-after'),
  busy: $('busy'),
  busyText: $('busy-text'),
  busyProgress: $('busy-progress'),
  file: $('file'),
  undo: $('undo'),
  reset: $('reset'),
  compare: $('compare'),
  save: $('save'),
  auto: $('auto'),
  sharpen: $('sharpen'),
  background: $('background'),
  panelSharpen: $('panel-sharpen'),
  sharpenAmount: $('sharpen-amount'),
  sharpenValue: $('sharpen-value'),
  text: $('text'),
  panelText: $('panel-text'),
  textStrength: $('text-strength'),
  textValue: $('text-value'),
  panelBg: $('panel-bg'),
  bgColors: $('bg-colors'),
  bgScenes: $('bg-scenes'),
  scenePlace: $('scene-place'),
  sceneSize: $('scene-size'),
  sceneReset: $('scene-reset'),
  sunToggle: $('sun-toggle'),
  sunStrength: $('sun-strength'),
  sunNote: $('sun-note'),
  sunHandle: $('sun-handle'),
  sceneHint: $('scene-hint'),
  sceneFile: $('scene-file'),
  bgCustom: $('bg-custom'),
  saveSheet: $('save-sheet'),
  saveImg: $('save-img'),
  saveClose: $('save-close'),
};

const state = {
  original: null, // the photo as loaded (after shrinking)
  history: [], // edits; the last one is what you see
  preview: null, // shown while a tool panel is open, not yet applied
  panel: null, // 'sharpen' | 'text' | 'bg' | null
  busy: false,
  comparing: false,
  split: 0.5, // compare divider position, 0..1
  fileName: 'photo',
  exportFile: null, // ready-made file so Save can open the share sheet at once
};

const masks = new WeakMap(); // image -> subject mask, so we only run the AI once

const current = () => state.history[state.history.length - 1] || null;
const shown = () => state.preview || current();

// ---------- status & busy ----------

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

function setBusy(text, progress) {
  state.busy = Boolean(text);
  el.busy.hidden = !text;
  if (text) el.busyText.textContent = text;
  el.busyProgress.hidden = progress === undefined;
  if (progress !== undefined) el.busyProgress.value = progress;
  updateButtons();
}

function updateButtons() {
  const has = Boolean(current());
  const idle = !state.busy;
  const free = idle && !state.panel;
  el.undo.disabled = !(free && state.history.length > 1);
  el.reset.disabled = !(free && has && current() !== state.original);
  el.compare.disabled = !(idle && has);
  el.save.disabled = !(free && has);
  el.auto.disabled = !(free && has);
  el.sharpen.disabled = !(free && has);
  el.text.disabled = !(free && has);
  el.background.disabled = !(free && has);
  el.file.disabled = !free;
  $('open').setAttribute('aria-disabled', String(!free));
  for (const b of document.querySelectorAll('.panel button, .panel input')) b.disabled = !idle;
}

// ---------- drawing ----------

function paint(canvas, img) {
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
}

function layout() {
  const img = shown();
  if (!img) return;
  const box = el.stage.getBoundingClientRect();
  const maxW = box.width - 32;
  const maxH = box.height - 16;
  const scale = Math.min(maxW / img.width, maxH / img.height);
  el.frame.style.width = `${Math.floor(img.width * scale)}px`;
  el.frame.style.height = `${Math.floor(img.height * scale)}px`;
}

function render() {
  const img = shown();
  el.empty.hidden = Boolean(img);
  el.frame.hidden = !img;
  if (!img) return;
  if (placing() && !state.preview) drawPlacement();
  else paint(el.after, img);
  layout();
  renderCompare();
  updateButtons();
}

function renderCompare() {
  const on = state.comparing && Boolean(state.original);
  el.compare.setAttribute('aria-pressed', String(on));
  el.frame.classList.toggle('comparing', on);
  el.before.hidden = !on;
  el.divider.hidden = !on;
  el.tagBefore.hidden = !on;
  el.tagAfter.hidden = !on;
  if (!on) return;
  if (el.before.width !== state.original.width || el.before.dataset.for !== String(state.loadId)) {
    paint(el.before, state.original);
    el.before.dataset.for = String(state.loadId);
  }
  const pct = state.split * 100;
  // "Before" is the left part, "After" shows on the right.
  el.before.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  el.divider.style.left = `${pct}%`;
}

new ResizeObserver(layout).observe(el.stage);

// ---------- history ----------

function commit(img) {
  state.history.push(img);
  // Keep the original reachable through Reset even when old steps drop off.
  while (state.history.length > MAX_HISTORY) state.history.splice(0, 1);
  state.preview = null;
  render();
  prepareExport();
}

el.undo.addEventListener('click', () => {
  if (state.history.length < 2) return;
  state.history.pop();
  render();
  prepareExport();
  setStatus('Undone');
});

el.reset.addEventListener('click', () => {
  // Reset is itself a step, so Undo can bring your edits back.
  commit(state.original);
  setStatus('Back to the original');
});

// ---------- loading a photo ----------

async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    // Halve in steps first: one big jump looks jagged.
    let src = img;
    const temps = [];
    while (w / 2 >= tw * 1.2) {
      w = Math.round(w / 2);
      h = Math.round(h / 2);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      temps.push(c);
      src = c;
    }
    const out = document.createElement('canvas');
    out.width = tw;
    out.height = th;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    const data = ctx.getImageData(0, 0, tw, th);
    // Free canvas memory right away (Safari is strict about it).
    for (const c of [...temps, out]) c.width = c.height = 0;
    return {
      image: { width: tw, height: th, data: data.data },
      shrunk: scale < 1,
      originalSize: `${img.naturalWidth}×${img.naturalHeight}`,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

el.file.addEventListener('change', async () => {
  const file = el.file.files[0];
  el.file.value = '';
  if (!file) return;
  closePanel();
  setBusy('Opening photo…');
  try {
    const { image, shrunk, originalSize } = await loadPhoto(file);
    state.original = image;
    state.history = [image];
    state.preview = null;
    state.loadId = (state.loadId || 0) + 1;
    state.fileName = (file.name || 'photo').replace(/\.[^.]+$/, '');
    setBusy(null);
    render();
    prepareExport();
    setStatus(shrunk ? `${image.width}×${image.height} (from ${originalSize})` : `${image.width}×${image.height}`);
  } catch (err) {
    setBusy(null);
    setStatus('Could not open that photo', true);
    console.error(err);
  }
});

// ---------- tools ----------

async function run(label, job) {
  setBusy(label);
  try {
    return await job();
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong', true);
    return null;
  } finally {
    setBusy(null);
  }
}

el.auto.addEventListener('click', async () => {
  const out = await run('Enhancing…', () => engine.autoEnhance(current()));
  if (out) {
    commit(out);
    setStatus('Auto-enhanced');
  }
});

// Panels: a tool shows a live preview; Apply keeps it, Cancel drops it.
const panels = { sharpen: el.panelSharpen, text: el.panelText, bg: el.panelBg };
const applied = { sharpen: 'Sharpened', text: 'Text made clearer', bg: 'Background changed' };

function openPanel(name) {
  state.panel = name;
  for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
  updateButtons();
}

function closePanel() {
  state.panel = null;
  state.preview = null;
  for (const panel of Object.values(panels)) panel.hidden = true;
  updatePlacing();
  render();
}

// Re-runs a tool as its settings change. Never queues more than one extra
// job; a newer setting simply replaces the waiting one.
function livePreview(name, compute, busyLabel) {
  let loop = null;
  let again = false;
  async function work() {
    do {
      again = false;
      const base = current();
      if (busyLabel) setBusy(busyLabel);
      try {
        const out = await compute(base);
        if (state.panel === name && current() === base) {
          state.preview = out;
          render();
        }
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        if (busyLabel) setBusy(null);
      }
    } while (again && state.panel === name);
  }
  return {
    request() {
      if (loop) {
        again = true;
        return;
      }
      loop = work().finally(() => {
        loop = null;
      });
    },
    settled: () => loop || Promise.resolve(),
  };
}

const previews = {};

for (const [name, panel] of Object.entries(panels)) {
  panel.querySelector('[data-cancel]').addEventListener('click', closePanel);
  panel.querySelector('[data-apply]').addEventListener('click', async () => {
    // Wait for the latest preview, so what you saw is what you get.
    if (previews[name]) await previews[name].settled();
    const img = state.preview;
    closePanel();
    if (img) {
      commit(img);
      setStatus(applied[name]);
    }
  });
}

// Sharpen: fast, so it follows the slider while you drag.
previews.sharpen = livePreview('sharpen', (base) => engine.sharpen(base, Number(el.sharpenAmount.value) / 50));

el.sharpen.addEventListener('click', () => {
  openPanel('sharpen');
  el.sharpenValue.textContent = el.sharpenAmount.value;
  previews.sharpen.request();
});

el.sharpenAmount.addEventListener('input', () => {
  el.sharpenValue.textContent = el.sharpenAmount.value;
  previews.sharpen.request();
});

// Text: slower (it deblurs), so it updates when you let go of the slider.
let textMode = 'color';
previews.text = livePreview(
  'text',
  (base) => engine.enhanceText(base, textMode, Number(el.textStrength.value) / 100),
  'Making text clearer…',
);

function showTextMode() {
  for (const b of el.panelText.querySelectorAll('[data-text-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.textMode === textMode));
  }
}

el.text.addEventListener('click', () => {
  openPanel('text');
  showTextMode();
  el.textValue.textContent = el.textStrength.value;
  previews.text.request();
});

for (const b of el.panelText.querySelectorAll('[data-text-mode]')) {
  b.addEventListener('click', () => {
    textMode = b.dataset.textMode;
    showTextMode();
    previews.text.request();
  });
}

el.textStrength.addEventListener('input', () => {
  el.textValue.textContent = el.textStrength.value;
});
el.textStrength.addEventListener('change', () => previews.text.request());

// Background removal
let bgChoice = { type: 'transparent' };

function showBgChoice() {
  for (const b of el.panelBg.querySelectorAll('[data-bg]')) {
    b.setAttribute('aria-pressed', String(b.dataset.bg === bgChoice.type));
  }
  el.bgColors.hidden = bgChoice.type !== 'color';
  for (const b of el.bgColors.querySelectorAll('[data-color]')) {
    b.setAttribute('aria-pressed', String(bgChoice.type === 'color' && b.dataset.color === bgChoice.color));
  }
  el.bgScenes.hidden = bgChoice.type !== 'scene';
  updatePlacing();
  for (const b of el.bgScenes.querySelectorAll('[data-scene]')) {
    b.setAttribute('aria-pressed', String(bgChoice.type === 'scene' && b.dataset.scene === bgChoice.scene));
  }
}

// Scenes are photos too: loaded (and shrunk) like one, kept while in use.
const scenes = new Map(); // name -> image; 'own' is the one you picked

async function sceneImage(name) {
  if (!scenes.has(name)) {
    const res = await fetch(`backgrounds/${name}.jpg`);
    if (!res.ok) throw new Error('Could not load that scene');
    const { image } = await loadPhoto(await res.blob());
    for (const key of scenes.keys()) if (key !== 'own') scenes.delete(key); // keep memory low
    scenes.set(name, image);
  }
  return scenes.get(name);
}

async function previewBg() {
  showBgChoice();
  const base = current();
  const mask = masks.get(base);
  if (!mask) return;
  if (bgChoice.type === 'scene') return previewScene();
  const out = await run('Changing background…', () => engine.composite(base, mask, bgChoice));
  if (out && state.panel === 'bg' && current() === base) {
    state.preview = out;
    render();
  }
}

// ---------- scenes: place the person ----------
// A scene picture is a stack of layers made by the engine: the scene, the
// shadows and the person (see "scenes as layers" in engine/ops.js). Moving
// the person or the shadow only redraws the stack on a canvas, so it
// follows your finger, and Apply saves exactly what you see.

const cuts = new WeakMap(); // image -> cut-out layer { image, anchor }
const place = {
  base: null,
  cut: null,
  sceneName: null,
  transform: { scale: 1, dx: 0, dy: 0 },
  fit: null, // engine layers { scene, subject }
  shadows: null, // engine shadow layers
  canvas: null, // the same layers as canvases: { scene, subject, contact, cast }
  ground: null, // where the ground starts in the frame (0..1), null = unknown
  tall: 1, // the person's height in the cut-out, in pixels
  feetCut: false, // the photo's bottom edge cuts through the person
};

// Sun for each scene, as where the shadow of the top of the person lands
// (from the feet, in person-heights: kx right, ky toward you), and the
// horizon: where the ground (floor, sand, water, grass) meets the sky or
// back wall, as a fraction of the scene's height (null = unknown).
// Shadows only fall below it.
const SCENE_SUN = {
  beach: { kx: 0.4, ky: 0.35, ground: 0.64 },
  'basketball-court': { kx: 0.05, ky: 0.18, ground: 0.55 },
  'soccer-stadium': { kx: -0.2, ky: 0.75, ground: 0.49 },
  scenery: { kx: -0.45, ky: 0.3, ground: 0.5 },
  own: { kx: 0.35, ky: 0.3, ground: null },
};
const sun = { on: false, kx: 0.4, ky: 0.35, strength: 0.5 };
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const PLACE_HINT = 'Drag to move · pinch or slide to resize';

const sunLight = () => (sun.on ? { kx: sun.kx, ky: sun.ky, strength: sun.strength } : null);

function canvasOf(img) {
  const c = document.createElement('canvas');
  paint(c, img);
  return c;
}

// The scene cropped to cover the photo's frame (same crop as the engine's
// coverScene, so the engine then uses it as is). Also says where a line at
// `fraction` of the scene's height ends up in the frame.
function coverImage(img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const cw = Math.min(img.width, Math.round(w / scale));
  const ch = Math.min(img.height, Math.round(h / scale));
  const x0 = Math.floor((img.width - cw) / 2);
  const y0 = Math.floor((img.height - ch) * 0.6);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvasOf(img), x0, y0, cw, ch, 0, 0, w, h);
  const where = (fraction) => Math.min(1, Math.max(0, (fraction * img.height - y0) / ch));
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data, where };
}

function placing() {
  return state.panel === 'bg' && bgChoice.type === 'scene' && place.canvas !== null && place.base === current();
}

// Cut-out coordinates -> picture coordinates (moved and resized).
function toPicture(u, v) {
  const { scale, dx, dy } = place.transform;
  const { x: ax, y: ay } = place.cut.anchor;
  return [(u - ax) * scale + ax + dx, (v - ay) * scale + ay + dy];
}

function drawStack(ctx, w, h) {
  const L = place.canvas;
  const { scale } = place.transform;
  ctx.drawImage(L.scene, 0, 0, w, h);
  const sh = place.shadows;
  const [sx, sy] = toPicture(-sh.pad.x, -sh.pad.y);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  // No feet in the photo (cut off at the bottom): a ground shadow would be
  // a slab under the cut, so only the sunlight on the person is used.
  if (!place.feetCut) ctx.drawImage(L.contact, sx, sy, sh.width * scale, sh.height * scale);
  if (L.cast && !place.feetCut) {
    const dw = sh.width * scale;
    const dh = sh.height * scale;
    if (place.ground === null) ctx.drawImage(L.cast, sx, sy, dw, dh);
    else {
      // Fade in over a band below the horizon instead of a hard cut:
      // a few strips, each a little more opaque.
      const top = place.ground * h;
      const band = h * 0.04;
      const steps = 4;
      for (let k = 0; k <= steps; k++) {
        ctx.save();
        ctx.beginPath();
        const y0 = top + (band * k) / steps;
        ctx.rect(0, y0, w, k < steps ? band / steps : h - y0);
        ctx.clip();
        ctx.globalAlpha = (k + 1) / (steps + 1);
        ctx.drawImage(L.cast, sx, sy, dw, dh);
        ctx.restore();
      }
    }
  }
  ctx.restore();
  const [px, py] = toPicture(0, 0);
  ctx.drawImage(L.subject, px, py, w * scale, h * scale);
}

function drawPlacement() {
  const { width: w, height: h } = place.base;
  if (el.after.width !== w || el.after.height !== h) {
    el.after.width = w;
    el.after.height = h;
  }
  drawStack(el.after.getContext('2d'), w, h);
  el.sceneSize.value = String(Math.round(place.transform.scale * 100));
  // The shadow-end handle: where the shadow of the top of the person lands.
  el.sunHandle.hidden = !sun.on;
  if (sun.on) {
    const { x: ax, y: ay } = place.cut.anchor;
    const [hx, hy] = toPicture(ax + sun.kx * place.tall, ay + sun.ky * place.tall);
    // Always reachable: kept inside the picture even if the shadow ends outside.
    const clamp = (v) => Math.min(96, Math.max(4, v));
    el.sunHandle.style.left = `${clamp((hx / w) * 100)}%`;
    el.sunHandle.style.top = `${clamp((hy / h) * 100)}%`;
  }
}

// Redraw at most once per screen frame.
let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    if (placing()) drawPlacement();
  });
}

// The final picture, drawn the same way at full size.
function renderStack() {
  const { width: w, height: h } = place.base;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  drawStack(ctx, w, h);
  const out = { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  c.width = c.height = 0;
  return out;
}

function setShadows(shadows) {
  place.shadows = shadows;
  place.canvas.contact = canvasOf(shadows.contact);
  place.canvas.cast = shadows.cast ? canvasOf(shadows.cast) : null;
}

// How tall the person is, and whether the photo's edge cuts them off.
// A body cut off by the bottom edge (half-body photo) is wide there; a
// shoe touching the edge is not.
function measureCut(cut) {
  const { width: w, height: h, data } = cut.image;
  let top = h;
  let left = w;
  let right = 0;
  let edge = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 128) continue;
      if (y < top) top = y;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y === h - 1) edge++;
    }
  }
  return { tall: Math.max(1, cut.anchor.y - top), feetCut: edge > Math.max(1, right - left) * 0.3 };
}

async function previewScene() {
  const base = current();
  const ready = await run('Fitting into the scene…', async () => {
    if (!cuts.has(base)) cuts.set(base, await engine.cutout(base, masks.get(base)));
    const cut = cuts.get(base);
    const img = await sceneImage(bgChoice.scene);
    const covered = coverImage(img, base.width, base.height);
    const sceneImg = { width: covered.width, height: covered.height, data: covered.data };
    // Each scene starts with its own sun (on/off stays as you chose).
    const preset = SCENE_SUN[bgChoice.scene] || SCENE_SUN.own;
    sun.kx = preset.kx;
    sun.ky = preset.ky;
    const fit = await engine.sceneFit(base, masks.get(base), cut, sceneImg);
    const shadows = await engine.shadows(cut, sunLight());
    const subject = sun.on ? await engine.relight(fit.subject, fit.scene, sunLight()) : fit.subject;
    if (place.base !== base) place.transform = { scale: 1, dx: 0, dy: 0 };
    Object.assign(place, { base, cut, sceneName: bgChoice.scene, fit, ...measureCut(cut) });
    place.ground = preset.ground === null ? null : covered.where(preset.ground);
    place.canvas = { scene: canvasOf(fit.scene), subject: canvasOf(subject) };
    setShadows(shadows);
    return true;
  });
  if (!ready || state.panel !== 'bg' || current() !== base) return;
  state.preview = null;
  showSun();
  layout();
  drawPlacement();
  updatePlacing();
  setStatus(PLACE_HINT);
}

// Engine jobs for the sun; a newer request replaces a waiting one.
function latest(job) {
  let running = null;
  let again = false;
  const loop = async () => {
    do {
      again = false;
      try {
        await job();
      } catch (err) {
        setStatus(err.message, true);
      }
    } while (again && placing());
  };
  return {
    request() {
      if (running) {
        again = true;
        return;
      }
      running = loop().finally(() => {
        running = null;
      });
    },
    done: async () => {
      while (running) await running;
    },
  };
}

const shadowUpdate = latest(async () => {
  const shadows = await engine.shadows(place.cut, sunLight());
  if (!placing()) return;
  setShadows(shadows);
  scheduleDraw();
});

const lightUpdate = latest(async () => {
  const light = sunLight();
  const subject = light ? await engine.relight(place.fit.subject, place.fit.scene, light) : place.fit.subject;
  if (!placing()) return;
  place.canvas.subject = canvasOf(subject);
  scheduleDraw();
  setStatus(sun.on ? 'Drag the yellow dot to aim the shadow' : PLACE_HINT);
});

previews.bg = {
  // Apply: wait for the latest sun update, then save what you see.
  async settled() {
    if (!placing()) return;
    await shadowUpdate.done();
    await lightUpdate.done();
    state.preview = renderStack();
  },
};

function updatePlacing() {
  const on = placing();
  el.frame.classList.toggle('placing', on);
  el.scenePlace.hidden = !on;
  if (!on) el.sunHandle.hidden = true;
}

// Drag with one finger, pinch with two. Positions are in image pixels.
const fingers = new Map();
let gesture = null;

function startGesture() {
  const pts = [...fingers.values()];
  gesture = { transform: { ...place.transform }, pts: pts.map((p) => ({ ...p })) };
}

function toImage(p) {
  const r = el.frame.getBoundingClientRect();
  const k = place.base.width / r.width;
  return { x: (p.x - r.left) * k, y: (p.y - r.top) * k };
}

el.frame.addEventListener('pointerdown', (e) => {
  if (!placing() || state.comparing || state.busy) return;
  el.frame.setPointerCapture(e.pointerId);
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  startGesture();
});

el.frame.addEventListener('pointermove', (e) => {
  if (!fingers.has(e.pointerId) || !gesture) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = [...fingers.values()].map(toImage);
  const then = gesture.pts.map(toImage);
  const t0 = gesture.transform;
  const { x: ax, y: ay } = place.cut.anchor;
  if (now.length === 1) {
    place.transform = { ...t0, dx: t0.dx + now[0].x - then[0].x, dy: t0.dy + now[0].y - then[0].y };
  } else {
    const mid = (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
    const dist = (p) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (t0.scale * dist(now)) / Math.max(dist(then), 1)));
    // Keep the point that was under your fingers under your fingers.
    const c0 = mid(then);
    const c1 = mid(now);
    const sx = (c0.x - ax - t0.dx) / t0.scale + ax;
    const sy = (c0.y - ay - t0.dy) / t0.scale + ay;
    place.transform = { scale, dx: c1.x - ax - (sx - ax) * scale, dy: c1.y - ay - (sy - ay) * scale };
  }
  scheduleDraw();
});

function endFinger(e) {
  if (!fingers.delete(e.pointerId)) return;
  if (fingers.size) startGesture();
  else {
    gesture = null;
    setStatus(sun.on ? 'Drag the yellow dot to aim the shadow' : PLACE_HINT);
  }
}
el.frame.addEventListener('pointerup', endFinger);
el.frame.addEventListener('pointercancel', endFinger);

// The size slider (one-handed alternative to pinching).
el.sceneSize.addEventListener('input', () => {
  if (!placing()) return;
  place.transform = { ...place.transform, scale: Number(el.sceneSize.value) / 100 };
  scheduleDraw();
});
el.sceneSize.addEventListener('change', () => placing() && setStatus(PLACE_HINT));

el.sceneReset.addEventListener('click', () => {
  if (!placing()) return;
  place.transform = { scale: 1, dx: 0, dy: 0 };
  scheduleDraw();
  setStatus(PLACE_HINT);
});

// ----- sun and shadow (an option) -----
// Drag the yellow dot (the end of the shadow) to aim it; the slider sets
// how dark it is.

function showSun() {
  el.sunToggle.setAttribute('aria-pressed', String(sun.on));
  el.sunStrength.hidden = !sun.on;
  el.sunNote.textContent = sun.on ? 'Darkness' : 'Shadow and sunlight';
  el.sunStrength.value = String(Math.round(sun.strength * 100));
  el.sceneHint.textContent = !sun.on
    ? PLACE_HINT
    : place.feetCut
      ? 'No feet in this photo, so no ground shadow: the sun lights the person. Drag the dot to move the light.'
      : 'Drag the yellow dot to where the shadow should end';
}

el.sunToggle.addEventListener('click', () => {
  if (!placing()) return;
  sun.on = !sun.on;
  showSun();
  shadowUpdate.request();
  lightUpdate.request();
  scheduleDraw();
});

el.sunStrength.addEventListener('input', () => {
  sun.strength = Number(el.sunStrength.value) / 100;
  shadowUpdate.request();
});
el.sunStrength.addEventListener('change', () => lightUpdate.request());

el.sunHandle.addEventListener('pointerdown', (e) => {
  if (!placing()) return;
  e.stopPropagation(); // not a person drag
  el.sunHandle.setPointerCapture(e.pointerId);
});

el.sunHandle.addEventListener('pointermove', (e) => {
  if (!el.sunHandle.hasPointerCapture(e.pointerId)) return;
  // Where the finger is, in the cut-out's coordinates, relative to the feet.
  const p = toImage({ x: e.clientX, y: e.clientY });
  const { scale, dx, dy } = place.transform;
  const { x: ax, y: ay } = place.cut.anchor;
  let kx = (p.x - dx - ax) / scale / place.tall;
  let ky = (p.y - dy - ay) / scale / place.tall;
  const len = Math.hypot(kx, ky);
  if (len > 2.5) {
    kx *= 2.5 / len;
    ky *= 2.5 / len;
  }
  sun.kx = kx;
  sun.ky = ky;
  shadowUpdate.request();
  scheduleDraw();
});

el.sunHandle.addEventListener('pointerup', () => lightUpdate.request());
el.sunHandle.addEventListener('pointercancel', () => lightUpdate.request());

el.background.addEventListener('click', async () => {
  const base = current();
  if (!masks.has(base)) {
    const mask = await run('Getting AI ready…', () =>
      engine.segment(base, (p) => {
        if (p.phase === 'download') {
          const mb = (n) => (n / 1e6).toFixed(1);
          setBusy(`Downloading AI model (first time only)… ${mb(p.loaded)} / ${mb(p.total)} MB`, p.loaded / p.total);
        } else if (p.phase === 'start') {
          setBusy('Starting AI…');
        } else if (p.phase === 'run') {
          setBusy('Finding the subject…');
        }
      }),
    );
    if (!mask) return;
    masks.set(base, mask);
  }
  openPanel('bg');
  await previewBg();
});

for (const b of el.panelBg.querySelectorAll('[data-bg]')) {
  b.addEventListener('click', () => {
    const type = b.dataset.bg;
    bgChoice = { type, color: bgChoice.color || '#ffffff', scene: bgChoice.scene || 'beach' };
    previewBg();
  });
}

for (const b of el.bgScenes.querySelectorAll('button[data-scene]')) {
  b.addEventListener('click', () => {
    bgChoice = { ...bgChoice, type: 'scene', scene: b.dataset.scene };
    previewBg();
  });
}

// "Your photo": any picture from the camera roll as the new background.
el.sceneFile.addEventListener('change', async () => {
  const file = el.sceneFile.files[0];
  el.sceneFile.value = '';
  if (!file) return;
  const loaded = await run('Opening photo…', () => loadPhoto(file));
  if (!loaded) return;
  scenes.set('own', loaded.image);
  bgChoice = { ...bgChoice, type: 'scene', scene: 'own' };
  previewBg();
});

for (const b of el.bgColors.querySelectorAll('[data-color]')) {
  b.style.setProperty('--c', b.dataset.color); // set here: the CSP forbids inline styles
  b.addEventListener('click', () => {
    bgChoice = { ...bgChoice, type: 'color', color: b.dataset.color };
    previewBg();
  });
}

el.bgCustom.addEventListener('change', () => {
  bgChoice = { ...bgChoice, type: 'color', color: el.bgCustom.value };
  previewBg();
});

// ---------- before / after ----------

el.compare.addEventListener('click', () => {
  state.comparing = !state.comparing;
  state.split = 0.5;
  renderCompare();
});

function moveSplit(e) {
  const r = el.frame.getBoundingClientRect();
  state.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  renderCompare();
}

el.frame.addEventListener('pointerdown', (e) => {
  if (!state.comparing) return;
  el.frame.setPointerCapture(e.pointerId);
  moveSplit(e);
});

el.frame.addEventListener('pointermove', (e) => {
  if (state.comparing && el.frame.hasPointerCapture(e.pointerId)) moveSplit(e);
});

// ---------- saving ----------

function hasTransparency(img) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

// Build the file in advance: iOS only opens the share sheet if share() is
// called straight from the tap, with no slow work in between.
let exportToken = 0;
async function prepareExport() {
  const img = current();
  const token = ++exportToken;
  state.exportFile = null;
  if (!img) return;
  const png = hasTransparency(img);
  const canvas = document.createElement('canvas');
  paint(canvas, img);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.92));
  canvas.width = canvas.height = 0;
  if (token !== exportToken || !blob) return;
  const name = `${state.fileName}-enhanced.${png ? 'png' : 'jpg'}`;
  state.exportFile = new File([blob], name, { type: blob.type });
}

el.save.addEventListener('click', async () => {
  const file = state.exportFile;
  if (!file) {
    setStatus('Still preparing the file, tap Save again in a moment');
    return;
  }
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      setStatus('Shared');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // you closed the share sheet
      console.error(err);
    }
  }
  // Fallback: show the image so it can be saved with a long press.
  if (el.saveImg.src) URL.revokeObjectURL(el.saveImg.src);
  el.saveImg.src = URL.createObjectURL(file);
  el.saveSheet.hidden = false;
});

el.saveClose.addEventListener('click', () => {
  el.saveSheet.hidden = true;
  URL.revokeObjectURL(el.saveImg.src);
  el.saveImg.removeAttribute('src');
});

// ---------- offline ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable', err));
}

updateButtons();
