// Pure pixel operations. No DOM, no network: works in the page, in a
// Worker, and in Node (for tests).
//
// An "image" here is a plain object { width, height, data } where data is
// a Uint8ClampedArray of RGBA bytes, the same layout as ImageData.
// A "mask" is a Uint8Array with one byte (0-255) per pixel.

export function makeImage(width, height, data) {
  return { width, height, data: data || new Uint8ClampedArray(width * height * 4) };
}

// ---------- blur helpers (on Float32 planes) ----------

// Box blur with radius r along rows, then columns. Edges are clamped.
// Both passes walk memory row by row (fast); edge clamping is kept out of
// the inner loops.
function boxBlurH(src, dst, w, h, r) {
  const scale = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row];
    const last = src[row + w - 1];
    let acc = first * (r + 1);
    for (let i = 1; i <= r; i++) acc += i < w ? src[row + i] : last;
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * scale;
      const add = x + r + 1 < w ? src[row + x + r + 1] : last;
      const sub = x - r >= 0 ? src[row + x - r] : first;
      acc += add - sub;
    }
  }
}

function boxBlurV(src, dst, w, h, r, acc) {
  const scale = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) acc[x] = src[x] * (r + 1);
  for (let i = 1; i <= r; i++) {
    const row = Math.min(i, h - 1) * w;
    for (let x = 0; x < w; x++) acc[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const out = y * w;
    const add = Math.min(y + r + 1, h - 1) * w;
    const sub = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) {
      dst[out + x] = acc[x] * scale;
      acc[x] += src[add + x] - src[sub + x];
    }
  }
}

// One box pass (mean over a (2r+1)^2 window). Returns a new plane.
export function boxBlur(plane, w, h, r) {
  if (r < 1) return Float32Array.from(plane);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  boxBlurH(plane, tmp, w, h, r);
  boxBlurV(tmp, out, w, h, r, new Float64Array(w));
  return out;
}

// Three box passes approximate a Gaussian with the given sigma.
export function gaussianBlur(plane, w, h, sigma) {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  const acc = new Float64Array(w);
  boxBlurH(plane, a, w, h, r);
  boxBlurV(a, b, w, h, r, acc);
  boxBlurH(b, a, w, h, r);
  boxBlurV(a, b, w, h, r, acc);
  boxBlurH(b, a, w, h, r);
  boxBlurV(a, b, w, h, r, acc);
  return b;
}

function luminance(img) {
  const { width: w, height: h, data: d } = img;
  const L = new Float32Array(w * h);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) {
    L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  }
  return L;
}

// ---------- sharpen ----------

// Unsharp mask on brightness only, so edges don't get colour fringes.
// amount: 0 = nothing, 1 = normal, 2 = strong.
export function sharpen(img, { amount = 1, sigma, threshold = 2 } = {}) {
  const { width: w, height: h, data: d } = img;
  if (sigma === undefined) sigma = Math.max(1, Math.max(w, h) / 1400);
  const L = luminance(img);
  const B = gaussianBlur(L, w, h, sigma);
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) {
    let diff = L[i] - B[i];
    // Leave flat areas alone so noise isn't amplified.
    if (Math.abs(diff) < threshold) diff = 0;
    const add = amount * diff;
    out[j] = d[j] + add;
    out[j + 1] = d[j + 1] + add;
    out[j + 2] = d[j + 2] + add;
    out[j + 3] = d[j + 3];
  }
  return makeImage(w, h, out);
}

// ---------- auto-enhance ----------

function percentile(hist, total, p) {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

// One-tap fix: stretch levels (brightness + contrast), partly neutralise
// colour casts, nudge mid-tones toward normal exposure, add a little
// colour. Deliberately gentle so it rarely makes a photo worse.
export function autoEnhance(img) {
  const { width: w, height: h, data: d } = img;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let j = 0; j < d.length; j += 4) {
    if (d[j + 3] < 128) continue; // ignore removed background
    hist[0][d[j]]++;
    hist[1][d[j + 1]]++;
    hist[2][d[j + 2]]++;
    hist[3][Math.round(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2])]++;
    n++;
  }
  if (n === 0) return makeImage(w, h, Uint8ClampedArray.from(d));

  const loL = percentile(hist[3], n, 0.005);
  const hiL = percentile(hist[3], n, 0.995);
  const CAST = 0.6; // how much of each channel's own stretch to use
  const MAX_GAIN = 2.5;
  const luts = [];
  for (let c = 0; c < 3; c++) {
    let lo = loL + CAST * (percentile(hist[c], n, 0.005) - loL);
    let hi = hiL + CAST * (percentile(hist[c], n, 0.995) - hiL);
    if (hi - lo < 255 / MAX_GAIN) {
      const mid = (hi + lo) / 2;
      lo = mid - 255 / MAX_GAIN / 2;
      hi = mid + 255 / MAX_GAIN / 2;
    }
    const lut = new Float32Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    luts.push(lut);
  }

  // Mean brightness after the stretch decides the mid-tone (gamma) nudge.
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    const weight = [0.299, 0.587, 0.114][c];
    for (let v = 0; v < 256; v++) sum += weight * hist[c][v] * luts[c][v];
  }
  const mean = Math.min(0.95, Math.max(0.05, sum / n));
  const gamma = Math.min(1.35, Math.max(0.75, Math.log(0.47) / Math.log(mean)));
  const final = luts.map((lut) => {
    const out = new Float32Array(256);
    for (let v = 0; v < 256; v++) out[v] = Math.pow(lut[v], gamma) * 255;
    return out;
  });

  const out = new Uint8ClampedArray(d.length);
  for (let j = 0; j < d.length; j += 4) {
    const r = final[0][d[j]];
    const g = final[1][d[j + 1]];
    const b = final[2][d[j + 2]];
    // Vibrance: boost dull colours more than already-saturated ones.
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const s = 1 + 0.18 * (1 - sat);
    out[j] = y + (r - y) * s;
    out[j + 1] = y + (g - y) * s;
    out[j + 2] = y + (b - y) * s;
    out[j + 3] = d[j + 3];
  }
  return makeImage(w, h, out);
}

