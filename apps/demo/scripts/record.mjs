// Browser scenario for the demo: three users, capacity 2. Asserts every step and records a GIF.
// Requires Redis (pnpm redis:up) and a built demo (pnpm build). The GIF is written only if all assertions pass.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.GIF_OUT ?? join(appDir, '..', '..', 'assets', 'demo.gif');
const port = Number(process.env.PORT ?? 3100);
const baseUrl = `http://localhost:${port}`;

const VIEW = { width: 340, height: 560 };
const GAP = 12;
const FRAME_MS = 200;
const STEP_MS = 1200;
// Longer than five failed 1 s polls, so the client reaches the retry screen mid-action
const POLL_MS_LIMIT = 7000;
const WIDTH = VIEW.width * 3 + GAP * 4;
const HEIGHT = VIEW.height + GAP * 2;

/** Start the demo server on an isolated key prefix so leftovers from earlier runs cannot hold slots */
async function startServer() {
  const server = spawn(process.execPath, [join(appDir, 'dist', 'main.js')], {
    env: { ...process.env, PORT: String(port), TURNWAY_KEY_PREFIX: `demo-rec-${Date.now()}` },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  // Without this, a stale server already on the port would answer the readiness check
  let exited = false;
  server.once('exit', () => { exited = true; });
  for (let attempt = 0; attempt < 50 && !exited; attempt += 1) {
    const ready = await fetch(`${baseUrl}/api/stats`).then((res) => res.ok, () => false);
    if (ready) return server;
    await sleep(200);
  }
  server.kill();
  throw new Error(`Demo server did not become ready on ${baseUrl}. Is Redis running?`);
}

/** Lay the three screenshots side by side on one RGBA canvas */
function compose(shots) {
  const canvas = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < canvas.length; i += 4) canvas.writeUInt32BE(0xc9ced6ff, i);
  shots.forEach((shot, index) => {
    const png = PNG.sync.read(shot);
    const left = GAP + index * (VIEW.width + GAP);
    for (let y = 0; y < png.height; y += 1) {
      png.data.copy(canvas, ((y + GAP) * WIDTH + left) * 4, y * png.width * 4, (y + 1) * png.width * 4);
    }
  });
  return canvas;
}

/** Encode frames as they arrive, merging identical consecutive frames into one longer frame */
function createRecorder(pages) {
  const gif = GIFEncoder();
  let pending = null;
  let recording = true;

  const write = (frame, delay) => {
    const palette = quantize(frame.rgba, 256);
    gif.writeFrame(applyPalette(frame.rgba, palette), WIDTH, HEIGHT, { palette, delay });
  };

  const loop = (async () => {
    while (recording) {
      const at = Date.now();
      const rgba = compose(await Promise.all(pages.map((page) => page.screenshot())));
      if (!pending || !rgba.equals(pending.rgba)) {
        if (pending) write(pending, at - pending.at);
        pending = { rgba, at };
      }
      await sleep(Math.max(0, FRAME_MS - (Date.now() - at)));
    }
  })();

  return {
    /** Stop capturing without encoding, for the failure path */
    async stop() {
      recording = false;
      // The scenario error is what matters; a screenshot failing as the browser closes is noise
      await loop.catch(() => {});
    },
    async finish(holdMs) {
      recording = false;
      await loop;
      write(pending, holdMs);
      gif.finish();
      return gif.bytes();
    },
  };
}

const text = (page, id) => page.locator(`#${id}`).textContent();

function waitFor(page, id, expected, timeout = 5000) {
  return page.waitForFunction(
    ([elementId, value]) => document.getElementById(elementId)?.textContent === value,
    [id, expected],
    { timeout },
  );
}

const storedPass = (page) => page.evaluate(() => localStorage.getItem('turnway-demo-pass'));

function callApi(page, method, path) {
  return page.evaluate(async ([m, p]) => {
    const res = await fetch(p, { method: m });
    return { status: res.status, body: await res.json() };
  }, [method, path]);
}

async function scenario([a, b, c]) {
  await Promise.all([a, b, c].map((page) => waitFor(page, 'admitted', '0 / 2')));
  await sleep(STEP_MS);

  // Two users fill the capacity, the third waits
  await a.click('#join');
  await waitFor(a, 'badge', 'ADMITTED');
  await sleep(STEP_MS / 2);
  await b.click('#join');
  await waitFor(b, 'badge', 'ADMITTED');
  await sleep(STEP_MS / 2);
  await c.click('#join');
  await waitFor(c, 'badge', 'WAITING');
  assert.equal(await text(c, 'big'), '#1');
  await waitFor(c, 'waiting', '1');
  assert.equal(await text(c, 'admitted'), '2 / 2');
  await sleep(STEP_MS);

  // A waiting user cannot run protected work, and joining again or reloading keeps the same pass
  const waitingPass = await storedPass(c);
  const denied = await callApi(c, 'POST', `/api/passes/${waitingPass}/protected`);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { code: 'NOT_ADMITTED', state: 'WAITING' });
  const rejoined = await callApi(c, 'POST', '/api/join');
  assert.equal(rejoined.body.passId, waitingPass);
  const foreign = await callApi(a, 'GET', `/api/passes/${waitingPass}`);
  assert.equal(foreign.status, 403);
  await c.reload();
  await waitFor(c, 'badge', 'WAITING');
  assert.equal(await storedPass(c), waitingPass);

  // An admitted user runs protected work, then leaves and frees a slot
  await a.click('#protected');
  await a.locator('#result:not([hidden])').waitFor();
  assert.match(await text(a, 'result'), /^Seat reserved for /);
  await sleep(STEP_MS);
  await a.click('#leave');
  await waitFor(a, 'badge', 'LEFT');

  // The waiting user is promoted by the admission worker
  await waitFor(c, 'badge', 'ADMITTED');
  await sleep(STEP_MS);
  await c.click('#protected');
  await c.locator('#result:not([hidden])').waitFor();
  assert.match(await text(c, 'result'), /^Seat reserved for /);
  await sleep(STEP_MS);
}

