// Rollout rehearsal: live app → publish new app (still old storage) → switch-over with tabs open.
const { execSync } = require('child_process');
const fs = require('fs');
const { chromium, openApp, ADMIN, JOAO } = require('./lib');
const APPFILE = process.env.APP_DIR_FILE;
const LIVE = process.env.LIVE_DIR, NEW = require('path').resolve(__dirname, '../..');
const sql = q => execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
const blobCell = sk => sql(`select coalesce((select people::text from _blob_cells((select value::jsonb from app_data where key='chbv_schedules')) where day||'_'||shift = '${sk}'), '{}')`);
const settle = async p => { await p.waitForFunction(() => !_saveTimer && !_saveInFlight, null, { timeout: 20000 }); await p.waitForTimeout(300); };
const out = []; const ok = (n, c, x = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
(async () => {
  execSync(__dirname + '/run-setup.sh');
  execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -1 -f ${NEW}/supabase/schedule-log-install.sql`);
  fs.writeFileSync(APPFILE, LIVE);                       // today's live app
  const browser = await chromium.launch();

  // R1 live app in use after install
  const O = await openApp(browser, ADMIN);
  await O.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-04'), 'day', ['d2']); save(); });
  await settle(O.page);
  ok('R1 live app keeps saving after install (step 3)', blobCell('2026-11-04_day') === '{d2}');

  // publish the new app (step 4); the old tab stays open
  fs.writeFileSync(APPFILE, NEW);
  const N = await openApp(browser, JOAO);
  const n1 = await N.page.evaluate(() => ({ mode: _scheduleMode, v: [...document.scripts].map(s => s.src).find(s => s.includes('app.js')) }));
  ok('R2 new app runs on the current storage (blob)', n1.mode === 'blob' && /v=7\d/.test(n1.v), JSON.stringify(n1));
  ok('R2b new app sees the old tab\'s edit', JSON.stringify(await N.page.evaluate(() => getAssignedForShift(parseDateKey('2026-11-04'), 'day'))) === '["d2"]');
  await N.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-05'), 'night', ['d1']); save(); });
  await settle(N.page);
  await O.page.evaluate(() => refreshFromServer()); await O.page.waitForTimeout(500);
  ok('R3 old and new app side by side: both edits kept',
    blobCell('2026-11-04_day') === '{d2}' && blobCell('2026-11-05_night') === '{d1}' &&
    JSON.stringify(await O.page.evaluate(() => getAssignedForShift(parseDateKey('2026-11-05'), 'night'))) === '["d1"]');
  await N.page.evaluate(() => openHistoryModal()); await N.page.waitForTimeout(800);
  const hist = await N.page.locator('#history-content').innerText();
  ok('R4 new app Histórico (blob mode) lists database backups with reasons', /Cópia inicial|Automática/.test(hist), hist.slice(0, 90).replace(/\s+/g, ' '));
  await N.page.evaluate(() => closeHistoryModal());

  // the old tab goes offline with an unsaved edit
  await O.page.route('**/api', r => r.abort());
  await O.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-07'), 'day', ['d2']); save(); });
  await O.page.waitForTimeout(1500);

  // switch-over (step 5) with tabs open
  const cut = execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -f ${NEW}/supabase/schedule-log-cutover.sql 2>&1`).toString();
  ok('R5 switch-over carries edits made since install, 0 differences',
    /cells/.test(cut) && sql('select count(*) from _cells_vs_blob()') === '0' &&
    sql("select count(*) from schedule_log where label = 'Sincronização com a app antiga'") === '2' &&
    sql("select people::text from schedule_cells where day='2026-11-04' and shift='day'") === '{d2}',
    'sync rows=' + sql("select count(*) from schedule_log where label = 'Sincronização com a app antiga'"));

  // the new-app tab notices and reloads itself into the new mode
  await N.page.evaluate(() => refreshFromServer()).catch(() => {});
  await N.page.waitForTimeout(2500);
  await N.page.waitForFunction(() => typeof _scheduleMode !== 'undefined' && _scheduleMode === 'cells', null, { timeout: 15000 });
  ok('R6 open new-app tab switches to the new mode by itself', await N.page.evaluate(() => _scheduleMode) === 'cells');

  // the old-app tab comes back online: its write is refused, nothing corrupted
  await O.page.unroute('**/api');
  const before = sql("select md5(string_agg(day||shift||people::text, ',' order by day, shift)) from schedule_cells");
  await O.page.evaluate(() => performSave()); await O.page.waitForTimeout(2000);
  ok('R7 old-app tab after switch-over cannot overwrite anything',
    before === sql("select md5(string_agg(day||shift||people::text, ',' order by day, shift)) from schedule_cells") &&
    sql('select count(*) from _cells_vs_blob()') === '0' &&
    /Falha|guardar/.test(await O.page.locator('#save-status').innerText().catch(() => '')),
    'status: ' + await O.page.locator('#save-status').innerText().catch(() => ''));

  // the old tab is reloaded (gets the new app) and its unsaved edit is replayed safely
  await O.page.reload();
  await O.page.waitForFunction(() => typeof currentRole !== 'undefined' && currentRole !== null, null, { timeout: 15000 });
  await O.page.waitForTimeout(1500); await settle(O.page);
  ok('R8 reloaded old tab runs the new app and its unsaved edit is applied once, logged',
    await O.page.evaluate(() => _scheduleMode) === 'cells' &&
    sql("select people::text from schedule_cells where day='2026-11-07' and shift='day'") === '{d2}' &&
    sql("select count(*) from schedule_log where day='2026-11-07' and shift='day'") === '1' &&
    sql("select count(*) from schedule_cells where day='2026-11-05' and shift='night' and people='{d1}'") === '1');
  ok('R9 final: old storage identical to new (0 differences)', sql('select count(*) from _cells_vs_blob()') === '0');
  ok('R10 no JavaScript errors in the new app', N.page.errors.length === 0, N.page.errors.join(' | '));
  console.log(out.join('\n'));
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.error('CRASH', e.message); process.exit(1); });