// ---------- resizing ----------

// Resize a Float32 plane. Downscaling pre-blurs to avoid aliasing,
// sampling is bilinear.
export function resizePlane(src, sw, sh, dw, dh) {
  let s = src;
  const factor = Math.max(sw / dw, sh / dh);
  if (factor > 1.5) s = boxBlur(src, sw, sh, Math.floor(factor / 2));
  const out = new Float32Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const syf = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(syf);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = syf - y0;
    for (let x = 0; x < dw; x++) {
      const sxf = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sxf);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sxf - x0;
      const a = s[y0 * sw + x0] + (s[y0 * sw + x1] - s[y0 * sw + x0]) * tx;
      const b = s[y1 * sw + x0] + (s[y1 * sw + x1] - s[y1 * sw + x0]) * tx;
      out[y * dw + x] = a + (b - a) * ty;
    }
  }
  return out;
}

// Split RGB into three Float32 planes (0-255).
export function toPlanes(img) {
  const { width: w, height: h, data: d } = img;
  const planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    planes[0][i] = d[j];
    planes[1][i] = d[j + 1];
    planes[2][i] = d[j + 2];
  }
  return planes;
}

// ---------- background removal helpers ----------

// Model input for U2-Net style models: size x size, ImageNet-normalised,
// planar float32 [1, 3, size, size].
export function modelInput(img, size) {
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const planes = toPlanes(img);
  const out = new Float32Array(3 * size * size);
  for (let c = 0; c < 3; c++) {
    const p = resizePlane(planes[c], img.width, img.height, size, size);
    for (let i = 0; i < p.length; i++) out[c * size * size + i] = (p[i] / 255 - mean[c]) / std[c];
  }
  return out;
}

// Model input for MODNet (people cut-out): long side 512, both sides a
// multiple of 32, values scaled to -1..1, planar [1, 3, h, w].
export function modnetInput(img, longSide = 512) {
  const scale = longSide / Math.max(img.width, img.height);
  const w = Math.max(32, Math.round((img.width * scale) / 32) * 32);
  const h = Math.max(32, Math.round((img.height * scale) / 32) * 32);
  const planes = toPlanes(img);
  const data = new Float32Array(3 * w * h);
  for (let c = 0; c < 3; c++) {
    const p = resizePlane(planes[c], img.width, img.height, w, h);
    for (let i = 0; i < p.length; i++) data[c * w * h + i] = p[i] / 127.5 - 1;
  }
  return { data, width: w, height: h };
}

