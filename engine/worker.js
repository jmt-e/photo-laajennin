// Runs the heavy work off the main thread so the UI stays smooth.
// Talks to engine.js with messages: { id, op, args } -> { id, result }
// or { id, error }, plus { id, progress } while downloading the AI model.

import * as ops from './ops.js';

const AI_CACHE = 'ai-v1';
// Byte sizes are only for the progress bar (tests/files.test.mjs checks them).
const MODEL = { url: new URL('../models/u2netp.onnx', import.meta.url).href, bytes: 4574861, size: 320 };
const WASM = { url: new URL('../vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm', import.meta.url).href, bytes: 14239897 };

let sessionPromise = null;
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

function loadSession(report) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const firstTime = !(await isCached(WASM.url)) || !(await isCached(MODEL.url));
      const total = WASM.bytes + MODEL.bytes;
      let loaded = 0;
      const onBytes = (n) => {
        loaded += n;
        if (firstTime) report({ phase: 'download', loaded: Math.min(loaded, total), total });
      };
      const [wasm, model] = await Promise.all([cachedBytes(WASM.url, onBytes), cachedBytes(MODEL.url, onBytes)]);
      report({ phase: 'start' });
      ort = await import('../vendor/onnxruntime-web/ort.wasm.min.mjs');
      ort.env.wasm.wasmBinary = wasm;
      ort.env.wasm.numThreads = 1;
      return ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
    })();
    // Let a failed download be retried.
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

const handlers = {
  sharpen: ({ image, amount }) => ops.sharpen(image, { amount }),
  autoEnhance: ({ image }) => ops.autoEnhance(image),
  enhanceText: ({ image, mode, strength }) => ops.enhanceText(image, { mode, strength }),
  composite: ({ image, mask, background }) => ops.composite(image, mask, background),
  async segment({ image }, report) {
    const session = await loadSession(report);
    report({ phase: 'run' });
    const size = MODEL.size;
    const input = new ort.Tensor('float32', ops.modelInput(image, size), [1, 3, size, size]);
    const outputs = await session.run({ [session.inputNames[0]]: input });
    const pred = outputs[session.outputNames[0]].data;
    return ops.refineMask(pred, size, image);
  },
  async isModelCached() {
    return (await isCached(MODEL.url)) && (await isCached(WASM.url));
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
