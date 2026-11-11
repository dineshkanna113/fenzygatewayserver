/**
 * Browser smoke test: signs in, walks the dashboard and pays through the hosted checkout.
 * Uses the Chrome already installed on the machine (no browser download): `npm run test:ui`.
 * Set CHROME_PATH to use a different binary.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright-core';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockgw-ui-'));
Object.assign(process.env, { DATA_DIR: dataDir, ADMIN_PASSWORD: 'admin-pass-for-ui', LOG_LEVEL: 'error', SMTP_ENABLED: 'false', RATE_LIMIT_PER_MINUTE: '0' });

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { db } = await import('../../src/db.js');

let server;
let browser;
let BASE;
const problems = [];

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = BASE;
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const executablePath = candidates.find((p) => p && fs.existsSync(p));
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
});

after(async () => {
  await browser?.close();
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`http ${r.status()} ${r.url()}`));
  return page;
}

async function signIn(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin-pass-for-ui');
  await Promise.all([page.waitForURL('**/dashboard'), page.click('#submit')]);
}

describe('hosted checkout', () => {
  test('pays by card and reaches the success screen', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/checkout/razorpay/new?key=${config.razorpay.keyId}&amount=129900&currency=INR&name=Fenzy`);
    assert.match(await page.textContent('.amount'), /1,299/);
    await page.click('[data-action="method"][data-m="card"]');
    await page.click('.testcards summary');
    await page.click('[data-action="fill-card"][data-n="4111111111111111"]');
    await page.click('form[data-form="card"] button[type="submit"]');
    await page.waitForSelector('.state-icon.ok', { timeout: 8000 });
    assert.match(await page.textContent('.state-screen h2'), /Payment successful/);
  });

  test('3-D Secure card asks for an OTP and rejects a wrong one', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/checkout/razorpay/new?key=${config.razorpay.keyId}&amount=50000&currency=INR&name=Fenzy`);
    await page.click('[data-action="method"][data-m="card"]');
    await page.click('.testcards summary');
    await page.click('[data-action="fill-card"][data-n="4000000000003220"]');
    await page.click('form[data-form="card"] button[type="submit"]');
    await page.waitForSelector('.acs', { timeout: 8000 });
    await page.locator('.otp-box').first().click();
    await page.keyboard.type('000000');
    await page.waitForSelector('#otp-error:not([hidden])', { timeout: 8000 });
    assert.match(await page.textContent('#otp-error'), /Incorrect OTP/);
  });

  test('stacks the stub above the form on a phone', async () => {
    const page = await newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(`${BASE}/checkout/razorpay/new?key=${config.razorpay.keyId}&amount=129900&currency=INR&name=Fenzy`);
    await page.evaluate(() => document.fonts.ready);
    const { stub, pane } = await page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { y: b.y, height: b.height }; };
      return { stub: r('.slip'), pane: r('.pane') };
    });
    assert.ok(pane.y >= stub.y + stub.height - 1, 'pane sits below the stub');
    assert.ok(stub.height < 200, `stub stays compact, got ${stub.height}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal scroll');
  });
});

describe('dashboard', () => {
  test('signs in, lists providers and shows the upipay snippet for Paytm', async () => {
    const page = await newPage();
    await signIn(page);
    assert.equal(await page.textContent('#title'), 'Overview');
    await page.click('.pitem[data-provider="Paytm"]');
    assert.match(await page.textContent('.snippet'), /upipay-shim\.mjs/);
    assert.match(await page.textContent('.pdetail'), /merchant_key/);
  });

  test('sorts payment rows when a column header is clicked', async () => {
    const page = await newPage();
    await signIn(page);
    for (const amount of [900000, 100000, 500000]) {
      await page.request.get(`${BASE}/checkout/razorpay/new?key=${config.razorpay.keyId}&amount=${amount}&currency=INR&name=Sort`);
    }
    await page.goto(`${BASE}/dashboard#payments`);
    await page.waitForSelector('tbody tr');
    const amountCol = page.locator('th', { hasText: 'Amount' });
    await amountCol.locator('.sort').click();
    assert.equal(await amountCol.getAttribute('aria-sort'), 'ascending');
    const amounts = await page.$$eval('tbody tr td:nth-child(4)', (tds) => tds.map((t) => parseFloat(t.textContent.replace(/[^0-9.]/g, ''))));
    assert.deepEqual(amounts, [...amounts].sort((a, b) => a - b));
    await amountCol.locator('.sort').click();
    assert.equal(await amountCol.getAttribute('aria-sort'), 'descending');
  });

  test('settings expose the failure-injection controls', async () => {
    const page = await newPage();
    await signIn(page);
    await page.goto(`${BASE}/dashboard#settings`);
    await page.waitForSelector('#settings-form');
    for (const key of ['checkout.nextFailure', 'webhooks.delaySeconds', 'webhooks.duplicate']) {
      assert.equal(await page.locator(`[name="${key}"]`).count(), 1, `${key} is editable`);
    }
  });

  test('dark mode swaps the surfaces and keeps text readable', async () => {
    const light = await newPage({ colorScheme: 'light' });
    const dark = await newPage({ colorScheme: 'dark' });
    await light.goto(`${BASE}/login`);
    await dark.goto(`${BASE}/login`);
    const read = (p) => p.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.querySelector('h1')).color }));
    const l = await read(light);
    const d = await read(dark);
    assert.notEqual(l.bg, d.bg);
    assert.notEqual(l.fg, d.fg);
  });
});

