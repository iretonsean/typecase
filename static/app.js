'use strict';
/* Typecase front end. Plain JS, no libraries. */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
  return j;
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

/* ------------------------------------------------------------ fonts */
const lib = { families: [], by: new Map(), favs: new Set(), installs: [], fontDir: '' };
const faces = new Map();
const fontUrl = (p, i) => '/font?path=' + encodeURIComponent(p) + (i ? '&index=' + i : '');
const fkey = s => s.file + '#' + (s.index || 0);
function faceInfo(file, variable, index) {
  const key = file + '#' + (index || 0);
  let f = faces.get(key);
  if (!f) {
    f = { name: 'tcf' + (faces.size + 1), variable: !!variable, p: null };
    faces.set(key, f);
    f.p = new FontFace(f.name, 'url("' + fontUrl(file, index) + '")', variable ? { weight: '1 1000', stretch: '25% 200%' } : {})
      .load().then(ff => { document.fonts.add(ff); return f; }).catch(() => f);
  }
  return f;
}
/* style = {file, weight, width, variable} */
function fontCss(s) {
  const f = faceInfo(s.file, s.variable, s.index);
  return { fontFamily: '"' + f.name + '", system-ui, sans-serif', fontWeight: s.variable ? String(s.weight) : '400',
    fontStretch: s.variable ? s.width + '%' : '100%', fontStyle: 'normal', fontSynthesis: 'none' };
}
function applyFont(el, s) { Object.assign(el.style, fontCss(s)); }
const io = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); if (e.target._s) applyFont(e.target, e.target._s); }
}, { rootMargin: '300px' });
function lazyFont(el, s) { el._s = s; io.observe(el); }
function repStyle(fam) {
  return fam.styles.filter(s => !s.italic).sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400) || Math.abs(a.width - 100) - Math.abs(b.width - 100))[0] || fam.styles[0];
}
function findStyle(fam, name) { return fam.styles.find(s => s.style === name) || repStyle(fam); }

/* ------------------------------------------------------------ tabs */
function showTab(t) {
  if (t !== 'install' && inst.stage) { cancelStage(); $('#inst-out').replaceChildren(); }
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + t));
  if (t === 'compare') renderCompare();
  if (t === 'canvas') setTimeout(() => { if (!cv.zoomSet) fitZoom(); }, 30);
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ------------------------------------------------------------ library */
const prefs = Object.assign({ scope: 'all', mono: false, vari: false, fav: false, sort: 'name', text: 'The quick brown fox jumps over the lazy dog', size: 26 });
let selFam = null, query = '';
let prefT;
function savePrefs() { clearTimeout(prefT); prefT = setTimeout(() => api('/api/state', { key: 'prefs', value: { lib: prefs, cmp } }).catch(() => {}), 400); }
function chip(label, on, fn) { return h('button', { class: 'chip' + (on ? ' on' : ''), onclick: fn }, label); }
function renderChips() {
  const sc = $('#f-scope'); sc.replaceChildren(
    ...[['all', 'All'], ['user', 'User-installed'], ['system', 'System']].map(([k, l]) => chip(l, prefs.scope === k, () => { prefs.scope = k; savePrefs(); renderChips(); renderList(); })));
  const mo = $('#f-more'); mo.replaceChildren(
    chip('Monospace', prefs.mono, () => { prefs.mono = !prefs.mono; savePrefs(); renderChips(); renderList(); }),
    chip('Variable', prefs.vari, () => { prefs.vari = !prefs.vari; savePrefs(); renderChips(); renderList(); }),
    chip('Favorites', prefs.fav, () => { prefs.fav = !prefs.fav; savePrefs(); renderChips(); renderList(); }));
}
function visibleFamilies() {
  const q = query.trim().toLowerCase();
  let l = lib.families.filter(f => (!q || f.name.toLowerCase().includes(q)) &&
    (prefs.scope === 'all' || (prefs.scope === 'user' ? f.user : !f.user)) && (!prefs.mono || f.mono) && (!prefs.vari || f.variable) && (!prefs.fav || lib.favs.has(f.name)));
  if (prefs.sort === 'recent') l.sort((a, b) => b.mtime - a.mtime);
  else if (prefs.sort === 'styles') l.sort((a, b) => b.styles.length - a.styles.length || a.name.localeCompare(b.name));
  return l;
}
function renderList() {
  const box = $('#fam-list'), l = visibleFamilies();
  $('#count').textContent = lib.families.length + ' families';
  if (!l.length) { box.replaceChildren(h('div', { class: 'empty' }, 'No fonts match.')); return; }
  box.replaceChildren(...l.map(f => {
    const pv = h('div', { class: 'pv', style: { fontSize: prefs.size + 'px' } }, prefs.text || f.name);
    lazyFont(pv, repStyle(f));
    return h('div', { class: 'fam' + (selFam === f.name ? ' sel' : ''), 'data-n': f.name, onclick: () => openFamily(f.name) },
      h('div', { class: 'meta' }, h('b', {}, f.name), h('span', {}, (f.variable ? 'Variable  ' : '') + (lib.favs.has(f.name) ? 'Fav  ' : '') + f.styles.length + (f.styles.length === 1 ? ' style' : ' styles')),
        h('button', { class: 'ghost cmpbtn', title: 'Add to Compare', onclick: e => { e.stopPropagation(); cmpAdd(f.name); } }, 'Compare')), pv);
  }));
}
$('#q').oninput = e => { query = e.target.value; renderList(); };
$('#sort').onchange = e => { prefs.sort = e.target.value; savePrefs(); renderList(); };
$('#ptext').oninput = e => { prefs.text = e.target.value; savePrefs(); renderList(); if (selFam) renderDetail(); };
$('#psize').oninput = e => { prefs.size = +e.target.value; savePrefs(); document.querySelectorAll('.fam .pv').forEach(p => p.style.fontSize = prefs.size + 'px'); };