// Turn the model's small output (pw x ph) into a full-size mask whose
// edges follow the photo (guided filter, He et al. 2010).
// normalize: stretch the output to 0..1 first (U2-Net; MODNet already is).
// low/high: output values that become fully clear / fully solid.
export function refineMask(pred, pw, ph, img, { normalize = true, low = 0.1, high = 0.9, eps = 1e-3 } = {}) {
  const { width: w, height: h } = img;
  let lo = 0;
  let hi = 1;
  if (normalize) {
    lo = Infinity;
    hi = -Infinity;
    for (const v of pred) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const norm = new Float32Array(pred.length);
  for (let i = 0; i < pred.length; i++) norm[i] = (pred[i] - lo) / (hi - lo || 1);

  const I = luminance(img);
  for (let i = 0; i < I.length; i++) I[i] /= 255;

  // Fast guided filter (He & Sun 2015): work out the edge-following
  // coefficients at up to 1024 px, then apply them at full size. Same
  // edges, a quarter of the memory, which matters on iPhone.
  const s = Math.min(1, 1024 / Math.max(w, h));
  const lw = Math.max(1, Math.round(w * s));
  const lh = Math.max(1, Math.round(h * s));
  const Il = s < 1 ? resizePlane(I, w, h, lw, lh) : I;
  const p = resizePlane(norm, pw, ph, lw, lh);

  // Window about two model pixels wide, so it spans the blurry upscaled edge.
  const r = Math.max(2, Math.round((2 * Math.max(lw, lh)) / Math.max(pw, ph)));
  const n = lw * lh;
  const II = new Float32Array(n);
  const Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = Il[i] * Il[i];
    Ip[i] = Il[i] * p[i];
  }
  const mI = boxBlur(Il, lw, lh, r);
  const mp = boxBlur(p, lw, lh, r);
  const mII = boxBlur(II, lw, lh, r);
  const mIp = boxBlur(Ip, lw, lh, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIp[i] - mI[i] * mp[i];
    a[i] = cov / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  let ma = boxBlur(a, lw, lh, r);
  let mb = boxBlur(b, lw, lh, r);
  if (s < 1) {
    ma = resizePlane(ma, lw, lh, w, h);
    mb = resizePlane(mb, lw, lh, w, h);
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    const q = ma[i] * I[i] + mb[i];
    // Gentle contrast so the subject is solid and the background clean.
    const t = Math.min(1, Math.max(0, (q - low) / (high - low)));
    mask[i] = Math.round(t * 255);
  }
  return mask;
}

// Blur a plane at up to 512 px (fast, little memory) and scale back up.
// sigmaFrac is the blur size as a fraction of the long side.
function softBlur(plane, w, h, sigmaFrac) {
  const f = Math.min(1, 512 / Math.max(w, h));
  const lw = Math.max(1, Math.round(w * f));
  const lh = Math.max(1, Math.round(h * f));
  const small = f < 1 ? resizePlane(plane, w, h, lw, lh) : plane;
  const blurred = gaussianBlur(small, lw, lh, Math.max(lw, lh) * sigmaFrac);
  return f < 1 ? resizePlane(blurred, lw, lh, w, h) : blurred;
}

// The photo's background with the subject removed and the hole filled in
// from around it: a blur of only the background pixels (weighted by
// 1 - mask), so the subject's colours don't smear into a halo.
function backgroundOnly(planes, alpha, w, h, sigmaFrac) {
  const weight = new Float32Array(w * h);
  for (let i = 0; i < weight.length; i++) weight[i] = 1 - alpha[i];
  return fillFrom(planes, weight, w, h, sigmaFrac);
}

// Colours spread out from where weight is high (normalised blur).
function fillFrom(planes, weight, w, h, sigmaFrac, minWeight = 0.02) {
  const wBlur = softBlur(weight, w, h, sigmaFrac);
  return planes.map((plane) => {
    const weighted = new Float32Array(plane.length);
    for (let i = 0; i < plane.length; i++) weighted[i] = plane[i] * weight[i];
    const wb = softBlur(weighted, w, h, sigmaFrac);
    const plain = softBlur(plane, w, h, sigmaFrac);
    for (let i = 0; i < wb.length; i++) wb[i] = wBlur[i] > minWeight ? wb[i] / wBlur[i] : plain[i];
    return wb;
  });
}

function alphaOf(img, mask) {
  const a = new Float32Array(mask.length);
  for (let i = 0; i < a.length; i++) a[i] = (mask[i] / 255) * (img.data[i * 4 + 3] / 255);
  return a;
}

// Put the cut-out subject on a new background.
// background: { type: 'transparent' } | { type: 'color', color: '#rrggbb' }
//           | { type: 'blur' }
//           | { type: 'scene', scene: image, transform?, cut? } (see placeOnScene)
export function composite(img, mask, background) {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8ClampedArray(d.length);
  const type = background.type;

  if (type === 'transparent') {
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      out[j] = d[j];
      out[j + 1] = d[j + 1];
      out[j + 2] = d[j + 2];
      out[j + 3] = (mask[i] * d[j + 3]) / 255;
    }
    return makeImage(w, h, out);
  }
  if (type === 'scene') return placeOnScene(img, mask, background.scene, background);

  let bg;
  if (type === 'color') {
    const hex = background.color.replace('#', '');
    const rgb = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
    bg = (c) => rgb[c];
  } else if (type === 'blur') {
    const planes = backgroundOnly(toPlanes(img), alphaOf(img, mask), w, h, 0.012);
    bg = (c, i) => planes[c][i];
  } else {
    throw new Error('Unknown background: ' + type);
  }

  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const a = (mask[i] / 255) * (d[j + 3] / 255);
    out[j] = d[j] * a + bg(0, i) * (1 - a);
    out[j + 1] = d[j + 1] * a + bg(1, i) * (1 - a);
    out[j + 2] = d[j + 2] * a + bg(2, i) * (1 - a);
    out[j + 3] = 255;
  }
  return makeImage(w, h, out);
}

