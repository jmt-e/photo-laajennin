"""Draws the built-in scene backgrounds (backgrounds/*.jpg).

Everything is generated here, so there are no licence questions. Scenes are
slightly out of focus on purpose, like a phone's portrait mode, which also
makes them look more like photos.

Dev tool only (needs numpy, scipy, pillow):
    python tools/make_backgrounds.py backgrounds
"""
import sys
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, map_coordinates

S = 2048  # square, so the app can crop it to portrait or landscape
rng = np.random.default_rng(7)
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32) / S


def noise(scale, octaves=5, seed=0, shape=(S, S)):
    """Smooth fractal noise in 0..1."""
    r = np.random.default_rng(seed)
    out = np.zeros(shape, np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cells = max(2, int(scale * 2 ** o))
        g = r.random((cells + 3, cells + 3)).astype(np.float32)
        ys = np.linspace(1, cells + 1, shape[0])
        xs = np.linspace(1, cells + 1, shape[1])
        Y, X = np.meshgrid(ys, xs, indexing='ij')
        out += amp * map_coordinates(g, [Y, X], order=3, mode='reflect')
        total += amp
        amp *= 0.5
    out /= total
    return (out - out.min()) / (out.max() - out.min() + 1e-6)


def mix(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return a * (1 - t) + b * t


def col(*rgb):
    return np.array(rgb, np.float32) / 255


def vgrad(top, bottom, y0, y1):
    t = np.clip((yy - y0) / (y1 - y0), 0, 1)
    return mix(np.broadcast_to(top, (S, S, 3)), np.broadcast_to(bottom, (S, S, 3)), t)


def finish(img, blur, name, out):
    img = np.clip(img, 0, 1)
    img = np.stack([gaussian_filter(img[..., c], blur) for c in range(3)], -1)
    im = Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))
    im.save(f'{out}/{name}.jpg', quality=84, optimize=True, progressive=True)
    im.resize((192, 192), Image.LANCZOS).save(f'{out}/{name}-thumb.jpg', quality=80, optimize=True)


def sky(horizon, top, low, clouds=0.5, seed=1):
    img = vgrad(top, low, 0, horizon)
    c = noise(3, 6, seed)
    c = np.clip((c - (1 - clouds)) / 0.25, 0, 1) * np.clip(1.2 - yy / horizon, 0, 1)
    shade = 1 - 0.18 * noise(6, 4, seed + 1)
    return mix(img, np.stack([shade] * 3, -1), c * 0.85)


def floor_coords(horizon, f=0.9):
    """World (x, z) for each pixel below the horizon, camera at height 1."""
    dy = np.maximum(yy - horizon, 1e-3)
    z = f / dy
    x = (xx - 0.5) * z / f
    return x, z