async function loadLib(refresh) {
  const d = await api('/api/fonts' + (refresh ? '?refresh=1' : ''));
  lib.families = d.families; lib.favs = new Set(d.favorites); lib.installs = d.installs; lib.fontDir = d.fontDir;
  lib.by = new Map(d.families.map(f => [f.name, f]));
  renderList(); if (selFam) renderDetail(); renderInstalled();
}
const infoCache = new Map();
function getInfo(file, index) {
  const k = file + '#' + (index || 0);
  if (!infoCache.has(k)) infoCache.set(k, api('/api/fontinfo?path=' + encodeURIComponent(file) + '&index=' + (index || 0)).catch(() => ({ features: [], axes: [], instances: [] })));
  return infoCache.get(k);
}
function installsFor(fam) {
  const files = new Set(fam.styles.map(s => s.file));
  return lib.installs.filter(i => i.files.some(f => files.has(f)));
}
function openFamily(name) { selFam = name; document.querySelectorAll('.fam').forEach(r => r.classList.toggle('sel', r.dataset.n === name)); renderDetail(); $('#lib-main').scrollTop = 0; }
let glyphStyleName = null, confirmUn = null;
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,:;!?\'"-_()[]{}/\\@#$%&*+=<>~|^`';
async function toggleFav(name) {
  if (lib.favs.has(name)) lib.favs.delete(name); else lib.favs.add(name);
  await api('/api/state', { key: 'favorites', value: [...lib.favs] }); renderList(); renderDetail();
}
function renderDetail() {
  const box = $('#detail'), fam = lib.by.get(selFam);
  if (!fam) { box.replaceChildren(h('div', { class: 'empty' }, 'Pick a font family on the left.')); return; }
  const mine = installsFor(fam);
  const fav = lib.favs.has(fam.name);
  const head = h('div', { class: 'dhead' }, h('h1', {}, fam.name), h('span', { class: 'badge' }, fam.styles.length + ' styles'),
    fam.mono && h('span', { class: 'badge' }, 'Monospace'), fam.variable && h('span', { class: 'badge' }, 'Variable'), mine.length > 0 && h('span', { class: 'badge ok' }, 'Installed by Typecase'),
    h('span', { class: 'sp' }),
    h('button', { class: fav ? 'on' : '', onclick: () => toggleFav(fam.name) }, fav ? 'Favorite' : 'Add to favorites'),
    h('button', { onclick: () => cmpAdd(fam.name) }, 'Compare'),
    h('button', { class: 'primary', onclick: () => { addBox({ family: fam.name, style: repStyle(fam).style }); showTab('canvas'); } }, 'Use in canvas'));
  const out = [head];
  if (mine.length) {
    const un = h('div', {});
    out.push(un);
    if (confirmUn) {
      const inst = mine.find(i => i.id === confirmUn);
      if (inst) un.append(h('div', { class: 'confirm' }, h('span', {}, 'Remove ' + inst.files.length + ' font files from "' + inst.collection + '"? This also removes other families in that install.'),
        h('button', { class: 'danger', onclick: () => doUninstall(inst.id) }, 'Remove files'),
        h('button', { onclick: () => { confirmUn = null; renderDetail(); } }, 'Cancel')));
    } else for (const i of mine) un.append(h('button', { class: 'danger', style: { marginRight: '8px' }, onclick: () => { confirmUn = i.id; renderDetail(); } }, 'Uninstall "' + i.collection + '"'));
  }
  const text = prefs.text || 'The quick brown fox jumps over the lazy dog';
  const wf = h('div', {});
  for (const s of fam.styles) {
    const lines = [[44, 1.1], [24, 1.2], [16, 1.3], [12, 1.3]].map(([px, lh]) => { const d = h('div', { class: 'l', style: { fontSize: px + 'px', lineHeight: lh } }, text); return d; });
    const blk = h('div', { class: 'wf' }, h('div', { class: 'lab' }, h('b', { style: { color: '#ccc', fontWeight: 600 } }, s.style), h('span', {}, s.variable ? 'variable' : ''), h('span', { class: 'sp' }),
      h('button', { class: 'ghost', onclick: () => { addBox({ family: fam.name, style: s.style }); showTab('canvas'); } }, 'Use in canvas')), lines);
    wf.append(blk);
    lines.forEach(l => lazyFont(l, s));
  }
  out.push(h('div', { class: 'sec' }, h('h3', {}, 'Styles'), wf));
  if (!glyphStyleName || !fam.styles.some(s => s.style === glyphStyleName)) glyphStyleName = repStyle(fam).style;
  const gs = findStyle(fam, glyphStyleName);
  const sel = h('select', { onchange: e => { glyphStyleName = e.target.value; renderDetail(); } }, fam.styles.map(s => h('option', { value: s.style, selected: s.style === glyphStyleName }, s.style)));
  const grid = h('div', { class: 'glyphs' }, [...GLYPHS].map(c => h('div', {}, c)));
  applyFont(grid, gs);
  out.push(h('div', { class: 'sec' }, h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', { style: { margin: 0, flex: 1 } }, 'Glyphs'), sel), grid));
  if (fam.variable) {
    const ax = h('div', { class: 'paths' }, 'Reading axes...');
    out.push(h('div', { class: 'sec' }, h('h3', {}, 'Variable axes'), ax));
    const vs = fam.styles.find(s => s.variable);
    getInfo(vs.file, vs.index).then(info => {
      ax.replaceChildren(...(info.axes.length ? info.axes.map(a => h('div', {}, a.label + ' (' + a.tag + ')   ' + a.min + ' to ' + a.max + ', default ' + a.default)) : [h('div', {}, 'No axes found.')]),
        info.instances.length ? h('div', { style: { marginTop: '6px' } }, 'Named instances: ' + info.instances.map(i => i.name).join(', ')) : null);
    });
  }
  const files = [...new Set(fam.styles.map(s => s.file))];
  const dirs = [...new Set(files.map(f => f.replace(/\/[^/]*$/, '')))];
  out.push(h('div', { class: 'sec' }, h('h3', {}, 'Files'),
    h('div', { class: 'paths' }, dirs.map(d => h('div', {}, d, ' ', h('button', { class: 'ghost', onclick: () => navigator.clipboard.writeText(d).then(() => toast('Folder path copied')).catch(() => toast(d)) }, 'Copy folder path')))),
    h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'muted', style: { cursor: 'pointer' } }, files.length + ' files'), h('div', { class: 'paths' }, files.map(f => h('div', {}, f))))));
  box.replaceChildren(...out);
}

/* ------------------------------------------------------------ compare */
const cmp = Object.assign({ items: [], text: 'Sphinx of black quartz, judge my vow. 0123456789', size: 56 });
const saveCmp = () => savePrefs();
function cmpAdd(name) {
  if (cmp.items.some(i => i.family === name)) { showTab('compare'); return; }
  if (cmp.items.length >= 4) { toast('Compare holds 4 families. Remove one first.'); showTab('compare'); return; }
  const f = lib.by.get(name); if (!f) return;
  cmp.items.push({ family: name, style: repStyle(f).style }); saveCmp(); showTab('compare');
}
function renderCompare() {
  cmp.items = cmp.items.filter(i => lib.by.has(i.family));
  $('#cmp-size').value = cmp.size; $('#cmp-sz').textContent = cmp.size + ' px';
  $('#cmp-chips').replaceChildren(...cmp.items.map((it, k) => h('span', { class: 'cmpchip' }, it.family, h('button', { title: 'Remove', onclick: () => { cmp.items.splice(k, 1); saveCmp(); renderCompare(); } }, '×'))));
  $('#cmp-add').disabled = cmp.items.length >= 4;
  const box = $('#cmp-cols');
  if (!cmp.items.length) { box.replaceChildren(h('div', { class: 'empty', style: { gridColumn: '1/-1' } }, 'Add families with the Compare button in the Library, or use Add family.')); return; }
  box.replaceChildren(...cmp.items.map(it => {
    const fam = lib.by.get(it.family), s = findStyle(fam, it.style);
    const smp = h('div', { class: 'smp', contenteditable: 'plaintext-only', spellcheck: 'false', style: { fontSize: cmp.size + 'px' } }, cmp.text);
    applyFont(smp, s);
    smp.oninput = () => { cmp.text = smp.innerText; saveCmp(); document.querySelectorAll('#cmp-cols .smp').forEach(o => { if (o !== smp) o.textContent = cmp.text; }); };
    const sel = h('select', { onchange: e => { it.style = e.target.value; saveCmp(); applyFont(smp, findStyle(fam, it.style)); } }, fam.styles.map(x => h('option', { value: x.style, selected: x.style === it.style }, x.style)));
    return h('div', { class: 'ccol' }, h('div', { class: 'hd' }, h('b', {}, it.family), sel), smp);
  }));
}
$('#cmp-size').oninput = e => { cmp.size = +e.target.value; saveCmp(); $('#cmp-sz').textContent = cmp.size + ' px'; document.querySelectorAll('#cmp-cols .smp').forEach(o => o.style.fontSize = cmp.size + 'px'); };
$('#cmp-add').onclick = () => pickerPop($('#cmp-add'), '', f => cmpAdd(f.name));