describe('accessibility', () => {
  // Text needs 4.5:1, form-control edges 3:1 (WCAG 1.4.3 and 1.4.11), in both themes.
  const PAIRS = [
    ['ink', 'paper', 4.5], ['ink-2', 'paper', 4.5], ['muted', 'paper', 4.5], ['muted', 'paper-2', 4.5], ['muted', 'well', 4.5],
    ['ink', 'ground', 4.5], ['ink-2', 'ground', 4.5], ['signal', 'paper', 4.5], ['signal', 'signal-soft', 4.5], ['ink', 'signal-soft', 4.5],
    ['signal-ink', 'signal', 4.5], ['paper', 'ink', 4.5], ['on-status', 'ok', 4.5], ['on-status', 'bad', 4.5],
    ['ok', 'ok-soft', 4.5], ['bad', 'bad-soft', 4.5], ['warn', 'warn-soft', 4.5], ['info', 'info-soft', 4.5],
    ['bad', 'paper', 4.5], ['warn', 'paper-2', 4.5], ['code-ink', 'code-bg', 4.5],
    ['edge', 'paper', 3], ['edge', 'field', 3], ['edge', 'paper-2', 3],
  ];

  for (const scheme of ['light', 'dark']) {
    test(`colour tokens meet WCAG contrast in ${scheme} mode`, async () => {
      const page = await newPage({ colorScheme: scheme });
      await page.goto(`${BASE}/login`);
      const rows = await page.evaluate((pairs) => {
        const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
        const rgb = (name) => {
          const probe = document.body.appendChild(document.createElement('i'));
          probe.style.color = `var(--${name})`;
          const c = getComputedStyle(probe).color;
          probe.remove();
          cx.clearRect(0, 0, 1, 1);
          cx.fillStyle = '#000';
          cx.fillStyle = c;
          cx.fillRect(0, 0, 1, 1);
          return Array.from(cx.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        return pairs.map(([fg, bg, min]) => {
          const a = lum(rgb(fg));
          const b = lum(rgb(bg));
          return { fg, bg, min, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
      }, PAIRS);
      const failing = rows.filter((r) => r.ratio < r.min).map((r) => `${r.fg} on ${r.bg}: ${r.ratio.toFixed(2)} < ${r.min}`);
      assert.deepEqual(failing, []);
    });
  }

  test('sign-in fits a phone and keeps the form reachable', async () => {
    const page = await newPage({ viewport: { width: 390, height: 780 } });
    await page.goto(`${BASE}/login`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no horizontal scroll');
    const box = await page.locator('#submit').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'submit button sits inside the viewport');
  });

  test('dashboard fits a phone: scrollable tab bar, no page-wide horizontal scroll', async () => {
    const page = await newPage({ viewport: { width: 390, height: 780 } });
    await signIn(page);
    for (const tab of ['overview', 'payments', 'settings']) {
      await page.goto(`${BASE}/dashboard#${tab}`);
      await page.waitForSelector('#view > *');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `#${tab} has no horizontal page scroll`);
    }
    const nav = await page.locator('#nav').boundingBox();
    assert.ok(nav.width <= 390, 'tab bar stays within the viewport and scrolls inside itself');
    assert.equal(await page.locator('#logout').isVisible(), true, 'sign out is reachable');
  });
});

test('no console errors or CSP violations across all pages', () => {
  assert.deepEqual(problems, []);
});
