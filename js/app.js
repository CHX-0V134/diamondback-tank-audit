// ---------------------------------------------------------------------------
// app.js — UI. Renders from the local IndexedDB snapshot, writes edits through
// the Sync layer (which persists + queues + pushes). Works fully offline.
// ---------------------------------------------------------------------------
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => (v == null ? '' : String(v));

// tiny DOM builder
function h(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => { if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); });
  return e;
}

const APP = {
  tanks: [], wells: [], products: [], wellsByTank: new Map(),
  currentTankId: null, syncState: 'idle',
};

// ---- theme -----------------------------------------------------------------
function initTheme() {
  const saved = localStorage.getItem('wca-theme') || 'auto';
  document.documentElement.setAttribute('data-theme', saved);
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = document.documentElement.getAttribute('data-theme') || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('wca-theme', next);
  toast('Theme: ' + next);
}

// ---- toast -----------------------------------------------------------------
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast'); t.className = 'toast ' + kind; t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---- screens ---------------------------------------------------------------
function show(screen) {
  ['login', 'denied', 'app'].forEach((id) => $('#' + id).classList.toggle('hidden', id !== screen));
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  initTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed', e));
  }
  wireStaticEvents();

  // Auth
  await Sync.getSession();
  Sync.onAuthStateChange(async () => { await routeAuth(); });
  Sync.onChange(onSyncEvent);
  await routeAuth();
}

async function routeAuth() {
  const session = await Sync.getSession();
  if (!session) { show('login'); return; }
  const allowed = await Sync.isAllowed().catch(() => false);
  if (!allowed) {
    $('#denied-email').textContent = Sync.userEmail() || '';
    show('denied'); return;
  }
  show('app');
  $('#menu-email').textContent = Sync.userEmail() || '';
  // Load local snapshot first (instant, offline-safe), then refresh from server.
  await loadLocal();
  render();
  updateSyncUI();
  if (navigator.onLine) {
    const r = await Sync.pull();
    if (!r.ok && r.reason && r.reason !== 'offline') toast('Sync (pull) issue: ' + r.reason, 'err');
  }
}

// ---- data load / index -----------------------------------------------------
async function loadLocal() {
  APP.tanks = await DB.getAll('tanks');
  APP.wells = await DB.getAll('wells');
  APP.products = await DB.getAll('products');
  APP.wellsByTank = new Map();
  for (const w of APP.wells) {
    if (!APP.wellsByTank.has(w.tank_id)) APP.wellsByTank.set(w.tank_id, []);
    APP.wellsByTank.get(w.tank_id).push(w);
  }
  buildFilters();
  buildDatalists();
}

function buildFilters() {
  const foremen = [...new Set(APP.tanks.map((t) => t.foreman).filter(Boolean))].sort();
  const types = [...new Set(APP.tanks.map((t) => t.product_type).filter(Boolean))].sort();
  const fSel = $('#filter-foreman'), tSel = $('#filter-type');
  const keepF = fSel.value, keepT = tSel.value;
  fSel.innerHTML = '<option value="">All foremen</option>' + foremen.map((f) => `<option>${esc(f)}</option>`).join('');
  tSel.innerHTML = '<option value="">All types</option>' + types.map((t) => `<option>${esc(t)}</option>`).join('');
  fSel.value = keepF; tSel.value = keepT;
}

function buildDatalists() {
  const mk = (id, vals) => {
    let dl = document.getElementById(id);
    if (!dl) { dl = h('datalist', { id }); document.body.append(dl); }
    dl.innerHTML = [...new Set(vals.filter(Boolean))].sort().map((v) => `<option value="${esc(v)}">`).join('');
  };
  mk('dl-app', APP.tanks.map((t) => t.application_id));
  mk('dl-pumpmake', APP.wells.map((w) => w.pump_make));
  mk('dl-program', APP.tanks.map((t) => t.program));
  mk('dl-ptype', APP.tanks.map((t) => t.product_type));
}