// Scale a scene to cover w x h (like CSS background-size: cover), centred
// sideways and a little below centre, so more ground than sky is kept.
export function coverScene(scene, w, h) {
  const scale = Math.max(w / scene.width, h / scene.height);
  const cw = Math.min(scene.width, Math.round(w / scale));
  const ch = Math.min(scene.height, Math.round(h / scale));
  const x0 = Math.floor((scene.width - cw) / 2);
  const y0 = Math.floor((scene.height - ch) * 0.6);
  return toPlanes(scene).map((plane) => {
    const crop = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) crop.set(plane.subarray((y0 + y) * scene.width + x0, (y0 + y) * scene.width + x0 + cw), y * cw);
    return resizePlane(crop, cw, ch, w, h);
  });
}

// Small deterministic random numbers (same result every run).
function rand(seed) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

// The cut-out subject as its own layer: RGBA where the colour is the
// subject's own colour even at soft edges (old background removed) and
// alpha is the mask, corrected where the AI mask spills onto the old
// background. Also returns the anchor (bottom centre of the subject) that
// moving and resizing are measured from.
export function cutout(img, mask) {
  const { width: w, height: h } = img;
  const n = w * h;
  const a = alphaOf(img, mask);
  const I = toPlanes(img);

  // B = old background, inside = subject colour just inside the edge.
  // An edge pixel is I = a*F + (1-a)*B.
  const B = backgroundOnly(I, a, w, h, 0.02);
  const solid = new Float32Array(n);
  for (let i = 0; i < n; i++) solid[i] = a[i] > 0.9 ? 1 : 0;
  const inside = fillFrom(I, solid, w, h, 0.01, 1e-4);

  // The AI mask is often a little too wide. Where an edge pixel's colour is
  // plainly the old background's, lower its alpha to match.
  // Only real edge pixels: inside the body, patterned clothes would fool it.
  for (let i = 0; i < n; i++) {
    if (a[i] <= 0.02 || a[i] >= 0.85) continue;
    let dd = 0;
    let dot = 0;
    for (let c = 0; c < 3; c++) {
      const dv = inside[c][i] - B[c][i];
      dd += dv * dv;
      dot += (I[c][i] - B[c][i]) * dv;
    }
    if (dd > 900) a[i] = Math.min(a[i], Math.max(0, dot / dd + 0.1));
  }

  // Solve for F; where alpha is faint that guess is unreliable, so the
  // colour comes from the subject just inside the edge instead.
  const layer = makeImage(w, h);
  const d = layer.data;
  for (let c = 0; c < 3; c++) {
    for (let i = 0, j = c; i < n; i++, j += 4) {
      if (a[i] > 0.98) {
        d[j] = I[c][i];
        continue;
      }
      const solved = Math.min(255, Math.max(0, B[c][i] + (I[c][i] - B[c][i]) / Math.max(a[i], 0.25)));
      const t = Math.min(1, Math.max(0, (a[i] - 0.3) / 0.6));
      d[j] = inside[c][i] + (solved - inside[c][i]) * t * t * (3 - 2 * t);
    }
  }
  let sx = 0;
  let sw = 0;
  let bottom = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = a[y * w + x];
      d[(y * w + x) * 4 + 3] = v * 255;
      sx += x * v;
      sw += v;
      if (v > 0.5) bottom = y;
    }
  }
  return { image: layer, anchor: { x: sw ? sx / sw : w / 2, y: sw ? bottom : h } };
}

// Where a subject pixel lands after moving/resizing: scaled by `scale`
// around the anchor, then shifted by (dx, dy). All in image pixels.
// Returns the layer resampled into the output frame (same size).
function warpLayer(layer, anchor, { scale = 1, dx = 0, dy = 0 } = {}) {
  const { width: w, height: h } = layer;
  const n = w * h;
  let planes = toPlanes(layer);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = layer.data[i * 4 + 3] / 255;
  // Premultiply so edges don't pick up dark fringes when resampled.
  for (const p of planes) for (let i = 0; i < n; i++) p[i] *= alpha[i];
  planes.push(alpha);
  if (scale === 1 && dx === 0 && dy === 0) return planes;
  if (scale < 0.7) planes = planes.map((p) => boxBlur(p, w, h, Math.max(1, Math.round(0.5 / scale - 0.5))));
  const out = planes.map(() => new Float32Array(n));
  for (let y = 0; y < h; y++) {
    const syf = (y - dy - anchor.y) / scale + anchor.y;
    if (syf < 0 || syf > h - 1) continue;
    const y0 = Math.floor(syf);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = syf - y0;
    for (let x = 0; x < w; x++) {
      const sxf = (x - dx - anchor.x) / scale + anchor.x;
      if (sxf < 0 || sxf > w - 1) continue;
      const x0 = Math.floor(sxf);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = sxf - x0;
      const i = y * w + x;
      for (let k = 0; k < planes.length; k++) {
        const p = planes[k];
        const top = p[y0 * w + x0] + (p[y0 * w + x1] - p[y0 * w + x0]) * tx;
        const bot = p[y1 * w + x0] + (p[y1 * w + x1] - p[y1 * w + x0]) * tx;
        out[k][i] = top + (bot - top) * ty;
      }
    }
  }
  return out;
}

