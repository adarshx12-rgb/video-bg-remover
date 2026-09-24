// End-to-end tests that drive the real UI in a local Chrome/Edge and verify the
// downloaded files with ffprobe/ffmpeg.
//
// Prerequisites: `npm run make-test-videos`, ffmpeg + ffprobe on PATH, and the app
// running (`npm run dev`, default http://localhost:4321; override with APP_URL).
// Usage: node tests/e2e/run-e2e.mjs [scenario-name-filter]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchPersistent } from './browser.mjs';

const APP_URL = process.env.APP_URL ?? 'http://localhost:4321/';
const MEDIA = resolve('test-media');
const OUT = resolve('test-results', 'e2e');
mkdirSync(OUT, { recursive: true });
const filter = process.argv[2] ?? '';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', 'raw.githubusercontent.com', 'huggingface.co', 'cas-bridge.xethub.hf.co']);

const results = [];
const context = await launchPersistent(resolve('test-results', process.env.E2E_PROFILE ?? 'chrome-profile-e2e'));
const requests = [];
context.on('request', (req) => {
  const url = new URL(req.url());
  if (url.protocol === 'blob:' || url.protocol === 'data:') return;
  requests.push({ method: req.method(), host: url.hostname, url: req.url().slice(0, 140), bodyBytes: req.postDataBuffer()?.length ?? 0 });
});

async function openApp() {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message));
  page.on('crash', () => console.log('   [crash] the page (renderer) crashed', new Date().toISOString()));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && console.log('   [console]', m.text().slice(0, 200)));
  currentPage = page;
  await page.goto(APP_URL);
  await page.getByRole('button', { name: 'Choose a video' }).waitFor({ timeout: 60000 });
  return page;
}

async function upload(page, file) {
  await page.locator('input[type=file][accept^="video"]').setInputFiles(join(MEDIA, file));
}

async function chooseModel(page, name) {
  await page.getByRole('radio', { name: new RegExp(`^${name}`) }).check();
}