def beach(out):
    H = 0.47
    img = sky(H, col(40, 110, 200), col(185, 220, 240), clouds=0.42, seed=3)
    # sun glow
    d = np.hypot(xx - 0.78, yy - 0.12)
    img += np.exp(-d * 9)[..., None] * col(255, 240, 200) * 0.55
    # sea: deep at the horizon, turquoise near the shore, with wave streaks
    shore = 0.63 + 0.015 * np.sin(xx * 9) + 0.01 * (noise(4, 3, 5) - 0.5)
    t = np.clip((yy - H) / (shore - H), 0, 1)
    sea = mix(np.broadcast_to(col(25, 80, 140), (S, S, 3)), np.broadcast_to(col(40, 185, 190), (S, S, 3)), t ** 1.5)
    waves = noise(1, 5, 9, shape=(S, S))
    streak = gaussian_filter(rng.random((S, S)).astype(np.float32), (0.6, 18))
    streak = (streak - streak.mean()) / streak.std()
    sea *= (1 + 0.05 * streak * (0.3 + t))[..., None]
    sea += (np.clip(streak - 1.6, 0, 1) * (0.4 + t))[..., None] * 0.25
    sea += (np.exp(-np.abs(xx - 0.78) * 12) * (1 - t) * 0.25 * (waves > 0.45))[..., None]
    foam = np.exp(-np.abs(yy - shore) * 160) * (0.6 + 0.4 * noise(20, 3, 11))
    is_sea = (yy >= H) & (yy < shore)
    img = np.where(is_sea[..., None], sea, img)
    # sand
    sand = vgrad(col(222, 200, 160), col(238, 214, 170), 0.6, 1.0)
    grain = noise(60, 3, 13) - 0.5
    ripple = np.sin((yy * 140 + 6 * noise(3, 3, 14)) ) * 0.02
    wet = np.exp(-np.clip(yy - shore, 0, 1) * 30)
    sand = sand * (1 + 0.08 * grain + ripple)[..., None] * (1 - 0.18 * wet)[..., None]
    img = np.where((yy >= shore)[..., None], sand, img)
    img = mix(img, np.ones_like(img), foam * (yy > H))
    # horizon haze
    img = mix(img, np.broadcast_to(col(210, 230, 240), (S, S, 3)), np.exp(-np.abs(yy - H) * 120) * 0.6)
    # a palm leaning in from the left
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    pts = [(int(S * (0.02 + 0.12 * (1 - t) ** 2)), int(S * (0.95 - 0.7 * t))) for t in np.linspace(0, 1, 30)]
    for i in range(len(pts) - 1):
        d.line([pts[i], pts[i + 1]], fill=(95, 70, 45), width=int(38 - 18 * i / 30))
    top = pts[-1]
    for a in np.linspace(-2.6, 0.9, 9):
        L = S * (0.16 + 0.05 * rng.random())
        frond = [(top[0] + L * s * np.cos(a), top[1] + L * s * np.sin(a) + 0.35 * L * s * s) for s in np.linspace(0, 1, 20)]
        for i in range(len(frond) - 1):
            d.line([frond[i], frond[i + 1]], fill=(30, 85, 40), width=int(26 * (1 - i / 20)) + 3)
    img = np.asarray(im, np.float32) / 255
    finish(img, 4, 'beach', out)


def court(out):
    H = 0.42
    # back wall with soft panels and arena lights
    wall = vgrad(col(35, 45, 70), col(70, 80, 105), 0, H)
    panels = 0.04 * np.sign(np.sin(xx * 40))
    img = wall * (1 + panels)[..., None]
    for lx in (0.12, 0.37, 0.63, 0.88):
        g = np.exp(-np.hypot((xx - lx) * 3, (yy - 0.05) * 6) * 6)
        img += g[..., None] * col(255, 245, 220) * 0.9
    # crowd-free bleacher band
    band = (yy > H - 0.12) & (yy < H)
    seats = 0.85 + 0.15 * np.sign(np.sin(yy * 420))
    img = np.where(band[..., None], col(120, 30, 35) * seats[..., None] * vgrad(col(120, 120, 120), col(200, 200, 200), H - 0.12, H) / 0.6, img)
    # wooden floor in perspective
    X, Z = floor_coords(H)
    plank = np.floor(X * 14)
    pr = np.random.default_rng(3).random(4096).astype(np.float32)
    tone = pr[(plank.astype(int) % 4096)]
    grain = noise(2, 4, 21)
    wood = col(200, 140, 85) * (0.85 + 0.15 * tone[..., None]) * (0.92 + 0.12 * grain[..., None])
    seam = (np.abs(X * 14 - np.round(X * 14)) < 0.03 / np.maximum(Z, 0.3))
    wood *= (1 - 0.15 * seam)[..., None]
    # the key ("paint") and lines; hoop is at z=6 ahead
    zb = 6.0
    key = (np.abs(X) < 0.9) & (Z > zb - 2.9) & (Z < zb)
    wood = np.where(key[..., None], wood * col(200, 80, 70) / 0.75, wood)
    lw = 0.03
    lines = (np.abs(np.abs(X) - 0.9) < lw) & (Z > zb - 2.9) & (Z < zb)
    lines |= (np.abs(Z - (zb - 2.9)) < lw * 1.5) & (np.abs(X) < 0.9)
    r = np.hypot(X, Z - (zb - 2.9))
    lines |= (np.abs(r - 0.9) < lw) & (Z < zb - 2.9)
    r3 = np.hypot(X, Z - (zb - 0.6))
    lines |= (np.abs(r3 - 3.4) < lw) & (Z < zb - 0.6)
    lines |= np.abs(Z - zb) < lw * 1.5
    wood = mix(wood, np.ones_like(wood) * 0.95, lines)
    # glossy reflections of the lights
    for lx in (0.12, 0.37, 0.63, 0.88):
        refl = np.exp(-np.abs(xx - lx) * 40) * np.exp(-(yy - H) * 3)
        wood += refl[..., None] * 0.35
    fog = np.clip(1 - (yy - H) * 6, 0, 1) * 0.25
    wood = mix(wood, np.broadcast_to(col(90, 90, 110), (S, S, 3)), fog)
    img = np.where((yy >= H)[..., None], wood, img)
    # backboard, rim, net, support
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    cx = S // 2
    d.rectangle([cx - 30, int(S * 0.23), cx + 30, int(S * (H + 0.012))], fill=(40, 40, 45))
    bb = [cx - 230, int(S * 0.15), cx + 230, int(S * 0.29)]
    d.rectangle(bb, fill=(235, 238, 240), outline=(30, 30, 30), width=10)
    d.rectangle([cx - 85, int(S * 0.215), cx + 85, int(S * 0.285)], outline=(200, 60, 40), width=9)
    rim_y = int(S * 0.29)
    d.ellipse([cx - 95, rim_y - 14, cx + 95, rim_y + 22], outline=(230, 90, 30), width=11)
    for k in range(-4, 5):
        d.line([(cx + 22 * k, rim_y + 10), (cx + 13 * k, rim_y + 120)], fill=(240, 240, 240), width=4)
    for j in range(1, 5):
        y = rim_y + 10 + 27 * j
        w = 95 - 8 * j
        d.line([(cx - w, y), (cx + w, y)], fill=(225, 225, 225), width=3)
    img = np.asarray(im, np.float32) / 255
    finish(img, 3.5, 'basketball-court', out)