// ---- list render -----------------------------------------------------------
function tankLead(t) {
  const ws = (APP.wellsByTank.get(t.id) || []).filter((w) => !w.is_deleted && w.is_attached);
  if (!ws.length) return { title: '(no wells attached)', count: 0 };
  const names = ws.map((w) => w.asset_name).filter(Boolean);
  return { title: names[0] || t.tgl_slot, count: ws.length, extra: names.length > 1 ? ` +${names.length - 1} more` : '' };
}

function matchesFilter(t) {
  const q = $('#search').value.trim().toLowerCase();
  const ff = $('#filter-foreman').value, ft = $('#filter-type').value;
  if (ff && t.foreman !== ff) return false;
  if (ft && t.product_type !== ft) return false;
  if (!q) return true;
  if ((t.tgl_slot || '').toLowerCase().includes(q)) return true;
  if ((t.product || '').toLowerCase().includes(q)) return true;
  if ((t.asset_tag || '').toLowerCase().includes(q)) return true;
  const ws = APP.wellsByTank.get(t.id) || [];
  return ws.some((w) => (w.asset_name || '').toLowerCase().includes(q) || (w.accounting_id || '').toLowerCase().includes(q));
}

function render() {
  const list = $('#list'); list.innerHTML = '';
  const tanks = APP.tanks.filter((t) => !t.is_deleted).filter(matchesFilter)
    .sort((a, b) => (a.tgl_slot || '').localeCompare(b.tgl_slot || ''));
  $('#empty').classList.toggle('hidden', tanks.length > 0);
  const frag = document.createDocumentFragment();
  for (const t of tanks) {
    const lead = tankLead(t);
    const card = h('div', { class: 'tank', onclick: () => openDetail(t.id) }, [
      h('div', { class: 'tank-top' }, [
        h('div', { class: 'tank-title' }, [lead.title, lead.extra ? h('span', { class: 'muted', text: lead.extra }) : null]),
        h('span', { class: 'chip type', text: t.product_type || '—' }),
      ]),
      h('div', { class: 'tank-meta' }, [
        h('span', { html: `<b>${esc(t.product) || '—'}</b> product` }),
        h('span', { html: `<b>${esc(t.tank_volume ?? '—')}</b> gal` }),
        h('span', { html: `<b>${lead.count}</b> well${lead.count === 1 ? '' : 's'}` }),
        h('span', { html: `${esc(t.program) || '—'} · ${esc(t.target_ppm ?? '—')} ppm` }),
        t.source === 'field' ? h('span', { class: 'badge-field', text: 'field-added' }) : null,
      ]),
      h('div', { class: 'tank-slot mono', text: t.tgl_slot }),
    ]);
    frag.append(card);
  }
  list.append(frag);
}

// ---- detail panel ----------------------------------------------------------
function savedFlag(kind) {
  return h('span', { class: 'saved-flag ' + (kind === 'queued' ? 'queued' : ''), text: kind === 'queued' ? 'queued ✓' : 'saved ✓' });
}
function flash(node) { node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 1400); }

// build an editable text/number/select field that autosaves through `save(value)`
function editField(labelText, value, save, opts = {}) {
  const flag = savedFlag(navigator.onLine ? '' : 'queued');
  let input;
  if (opts.type === 'select') {
    input = h('select', {}, opts.options.map((o) =>
      h('option', { value: o.value, ...(String(o.value) === String(value ?? '') ? { selected: '' } : {}) }, o.label)));
  } else if (opts.type === 'textarea') {
    input = h('textarea', { rows: opts.rows || 2 }); input.value = value ?? '';
  } else {
    input = h('input', { type: opts.type || 'text' });
    if (opts.list) input.setAttribute('list', opts.list);
    if (opts.inputmode) input.setAttribute('inputmode', opts.inputmode);
    input.value = value ?? '';
  }
  input.addEventListener('change', async () => {
    let v = input.value;
    if (opts.number) v = v === '' ? null : Number(v);
    else v = v === '' ? null : v;
    await save(v, input);
    flag.className = 'saved-flag ' + (navigator.onLine ? '' : 'queued');
    flag.textContent = navigator.onLine ? 'saved ✓' : 'queued ✓';
    flash(flag);
  });
  const lbl = h('label', {}, [labelText, flag]);
  return { wrap: h('div', { class: 'field' }, [lbl, input]), input };
}

