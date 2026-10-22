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
  paint(el.after, img);
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
  const choice = bgChoice;
  const out = await run(choice.type === 'scene' ? 'Fitting you into the scene…' : 'Changing background…', async () => {
    const background = choice.type === 'scene' ? { type: 'scene', scene: await sceneImage(choice.scene) } : choice;
    return engine.composite(base, mask, background);
  });
  if (out && state.panel === 'bg' && current() === base) {
    state.preview = out;
    render();
  }
}

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
