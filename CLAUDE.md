# Photo Enhancer: notes for Claude

A private photo enhancer for iPhone, built as a PWA. We start with a very
simple proof of concept and improve it step by step.

## Why

The owner wants to enhance photos without sending them to any cloud
service. Everything runs on the phone (later also on their own PC).

## Hard rules (never break these)

- **Photos never leave the phone.** No uploads, analytics, trackers, or
  third-party scripts or fonts.
- **Every file is hosted in this repo**, AI model files included. Nothing is
  loaded from a CDN.
- The Content-Security-Policy in `index.html` blocks connections to other
  servers (`connect-src 'self'`). Keep it. Inline `style="..."` attributes
  and inline scripts are blocked by it too; set styles from JS or CSS files.
- **Plain HTML, CSS and JavaScript, no build step.** It must run on GitHub
  Pages exactly as committed. Libraries are fine if their files are copied
  into the repo (`vendor/`).
- Every file must stay under GitHub's 100 MB per-file limit
  (`tests/files.test.mjs` checks this).

## Working with the owner

- iPhone only, no computer. They can't run commands, so test before
  handing over.
- Keep explanations short and simple. Give tap-by-tap steps for anything
  they need to do.
- Ask when something is unclear.

## Hosting

GitHub Pages, from the `main` branch, root folder. `.nojekyll` makes Pages
serve files as they are. The site URL is
`https://jmt-e.github.io/photo-laajennin/` (repo `jmt-e/photo-laajennin`), so all paths in the app are
relative.

The repo is public because free GitHub Pages needs that (photos are never
in the repo, only code). The owner may later switch to a private repo hosted
on Netlify, like their other project Vahti. The app needs no build, so
Netlify would just publish the repo root.

GitHub Pages can't set HTTP headers, so the CSP is a `<meta>` tag. That tag
covers the page itself; the Web Worker gets its own policy from headers,
which Pages doesn't send. The worker only runs our own code, so this is
acceptable, but don't add network code to it.

## How it's built

```
index.html             page, CSP, iPhone home-screen tags
style.css              mobile-first, dark mode via prefers-color-scheme
app.js                 UI: history (Undo/Reset), panels, compare, save
engine/engine.js       THE engine API. The app only talks to this.
engine/worker.js       runs engine jobs in a Web Worker, loads the AI model
engine/ops.js          pure pixel functions (no DOM): sharpen, auto-enhance,
                       text clean-up, resize, mask refinement, backgrounds
sw.js                  service worker: offline cache
manifest.webmanifest   PWA manifest
icons/                 app icons (generated, simple sparkle)
models/u2netp.onnx     background-removal model (4.6 MB, Apache-2.0)
vendor/onnxruntime-web ONNX Runtime Web 1.30.0 (MIT), wasm-only build
tests/                 node tests + Playwright browser test (dev only)
```

### Engine

`engine/engine.js` exports `engine` with `sharpen`, `autoEnhance`,
`enhanceText`, `segment` (AI mask), `composite` (new background) and
`isModelCached`.
Images are plain `{ width, height, data }` RGBA objects. Today each call is
a message to `engine/worker.js`. In phase 3 a second transport can send the
same calls to the PC instead; the app shouldn't need to change. Keep all
pixel work behind this module.

### Photos

- Loaded with `<img>` + canvas (Safari applies EXIF rotation), shrunk to
  max 2048 px on the long side in halving steps.
- History keeps up to 10 steps (~12 MB each at 2048²). Reset is a step
  itself, so it can be undone. The original is kept separately for Compare
  and Reset.
- Tools with settings (Sharpen, Background) show a live preview in a
  bottom panel; Apply commits it, Cancel drops it.

### Text tool (readable text from blurry, zoomed photos)

Owner's use case: a photo of text taken with big zoom, too blurry to read.
`ops.enhanceText`, no AI, all classic image processing:
1. Light text on a dark background is detected (median brightness) and
   flipped, so everything below works on dark ink on light paper.
2. Paper estimate (brightest value per block, smoothed) is divided out:
   uneven light and tinted paper become plain white.
