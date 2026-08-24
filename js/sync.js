// ---------------------------------------------------------------------------
// sync.js — the sync engine. Edits go to IndexedDB + outbox synchronously,
// then push to Supabase when connectivity allows. Pull refreshes the local
// snapshot. The append-only audit_change_log on the server is the data-loss
// backstop: every field change is recorded with who/when/old/new.
// ---------------------------------------------------------------------------
let sb = null;              // supabase client
let _session = null;
const listeners = new Set(); // state-change callbacks -> re-render / status

function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit(evt) { listeners.forEach((cb) => { try { cb(evt); } catch (e) { console.error(e); } }); }

function client() {
  if (!sb) {
    sb = window.supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'wca-auth' }
    });
  }
  return sb;
}

// ---- auth ---------------------------------------------------------------
async function getSession() {
  const { data } = await client().auth.getSession();
  _session = data.session;
  return _session;
}
function userEmail() { return _session && _session.user ? (_session.user.email || '').toLowerCase() : null; }

async function sendMagicLink(email) {
  const redirect = window.location.origin + window.location.pathname;
  return client().auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: redirect } });
}
async function signOut() { await client().auth.signOut(); _session = null; emit({ type: 'auth' }); }

// Whitelist gate — returns true only if the signed-in email is in audit_allowed_emails.
async function isAllowed() {
  try {
    const { data, error } = await client().rpc('audit_is_allowed');
    if (error) return false;
    return !!data;
  } catch { return false; }
}

// ---- pull ---------------------------------------------------------------
async function pull() {
  if (!navigator.onLine) return { ok: false, reason: 'offline' };
  const c = client();
  const [tanksRes, wellsRes, prodRes] = await Promise.all([
    c.from('audit_tanks').select('*'),
    c.from('audit_wells').select('*'),
    c.from('audit_products').select('*'),
  ]);
  if (tanksRes.error || wellsRes.error || prodRes.error) {
    return { ok: false, reason: (tanksRes.error || wellsRes.error || prodRes.error).message };
  }
  // Replace snapshot, then re-overlay any still-pending local edits so the
  // UI never "loses" an unsynced change during a pull.
  await DB.clear('tanks'); await DB.putMany('tanks', tanksRes.data);
  await DB.clear('wells'); await DB.putMany('wells', wellsRes.data);
  await DB.clear('products'); await DB.putMany('products', prodRes.data);
  await overlayOutbox();
  await DB.setMeta('lastPull', new Date().toISOString());
  emit({ type: 'data' });
  return { ok: true };
}

// Re-apply pending outbox payloads onto the local snapshot (post-pull safety).
async function overlayOutbox() {
  const items = await DB.outbox();
  for (const m of items) {
    if (m.op === 'update_tank') { const r = await DB.get('tanks', m.entityId); if (r) await DB.put('tanks', { ...r, ...m.payload }); }
    else if (m.op === 'update_well' || m.op === 'detach_well' || m.op === 'attach_well') {
      const r = await DB.get('wells', m.entityId); if (r) await DB.put('wells', { ...r, ...m.payload });
      else if (m.op === 'attach_well') await DB.put('wells', m.payload);
    } else if (m.op === 'insert_product') {
      const existing = await DB.get('products', m.entityId); if (!existing) await DB.put('products', m.payload);
    }
  }
}

// ---- push ---------------------------------------------------------------
let _pushing = false;
async function push() {
  if (_pushing) return { ok: true, busy: true };
  if (!navigator.onLine) return { ok: false, reason: 'offline' };
  _pushing = true;
  emit({ type: 'sync-start' });
  try {
    const c = client();
    let items = await DB.outbox();
    items.sort((a, b) => a.localId - b.localId); // preserve order
    for (const m of items) {
      if (m.blocked) continue; // poison mutation, kept for inspection, skipped
      try {
        await applyMutation(c, m);
        await writeChangeLog(c, m);
        await DB.dequeue(m.localId);
      } catch (err) {
        m.attempts = (m.attempts || 0) + 1;
        m.lastError = String(err && err.message ? err.message : err);
        const networkish = /network|fetch|Failed to fetch|timeout/i.test(m.lastError);
        if (!networkish && m.attempts >= 5) m.blocked = true; // don't let one bad row wedge the queue
        await DB.put('outbox', m);
        if (networkish) break; // stop the run; retry later, order preserved
      }
    }
    const remaining = (await DB.outbox()).filter((x) => !x.blocked).length;
    emit({ type: 'sync-end', pending: remaining });
    return { ok: true, pending: remaining };
  } finally { _pushing = false; }
}

async function applyMutation(c, m) {
  if (m.op === 'update_tank') {
    const { error } = await c.from('audit_tanks').update(m.payload).eq('id', m.entityId);
    if (error) throw error;
  } else if (m.op === 'update_well' || m.op === 'detach_well' || m.op === 'attach_well') {
    if (m.op === 'attach_well') {
      const { error } = await c.from('audit_wells').upsert(m.payload, { onConflict: 'id' });
      if (error) throw error;
    } else {
      const { error } = await c.from('audit_wells').update(m.payload).eq('id', m.entityId);
      if (error) throw error;
    }
  } else if (m.op === 'insert_product') {
    const { error } = await c.from('audit_products').upsert(m.payload, { onConflict: 'code', ignoreDuplicates: true });
    if (error) throw error;
  }
}