// Sun shadow geometry. A point of the subject at height hgt above the
// anchor (its feet) lands on the ground at
//   x + hgt * kx,  anchorY + hgt * ky
// angle: 0 = shadow comes toward you (sun behind the person), 90 = to the
// right, -90 = to the left, 180 = away from you. length: 1 = as long as
// the person is tall (ground is seen at a slant, so it looks shorter).
export function shadowShear({ angle = 0, length = 0.7 } = {}) {
  const t = (angle * Math.PI) / 180;
  const c = Math.cos(t);
  return { kx: length * Math.sin(t), ky: length * 0.5 * (c < 0 ? -1 : 1) * Math.max(Math.abs(c), 0.3) };
}

// The cast shadow (0..1) of a subject alpha. Each part of the subject
// stands on the ground under its own lowest point nearby (so two people at
// different distances each get a shadow from their own feet). Sharp at
// the feet, softer and fainter further away; only on the ground (below
// `ground`, a fraction of the height) when that is known.
function castShadow(a, w, h, light) {
  const f = Math.min(1, 512 / Math.max(w, h));
  const lw = Math.max(1, Math.round(w * f));
  const lh = Math.max(1, Math.round(h * f));
  const al = f < 1 ? resizePlane(a, w, h, lw, lh) : a;
  const { kx, ky } = shadowShear(light);

  // Lowest solid pixel per column, and the subject's height.
  const bottom = new Float32Array(lw).fill(-1);
  let top = lh;
  let low = 0;
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      if (al[y * lw + x] <= 0.5) continue;
      bottom[x] = y;
      if (y < top) top = y;
      if (y > low) low = y;
    }
  }
  const tall = Math.max(4, low - top);
  // Feet: the lowest point within a short distance, so a raised foot or
  // an arm doesn't count as standing on the ground.
  const reach = Math.max(2, Math.round(tall * 0.12));
  const foot = new Float32Array(lw).fill(-1);
  for (let x = 0; x < lw; x++) {
    for (let k = Math.max(0, x - reach); k <= Math.min(lw - 1, x + reach); k++) foot[x] = Math.max(foot[x], bottom[k]);
  }

  // Throw every subject pixel onto the ground (bilinear splat).
  const raw = new Float32Array(lw * lh);
  const dist = new Float32Array(lw * lh);
  const put = (qx, qy, v, d) => {
    if (qx < 0 || qy < 0 || qx >= lw || qy >= lh) return;
    const i = qy * lw + qx;
    if (v > raw[i]) {
      raw[i] = v;
      dist[i] = d;
    }
  };
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const v = al[y * lw + x];
      if (v < 0.05 || foot[x] < 0) continue;
      const hgt = foot[x] - y;
      if (hgt < 0) continue;
      const qx = x + hgt * kx;
      const qy = foot[x] + hgt * ky;
      const x0 = Math.floor(qx);
      const y0 = Math.floor(qy);
      const d = hgt / tall;
      // Fill a little footprint so stretched shadows have no gaps.
      for (let oy = 0; oy <= 1 + Math.ceil(Math.abs(ky)); oy++) {
        for (let ox = 0; ox <= 1 + Math.ceil(Math.abs(kx)); ox++) put(x0 + ox, y0 + oy, v, d);
      }
    }
  }
  const near = gaussianBlur(raw, lw, lh, Math.max(1, lh * 0.004));
  const far = gaussianBlur(raw, lw, lh, Math.max(2, lh * 0.02));
  const distSoft = gaussianBlur(dist, lw, lh, Math.max(2, lh * 0.03));
  const out = new Float32Array(lw * lh);
  const g = light.ground == null ? null : light.ground * lh;
  for (let y = 0, i = 0; y < lh; y++) {
    const onGround = g === null ? 1 : Math.min(1, Math.max(0, (y - g) / (lh * 0.03) + 0.5));
    for (let x = 0; x < lw; x++, i++) {
      const t = Math.min(1, distSoft[i]);
      out[i] = (near[i] + (far[i] - near[i]) * t) * (1 - 0.4 * t) * onGround;
    }
  }
  return f < 1 ? resizePlane(out, lw, lh, w, h) : out;
}

