# Photo Enhancer

Enhance photos on your iPhone without sending them anywhere. Everything
happens on the phone, including the AI. Works offline once installed.

- Auto-enhance: one tap fixes brightness, contrast and colour
- Sharpen with a strength slider
- Text: makes blurry, zoomed photos of text readable (colour or black &
  white)
- Remove the background (AI on the phone), then choose transparent, a
  colour, a blurred background, or a new scene (beach, basketball court,
  soccer stadium, scenery, or any photo of your own), fitted in smoothly
- Undo, Reset, before/after slider
- Save to Photos through the share sheet

## Install on iPhone

1. Open https://jmt-e.github.io/photo-laajennin/ in Safari.
2. Tap the Share button, then **Add to Home Screen**.

## Privacy

No uploads, no analytics, no third-party files. A Content-Security-Policy
stops the page from contacting any other server.

## Credits

The built-in scene backgrounds are drawn by `tools/make_backgrounds.py`.

- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT)
- [U²-Net](https://github.com/xuebinqin/U-2-Net) model `u2netp` (Apache-2.0),
  ONNX file from [rembg](https://github.com/danielgatis/rembg)

Developer notes are in `CLAUDE.md`.