def stadium(out):
    H = 0.5
    img = sky(0.3, col(25, 50, 110), col(120, 150, 200), clouds=0.3, seed=31)
    # roof edge and floodlights
    img = np.where((yy < 0.07)[..., None], col(30, 32, 38), img)
    for lx in (0.08, 0.36, 0.64, 0.92):
        g = np.exp(-np.hypot((xx - lx) * 2.5, (yy - 0.08) * 4) * 9)
        img += g[..., None] * col(255, 250, 230) * 1.2
    # stands full of people: colourful dots, darker further up
    st = (yy >= 0.07) & (yy < H - 0.04)
    cells = rng.random((S // 6 + 1, S // 6 + 1, 3)).astype(np.float32)
    palette = np.array([col(200, 40, 40), col(240, 240, 240), col(30, 60, 160), col(240, 200, 40), col(40, 40, 50), col(180, 120, 90)])
    pick = (cells[..., 0] * len(palette)).astype(int)
    crowd = palette[pick]
    crowd = np.repeat(np.repeat(crowd, 6, 0), 6, 1)[:S, :S]
    tiers = 0.75 + 0.25 * (np.sin(yy * 260) > -0.6)
    shade = (0.55 + 0.45 * (yy - 0.07) / (H - 0.11))
    crowd = crowd * (tiers * shade)[..., None]
    crowd = mix(crowd, np.broadcast_to(col(40, 45, 60), (S, S, 3)), 0.35)
    img = np.where(st[..., None], crowd, img)
    # advertising boards (plain colour blocks, no text)
    ab = (yy >= H - 0.04) & (yy < H)
    blocks = np.floor(xx * 7) % 3
    boards = np.array([col(20, 90, 170), col(220, 220, 225), col(200, 40, 50)])[blocks.astype(int)]
    img = np.where(ab[..., None], boards, img)
    # pitch in perspective with mowing stripes and lines
    X, Z = floor_coords(H, 0.8)
    stripe = (np.floor(Z * 1.4) % 2)
    grass = col(55, 135, 55) * (0.88 + 0.12 * stripe[..., None]) * (0.93 + 0.1 * noise(30, 3, 41)[..., None])
    lw = 0.035
    lines = np.abs(Z - 7.5) < lw * 1.2  # halfway line
    lines |= (np.abs(np.hypot(X, Z - 7.5) - 2.2) < lw)
    lines |= np.abs(np.abs(X) - 9) < lw
    grass = mix(grass, np.ones_like(grass) * 0.93, lines)
    grass = mix(grass, np.broadcast_to(col(150, 170, 160), (S, S, 3)), np.clip(1 - (yy - H) * 8, 0, 1) * 0.25)
    img = np.where((yy >= H)[..., None], grass, img)
    finish(img, 4.5, 'soccer-stadium', out)


def ridge(seed, base, rough, n=S):
    r = np.random.default_rng(seed)
    pts = np.array([base, base], np.float32)
    amp = rough
    while len(pts) < n:
        mids = (pts[:-1] + pts[1:]) / 2 + r.normal(0, amp, len(pts) - 1)
        new = np.empty(len(pts) * 2 - 1, np.float32)
        new[0::2], new[1::2] = pts, mids
        pts, amp = new, amp * 0.55
    return np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(pts)), pts)