3. Light denoise, then Richardson-Lucy deconvolution (`ops.deblur`,
   Gaussian blur model, 12 rounds) to undo the blur. The slider ("How
   blurry is it?") sets the assumed blur size. Too high on a sharp photo
   makes thin strokes break up.
4. Contrast stretch (1st percentile = black, 60th = white).
5. Black & white: soft threshold. Colour: the photo's smoothed colour
   differences are added back, so coloured ink keeps its colour.

Speed: big photos are processed at half size and enlarged with bicubic
before the threshold (blurry text loses nothing, ~4x faster; under 1 s for
2048 px in desktop Chromium). Photos up to 1024 px come back 2x larger.
The slider updates on release, not while dragging. Tested on synthetic
zoomed-text images and a real book page; an AI text model could do better
on extreme blur later (see roadmap).

### Background removal

- Model: **U²-Netp** (`u2netp.onnx`, from rembg's GitHub release, original
  by Xuebin Qin, Apache-2.0: OK for personal use and public hosting).
  Input 320×320, ImageNet normalisation, first output is the mask.
- The 320 px mask is upscaled and refined with a guided filter so edges
  follow the photo (`ops.refineMask`).
- Backgrounds: transparent, solid colour, or a blur of the original
  (blur excludes the subject to avoid a halo). The mask is cached per image,
  so switching backgrounds doesn't re-run the AI.
- The model and the ONNX Runtime wasm (~19 MB together) are downloaded the
  first time with a progress bar, then kept in Cache Storage (`ai-v1`) by
  the worker, so it works offline. Their byte sizes are hard-coded in
  `worker.js` for the progress bar; a test checks they match.
- Single-threaded wasm (Pages can't send the COOP/COEP headers threads need).
- Models compared on test images (October 2026): `isnet-general-use`
  (178 MB, fixed 1024 input; quantised uint8 is 46 MB) gives sharper edges
  but is ~10× slower and risky for iPhone memory. `silueta` was no better
  than u2netp. BiRefNet is too big. Revisit if quality isn't enough.

### Saving

The export file (JPEG 92 %, or PNG if anything is transparent) is built in
the background after every change, because iOS only opens the share sheet
when `navigator.share` is called straight from the tap. If sharing files
isn't possible, a sheet shows the image so it can be saved with a long
press.

### Offline / updates

`sw.js` caches the app files on install (cache-first). **Bump `VERSION` in
`sw.js` whenever any cached file changes**, or phones keep the old copy.
The new version takes over on the next app launch.

## Testing

```
node --test tests/*.test.mjs                 # pixel ops + hosting rules
node tests/e2e.mjs <photo.jpg> [shots-dir]   # full app in Chromium at iPhone size
node tests/serve.mjs 8080                    # serve locally
```

`e2e.mjs` needs Playwright (preinstalled in Claude's cloud container). It
opens a photo, runs every tool, checks Undo/Reset, Compare, the save
fallback, offline mode, and that no request goes to another server.
Chromium isn't Safari: things like the share sheet, HEIC and memory limits
can only be checked on the iPhone.

## Roadmap

Done: **Proof of concept** (pick photo, shrink to 2048 px, sharpen slider,
auto-enhance, AI background removal with transparent/colour/blur
backgrounds, Undo/Reset, before/after slider, save via share sheet,
offline PWA, engine module).

Done: **Text tool** for blurry zoomed photos of text (colour or black &
white, blur-size slider).

Next, on the phone:
- Crop and rotate
- Filters
- Light 2× upscaling
- Noise removal
- Pinch to zoom the result in the app (useful for reading text)
- Text: crop to just the text first; maybe an AI model for extreme blur

Phase 2: a Python program on the owner's Windows PC for heavy AI work:
- rembg for better background removal
- Real-ESRGAN for big upscaling
- Face fixing
- Erasing objects
- Many photos at once

Phase 3: phone and PC connect privately via Tailscale. `tailscale serve`
gives the PC an https address. The app's engine gets a "remote" transport
that sends jobs to that address; the CSP `connect-src` then needs that one
address added, and nothing else.