function productField(tank) {
  const flag = savedFlag('');
  const opts = APP.products.slice().sort((a, b) => (a.code || '').localeCompare(b.code || ''))
    .map((p) => h('option', { value: p.code, ...(p.code === tank.product ? { selected: '' } : {}) }, p.code + (p.is_custom ? ' (custom)' : '')));
  // ensure current value present even if not in list
  const has = APP.products.some((p) => p.code === tank.product);
  const sel = h('select', {}, [
    ...(!has && tank.product ? [h('option', { value: tank.product, selected: '' }, tank.product)] : []),
    ...opts,
    h('option', { value: '__OTHER__' }, '➕ Other (type a new product)…'),
  ]);
  const otherWrap = h('div', { class: 'field hidden' });
  const otherInput = h('input', { type: 'text', placeholder: 'New product code, e.g. XX-1234' });
  const otherBtn = h('button', { class: 'btn primary', style: 'margin-top:.5rem', onclick: async () => {
    const code = otherInput.value.trim(); if (!code) return;
    await Sync.addCustomProduct(code);
    await Sync.editTank(tank.id, { product: code });
    await loadLocal(); openDetail(tank.id); toast('Product "' + code + '" added', 'ok');
  } }, 'Add & select');
  otherWrap.append(h('label', {}, 'New product'), otherInput, otherBtn);

  sel.addEventListener('change', async () => {
    if (sel.value === '__OTHER__') { otherWrap.classList.remove('hidden'); otherInput.focus(); return; }
    otherWrap.classList.add('hidden');
    await Sync.editTank(tank.id, { product: sel.value });
    flag.className = 'saved-flag ' + (navigator.onLine ? '' : 'queued');
    flag.textContent = navigator.onLine ? 'saved ✓' : 'queued ✓'; flash(flag);
  });
  return h('div', { class: 'field' }, [h('label', {}, ['Product', flag]), sel, otherWrap]);
}

function wellCard(w, tank) {
  const nameF = editField('Well name', w.asset_name, (v) => Sync.editWell(w.id, { asset_name: v }));
  const acctF = editField('Accounting ID', w.accounting_id, (v) => Sync.editWell(w.id, { accounting_id: v }));
  const makeF = editField('Pump make', w.pump_make, (v) => Sync.editWell(w.id, { pump_make: v }), { list: 'dl-pumpmake' });
  const snF = editField('Pump S/N', w.pump_sn, (v) => Sync.editWell(w.id, { pump_sn: v }));
  const detach = h('button', { class: 'linkbtn', style: 'color:var(--danger)', onclick: async () => {
    await Sync.detachWell(w.id); await loadLocal(); openDetail(tank.id); toast('Well detached');
  } }, 'Detach from tank');
  return h('div', { class: 'well' + (w.is_attached ? '' : ' detached') }, [
    h('div', { class: 'well-head' }, [
      h('span', { class: 'well-name', text: w.asset_name || w.accounting_id || 'Well' }),
      w.source === 'field' ? h('span', { class: 'chip', text: 'added' }) : (w.is_attached ? null : h('span', { class: 'chip', text: 'detached' })),
    ]),
    h('div', { class: 'grid2' }, [nameF.wrap, acctF.wrap]),
    h('div', { class: 'grid2' }, [makeF.wrap, snF.wrap]),
    h('div', { class: 'row-actions' }, [w.is_attached ? detach : null]),
  ]);
}

