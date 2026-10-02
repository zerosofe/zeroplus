// نسخة وهمية من عميل Supabase لمحاكاة REST/PostgREST بدقة كافية للاختبار
export const TABLE_COLUMNS = {
  profiles: ['id', 'device_id', 'user_name', 'department', 'xp', 'total_focus_mins',
    'current_section_id', 'unlocked_stage_max', 'streak_count', 'last_active', 'created_at',
    'password_hash', 'auth_provider', 'email', 'avatar_url', 'node_crowns', 'learning_track'],
  user_tasks: ['id', 'device_id', 'title', 'done', 'tag', 'prio', 'created_at', 'updated_at'],
  user_focus_sessions: ['id', 'device_id', 'session_name', 'duration_mins', 'session_time', 'created_at'],
  user_node_progress: ['id', 'device_id', 'node_id', 'completed', 'score', 'updated_at'],
  user_word_mastery: ['id', 'device_id', 'term_key', 'mastered', 'mistake_count', 'next_review_at', 'updated_at'],
};

function defaultsFor(table) {
  const now = new Date().toISOString();
  if (table === 'user_tasks') return { done: false, tag: '', prio: 'normal', created_at: now, updated_at: now };
  if (table === 'user_focus_sessions') return { duration_mins: 25, created_at: now };
  if (table === 'profiles') return { department: 'general', xp: 0, total_focus_mins: 0, created_at: now };
  return { created_at: now };
}

class Query {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.filters = [];
    this.op = null;
    this.payload = null;
    this.conflict = null;
    this.limitN = null;
    this.orderBy = null;
    this.single = false;
  }
  select() { this.op = this.op || 'select'; return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  upsert(p, opts) { this.op = 'upsert'; this.payload = p; this.conflict = (opts && opts.onConflict) || 'id'; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, val) { this.filters.push([col, val]); return this; }
  order(col, opts) { this.orderBy = { col, ascending: !(opts && opts.ascending === false) }; return this; }
  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.single = 'maybe'; return this; }
  single() { this.single = 'one'; return this; }
  then(res, rej) { return this.exec().then(res, rej); }

  _validate(payload) {
    if (payload === null || payload === undefined) return null;   // عمليات الحذف بلا payload
    const cols = TABLE_COLUMNS[this.table] || [];
    for (const row of (Array.isArray(payload) ? payload : [payload])) {
      for (const k of Object.keys(row)) {
        if (!cols.includes(k)) {
          return {
            code: 'PGRST204',
            message: `Could not find the '${k}' column of '${this.table}' in the schema cache`,
          };
        }
      }
    }
    return null;
  }
  _matches(row) {
    return this.filters.every(([c, v]) => String(row[c]) === String(v));
  }
  _conflictCols() { return String(this.conflict || 'id').split(',').map(s => s.trim()); }
  _keyOf(row) { return this._conflictCols().map(c => String(row[c])).join('\u0001'); }

  async exec() {
    const st = this.state;
    const failure = st.failures[this.table] || st.failures.all;
    st.calls.push({ table: this.table, op: this.op, payload: this.payload, filters: this.filters, conflict: this.conflict });
    if (failure) {
      return { data: null, error: { code: '42501', message: failure } };
    }
    const rows = st.tables[this.table] || (st.tables[this.table] = []);

    if (this.op === 'select') {
      let out = rows.filter(r => this._matches(r)).map(r => ({ ...r }));
      if (this.orderBy) {
        const { col, ascending } = this.orderBy;
        out.sort((a, b) => (a[col] === b[col] ? 0 : (a[col] > b[col] ? 1 : -1)) * (ascending ? 1 : -1));
      }
      if (this.limitN != null) out = out.slice(0, this.limitN);
      if (this.single) out = out.length ? out[0] : null;
      return { data: out, error: null };
    }

    const invalid = this._validate(this.payload);
    if (invalid) return { data: null, error: invalid };

    if (this.op === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const item of items) {
        const row = { ...defaultsFor(this.table), ...item };
        rows.push(row);
      }
      return { data: null, error: null };
    }

    if (this.op === 'upsert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const item of items) {
        const key = this._keyOf(item);
        const existing = rows.find(r => this._keyOf(r) === key);
        if (existing) Object.assign(existing, item);
        else rows.push({ ...defaultsFor(this.table), ...item });
      }
      return { data: null, error: null };
    }

    if (this.op === 'update') {
      rows.filter(r => this._matches(r)).forEach(r => Object.assign(r, this.payload));
      return { data: null, error: null };
    }

    if (this.op === 'delete') {
      const keep = rows.filter(r => !this._matches(r));
      st.deletedRows.push(...rows.filter(r => this._matches(r)).map(r => ({ table: this.table, row: { ...r } })));
      st.tables[this.table] = keep;
      return { data: null, error: null };
    }

    return { data: null, error: { message: 'op غير مدعوم: ' + this.op } };
  }
}

export function createMockSupabase() {
  const state = {
    tables: { profiles: [], user_tasks: [], user_focus_sessions: [], user_node_progress: [], user_word_mastery: [] },
    failures: {},
    calls: [],
    deletedRows: [],
    session: null,
  };
  const client = {
    _state: state,
    from(table) { return new Query(state, table); },
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      signInWithOAuth: async () => { state.calls.push({ table: 'auth', op: 'oauth' }); return { data: {}, error: null }; },
      signOut: async () => { state.session = null; state.calls.push({ table: 'auth', op: 'signOut' }); return { error: null }; },
    },
  };
  return client;
}
