import { chromium } from 'playwright';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = await ensureAccount(BASE, 'zz_shot', 'smoke-pass-123456');
const character = await ensureCharacter(BASE, token, 'Shotwalker', 'warrior');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 800 } })).newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.text().includes('foliage') || m.text().includes('texture'))
    console.log('console:', m.text().slice(0, 300));
});
await page.addInitScript((t) => localStorage.setItem('dawned.token', t), token);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.click(`.char-card:has-text("${character.name}")`, { timeout: 60000 });
await page.click('.btn--primary:has-text("ENTER WORLD")', { timeout: 60000 });
await page.waitForFunction(
  () => document.querySelector('.hud-status')?.textContent?.includes('in world'),
  { timeout: 90000 },
);
// Look south toward the island interior (trees), wait for streaming + foliage.
await page.evaluate(() => {
  window.__dawned.input.yaw = Math.PI;
  window.__dawned.input.pitch = 0.25;
});
await sleep(15000);
const stats = await page.evaluate(() => window.__dawned.rendererInfo());
console.log('renderer:', JSON.stringify(stats));
await page.screenshot({
  path: '/tmp/claude-0/-home-user/addc3ede-0123-5e0c-a9da-af6838ad1eab/scratchpad/shots/foliage-local.png',
  timeout: 60000,
});
await browser.close();
console.log('done');