// Put the subject into a scene so it looks like it belongs there:
// 1. cut-out with clean edges (see cutout; pass one in to save time),
// 2. moved/resized as asked (transform: { scale, dx, dy }),
// 3. colour and brightness matched a little toward the scene,
// 4. "light wrap": the scene's light spills softly over the edges,
// 5. soft contact shadow around and below the subject,
// 6. the scene gets the same photo grain (noise) as the subject,
// 7. optional sun (light: { angle, length, strength, ground }): a cast
//    shadow on the ground, the sunny side of the person a little brighter
//    and, with the sun behind them, a rim of light on their edges.
export function placeOnScene(img, mask, scene, { cut, transform, light } = {}) {
  const { width: w, height: h } = img;
  const n = w * h;
  const S = coverScene(scene, w, h);
  const { image: layer, anchor } = cut || cutout(img, mask);
  const warped = warpLayer(layer, anchor, transform);
  const a = warped[3];
  // Back from premultiplied colour.
  const F = warped.slice(0, 3).map((p) => p.map((v, i) => (a[i] > 1e-3 ? v / a[i] : 0)));

  // 3. Colour and brightness: move part of the way toward the scene.
  const mean = (planes, weight) => {
    const m = [0, 0, 0];
    let sw = 0;
    for (let i = 0; i < n; i += 7) {
      const wi = weight ? weight[i] : 1;
      sw += wi;
      for (let c = 0; c < 3; c++) m[c] += planes[c][i] * wi;
    }
    return m.map((v) => v / Math.max(sw, 1e-6));
  };
  const lum = (m) => 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
  const fm = mean(F, a);
  const sm = mean(S);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const gainL = clamp(Math.pow(lum(sm) / Math.max(lum(fm), 1), 0.25), 0.85, 1.2);
  const gains = [0, 1, 2].map((c) => {
    const tint = sm[c] / Math.max(lum(sm), 1) / (fm[c] / Math.max(lum(fm), 1) || 1);
    return gainL * clamp(Math.pow(tint, 0.3), 0.92, 1.08);
  });

  // 4. Light wrap: blurred scene light on the subject's outer edge.
  const aSoft = softBlur(a, w, h, 0.012);
  const wrap = S.map((plane) => softBlur(plane, w, h, 0.012));

  // 5. Contact shadow: a soft, slightly lowered copy of the subject.
  const shift = Math.round(h * 0.012);
  const lowered = new Float32Array(n);
  lowered.set(a.subarray(0, n - shift * w), shift * w);
  const shadow = softBlur(lowered, w, h, 0.025);

  // 7. Sun: cast shadow plus light on the person.
  let sun = null;
  if (light) {
    const strength = light.strength ?? 0.55;
    const t = ((light.angle ?? 0) * Math.PI) / 180;
    // Sunlight colour: the scene's brightest 2 % (sky, sun, highlights).
    const lumS = new Float32Array(n);
    for (let i = 0; i < n; i++) lumS[i] = 0.299 * S[0][i] + 0.587 * S[1][i] + 0.114 * S[2][i];
    const sample = [];
    for (let i = 0; i < n; i += 11) sample.push(lumS[i]);
    sample.sort((x, y) => x - y);
    const bright = sample[Math.floor(sample.length * 0.98)];
    const hl = [0, 0, 0];
    let cnt = 0;
    for (let i = 0; i < n; i += 11) {
      if (lumS[i] < bright) continue;
      for (let c = 0; c < 3; c++) hl[c] += S[c][i];
      cnt++;
    }
    // Where the person is, to know their sunny side.
    let x0 = w;
    let x1 = 0;
    for (let i = 0; i < n; i += 3) {
      if (a[i] < 0.5) continue;
      const x = i % w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
    sun = {
      strength,
      cast: castShadow(a, w, h, light),
      sunX: -Math.sin(t), // +1: sun on the right
      back: Math.cos(t), // +1: sun behind the person
      cx: (x0 + x1) / 2,
      half: Math.max(1, (x1 - x0) / 2),
      highlight: hl.map((v) => Math.min(255, (v / Math.max(cnt, 1)) * 1.05)),
    };
  }

  // 6. Grain: the photo's sensor noise, measured on both the old
  //    background and the subject; the smaller one is the noise (the
  //    other also contains texture such as skin or foliage).
  const L = luminance(img);
  const Lb = boxBlur(L, w, h, 1);
  const original = alphaOf(img, mask);
  const median = (keep) => {
    const v = [];
    for (let i = 0; i < n; i += 13) if (keep(original[i])) v.push(Math.abs(L[i] - Lb[i]));
    v.sort((x, y) => x - y);
    return v.length > 50 ? v[v.length >> 1] : Infinity;
  };
  const noise = Math.min(median((v) => v < 0.05), median((v) => v > 0.95));
  const grain = Number.isFinite(noise) ? Math.min(5, 1.25 * noise) : 0;
  const random = rand(12345);

  const out = makeImage(w, h);
  const d = out.data;
  // Shadows are a little blue (lit by the sky), so blue drops least.
  const shadeTint = [1, 0.96, 0.86];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const ai = a[i];
    const edge = ai * (1 - aSoft[i]); // inside the subject, near its edge
    const dark = 1 - 0.35 * shadow[i] * (1 - ai);
    const g = grain ? (random() + random() + random() - 1.5) * grain * 1.4 : 0;
    let gain = 1;
    let rim = 0;
    if (sun) {
      const side = Math.max(-1, Math.min(1, ((i % w) - sun.cx) / sun.half)) * sun.sunX; // +1: facing the sun
      gain = 1 + sun.strength * (0.12 * side - 0.1 * Math.max(sun.back, 0) + 0.06 * Math.max(-sun.back, 0));
      rim = sun.strength * edge * Math.max(0, sun.back) * (0.6 + 0.4 * side) * 0.9;
    }
    for (let c = 0; c < 3; c++) {
      let f = F[c][i] * gains[c] * gain;
      f += 0.6 * edge * (wrap[c][i] - f);
      if (rim) f += rim * (sun.highlight[c] - f);
      let b = S[c][i] * dark + g;
      if (sun) b *= 1 - sun.strength * 0.8 * sun.cast[i] * shadeTint[c];
      d[j + c] = f * ai + b * (1 - ai);
    }
    d[j + 3] = 255;
  }
  return out;
}

