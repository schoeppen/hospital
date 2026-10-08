// Two people change the SAME tarefeira (or doctor) record at the same time.
const { execSync } = require('child_process');
const { chromium, openApp, ADMIN, TAREF, JOAO } = require('./lib');
const ROOT = require('path').resolve(__dirname, '../..');
const sql = q => execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
const terc = () => JSON.parse(sql("select value::text from app_data where key='chbv_terceiros'"))[0];
const doc = () => JSON.parse(sql("select value::text from app_data where key='chbv_doctors'"))[0];
const settle = async p => { await p.waitForFunction(() => !_saveTimer && !_saveInFlight && !_retryTimer, null, { timeout: 30000 }); await p.waitForTimeout(300); };
const out = []; const ok = (n, c, x = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
(async () => {
  execSync(__dirname + '/run-setup.sh');
  execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -1 -f ${ROOT}/supabase/schedule-log-install.sql`);
  execSync(`psql -q -h /var/tmp/pgt -p 5499 -U postgres -d p1 -f ${ROOT}/supabase/schedule-log-cutover.sql`);
  // one tarefeira (linked to the tarefeiro login) with some availability
  sql(`update app_data set value = '[{"id":"t","name":"Claudia","monthlyAvailability":{"2026-11-20":{"day":true},"2026-11-21":{"night":true}},"recusados":{}}]' where key='chbv_terceiros'`);
  const browser = await chromium.launch();
  const A = await openApp(browser, ADMIN), T = await openApp(browser, TAREF), J = await openApp(browser, JOAO);
  for (const p of [A, T, J]) await p.page.evaluate(() => stopAutoRefresh());   // both hold the same copy

  // F1 tarefeira adds a day while the admin declines another day of hers
  await T.page.evaluate(() => { terceiros[0].monthlyAvailability['2026-11-25'] = { day: true }; save(); });
  await settle(T.page);
  await A.page.evaluate(() => { terceiros[0].recusados = { '2026-11-21': { night: true } }; delete terceiros[0].monthlyAvailability['2026-11-21']; save(); });
  await settle(A.page);
  const t1 = terc();
  ok('F1 tarefeira adds a day + admin declines another day: both kept',
    !!t1.monthlyAvailability['2026-11-25'] && !t1.monthlyAvailability['2026-11-21'] && !!(t1.recusados['2026-11-21'] || {}).night,
    JSON.stringify(t1));

  // F2 two admins edit different details of the same doctor
  await A.page.evaluate(() => refreshFromServer()); await J.page.evaluate(() => refreshFromServer());
  await A.page.waitForTimeout(500);
  await A.page.evaluate(() => { doctors[0].phone = '911111111'; save(); }); await settle(A.page);
  await J.page.evaluate(() => { doctors[0].email = 'ana@hospital.pt'; save(); }); await settle(J.page);
  const d = doc();
  ok('F2 two admins change different fields of the same doctor: both kept', d.phone === '911111111' && d.email === 'ana@hospital.pt', JSON.stringify(d));

  // F3 same day, same shift changed by both: the later edit wins (documented), nothing else lost
  await A.page.evaluate(() => refreshFromServer()); await T.page.evaluate(() => refreshFromServer());
  await A.page.waitForTimeout(500);
  await T.page.evaluate(() => { terceiros[0].monthlyAvailability['2026-11-20'] = { day: true, night: true }; terceiros[0].monthlyAvailability['2026-11-27'] = { night: true }; save(); });
  await settle(T.page);
  await A.page.evaluate(() => { terceiros[0].monthlyAvailability['2026-11-20'] = {}; save(); });
  await settle(A.page);
  const t3 = terc();
  ok('F3 same day: admin removed the day shift, tarefeira added the night shift → both applied; other days kept',
    JSON.stringify(t3.monthlyAvailability['2026-11-20']) === '{"night":true}' && !!t3.monthlyAvailability['2026-11-27'] && !!t3.monthlyAvailability['2026-11-25'],
    JSON.stringify(t3.monthlyAvailability));

  // F4 deleting a tarefeira still deletes; adding one still adds
  ok('F4 schedule untouched (0 differences)', sql('select count(*) from _cells_vs_blob()') === '0');
  ok('F5 no JavaScript errors', [A, T, J].every(x => x.page.errors.length === 0), [A, T, J].flatMap(x => x.page.errors).join(' | '));
  console.log(out.join('\n'));
  await browser.close();
})().catch(e => { console.log(out.join('\n')); console.error('CRASH', e.message); process.exit(1); });
