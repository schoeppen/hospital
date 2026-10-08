let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const BASE = 'http://localhost:8787/';
const ADMIN = '00000000-0000-0000-0000-00000000000a', TAREF = '00000000-0000-0000-0000-00000000000b', JOAO = '00000000-0000-0000-0000-00000000000c';
async function openApp(browser, uid = ADMIN, opts = {}) {
  const ctx = opts.ctx || await browser.newContext({ timezoneId: opts.tz || 'Europe/Lisbon' });
  const page = await ctx.newPage();
  page.dialogs = [];
  page.on('dialog', d => { page.dialogs.push(d.message()); d.accept(); });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/**', r => r.fulfill({ path: __dirname + '/fake-supabase.js', contentType: 'text/javascript' }));
  await page.route('https://cdn.jsdelivr.net/npm/html2canvas**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
  if (opts.beforeLoad) await opts.beforeLoad(page);
  await page.goto(BASE + '?uid=' + uid);
  await page.waitForFunction(() => typeof currentRole !== 'undefined' && currentRole !== null, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  return { ctx, page };
}
const state = page => page.evaluate(() => ({
  mode: _scheduleMode,
  slots: Object.values(flattenSchedule(schedules)).reduce((a, x) => a + x.length, 0),
  dirty: localChanged('chbv_schedules'),
}));
const cell = (page, sk) => page.evaluate(sk => flattenSchedule(schedules)[sk] || [], sk);
const settle = async page => { await page.waitForFunction(() => !_saveTimer && !_saveInFlight && !_retryTimer, null, { timeout: 20000 }); await page.waitForTimeout(200); };
module.exports = { chromium, openApp, state, cell, settle, ADMIN, TAREF, JOAO };
