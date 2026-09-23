/* Cliente Supabase mínimo (solo lo que usa el dashboard) sobre la API REST real.
 *
 * Permite ejecutar js/data.js —y por tanto todo el dashboard— contra la base de
 * datos de verdad desde Node, sin navegador: emite exactamente las mismas
 * peticiones PostgREST (from().select().order().limit(), insert/update/delete y
 * rpc) que produce la librería oficial, pero implementadas con fetch, porque
 * Node ya no permite importar módulos desde una URL.
 *
 * Se usa solo en pruebas (tools/live-check.mjs). No forma parte del dashboard.
 */

export function createRestClient({ url, apikey, accessToken = null }) {
  const headers = () => ({
    apikey,
    Authorization: `Bearer ${accessToken || apikey}`,
    'Content-Type': 'application/json'
  });

  let lastError = null;

  async function request(path, { method = 'GET', body = null, prefer = null, headers: extra = {} } = {}) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: { ...headers(), ...(prefer ? { Prefer: prefer } : {}), ...extra },
      body: body === null ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (response.status >= 400) {
      const error = data && typeof data === 'object' ? data : { message: String(data || response.statusText) };
      lastError = { code: error.code || `HTTP_${response.status}`, message: error.message || 'Error desconocido', details: error.details || null, hint: error.hint || null };
      return { data: null, error: lastError, status: response.status };
    }
    lastError = null;
    return { data, error: null, status: response.status };
  }

  function builder(table) {
    const state = { filters: [], order: null, limit: null, method: 'GET', body: null, wantRows: false };
    const chain = {
      select(_columns = '*', options = {}) {
        if (state.method === 'GET' && _columns) state.columns = _columns;
        if (options.head || options.count) state.head = true;
        return chain;
      },
      order(column, { ascending = false, nullsFirst = false } = {}) {
        state.order = { column, ascending, nullsFirst };
        return chain;
      },
      limit(count) { state.limit = count; return chain; },
      eq(column, value) { state.filters.push([column, 'eq', value]); return chain; },
      insert(payload) { state.method = 'POST'; state.body = payload; return chain; },
      update(payload) { state.method = 'PATCH'; state.body = payload; return chain; },
      delete() { state.method = 'DELETE'; return chain; },
      then(resolvePromise, rejectPromise) { return execute().then(resolvePromise, rejectPromise); },
      catch(handler) { return execute().catch(handler); }
    };

    function queryString() {
      const params = new URLSearchParams();
      params.set('select', state.columns || '*');
      state.filters.forEach(([column, operator, value]) => params.append(column, `${operator}.${value}`));
      if (state.order) {
        params.set('order', state.order.column);
        if (!state.order.ascending) params.append('order', 'desc');
        if (state.order.nullsFirst) params.append('order', 'nullsfirst');
      }
      if (state.limit !== null) params.set('limit', String(state.limit));
      return params.toString();
    }

    async function execute() {
      const prefer = [];
      if (state.method !== 'GET' && state.body !== null) prefer.push('return=representation');
      if (state.head) prefer.push('count=exact');
      const result = await request(`${table}?${queryString()}`, {
        method: state.method,
        body: state.body,
        prefer: prefer.length ? prefer.join(',') : null,
        headers: state.head ? { Range: '0-0' } : {}
      });
      if (result.error) return { data: null, error: result.error, count: null };
      const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
      return { data: rows, error: null, count: rows.length };
    }

    return chain;
  }

  return {
    from: table => builder(table),
    async rpc(name, params = {}) {
      const response = await request(`rpc/${name}`, { method: 'POST', body: params });
      return { data: response.data, error: response.error };
    },
    auth: {
      async getSession() { return { data: { session: null }, error: null }; },
      async getUser() { return { data: { user: null }, error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async signOut() { return { error: null }; },
      async signInWithOtp() { return { error: null }; }
    },
    __lastError: () => lastError
  };
}
