// ---------------------------------------------------------------------------
// sync.js — sync engine, email-gate model (no Supabase Auth).
// The public anon key can ONLY call the SECURITY DEFINER RPCs
// (audit_login / audit_bootstrap / audit_apply); every RPC re-checks the
// email against the whitelist server-side. Tables are unreachable directly.
// Edits still go to IndexedDB + outbox first (offline durable), then push.
// ---------------------------------------------------------------------------
let sb = null;
let _email = null;
const listeners = new Set();

function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit(evt) { listeners.forEach((cb) => { try { cb(evt); } catch (e) { console.error(e); } }); }

function client() {
  if (!sb) sb = window.supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  return sb;
}

// ---- email gate ---------------------------------------------------------
const EMAIL_KEY = 'wca-email';
function getEmail() { if (_email === null) _email = localStorage.getItem(EMAIL_KEY) || ''; return _email; }
function setEmail(e) { _email = (e || '').trim().toLowerCase(); localStorage.setItem(EMAIL_KEY, _email); }
function userEmail() { return getEmail() || null; }

async function login(email) {
  email = (email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'Enter your email' };
  if (!navigator.onLine) {
    // Offline: only let in an email that was already validated on this device.
    if (localStorage.getItem('wca-known-' + email)) { setEmail(email); emit({ type: 'auth' }); return { ok: true, offline: true }; }
    return { ok: false, reason: 'You need to be online the first time you sign in.' };
  }
  const { data, error } = await client().rpc('audit_login', { p_email: email });
  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: false, reason: 'not_allowed' };
  setEmail(email);
  localStorage.setItem('wca-known-' + email, '1');
  emit({ type: 'auth' });
  return { ok: true };
}

function logout() { localStorage.removeItem(EMAIL_KEY); _email = ''; emit({ type: 'auth' }); }

// true if the stored email is still approved; offline we trust prior validation
async function isAllowed() {
  const e = getEmail();
  if (!e) return false;
  if (!navigator.onLine) return true;
  try {
    const { data, error } = await client().rpc('audit_login', { p_email: e });
    if (error) return true;      // network hiccup -> don't lock the user out
    return !!data;               // explicit false -> email was removed
  } catch { return true; }
}

// ---- pull ---------------------------------------------------------------
async function pull() {
  if (!navigator.onLine) return { ok: false, reason: 'offline' };
  const e = getEmail();
  if (!e) return { ok: false, reason: 'no-email' };
  const { data, error } = await client().rpc('audit_bootstrap', { p_email: e });
  if (error) return { ok: false, reason: error.message };
  await DB.clear('tanks'); await DB.putMany('tanks', data.tanks || []);
  await DB.clear('wells'); await DB.putMany('wells', data.wells || []);
  await DB.clear('products'); await DB.putMany('products', data.products || []);
  await overlayOutbox();
  await DB.setMeta('lastPull', new Date().toISOString());
  emit({ type: 'data' });
  return { ok: true };
}