async function writeChangeLog(c, m) {
  if (!m.changes || !m.changes.length) return;
  const rows = m.changes.map((ch) => ({
    entity_type: m.entity, entity_id: m.entityId,
    tgl_slot: m.meta && m.meta.tgl_slot || null,
    accounting_id: m.meta && m.meta.accounting_id || null,
    op: m.logOp || 'update', field: ch.field,
    old_value: ch.old == null ? null : String(ch.old),
    new_value: ch.new == null ? null : String(ch.new),
    changed_by: m.userEmail || null, client_ts: m.clientTs, device_id: m.deviceId,
  }));
  const { error } = await c.from('audit_change_log').insert(rows);
  if (error) throw error;
}

async function fullSync() {
  const p = await push();
  const q = await pull();
  return { push: p, pull: q };
}

// ---- edit API (called by the UI) ---------------------------------------
// Each edit: (1) update local snapshot immediately, (2) enqueue durable
// mutation, (3) fire a background sync if online. Nothing blocks on network.
async function enqueueAndSync(mutation) {
  mutation.clientTs = new Date().toISOString();
  mutation.userEmail = userEmail();
  mutation.deviceId = await getDeviceId();
  await DB.enqueue(mutation);
  emit({ type: 'queued' });
  if (navigator.onLine) push();
}

async function editTank(tankId, changes /* {field:newValue} */) {
  const cur = await DB.get('tanks', tankId);
  const diff = [];
  for (const [f, v] of Object.entries(changes)) {
    if ((cur ? cur[f] : null) !== v) diff.push({ field: f, old: cur ? cur[f] : null, new: v });
  }
  if (!diff.length) return;
  const updated = { ...cur, ...changes };
  await DB.put('tanks', updated);
  await enqueueAndSync({
    op: 'update_tank', entity: 'tank', entityId: tankId,
    payload: changes, changes: diff, meta: { tgl_slot: cur.tgl_slot },
  });
}

async function editWell(wellId, changes) {
  const cur = await DB.get('wells', wellId);
  const diff = [];
  for (const [f, v] of Object.entries(changes)) {
    if ((cur ? cur[f] : null) !== v) diff.push({ field: f, old: cur ? cur[f] : null, new: v });
  }
  if (!diff.length) return;
  const tank = cur ? await DB.get('tanks', cur.tank_id) : null;
  await DB.put('wells', { ...cur, ...changes });
  await enqueueAndSync({
    op: 'update_well', entity: 'well', entityId: wellId,
    payload: changes, changes: diff,
    meta: { tgl_slot: tank ? tank.tgl_slot : null, accounting_id: cur.accounting_id },
  });
}

async function attachWell(tankId, fields /* {accounting_id, asset_name, foreman, pump_make, pump_sn} */) {
  const tank = await DB.get('tanks', tankId);
  const row = {
    id: crypto.randomUUID(), tank_id: tankId, accounting_id: fields.accounting_id || null,
    asset_name: fields.asset_name || null, foreman: fields.foreman || (tank ? tank.foreman : null),
    pump_make: fields.pump_make || null, pump_sn: fields.pump_sn || null,
    is_attached: true, is_deleted: false, source: 'field',
  };
  await DB.put('wells', row);
  await enqueueAndSync({
    op: 'attach_well', entity: 'well', entityId: row.id, payload: row, logOp: 'attach',
    changes: [{ field: 'accounting_id', old: null, new: row.accounting_id }],
    meta: { tgl_slot: tank ? tank.tgl_slot : null, accounting_id: row.accounting_id },
  });
  return row;
}

async function detachWell(wellId) {
  const cur = await DB.get('wells', wellId);
  const tank = cur ? await DB.get('tanks', cur.tank_id) : null;
  await DB.put('wells', { ...cur, is_attached: false });
  await enqueueAndSync({
    op: 'detach_well', entity: 'well', entityId: wellId, payload: { is_attached: false }, logOp: 'detach',
    changes: [{ field: 'is_attached', old: true, new: false }],
    meta: { tgl_slot: tank ? tank.tgl_slot : null, accounting_id: cur.accounting_id },
  });
}

async function addCustomProduct(code) {
  code = (code || '').trim();
  if (!code) return null;
  const all = await DB.getAll('products');
  const existing = all.find((p) => (p.code || '').toLowerCase() === code.toLowerCase());
  if (existing) return existing;
  const row = { id: crypto.randomUUID(), code, is_custom: true, active: true, created_by: userEmail() };
  await DB.put('products', row);
  await enqueueAndSync({
    op: 'insert_product', entity: 'product', entityId: row.id, payload: row, logOp: 'create',
    changes: [{ field: 'code', old: null, new: code }], meta: {},
  });
  return row;
}

async function pendingCount() { return (await DB.outbox()).filter((x) => !x.blocked).length; }
async function blockedCount() { return (await DB.outbox()).filter((x) => x.blocked).length; }

window.Sync = {
  client, onChange, getSession, userEmail, sendMagicLink, signOut, isAllowed,
  pull, push, fullSync, editTank, editWell, attachWell, detachWell, addCustomProduct,
  pendingCount, blockedCount,
  onAuthStateChange: (cb) => client().auth.onAuthStateChange((_e, s) => { _session = s; cb(s); }),
};

// Auto-sync when connectivity returns.
window.addEventListener('online', () => { emit({ type: 'online' }); push(); });
window.addEventListener('offline', () => emit({ type: 'offline' }));
