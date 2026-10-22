// The engine: the only door between the app and the image processing.
//
// The app never touches pixels itself; it calls these functions with
// { width, height, data } images and gets new images back. Today every
// call goes to a Web Worker on the phone (worker.js). Later a "remote"
// transport can send the same calls to the PC over Tailscale (phase 3)
// without the app changing; see CLAUDE.md.

// Shadow geometry is shared with the app's instant preview.
export { shadowShear } from './ops.js';

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error, progress } = e.data;
      const job = pending.get(id);
      if (!job) return;
      if (progress) {
        if (job.onProgress) job.onProgress(progress);
        return;
      }
      pending.delete(id);
      if (error) job.reject(new Error(error));
      else job.resolve(result);
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'Engine crashed'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function call(op, args = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, op, args });
  });
}

// Copies of the pixels are sent, so the caller's image stays usable
// (the app keeps it for Undo).
const plain = (img) => ({ width: img.width, height: img.height, data: img.data });

export const engine = {
  // amount: 0 (none) to 2 (strong)
  sharpen: (image, amount) => call('sharpen', { image: plain(image), amount }),

  autoEnhance: (image) => call('autoEnhance', { image: plain(image) }),

  // Readable text from a blurry, zoomed photo. mode: 'color' | 'bw',
  // strength 0..1 (how blurry the photo is). Small photos come back 2x larger.
  enhanceText: (image, mode, strength) => call('enhanceText', { image: plain(image), mode, strength }),

  // Finds the main subject. Returns a mask (one byte per pixel).
  // onProgress gets { phase: 'download', loaded, total } the first time
  // (AI files are being fetched), then { phase: 'start' } and { phase: 'run' }.
  segment: (image, onProgress) => call('segment', { image: plain(image) }, onProgress),

  // The subject as its own layer with clean edges, plus its anchor (bottom
  // centre). Pass it to composite as background.cut to save time.
  cutout: (image, mask) => call('cutout', { image: plain(image), mask }),

  // Scene pictures as layers the app stacks and redraws instantly (see
  // "scenes as layers" in ops.js):
  // { scene, subject } for a scene (scene must already cover the photo frame)
  sceneFit: (image, mask, cut, scene) => call('sceneFit', { image: plain(image), mask, cut, scene }),
  // { pad, width, height, contact, cast } shadow layers; light = null for none
  shadows: (cut, light) => call('shadows', { cut, light }),
  // the person lit by the sun
  relight: (subject, scene, light) => call('relight', { subject, scene, light }),

  // background: { type: 'transparent' | 'color' | 'blur', color? } or
  // { type: 'scene', scene, cut?, transform?: { scale, dx, dy },
  //   light?: { kx, ky, strength, ground } } (sun and cast shadow)
  composite: (image, mask, background) => call('composite', { image: plain(image), mask, background }),

  isModelCached: () => call('isModelCached'),
};
