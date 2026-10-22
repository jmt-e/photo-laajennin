// Runs the heavy work off the main thread so the UI stays smooth.
// Talks to engine.js with messages: { id, op, args } -> { id, result }
// or { id, error }, plus { id, progress } while downloading the AI model.

import * as ops from './ops.js';

const AI_CACHE = 'ai-v1';
// Byte sizes are only for the progress bar (tests/files.test.mjs checks them).
// MODNet: made for people (hair-level edges). U2-Netp: any main subject,
// used when MODNet finds no person.
const MODELS = {
  modnet: { url: new URL('../models/modnet.onnx', import.meta.url).href, bytes: 25888640 },
  u2netp: { url: new URL('../models/u2netp.onnx', import.meta.url).href, bytes: 4574861, size: 320 },
};
const WASM = { url: new URL('../vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm', import.meta.url).href, bytes: 14239897 };

const sessions = {};
let ort = null;

// Fetch a file from our own site once, keep it in Cache Storage so it works
// offline afterwards. Reports bytes as they arrive.
async function cachedBytes(url, onBytes) {
  const cache = self.caches ? await caches.open(AI_CACHE) : null;
  const res = cache && (await cache.match(url));
  if (!res) {
    const net = await fetch(url);
    if (!net.ok) throw new Error(`Could not download ${url.split('/').pop()} (${net.status})`);
    const reader = net.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onBytes(value.length);
    }
    const blob = new Blob(chunks);
    try {
      if (cache) await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch {
      // Storage full or blocked: still works, just downloads again next time.
    }
    return blob.arrayBuffer();
  }
  const buf = await res.arrayBuffer();
  onBytes(buf.byteLength);
  return buf;
}

async function isCached(url) {
  if (!self.caches) return false;
  const cache = await caches.open(AI_CACHE);
  return Boolean(await cache.match(url));
}

// Loads ONNX Runtime (once) and the named model, downloading what isn't
// cached yet with a progress report.
function loadSession(name, report) {
  if (!sessions[name]) {
    sessions[name] = (async () => {
      const files = ort ? [MODELS[name]] : [WASM, MODELS[name]];
      const missing = [];
      for (const f of files) if (!(await isCached(f.url))) missing.push(f);
      const total = missing.reduce((sum, f) => sum + f.bytes, 0);
      let loaded = 0;
      const onBytes = (n) => {
        loaded += n;
        if (missing.length) report({ phase: 'download', loaded: Math.min(loaded, total), total });
      };
      const quiet = () => {};
      const bytes = await Promise.all(files.map((f) => cachedBytes(f.url, missing.includes(f) ? onBytes : quiet)));
      report({ phase: 'start' });
      if (!ort) {
        const lib = await import('../vendor/onnxruntime-web/ort.wasm.min.mjs');
        lib.env.wasm.wasmBinary = bytes[0];
        lib.env.wasm.numThreads = 1;
        ort = lib;
      }
      return ort.InferenceSession.create(new Uint8Array(bytes[bytes.length - 1]), { executionProviders: ['wasm'] });
    })();
    // Let a failed download be retried.
    sessions[name].catch(() => {
      sessions[name] = null;
    });
  }
  return sessions[name];
}

async function run(session, data, dims) {
  const input = new ort.Tensor('float32', data, dims);
  const outputs = await session.run({ [session.inputNames[0]]: input });
  return outputs[session.outputNames[0]].data;
}

const handlers = {
  sharpen: ({ image, amount }) => ops.sharpen(image, { amount }),
  autoEnhance: ({ image }) => ops.autoEnhance(image),
  enhanceText: ({ image, mode, strength }) => ops.enhanceText(image, { mode, strength }),
  composite: ({ image, mask, background }) => ops.composite(image, mask, background),
  cutout: ({ image, mask }) => ops.cutout(image, mask),
  async segment({ image }, report) {
    // People first: MODNet gives soft, hair-level edges.
    const modnet = await loadSession('modnet', report);
    report({ phase: 'run' });
    const input = ops.modnetInput(image);
    const matte = await run(modnet, input.data, [1, 3, input.height, input.width]);
    let person = 0;
    for (const v of matte) if (v > 0.5) person++;
    if (person > matte.length * 0.01) {
      return ops.refineMask(matte, input.width, input.height, image, { normalize: false, low: 0.04, high: 0.8, eps: 1e-4 });
    }
    // No person found: cut out the main subject instead.
    const u2 = await loadSession('u2netp', report);
    report({ phase: 'run' });
    const size = MODELS.u2netp.size;
    const pred = await run(u2, ops.modelInput(image, size), [1, 3, size, size]);
    return ops.refineMask(pred, size, size, image);
  },
  async isModelCached() {
    return (await isCached(MODELS.modnet.url)) && (await isCached(WASM.url));
  },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  const report = (progress) => self.postMessage({ id, progress });
  try {
    const result = await handlers[op](args, report);
    const transfer = [];
    if (result && result.data && result.data.buffer) transfer.push(result.data.buffer);
    else if (result && result.buffer) transfer.push(result.buffer);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
