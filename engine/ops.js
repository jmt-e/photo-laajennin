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

// Turn the model's small output into a full-size mask whose edges follow
// the photo (guided filter, He et al. 2010).
export function refineMask(pred, size, img) {
  const { width: w, height: h } = img;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pred) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
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
  const p = resizePlane(norm, size, size, lw, lh);

  // Window about two model pixels wide, so it spans the blurry upscaled edge.
  const r = Math.max(2, Math.round((2 * Math.max(lw, lh)) / size));
  const eps = 1e-3;
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
    const t = Math.min(1, Math.max(0, (q - 0.1) / 0.8));
    mask[i] = Math.round(t * 255);
  }
  return mask;
}

// Put the cut-out subject on a new background.
// background: { type: 'transparent' } | { type: 'color', color: '#rrggbb' }
//           | { type: 'blur' }
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

  let bg;
  if (type === 'color') {
    const hex = background.color.replace('#', '');
    const rgb = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
    bg = (c) => rgb[c];
  } else if (type === 'blur') {
    // A blurred background doesn't need full resolution: blur at up to
    // 512 px (fast, little memory) and scale back up.
    const f = Math.min(1, 512 / Math.max(w, h));
    const lw = Math.max(1, Math.round(w * f));
    const lh = Math.max(1, Math.round(h * f));
    const sigma = Math.max(lw, lh) * 0.012;
    // Blur only the background (weighted by 1 - mask), so the subject's
    // colours don't smear into a halo around it.
    const weightFull = new Float32Array(w * h);
    for (let i = 0; i < weightFull.length; i++) weightFull[i] = 1 - mask[i] / 255;
    const weight = resizePlane(weightFull, w, h, lw, lh);
    const wBlur = gaussianBlur(weight, lw, lh, sigma);
    const planes = toPlanes(img).map((plane) => {
      const small = resizePlane(plane, w, h, lw, lh);
      const weighted = new Float32Array(small.length);
      for (let i = 0; i < small.length; i++) weighted[i] = small[i] * weight[i];
      const wb = gaussianBlur(weighted, lw, lh, sigma);
      const plain = gaussianBlur(small, lw, lh, sigma);
      for (let i = 0; i < wb.length; i++) {
        wb[i] = wBlur[i] > 0.02 ? wb[i] / wBlur[i] : plain[i];
      }
      return resizePlane(wb, lw, lh, w, h);
    });
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