/* ------------------------------------------------------------ install */
function cancelStage() { if (inst.stage) { api('/api/cancel', { stage: inst.stage }).catch(() => {}); inst.stage = null; } }
let confirmInst = null;
function renderInstalled() {
  const box = $('#inst-list'); if (!box) return;
  if (!lib.installs.length) { box.replaceChildren(); return; }
  box.replaceChildren(h('h3', { style: { margin: '30px 0 10px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.8px', color: 'var(--muted)' } }, 'Installed by Typecase'),
    ...lib.installs.map(i => h('div', { class: 'instrow' }, h('div', { class: 'info' }, h('b', {}, i.collection), h('div', { class: 'muted' }, (i.source || 'unknown source'), '  ', i.date, '  ', i.files.length + ' files')),
      confirmInst === i.id
        ? h('span', { class: 'row' }, h('span', { class: 'muted' }, 'Remove ' + i.files.length + ' files?'), h('button', { class: 'danger', onclick: () => doUninstall(i.id) }, 'Remove files'), h('button', { onclick: () => { confirmInst = null; renderInstalled(); } }, 'Cancel'))
        : h('button', { class: 'danger', onclick: () => { confirmInst = i.id; renderInstalled(); } }, 'Uninstall'))));
}
async function doUninstall(id) {
  try {
    const r = await api('/api/uninstall', { id });
    toast(r.removed ? 'Uninstalled ' + r.removed + ' files' : 'Nothing was removed. The files were already gone.');
    confirmInst = null; confirmUn = null; await loadLib(true); if (!lib.by.get(selFam)) selFam = null; renderDetail();
  } catch (e) { toast(e.message); }
}
const inst = { stage: null, items: [], sel: new Set() };
function instMsg(cls, text) { return h('div', { class: cls }, text); }
async function startFetch(url, existingJob) {
  const out = $('#inst-out'); cancelStage();
  const prog = h('div', { class: 'prog' }, 'Starting');
  out.replaceChildren(prog);
  $('#fetch').disabled = true;
  try {
    let job = existingJob;
    if (!job) job = (await api('/api/fetch', { url })).job;
    for (;;) {
      const j = await api('/api/job?id=' + job);
      prog.textContent = j.text;
      if (j.done) {
        if (j.error) { out.replaceChildren(instMsg('err', j.error)); }
        else renderPreview(j.result);
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }
  } catch (e) { out.replaceChildren(instMsg('err', e.message)); }
  $('#fetch').disabled = false;
}
$('#fetch').onclick = () => startFetch($('#url').value);
$('#url').onkeydown = e => { if (e.key === 'Enter') startFetch($('#url').value); };

function renderPreview(res) {
  inst.stage = res.stage; inst.items = res.items; inst.sel = new Set();
  const fewEnough = res.items.length <= 60;
  if (fewEnough) res.items.forEach(i => { if (!i.dup) inst.sel.add(i.i); });
  const out = $('#inst-out');
  const folders = new Map();
  res.items.forEach(i => { if (!folders.has(i.folder)) folders.set(i.folder, []); folders.get(i.folder).push(i); });
  const countEl = h('b', {}), btn = h('button', { class: 'primary' }, 'Install');
  const coll = h('input', { type: 'text', value: res.source.label.split('/').pop(), style: { width: '200px' }, title: 'Collection folder name' });
  const checks = []; // {el, items}
  function sync() {
    countEl.textContent = inst.sel.size + ' of ' + res.items.length + ' selected';
    btn.disabled = !inst.sel.size;
    for (const c of checks) {
      const n = c.items.filter(i => inst.sel.has(i.i)).length;
      c.el.checked = n === c.items.length; c.el.indeterminate = n > 0 && n < c.items.length;
      if (c.cnt) c.cnt.textContent = n + '/' + c.items.length;
    }
    for (const r of rows) r.el.checked = inst.sel.has(r.i);
  }
  const rows = [];
  const folderEls = [...folders.entries()].map(([name, items], idx) => {
    const fc = h('input', { type: 'checkbox', onclick: e => e.stopPropagation(), onchange: e => { items.forEach(i => e.target.checked ? inst.sel.add(i.i) : inst.sel.delete(i.i)); sync(); } });
    const cnt = h('span', { class: 'muted' });
    checks.push({ el: fc, items, cnt });
    const dups = items.filter(i => i.dup).length;
    const det = h('details', { class: 'fold' }, h('summary', {}, fc, h('span', { class: 'name' }, name), dups ? h('span', { class: 'badge warn' }, dups + ' already on system') : null, cnt));
    let built = false;
    const build = () => {
      if (built) return; built = true;
      for (const it of items) {
        const cb = h('input', { type: 'checkbox', onchange: e => { e.target.checked ? inst.sel.add(it.i) : inst.sel.delete(it.i); sync(); } });
        rows.push({ el: cb, i: it.i });
        const pv = h('div', { class: 'pv' }, it.family + ' ' + it.style);
        lazyFont(pv, { file: it.path, weight: 400, width: 100, variable: false });
        det.append(h('label', { class: 'frow' }, cb, pv, h('div', { class: 'info' }, h('b', {}, it.family + ' ' + it.style), it.name,
          it.dup ? h('div', {}, h('span', { class: 'badge warn', title: 'A family with this name is already installed. Two copies can conflict.' }, 'Name already installed')) : null)));
      }
      sync();
    };
    det.addEventListener('toggle', () => { if (det.open) build(); });
    if (idx === 0) { det.open = true; build(); }
    return det;
  });
  const q = h('input', { type: 'search', placeholder: 'Find a family in this list', style: { width: '200px' }, oninput: e => {
    const v = e.target.value.toLowerCase();
    if (v) {
      folderEls.forEach(d => d.open = true);
      document.querySelectorAll('#inst-out .frow').forEach(r => r.style.display = r.textContent.toLowerCase().includes(v) ? '' : 'none');
    } else document.querySelectorAll('#inst-out .frow').forEach(r => r.style.display = '');
  } });
  btn.onclick = async () => {
    btn.disabled = true; const note = h('div', { class: 'prog' }, 'Copying ' + inst.sel.size + ' files and updating the font cache. This can take a minute.');
    out.prepend(note);
    try {
      const r = await api('/api/install', { stage: inst.stage, files: [...inst.sel], collection: coll.value });
      await loadLib(true);
      const first = r.families[0];
      inst.stage = null;
      out.replaceChildren(h('div', { class: 'okbox' }, 'Installed ' + r.files.length + ' files into ' + r.dir + '. ',
        first && h('button', { onclick: () => { showTab('library'); query = first; $('#q').value = first; renderList(); openFamily(first); } }, 'Show ' + first + ' in the library')));
    } catch (e) { note.className = 'err'; note.textContent = e.message; btn.disabled = false; }
  };
  out.replaceChildren(
    h('div', { class: 'okbox' }, 'Found ' + res.items.length + ' font files in ' + folders.size + (folders.size === 1 ? ' folder' : ' folders') + ' from ' + res.source.label + '.' +
      (res.skipped ? ' ' + res.skipped + ' web font files (woff/woff2) were skipped.' : '') +
      (fewEnough ? '' : ' Nothing is selected yet because there are many files. Choose the folders or files you want.')),
    h('div', { class: 'pbar' }, countEl, h('button', { onclick: () => { res.items.forEach(i => inst.sel.add(i.i)); sync(); } }, 'Select all'),
      h('button', { onclick: () => { inst.sel.clear(); sync(); } }, 'Select none'), q, h('span', { class: 'sp' }), h('span', { class: 'muted' }, 'Install into'), coll, btn),
    ...folderEls);
  sync();
}

/* ------------------------------------------------------------ canvas */
const PRESETS = { 'A4': [794, 1123], 'Letter': [816, 1056], '1080 x 1080': [1080, 1080], '1920 x 1080': [1920, 1080], 'Custom': null };
const cv = { doc: { artboard: { w: 794, h: 1123, bg: '#ffffff', preset: 'A4' }, layers: [] }, sel: null, selSet: [], dsel: new Set(), tool: 'select', open: new Set(), zoom: 1, pan: { x: 60, y: 60 }, zoomSet: false, hist: [], hi: -1, editing: null };
function sanitizeDoc(d) {
  if (!d || typeof d !== 'object' || !d.artboard || typeof d.artboard !== 'object') return null;
  const src = Array.isArray(d.layers) ? d.layers : Array.isArray(d.boxes) ? d.boxes : null;   /* old documents used "boxes" */
  if (!src) return null;
  const a = d.artboard, w = num_(a.w, NaN), hh = num_(a.h, NaN);
  if (!(w >= 50 && w <= 20000 && hh >= 50 && hh <= 20000)) return null;
  const out = { artboard: { w, h: hh, bg: okColor(a.bg, '#ffffff'), preset: typeof a.preset === 'string' ? a.preset : 'Custom' }, layers: [] };
  const clamp = (v, lo, hi, df) => Math.min(hi, Math.max(lo, num_(v, df)));
  const budget = { nodes: 200000 };
  const scl = v => { const n = +v; if (!Number.isFinite(n) || n === 0) return 1; return Math.sign(n) * Math.min(100, Math.max(0.01, Math.abs(n))); };
  const seen = new Set();
  const freshId = v => { let id = typeof v === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(v) && !seen.has(v) ? v : uid(); while (seen.has(id)) id = uid(); seen.add(id); return id; };
  const common = (b, type, dflt) => ({ id: freshId(b.id), type, name: typeof b.name === 'string' ? b.name.slice(0, 80) : dflt, visible: b.visible !== false, locked: b.locked === true });
  const pt = p => Array.isArray(p) && p.length === 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) ? [clamp(p[0], -1e6, 1e6, 0), clamp(p[1], -1e6, 1e6, 0)] : null;
  const path = b => {
    const contours = [];
    if (Array.isArray(b.contours)) for (const c of b.contours.slice(0, 500)) {
      if (!c || !Array.isArray(c.nodes)) continue;
      const nodes = [];
      for (const n of c.nodes.slice(0, 20000)) {
        if (!n || budget.nodes-- <= 0 || !Number.isFinite(+n.x) || !Number.isFinite(+n.y)) continue;
        nodes.push({ x: clamp(n.x, -1e6, 1e6, 0), y: clamp(n.y, -1e6, 1e6, 0), i: pt(n.i), o: pt(n.o) });
      }
      if (nodes.length) contours.push({ closed: c.closed !== false, nodes });
    }
    return Object.assign(common(b, 'path', 'Path'), { contours, fill: okColor(b.fill, '#111111'), op: clamp(b.op, 0, 1, 1) });
  };
  for (const b of src.slice(0, 500)) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'group') {
      out.layers.push(Object.assign(common(b, 'group', 'Group'), { children: Array.isArray(b.children) ? b.children.slice(0, 5000).filter(c => c && typeof c === 'object').map(path) : [] }));
      continue;
    }
    if (b.type === 'path') { out.layers.push(path(b)); continue; }
    const feat = {}, vars = {};
    if (b.feat && typeof b.feat === 'object') for (const [k, v] of Object.entries(b.feat)) if (/^[A-Za-z0-9]{4}$/.test(k)) feat[k] = +v ? 1 : 0;
    if (b.vars && typeof b.vars === 'object') for (const [k, v] of Object.entries(b.vars)) if (/^[A-Za-z0-9]{4}$/.test(k) && Number.isFinite(+v)) vars[k] = +v;
    out.layers.push(Object.assign(common(b, 'text', ''), { x: clamp(b.x, -50000, 50000, 0), y: clamp(b.y, -50000, 50000, 0), w: clamp(b.w, 20, 20000, 400),
      text: typeof b.text === 'string' ? b.text.slice(0, 20000) : '', family: typeof b.family === 'string' ? b.family : '', style: typeof b.style === 'string' ? b.style : '',
      size: clamp(b.size, 1, 2000, 48), lh: clamp(b.lh, 0.3, 10, 1.2), ls: clamp(b.ls, -100, 200, 0), align: ['left', 'center', 'right'].includes(b.align) ? b.align : 'left',
      color: okColor(b.color, '#111111'), tt: b.tt === 'upper' ? 'upper' : 'none', op: clamp(b.op, 0, 1, 1), feat, vars,
      rot: Number.isFinite(+b.rot) ? +normDeg(+b.rot).toFixed(3) : 0, sx: scl(b.sx), sy: scl(b.sy) }));
  }
  return out;
}
const uid = () => Math.random().toString(36).slice(2, 9);
const ab = $('#artboard');
$('#preset').replaceChildren(...Object.keys(PRESETS).map(k => h('option', { value: k }, k)));
const snap = () => JSON.stringify(cv.doc);
function commit() {
  const s = snap();
  if (cv.hist[cv.hi] === s) return;
  cv.hist = cv.hist.slice(0, cv.hi + 1); cv.hist.push(s); if (cv.hist.length > 200) cv.hist.shift(); cv.hi = cv.hist.length - 1;
  scheduleSave(); updBtns();
}
function restore(s) { cv.doc = JSON.parse(s); cv.selSet = cv.selSet.filter(id => findItem(id)); cv.sel = cv.selSet.includes(cv.sel) ? cv.sel : (cv.selSet[cv.selSet.length - 1] || null); cv.dsel = new Set(); renderAll(); scheduleSave(); updBtns(); }
function undo() { if (cv.hi > 0) { cv.hi--; restore(cv.hist[cv.hi]); } }
function redo() { if (cv.hi < cv.hist.length - 1) { cv.hi++; restore(cv.hist[cv.hi]); } }
function updBtns() { $('#undo').disabled = cv.hi <= 0; $('#redo').disabled = cv.hi >= cv.hist.length - 1; const has = cv.selSet.length > 0; $('#dup').disabled = !has; $('#del').disabled = !has; }
let saveT;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(() => { saveT = null; api('/api/state', { key: 'canvas', value: cv.doc }).catch(() => {}); }, 500); }
const boxById = id => { const it = id && findItem(id); return it && it.item.type === 'text' ? it.item : undefined; };
function resolveStyle(b) {
  const fam = lib.by.get(b.family) || lib.families.find(f => f.name === 'Noto Sans') || lib.families[0];
  if (!fam) return null;
  return { fam, s: findStyle(fam, b.style) };
}
function defaultFamily() { const f = lib.by.get('Noto Sans') || lib.families[0]; return f ? f.name : ''; }
function addBox(over, at) {
  const a = cv.doc.artboard;
  const fam = lib.by.get(over && over.family) || lib.by.get(defaultFamily());
  const w = Math.min(520, a.w - 80);
  const b = Object.assign({ id: uid(), type: 'text', name: '', visible: true, locked: false, x: at ? at.x : Math.round((a.w - w) / 2), y: at ? at.y : Math.round(a.h / 3 + cv.doc.layers.length * 24), w, text: 'Double-click to edit',
    family: fam ? fam.name : '', style: fam ? repStyle(fam).style : '', size: 48, lh: 1.2, ls: 0, align: 'left', color: '#111111', tt: 'none', op: 1, feat: {}, vars: {}, rot: 0, sx: 1, sy: 1 }, over || {});
  if (fam && !b.style) b.style = repStyle(fam).style;
  cv.doc.layers.push(b); setSel([b.id]); renderAll(); commit();
  return b;
}
const tfOf = b => ({ r: Number.isFinite(+b.rot) ? +b.rot : 0, sx: +b.sx || 1, sy: +b.sy || 1 });
const normDeg = d => ((d + 180) % 360 + 360) % 360 - 180;
function tfCss(b) { const t = tfOf(b); return t.r || t.sx !== 1 || t.sy !== 1 ? 'rotate(' + fmt(t.r) + 'deg) scale(' + +t.sx.toFixed(4) + ',' + +t.sy.toFixed(4) + ')' : ''; }
function styleBox(el, b) {
  el.style.transformOrigin = '50% 50%'; el.style.transform = tfCss(b);
  const r = resolveStyle(b);
  Object.assign(el.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', fontSize: b.size + 'px', lineHeight: b.lh, letterSpacing: b.ls + 'px',
    textAlign: b.align, color: b.color, textTransform: b.tt === 'upper' ? 'uppercase' : 'none', opacity: b.op });
  if (r) {
    applyFont(el, r.s);
    el.style.fontFeatureSettings = featCss(b);
    el.style.fontVariationSettings = r.s.variable ? varCss(b) : 'normal';
  }
}
const DEFAULT_ON = new Set(['liga', 'calt', 'kern', 'clig', 'ccmp', 'locl', 'mark', 'mkmk']);
function featCss(b) { const e = Object.entries(b.feat || {}); return e.length ? e.map(([t, v]) => '"' + t + '" ' + v).join(',') : 'normal'; }
function varCss(b) { const e = Object.entries(b.vars || {}); return e.length ? e.map(([t, v]) => '"' + t + '" ' + v).join(',') : 'normal'; }
const needsSvgPath = (b, r) => Object.keys(b.feat || {}).length > 0 || (r.s.variable && Object.keys(b.vars || {}).length > 0);
function boxEl(b) {
  const el = h('div', { class: 'tb' + (cv.selSet.includes(b.id) ? ' sel' : '') + (b.locked ? ' locked' : ''), 'data-id': b.id });
  el.style.display = b.visible === false ? 'none' : '';
  const t = h('span', {}, b.text); el.append(t);
  el.append(h('i', { class: 'hdl' }));
  styleBox(el, b);
  return el;
}
function renderBoxEl(b) {
  const el = ab.querySelector('[data-id="' + CSS.escape(b.id) + '"]');
  if (!el) return;
  styleBox(el, b); if (cv.editing !== b.id) el.firstChild.textContent = b.text;
  el.style.display = b.visible === false ? 'none' : ''; el.classList.toggle('locked', !!b.locked);
}
function renderAll() {
  const a = cv.doc.artboard;
  ab.style.width = a.w + 'px'; ab.style.height = a.h + 'px'; ab.style.background = a.bg;
  $('#abg').value = a.bg; $('#preset').value = a.preset in PRESETS ? a.preset : 'Custom';
  $('#custom').style.display = $('#preset').value === 'Custom' ? 'flex' : 'none'; $('#cw').value = a.w; $('#ch').value = a.h;
  ab.replaceChildren(...cv.doc.layers.map(l => l.type === 'text' ? boxEl(l) : vecEl(l)), makeOverlay(), h('div', { class: 'guide', id: 'gv', style: { width: '1px', top: 0, bottom: 0, left: '50%' } }), h('div', { class: 'guide', id: 'gh', style: { height: '1px', left: 0, right: 0, top: '50%' } }));
  applyZoom(); renderInsp(); renderLayers(); renderOverlay(); updBtns();
}
function applyZoom() {
  const a = cv.doc.artboard, z = cv.zoom;
  ab.style.transform = 'scale(' + z + ')'; if (typeof renderOverlay === 'function') renderOverlay();
  const w = $('#cv-wrap'); w.style.width = a.w * z + 'px'; w.style.height = a.h * z + 'px';
  w.style.left = cv.pan.x + 'px'; w.style.top = cv.pan.y + 'px';
  $('#zl').textContent = Math.round(z * 100) + '%';
}
function fitZoom() {
  const s = $('#cv-scroll'), a = cv.doc.artboard;
  if (!s.clientWidth) return;
  cv.zoom = Math.max(0.05, Math.min((s.clientWidth - 140) / a.w, (s.clientHeight - 140) / a.h, 2)); cv.zoomSet = false;
  cv.pan = { x: Math.round((s.clientWidth - a.w * cv.zoom) / 2), y: Math.round((s.clientHeight - a.h * cv.zoom) / 2) }; applyZoom();
}
$('#zfit').onclick = fitZoom;
/* Zoom so the page point under (mx, my) — view coordinates inside #cv-scroll — stays under it. */
function zoomAt(nz, mx, my) {
  nz = Math.max(0.05, Math.min(16, nz));
  const ax = (mx - cv.pan.x) / cv.zoom, ay = (my - cv.pan.y) / cv.zoom;
  cv.zoom = nz; cv.pan = { x: mx - ax * nz, y: my - ay * nz }; cv.zoomSet = true; applyZoom();
}
const viewCenter = () => { const s = $('#cv-scroll'); return [s.clientWidth / 2, s.clientHeight / 2]; };
$('#z100').onclick = () => zoomAt(1, ...viewCenter());
$('#cv-scroll').addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {               /* Ctrl+wheel and trackpad pinch: zoom toward the pointer */
    const r = $('#cv-scroll').getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(cv.zoom * Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.004), e.clientX - r.left, e.clientY - r.top);
  } else {                                    /* plain wheel / two-finger scroll pans; Shift turns it sideways */
    const k = e.deltaMode === 1 ? 16 : 1, dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k, dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
    cv.pan = { x: cv.pan.x - dx, y: cv.pan.y - dy }; cv.zoomSet = true; applyZoom();
  }
}, { passive: false });
/* Hand tool (H), Space held, or middle mouse button: drag to move the view. */
let spaceHand = false;
const handOn = () => cv.tool === 'hand' || spaceHand;
$('#cv-scroll').addEventListener('pointerdown', e => {
  if (!(e.button === 1 || (e.button === 0 && handOn()))) return;
  e.preventDefault(); e.stopPropagation();
  const sc = $('#cv-scroll'), x0 = e.clientX, y0 = e.clientY, p0 = { ...cv.pan };
  sc.classList.add('panning'); sc.setPointerCapture(e.pointerId);
  const mv = ev => { cv.pan = { x: p0.x + ev.clientX - x0, y: p0.y + ev.clientY - y0 }; cv.zoomSet = true; applyZoom(); };
  const up = () => { sc.classList.remove('panning'); sc.removeEventListener('pointermove', mv); sc.removeEventListener('pointerup', up); sc.removeEventListener('pointercancel', up); };
  sc.addEventListener('pointermove', mv); sc.addEventListener('pointerup', up); sc.addEventListener('pointercancel', up);
}, true);
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.repeat || cv.editing || !$('#v-canvas').classList.contains('active')) return;
  if (e.target.matches && e.target.matches('input,textarea,select,button,[contenteditable]:not([contenteditable=false])')) return;
  e.preventDefault(); spaceHand = true; $('#cv-scroll').classList.add('space');
});
document.addEventListener('keyup', e => { if (e.code === 'Space' && spaceHand) { spaceHand = false; $('#cv-scroll').classList.remove('space'); } });
window.addEventListener('blur', () => { spaceHand = false; $('#cv-scroll').classList.remove('space'); });
window.addEventListener('resize', () => { if (!cv.zoomSet && $('#v-canvas').classList.contains('active')) fitZoom(); });