/** Count requests to a path over a window, to tell whether exactly one polling loop is running */
async function countRequests(page, fragment, ms) {
  let count = 0;
  const onRequest = (request) => { if (request.url().includes(fragment)) count += 1; };
  page.on('request', onRequest);
  await sleep(ms);
  page.off('request', onRequest);
  return count;
}

// Not recorded: a 503 outage must keep the pass, stop at the retry screen, and recover to one loop
async function resilience(browser) {
  const context = await browser.newContext({ viewport: VIEW });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.click('#join');
  await waitFor(page, 'badge', 'ADMITTED');
  const pass = await storedPass(page);
  // Stand-in for a Redis outage: while down, every API call except a held protected call gets 503
  let down = true;
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/protected')) {
      await sleep(POLL_MS_LIMIT);
      down = false;
      return route.continue();
    }
    if (!down) return route.continue();
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"STORAGE_FAILURE"}' });
  });

  // The loop gives up while the action is still in flight; that action succeeding must restart polling
  await page.click('#protected');
  await page.locator('#retry:not([hidden])').waitFor({ timeout: 10_000 });
  await page.locator('#result:not([hidden])').waitFor({ timeout: 10_000 });
  assert.ok(await countRequests(page, '/api/stats', 3000) >= 2, 'polling did not resume after the action succeeded');

  // Server errors are not expiry: the pass survives, and repeated retries leave a single loop
  down = true;
  await page.locator('#retry:not([hidden])').waitFor({ timeout: 10_000 });
  assert.equal(await storedPass(page), pass);
  assert.equal(await text(page, 'badge'), 'ADMITTED');
  down = false;
  await page.evaluate(() => { for (let i = 0; i < 3; i += 1) document.getElementById('retry').click(); });
  const polls = await countRequests(page, '/api/stats', 3000);
  assert.ok(polls <= 4, `expected one polling loop, saw ${polls} stats requests in 3 s`);

  await page.click('#leave');
  await waitFor(page, 'badge', 'LEFT');
  await context.close();
}

const server = await startServer();
const browser = await chromium.launch();
let recorder;
try {
  const pages = await Promise.all(['Browser A', 'Browser B', 'Browser C'].map(async (label) => {
    // Separate contexts get separate cookies, so each one is a different user
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
    context.setDefaultTimeout(15_000);
    await context.addInitScript((name) => {
      addEventListener('DOMContentLoaded', () => {
        const tag = document.createElement('div');
        tag.textContent = name;
        tag.style.cssText = 'background:#1d2330;color:#fff;font:600 12px system-ui;padding:6px 16px';
        document.body.prepend(tag);
      });
    }, label);
    const page = await context.newPage();
    await page.goto(baseUrl);
    return page;
  }));

  recorder = createRecorder(pages);
  await scenario(pages);
  const gif = await recorder.finish(2500);
  console.log('scenario passed');

  for (const page of pages.slice(1)) await page.click('#leave');
  await Promise.all(pages.slice(1).map((page) => waitFor(page, 'badge', 'LEFT')));
  await resilience(browser);
  console.log('resilience checks passed');

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, gif);
  console.log(`wrote ${output} (${(gif.length / 1024).toFixed(0)} KiB)`);
} finally {
  // Kill the server first so a failure below cannot leave it holding the port
  server.kill();
  await recorder?.stop();
  await browser.close();
}
