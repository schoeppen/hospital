// Scenarios from the independent review (each one failed or was unprotected before the fixes).
const { execSync } = require('child_process');
const { chromium, openApp, cell, ADMIN, JOAO } = require('./lib');
const ROOT = require('path').resolve(__dirname, '../..');
const sql = q => execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
const srv = (d, s) => sql(`select people::text from schedule_cells where day='${d}' and shift='${s}'`);
const asJoao = (d, s, exp, ppl) => sql(`set role authenticated; select set_config('test.uid','00000000-0000-0000-0000-00000000000c',false); select apply_schedule_changes('[{"op_id":"${require('crypto').randomUUID()}","day":"${d}","shift":"${s}","expected":${exp},"people":${ppl}}]')->'results'->0->>'status'`).split('\n').pop();
const settle = async p => { await p.waitForFunction(() => !_saveTimer && !_saveInFlight && !_retryTimer, null, { timeout: 30000 }); await p.waitForTimeout(300); };
const out = []; const ok = (n, c, x = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
(async () => {
  execSync(__dirname + '/run-setup.sh');
  execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -1 -f ${ROOT}/supabase/schedule-log-install.sql`);
  execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -f ${ROOT}/supabase/schedule-log-cutover.sql`);
  const browser = await chromium.launch();
  const A = await openApp(browser, ADMIN);
  await A.page.evaluate(() => stopAutoRefresh());

  // #2 a failing save is pending → "Ver" is refused, nothing written; and while previewing, no save runs
  await A.page.route('**/api', r => (r.request().postData() || '').includes('apply_schedule_changes') ? r.abort() : r.continue());
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-08'), 'day', ['d1']); save(); });
  await A.page.waitForFunction(() => _retryTimer, null, { timeout: 30000 });
  await A.page.evaluate(() => { _verRows = [{ id: 0, at: new Date().toISOString(), batch_id: 'x', day: '2026-11-01', shift: 'day', before: [], after: [] }]; _buildVersionGroups(); });
  await A.page.evaluate(() => previewVersion(0)); await A.page.waitForTimeout(3000);
  const refused = await A.page.evaluate(() => !_preview);
  await A.page.unroute('**/api');
  await A.page.evaluate(() => { clearTimeout(_retryTimer); _retryTimer = null; performSave(); }); await settle(A.page);
  ok('RV2a "Ver" refused while an edit is unsaved; that edit then saves', refused && srv('2026-11-08', 'day') === '{d1}' &&
     A.page.dialogs.some(d => d.includes('ainda não foram guardadas')));
  const before = sql("select md5(string_agg(day||shift||people::text, ',' order by day, shift)) from schedule_cells");
  await A.page.evaluate(() => { _verRows = [{ id: 0, at: new Date().toISOString(), batch_id: 'x', day: '2026-11-01', shift: 'day', before: [], after: [] }]; _buildVersionGroups(); });
  await A.page.evaluate(() => previewVersion(0)); await A.page.waitForTimeout(800);
  await A.page.evaluate(() => performSave()); await A.page.waitForTimeout(800);          // a retry firing during "Ver"
  ok('RV2b nothing is written while an old version is shown', await A.page.evaluate(() => !!_preview) &&
     before === sql("select md5(string_agg(day||shift||people::text, ',' order by day, shift)) from schedule_cells"));
  await A.page.evaluate(() => exitPreview()); await A.page.waitForTimeout(300);
  ok('RV2c after closing "Ver" the real schedule is back, not dirty', await A.page.evaluate(() => !localChanged('chbv_schedules')) &&
     JSON.stringify(await cell(A.page, '2026-11-08_day')) === '["d1"]');

  // #3 undo while a newer edit is still queued → the queued edit is kept
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-10'), 'night', ['d2']); save(); }); await settle(A.page);
  const undoId = sql("select max(id) from schedule_log where day='2026-11-10'");
  await A.page.evaluate(id => { setAssignedForShift(parseDateKey('2026-11-11'), 'day', ['d2']); save(); return undoVersionEdit(Number(id), true); }, undoId);
  await A.page.waitForTimeout(1500); await settle(A.page);
  ok('RV3 undo with a queued edit: undo applied, queued edit kept', srv('2026-11-11', 'day') === '{d2}' &&
     srv('2026-11-10', 'night') !== '{d2}' && !(await A.page.evaluate(() => localChanged('chbv_schedules'))),
     `11/11=${srv('2026-11-11', 'day')} 10/11 night=${srv('2026-11-10', 'night')}`);

  // #4 someone else changes a shift; meanwhile this device changes it twice (second during the request)
  const orig = srv('2026-11-13', 'day');
  asJoao('2026-11-13', 'day', JSON.stringify(orig.replace(/[{}]/g, '').split(',').filter(Boolean)), '["d2"]');
  await A.page.route('**/api', async r => { if ((r.request().postData() || '').includes('apply_schedule_changes')) await new Promise(x => setTimeout(x, 1500)); r.continue(); });
  A.page.dialogs.length = 0;
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-13'), 'day', ['d1']); save(); });
  await A.page.waitForFunction(() => _saveInFlight);
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-13'), 'day', ['d1', 'd2']); save(); });
  await settle(A.page); await A.page.unroute('**/api'); await A.page.waitForTimeout(300);
  ok('RV4 the other person\'s change is never silently replaced; user is told', srv('2026-11-13', 'day') === '{d2}' &&
     JSON.stringify(await cell(A.page, '2026-11-13_day')) === '["d2"]' && A.page.dialogs.some(d => d.includes('outra pessoa')),
     `server=${srv('2026-11-13', 'day')} screen=${JSON.stringify(await cell(A.page, '2026-11-13_day'))}`);

  // #11 reply lost, then the user puts the shift back → server ends at the user's final value
  const o15 = srv('2026-11-14', 'day');
  let dropped = false;
  await A.page.route('**/api', async r => {
    if (!dropped && (r.request().postData() || '').includes('apply_schedule_changes')) { dropped = true; await r.fetch(); return r.abort(); }
    r.continue();
  });
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-14'), 'day', ['d2']); save(); });
  await A.page.waitForFunction(() => _saveInFlight); await A.page.waitForTimeout(400);      // request applied, reply lost
  await A.page.evaluate(o => { setAssignedForShift(parseDateKey('2026-11-14'), 'day', o); save(); }, o15.replace(/[{}]/g, '').split(',').filter(Boolean));
  await settle(A.page); await A.page.unroute('**/api');
  ok('RV11 lost reply then undone locally: server ends at the user\'s final value', srv('2026-11-14', 'day') === o15, `server=${srv('2026-11-14', 'day')} want=${o15}`);

  ok('RV-final 0 differences between old and new storage', sql('select count(*) from _cells_vs_blob()') === '0');
  ok('RV-final no JavaScript errors', A.page.errors.length === 0, A.page.errors.join(' | '));
  console.log(out.join('\n'));
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.error('CRASH', e.message); process.exit(1); });
