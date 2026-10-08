// Minimal supabase-js stand-in: same call shapes the app uses, sent to /api.
(function () {
  const uid = new URLSearchParams(location.search).get('uid') || '00000000-0000-0000-0000-00000000000a';
  const call = body => fetch('/api', { method: 'POST', body: JSON.stringify({ uid, ...body }) }).then(r => r.json());
  function builder(table) {
    const st = { table, filters: [] };
    const q = {
      select(cols) { st.kind = st.kind || 'select'; st.columns = cols || '*'; return q; },
      eq(col, val) { st.filters.push({ op: 'eq', col, val }); return q; },
      in(col, val) { st.filters.push({ op: 'in', col, val }); return q; },
      order(col, o) { st.order = { col, asc: !(o && o.ascending === false) }; return q; },
      single() { st.single = true; return q; },
      upsert(rows) { st.kind = 'upsert'; st.rows = Array.isArray(rows) ? rows : [rows]; return q; },
      update(values) { st.kind = 'update'; st.values = values; return q; },
      insert(row) { st.kind = 'insert'; st.rows = Array.isArray(row) ? row : [row]; return q; },
      delete() { st.kind = 'delete'; return q; },
      lt(col, val) { st.filters.push({ op: 'lt', col, val }); return q; },
      gte(col, val) { st.filters.push({ op: 'gte', col, val }); return q; },
      limit(n) { st.limit = n; return q; },
      then(res, rej) { return call(st).then(res, rej); },
    };
    return q;
  }
  window.supabase = {
    createClient() {
      const session = { user: { id: uid, email: uid + '@test' }, access_token: 't' };
      return {
        auth: {
          getSession: async () => ({ data: { session } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: async () => ({ error: null }),
          signInWithPassword: async () => ({ error: null }),
        },
        from: builder,
        rpc: (fn, args) => ({ then(res, rej) { return call({ kind: 'rpc', fn, args }).then(res, rej); } }),
      };
    },
  };
})();