function artPoint(e) { const r = ab.getBoundingClientRect(); return { x: (e.clientX - r.left) / cv.zoom, y: (e.clientY - r.top) / cv.zoom }; }
function beginEdit(id) {
  const el = ab.querySelector('[data-id="' + CSS.escape(id) + '"]'), b = boxById(id); if (!el || !b) return;
  cv.editing = id; el.classList.add('edit');
  const t = el.firstChild; t.contentEditable = 'plaintext-only'; if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
  t.style.outline = 'none'; t.focus();
  const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  t.oninput = () => { b.text = t.innerText.replace(/\n$/, ''); };
  t.onkeydown = e => { if (e.key === 'Escape') t.blur(); e.stopPropagation(); };
  t.onblur = () => { b.text = t.innerText.replace(/\n$/, ''); t.contentEditable = 'false'; t.onblur = null; cv.editing = null; el.classList.remove('edit'); t.textContent = b.text; commit(); renderLayers(); };
}
$('#add').onclick = () => addBox();
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#preset').onchange = e => {
  const k = e.target.value, a = cv.doc.artboard;
  a.preset = k; if (PRESETS[k]) [a.w, a.h] = PRESETS[k];
  renderAll(); fitZoom(); commit();
};
const setCustom = () => { const a = cv.doc.artboard; a.w = Math.max(50, +$('#cw').value || a.w); a.h = Math.max(50, +$('#ch').value || a.h); a.preset = 'Custom'; renderAll(); fitZoom(); commit(); };
$('#cw').onchange = setCustom; $('#ch').onchange = setCustom;
$('#abg').oninput = e => { cv.doc.artboard.bg = okColor(e.target.value, '#ffffff'); ab.style.background = e.target.value; };
$('#abg').onchange = () => commit();
/* inspector */
let inspNums = {}, inspRanges = {};
function syncInspNums() { const b = boxById(cv.sel); if (!b) return; for (const [k, el] of Object.entries(inspNums)) if (document.activeElement !== el) el.value = b[k]; for (const [k, el] of Object.entries(inspRanges)) el.value = b[k]; }
let openPop = null;
function pickerPop(anchor, cur, onPick) {
  if (openPop) { const same = openPop.anchor === anchor; openPop.close(); if (same) return; }
  const pop = h('div', { class: 'pop' });
  const inp = h('input', { type: 'text', placeholder: 'Search fonts' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    const fams = lib.families.filter(f => !q || f.name.toLowerCase().includes(q)).slice(0, 400);
    list.replaceChildren(...fams.map(f => { const it = h('div', { class: 'it' + (f.name === cur ? ' cur' : ''), onclick: () => { close(); onPick(f); } }, f.name); lazyFont(it, repStyle(f)); return it; }));
  };
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', away, true); if (openPop && openPop.pop === pop) openPop = null; };
  openPop = { anchor, pop, close };
  const away = e => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  inp.oninput = draw; inp.onkeydown = e => { if (e.key === 'Escape') close(); if (e.key === 'Enter') { const f = lib.families.find(f => f.name.toLowerCase().includes(inp.value.trim().toLowerCase())); if (f) { close(); onPick(f); } } };
  pop.append(inp, list); document.body.append(pop);
  const r = anchor.getBoundingClientRect(); pop.style.left = Math.max(8, r.right - 300) + 'px'; pop.style.top = Math.min(r.bottom + 4, innerHeight - 390) + 'px';
  draw(); inp.focus(); setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
}
function renderInsp() {
  const box = $('#insp'), b = boxById(cv.sel); inspNums = {}; inspRanges = {};
  if (!b) { renderVecInsp(box); return; }
  const live = (k, v) => { b[k] = k === 'color' ? okColor(v, '#000000') : v; renderBoxEl(b); };
  const num = (k, label, min, max, step) => {
    const n = h('input', { type: 'number', min, max, step, value: b[k] });
    const r = h('input', { type: 'range', min, max, step, value: b[k] });
    inspNums[k] = n; inspRanges[k] = r;
    n.oninput = () => { if (n.value === '') return; live(k, +n.value); r.value = n.value; }; n.onchange = commit;
    r.oninput = () => { live(k, +r.value); n.value = r.value; }; r.onchange = commit;
    return h('div', { class: 'f' }, h('span', {}, label), h('div', { class: 'row' }, r, n));
  };
  const fam = lib.by.get(b.family);
  const pickBtn = h('button', { onclick: () => pickerPop(pickBtn, b.family, f => { b.family = f.name; b.style = repStyle(f).style; b.vars = {}; b.feat = {}; renderBoxEl(b); renderInsp(); commit(); }) }, b.family || 'Choose a font');
  if (fam) { const rs = findStyle(fam, b.style); applyFont(pickBtn, rs); pickBtn.style.fontSize = '15px'; }
  const stSel = h('select', { onchange: e => { b.style = e.target.value; b.vars = {}; renderBoxEl(b); renderInsp(); commit(); } }, (fam ? fam.styles : []).map(s => h('option', { value: s.style, selected: s.style === b.style }, s.style)));
  const seg = (k, opts) => h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { class: b[k] === v ? 'on' : '', onclick: e => { b[k] = v; renderBoxEl(b); commit(); [...e.target.parentNode.children].forEach(c => c.classList.toggle('on', c === e.target)); } }, l)));
  const color = h('input', { type: 'color', value: b.color, oninput: e => live('color', e.target.value), onchange: commit });
  box.replaceChildren(h('h3', {}, 'Text'),
    h('div', { class: 'f' }, h('span', {}, 'Font'), h('div', { class: 'picker' }, pickBtn)),
    h('div', { class: 'f' }, h('span', {}, 'Style'), stSel),
    num('size', 'Size', 4, 400, 1), num('lh', 'Line height', 0.6, 3, 0.05), num('ls', 'Letter spacing', -20, 60, 0.5),
    h('div', { class: 'f' }, h('span', {}, 'Align'), seg('align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])),
    h('div', { class: 'f' }, h('span', {}, 'Case'), seg('tt', [['none', 'As typed'], ['upper', 'UPPER']])),
    h('div', { class: 'f' }, h('span', {}, 'Color'), color),
    num('op', 'Opacity', 0, 1, 0.05), num('w', 'Width', 20, 4000, 1), num('rot', 'Rotation', -180, 180, 1), scaleRow(b),
    h('div', { class: 'f' }, h('span', {}, 'Position'), h('div', { class: 'row' }, 'X', (() => { const n = h('input', { type: 'number', value: b.x, onchange: commit, oninput: e => live('x', +e.target.value) }); inspNums.x = n; return n; })(), 'Y', (() => { const n = h('input', { type: 'number', value: b.y, onchange: commit, oninput: e => live('y', +e.target.value) }); inspNums.y = n; return n; })())),
    h('div', { class: 'f' }, h('span', {}, 'Outlines'), h('button', { title: 'Ctrl+Shift+O', onclick: () => createOutlines(b.id) }, 'Create outlines')),
    h('div', { id: 'insp-ot' }));
  const rs0 = resolveStyle(b);
  if (rs0) getInfo(rs0.s.file, rs0.s.index).then(info => { if (cv.sel === b.id && $('#insp-ot')) fillOT($('#insp-ot'), b, rs0, info); });
}
function fillOT(host, b, r, info) {
  const kids = [];
  if (r.s.variable && info.axes.length) {
    const set = (tag, v) => { b.vars = Object.assign({}, b.vars, { [tag]: v }); renderBoxEl(b); inst.options[0].textContent = 'Custom'; inst.value = ''; };
    const inst = h('select', { onchange: e => { const i = info.instances[+e.target.value]; if (i) { b.vars = Object.assign({}, i.coords); renderBoxEl(b); renderInsp(); commit(); } } },
      h('option', { value: '' }, Object.keys(b.vars || {}).length ? 'Custom' : 'Style default'), ...info.instances.map((i, k) => h('option', { value: k }, i.name)));
    kids.push(h('h3', { style: { marginTop: '18px' } }, 'Variable axes'), h('div', { class: 'f' }, h('span', {}, 'Instance'), inst));
    for (const a of info.axes) {
      const cur = (b.vars && b.vars[a.tag] != null) ? b.vars[a.tag] : a.tag === 'wght' ? r.s.weight : a.tag === 'wdth' ? r.s.width : a.default;
      const step = (a.max - a.min) > 20 ? 1 : 0.01;
      const n = h('input', { type: 'number', min: a.min, max: a.max, step, value: cur }), rg = h('input', { type: 'range', min: a.min, max: a.max, step, value: cur });
      n.oninput = () => { rg.value = n.value; set(a.tag, +n.value); }; rg.oninput = () => { n.value = rg.value; set(a.tag, +rg.value); }; n.onchange = rg.onchange = commit;
      kids.push(h('div', { class: 'f' }, h('span', {}, a.label), h('div', { class: 'row' }, rg, n)));
    }
    kids.push(h('div', { class: 'f' }, h('span', {}), h('button', { onclick: () => { b.vars = {}; renderBoxEl(b); renderInsp(); commit(); } }, 'Reset axes')));
  }
  if (info.features.length) {
    kids.push(h('h3', { style: { marginTop: '18px' } }, 'Features'));
    const list = h('div', { class: 'feats' }, info.features.map(f => {
      const def = DEFAULT_ON.has(f.tag), cur = b.feat && b.feat[f.tag] != null ? !!b.feat[f.tag] : def;
      return h('label', { title: f.tag }, h('input', { type: 'checkbox', checked: cur, onchange: e => {
        b.feat = Object.assign({}, b.feat); if (e.target.checked === def) delete b.feat[f.tag]; else b.feat[f.tag] = e.target.checked ? 1 : 0;
        renderBoxEl(b); commit(); } }), h('span', {}, f.label), h('code', {}, f.tag));
    }));
    kids.push(list, h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Only features this font has are listed.'));
  }
  host.replaceChildren(...kids);
}

/* export, save, open */
function download(name, blob) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('Saved ' + name + ' to your Downloads folder'); }
const okColor = (c, d) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : d;
const num_ = (v, d) => Number.isFinite(+v) ? +v : d;
const STRETCH = [[50, 'ultra-condensed'], [62.5, 'extra-condensed'], [75, 'condensed'], [87.5, 'semi-condensed'], [100, 'normal'], [112.5, 'semi-expanded'], [125, 'expanded'], [150, 'extra-expanded'], [200, 'ultra-expanded']];
const stretchWord = w => STRETCH.reduce((a, c) => Math.abs(c[0] - w) < Math.abs(a[0] - w) ? c : a)[1];
async function prepFonts() {
  const used = new Map();
  for (const b of cv.doc.layers) { if (b.type !== 'text' || b.visible === false) continue; const r = resolveStyle(b); if (r) { const f = faceInfo(r.s.file, r.s.variable, r.s.index); used.set(fkey(r.s), { f, s: r.s }); } }
  await Promise.all([...used.values()].map(u => u.f.p));
  return used;
}
function layoutBox(ctx, b, t) {
  const text = b.tt === 'upper' ? b.text.toUpperCase() : b.text, lines = [];
  for (const para of text.split('\n')) {
    if (!para) { lines.push(''); continue; }
    let cur = '';
    for (const word of para.split(' ')) {
      const trial = cur ? cur + ' ' + word : word;
      if (ctx.measureText(trial).width <= b.w || !cur && !word) { cur = trial; continue; }
      if (cur) { lines.push(cur); cur = ''; }
      if (ctx.measureText(word).width <= b.w) { cur = word; continue; }
      for (const ch of word) { if (ctx.measureText(cur + ch).width > b.w && cur) { lines.push(cur); cur = ch; } else cur += ch; }
    }
    lines.push(cur);
  }
  return lines;
}
function setCtxFont(ctx, b, r, scale) {
  const f = faceInfo(r.s.file, r.s.variable, r.s.index);
  ctx.font = (r.s.variable ? r.s.weight : 400) + ' ' + (b.size * scale) + 'px "' + f.name + '"';
  ctx.fontStretch = r.s.variable ? stretchWord(r.s.width) : 'normal';
  ctx.letterSpacing = (b.ls * scale) + 'px';
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const b64cache = new Map();
async function b64(path, index) {
  const ck = path + '#' + (index || 0);
  if (b64cache.has(ck)) return b64cache.get(ck);
  const buf = new Uint8Array(await (await fetch(fontUrl(path, index))).arrayBuffer()); let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const v = btoa(s); b64cache.set(ck, v); return v;
}
async function fontFaceCss(used) {
  let css = '';
  for (const u of used.values()) css += '@font-face{font-family:"' + u.f.name + '";src:url(data:font/ttf;base64,' + await b64(u.s.file, u.s.index) + ');' + (u.s.variable ? 'font-weight:1 1000;font-stretch:25% 200%;' : '') + '}';
  return css;
}
/* one <text> element for a box, wrapped with the 2D context measurements */
function svgText(b, r, ctx) {
  setCtxFont(ctx, b, r, 1);
  const lines = layoutBox(ctx, b), f = faceInfo(r.s.file, r.s.variable, r.s.index);
  const m = ctx.measureText('Hg'), asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent, lh = b.size * b.lh;
  const anchor = b.align === 'center' ? 'middle' : b.align === 'right' ? 'end' : 'start';
  const x = b.align === 'center' ? b.x + b.w / 2 : b.align === 'right' ? b.x + b.w : b.x;
  const st = [];
  if (Object.keys(b.feat || {}).length) st.push('font-feature-settings:' + featCss(b).replace(/"/g, "'"));
  if (r.s.variable && Object.keys(b.vars || {}).length) st.push('font-variation-settings:' + varCss(b).replace(/"/g, "'"));
  const A = (k, v) => ' ' + k + '="' + esc(String(v)) + '"';
  let out = '<text xml:space="preserve"' + A('font-family', "'" + f.name + "', '" + b.family + "', sans-serif") + A('font-size', num_(b.size, 48)) + A('font-weight', r.s.weight) +
    (r.s.variable ? A('font-stretch', r.s.width + '%') : '') + A('letter-spacing', num_(b.ls, 0)) + A('fill', okColor(b.color, '#000000')) + A('fill-opacity', num_(b.op, 1)) + A('text-anchor', anchor) + A('data-style', b.style) +
    (st.length ? A('style', st.join(';')) : '') + (() => { const t = tfOf(b); if (!t.r && t.sx === 1 && t.sy === 1) return ''; const cx = b.x + b.w / 2, cy = b.y + lines.length * lh / 2; return A('transform', 'translate(' + fmt(cx) + ' ' + fmt(cy) + ') rotate(' + fmt(t.r) + ') scale(' + +t.sx.toFixed(4) + ' ' + +t.sy.toFixed(4) + ') translate(' + fmt(-cx) + ' ' + fmt(-cy) + ')'); })() + '>';
  lines.forEach((ln, i) => { out += '<tspan x="' + +x + '" y="' + +(b.y + i * lh + (lh - (asc + desc)) / 2 + asc).toFixed(2) + '">' + esc(ln) + '</tspan>'; });
  return out + '</text>\n';
}
function svgWrap(a, css, body, scale) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + +(a.w * scale) + '" height="' + +(a.h * scale) + '" viewBox="0 0 ' + +a.w + ' ' + +a.h + '"><style>' + css + '</style>' + body + '</svg>';
}
function svgImage(svg) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('The browser could not draw the SVG text.')); im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
}
async function renderPNGCanvas() {
  const a = cv.doc.artboard, S = 2;
  const used = await prepFonts();
  for (const u of used.values()) await document.fonts.load('16px "' + u.f.name + '"');
  const c = document.createElement('canvas'); c.width = a.w * S; c.height = a.h * S;
  const ctx = c.getContext('2d'); ctx.fillStyle = okColor(a.bg, '#ffffff'); ctx.fillRect(0, 0, c.width, c.height);
  const m1 = document.createElement('canvas').getContext('2d');
  for (const b of cv.doc.layers) {
    if (b.visible === false) continue;
    if (b.type !== 'text') { drawVecPNG(ctx, b, S); continue; }
    const r = resolveStyle(b); if (!r) continue;
    if (needsSvgPath(b, r)) {
      /* Canvas 2D cannot apply OpenType features or variation axes: draw this box through an SVG image with the font embedded. */
      const one = new Map([[fkey(r.s), used.get(fkey(r.s))]]);
      ctx.drawImage(await svgImage(svgWrap(a, await fontFaceCss(one), svgText(b, r, m1), S)), 0, 0, c.width, c.height);
      continue;
    }
    setCtxFont(ctx, b, r, S);
    ctx.globalAlpha = b.op; ctx.fillStyle = okColor(b.color, '#000000'); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const sw = b.w * S, ls2 = layoutBox(ctx, Object.assign({}, b, { w: sw }));
    const m = ctx.measureText('Hg'), asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent, lh = b.size * b.lh * S;
    const tf = tfOf(b), tcx = b.x * S + sw / 2, tcy = b.y * S + ls2.length * lh / 2;
    ctx.save(); ctx.translate(tcx, tcy); ctx.rotate(tf.r * Math.PI / 180); ctx.scale(tf.sx, tf.sy); ctx.translate(-tcx, -tcy);
    ls2.forEach((ln, i) => {
      const w = ctx.measureText(ln).width - (b.ls * S);
      let x = b.x * S; if (b.align === 'center') x += (sw - w) / 2; else if (b.align === 'right') x += sw - w;
      ctx.fillText(ln, x, b.y * S + i * lh + (lh - (asc + desc)) / 2 + asc);
    });
    ctx.restore(); ctx.globalAlpha = 1;
  }
  return c;
}
async function exportPNG() {
  try { const c = await renderPNGCanvas(); c.toBlob(bl => download('typecase.png', bl), 'image/png'); }
  catch (e) { toast('PNG export failed: ' + e.message); }
}
async function buildSVG() {
  const a = cv.doc.artboard;
  const used = await prepFonts(), c = document.createElement('canvas').getContext('2d');
  let out = '<rect width="100%" height="100%" fill="' + esc(okColor(a.bg, '#ffffff')) + '"/>\n';
  for (const b of cv.doc.layers) { if (b.visible === false) continue; if (b.type !== 'text') { out += svgVec(b); continue; } const r = resolveStyle(b); if (r) out += svgText(b, r, c); }
  return svgWrap(a, await fontFaceCss(used), out, 1);
}
async function exportSVG() {
  try { download('typecase.svg', new Blob([await buildSVG()], { type: 'image/svg+xml' })); }
  catch (e) { toast('SVG export failed: ' + e.message); }
}
$('#exppng').onclick = exportPNG; $('#expsvg').onclick = exportSVG;
$('#save').onclick = () => download('typecase-document.json', new Blob([JSON.stringify(cv.doc, null, 1)], { type: 'application/json' }));
$('#open').onclick = () => $('#openfile').click();
$('#openfile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const d = sanitizeDoc(JSON.parse(await f.text())); if (!d) throw new Error('This is not a Typecase document.'); cv.doc = d; setSel([]); renderAll(); fitZoom(); commit(); toast('Opened ' + f.name); }
  catch (er) { toast(er.message); }
  e.target.value = '';
};

/* ------------------------------------------------------------ boot */
function demoCanvas() {
  const pick = (names, def) => names.find(n => lib.by.has(n)) || def;
  cv.doc = { artboard: { w: 1080, h: 1080, bg: '#f4efe6', preset: '1080 x 1080' }, layers: [] };
  const f1 = pick(['Helvetica', 'Manrope'], defaultFamily()), f2 = pick(['Noto Serif', 'DejaVu Serif'], defaultFamily()), f3 = pick(['JetBrains Mono', 'DejaVu Sans Mono', 'Noto Sans Mono'], defaultFamily());
  const mk = (family, style, over) => Object.assign({ id: uid(), type: 'text', name: '', visible: true, locked: false, x: 90, y: 120, w: 900, text: '', family, style, size: 48, lh: 1.2, ls: 0, align: 'left', color: '#171717', tt: 'none', op: 1, rot: 0, sx: 1, sy: 1 }, over);
  const fs = n => { const f = lib.by.get(n); const bold = f && f.styles.find(s => /bold/i.test(s.style) && !s.italic); return bold ? bold.style : (f ? repStyle(f).style : ''); };
  cv.doc.layers.push(mk(f1, fs(f1), { text: 'Type is the voice of the page', size: 120, lh: 1.0, ls: -2, y: 150 }));
  cv.doc.layers.push(mk(f2, repStyle(lib.by.get(f2)).style, { text: 'Three text boxes in three different families, wrapped to a column width.', size: 44, y: 560, w: 640, color: '#3b3b3b' }));
  cv.doc.layers.push(mk(f3, repStyle(lib.by.get(f3)).style, { text: 'typecase.canvas / export png svg', size: 30, y: 930, ls: 1, color: '#c2410c', tt: 'upper' }));
  setSel([cv.doc.layers[1].id]); cv.hist = []; cv.hi = -1; renderAll(); commit(); fitZoom();
}
async function demoOT() {
  /* pick a variable font with stylistic sets for the inspector screenshot */
  const fam = lib.by.get('Adwaita Sans') || lib.families.find(f => f.variable) || lib.families[0];
  const b = cv.doc.layers[0] || addBox();
  b.family = fam.name; b.style = repStyle(fam).style; b.text = 'Fractions 1/2 and 3/4 -- 0123'; b.feat = { frac: 1, zero: 1 }; b.vars = { wght: 700 }; b.size = 80;
  setSel([b.id]); renderAll(); commit();
}
async function selfTest() {
  /* Draws the first box with and without a feature through the PNG path and compares pixels. */
  const b = cv.doc.layers[0], px = async () => { const c = await renderPNGCanvas(); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
  b.feat = {}; b.vars = {}; const A = await px(); b.feat = { frac: 1, zero: 1 }; b.vars = { wght: 300 }; const B = await px();
  let d = 0; for (let i = 0; i < A.length; i += 4) if (A[i] !== B[i]) d++;
  document.title = 'SELFTEST diff=' + d;
}
async function route() {
  /* deep links, also used for screenshots: #library/Family, #install?job=ID, #canvas?demo=1 */
  const [tab, rest] = location.hash.slice(1).split('?');
  const [t0, ...fam] = (tab || '').split('/');
  const p = new URLSearchParams(rest || '');
  if (t0 === 'library') { showTab('library'); if (fam.length) openFamily(decodeURIComponent(fam.join('/'))); }
  else if (t0 === 'install') { showTab('install'); if (p.get('job')) startFetch('', p.get('job')); }
  else if (t0 === 'compare') { if (p.get('demo')) { cmp.items = []; p.get('demo').split(',').forEach(n => cmpAdd(n)); } showTab('compare'); }
  else if (t0 === 'canvas') {
    showTab('canvas');
    if (p.get('demo')) demoCanvas();
    if (p.get('ot')) await demoOT();
    if (p.get('selftest')) selfTest();
  }
}
window.addEventListener('hashchange', () => { route().catch(e => toast('Could not open that view: ' + e.message)); });
async function step(name, fn) { try { await fn(); } catch (e) { console.error('Typecase ' + name + ':', e); toast('Something went wrong while loading ' + name + '.'); } }
async function boot() {
  let saved = {};
  await step('saved settings', async () => { saved = await api('/api/state'); });
  await step('your preferences', async () => {
    const pr = saved.prefs && typeof saved.prefs === 'object' ? saved.prefs : {};
    if (pr.lib && typeof pr.lib === 'object') Object.assign(prefs, pr.lib);
    if (pr.cmp && typeof pr.cmp === 'object') {
      if (Array.isArray(pr.cmp.items)) cmp.items = pr.cmp.items.filter(i => i && typeof i.family === 'string').slice(0, 4).map(i => ({ family: i.family, style: String(i.style || '') }));
      if (typeof pr.cmp.text === 'string') cmp.text = pr.cmp.text;
      if (Number.isFinite(+pr.cmp.size)) cmp.size = Math.min(160, Math.max(12, +pr.cmp.size));
    }
    $('#ptext').value = prefs.text; $('#psize').value = prefs.size; $('#sort').value = prefs.sort;
    renderChips();
  });
  await step('the font library', loadLib);
  await step('the canvas', async () => {
    const d = sanitizeDoc(saved.canvas);
    if (d) cv.doc = d; else if (saved.canvas && Object.keys(saved.canvas).length) toast('The saved canvas was damaged, so a blank page was opened.');
    cv.hist = [snap()]; cv.hi = 0; renderAll();
  });
  await step('the font detail', async () => renderDetail());
  await step('the installed list', async () => renderInstalled());
  await step('the view', route);
}
function flushSave() {
  if (!saveT) return;
  clearTimeout(saveT); saveT = null;
  try { fetch('/api/state', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'canvas', value: cv.doc }) }); } catch (e) {}
}
window.addEventListener('pagehide', flushSave);
window.addEventListener('beforeunload', () => { flushSave(); if (inst.stage) { try { fetch('/api/cancel', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: inst.stage }) }); } catch (e) {} } });
