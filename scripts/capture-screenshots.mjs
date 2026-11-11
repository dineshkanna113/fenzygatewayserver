/**
 * Regenerates the README screenshots in docs/screenshots from a running server.
 *
 *   MOCK_URL=http://localhost:4000 ADMIN_PASSWORD=... node scripts/capture-screenshots.mjs
 *
 * The dashboard pages show whatever data the server holds, so seed some SMS and payments first.
 * Uses the Chrome installed on the machine (CHROME_PATH overrides the location).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = (process.env.MOCK_URL || 'http://localhost:4000').replace(/\/+$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD;
const OUT = path.resolve(import.meta.dirname, '../docs/screenshots');
if (!PASSWORD) throw new Error('Set ADMIN_PASSWORD to the dashboard password.');

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const executablePath = candidates.find((p) => p && fs.existsSync(p));
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });

const shot = async (page, name) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('wrote', `${name}.png`);
};

async function context(viewport, deviceScaleFactor) {
  return browser.newContext({ viewport, deviceScaleFactor, colorScheme: 'light', locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
}

/* sign-in and dashboard: desktop */
{
  const page = await (await context({ width: 1280, height: 800 }, 1)).newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('#username', 'admin');
  await shot(page, 'login');

  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForURL('**/dashboard'), page.click('#submit')]);
  await page.click('.pitem[data-provider="Paytm"]');
  await page.waitForSelector('.snippet');
  await shot(page, 'dashboard');

  await page.goto(`${BASE}/dashboard#sms`);
  await page.waitForSelector('tbody tr');
  await shot(page, 'dashboard-sms');
}

/* hosted checkout: phone-width so the four-up README table stays legible */
{
  const page = await (await context({ width: 430, height: 780 }, 2)).newPage();
  const start = `${BASE}/checkout/razorpay/new?key=rzp_test_mockkey000001&amount=129900&currency=INR&name=Fenzy&description=Pro%20plan%2C%20annual&prefill_contact=9876543210&prefill_email=asha%40example.com`;
  await page.goto(start);
  await page.waitForSelector('.methods');
  await shot(page, 'checkout-methods');

  await page.click('[data-action="method"][data-m="card"]');
  await page.click('.testcards summary');
  await page.click('[data-action="fill-card"][data-n="4000000000003220"]');
  await page.evaluate(() => document.querySelector('.testcards')?.removeAttribute('open'));
  await shot(page, 'checkout-card');

  await page.click('form[data-form="card"] button[type="submit"]');
  await page.waitForSelector('.acs');
  await shot(page, 'checkout-otp');

  await page.locator('.otp-box').first().click();
  await page.keyboard.type('123456');
  await page.waitForSelector('.state-icon.ok');
  await shot(page, 'checkout-success');
}

await browser.close();
