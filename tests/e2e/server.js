// Local stand-in for Supabase: serves the app and runs its calls against the test
// Postgres AS the logged-in user (role authenticated + auth.uid()), so RLS and the
// database functions are exercised exactly as in production.
const http = require('http'), fs = require('fs'), path = require('path');
const { Pool } = require(process.env.PG_MODULE || 'pg');
const pool = new Pool({ host: '/var/tmp/pgt', port: 5499, user: 'postgres', database: process.env.DB || 'p1' });
pool.on('error', () => {});   // the test database is recreated between runs
const APP = process.env.APP_DIR || path.resolve(__dirname, '../..');
const ident = s => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error('bad ident ' + s); return '"' + s + '"'; };

async function run(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('test.uid', $1, true)", [uid || '']);
    await c.query('set local role authenticated');
    const data = await fn(c);
    await c.query('commit');
    return { data, error: null };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    return { data: null, error: { message: e.message, code: e.code } };
  } finally { c.release(); }
}

async function handle(b) {
  if (b.kind === 'rpc') return run(b.uid, async c => {
    const meta = await c.query("select proretset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace", [b.fn]);
    if (!meta.rows.length) throw Object.assign(new Error(`Could not find the function public.${b.fn}`), { code: 'PGRST202' });
    const keys = Object.keys(b.args || {});
    const args = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ');
    const vals = keys.map(k => { const v = b.args[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
    if (meta.rows[0].proretset) {
      const r = await c.query(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as r from public.${ident(b.fn)}(${args}) t`, vals);
      return r.rows[0].r;
    }
    const r = await c.query(`select to_jsonb(public.${ident(b.fn)}(${args})) as r`, vals);
    return r.rows[0].r;
  });
  if (b.kind === 'select') return run(b.uid, async c => {
    const cols = b.columns === '*' ? '*' : b.columns.split(',').map(x => ident(x.trim())).join(', ');
    const where = [], vals = [];
    (b.filters || []).forEach(f => {
      if (f.op === 'eq') { vals.push(f.val); where.push(`${ident(f.col)} = $${vals.length}`); }
      if (f.op === 'in') { vals.push(f.val); where.push(`${ident(f.col)} = any($${vals.length})`); }
      if (f.op === 'gte') { vals.push(f.val); where.push(`${ident(f.col)} >= $${vals.length}`); }
    });
    const order = b.order ? ` order by ${ident(b.order.col)} ${b.order.asc === false ? 'desc' : 'asc'}` : '';
    const r = await c.query(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as r from (select ${cols} from public.${ident(b.table)}${where.length ? ' where ' + where.join(' and ') : ''}${order}) t`, vals);
    const rows = r.rows[0].r;
    if (b.single) { if (rows.length !== 1) throw new Error('JSON object requested, multiple (or no) rows returned'); return rows[0]; }
    return rows;
  });
  if (b.kind === 'upsert') return run(b.uid, async c => {
    for (const row of b.rows) {
      await c.query(`insert into public.${ident(b.table)} (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [row.key, JSON.stringify(row.value)]);
    }
    return null;
  });
  if (b.kind === 'insert') return run(b.uid, async c => {
    for (const row of b.rows) {
      const cols = Object.keys(row);
      await c.query(`insert into public.${ident(b.table)} (${cols.map(ident).join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`,
        cols.map(k => row[k] !== null && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k]));
    }
    return null;
  });
  if (b.kind === 'delete') return run(b.uid, async c => {
    const f = b.filters[0];
    const op = { lt: '<', eq: '=' }[f.op];
    const r = await c.query(`delete from public.${ident(b.table)} where ${ident(f.col)} ${op} $1`, [f.val]);
    return { deleted: r.rowCount };
  });
  if (b.kind === 'update') return run(b.uid, async c => {
    const sets = Object.keys(b.values), vals = sets.map(k => b.values[k]);
    vals.push(b.filters[0].val);
    await c.query(`update public.${ident(b.table)} set ${sets.map((k, i) => `${ident(k)} = $${i + 1}`).join(', ')} where ${ident(b.filters[0].col)} = $${vals.length}`, vals);
    return null;
  });
  return { data: null, error: { message: 'unsupported ' + b.kind } };
}

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      const out = await handle(JSON.parse(body));
      if (process.env.LOG) console.log(JSON.parse(body).kind, JSON.parse(body).fn || JSON.parse(body).table, out.error ? 'ERR ' + out.error.message : 'ok');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
    });
    return;
  }
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const file = p === '/fake-supabase.js' ? path.join(__dirname, 'fake-supabase.js') : path.join(APP, p);
  fs.readFile(file, (e, d) => {
    if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(d);
  });
}).listen(8787, () => console.log('listening 8787'));
