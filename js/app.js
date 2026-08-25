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
  ['login', 'app'].forEach((id) => $('#' + id).classList.toggle('hidden', id !== screen));
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  initTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed', e));
  }
  wireStaticEvents();
  Sync.onChange(onSyncEvent);
  await routeAuth();
}

async function routeAuth() {
  const email = Sync.getEmail();
  if (!email) { show('login'); return; }
  // If online, confirm the email is still approved; if it was removed, bounce to login.
  const allowed = await Sync.isAllowed().catch(() => true);
  if (!allowed) {
    Sync.logout(); show('login');
    const msg = $('#login-msg'); msg.className = 'msg err'; msg.textContent = 'This email is no longer on the approved list.';
    return;
  }
  show('app');
  $('#menu-email').textContent = email;
  // Load local snapshot first (instant, offline-safe), then refresh from server.
  await loadLocal();
  render();
  updateSyncUI();
  if (navigator.onLine) {
    const r = await Sync.pull();
    if (!r.ok && r.reason && !['offline', 'no-email'].includes(r.reason)) toast('Sync (pull) issue: ' + r.reason, 'err');
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
function attachedWells(t) { return (APP.wellsByTank.get(t.id) || []).filter((w) => !w.is_deleted && w.is_attached); }

// Merge the attached wells' names into one label: shared prefix once, then each
// distinct tail joined with commas and an ampersand before the last.
// e.g. "MABEE BREEDLOVE D 2408LS, E 2408MS, F 2408WA & G 2408WB"
function combinedName(t) {
  const names = attachedWells(t).map((w) => (w.asset_name || '').trim()).filter(Boolean);
  if (!names.length) return t.tgl_slot || '(no wells attached)';
  if (names.length === 1) return names[0];
  const toks = names.map((n) => n.split(/\s+/));
  const minLen = Math.min(...toks.map((a) => a.length));
  let p = 0;
  while (p < minLen && toks.every((a) => a[p] === toks[0][p])) p++;
  if (p >= minLen) p = minLen - 1;                 // always leave a distinct tail
  const prefix = toks[0].slice(0, p).join(' ');
  const tails = [...new Set(toks.map((a) => a.slice(p).join(' ').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  let joined;
  if (tails.length <= 1) joined = tails[0] || '';
  else if (tails.length === 2) joined = tails[0] + ' & ' + tails[1];
  else joined = tails.slice(0, -1).join(', ') + ' & ' + tails[tails.length - 1];
  return (prefix ? prefix + ' ' : '') + joined;
}

function matchesFilter(t) {
  const q = $('#search').value.trim().toLowerCase();
  const ff = $('#filter-foreman').value, ft = $('#filter-type').value, fs = $('#filter-status').value;
  if (ff && t.foreman !== ff) return false;
  if (ft && t.product_type !== ft) return false;
  if (fs === 'unreviewed' && t.reviewed_at) return false;
  if (fs === 'reviewed' && !t.reviewed_at) return false;
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
    const count = attachedWells(t).length;
    const card = h('div', { class: 'tank' + (!t.reviewed_at ? ' has-corner' : ''), onclick: () => openDetail(t.id) }, [
      h('div', { class: 'tank-top' }, [
        h('div', { class: 'tank-title', text: combinedName(t) }),
        h('span', { class: 'chip type', text: t.product_type || '—' }),
      ]),
      h('div', { class: 'tank-meta' }, [
        h('span', { html: `<b>${esc(t.product) || '—'}</b>` }),
        h('span', { html: `<b>${esc(t.tank_volume ?? '—')}</b> gal` }),
        h('span', { html: `<b>${count}</b> well${count === 1 ? '' : 's'}` }),
        (t.current_inventory != null && t.current_inventory !== '') ? h('span', { html: `inv <b>${esc(t.current_inventory)}</b> gal` }) : null,
        t.source === 'field' ? h('span', { class: 'badge-field', text: 'field-added' }) : null,
        t.needs_order ? h('span', { class: 'badge-order', text: 'NEEDS ORDER' }) : null,
      ]),
      !t.reviewed_at ? h('span', { class: 'badge-review corner', text: 'NEEDS REVIEW' }) : null,
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
    // Serial numbers / IDs / tags: stop the phone from "helpfully" autocapitalizing
    // or autocorrecting them into garbage.
    if (opts.raw) { input.setAttribute('autocapitalize', 'off'); input.setAttribute('autocorrect', 'off'); input.setAttribute('spellcheck', 'false'); }
    else if (opts.autocapitalize) { input.setAttribute('autocapitalize', opts.autocapitalize); input.setAttribute('autocorrect', 'off'); input.setAttribute('spellcheck', 'false'); }
    input.setAttribute('enterkeyhint', 'done');
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
    if (opts.refresh) await refreshDetail(); // recompute top metric
  });
  const lbl = h('label', {}, [labelText, flag]);
  return { wrap: h('div', { class: 'field' }, [lbl, input]), input };
}

async function refreshDetail() { await loadLocal(); if (APP.currentTankId) openDetail(APP.currentTankId); }

function distinct(list, key) {
  return [...new Set(list.map((x) => x[key]).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
}

// A <select> whose options come from base data, plus an "Other…" free-text option.
// New free-text values simply get saved on the record; once synced they appear in
// everyone's dropdown (options are rebuilt from live data).
function selectWithOther(labelText, value, options, onSave, opts = {}) {
  const flag = savedFlag(navigator.onLine ? '' : 'queued');
  const inList = value != null && value !== '' && options.includes(value);
  const sel = h('select', {}, [
    h('option', { value: '' }, opts.placeholder || '—'),
    ...(!inList && value ? [h('option', { value, selected: '' }, value)] : []),
    ...options.map((o) => h('option', { value: o, ...(o === value ? { selected: '' } : {}) }, o)),
    h('option', { value: '__OTHER__' }, '➕ Other…'),
  ]);
  const wrap = h('div', { class: 'field hidden' });
  const inp = h('input', { type: 'text', placeholder: 'Type a value', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false' });
  const btn = h('button', { class: 'btn primary', style: 'margin-top:.5rem', onclick: async () => { const v = inp.value.trim(); if (!v) return; await onSave(v); await refreshDetail(); } }, 'Save');
  wrap.append(h('label', {}, 'New value'), inp, btn);
  sel.addEventListener('change', async () => {
    if (sel.value === '__OTHER__') { wrap.classList.remove('hidden'); inp.focus(); return; }
    wrap.classList.add('hidden');
    await onSave(sel.value === '' ? null : sel.value);
    if (opts.rerender) { await refreshDetail(); return; }
    flag.className = 'saved-flag ' + (navigator.onLine ? '' : 'queued'); flag.textContent = navigator.onLine ? 'saved ✓' : 'queued ✓'; flash(flag);
  });
  return h('div', { class: 'field' }, [h('label', {}, [labelText, flag]), sel, wrap]);
}

function checkboxField(labelText, checked, onSave) {
  const flag = savedFlag(navigator.onLine ? '' : 'queued');
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!checked;
  cb.addEventListener('change', async () => {
    await onSave(cb.checked);
    flag.className = 'saved-flag ' + (navigator.onLine ? '' : 'queued'); flag.textContent = navigator.onLine ? 'saved ✓' : 'queued ✓'; flash(flag);
  });
  return h('div', { class: 'field' }, [h('label', { class: 'checkrow' }, [cb, h('span', { text: labelText }), flag])]);
}

// Required Yes/No confirmation. value: true | false | null (unanswered).
// compact Yes/No pair shown inline next to a field (only when there's a value to confirm)
function smallYesNo(value, onSave) {
  const yes = h('button', { type: 'button', class: 'yn sm' + (value === true ? ' on-yes' : '') }, 'Yes');
  const no = h('button', { type: 'button', class: 'yn sm' + (value === false ? ' on-no' : '') }, 'No');
  yes.addEventListener('click', async () => { await onSave(true); await refreshDetail(); });
  no.addEventListener('click', async () => { await onSave(false); await refreshDetail(); });
  return [yes, no];
}

// numeric field with optional inline confirm buttons
function numberFieldInline(labelText, value, saveVal, confirm) {
  const flag = savedFlag(navigator.onLine ? '' : 'queued');
  const inp = h('input', { type: 'number', inputmode: 'decimal', enterkeyhint: 'done' }); inp.value = value ?? '';
  inp.addEventListener('change', async () => {
    await saveVal(inp.value === '' ? null : Number(inp.value));
    flag.className = 'saved-flag ' + (navigator.onLine ? '' : 'queued'); flag.textContent = navigator.onLine ? 'saved ✓' : 'queued ✓'; flash(flag);
    await refreshDetail(); // tank size feeds the days-to-empty metric
  });
  const row = h('div', { class: 'inline-confirm' }, [inp]);
  if (confirm && confirm.show) row.append(...smallYesNo(confirm.value, confirm.onSave));
  const need = confirm && confirm.show && confirm.value == null ? h('span', { class: 'yn-need', text: 'confirm' }) : null;
  return h('div', { class: 'field' }, [h('label', {}, [labelText, need, flag]), row]);
}

function productField(tank) {
  const flag = savedFlag('');
  const opts = APP.products.slice().sort((a, b) => (a.code || '').localeCompare(b.code || ''))
    .map((p) => h('option', { value: p.code, ...(p.code === tank.product ? { selected: '' } : {}) }, p.code + (p.is_custom ? ' (custom)' : '')));
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
    const prod = APP.products.find((p) => p.code === sel.value);
    const patch = { product: sel.value };
    if (prod && prod.product_type) patch.product_type = prod.product_type;
    await Sync.editTank(tank.id, patch);
    await refreshDetail();
  });

  // inline "Product correct?" — only when a product value is present
  const showConfirm = tank.product != null && tank.product !== '';
  const row = h('div', { class: 'inline-confirm' }, [sel]);
  if (showConfirm) row.append(...smallYesNo(tank.product_confirmed, (v) => Sync.editTank(tank.id, { product_confirmed: v })));
  const need = showConfirm && tank.product_confirmed == null ? h('span', { class: 'yn-need', text: 'confirm' }) : null;
  return h('div', { class: 'field' }, [h('label', {}, ['Product', need, flag]), row, otherWrap]);
}

function wellCard(w, tank, pumpMakes) {
  // well name is shown as the card header, so no separate input here
  const acctF = editField('Accounting ID', w.accounting_id, (v) => Sync.editWell(w.id, { accounting_id: v }), { raw: true, inputmode: 'numeric' });
  // pump make is a dropdown; changing it clears the pump S/N (belongs to the old pump)
  const makeF = selectWithOther('Pump make', w.pump_make, pumpMakes, async (v) => { await Sync.editWell(w.id, { pump_make: v, pump_sn: null }); }, { rerender: true });
  const snF = editField('Pump S/N', w.pump_sn, (v) => Sync.editWell(w.id, { pump_sn: v }), { raw: true });
  const foundF = editField('Rate as found', w.rate_as_found, (v) => Sync.editWell(w.id, { rate_as_found: v }), { type: 'number', number: true, inputmode: 'decimal' });
  const leftF = editField('Rate as left', w.rate_as_left, (v) => Sync.editWell(w.id, { rate_as_left: v }), { type: 'number', number: true, inputmode: 'decimal', refresh: true });
  const detach = h('button', { class: 'linkbtn', style: 'color:var(--danger)', onclick: async () => {
    await Sync.detachWell(w.id); await loadLocal(); openDetail(tank.id); toast('Well detached');
  } }, 'Detach from tank');
  return h('div', { class: 'well' + (w.is_attached ? '' : ' detached') }, [
    h('div', { class: 'well-head' }, [
      h('span', { class: 'well-name', text: w.asset_name || w.accounting_id || 'Well' }),
      w.source === 'field' ? h('span', { class: 'chip', text: 'added' }) : (w.is_attached ? null : h('span', { class: 'chip', text: 'detached' })),
    ]),
    acctF.wrap,
    h('div', { class: 'grid2' }, [makeF, snF.wrap]),
    h('div', { class: 'grid2' }, [foundF.wrap, leftF.wrap]),
    h('div', { class: 'row-actions' }, [w.is_attached ? detach : null]),
  ]);
}

function attachForm(tank) {
  const raw = { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next' };
  const acc = h('input', { type: 'text', placeholder: 'Accounting ID', inputmode: 'numeric', ...raw });
  const nm = h('input', { type: 'text', placeholder: 'Well name', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next' });
  const mk = h('input', { type: 'text', placeholder: 'Pump make', list: 'dl-pumpmake', ...raw });
  const sn = h('input', { type: 'text', placeholder: 'Pump S/N', ...raw });
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

  const applications = distinct(APP.tanks, 'application_id');
  const pumpMakes = distinct(APP.wells, 'pump_make');

  // Days-to-empty: (current inventory − 5% heel of tank size) ÷ total as-left rate
  const totalRate = attachedWells(tank).reduce((s, w) => s + (Number(w.rate_as_left) || 0), 0);
  const invVal = (tank.current_inventory == null || tank.current_inventory === '') ? NaN : Number(tank.current_inventory);
  const capVal = (tank.tank_volume == null || tank.tank_volume === '') ? 0 : Number(tank.tank_volume);
  let metricTile = null;
  if (totalRate > 0 && isFinite(invVal)) {
    const usable = invVal - 0.05 * capVal;
    const days = usable / totalRate;
    const cls = days <= 3 ? ' danger' : (days <= 10 ? ' warn' : '');
    metricTile = h('div', { class: 'metric' + cls }, [
      h('div', { class: 'metric-big', text: (days <= 0 ? '0' : days.toFixed(1)) + ' days to empty' }),
      h('div', { class: 'metric-sub', text: `usable ${Math.max(0, usable).toFixed(0)} gal ÷ ${totalRate}/day (5% heel)` }),
    ]);
  }

  const ptypeRO = h('input', { type: 'text', disabled: '' }); ptypeRO.value = tank.product_type || '';
  // confirmations are only required for fields that have a pre-populated value to check
  const needSize = tank.tank_volume != null && tank.tank_volume !== '';
  const needProduct = tank.product != null && tank.product !== '';
  const canReview = (!needSize || tank.size_confirmed != null) && (!needProduct || tank.product_confirmed != null);
  const reviewed = !!tank.reviewed_at;
  const revChip = reviewed
    ? h('div', { class: 'rev-chip ok', text: '✓ Reviewed' + (tank.reviewed_by ? ' · ' + tank.reviewed_by : '') })
    : h('div', { class: 'rev-chip warn', text: '● Needs review' });
  const reviewBtn = reviewed
    ? h('button', { class: 'btn ghost block', onclick: async () => { await Sync.editTank(tank.id, { reviewed_at: null, reviewed_by: null }); await refreshDetail(); toast('Reopened for editing'); } }, '✓ Reviewed — tap to reopen')
    : h('button', { class: 'btn primary block', ...(canReview ? {} : { disabled: '' }), onclick: async () => { await Sync.editTank(tank.id, { reviewed_at: new Date().toISOString(), reviewed_by: Sync.userEmail() }); await refreshDetail(); toast('Marked reviewed', 'ok'); } }, canReview ? 'Mark reviewed' : 'Confirm the shown values to review');

  const body = h('div', { class: 'panel-body' }, [
    h('div', { class: 'section-title', style: 'margin-top:0', text: 'Tank' }),
    h('div', { class: 'tank-name-lg', text: combinedName(tank) }),
    h('div', { class: 'mono muted', style: 'word-break:break-all;font-size:.72rem;margin:.15rem 0 .2rem', text: 'ID: ' + tank.tgl_slot }),
    revChip,
    metricTile,

    h('div', { class: 'section-title', text: 'Configuration' }),
    productField(tank),
    numberFieldInline('Tank size (gal)', tank.tank_volume, (v) => Sync.editTank(tank.id, { tank_volume: v }),
      { show: needSize, value: tank.size_confirmed, onSave: (v) => Sync.editTank(tank.id, { size_confirmed: v }) }),
    h('div', { class: 'grid2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Product type (auto)'), ptypeRO]),
      selectWithOther('Application', tank.application_id, applications, (v) => Sync.editTank(tank.id, { application_id: v })),
    ]),
    h('div', { class: 'grid2' }, [
      editField('Current inventory (gal)', tank.current_inventory, (v) => Sync.editTank(tank.id, { current_inventory: v }), { type: 'number', number: true, inputmode: 'decimal', refresh: true }).wrap,
      editField('Asset tag', tank.asset_tag, (v) => Sync.editTank(tank.id, { asset_tag: v }), { raw: true }).wrap,
    ]),
    checkboxField('Needs order', tank.needs_order, (v) => Sync.editTank(tank.id, { needs_order: v })),
    editField('Notes', tank.notes, (v) => Sync.editTank(tank.id, { notes: v }), { type: 'textarea', rows: 2 }).wrap,

    h('div', { class: 'section-title', text: `Wells served (${wells.filter((w) => w.is_attached && !w.is_deleted).length})` }),
    ...wells.filter((w) => !w.is_deleted).map((w) => wellCard(w, tank, pumpMakes)),
    attachForm(tank),

    h('div', { class: 'section-title', text: 'Review' }),
    reviewBtn,
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
  const banner = $('#offline-banner');
  if (banner) banner.classList.toggle('hidden', navigator.onLine);
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
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Checking…';
    const r = await Sync.login(email);
    btn.disabled = false;
    if (r.ok) { msg.className = 'msg'; msg.textContent = ''; await routeAuth(); }
    else if (r.reason === 'not_allowed') { msg.className = 'msg err'; msg.textContent = "That email isn't on the approved list. Ask an admin to add it."; }
    else { msg.className = 'msg err'; msg.textContent = r.reason || 'Could not sign in.'; }
  });
  $('#signout-btn').addEventListener('click', () => { Sync.logout(); $('#account-menu').classList.add('hidden'); show('login'); });
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
  $('#filter-status').addEventListener('change', render);
  window.addEventListener('online', updateSyncUI);
  window.addEventListener('offline', updateSyncUI);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && APP.currentTankId) closeDetail(); });
}

boot();