// ---------- text ----------

// Catmull-Rom 2x enlargement of a plane (smoother letter edges than bilinear).
export function upscale2x(src, w, h) {
  const cr = (t) => [(-t * t * t + 2 * t * t - t) / 2, (3 * t * t * t - 5 * t * t + 2) / 2, (-3 * t * t * t + 4 * t * t + t) / 2, (t * t * t - t * t) / 2];
  const even = cr(0.75); // output 2i   sits at source i - 0.25
  const odd = cr(0.25); //  output 2i+1 sits at source i + 0.25
  const W = 2 * w;
  const H = 2 * h;
  const rows = new Float32Array(W * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    const at = (x) => src[r + Math.min(w - 1, Math.max(0, x))];
    for (let i = 0; i < w; i++) {
      rows[y * W + 2 * i] = even[0] * at(i - 2) + even[1] * at(i - 1) + even[2] * at(i) + even[3] * at(i + 1);
      rows[y * W + 2 * i + 1] = odd[0] * at(i - 1) + odd[1] * at(i) + odd[2] * at(i + 1) + odd[3] * at(i + 2);
    }
  }
  const out = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    const at = (y) => rows[Math.min(h - 1, Math.max(0, y)) * W + x];
    for (let i = 0; i < h; i++) {
      out[2 * i * W + x] = even[0] * at(i - 2) + even[1] * at(i - 1) + even[2] * at(i) + even[3] * at(i + 1);
      out[(2 * i + 1) * W + x] = odd[0] * at(i - 1) + odd[1] * at(i) + odd[2] * at(i + 1) + odd[3] * at(i + 2);
    }
  }
  return out;
}

// Brightest value in each block: for dark text on paper that's the paper.
function maxPool(src, w, h, block) {
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const out = new Float32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const by = Math.floor(y / block) * bw;
    for (let x = 0; x < w; x++) {
      const i = by + Math.floor(x / block);
      if (src[y * w + x] > out[i]) out[i] = src[y * w + x];
    }
  }
  return { plane: out, w: bw, h: bh };
}

// Value below which the given fraction of pixels lie (plane values 0..1).
function planePercentile(plane, p) {
  const hist = new Uint32Array(1024);
  for (const v of plane) hist[Math.min(1023, Math.max(0, Math.round(v * 1023)))]++;
  const target = plane.length * p;
  let acc = 0;
  for (let v = 0; v < 1024; v++) {
    acc += hist[v];
    if (acc >= target) return v / 1023;
  }
  return 1;
}

// Richardson-Lucy deconvolution with a Gaussian blur: undoes blur instead
// of just boosting edges. Works on a plane where the ink is bright.
export function deblur(plane, w, h, sigma, iterations) {
  let est = Float32Array.from(plane);
  const ratio = new Float32Array(plane.length);
  for (let k = 0; k < iterations; k++) {
    const blurred = gaussianBlur(est, w, h, sigma);
    for (let i = 0; i < ratio.length; i++) ratio[i] = plane[i] / Math.max(blurred[i], 1e-3);
    const corr = gaussianBlur(ratio, w, h, sigma);
    for (let i = 0; i < est.length; i++) est[i] = Math.min(1.5, est[i] * corr[i]);
  }
  return est;
}