async function overlayOutbox() {
  const items = await DB.outbox();
  for (const m of items) {
    if (m.op === 'update_tank') { const r = await DB.get('tanks', m.entityId); if (r) await DB.put('tanks', { ...r, ...m.payload }); }
    else if (m.op === 'update_well' || m.op === 'detach_well' || m.op === 'attach_well') {
      const r = await DB.get('wells', m.entityId);
      if (r) await DB.put('wells', { ...r, ...m.payload });
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
  if (!getEmail()) return { ok: false, reason: 'no-email' };
  _pushing = true;
  emit({ type: 'sync-start' });
  try {
    const c = client();
    let networkBroke = false;
    // Loop until the outbox is fully drained. Re-reading each pass also flushes
    // mutations that were enqueued WHILE an earlier pass was still running
    // (rapid successive edits), so the last edit never waits for another trigger.
    while (true) {
      const items = (await DB.outbox()).filter((x) => !x.blocked).sort((a, b) => a.localId - b.localId);
      if (!items.length) break;
      let progressed = false;
      for (const m of items) {
        try {
          await applyMutation(c, m);
          await DB.dequeue(m.localId);
          progressed = true;
        } catch (err) {
          m.attempts = (m.attempts || 0) + 1;
          m.lastError = String(err && err.message ? err.message : err);
          const networkish = /network|fetch|Failed to fetch|timeout|Load failed/i.test(m.lastError);
          if (!networkish && m.attempts >= 5) m.blocked = true; // poison-message backstop
          await DB.put('outbox', m);
          if (networkish) { networkBroke = true; break; } // stop; retry on next online/trigger
        }
      }
      if (networkBroke || !progressed) break;
    }
    const remaining = (await DB.outbox()).filter((x) => !x.blocked).length;
    emit({ type: 'sync-end', pending: remaining });
    return { ok: true, pending: remaining };
  } finally { _pushing = false; }
}

async function applyMutation(c, m) {
  const { error } = await c.rpc('audit_apply', { p_email: getEmail(), p_mutation: m });
  if (error) throw error;
}

async function fullSync() { const p = await push(); const q = await pull(); return { push: p, pull: q }; }

// ---- edit API (unchanged shapes; each writes local + queues durable) ----
async function enqueueAndSync(mutation) {
  mutation.clientTs = new Date().toISOString();
  mutation.userEmail = userEmail();
  mutation.deviceId = await getDeviceId();
  await DB.enqueue(mutation);
  emit({ type: 'queued' });
  if (navigator.onLine) push();
}

async function editTank(tankId, changes) {
  const cur = await DB.get('tanks', tankId);
  const diff = [];
  for (const [f, v] of Object.entries(changes)) if ((cur ? cur[f] : null) !== v) diff.push({ field: f, old: cur ? cur[f] : null, new: v });
  if (!diff.length) return;
  await DB.put('tanks', { ...cur, ...changes });
  await enqueueAndSync({ op: 'update_tank', entity: 'tank', entityId: tankId, payload: changes, changes: diff, meta: { tgl_slot: cur.tgl_slot } });
}

async function editWell(wellId, changes) {
  const cur = await DB.get('wells', wellId);
  const diff = [];
  for (const [f, v] of Object.entries(changes)) if ((cur ? cur[f] : null) !== v) diff.push({ field: f, old: cur ? cur[f] : null, new: v });
  if (!diff.length) return;
  const tank = cur ? await DB.get('tanks', cur.tank_id) : null;
  await DB.put('wells', { ...cur, ...changes });
  await enqueueAndSync({ op: 'update_well', entity: 'well', entityId: wellId, payload: changes, changes: diff, meta: { tgl_slot: tank ? tank.tgl_slot : null, accounting_id: cur.accounting_id } });
  // accounting_id is part of the tgl_slot -> keep the slot in sync
  if ('accounting_id' in changes && cur) await regenSlot(cur.tank_id);
}

// Rebuild a tank's tgl_slot from its currently-attached wells' accounting IDs
// (kept as <accts concatenated>_<middle>_<product_type>). Called on attach/detach
// and when an accounting_id changes.
async function regenSlot(tankId) {
  const tank = await DB.get('tanks', tankId);
  if (!tank) return;
  const wells = (await DB.getAll('wells')).filter((w) => w.tank_id === tankId && !w.is_deleted && w.is_attached);
  const accts = [...new Set(wells.map((w) => (w.accounting_id || '').trim()).filter(Boolean))].sort();
  if (!accts.length) return; // never blank a slot out entirely
  const parts = String(tank.tgl_slot || '').split('_');
  const middle = parts.length >= 2 ? parts[parts.length - 2] : 'C';
  const ptype = tank.product_type || parts[parts.length - 1] || '';
  const newSlot = accts.join('') + '_' + middle + '_' + ptype;
  if (newSlot !== tank.tgl_slot) await editTank(tankId, { tgl_slot: newSlot });
}

async function attachWell(tankId, fields) {
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
  await regenSlot(tankId);
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
  await regenSlot(cur.tank_id);
}

async function addCustomProduct(code) {
  code = (code || '').trim();
  if (!code) return null;
  const all = await DB.getAll('products');
  const existing = all.find((p) => (p.code || '').toLowerCase() === code.toLowerCase());
  if (existing) return existing;
  const row = { id: crypto.randomUUID(), code, is_custom: true, active: true, created_by: userEmail() };
  await DB.put('products', row);
  await enqueueAndSync({ op: 'insert_product', entity: 'product', entityId: row.id, payload: row, logOp: 'create', changes: [{ field: 'code', old: null, new: code }], meta: {} });
  return row;
}

async function pendingCount() { return (await DB.outbox()).filter((x) => !x.blocked).length; }
async function blockedCount() { return (await DB.outbox()).filter((x) => x.blocked).length; }

window.Sync = {
  client, onChange, getEmail, userEmail, login, logout, isAllowed,
  pull, push, fullSync, editTank, editWell, attachWell, detachWell, addCustomProduct,
  pendingCount, blockedCount,
};

window.addEventListener('online', () => { emit({ type: 'online' }); push(); });
window.addEventListener('offline', () => emit({ type: 'offline' }));
