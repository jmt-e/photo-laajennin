// Drives the real app in Chromium at iPhone size.
// Run: node tests/e2e.mjs <photo.jpg> [screenshot-dir]
// Needs Playwright (preinstalled in the dev container, not part of the app).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { serve } from './serve.mjs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(`${execSync('npm root -g').toString().trim()}/playwright`);
}
const { chromium } = playwright;

const [photo, shots = '.'] = process.argv.slice(2);
const PORT = 8123;
const ORIGIN = `http://localhost:${PORT}`;
const server = await serve(PORT);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});
const page = await context.newPage();
const errors = [];
const foreign = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
context.on('request', (r) => !r.url().startsWith(ORIGIN) && !r.url().startsWith('blob:') && !r.url().startsWith('data:') && foreign.push(r.url()));

const idle = () => page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
const step = (name) => console.log('✓', name);

try {
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.screenshot({ path: `${shots}/1-empty.png` });
  step('loads, service worker ready');

  await page.setInputFiles('#file', photo);
  await page.waitForSelector('#frame:not([hidden])');
  await idle();
  const size = await page.$eval('#after', (c) => [c.width, c.height]);
  assert.ok(Math.max(...size) <= 2048, `shrunk to ${size}`);
  step(`opened and shrunk to ${size.join('×')} — ${await page.textContent('#status')}`);

  const pixels = () => page.$eval('#after', (c) => Array.from(c.getContext('2d').getImageData(c.width / 2, c.height / 3, 1, 1).data));
  const before = await pixels();
  await page.click('#auto');
  await idle();
  assert.notDeepEqual(await pixels(), before, 'auto changed pixels');
  assert.equal(await page.isEnabled('#undo'), true);
  step('auto-enhance');

  await page.click('#sharpen');
  await page.waitForSelector('#panel-sharpen:not([hidden])');
  await page.$eval('#sharpen-amount', (s) => {
    s.value = '80';
    s.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/2-sharpen.png` });
  await page.click('#panel-sharpen [data-apply]');
  await page.waitForSelector('#panel-sharpen', { state: 'hidden' });
  step('sharpen with slider');

  await page.click('#text');
  await page.waitForSelector('#panel-text:not([hidden])');
  await idle();
  const colourText = await pixels();
  await page.click('[data-text-mode="bw"]');
  await idle();
  const [r, g, b] = await pixels();
  assert.ok(r === g && g === b, 'black & white is grey');
  await page.$eval('#text-strength', (s) => {
    s.value = '70';
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
  });
  await idle();
  await page.screenshot({ path: `${shots}/2b-text.png` });
  await page.click('#panel-text [data-apply]');
  await page.waitForSelector('#panel-text', { state: 'hidden' });
  assert.equal(await page.textContent('#status'), 'Text made clearer');
  await page.click('#undo');
  assert.notDeepEqual(colourText, [r, g, b]);
  step('text: colour, black & white, strength, apply, undo');

  let sawProgress = false;
  const watch = setInterval(async () => {
    if (await page.isVisible('#busy-progress').catch(() => false)) sawProgress = true;
  }, 50);
  const t0 = Date.now();
  await page.click('#background');
  await page.waitForSelector('#panel-bg:not([hidden])', { timeout: 120000 });
  await idle();
  clearInterval(watch);
  step(`background removed in ${Date.now() - t0} ms (progress bar seen: ${sawProgress})`);
  const corner = await page.$eval('#after', (c) => c.getContext('2d').getImageData(5, 5, 1, 1).data[3]);
  assert.equal(corner, 0, 'corner is transparent');
  await page.screenshot({ path: `${shots}/3-transparent.png` });

  await page.click('[data-bg="color"]');
  await idle();
  await page.click('[data-color="#2f6fde"]');
  await idle();
  const blue = await page.$eval('#after', (c) => Array.from(c.getContext('2d').getImageData(5, 5, 1, 1).data));
  assert.deepEqual(blue, [47, 111, 222, 255]);
  await page.screenshot({ path: `${shots}/4-colour.png` });
  // Wait until the engine's full fit (after moving) has been drawn.
  const fitted = async () => {
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Drag to move'), null, { timeout: 60000 });
    await page.$eval('#status', (s) => (s.textContent = ''));
  };
  for (const scene of ['beach', 'basketball-court', 'soccer-stadium', 'scenery']) {
    if (scene === 'beach') await page.click('[data-bg="scene"]');
    else await page.click(`[data-scene="${scene}"]`);
    await idle();
    await fitted();
    assert.equal(await page.getAttribute(`[data-scene="${scene}"]`, 'aria-pressed'), 'true');
    assert.equal(await page.isVisible('#scene-place'), true, 'move/resize controls shown');
    await page.screenshot({ path: `${shots}/5-${scene}.png` });
  }
  // Move the person: drag left and down, then shrink with the slider.
  const side = () => page.$eval("#after", (c) => Array.from(c.getContext("2d").getImageData(c.width / 2, c.height / 3, 1, 1).data));
  const sideBefore = await side();
  const fb = await page.locator('#frame').boundingBox();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width * 0.3, fb.y + fb.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await fitted();
  await page.$eval('#scene-size', (s) => {
    s.value = '60';
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
  });
  await fitted();
  assert.notDeepEqual(await side(), sideBefore, "moving the person changed the picture");
  await page.screenshot({ path: `${shots}/5-moved.png` });
  await page.click('#scene-reset');
  await fitted();

  // Sun & shadow option: on, then turn the shadow to the right.
  const checksum = () => page.$eval('#after', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 97) sum += d[i];
    return sum;
  });
  await page.click('[data-scene="beach"]');
  await idle();
  await fitted();
  const noSun = await checksum();
  await page.click('#sun-toggle');
  await fitted();
  assert.equal(await page.getAttribute('#sun-toggle', 'aria-pressed'), 'true');
  assert.equal(await page.isVisible('#sun-length'), true, 'sun sliders shown');
  const withSun = await checksum();
  await page.screenshot({ path: `${shots}/5-sun.png` });
  assert.notEqual(withSun, noSun, 'shadow and light change the picture');
  await page.$eval('#sun-angle', (s) => {
    s.value = '70';
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
  });
  await fitted();
  assert.match(await page.textContent('#sun-dir-label'), /→|↘/);
  await page.screenshot({ path: `${shots}/5-sun-right.png` });
  await page.$eval('#scene-size', (s) => {
    s.value = '55';
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
  });
  await fitted();
  await page.screenshot({ path: `${shots}/5-sun-small.png` });
  await page.click('#sun-toggle');
  await fitted();
  step('sun & shadow option, direction');
  await page.setInputFiles('#scene-file', photo);
  await idle();
  await fitted();
  assert.equal(await page.getAttribute('[data-scene="own"]', 'aria-pressed'), 'true');
  step('scenes: beach, court, stadium, scenery, your own photo; move and resize');
  await page.click('[data-bg="blur"]');
  await idle();
  await page.screenshot({ path: `${shots}/5-blur.png` });
  await page.click('#panel-bg [data-apply]');
  step('colour + blur backgrounds, applied');

  await page.click('#compare');
  const box = await page.locator('#frame').boundingBox();
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
  const clip = await page.$eval('#before', (c) => c.style.clipPath);
  assert.match(clip, /inset\(0px 30/);
  await page.screenshot({ path: `${shots}/6-compare.png` });
  await page.click('#compare');
  step('compare slider');

  await page.click('#undo');
  await page.click('#undo');
  await page.click('#reset');
  assert.equal(await page.isDisabled('#reset'), true);
  await page.click('#undo');
  assert.equal(await page.isEnabled('#reset'), true);
  step('undo / reset / undo-the-reset');

  await page.waitForTimeout(500);
  await page.click('#save');
  await page.waitForSelector('#save-sheet:not([hidden])');
  await page.waitForFunction(() => document.getElementById('save-img').naturalWidth > 0);
  const type = await page.$eval('#save-img', (img) => `${img.naturalWidth}×${img.naturalHeight}`);
  await page.screenshot({ path: `${shots}/7-save-fallback.png` });
  await page.click('#save-close');
  step(`save fallback shows the image (${type})`);

  // Offline: reload with no network, run background removal from cache.
  await context.setOffline(true);
  await page.reload();
  await page.setInputFiles('#file', photo);
  await page.waitForSelector('#frame:not([hidden])');
  await idle();
  await page.click('#background');
  await page.waitForSelector('#panel-bg:not([hidden])', { timeout: 60000 });
  await idle();
  step('works offline, AI model comes from cache');
  await context.setOffline(false);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `${shots}/8-light.png` });

  assert.deepEqual(foreign, [], 'no requests to other servers');
  step('no requests to other servers');
  assert.deepEqual(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e)), [], 'no console errors');
  step('no errors');
} finally {
  await browser.close();
  server.close();
}