function attachForm(tank) {
  const acc = h('input', { type: 'text', placeholder: 'Accounting ID' });
  const nm = h('input', { type: 'text', placeholder: 'Well name' });
  const mk = h('input', { type: 'text', placeholder: 'Pump make', list: 'dl-pumpmake' });
  const sn = h('input', { type: 'text', placeholder: 'Pump S/N' });
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    if (!nm.value.trim() && !acc.value.trim()) { toast('Enter a well name or accounting ID', 'err'); return; }
    await Sync.attachWell(tank.id, { accounting_id: acc.value.trim(), asset_name: nm.value.trim(), pump_make: mk.value.trim(), pump_sn: sn.value.trim() });
    await loadLocal(); openDetail(tank.id); toast('Well attached', 'ok');
  } }, '+ Attach well');
  return h('div', { class: 'well' }, [
    h('div', { class: 'section-title', style: 'margin-top:0', text: 'Attach a well not shown above' }),
    h('div', { class: 'grid2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Well name'), nm]),
      h('div', { class: 'field' }, [h('label', {}, 'Accounting ID'), acc]),
    ]),
    h('div', { class: 'grid2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Pump make'), mk]),
      h('div', { class: 'field' }, [h('label', {}, 'Pump S/N'), sn]),
    ]),
    btn,
  ]);
}

function openDetail(tankId) {
  const tank = APP.tanks.find((t) => t.id === tankId);
  if (!tank) return;
  APP.currentTankId = tankId;
  const wells = (APP.wellsByTank.get(tankId) || []).slice().sort((a, b) => (a.asset_name || '').localeCompare(b.asset_name || ''));

  const body = h('div', { class: 'panel-body' }, [
    h('div', { class: 'section-title', style: 'margin-top:0', text: 'Tank / slot' }),
    h('div', { class: 'mono muted', style: 'word-break:break-all;margin-bottom:.4rem', text: tank.tgl_slot }),

    h('div', { class: 'section-title', text: 'Configuration' }),
    productField(tank),
    h('div', { class: 'grid2' }, [
      editField('Tank size (gal)', tank.tank_volume, (v) => Sync.editTank(tank.id, { tank_volume: v }), { type: 'number', number: true, inputmode: 'decimal' }).wrap,
      editField('Target PPM', tank.target_ppm, (v) => Sync.editTank(tank.id, { target_ppm: v }), { type: 'number', number: true, inputmode: 'decimal' }).wrap,
    ]),
    h('div', { class: 'grid2' }, [
      editField('Product type', tank.product_type, (v) => Sync.editTank(tank.id, { product_type: v }), { list: 'dl-ptype' }).wrap,
      editField('Program', tank.program, (v) => Sync.editTank(tank.id, { program: v }), { list: 'dl-program' }).wrap,
    ]),
    h('div', { class: 'grid2' }, [
      editField('Application', tank.application_id, (v) => Sync.editTank(tank.id, { application_id: v }), { list: 'dl-app' }).wrap,
      editField('Asset tag', tank.asset_tag, (v) => Sync.editTank(tank.id, { asset_tag: v })).wrap,
    ]),
    editField('Notes', tank.notes, (v) => Sync.editTank(tank.id, { notes: v }), { type: 'textarea', rows: 2 }).wrap,

    h('div', { class: 'section-title', text: `Wells served (${wells.filter((w) => w.is_attached && !w.is_deleted).length})` }),
    ...wells.filter((w) => !w.is_deleted).map((w) => wellCard(w, tank)),
    attachForm(tank),
  ]);

  const panel = $('#detail');
  panel.innerHTML = '';
  panel.append(
    h('div', { class: 'panel-head' }, [
      h('div', { class: 'brand small' }, [h('span', { class: 'brand-mark', text: 'SLB' }), h('span', { class: 'brand-name', text: tank.product_type || 'Tank' })]),
      h('button', { class: 'icon-btn', onclick: closeDetail, 'aria-label': 'Close' }, '✕'),
    ]),
    body
  );
  panel.classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
}
function closeDetail() { APP.currentTankId = null; $('#detail').classList.add('hidden'); $('#scrim').classList.add('hidden'); }