async function processAndDownload(page, { downloadName, timeout = 15 * 60_000 }) {
  await page.getByRole('button', { name: 'Remove background' }).click();
  await page.getByText('Your video is ready').waitFor({ timeout });
  // Read the exact bytes behind the Download link (the blob the user saves). Playwright's
  // download.saveAs() intermittently crashes headless Chrome 153 on this machine, even for
  // a 5-byte blob, so it is not used here.
  const link = page.getByRole('link', { name: /^Download / });
  const fileName = await link.getAttribute('download');
  assert(fileName && /.(mp4|webm)$/.test(fileName), `Download link has no usable file name: ${fileName}`);
  const base64 = await link.evaluate(async (a) => {
    const bytes = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  const path = join(OUT, downloadName);
  writeFileSync(path, Buffer.from(base64, 'base64'));
  return path;
}

function verify(source, output, extra = []) {
  try {
    const log = execFileSync('node', ['scripts/verify-output.mjs', join(MEDIA, source), output, ...extra]).toString();
    return { ok: true, log };
  } catch (error) {
    return { ok: false, log: error.stdout?.toString() ?? String(error) };
  }
}

/** Decode the VP9 alpha plane with libvpx and report the share of transparent/opaque pixels. */
function alphaStats(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', file, '-frames:v', '1', '-ss', '0', '-vf', 'alphaextract,scale=160:-2', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  let transparent = 0, opaque = 0;
  for (const v of raw) { if (v < 16) transparent++; else if (v > 240) opaque++; }
  return { transparent: transparent / raw.length, opaque: opaque / raw.length };
}

let currentPage = null;
async function scenario(name, fn) {
  if (filter && !name.includes(filter)) return;
  const t0 = Date.now();
  console.log(`\n▶ ${name}`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, seconds: (Date.now() - t0) / 1000 });
    console.log(`  PASS (${((Date.now() - t0) / 1000).toFixed(0)} s) ${detail ?? ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, seconds: (Date.now() - t0) / 1000 });
    await currentPage?.screenshot({ path: join(OUT, `failure-${name.replace(/W+/g, '-')}.png`), fullPage: true }).catch(() => undefined);
    console.log(`  FAIL: ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------------

await scenario('rvm: video with audio -> MP4 with green background', async () => {
  const page = await openApp();
  await upload(page, 'person-audio.mp4');
  await page.getByText('6.0 s').waitFor();
  await chooseModel(page, 'People');
  await page.getByText('Green', { exact: true }).click();
  const file = await processAndDownload(page, { downloadName: 'rvm-person-audio.mp4' });
  const v = verify('person-audio.mp4', file);
  console.log(v.log.replace(/^/gm, '   '));
  assert(v.ok, 'output verification failed');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '3', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', join(OUT, 'rvm-person-audio-3s.png')]);
  await page.close();
});

await scenario('rvm: silent video -> WebM with image background', async () => {
  const page = await openApp();
  await upload(page, 'person-silent.mp4');
  await page.getByText('None', { exact: true }).first().waitFor();
  await page.locator('input[type=file][accept^="image"]').setInputFiles(join(MEDIA, 'src', 'cats.jpg'));
  await page.getByText('WebM (VP9)', { exact: true }).click();
  const file = await processAndDownload(page, { downloadName: 'rvm-person-silent.webm' });
  const v = verify('person-silent.mp4', file);
  console.log(v.log.replace(/^/gm, '   '));
  assert(v.ok, 'output verification failed');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '2', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', join(OUT, 'rvm-person-silent-2s.png')]);
  await page.close();
});

await scenario('rvm: rotated portrait phone video -> transparent WebM (alpha verified)', async () => {
  const page = await openApp();
  await upload(page, 'person-portrait-rotated.mp4');
  await page.getByText('720 × 1280').first().waitFor();
  await page.getByText('None', { exact: true }).click();
  await page.getByText('Transparent WebM (VP9 + alpha)').waitFor();
  const file = await processAndDownload(page, { downloadName: 'rvm-portrait-transparent.webm' });
  const v = verify('person-portrait-rotated.mp4', file, ['--alpha']);
  console.log(v.log.replace(/^/gm, '   '));
  assert(v.ok, 'output verification failed');
  const alpha = alphaStats(file);
  console.log(`   alpha plane: ${(alpha.transparent * 100).toFixed(1)}% transparent, ${(alpha.opaque * 100).toFixed(1)}% opaque`);
  assert(alpha.transparent > 0.05 && alpha.opaque > 0.05, 'alpha plane does not contain both transparent and opaque regions');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', file, '-frames:v', '1', '-vf', 'scale=-2:480', join(OUT, 'rvm-portrait-transparent.png')]);
  await page.close();
  return `transparent ${(alpha.transparent * 100).toFixed(0)}%, opaque ${(alpha.opaque * 100).toFixed(0)}%`;
});

await scenario('rvm: audio starting 0.5 s late stays in sync', async () => {
  const page = await openApp();
  await upload(page, 'person-audio-offset.mp4');
  await page.getByText('4.0 s').waitFor();
  const file = await processAndDownload(page, { downloadName: 'rvm-audio-offset.mp4' });
  const v = verify('person-audio-offset.mp4', file);
  console.log(v.log.replace(/^/gm, '   '));
  assert(v.ok, 'output verification failed');
  await page.close();
});

await scenario('rvm: reduced frame rate keeps duration and audio', async () => {
  const page = await openApp();
  await upload(page, 'person-audio.mp4');
  await page.getByText('6.0 s').waitFor();
  await page.getByLabel('Frame rate').selectOption('10');
  const file = await processAndDownload(page, { downloadName: 'rvm-10fps.mp4' });
  const v = verify('person-audio.mp4', file, ['--fps', '10']);
  console.log(v.log.replace(/^/gm, '   '));
  assert(v.ok, 'output verification failed');
  await page.close();
});

// BEN2 is slow on most integrated GPUs (~30-40 s per frame measured), so this runs only
// when requested: E2E_BEN2=1 node tests/e2e/run-e2e.mjs ben2
if (process.env.E2E_BEN2) {
  await scenario('ben2: WebM (VP9 + Opus) non-person subject -> MP4 at 5 fps', async () => {
    const page = await openApp();
    await upload(page, 'cats-1s.webm');
    await page.getByText('1.0 s').waitFor();
    await chooseModel(page, 'General subjects');
    await page.getByText('Black', { exact: true }).click();
    await page.getByLabel('Frame rate').selectOption('5');
    const file = await processAndDownload(page, { downloadName: 'ben2-cats-5fps.mp4', timeout: 30 * 60_000 });
    const backend = await page.getByText(/Ready, running on/).innerText();
    const v = verify('cats-1s.webm', file, ['--fps', '5']);
    console.log(v.log.replace(/^/gm, '   '));
    assert(v.ok, 'output verification failed');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', join(OUT, 'ben2-cats.png')]);
    await page.close();
    return backend;
  });
}

await scenario('cancel, then try again', async () => {
  const page = await openApp();
  await upload(page, 'person-silent.mp4');
  await page.getByText('4.0 s').waitFor();
  await page.getByRole('button', { name: 'Remove background' }).click();
  await page.getByText('Removing the background').waitFor({ timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByText('Stopped', { exact: true }).waitFor({ timeout: 15000 });
  assert(!(await page.getByRole('link', { name: /^Download / }).count()), 'download offered after cancel');
  // Stale progress must not reappear after cancelling.
  await page.waitForTimeout(3000);
  assert(await page.getByText('Stopped', { exact: true }).isVisible(), 'status changed after cancel (stale job update)');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByText('Your video is ready').waitFor({ timeout: 10 * 60_000 });
  await page.close();
});

await scenario('model switching releases the previous model worker', async () => {
  const page = await openApp();
  await upload(page, 'person-silent.mp4');
  await page.getByText('4.0 s').waitFor();
  await page.getByRole('button', { name: 'Preview this frame' }).click();
  await page.getByText(/Showing a preview of the frame/).waitFor({ timeout: 120000 });
  const before = page.workers().length;
  await chooseModel(page, 'General subjects');
  await page.waitForTimeout(1000);
  const afterSwitch = page.workers().length;
  await chooseModel(page, 'People');
  await page.waitForTimeout(1000);
  assert(afterSwitch < before, `worker count did not drop after switching (before ${before}, after ${afterSwitch})`);
  // Selecting a model alone must not download it; People loads again only when used.
  await page.getByRole('button', { name: 'Preview this frame' }).click();
  await page.getByText(/Showing a preview of the frame/).waitFor({ timeout: 120000 });
  await page.close();
  return `workers before ${before}, after switch ${afterSwitch}`;
});

await scenario('rejects video that is too long', async () => {
  const page = await openApp();
  await upload(page, 'too-long.mp4');
  await page.getByText(/35\.0 seconds long/).waitFor({ timeout: 20000 });
  assert(await page.getByText(/Trim the video to 30 seconds/).isVisible(), 'no recovery step shown');
  await page.close();
});

await scenario('rejects unsupported codec with recovery steps', async () => {
  const page = await openApp();
  await upload(page, 'unsupported-codec.avi');
  await page.getByRole('alert').waitFor({ timeout: 20000 });
  const text = await page.getByRole('alert').innerText();
  console.log('   ' + text.replace(/\n/g, ' | '));
  assert(/MP4|H\.264/.test(text), 'no actionable recovery step');
  await page.close();
});

await scenario('repeated use keeps memory bounded', async () => {
  const page = await openApp();
  const heap = async () => page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    await upload(page, 'person-silent.mp4');
    await page.getByText('4.0 s').waitFor();
    await page.getByRole('button', { name: /Remove background/ }).first().click();
    await page.getByText('Your video is ready').waitFor({ timeout: 10 * 60_000 });
    await page.getByRole('button', { name: 'Choose another video' }).click();
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    samples.push(Math.round((await heap()) / 1024 / 1024));
  }
  console.log(`   main-thread JS heap after each run (MB): ${samples.join(', ')}; workers alive: ${page.workers().length}`);
  assert(samples[2] - samples[0] < 40, 'main-thread heap grew by more than 40 MB over repeated runs');
  await page.close();
  return `heap MB ${samples.join(' -> ')}`;
});

// ---------------------------------------------------------------------------------

const uploads = requests.filter((r) => r.method !== 'GET' || r.bodyBytes > 0);
const foreign = requests.filter((r) => !ALLOWED_HOSTS.has(r.host) && !r.host.endsWith('.hf.co') && !r.host.endsWith('.huggingface.co'));
console.log(`\nNetwork: ${requests.length} requests; non-GET or with body: ${uploads.length}; unexpected hosts: ${foreign.length}`);
for (const r of [...uploads, ...foreign].slice(0, 10)) console.log('  ', r.method, r.url);
const hosts = [...new Set(requests.map((r) => r.host))];
console.log('Hosts contacted:', hosts.join(', '));
results.push({ name: 'no video/audio upload (only GET requests, only expected hosts)', ok: uploads.length === 0 && foreign.length === 0 });

await context.close();
console.log('\nSummary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `: ${r.detail}`}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
