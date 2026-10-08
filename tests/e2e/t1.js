const { execSync } = require('child_process');
const { chromium, openApp, state, cell, settle, ADMIN, TAREF } = require('./lib');
const sql = q => execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

(async () => {
  execSync(__dirname + '/run-setup.sh');
  sql('alter table profiles add column if not exists created_at timestamptz default now()');
  execSync('psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -1 -f ' + __dirname + '/../../supabase/schedule-log-install.sql');
  execSync('psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -f ' + __dirname + '/../../supabase/schedule-log-cutover.sql');
  const browser = await chromium.launch();

  // S1 load in cells mode
  const A = await openApp(browser);
  const s1 = await state(A.page);
  check('S1 app loads in new mode with all shifts', s1.mode === 'cells' && s1.slots === 288 && !s1.dirty, JSON.stringify(s1));

  // S2 normal edit through the UI path (setAssignedForShift + save, as the app does)
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-04'), 'day', ['d2']); setSaveLabel('Edição'); save(); });
  await settle(A.page);
  check('S2 edit saved to cell, logged, old storage synced',
    sql("select people::text from schedule_cells where day='2026-11-04' and shift='day'") === '{d2}' &&
    sql("select count(*) from schedule_log where day='2026-11-04'") === '1' &&
    sql("select count(*) from _cells_vs_blob()") === '0');

  // S3 two admins: B has a stale copy and edits the same shift A changed
  const B = await openApp(browser);
  await B.page.evaluate(() => { stopAutoRefresh(); });             // keep B stale on purpose
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-05'), 'night', ['d1']); save(); });
  await settle(A.page);
  await B.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-05'), 'night', []); save(); });
  await settle(B.page);
  const bCell = await cell(B.page, '2026-11-05_night');
  check('S3 stale edit refused; A\'s change kept; B told and shows A\'s value',
    sql("select people::text from schedule_cells where day='2026-11-05' and shift='night'") === '{d1}' &&
    JSON.stringify(bCell) === '["d1"]' && B.page.dialogs.some(m => m.includes('alterados por outra pessoa')),
    `server=${sql("select people::text from schedule_cells where day='2026-11-05' and shift='night'")} B=${JSON.stringify(bCell)}`);

  // S4 lost response: server applies, client sees an error, retries -> applied once
  let dropped = false;
  await A.page.route('**/api', async route => {
    const body = route.request().postData() || '';
    if (!dropped && body.includes('apply_schedule_changes')) {
      dropped = true;
      await route.fetch();          // reaches the server…
      return route.abort();          // …but the reply is lost
    }
    return route.continue();
  });
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-06'), 'day', ['d1', 'd2', 'd1'].slice(0, 2).reverse()); save(); });
  await settle(A.page);
  await A.page.unroute('**/api');
  check('S4 retry after lost reply applied exactly once',
    sql("select count(*) from schedule_log where day='2026-11-06' and shift='day'") === '1' &&
    sql("select people::text from schedule_cells where day='2026-11-06' and shift='day'") === '{d2,d1}' &&
    !(await state(A.page)).dirty, `log rows=${sql("select count(*) from schedule_log where day='2026-11-06' and shift='day'")} cell=${sql("select people::text from schedule_cells where day='2026-11-06' and shift='day'")} state=${JSON.stringify(await state(A.page))} dropped=${dropped}`);

  // S5 old phone: pending local copy made BEFORE A's edits, replayed on open
  const C = await openApp(browser, ADMIN, {
    beforeLoad: async page => {
      // build a cache as an old phone would have: base = today's start, one own edit, then offline
      await page.addInitScript(() => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        window.__seedCache = true;
      });
    },
  });
  const oldBase = await C.page.evaluate(() => {
    // pretend this phone's copy is from before S2/S3/S4 and it removed 2026-11-07 day offline
    const base = JSON.parse(JSON.stringify(schedules));
    setCellIn(base, '2026-11-04_day', ['d1', 'd2']);
    setCellIn(base, '2026-11-05_night', ['d1', 'd2']);
    setCellIn(base, '2026-11-06_day', ['d1', 'd2']);
    const mine = JSON.parse(JSON.stringify(base));
    setCellIn(mine, '2026-11-07_day', []);
    const b = {}; Object.keys(DATA_KEYS).forEach(k => { b[k] = JSON.stringify(DATA_KEYS[k].get() ?? null); });
    b.chbv_schedules = JSON.stringify(base);
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({ version: 2, timestamp: Date.now() - 60000, pending: true,
      doctors, schedules: mine, terceiros, rotations: rotationGrid, base: b }));
    return true;
  });
  await C.page.reload(); await C.page.waitForTimeout(1500); await settle(C.page);
  check('S5 old phone replay: only its own edit applied, newer work untouched',
    sql("select people::text from schedule_cells where day='2026-11-07' and shift='day'") === '{}' &&
    sql("select people::text from schedule_cells where day='2026-11-04' and shift='day'") === '{d2}' &&
    sql("select people::text from schedule_cells where day='2026-11-05' and shift='night'") === '{d1}' &&
    sql("select people::text from schedule_cells where day='2026-11-06' and shift='day'") === '{d2,d1}');

  // S6 clear a month -> safety backup + one logged group -> undo from the history window
  await A.page.evaluate(() => { currentSchedMonth = 11 - 1; currentSchedYear = 2026; renderSchedule(); });
  await A.page.evaluate(() => document.getElementById('clear-week-btn').click());
  await settle(A.page);
  const afterClear = sql("select coalesce(sum(cardinality(people)),0) from schedule_cells where day between '2026-11-01' and '2026-11-30'");
  check('S6a clear month removed November, backup made first',
    afterClear === '0' && sql("select reason from app_data_history order by id desc limit 1").startsWith('Antes de limpar mês'), `nov slots=${afterClear} left=${sql("select string_agg(day||' '||shift||' '||people::text, '; ') from schedule_cells where day between '2026-11-01' and '2026-11-30' and cardinality(people)>0")} dialogs=${JSON.stringify(A.page.dialogs.slice(-2))}`);
  await A.page.evaluate(() => openHistoryModal());
  await A.page.waitForSelector('#history-content button:has-text("Desfazer")');
  await A.page.click('#history-content button:has-text("Desfazer") >> nth=0');
  await A.page.waitForTimeout(1500); await settle(A.page);
  const afterUndo = sql("select coalesce(sum(cardinality(people)),0) from schedule_cells where day between '2026-11-01' and '2026-11-30'");
  const uiSlots = await A.page.evaluate(() => Object.entries(flattenSchedule(schedules)).filter(([k]) => k.startsWith('2026-11')).reduce((a, [, v]) => a + v.length, 0));
  check('S6b Desfazer brings November back (server and screen)', afterUndo === uiSlots.toString() && Number(afterUndo) > 60, `server=${afterUndo} screen=${uiSlots}`);

  // S7 Voltar a antes disto: back to before S2
  await A.page.evaluate(() => openHistoryModal());
  await A.page.waitForSelector('#history-content button:has-text("Voltar a antes disto")');
  const n = await A.page.locator('#history-content button:has-text("Voltar a antes disto")').count();
  await A.page.locator('#history-content button:has-text("Voltar a antes disto")').nth(n - 1).click();
  await A.page.waitForTimeout(1500); await settle(A.page);
  check('S7 "Voltar a antes disto" (oldest) restores the original schedule exactly',
    sql("select count(*) from (select day, shift, people from schedule_cells where cardinality(people)>0 except select day, shift, people from _blob_cells((select value::jsonb from app_data_archive where note='Antes da instalação da Fase 1' and key='chbv_schedules' limit 1))) x") === '0' &&
    sql("select sum(cardinality(people)) from schedule_cells") === '288');

  // S8 tarefeiro: cannot change the schedule, availability still saves
  const T = await openApp(browser, TAREF);
  await T.page.evaluate(() => { terceiros = [{ id: 't', name: 'T', monthlyAvailability: { '2026-11-20': { day: true } } }]; save(); });
  await settle(T.page);
  check('S8 tarefeiro availability saved, schedule untouched',
    sql("select value::text from app_data where key='chbv_terceiros'").includes('2026-11-20') && sql("select sum(cardinality(people)) from schedule_cells") === '288');

  // S9 device on Cyprus time sees exactly the same schedule
  const K = await openApp(browser, ADMIN, { tz: 'Asia/Nicosia' });
  const k = await state(K.page);
  check('S9 Cyprus-time device sees the same 288 slots', k.slots === 288, JSON.stringify(k));


  // S12 restore a backup from the Histórico window (cells mode): logged, undoable
  const firstBackup = sql("select id from app_data_history where reason like 'Cópia inicial%' order by id limit 1");
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-10'), 'day', ['d1']); save(); });
  await settle(A.page);
  await A.page.evaluate(id => restoreHistory(Number(id)), firstBackup);
  await A.page.waitForTimeout(1500); await settle(A.page);
  check('S12 restore from Histórico: schedule = backup, logged, screen updated',
    sql("select count(*) from (select day, shift, people from schedule_cells where cardinality(people)>0 except select * from _blob_cells((select schedules::jsonb from app_data_history where id=" + firstBackup + "))) x") === '0' &&
    sql("select count(*) from schedule_log where label like 'Restaurar cópia%'") !== '0' &&
    (await state(A.page)).slots === Number(sql("select sum(cardinality(people)) from schedule_cells")), JSON.stringify(A.page.dialogs.slice(-3)));

  // S13 Auto-preencher on November: one labelled group, consistent
  await A.page.evaluate(() => { currentSchedMonth = 10; currentSchedYear = 2026; renderSchedule(); document.getElementById('auto-fill-btn').click(); });
  await A.page.waitForTimeout(500); await settle(A.page);
  check('S13 Auto-preencher saved as one logged group, no differences',
    sql("select count(distinct batch_id) from schedule_log where label='Auto-preencher'") <= '1' &&
    sql('select count(*) from _cells_vs_blob()') === '0' && !(await state(A.page)).dirty,
    `groups=${sql("select count(distinct batch_id) from schedule_log where label='Auto-preencher'")} rows=${sql("select count(*) from schedule_log where label='Auto-preencher'")}`);

  // S14 fast edits while a save is in flight: nothing lost
  await A.page.evaluate(async () => {
    setAssignedForShift(parseDateKey('2026-11-11'), 'day', ['d1']); save();
    await new Promise(r => setTimeout(r, 450));        // first save now in flight
    setAssignedForShift(parseDateKey('2026-11-11'), 'night', ['d2']); save();
    setAssignedForShift(parseDateKey('2026-11-13'), 'day', ['d2', 'd1']); save();
  });
  await A.page.waitForTimeout(800); await settle(A.page);
  check('S14 edits made during a save all reach the server',
    sql("select string_agg(shift||'='||people::text, ',' order by day, shift) from schedule_cells where (day='2026-11-11') or (day='2026-11-13' and shift='day')") === 'day={d1},night={d2},day={d2,d1}' && !(await state(A.page)).dirty,
    sql("select string_agg(day||shift||'='||people::text, ',' order by day, shift) from schedule_cells where (day='2026-11-11') or (day='2026-11-13' and shift='day')"));

  // S15 remove a doctor: removed from every shift, one group, backup first
  const d2before = sql("select count(*) from schedule_cells where 'd2' = any(people)");
  await A.page.evaluate(() => deleteDoctor('d2'));
  await A.page.waitForTimeout(500); await settle(A.page);
  check('S15 remove doctor: gone from all shifts, logged, backup made',
    sql("select count(*) from schedule_cells where 'd2' = any(people)") === '0' &&
    sql("select count(*) from schedule_log where label='Remover médico'") === d2before &&
    sql("select count(*) from app_data_history where reason like 'Antes de remover%'") !== '0', `cells with d2 before=${d2before}`);
  // and undo it from the list
  await A.page.evaluate(() => openHistoryModal());
  await A.page.waitForSelector('#history-content button:has-text("Desfazer")');
  await A.page.click('#history-content button:has-text("Desfazer") >> nth=0');
  await A.page.waitForTimeout(1500); await settle(A.page);
  check('S15b undo puts the doctor back in all those shifts', sql("select count(*) from schedule_cells where 'd2' = any(people)") === d2before);

  // S16 roll back to the old system while the app is open: app reloads and keeps working
  execSync('psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -f ' + __dirname + '/../../supabase/schedule-log-rollback.sql');
  await A.page.evaluate(() => refreshFromServer()).catch(() => {});
  await A.page.waitForTimeout(2500);
  await A.page.waitForFunction(() => typeof currentRole !== 'undefined' && currentRole !== null);
  const sb = await state(A.page);
  await A.page.evaluate(() => { setAssignedForShift(parseDateKey('2026-11-12'), 'day', ['d1']); save(); });
  await settle(A.page);
  check('S16 after rollback the app runs in old mode and saves to the old storage',
    sb.mode === 'blob' && sql("select (value::jsonb->'2026-11-09'->'2026-11-12_day')::text from app_data where key='chbv_schedules'") === '["d1"]', JSON.stringify(sb));

  // re-enable the new mode (as the cutover script would) to check the final state
  execSync('psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -f ' + __dirname + '/../../supabase/schedule-log-cutover.sql');
  // S10 everything consistent at the end
  check('S10 old storage identical to the new one (0 differences)', sql('select count(*) from _cells_vs_blob()') === '0');
  const errs = [A, B, C, T, K].flatMap(x => x.page.errors);
  check('S11 no JavaScript errors in any browser', errs.length === 0, errs.join(' | '));

  console.log(results.join('\n'));
  await browser.close();
})().catch(e => { console.log(results.join('\n')); console.error('CRASH', e); process.exit(1); });