def scenery(out):
    H = 0.58
    img = sky(H, col(70, 130, 210), col(215, 230, 240), clouds=0.45, seed=51)
    haze = col(190, 210, 230)
    layers = [(0.30, 0.16, col(120, 140, 170), 0.55, True), (0.40, 0.12, col(70, 95, 120), 0.3, True), (0.50, 0.06, col(45, 75, 60), 0.1, False)]
    for i, (base, rough, colour, fade, snow) in enumerate(layers):
        top = ridge(60 + i, base, rough)[None, :]
        m = yy >= top
        body = np.broadcast_to(colour, (S, S, 3)) * (0.9 + 0.15 * noise(8 + 4 * i, 4, 70 + i)[..., None])
        if snow:
            # snow above a wavy snow line, with sunlit and shaded sides
            line = base - 0.015 + 0.03 * (noise(10, 4, 90 + i)[0:1, :] - 0.5) + 0.04 * (noise(25, 3, 95 + i) - 0.5)
            cap = np.clip((line - yy) * 60, 0, 1)
            # rock faces: ridged 2D noise, sheared so gullies run downhill
            sheared = np.stack([map_coordinates(noise(6, 5, 97 + i), [yy * S, ((xx + 0.35 * yy) % 1) * (S - 1)], order=1)])[0]
            ridged = 1 - np.abs(2 * sheared - 1)
            light = np.clip(0.7 + 0.45 * ridged, 0.6, 1.08)
            body = body * light[..., None] ** 0.5
            body = mix(body, np.ones_like(body) * 0.95 * light[..., None], cap * 0.9)
        body = mix(body, np.broadcast_to(haze, (S, S, 3)), fade)
        img = np.where(m[..., None], body, img)
    # pine trees along the shore
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    for _ in range(70):
        x = rng.random() * S
        h = S * (0.03 + 0.05 * rng.random())
        b = S * (H + 0.004)
        d.polygon([(x, b - h), (x - h * 0.22, b), (x + h * 0.22, b)], fill=(28, 55, 40))
    img = np.asarray(im, np.float32) / 255
    # lake: mirror of everything above, darker, with ripples
    lake_end = 0.78
    src_y = np.clip(2 * H - yy + 0.004 * np.sin(yy * 900 + 3 * noise(5, 2, 81)), 0, H)
    refl = np.stack([map_coordinates(img[..., c], [src_y * S, xx * S], order=1) for c in range(3)], -1)
    refl = refl * 0.75 + col(20, 50, 70) * 0.25
    lake = (yy >= H) & (yy < lake_end)
    img = np.where(lake[..., None], refl, img)
    # meadow in front, with flowers
    meadow = vgrad(col(95, 150, 60), col(70, 125, 45), lake_end, 1.0)
    meadow *= (0.85 + 0.25 * noise(40, 4, 91))[..., None]
    flowers = (rng.random((S, S)) > 0.9985) & (yy > lake_end + 0.03)
    fl = gaussian_filter(flowers.astype(np.float32), 2.5) * 25
    meadow = mix(meadow, np.broadcast_to(col(250, 230, 120), (S, S, 3)), fl * 0.7)
    edge = lake_end + 0.006 * np.sin(xx * 23)
    img = np.where((yy >= edge)[..., None], meadow, img)
    finish(img, 3.5, 'scenery', out)


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'backgrounds'
    for fn in (beach, court, stadium, scenery):
        fn(out)
        print('drew', fn.__name__)