// Make text in a blurry, zoomed photo readable: even out the lighting so
// the paper turns white, deblur, boost contrast. Small photos come back
// 2x larger (smoother letters).
// mode: 'color' keeps coloured ink, 'bw' gives crisp black and white.
// Light text on a dark background (signs) is detected and handled too.
// strength: 0..1, more strength assumes a blurrier photo.
export function enhanceText(img, { mode = 'color', strength = 0.5 } = {}) {
  const outW = Math.max(img.width, img.height) <= 1024 ? img.width * 2 : img.width;
  const outH = outW === img.width ? img.height : img.height * 2;

  // The heavy work runs at up to ~1400 px: big photos at half size (blurry
  // text loses nothing), and the result is enlarged smoothly at the end.
  const half = Math.max(img.width, img.height) > 1400;
  const w = half ? Math.ceil(img.width / 2) : img.width;
  const h = half ? Math.ceil(img.height / 2) : img.height;
  const n = w * h;
  const planes = toPlanes(img).map((p) => {
    for (let i = 0; i < p.length; i++) p[i] /= 255;
    return half ? resizePlane(p, img.width, img.height, w, h) : p;
  });
  const side = Math.max(w, h);
  let L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * planes[0][i] + 0.587 * planes[1][i] + 0.114 * planes[2][i];

  // Light text on dark: flip, process as dark-on-light, flip back.
  const inverted = planePercentile(L, 0.5) < 0.45;
  if (inverted) for (let i = 0; i < n; i++) L[i] = 1 - L[i];

  // 1. Paper estimate (brightest per block, smoothed): divide it out so
  //    uneven light and tinted paper become plain white.
  const block = Math.max(4, Math.round(side / 40));
  const flatten = (p) => {
    const pooled = maxPool(p, w, h, block);
    const paper = resizePlane(gaussianBlur(pooled.plane, pooled.w, pooled.h, 1), pooled.w, pooled.h, w, h);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.min(1, p[i] / Math.max(paper[i], 0.04));
    return out;
  };
  let q = flatten(L);

  // 2. Calm noise, then deblur the ink.
  const base = Math.max(0.5, side / 1000);
  q = gaussianBlur(q, w, h, base * 0.8);
  const ink = new Float32Array(n);
  for (let i = 0; i < n; i++) ink[i] = 1.02 - q[i];
  const sharp = deblur(ink, w, h, base * (1.6 + 4.8 * strength), 12);
  for (let i = 0; i < n; i++) q[i] = 1 - Math.min(1, sharp[i]);

  // 3. Ink -> black, paper -> white.
  const black = planePercentile(q, 0.01);
  const white = Math.max(black + 0.1, Math.min(0.97, planePercentile(q, 0.6)));
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, (q[i] - black) / (white - black)));

  // Colour: the photo's smoothed colour differences, added back at the end
  // so red ink stays red while noise and JPEG blocks don't come back.
  let tint = null;
  if (mode === 'color' && !inverted) {
    const sigma = base * 4;
    const Ls = gaussianBlur(flatten(L), w, h, sigma);
    tint = planes.map((pc) => {
      const cs = gaussianBlur(flatten(pc), w, h, sigma);
      for (let i = 0; i < n; i++) cs[i] -= Ls[i];
      return resizePlane(cs, w, h, outW, outH);
    });
  }

  // 4. Back to full size with smooth (bicubic) edges.
  if (outW !== w) q = cropPlane(upscale2x(q, w, h), 2 * w, outW, outH);
  const m = outW * outH;

  // 5. Black and white: soft threshold, so letters keep smooth edges.
  //    Colour: light grey speckles left by the deblur go to white.
  if (mode === 'bw') {
    const soft = 0.12;
    for (let i = 0; i < m; i++) {
      const t = Math.min(1, Math.max(0, (q[i] - 0.5 + soft) / (2 * soft)));
      q[i] = t * t * (3 - 2 * t);
    }
  } else {
    for (let i = 0; i < m; i++) q[i] = Math.min(1, Math.max(0, q[i] / 0.8));
  }
  if (inverted) for (let i = 0; i < m; i++) q[i] = 1 - q[i];

  const res = makeImage(outW, outH);
  const d = res.data;
  for (let i = 0, j = 0; i < m; i++, j += 4) {
    const v = q[i] * 255;
    if (tint) {
      d[j] = v + tint[0][i] * 255;
      d[j + 1] = v + tint[1][i] * 255;
      d[j + 2] = v + tint[2][i] * 255;
    } else {
      d[j] = d[j + 1] = d[j + 2] = v;
    }
    d[j + 3] = 255;
  }
  return res;
}

// Top-left w x h part of a plane that is srcW wide.
function cropPlane(src, srcW, w, h) {
  if (srcW === w && src.length === w * h) return src;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) out.set(src.subarray(y * srcW, y * srcW + w), y * w);
  return out;
}
