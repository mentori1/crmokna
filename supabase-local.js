(function () {
    const request = async (url, options = {}) => {
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
            ...options,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = { message: payload.error || `HTTP ${response.status}`, code: payload.code || String(response.status) };
            return { data: null, error };
        }
        return { data: payload.data ?? payload, error: null };
    };

    class Query {
        constructor(table) { this.table = table; this.action = 'select'; this.filters = []; this.body = {}; }
        select(spec = '*') { this.body.select = spec; this.body.nested_items = /order_items/.test(spec); return this; }
        is(column, value) { this.filters.push({ column, op: 'is', value }); return this; }
        eq(column, value) { this.filters.push({ column, op: 'eq', value }); return this; }
        range(from, to) { this.body.offset = from; this.body.limit = to - from + 1; return this; }
        insert(rows) { this.action = 'insert'; this.body.rows = rows; return this; }
        update(values) { this.action = 'update'; this.body.values = values; return this; }
        delete() { this.action = 'delete'; return this; }
        upsert(rows, opts = {}) { this.action = 'upsert'; this.body.rows = rows; this.body.on_conflict = opts.onConflict; return this; }
        async maybeSingle() {
            const result = await this.execute();
            if (!result.error) result.data = Array.isArray(result.data) ? (result.data[0] || null) : result.data;
            return result;
        }
        async execute() {
            return request('/api/query', { method: 'POST', body: JSON.stringify({ table: this.table, action: this.action, filters: this.filters, ...this.body }) });
        }
        then(resolve, reject) { return this.execute().then(resolve, reject); }
    }

    const auth = {
        async getSession() {
            const response = await request('/api/session');
            return { data: { session: response.error ? null : response.data.session }, error: response.error };
        },
        async signInWithPassword({ email, password }) {
            const response = await request('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
            return { data: response.data, error: response.error };
        },
        async signOut() { return request('/api/logout', { method: 'POST', body: '{}' }); },
    };

    function createClient() {
        let revision = null;
        let revisionHandler = null;
        let polling = false;
        const poll = async () => {
            if (polling) return;
            polling = true;
            try {
                const response = await request('/api/revision');
                const next = response.error ? null : response.data.revision;
                if (revision !== null && next !== null && next !== revision && revisionHandler) revisionHandler(next);
                if (next !== null) revision = next;
            } finally { polling = false; }
        };
        return {
            auth,
            from: table => new Query(table),
            rpc: (name, args) => {
                if (name === 'create_order') return request('/api/rpc/create_order', { method: 'POST', body: JSON.stringify({ order: args.p_order, items: args.p_items }) });
                if (name === 'replace_order_items') return request('/api/rpc/replace_order_items', { method: 'POST', body: JSON.stringify({ order_id: args.p_order_id, items: args.p_items }) });
                if (name === 'delete_order') return request('/api/rpc/delete_order', { method: 'POST', body: JSON.stringify({ order_id: args.p_order_id, version: args.p_version }) });
                return Promise.resolve({ data: null, error: { message: 'Unknown RPC', code: '404' } });
            },
            onRevision(handler) {
                revisionHandler = handler;
                poll();
                setInterval(poll, 5000);
            },
            channel() { return { on() { return this; }, subscribe() { return this; } }; },
        };
    }
    window.supabase = { createClient };
})();