// ---- sync UI ---------------------------------------------------------------
async function updateSyncUI() {
  const pending = await Sync.pendingCount();
  const blocked = await Sync.blockedCount();
  const dot = $('#net-dot'), label = $('#sync-label');
  dot.className = 'dot';
  if (!navigator.onLine) { dot.classList.add('offline'); label.textContent = pending ? `Offline (${pending})` : 'Offline'; }
  else if (APP.syncState === 'syncing') { dot.classList.add('syncing'); label.textContent = 'Syncing…'; }
  else if (blocked) { dot.classList.add('error'); label.textContent = 'Sync error'; }
  else if (pending) { dot.classList.add('pending'); label.textContent = `Sync (${pending})`; }
  else { label.textContent = 'Synced'; }

  const last = await DB.getMeta('lastPull', null);
  $('#sync-detail').innerHTML =
    `${navigator.onLine ? 'Online' : 'Offline'} · ${pending} pending${blocked ? ` · <b style="color:var(--danger)">${blocked} blocked</b>` : ''}<br>` +
    (last ? 'Last sync: ' + new Date(last).toLocaleString() : 'Not synced yet');
}

async function onSyncEvent(evt) {
  if (evt.type === 'sync-start') APP.syncState = 'syncing';
  if (evt.type === 'sync-end') { APP.syncState = 'idle'; if (evt.pending === 0) toast('All changes synced', 'ok'); }
  // A local edit was queued: refresh the list to reflect it, but leave any
  // open detail panel untouched so the user's focus/scroll isn't disrupted.
  if (evt.type === 'queued') { await loadLocal(); render(); }
  if (evt.type === 'data') { await loadLocal(); render(); if (APP.currentTankId) openDetail(APP.currentTankId); }
  if (evt.type === 'online') toast('Back online — syncing');
  if (evt.type === 'offline') toast('Offline — changes saved locally');
  updateSyncUI();
}

// ---- static events ---------------------------------------------------------
function wireStaticEvents() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn'), msg = $('#login-msg');
    const email = $('#email').value.trim();
    if (!email) return;
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Sending…';
    const { error } = await Sync.sendMagicLink(email);
    btn.disabled = false;
    if (error) { msg.className = 'msg err'; msg.textContent = error.message; }
    else { msg.className = 'msg ok'; msg.textContent = 'Check your email for a sign-in link. Open it on this device.'; }
  });
  $('#denied-signout').addEventListener('click', () => Sync.signOut());
  $('#signout-btn').addEventListener('click', () => Sync.signOut());
  $('#theme-btn').addEventListener('click', cycleTheme);
  $('#menu-btn').addEventListener('click', () => { $('#account-menu').classList.toggle('hidden'); updateSyncUI(); });
  $('#sync-btn').addEventListener('click', async () => {
    if (!navigator.onLine) { toast('Offline — will sync when back online'); return; }
    APP.syncState = 'syncing'; updateSyncUI();
    const r = await Sync.fullSync();
    APP.syncState = 'idle';
    if (r.push && r.push.reason && r.push.reason !== 'offline') toast('Sync issue: ' + r.push.reason, 'err');
    await loadLocal(); render(); if (APP.currentTankId) openDetail(APP.currentTankId); updateSyncUI();
  });
  $('#scrim').addEventListener('click', closeDetail);
  ['input', 'change'].forEach((ev) => {
    $('#search').addEventListener(ev, render);
  });
  $('#filter-foreman').addEventListener('change', render);
  $('#filter-type').addEventListener('change', render);
  window.addEventListener('online', updateSyncUI);
  window.addEventListener('offline', updateSyncUI);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && APP.currentTankId) closeDetail(); });
}

boot();
