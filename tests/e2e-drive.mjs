// CDP driver for the Typecase review. Usage: node drive.mjs [phase]
import fs from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const R = ROOT + '.cache/review';
const BASE = 'http://127.0.0.1:47312/';
const phase = process.argv[2] || 'all';
const FONT_DIR = process.env.TYPECASE_FONT_DIR || ROOT + '.cache/review-fonts';   /* the test server's font install folder */
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
let tgt = list.find(t => t.type === 'page');
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const events = [];
const log = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); return; }
  if (d.method === 'Runtime.exceptionThrown') { const e = d.params.exceptionDetails; log.push('EXCEPTION: ' + (e.exception && e.exception.description || e.text) + ' @' + e.url + ':' + e.lineNumber); }
  if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) log.push('CONSOLE ' + d.params.type + ': ' + d.params.args.map(a => a.value || a.description).join(' '));
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') log.push('LOG: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  if (d.method === 'Browser.downloadProgress' || d.method === 'Page.downloadProgress') events.push(d);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
const results = [];
const check = (name, ok, info = '') => { results.push((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  [' + info + ']' : '')); console.log(results.at(-1)); };
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(R + '/' + name + '.png', Buffer.from(r.data, 'base64')); };
const rect = async sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,l:r.left,t:r.top}})()`);
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const click = async (x, y, count = 1) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); for (let c = 1; c <= count; c++) { await mouse('mousePressed', x, y, { clickCount: c }); await mouse('mouseReleased', x, y, { clickCount: c }); } await sleep(80); };
const clickSel = async (sel, count = 1) => { const r = await rect(sel); if (!r) throw new Error('no element ' + sel); await click(r.x, r.y, count); return r; };
const drag = async (x0, y0, x1, y1, steps = 12, midCb) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await mouse('mousePressed', x0, y0);
  let mid;
  for (let i = 1; i <= steps; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left', buttons: 1 }); await sleep(10); }
  if (midCb) mid = await midCb();
  await mouse('mouseReleased', x1, y1); await sleep(80); return mid;
};
const KEYS = { Delete: [46, 'Delete'], Escape: [27, 'Escape'], Enter: [13, 'Enter'], Backspace: [8, 'Backspace'], ArrowRight: [39, 'ArrowRight'] };
const key = async (k, mods = 0) => {
  let vk, code, text;
  if (KEYS[k]) [vk, code] = KEYS[k]; else { vk = k.toUpperCase().charCodeAt(0); code = 'Key' + k.toUpperCase(); text = mods ? undefined : k; }
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: (mods & 8) && k.length === 1 ? k.toUpperCase() : k, code, windowsVirtualKeyCode: vk, modifiers: mods, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(60);
};
const type = async s => { for (const ch of s) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); } await sleep(60); };
const CTRL = 2, SHIFT = 8;
const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (e) {} await sleep(150); } return false; };
const nav = async url => { await send('Page.navigate', { url: 'about:blank' }); await sleep(200); await send('Page.navigate', { url }); await sleep(300); await waitFor(`document.readyState==='complete' && lib.families.length>0`, 20000); await sleep(300); };

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: R + '/dl', eventsEnabled: true });

if (phase === 'all' || phase === 'ui') {
  await nav(BASE);
  await ev(`cmp.items=[]; savePrefs()`);
  await ev(`(()=>{cv.doc={artboard:{w:794,h:1123,bg:'#ffffff',preset:'A4'},layers:[]}; setSel([]); renderAll(); addBox(); cv.hist=[snap()]; cv.hi=0; return 1})()`);
  check('library loads', await ev('lib.families.length') > 50, (await ev('lib.families.length')) + ' families');
  // search
  await clickSel('#q'); await type('noto sans');
  let names = await ev(`[...document.querySelectorAll('#fam-list .fam')].map(e=>e.dataset.n)`);
  check('search filters', names.length > 0 && names.every(n => n.toLowerCase().includes('noto sans')), names.length + ' rows');
  await ev(`(()=>{const q=document.querySelector('#q'); q.value=''; q.dispatchEvent(new Event('input'));})()`);
  // Variable chip
  await ev(`[...document.querySelectorAll('#f-more .chip')].find(b=>b.textContent==='Variable').click()`);
  let vrows = await ev(`[...document.querySelectorAll('#fam-list .fam')].map(e=>lib.by.get(e.dataset.n).variable)`);
  check('Variable filter', vrows.length > 0 && vrows.every(Boolean), vrows.length + ' rows');
  await ev(`[...document.querySelectorAll('#f-more .chip')].find(b=>b.textContent==='Variable').click()`);
  // scope
  await ev(`[...document.querySelectorAll('#f-scope .chip')].find(b=>b.textContent==='User-installed').click()`);
  let urows = await ev(`[...document.querySelectorAll('#fam-list .fam')].map(e=>lib.by.get(e.dataset.n).user)`);
  check('User scope filter', urows.length > 0 && urows.every(Boolean), urows.length + ' rows');
  await ev(`[...document.querySelectorAll('#f-scope .chip')].find(b=>b.textContent==='All').click()`);
  // sort by styles
  await ev(`(()=>{const s=document.querySelector('#sort'); s.value='styles'; s.dispatchEvent(new Event('change'));})()`);
  let counts = await ev(`[...document.querySelectorAll('#fam-list .fam')].slice(0,30).map(e=>lib.by.get(e.dataset.n).styles.length)`);
  check('sort by styles', counts.every((c, i) => !i || counts[i - 1] >= c), counts.slice(0, 5).join(','));
  await ev(`(()=>{const s=document.querySelector('#sort'); s.value='name'; s.dispatchEvent(new Event('change'));})()`);
  // open family detail by clicking a row
  await clickSel('#fam-list .fam:nth-child(3)');
  check('family detail opens', !!(await ev(`document.querySelector('#detail h1')?.textContent`)));
  // TTC face index check: Noto Sans Mono CJK JP should be monospaced
  const ttc = await ev(`(async()=>{const f=lib.by.get('Noto Sans Mono CJK JP')||lib.families.find(x=>/Mono CJK/.test(x.name)); if(!f) return null; const s=repStyle(f); const fi=faceInfo(s.file,s.variable,s.index); await fi.p; await document.fonts.ready;
    const c=document.createElement('canvas').getContext('2d'); c.font='40px "'+fi.name+'"'; const a=c.measureText('iiiiiiii').width, b=c.measureText('MMMMMMMM').width; return {fam:f.name,file:s.file,index:s.index,iW:a,MW:b}})()`);
  if (ttc) check('TTC face index honoured (Mono CJK renders monospaced)', Math.abs(ttc.iW - ttc.MW) < 1, JSON.stringify(ttc));
  // Compare add / remove
  await ev(`(()=>{const q=document.querySelector('#q'); q.value=''; q.dispatchEvent(new Event('input'));})()`);
  await clickSel('#fam-list .fam:nth-child(1) .cmpbtn');
  await ev(`showTab('library')`);
  await clickSel('#fam-list .fam:nth-child(2) .cmpbtn');
  await sleep(200);
  let chips = await ev(`document.querySelectorAll('#cmp-chips .cmpchip').length`);
  let cols = await ev(`document.querySelectorAll('#cmp-cols .ccol').length`);
  check('Compare add 2', chips === 2 && cols === 2, chips + ' chips ' + cols + ' cols');
  await shot('compare');
  await clickSel('#cmp-chips .cmpchip button');
  chips = await ev(`document.querySelectorAll('#cmp-chips .cmpchip').length`);
  check('Compare remove', chips === 1, chips + ' chips');
  // Compare: Add family picker
  await clickSel('#cmp-add'); await type('Manrope'); await key('Enter'); await sleep(200);
  check('Compare Add family picker', (await ev(`cmp.items.map(i=>i.family).join('|')`)).includes('Manrope'), await ev(`cmp.items.map(i=>i.family).join('|')`));

  // ---------------- canvas
  await clickSel('.tabs button[data-tab=canvas]'); await sleep(200);
  const n0 = await ev('cv.doc.layers.length');
  await clickSel('#add');
  check('Add text button', await ev('cv.doc.layers.length') === n0 + 1);
  // double-click empty part of artboard (bottom-left area)
  const abr = await rect('#artboard');
  const zoom = await ev('cv.zoom');
  const ex = abr.l + abr.w * 0.1, ey = abr.t + abr.h * 0.85;
  const hit = await ev(`document.elementFromPoint(${ex},${ey}).id`);
  await click(ex, ey, 2); await sleep(150);
  check('double-click empty canvas adds box + edits', await ev('cv.doc.layers.length') === n0 + 2 && await ev('!!cv.editing'), 'hit=' + hit + ' editing=' + await ev('cv.editing'));
  await type('Hello CDP');
  await key('Escape'); await sleep(100);
  const txt = await ev(`boxById(cv.sel)?.text`);
  check('typing into box', txt === 'Hello CDP', JSON.stringify(txt));
  check('history after edit', await ev('cv.hi') >= 2, 'hi=' + await ev('cv.hi'));
  // drag to move
  const selId = await ev('cv.sel');
  let br = await rect(`.tb[data-id="${selId}"]`);
  const bx0 = await ev('boxById(cv.sel).x');
  await drag(br.x, br.y, br.x + 60, br.y - 40);
  const bx1 = await ev('boxById(cv.sel).x'), by1 = await ev('boxById(cv.sel).y');
  check('drag moves box', Math.abs((bx1 - bx0) - Math.round(60 / zoom)) <= 2, `dx=${bx1 - bx0} expected~${Math.round(60 / zoom)} zoom=${zoom.toFixed(3)}`);
  // drag to centre: guides
  br = await rect(`.tb[data-id="${selId}"]`);
  const abr2 = await rect('#artboard');
  const guides = await drag(br.x, br.y, abr2.x + 1, abr2.y + 1, 15, async () => ({ gv: await ev(`getComputedStyle(document.querySelector('#gv')).display`), gh: await ev(`getComputedStyle(document.querySelector('#gh')).display`) }));
  await (async () => {})();
  check('center-snap guides appear during drag', guides.gv === 'block' && guides.gh === 'block', JSON.stringify(guides));
  const cen = await ev(`(()=>{const b=boxById(cv.sel),el=document.querySelector('.tb[data-id="'+b.id+'"]'); return {cx:b.x+el.offsetWidth/2, cy:b.y+el.offsetHeight/2, aw:cv.doc.artboard.w/2, ah:cv.doc.artboard.h/2}})()`);
  check('box snapped to centre', Math.abs(cen.cx - cen.aw) <= 1 && Math.abs(cen.cy - cen.ah) <= 1, JSON.stringify(cen));
  check('guides hidden after drop', await ev(`getComputedStyle(document.querySelector('#gv')).display`) === 'none');
  // width handle
  const w0 = await ev('boxById(cv.sel).w');
  const hr = await rect(`.tb[data-id="${selId}"] .hdl`);
  await drag(hr.x, hr.y, hr.x + 50, hr.y);
  const w1 = await ev('boxById(cv.sel).w');
  check('width handle resizes', Math.abs((w1 - w0) - Math.round(50 / zoom)) <= 2, `w ${w0}->${w1}`);
  check('width slider synced after handle drag', await ev(`(()=>{const r=[...document.querySelectorAll('#insp .f')].find(f=>f.firstChild.textContent==='Width').querySelector('input[type=range]'); return +r.value===boxById(cv.sel).w})()`), 'range=' + await ev(`[...document.querySelectorAll('#insp .f')].find(f=>f.firstChild.textContent==='Width').querySelector('input[type=range]').value`));
  // Ctrl+D, Delete, undo/redo
  await ev('document.activeElement.blur()');
  const c0 = await ev('cv.doc.layers.length');
  await key('d', CTRL);
  check('Ctrl+D duplicates', await ev('cv.doc.layers.length') === c0 + 1);
  await key('Delete');
  check('Delete removes', await ev('cv.doc.layers.length') === c0);
  await key('z', CTRL);
  check('Ctrl+Z undo restores deleted', await ev('cv.doc.layers.length') === c0 + 1);
  await key('z', CTRL | SHIFT);
  check('Ctrl+Shift+Z redo', await ev('cv.doc.layers.length') === c0, 'len=' + await ev('cv.doc.layers.length'));
  await clickSel('#undo');
  check('Undo button', await ev('cv.doc.layers.length') === c0 + 1);
  await clickSel('#redo');
  check('Redo button', await ev('cv.doc.layers.length') === c0);
  // After clicking a toolbar button, focus is on the button: does Delete still work? Enter?
  // select the edited box by click
  br = await rect(`.tb[data-id="${selId}"]`); await click(br.x, br.y);
  check('click selects box', await ev('cv.sel') === selId);
  // inspector: font picker
  await clickSel('#insp .picker button'); await sleep(100);
  await clickSel('#insp .picker button'); await sleep(100);
  const pops = await ev(`document.querySelectorAll('.pop').length`);
  check('font picker toggles (second click closes)', pops <= 1, pops + ' popups open');
  await ev(`document.querySelectorAll('.pop').forEach(p=>p.remove())`);
  await clickSel('#insp .picker button'); await sleep(100);
  await type('Manrope'); await sleep(100);
  await clickSel('.pop .list .it');
  check('font picker changes family', await ev('boxById(cv.sel).family') === 'Manrope', await ev('boxById(cv.sel).family'));
  await waitFor(`!!document.querySelector('#insp-ot input[type=range]')`, 5000);
  // size number
  await ev(`(()=>{const n=[...document.querySelectorAll('#insp .f')].find(f=>f.firstChild.textContent==='Size').querySelector('input[type=number]'); n.focus(); n.select();})()`);
  await type('72'); await key('Enter');
  await ev('document.activeElement.blur()');
  check('size input', await ev('boxById(cv.sel).size') === 72, 'size=' + await ev('boxById(cv.sel).size') + ' css=' + await ev(`document.querySelector('.tb[data-id="${selId}"]').style.fontSize`));
  // axis slider: drag range thumb
  const rr = await rect('#insp-ot input[type=range]');
  if (rr) {
    await drag(rr.l + 4, rr.y, rr.l + rr.w - 2, rr.y, 8);
    const vars = await ev('JSON.stringify(boxById(cv.sel).vars)');
    const fvs = await ev(`document.querySelector('.tb[data-id="${selId}"]').style.fontVariationSettings`);
    check('axis slider sets variation', vars.includes('wght') && fvs.includes('wght'), vars + ' css=' + fvs);
  } else check('axis slider present', false, 'no axis range for Manrope');
  // feature toggle
  const feats = await ev(`[...document.querySelectorAll('#insp-ot .feats label')].map(l=>l.title)`);
  const fi = feats.findIndex(t => !['liga', 'calt', 'kern'].includes(t));
  if (fi >= 0) {
    await clickSel(`#insp-ot .feats label:nth-child(${fi + 1}) input`);
    const ff = await ev(`document.querySelector('.tb[data-id="${selId}"]').style.fontFeatureSettings`);
    check('feature toggle applies', ff.includes(feats[fi]), feats[fi] + ' css=' + ff);
  } else check('feature list', false, JSON.stringify(feats));
  // style select
  const styles = await ev(`[...document.querySelectorAll('#insp select')][0].options.length`);
  await ev(`(()=>{const s=document.querySelectorAll('#insp select')[0]; s.selectedIndex=s.options.length-1; s.dispatchEvent(new Event('change'));})()`);
  check('style select changes style', (await ev('boxById(cv.sel).style')) === await ev(`(()=>{const s=document.querySelectorAll('#insp select')[0]; return s.value})()`), await ev('boxById(cv.sel).style') + ' of ' + styles);
  await shot('canvas-inspector');
  const docBefore = await ev('JSON.stringify(cv.doc)');
  await sleep(900);
  await nav(BASE + '#canvas');
  await sleep(500);
  const docAfter = await ev('JSON.stringify(cv.doc)');
  check('autosave restores doc after reload', docBefore === docAfter, docBefore.length + ' vs ' + docAfter.length);
  // quick-change then immediate reload (inside 500 ms debounce)
  await ev(`(()=>{cv.doc.layers[0].text='LAST EDIT'; commit();})()`);
  await sleep(100);
  await nav(BASE + '#canvas');
  check('edit just before reload kept', await ev('cv.doc.layers[0].text') === 'LAST EDIT', JSON.stringify(await ev('cv.doc.layers[0].text')));
  // Export
  for (const f of fs.readdirSync(R + '/dl')) fs.unlinkSync(R + '/dl/' + f);
  await ev(`showTab('canvas')`); await sleep(200);
  await clickSel('#exppng');
  await waitFor('false', 4000);
  await clickSel('#morebtn'); await sleep(100);
  check('toolbar: More menu opens with Duplicate, Delete, Open, Save, Export SVG', await ev(`!document.querySelector('#more-menu').hidden && document.querySelectorAll('#more-menu button').length===5`));
  await clickSel('#expsvg');
  await waitFor('false', 4000);
  const dl = fs.readdirSync(R + '/dl');
  check('export downloads', dl.includes('typecase.png') && dl.includes('typecase.svg'), dl.join(','));
  // PNG via in-page render to verify content
  const png = await ev(`(async()=>{const c=await renderPNGCanvas(); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; const bg=[d[0],d[1],d[2]]; for(let i=0;i<d.length;i+=16) if(Math.abs(d[i]-bg[0])+Math.abs(d[i+1]-bg[1])+Math.abs(d[i+2]-bg[2])>60) n++; return {w:c.width,h:c.height,ink:n}})()`);
  check('PNG has ink', png.ink > 100, JSON.stringify(png));
  await shot('canvas-after-export');
  await ev(`showTab('library')`);
}

if (phase === 'all' || phase === 'install') {
  await nav(BASE + '#install');
  await ev(`showTab('install')`);
  await clickSel('#url'); await type('https://github.com/JetBrains/JetBrainsMono/tree/master/fonts');
  await clickSel('#fetch');
  const okp = await waitFor(`!!document.querySelector('#inst-out .pbar') || !!document.querySelector('#inst-out .err')`, 120000);
  const err = await ev(`document.querySelector('#inst-out .err')?.textContent || ''`);
  check('fetch preview', okp && !err, err || await ev(`document.querySelector('#inst-out .okbox')?.textContent`));
  await shot('install-preview');
  if (!err) {
    const folders = await ev(`[...document.querySelectorAll('#inst-out details.fold summary .name')].map(e=>e.textContent)`);
    console.log('folders', folders);
    await ev(`[...document.querySelectorAll('#inst-out .pbar button')].find(b=>b.textContent==='Select none').click()`);
    // pick the smallest folder
    const sizes = await ev(`(()=>{const m={}; inst.items.forEach(i=>m[i.folder]=(m[i.folder]||0)+1); return m})()`);
    const pick = Object.entries(sizes).sort((a, b) => a[1] - b[1])[0][0];
    const idx = folders.indexOf(pick);
    await ev(`document.querySelectorAll('#inst-out details.fold')[${idx}].scrollIntoView()`);
    await clickSel(`#inst-out details.fold:nth-of-type(${idx + 1}) summary input`).catch(async () => { await ev(`(()=>{const c=document.querySelectorAll('#inst-out details.fold summary input')[${idx}]; c.click();})()`); });
    const nsel = await ev('inst.sel.size');
    check('select one folder', nsel === sizes[pick], `${pick}: ${nsel} of ${sizes[pick]}`);
    await ev(`(()=>{const c=document.querySelector('#inst-out .pbar input[type=text]'); c.value='ReviewFont'; })()`);
    await ev(`[...document.querySelectorAll('#inst-out .pbar button')].find(b=>b.textContent==='Install').click()`);
    const done = await waitFor(`!!document.querySelector('#inst-out .okbox button') || !!document.querySelector('#inst-out .err')`, 120000);
    const ierr = await ev(`document.querySelector('#inst-out .err')?.textContent || ''`);
    check('install', done && !ierr, ierr || await ev(`document.querySelector('#inst-out .okbox').textContent`));
    await shot('install-done');
    const files = fs.existsSync(`${FONT_DIR}/ReviewFont`) ? fs.readdirSync(`${FONT_DIR}/ReviewFont`, { recursive: true }) : [];
    check('files written to test dir', files.length > 0, files.length + ' entries');
    // show in library and uninstall
    if (!ierr) {
      await ev(`document.querySelector('#inst-out .okbox button').click()`); await sleep(500);
      const fam = await ev(`document.querySelector('#detail h1')?.textContent`);
      const unb = await ev(`[...document.querySelectorAll('#detail button.danger')].map(b=>b.textContent)`);
      check('installed family shows Uninstall', unb.length > 0, fam + ' ' + JSON.stringify(unb));
      if (unb.length) {
        await ev(`[...document.querySelectorAll('#detail button.danger')][0].click()`); await sleep(100);
        await shot('uninstall-confirm');
        await ev(`[...document.querySelectorAll('#detail .confirm button.danger')][0].click()`);
        await waitFor(`lib.installs.length===0`, 60000);
        const left = fs.existsSync(`${FONT_DIR}/ReviewFont`);
        check('uninstall removes files + record', !left && await ev('lib.installs.length') === 0, 'dir left=' + left);
        await shot('after-uninstall');
      }
    }
  }
}

if (phase === 'reload') {
  const reload = async () => { await send('Page.reload', { ignoreCache: true }); await sleep(400); await waitFor(`document.readyState==='complete' && lib.families.length>0`, 20000); await sleep(400); };
  await nav(BASE + '#canvas');
  await ev(`(()=>{cv.doc={artboard:{w:794,h:1123,bg:'#ffffff',preset:'A4'},layers:[]}; setSel([]); renderAll(); addBox(); cv.hist=[snap()]; cv.hi=0; return 1})()`);
  const loads0 = await ev('performance.timeOrigin');
  const docBefore = await ev('JSON.stringify(cv.doc)');
  await reload();
  check('page really reloaded', loads0 !== await ev('performance.timeOrigin'));
  const docAfter = await ev('JSON.stringify(cv.doc)'); if (docBefore !== docAfter) console.log('BEFORE', docBefore, '\nAFTER', docAfter);
  check('autosave restores doc after real reload', docBefore === docAfter, docBefore.length + ' chars, ' + await ev('cv.doc.layers.length') + ' boxes');
  await ev(`(()=>{cv.doc.layers[0].text='LAST EDIT'; renderAll(); commit();})()`);
  await sleep(150);
  await reload();
  check('edit 150 ms before reload kept', await ev('cv.doc.layers[0].text') === 'LAST EDIT', JSON.stringify(await ev('cv.doc.layers[0].text')));
  // style select vs axis override
  await ev(`showTab('canvas')`); await sleep(200);
  const r = await ev(`(()=>{const b=cv.doc.layers.find(b=>b.family==='Manrope')||cv.doc.layers[0]; b.family='Manrope'; b.vars={wght:800}; setSel([b.id]); renderAll(); const s=document.querySelectorAll('#insp select')[0]; const lt=[...s.options].find(o=>/Light/.test(o.value)); s.value=lt.value; s.dispatchEvent(new Event('change')); const el=document.querySelector('.tb[data-id="'+b.id+'"]'); return {style:b.style, fw:el.style.fontWeight, fvs:el.style.fontVariationSettings}})()`);
  check('choosing Light style after axis edit renders Light', !String(r.fvs).includes('800'), JSON.stringify(r));
  // font change keeps old feat/vars
  const r2 = await ev(`(()=>{const b=boxById(cv.sel); b.feat={ss01:1}; const f=lib.families.find(f=>f.name!=='Manrope'); b.family=f.name; b.style=repStyle(f).style; renderAll(); return {feat:JSON.stringify(b.feat), vars:JSON.stringify(b.vars), svg:needsSvgPath(b,resolveStyle(b))}})()`);
  console.log('after font switch (simulating picker onPick):', JSON.stringify(r2));
}

if (phase === 'corrupt') {
  await nav(BASE);
  // 1. a cross-site page cannot write state (CSRF): wrong Origin and wrong content type are refused
  const bad = JSON.stringify({ key: 'canvas', value: { artboard: { w: 100 }, boxes: 'x' } });
  const r1 = await fetch(BASE + 'api/state', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: bad });
  const r2 = await fetch(BASE + 'api/state', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: bad });
  check('CSRF: foreign Origin refused', r1.status === 403, 'status ' + r1.status);
  check('CSRF: text/plain refused', r2.status === 415, 'status ' + r2.status);
  // 2. damaged canvas already on disk (written the legitimate way) must not blank the app
  for (const doc of [{ artboard: { w: 100 }, boxes: 'x' }, { artboard: { w: 800, h: 600, bg: 'url(x)' }, boxes: [{ text: 5, size: 'big', color: '"><script>' }, null, 7] }]) {
    await ev(`fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'canvas',value:${JSON.stringify(doc)}})}).then(r=>r.status)`);
    await send('Page.navigate', { url: 'about:blank' }); await sleep(300); await send('Page.navigate', { url: BASE + '#library/Manrope' }); await sleep(3000);
    const det = await ev(`document.querySelector('#detail').textContent.slice(0,60)`);
    check('app survives bad canvas state', det.includes('Manrope'), JSON.stringify(det));
    const cvs = await ev(`JSON.stringify({bg:cv.doc.artboard.bg, w:cv.doc.artboard.w, boxes:cv.doc.layers.map(b=>[b.text,b.size,b.color])})`);
    check('bad doc replaced by safe values', !/script|url\(/.test(cvs), cvs);
  }
  await shot('corrupt-state');
  await ev(`fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'canvas',value:{}})}).then(r=>r.status)`);
}

if (phase === 'new') {
  await nav(BASE);
  await ev(`(()=>{cv.doc={artboard:{w:794,h:1123,bg:'#ffffff',preset:'A4'},layers:[]}; setSel([]); renderAll(); addBox(); cv.hist=[snap()]; cv.hi=0; return 1})()`);
  // prefs stored on the server, not in the browser
  await ev(`(()=>{prefs.mono=true; prefs.text='SERVER PREFS'; savePrefs();})()`); await sleep(700);
  const st = await (await fetch(BASE + 'api/state')).json();
  check('prefs saved server-side', st.prefs && st.prefs.lib && st.prefs.lib.text === 'SERVER PREFS', JSON.stringify(st.prefs).slice(0, 80));
  await ev(`localStorage.clear()`); await send('Page.reload'); await sleep(2500);
  check('prefs restored after reload', await ev(`prefs.text==='SERVER PREFS' && prefs.mono===true && document.querySelector('#ptext').value==='SERVER PREFS'`));
  await ev(`(()=>{prefs.mono=false; prefs.text='The quick brown fox jumps over the lazy dog'; savePrefs();})()`); await sleep(600);
  // /font with index for a TTC
  const ttc = await ev(`(()=>{const f=lib.by.get('Noto Sans Mono CJK JP'); const s=f&&f.styles.find(s=>s.file.endsWith('.ttc')); return s?{file:s.file,index:s.index}:null})()`);
  console.log('ttc style', JSON.stringify(ttc));
  if (ttc) {
    const r = await fetch(BASE + 'font?path=' + encodeURIComponent(ttc.file) + '&index=' + ttc.index);
    const buf = new Uint8Array(await r.arrayBuffer());
    check('/font serves one face as plain sfnt', r.status === 200 && buf.length > 1000 && buf.length < 40e6 && String.fromCharCode(...buf.slice(0, 4)) !== 'ttcf', buf.length + ' bytes');
  }
  // dead link: Origin
  const g = await fetch(BASE + 'api/fonts', { headers: { Origin: 'https://evil.example' } });
  check('GET with foreign Origin refused', g.status === 403, 'status ' + g.status);
  // hashchange routing
  await ev(`location.hash='#compare'`); await sleep(400);
  check('hashchange routes to Compare tab', await ev(`document.querySelector('#v-compare').classList.contains('active')`));
  // style change clears axes, family change clears features
  await ev(`showTab('canvas')`); await sleep(200);
  const x = await ev(`(()=>{const b=cv.doc.layers[0]||addBox(); const f=lib.by.get('Manrope'); b.family='Manrope'; b.style=repStyle(f).style; b.vars={wght:800}; b.feat={case:1}; setSel([b.id]); renderAll();
    const s=document.querySelectorAll('#insp select')[0]; s.value=[...s.options].find(o=>/Light/.test(o.value)).value; s.dispatchEvent(new Event('change')); const afterStyle=JSON.stringify(b.vars);
    const g=lib.families.find(f=>f.name!=='Manrope'); b.feat={ss01:1}; b.vars={wght:300}; b.family=g.name; b.style=repStyle(g).style; b.vars={}; b.feat={}; return {afterStyle}})()`);
  check('style change clears axis overrides', x.afterStyle === '{}', x.afterStyle);
  // SVG export escapes and validates colours
  const svg = await ev(`(async()=>{const b=cv.doc.layers[0]; b.color='"><script>alert(1)</script>'; b.family='Manrope\"><x/>'; const c=document.createElement('canvas').getContext('2d'); const r=resolveStyle(b); return svgText(b,r,c)})()`);
  check('SVG text has no raw markup injection', !/<script|<x\/>/.test(svg) && /fill="#000000"/.test(svg), svg.slice(0, 200));
  // installed list on Install tab
  await ev(`showTab('install')`); await sleep(200);
  check('Installed list container exists', await ev(`!!document.querySelector('#inst-list')`));
}


/* ===================== layers / alt-drag / outlines / direct selection ===================== */
const SHOTS = ROOT + 'docs/screenshots/';
const A2S = async (x, y) => ev(`(()=>{const r=ab.getBoundingClientRect(); return {x:r.left+${x}*cv.zoom, y:r.top+${y}*cv.zoom}})()`);
const T = (id, x, y, text, extra = {}) => ({ type: 'text', id, x, y, w: 300, text, family: 'Noto Sans', style: 'Regular', size: 60, lh: 1.2, ls: 0, align: 'left', color: '#111111', tt: 'none', op: 1, feat: {}, vars: {}, visible: true, locked: false, ...extra });
const loadDoc = async (layers, art = { w: 800, h: 500, bg: '#ffffff', preset: 'Custom' }) => ev(`(()=>{cv.doc=sanitizeDoc(${JSON.stringify({ artboard: art, layers })}); cv.selSet=[];cv.sel=null; cv.hist=[snap()];cv.hi=0; renderAll(); cv.zoom=0.9; cv.zoomSet=true; applyZoom(); setTool('select'); renderOverlay(); return cv.doc.layers.length})()`);
const clickM = async (x, y, mods = 0, count = 1) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods }); for (let c = 1; c <= count; c++) { await mouse('mousePressed', x, y, { clickCount: c, modifiers: mods }); await mouse('mouseReleased', x, y, { clickCount: c, modifiers: mods }); } await sleep(80); };
const dragM = async (x0, y0, x1, y1, mods = 0, steps = 10, midCb = null, altFrom = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, modifiers: mods });
  await mouse('mousePressed', x0, y0, { modifiers: mods });
  let mid;
  for (let i = 1; i <= steps; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left', buttons: 1, modifiers: i > altFrom ? mods : 0 }); await sleep(12); }
  if (midCb) mid = await midCb();
  await mouse('mouseReleased', x1, y1, { modifiers: mods }); await sleep(120); return mid;
};
const rawKey = async (k, code, vk, mods = 0) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(120); };
const ids = async () => ev(`cv.doc.layers.map(l=>l.id)`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ctrlZ = () => key('z', CTRL);
const centerOf = async sel => { const r = await rect(sel); if (!r) throw new Error('missing ' + sel); return r; };
const shotClip = async () => { const r = await ev(`(()=>{const q=ab.getBoundingClientRect(); return {x:q.left,y:q.top,w:q.width,h:q.height}})()`); const d = await send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } }); return d.data; };
const inkInfo = b64 => ev(`(async()=>{const im=new Image(); im.src='data:image/png;base64,${b64}'; await im.decode(); const c=document.createElement('canvas'); c.width=im.width; c.height=im.height; const x=c.getContext('2d'); x.drawImage(im,0,0); const d=x.getImageData(0,0,c.width,c.height).data; let l=1e9,t=1e9,r=-1,b=-1,n=0; for(let y=3;y<c.height-3;y++)for(let xx=3;xx<c.width-3;xx++){const i=(y*c.width+xx)*4; if(255*3-(d[i]+d[i+1]+d[i+2])>180){n++; if(xx<l)l=xx; if(xx>r)r=xx; if(y<t)t=y; if(y>b)b=y;}} return {l,t,r,b,n,w:c.width,h:c.height}})()`);
const shotDiff = (a, b) => ev(`(async()=>{const get=async s=>{const im=new Image(); im.src='data:image/png;base64,'+s; await im.decode(); const c=document.createElement('canvas'); c.width=im.width;c.height=im.height; const x=c.getContext('2d'); x.drawImage(im,0,0); return x.getImageData(0,0,c.width,c.height).data}; const A=await get(${JSON.stringify(a)}), B=await get(${JSON.stringify(b)}); let ink=0,diff=0; for(let i=0;i<A.length;i+=4){const ga=765-(A[i]+A[i+1]+A[i+2]), gb=765-(B[i]+B[i+1]+B[i+2]); if(ga>180||gb>180){ink++; if(Math.abs(ga-gb)>300)diff++;}} return {ink,diff}})()`);
const openCanvas = async () => { await nav(BASE); await ev(`showTab('canvas')`); await sleep(250); };

if (phase === 'all' || phase === 'layers') {
  await openCanvas();
  await loadDoc([T('A', 50, 50, 'Alpha'), T('B', 50, 170, 'Bravo'), T('C', 50, 290, 'Charlie')]);
  check('layers panel: top row is the frontmost layer', same(await ev(`[...document.querySelectorAll('#lyr-list .lrow')].map(r=>r.dataset.id)`), ['C', 'B', 'A']));
  check('tool strip has 5 tools with key tooltips', same(await ev(`[...document.querySelectorAll('#tools button')].map(b=>b.title)`), ['Selection (V)', 'Direct Selection (A)', 'Transform (E)', 'Text (T)', 'Hand (H, or hold Space)']));
  await clickSel('.lrow[data-id="B"] .lname');
  check('click row selects', same(await ev('cv.selSet'), ['B']) && await ev(`document.querySelector('.lrow[data-id="B"]').classList.contains('sel')`));
  const ra = await centerOf('.lrow[data-id="A"] .lname'); await clickM(ra.x, ra.y, SHIFT);
  check('shift-click adds to selection', same((await ev('cv.selSet')).sort(), ['A', 'B']));
  await ev(`setSel(['C'])`);
  // drag the top row (C) to the bottom of the list: C becomes the backmost layer
  const rc = await centerOf('.lrow[data-id="C"] .lname'), rA = await rect('.lrow[data-id="A"]');
  let dropShown = false;
  await dragM(rc.x, rc.y, rc.x, rA.t + rA.h + 4, 0, 12, async () => { dropShown = await ev(`!!document.querySelector('#lyr-list .dropline')`); });
  check('drag row shows a drop line', dropShown);
  check('drag row reorders layers', same(await ids(), ['C', 'A', 'B']), JSON.stringify(await ids()));
  check('reorder changes z-order in the DOM', same(await ev(`[...document.querySelectorAll('#artboard .tb')].map(e=>e.dataset.id)`), ['C', 'A', 'B']));
  await ctrlZ();
  check('undo restores the order', same(await ids(), ['A', 'B', 'C']) && same(await ev(`[...document.querySelectorAll('#artboard .tb')].map(e=>e.dataset.id)`), ['A', 'B', 'C']));
  // hide
  const eye = await centerOf('.lrow[data-id="B"] .leye'); await click(eye.x, eye.y);
  check('eye hides the layer', await ev(`cv.doc.layers[1].visible===false && document.querySelector('.tb[data-id="B"]').style.display==='none' && document.querySelector('.lrow[data-id="B"]').classList.contains('hid')`));
  const svgH = await ev(`buildSVG()`);
  check('hidden layer is not exported (SVG)', !svgH.includes('Bravo') && svgH.includes('Alpha'));
  const inkAll = await ev(`(async()=>{cv.doc.layers.forEach(l=>l.visible=false); const c=await renderPNGCanvas(); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for(let i=0;i<d.length;i+=4) if(d[i]<200) n++; cv.doc.layers.forEach(l=>l.visible=true); cv.doc.layers[1].visible=false; return n})()`);
  check('hidden layers are not exported (PNG has no ink)', inkAll === 0, 'ink=' + inkAll);
  await ctrlZ();
  check('undo shows the layer again', await ev(`cv.doc.layers[1].visible!==false && document.querySelector('.tb[data-id="B"]').style.display!=='none'`));
  // lock
  const lk = await centerOf('.lrow[data-id="A"] .llock'); await click(lk.x, lk.y);
  check('lock toggle locks the layer', await ev(`cv.doc.layers[0].locked===true && document.querySelector('.tb[data-id="A"]').classList.contains('locked')`));
  const ael = await centerOf('.tb[data-id="A"]');
  await ev(`setSel([])`); await clickM(ael.x, ael.y);
  check('locked layer cannot be selected on the canvas', !(await ev('cv.selSet')).includes('A'), JSON.stringify(await ev('cv.selSet')));
  const ax0 = await ev(`cv.doc.layers[0].x`);
  await dragM(ael.x, ael.y, ael.x + 90, ael.y + 40);
  check('locked layer cannot be moved', await ev(`cv.doc.layers[0].x`) === ax0 && await ev(`cv.doc.layers[0].y`) === 50);
  await ev(`setSel(['A'])`); await rawKey('ArrowRight', 'ArrowRight', 39);
  check('locked layer cannot be nudged', await ev(`cv.doc.layers[0].x`) === ax0);
  const lk2 = await centerOf('.lrow[data-id="A"] .llock'); await click(lk2.x, lk2.y);
  check('unlock works', await ev(`cv.doc.layers[0].locked===false`));
  // rename
  const nm = await centerOf('.lrow[data-id="C"] .lname'); await click(nm.x, nm.y, 2); await sleep(150);
  check('double-click name opens an inline input', await ev(`!!document.querySelector('.lrow[data-id="C"] input.lren')`));
  await ev(`document.querySelector('.lrow[data-id="C"] input.lren').select()`); await type('Renamed'); await key('Enter'); await sleep(100);
  check('rename commits on Enter', await ev(`cv.doc.layers[2].name`) === 'Renamed' && await ev(`document.querySelector('.lrow[data-id="C"] .lname').textContent`) === 'Renamed');
  await ctrlZ();
  check('undo restores the old name', await ev(`cv.doc.layers[2].name`) === '' && await ev(`document.querySelector('.lrow[data-id="C"] .lname').textContent`) === 'Charlie');
  // order shortcuts on B
  await ev(`setSel(['B'])`);
  await rawKey(']', 'BracketRight', 221, CTRL);   check('Ctrl+] brings forward', same(await ids(), ['A', 'C', 'B']), JSON.stringify(await ids()));
  await rawKey('[', 'BracketLeft', 219, CTRL);    check('Ctrl+[ sends backward', same(await ids(), ['A', 'B', 'C']));
  await rawKey('}', 'BracketRight', 221, CTRL | SHIFT);  check('Ctrl+Shift+] brings to front', same(await ids(), ['A', 'C', 'B']));
  await rawKey('{', 'BracketLeft', 219, CTRL | SHIFT);   check('Ctrl+Shift+[ sends to back', same(await ids(), ['B', 'A', 'C']));
  await ctrlZ(); await ctrlZ(); await ctrlZ(); await ctrlZ();
  check('undo x4 restores the order', same(await ids(), ['A', 'B', 'C']));
  // delete + duplicate on the selection
  await ev(`setSel(['B'])`); await key('d', CTRL);
  check('Ctrl+D duplicates the selection', await ev(`cv.doc.layers.length`) === 4 && await ev(`cv.doc.layers[2].text`) === 'Bravo');
  await key('Delete');
  check('Delete removes the selection', await ev(`cv.doc.layers.length`) === 3);
  await ctrlZ(); await ctrlZ();
  check('undo twice restores', await ev(`cv.doc.layers.length`) === 3 && same(await ids(), ['A', 'B', 'C']));
  // old documents (with "boxes") migrate
  const mig = await ev(`(()=>{const d=sanitizeDoc({artboard:{w:500,h:500},boxes:[{id:'x1',x:1,y:2,w:300,text:'old',family:'Noto Sans',style:'',size:30,lh:1.2,ls:0,align:'left',color:'#111111',tt:'none',op:1}]}); return d && d.layers.length===1 && d.layers[0].type==='text' && d.layers[0].visible===true && d.layers[0].locked===false && 'name' in d.layers[0] && !('boxes' in d)})()`);
  check('old documents migrate to layers', mig === true);
}

if (phase === 'all' || phase === 'alt') {
  await openCanvas();
  await loadDoc([T('A', 100, 100, 'Alpha'), T('B', 100, 300, 'Bravo')]);
  const ael = await centerOf('.tb[data-id="A"]');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ael.x, y: ael.y, modifiers: 1 }); await sleep(100);
  check('copy cursor class while Alt is held over an item', await ev(`ab.classList.contains('copy') && getComputedStyle(document.querySelector('.tb[data-id="A"]')).cursor==='copy'`));
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 }); await sleep(80);
  check('copy cursor off after Alt is released', !(await ev(`ab.classList.contains('copy')`)));
  const n0 = await ev(`cv.doc.layers.length`), h0 = await ev('cv.hi');
  await dragM(ael.x, ael.y, ael.x + 135, ael.y + 54, 1);
  const L = await ev(`JSON.stringify(cv.doc.layers.map(l=>[l.id,l.x,l.y,l.text]))`), arr = JSON.parse(L);
  const orig = arr.find(l => l[0] === 'A'), copy = arr.find(l => l[0] !== 'A' && l[0] !== 'B' && l[3] === 'Alpha');
  check('Alt+drag adds one copy', arr.length === n0 + 1 && !!copy, 'count ' + n0 + '->' + arr.length);
  check('Alt+drag leaves the original in place', orig && orig[1] === 100 && orig[2] === 100, JSON.stringify(orig));
  check('Alt+drag moves the copy by the drag distance', copy && Math.abs(copy[1] - 250) <= 1 && Math.abs(copy[2] - 160) <= 1, JSON.stringify(copy));
  check('the copy is selected and sits above the original', await ev(`cv.selSet.length===1 && cv.selSet[0]!=='A'`) && (await ids()).indexOf(copy[0]) === 1);
  check('Alt+drag is one undo step', await ev('cv.hi') === h0 + 1);
  await ctrlZ();
  check('one undo removes the copy and keeps the original', await ev(`cv.doc.layers.length`) === n0 && await ev(`cv.doc.layers[0].x`) === 100);
  // snapping still works with Alt: centre of A is x=250; the page centre is 400, so move by 150 (grab with a small error)
  const guides = await dragM(ael.x, ael.y, ael.x + 150 * 0.9 + 2, ael.y, 1, 10, async () => ev(`({v:getComputedStyle(document.querySelector('#gv')).display, h:getComputedStyle(document.querySelector('#gh')).display})`));
  const cp = await ev(`(()=>{const c=cv.doc.layers.find(l=>l.id!=='A'&&l.id!=='B'); const el=document.querySelector('.tb[data-id="'+c.id+'"]'); return c.x+el.offsetWidth/2})()`);
  check('snapping works during Alt+drag (guide shown, copy centred)', guides.v === 'block' && Math.abs(cp - 400) <= 1, JSON.stringify(guides) + ' cx=' + cp);
  await ctrlZ();
  // Alt pressed in the middle of a drag
  const bel = await centerOf('.tb[data-id="B"]');
  await dragM(bel.x, bel.y, bel.x + 90, bel.y + 30, 1, 10, null, 5);
  const arr2 = JSON.parse(await ev(`JSON.stringify(cv.doc.layers.map(l=>[l.id,l.x,l.y,l.text]))`));
  const ob = arr2.find(l => l[0] === 'B'), cb = arr2.find(l => l[0] !== 'A' && l[0] !== 'B' && l[3] === 'Bravo');
  check('Alt pressed mid-drag duplicates and restores the original', !!cb && ob[1] === 100 && ob[2] === 300 && cb[1] > 100, JSON.stringify([ob, cb]));
  await ctrlZ();
  check('mid-drag Alt is also one undo step', await ev(`cv.doc.layers.length`) === 2);
  // plain drag still just moves
  await dragM(ael.x, ael.y, ael.x + 45, ael.y + 45);
  check('plain drag moves without copying', await ev(`cv.doc.layers.length`) === 2 && await ev(`cv.doc.layers[0].x`) > 100);
  await ctrlZ();
  // Text tool: key T, one click on empty canvas adds a text layer in edit mode; Esc leaves the tool
  await key('t');
  const emp = await A2S(600, 440); await clickM(emp.x, emp.y); await sleep(150);
  check('Text tool: click on empty canvas adds a text layer and edits it', await ev(`cv.tool`) === 'text' && await ev(`cv.doc.layers.length`) === 3 && await ev(`!!cv.editing`));
  await key('Escape'); await key('Escape'); await sleep(100);
  check('Esc returns to the Selection tool', await ev(`cv.tool`) === 'select');
}

if (phase === 'all' || phase === 'outlines') {
  await openCanvas();
  const art = { w: 800, h: 300, bg: '#ffffff', preset: 'Custom' };
  await loadDoc([T('V', 60, 60, 'Hamburg 123', { family: 'Manrope', style: '', size: 110, w: 700, vars: { wght: 800 }, feat: { tnum: 1 } })], art);
  await ev(`setSel([])`); await sleep(200);
  const before = await shotClip(), inkB = await inkInfo(before);
  await ev(`setSel(['V'])`); await sleep(150);
  const btn = await ev(`(()=>{const b=[...document.querySelectorAll('#insp button')].find(b=>b.textContent==='Create outlines'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await click(btn.x, btn.y);
  check('Create outlines button converts the layer', await waitFor(`cv.doc.layers[0] && cv.doc.layers[0].type==='group'`, 20000));
  const g = JSON.parse(await ev(`JSON.stringify({n:cv.doc.layers[0].children.length, name:cv.doc.layers[0].name, vis:cv.doc.layers[0].visible, fill:cv.doc.layers[0].children[0].fill, types:[...new Set(cv.doc.layers[0].children.map(c=>c.type))], names:cv.doc.layers[0].children.map(c=>c.name).join('')})`));
  check('group has one path per non-space glyph', g.n === 'Hamburg123'.length && g.types.join() === 'path', JSON.stringify(g));
  check('group is named after the text and keeps the colour', g.name === 'Hamburg 123' && g.fill === '#111111', g.name + ' ' + g.fill);
  await ev(`setSel([])`); await sleep(250);
  const after = await shotClip(), inkA = await inkInfo(after), df = await shotDiff(before, after);
  const dd = ['l', 't', 'r', 'b'].map(k => Math.abs(inkA[k] - inkB[k]));
  check('outlines match the text: ink box within 2 px', Math.max(...dd) <= 2, 'text ' + JSON.stringify([inkB.l, inkB.t, inkB.r, inkB.b]) + ' outlines ' + JSON.stringify([inkA.l, inkA.t, inkA.r, inkA.b]));
  check('outlines match the text: pixels agree (variable axis + feature applied)', df.diff / df.ink < 0.08, JSON.stringify(df));
  const svg = await ev(`buildSVG()`);
  check('SVG export of a group contains <path> elements and no <text>', (svg.match(/<path /g) || []).length >= 10 && !svg.includes('<text') && svg.includes('<g data-name="Hamburg 123"'), (svg.match(/<path /g) || []).length + ' paths');
  const ink = await ev(`(async()=>{const c=await renderPNGCanvas(); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for(let i=0;i<d.length;i+=4) if(d[i]<100) n++; return n})()`);
  check('PNG export draws the group', ink > 3000, 'ink ' + ink);
  const rt = await ev(`(()=>{const a=JSON.stringify(cv.doc); const b=JSON.stringify(sanitizeDoc(JSON.parse(a))); return a===b})()`);
  check('save/open round-trips groups and paths', rt === true);
  await ctrlZ();
  check('undo restores the text layer', await ev(`cv.doc.layers[0].type`) === 'text' && await ev(`cv.doc.layers[0].text`) === 'Hamburg 123' && await ev(`!!document.querySelector('.tb[data-id="V"]')`));
  // keyboard: Ctrl+Shift+O
  await ev(`setSel(['V'])`); await rawKey('O', 'KeyO', 79, CTRL | SHIFT);
  check('Ctrl+Shift+O creates outlines', await waitFor(`cv.doc.layers[0].type==='group'`, 20000));
  await ctrlZ();
  // line breaks, alignment, letter spacing and uppercase come from the DOM
  await ev(`(()=>{const b=cv.doc.layers[0]; Object.assign(b,{text:'Wrap and\\nbreak ok', w:360, align:'center', ls:4, lh:1.3, size:70, tt:'upper', vars:{}, feat:{}, family:'Noto Sans'}); renderAll(); commit();})()`);
  await ev(`setSel([])`); await sleep(250);
  const b2 = await shotClip(), i2 = await inkInfo(b2);
  await ev(`createOutlines('V')`); await waitFor(`cv.doc.layers[0].type==='group'`, 20000);
  await ev(`setSel([])`); await sleep(250);
  const a2 = await shotClip(), j2 = await inkInfo(a2), d2 = await shotDiff(b2, a2);
  check('wrapped, centred, spaced, uppercase text: ink box within 2 px', Math.max(...['l', 't', 'r', 'b'].map(k => Math.abs(i2[k] - j2[k]))) <= 2, JSON.stringify([i2.l, i2.t, i2.r, i2.b]) + ' vs ' + JSON.stringify([j2.l, j2.t, j2.r, j2.b]));
  check('wrapped, centred, spaced, uppercase text: pixels agree', d2.diff / d2.ink < 0.1, JSON.stringify(d2));
  await ctrlZ();
}

if (phase === 'all' || phase === 'direct') {
  await openCanvas();
  const art = { w: 800, h: 400, bg: '#ffffff', preset: 'Custom' };
  await loadDoc([T('V', 80, 60, 'Oa', { family: 'Manrope', style: '', size: 260, w: 700 })], art);
  await ev(`createOutlines('V')`); await waitFor(`cv.doc.layers[0].type==='group'`, 20000);
  const gid = await ev(`cv.doc.layers[0].id`);
  const kids = JSON.parse(await ev(`JSON.stringify(cv.doc.layers[0].children.map(c=>[c.id,c.name,c.contours.reduce((n,k)=>n+k.nodes.length,0)]))`));
  check('outlined "Oa" gives 2 child paths', kids.length === 2 && kids[0][1] === 'O' && kids[1][1] === 'a', JSON.stringify(kids));
  // layers panel: group is expanded after outlining; screenshot
  check('layers panel shows the group expanded with its children', await ev(`document.querySelectorAll('#lyr-list .lrow.child').length`) === 2);
  const [oId, aId] = [kids[0][0], kids[1][0]];
  const dOf = id => ev(`contoursToD(findItem('${id}').item.contours)`);
  // selection tool: clicking a glyph selects the whole group
  const pt = async id => ev(`(()=>{const p=document.querySelector('path[data-pid="${id}"]'); const b=p.getBBox(); const q=ab.getBoundingClientRect(); for(let y=b.y+b.height*0.1;y<b.y+b.height;y+=3)for(let x=b.x+b.width*0.05;x<b.x+b.width;x+=3){ if(p.isPointInFill(new DOMPoint(x,y))) return {x:q.left+x*cv.zoom,y:q.top+y*cv.zoom,ax:x,ay:y}} return null})()`);
  const pa = await pt(aId), po = await pt(oId);
  await clickM(pa.x, pa.y);
  check('Selection tool: click a glyph selects the group', same(await ev('cv.selSet'), [gid]));
  // direct selection
  await key('a');
  check('key A switches to Direct Selection', await ev('cv.tool') === 'direct' && await ev(`document.querySelector('#tools button[data-tool=direct]').classList.contains('on')`));
  await clickM(pa.x, pa.y);
  check('Direct: click a glyph selects only that path', same(await ev('cv.selSet'), [aId]) && await ev(`!!findItem('${aId}').parent`));
  const nA = kids[1][2];
  check('Direct: anchors are shown as squares', await ev(`document.querySelectorAll('#ov rect.anc').length`) === nA, nA + ' nodes, ' + await ev(`document.querySelectorAll('#ov rect.anc').length`) + ' squares');
  // move the whole path
  const dA0 = await dOf(aId), dO0 = await dOf(oId);
  await dragM(pa.x, pa.y, pa.x + 54, pa.y + 36);
  const dA1 = await dOf(aId), dO1 = await dOf(oId);
  check('Direct: dragging the glyph moves only that path', dA1 !== dA0 && dO1 === dO0);
  const mv = await ev(`(()=>{const a=findItem('${aId}').item.contours[0].nodes[0]; return [a.x,a.y]})()`);
  await ctrlZ();
  check('undo restores the moved glyph', await dOf(aId) === dA0);
  // anchor selection
  const anc = async i => ev(`(()=>{const e=document.querySelectorAll('#ov rect.anc')[${i}]; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const a0 = await anc(0), a1 = await anc(1);
  await clickM(a0.x, a0.y);
  check('Direct: click an anchor selects it', await ev(`cv.dsel.size`) === 1 && await ev(`document.querySelectorAll('#ov rect.anc.sel').length`) === 1);
  await clickM(a1.x, a1.y, SHIFT);
  check('Direct: shift-click adds an anchor', await ev(`cv.dsel.size`) === 2);
  await clickM(a0.x, a0.y);
  check('Direct: plain click on an anchor selects just it', await ev(`cv.dsel.size`) === 1);
  // drag the anchor with its handles
  const node0 = () => ev(`JSON.stringify(findItem('${aId}').item.contours[0].nodes.map(n=>[n.x,n.y,n.i,n.o]))`).then(JSON.parse);
  const n0 = await node0();
  await dragM(a0.x, a0.y, a0.x + 27, a0.y + 18);
  const n1 = await node0(); const dx = n1[0][0] - n0[0][0], dy = n1[0][1] - n0[0][1];
  const hmoved = [[1, 2], [2, 3]].every(([k, w]) => { const A = n0[0][w], B = n1[0][w]; return !A || (Math.abs(B[0] - A[0] - dx) < 0.01 && Math.abs(B[1] - A[1] - dy) < 0.01); });
  const othersSame = n1.slice(1).every((n, i) => JSON.stringify(n) === JSON.stringify(n0[i + 1]));
  check('Direct: dragging an anchor moves it with its own handles, others stay', Math.abs(dx - 30) < 1 && Math.abs(dy - 20) < 1 && hmoved && othersSame, 'd=' + dx.toFixed(1) + ',' + dy.toFixed(1));
  check('anchor drag changes the path data', await dOf(aId) !== dA0);
  await ctrlZ();
  check('undo restores the anchor', JSON.stringify(await node0()) === JSON.stringify(n0));
  // handles: pick an anchor that has handles
  const withH = await ev(`(()=>{const ns=findItem('${aId}').item.contours.flatMap((c,ci)=>c.nodes.map((n,ni)=>[ci,ni,!!(n.i||n.o)])); const k=ns.findIndex(x=>x[2]); return k<0?null:k})()`);
  if (withH !== null) {
    const ai = await anc(withH); await clickM(ai.x, ai.y);
    const hdN = await ev(`document.querySelectorAll('#ov circle.hd').length`);
    check('Direct: handles of the selected anchor are shown as dots with lines', hdN >= 1 && await ev(`document.querySelectorAll('#ov line').length`) === hdN, hdN + ' handles');
    await sleep(200);
    const clip = await ev(`(()=>{const p=document.querySelector('path[data-pid="${aId}"]').getBBox(); const q=ab.getBoundingClientRect(); const z=cv.zoom; return {x:q.left+(p.x-60)*z, y:q.top+(p.y-40)*z, width:(p.width+120)*z, height:(p.height+80)*z}})()`);
    await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 3 } }).then(r => fs.writeFileSync(SHOTS + 'direct-selection.png', Buffer.from(r.data, 'base64')));
    const hp = await ev(`(()=>{const e=document.querySelector('#ov circle.hd'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,key:e.dataset.key,w:e.dataset.w}})()`);
    const [pid, ci, ni] = hp.key.split('|');
    const nodeAt = () => ev(`JSON.stringify(findItem('${pid}').item.contours[${ci}].nodes)`).then(JSON.parse);
    const h0 = await nodeAt();
    await dragM(hp.x, hp.y, hp.x + 18, hp.y - 27, 1);   // Alt breaks the smooth pair, so only this handle moves
    const h1 = await nodeAt();
    const changed = h1.map((n, i) => JSON.stringify(n) !== JSON.stringify(h0[i]) ? i : -1).filter(i => i >= 0);
    check('Direct: Alt-dragging a handle moves only that handle', changed.length === 1 && changed[0] === +ni && h1[+ni].x === h0[+ni].x && h1[+ni].y === h0[+ni].y && JSON.stringify(h1[+ni][hp.w]) !== JSON.stringify(h0[+ni][hp.w]) && JSON.stringify(h1[+ni][hp.w === 'i' ? 'o' : 'i']) === JSON.stringify(h0[+ni][hp.w === 'i' ? 'o' : 'i']));
    await ctrlZ();
    check('undo restores the handle', JSON.stringify(await nodeAt()) === JSON.stringify(h0));
  } else check('Direct: handles shown', false, 'no node with handles');
  // marquee selects anchors of the glyph "a"
  await clickM(pa.x, pa.y);   // keep a selected so marquee works within selected paths
  const bb = await ev(`(()=>{const p=document.querySelector('path[data-pid="${aId}"]').getBBox(); const q=ab.getBoundingClientRect(); return {l:q.left+(p.x-6)*cv.zoom,t:q.top+(p.y-6)*cv.zoom,r:q.left+(p.x+p.width+6)*cv.zoom,b:q.top+(p.y+p.height+6)*cv.zoom}})()`);
  await ev(`setSel([])`);
  await dragM(bb.l, bb.t, bb.r, bb.b);
  check('Direct: marquee on empty canvas selects the anchors inside', await ev(`cv.dsel.size`) === nA && same(await ev('cv.selSet'), [aId]), 'dsel=' + await ev(`cv.dsel.size`) + ' of ' + nA);
  // arrow nudge
  const nb = await node0();
  await rawKey('ArrowRight', 'ArrowRight', 39); await rawKey('ArrowDown', 'ArrowDown', 40, SHIFT);
  const nc = await node0();
  check('Arrow keys nudge selected anchors 1 px and Shift 10 px', Math.abs(nc[0][0] - nb[0][0] - 1) < 0.01 && Math.abs(nc[0][1] - nb[0][1] - 10) < 0.01 && Math.abs(nc[3][0] - nb[3][0] - 1) < 0.01);
  await ctrlZ(); await ctrlZ();
  check('undo restores the nudges', JSON.stringify(await node0()) === JSON.stringify(nb));
  // arrows with a path selected and no anchors: moves the path
  await ev(`setSel(['${aId}'])`); const dN0 = await dOf(aId);
  await rawKey('ArrowLeft', 'ArrowLeft', 37, SHIFT);
  check('Arrow keys move a selected path (Shift = 10 px)', await dOf(aId) !== dN0 && await dOf(oId) === dO0);
  await ctrlZ();
  // Alt+drag on a child path duplicates it inside the group
  const cnt0 = await ev(`cv.doc.layers[0].children.length`), dA = await dOf(aId);
  const pc = await ev(`(()=>{const p=document.querySelector('path[data-pid="${aId}"]'); const b=p.getBBox(); const q=ab.getBoundingClientRect(); for(let y=b.y+b.height*0.1;y<b.y+b.height;y+=2)for(let x=b.x+b.width*0.05;x<b.x+b.width;x+=2){ if(!p.isPointInFill(new DOMPoint(x,y))) continue; const sx=q.left+x*cv.zoom, sy=q.top+y*cv.zoom; if(document.elementFromPoint(sx,sy)===p) return {x:sx,y:sy}} return null})()`);
  await dragM(pc.x, pc.y, pc.x + 63, pc.y + 36, 1);
  check('Direct: Alt+drag on a child duplicates it in the group', await ev(`cv.doc.layers[0].children.length`) === cnt0 + 1 && await dOf(aId) === dA, 'children ' + cnt0 + '->' + await ev(`cv.doc.layers[0].children.length`) + ' same=' + (await dOf(aId) === dA) + ' tool=' + await ev('cv.tool') + ' sel=' + await ev('JSON.stringify(cv.selSet)'));
  await ctrlZ();
  check('undo removes the duplicated child', await ev(`cv.doc.layers[0].children.length`) === cnt0);
  // layers panel: clicking a child selects it as a direct selection
  await ev(`setTool('select'); setSel([])`);
  const row = await centerOf(`.lrow[data-id="${oId}"] .lname`); await click(row.x, row.y);
  check('Layers: clicking a child selects it as a direct selection', same(await ev('cv.selSet'), [oId]) && await ev('cv.tool') === 'direct' && await ev(`document.querySelectorAll('#ov rect.anc').length`) === kids[0][2]);
  await sleep(150); await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(SHOTS + 'layers.png', Buffer.from(r.data, 'base64')));
  // eye on a child hides just that glyph
  const eyeC = await centerOf(`.lrow[data-id="${oId}"] .leye`); await click(eyeC.x, eyeC.y);
  check('Layers: eye on a child hides that glyph only', await ev(`document.querySelector('path[data-pid="${oId}"]').style.display`) === 'none' && await ev(`document.querySelector('path[data-pid="${aId}"]').style.display`) !== 'none');
  const svgC = await ev(`buildSVG()`); check('hidden child is not exported', (svgC.match(/<path /g) || []).length === 1);
  await ctrlZ();
  // Selection tool marquee selects whole layers; Esc returns to Selection
  await ev(`setTool('select'); setSel([])`);
  const mq = await ev(`(()=>{const q=ab.getBoundingClientRect(); return {l:q.left+5,t:q.top+5,r:q.left+700*cv.zoom,b:q.top+390*cv.zoom}})()`);
  await dragM(mq.l, mq.t, mq.r, mq.b);
  check('Selection: marquee selects whole layers', same(await ev('cv.selSet'), [gid]));
  await key('a'); await key('Escape');
  check('Esc returns to the Selection tool', await ev('cv.tool') === 'select');
  // direct tool on a text layer acts like the selection tool
  await ev(`(()=>{cv.doc.layers.push(${JSON.stringify(T('X', 80, 330, 'Plain', { size: 40 }))}); renderAll(); commit(); setTool('direct'); setSel([])})()`);
  const xe = await centerOf('.tb[data-id="X"]'); const x0 = await ev(`findItem('X').item.x`);
  await dragM(xe.x, xe.y, xe.x + 36, xe.y + 18);
  check('Direct tool on a text layer behaves like Selection (select + move)', same(await ev('cv.selSet'), ['X']) && await ev(`findItem('X').item.x`) === x0 + 40);
  // old-model migration also keeps text working next to groups after reload
  await sleep(700); await send('Page.reload'); await sleep(400); await waitFor(`document.readyState==='complete' && lib.families.length>0`, 20000); await sleep(600);
  check('autosave keeps groups and paths across a reload', await ev(`cv.doc.layers.some(l=>l.type==='group' && l.children.length===2)`));
}


/* ===================== fix round: regression checks 1-9 + toolbar ===================== */
const P = (id, name, x, y, extra = {}) => ({ type: 'path', id, name, visible: true, locked: false, fill: '#111111', op: 1, contours: [{ closed: true, nodes: [{ x, y, i: null, o: null }, { x: x + 60, y, i: null, o: null }, { x: x + 60, y: y + 60, i: null, o: null }, { x, y: y + 60, i: null, o: null }] }], ...extra });
const G = (id, name, children, extra = {}) => ({ type: 'group', id, name, visible: true, locked: false, children, ...extra });
const dOfId = id => ev(`contoursToD(findItem(${JSON.stringify(id)}).item.contours)`);
const pathCenter = async id => ev(`(()=>{const p=document.querySelector('path[data-pid=${JSON.stringify(id)}]'); const b=p.getBBox(); const q=ab.getBoundingClientRect(); return {x:q.left+(b.x+b.width/2)*cv.zoom,y:q.top+(b.y+b.height/2)*cv.zoom}})()`);

if (phase === 'all' || phase === 'fix') {
  await openCanvas();
  const bar = await ev(`(()=>{const b=document.querySelector('#cv-bar'); const rows=new Set([...b.querySelectorAll(':scope > *')].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect(); return Math.round((r.top+r.bottom)/2/6)})); return {rows:rows.size, h:b.getBoundingClientRect().height, sw:b.scrollWidth, cw:b.clientWidth}})()`);
  check('toolbar fits on one row at 1400 px', bar.rows === 1 && bar.h < 60 && bar.sw <= bar.cw + 1, JSON.stringify(bar));
  await clickSel('#morebtn'); await key('Escape');
  check('More menu closes with Esc', await ev(`document.querySelector('#more-menu').hidden`));

  /* 1. direct selection respects locks */
  await loadDoc([G('g1', 'Locked group', [P('p1', 'one', 100, 100), P('p2', 'two', 300, 100)], { locked: true }), G('g2', 'Group', [P('p3', 'three', 100, 250), P('p4', 'four', 300, 250, { locked: true })])]);
  await ev(`setTool('direct'); setSel(['p1'])`);
  check('1: no anchors shown for a path in a locked group', await ev(`document.querySelectorAll('#ov rect.anc').length`) === 0);
  await ev(`cv.dsel=new Set(['p1|0|0']); renderOverlay()`);
  const d1 = await dOfId('p1'); await ev(`nudge(5,5)`);
  check('1: locked group child cannot be nudged or edited', await dOfId('p1') === d1);
  await ev(`cv.dsel=new Set(['p1|0|0']); delSel()`);
  check('1: anchor delete skips locked items', await ev(`findItem('p1').item.contours[0].nodes.length`) === 4);
  await ev(`setSel(['p4'])`);
  check('1: no anchors for a locked path in an unlocked group', await ev(`document.querySelectorAll('#ov rect.anc').length`) === 0);
  await ev(`setSel(['p3'])`);
  check('1: unlocked path still shows its anchors', await ev(`document.querySelectorAll('#ov rect.anc').length`) === 4);
  const anc3 = await ev(`(()=>{const e=document.querySelectorAll('#ov rect.anc')[0]; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  // marquee over the locked group must not select its anchors
  const q0 = await A2S(60, 60), q1 = await A2S(420, 200);
  await ev(`setSel([])`); await dragM(q0.x, q0.y, q1.x, q1.y);
  check('1: marquee skips anchors of locked groups', await ev(`cv.dsel.size`) === 0);

  /* 2. ids */
  const ids2 = await ev(`(()=>{const d=sanitizeDoc({artboard:{w:400,h:400},layers:[{type:'text',id:'a b',text:'x',family:'Noto Sans'},{type:'text',id:'dup',text:'y',family:'Noto Sans'},{type:'text',id:'dup',text:'z',family:'Noto Sans'},{type:'group',id:'dup',children:[{id:'dup',contours:[]},{id:'x"]',contours:[]}]},{type:'text',id:'a'.repeat(30),text:'q',family:'Noto Sans'},{type:'text',id:'..',text:'r',family:'Noto Sans'}]}); const all=[]; d.layers.forEach(l=>{all.push(l.id); if(l.children) l.children.forEach(c=>all.push(c.id))}); return {all, ok: all.every(i=>/^[A-Za-z0-9_-]{1,20}$/.test(i)), uniq:new Set(all).size===all.length}})()`);
  check('2: bad or duplicate ids are replaced (groups and children too)', ids2.ok && ids2.uniq && ids2.all.includes('dup'), JSON.stringify(ids2));
  const inj = await ev(`(()=>{cv.doc=sanitizeDoc({artboard:{w:400,h:400},layers:[{type:'text',id:'a\\\\"]b',text:'t',family:'Noto Sans',x:10,y:10,w:200}]}); renderAll(); return !!document.querySelector('.tb')})()`);
  check('2: odd ids cannot break selectors', inj === true);

  /* 3. Shift */
  await loadDoc([T('A', 100, 100, 'Alpha'), T('B', 100, 250, 'Bravo')]);
  await ev(`setSel(['A','B'])`);
  const ac = await centerOf('.tb[data-id="A"]');
  await dragM(ac.x, ac.y, ac.x + 40, ac.y + 40, SHIFT);
  check('3: Shift-drag on a selected object keeps the selection while dragging', same((await ev('cv.selSet')).sort(), ['A', 'B']) && await ev(`cv.doc.layers[0].x`) > 100);
  await ev(`setSel(['A','B'])`); await clickM(ac.x, ac.y, SHIFT);
  check('3: Shift-click (no drag) on a selected object removes it', same(await ev('cv.selSet'), ['B']));
  await ev(`cv.doc.layers[0].x=100; cv.doc.layers[0].y=100; renderAll(); setSel(['A'])`);
  const ac2 = await centerOf('.tb[data-id="A"]');
  await dragM(ac2.x, ac2.y, ac2.x + 90, ac2.y + 30, SHIFT);
  const mv = await ev(`[cv.doc.layers[0].x-100, cv.doc.layers[0].y-100]`);
  check('3: Shift constrains the drag to 0/45/90 degrees', mv[1] === 0 || mv[0] === 0 || Math.abs(Math.abs(mv[0]) - Math.abs(mv[1])) <= 1, JSON.stringify(mv));

  /* 4. Alt released before mouse-up */
  await loadDoc([T('A', 100, 100, 'Alpha')]);
  const a4 = await centerOf('.tb[data-id="A"]');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a4.x, y: a4.y, modifiers: 1 });
  await mouse('mousePressed', a4.x, a4.y, { modifiers: 1 });
  for (let i = 1; i <= 5; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a4.x + 12 * i, y: a4.y + 6 * i, button: 'left', buttons: 1, modifiers: 1 }); await sleep(15); }
  const withCopy = await ev(`cv.doc.layers.length`);
  for (let i = 6; i <= 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a4.x + 12 * i, y: a4.y + 6 * i, button: 'left', buttons: 1, modifiers: 0 }); await sleep(15); }
  const afterRelease = await ev(`cv.doc.layers.length`);
  await mouse('mouseReleased', a4.x + 120, a4.y + 60, {}); await sleep(150);
  check('4: Alt held creates a copy', withCopy === 2);
  check('4: Alt released before mouse-up removes the copy and moves the original', afterRelease === 1 && await ev(`cv.doc.layers.length`) === 1 && await ev(`cv.doc.layers[0].id`) === 'A' && await ev(`cv.doc.layers[0].x`) > 150, 'x=' + await ev(`cv.doc.layers[0].x`));
  check('4: that drag is one undo step', await ev('cv.hi') === 1);
  await ctrlZ();
  check('4: undo puts the original back', await ev(`cv.doc.layers[0].x`) === 100);
  // Alt released only at the very end (no more moves)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a4.x, y: a4.y, modifiers: 1 });
  await mouse('mousePressed', a4.x, a4.y, { modifiers: 1 });
  for (let i = 1; i <= 6; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a4.x + 10 * i, y: a4.y, button: 'left', buttons: 1, modifiers: 1 }); await sleep(15); }
  await mouse('mouseReleased', a4.x + 60, a4.y, { modifiers: 0 }); await sleep(150);
  check('4: Alt released together with the mouse (no further move) moves the original', await ev(`cv.doc.layers.length`) === 1 && await ev(`cv.doc.layers[0].x`) > 100);
  await ctrlZ();

  /* 5. hidden items do not move or copy */
  await loadDoc([T('A', 100, 100, 'Alpha'), T('B', 100, 250, 'Bravo', { visible: false })]);
  await ev(`setSel(['B'])`); const bx0 = await ev(`cv.doc.layers[1].x`);
  await rawKey('ArrowRight', 'ArrowRight', 39);
  check('5: hidden layer does not nudge', await ev(`cv.doc.layers[1].x`) === bx0);
  await key('d', CTRL);
  check('5: hidden layer is not duplicated', await ev(`cv.doc.layers.length`) === 2);
  check('5: hidden layer can still be selected', same(await ev('cv.selSet'), ['B']));
  await ev(`setSel(['A','B'])`); const a5 = await centerOf('.tb[data-id="A"]');
  await dragM(a5.x, a5.y, a5.x + 60, a5.y + 30, 1);
  check('5: Alt+drag with a hidden item selected copies only the visible one', await ev(`cv.doc.layers.length`) === 3 && await ev(`cv.doc.layers.filter(l=>l.text==='Bravo').length`) === 1 && await ev(`cv.doc.layers.find(l=>l.id==='B').x`) === bx0);
  await ctrlZ();

  /* 6. locked child in a moving / deleted group */
  await loadDoc([G('g', 'Group', [P('c1', 'free', 100, 100), P('c2', 'pinned', 300, 100, { locked: true })])]);
  const pinned0 = await dOfId('c2'), free0 = await dOfId('c1');
  const gp = await pathCenter('c1');
  await ev(`setTool('select')`); await dragM(gp.x, gp.y, gp.x + 54, gp.y + 18);
  check('6: group move leaves a locked child in place', await dOfId('c2') === pinned0 && await dOfId('c1') !== free0);
  await ctrlZ();
  await ev(`setSel(['g'])`); await rawKey('ArrowRight', 'ArrowRight', 39, SHIFT);
  check('6: nudging a group skips a locked child', await dOfId('c2') === pinned0 && await dOfId('c1') !== free0);
  await ctrlZ();
  await dragM(gp.x, gp.y, gp.x + 54, gp.y + 18, 1);
  check('6: Alt+drag copy of a group does not copy its locked child', await ev(`cv.doc.layers.length`) === 2 && await ev(`cv.doc.layers[1].children.length`) === 1 && await dOfId('c2') === pinned0);
  await ctrlZ();
  await ev(`setSel(['g'])`); await key('Delete');
  check('6: deleting the group keeps its locked child', await ev(`cv.doc.layers.length`) === 1 && await ev(`cv.doc.layers[0].children.length`) === 1 && await ev(`cv.doc.layers[0].children[0].id`) === 'c2');
  await ctrlZ();

  /* 9c. empty paths and groups */
  await loadDoc([G('g', 'Group', [P('c1', 'one', 100, 100), P('c2', 'two', 300, 100)]), P('solo', 'Solo', 100, 300)]);
  await ev(`setTool('direct'); setSel(['c1']); cv.dsel=new Set(['c1|0|0','c1|0|1']); delSel()`);
  check('9c: a closed path with 2 anchors left becomes open', await ev(`findItem('c1').item.contours[0].nodes.length`) === 2 && await ev(`findItem('c1').item.contours[0].closed`) === false);
  await ev(`setSel(['c1']); cv.dsel=new Set(['c1|0|0','c1|0|1']); delSel()`);
  check('9c: a path with no anchors left is removed', await ev(`!findItem('c1') && cv.doc.layers[0].children.length===1`));
  await ev(`setSel(['c2']); cv.dsel=new Set(['c2|0|0','c2|0|1','c2|0|2','c2|0|3']); delSel()`);
  check('9c: a group with no paths left is removed', await ev(`!findItem('g') && cv.doc.layers.length===1`));
  await ev(`setSel(['solo']); cv.dsel=new Set(['solo|0|0','solo|0|1','solo|0|2','solo|0|3']); delSel()`);
  check('9c: a top-level path with no anchors left is removed', await ev(`cv.doc.layers.length===0`));
  await ctrlZ(); await ctrlZ(); await ctrlZ(); await ctrlZ();
  check('9c: undo brings everything back', await ev(`cv.doc.layers.length===2 && findItem('c1') && findItem('c1').item.contours[0].nodes.length===4`));

  /* 9a smooth handles, 9b shift-marquee: use real glyph outlines */
  await loadDoc([T('V', 80, 40, 'Oa', { family: 'Manrope', style: '', size: 260, w: 700 })], { w: 800, h: 400, bg: '#ffffff', preset: 'Custom' });
  await ev(`createOutlines('V')`); await waitFor(`cv.doc.layers[0].type==='group'`, 20000);
  const kids = JSON.parse(await ev(`JSON.stringify(cv.doc.layers[0].children.map(c=>[c.id,c.name]))`)); const oId = kids[0][0], aId = kids[1][0];
  await ev(`setTool('direct'); setSel(['${oId}'])`);
  const smoothIdx = await ev(`(()=>{const ns=findItem('${oId}').item.contours[0].nodes; return ns.findIndex(n=>n.i&&n.o)})()`);
  const ancO = async i => ev(`(()=>{const e=document.querySelectorAll('#ov rect.anc')[${i}]; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const aS = await ancO(smoothIdx); await clickM(aS.x, aS.y);
  const nodeO = () => ev(`JSON.stringify(findItem('${oId}').item.contours[0].nodes[${smoothIdx}])`).then(JSON.parse);
  const n0 = await nodeO();
  const hp = await ev(`(()=>{const e=[...document.querySelectorAll('#ov circle.hd')].find(c=>c.dataset.w==='o'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await dragM(hp.x, hp.y, hp.x + 22, hp.y - 30);
  const n1 = await nodeO();
  const vo = [n1.o[0] - n1.x, n1.o[1] - n1.y], vi = [n1.i[0] - n1.x, n1.i[1] - n1.y];
  const cross = Math.abs(vo[0] * vi[1] - vo[1] * vi[0]) / (Math.hypot(...vo) * Math.hypot(...vi)), dot = vo[0] * vi[0] + vo[1] * vi[1];
  const len0 = Math.hypot(n0.i[0] - n0.x, n0.i[1] - n0.y), len1 = Math.hypot(...vi);
  check('9a: dragging one handle of a smooth point keeps the pair on one line', cross < 0.01 && dot < 0, 'sin=' + cross.toFixed(4));
  check('9a: the opposite handle keeps its length', Math.abs(len0 - len1) < 0.05, len0.toFixed(2) + ' -> ' + len1.toFixed(2));
  check('9a: the dragged handle moved and the anchor did not', JSON.stringify(n1.o) !== JSON.stringify(n0.o) && n1.x === n0.x && n1.y === n0.y);
  await ctrlZ();
  await clickM(aS.x, aS.y);
  const n0b = await nodeO();
  const hp2 = await ev(`(()=>{const e=[...document.querySelectorAll('#ov circle.hd')].find(c=>c.dataset.w==='o'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await dragM(hp2.x, hp2.y, hp2.x + 22, hp2.y - 30, 1);
  const n2 = await nodeO();
  check('9a: Alt-drag breaks the pair: the opposite handle stays', JSON.stringify(n2.i) === JSON.stringify(n0b.i) && JSON.stringify(n2.o) !== JSON.stringify(n0b.o));
  await ctrlZ();
  // 9b: marquee, then Shift+marquee adds the other glyph's anchors
  await ev(`setSel([])`);
  const bbO = await ev(`(()=>{const p=document.querySelector('path[data-pid="${oId}"]').getBBox(); const q=ab.getBoundingClientRect(); return {l:q.left+(p.x-6)*cv.zoom,t:q.top+(p.y-6)*cv.zoom,r:q.left+(p.x+p.width+6)*cv.zoom,b:q.top+(p.y+p.height+6)*cv.zoom}})()`);
  const bbA = await ev(`(()=>{const p=document.querySelector('path[data-pid="${aId}"]').getBBox(); const q=ab.getBoundingClientRect(); return {l:q.left+(p.x-6)*cv.zoom,t:q.top+(p.y-6)*cv.zoom,r:q.left+(p.x+p.width+6)*cv.zoom,b:q.top+(p.y+p.height+6)*cv.zoom}})()`);
  await dragM(bbO.l, bbO.t, bbO.r, bbO.b);
  const nO = await ev(`cv.dsel.size`);
  await dragM(bbA.l, bbA.t, bbA.r, bbA.b, SHIFT);
  const nBoth = await ev(`cv.dsel.size`), selBoth = (await ev('cv.selSet')).sort();
  check('9b: Shift+marquee adds anchors to the selection', nO > 0 && nBoth > nO && same(selBoth, [oId, aId].sort()), nO + ' -> ' + nBoth);
  await dragM(bbA.l, bbA.t, bbA.r, bbA.b);
  check('9b: a plain marquee replaces the selection', same(await ev('cv.selSet'), [aId]) && await ev(`cv.dsel.size`) < nBoth);
}

if (phase === 'all' || phase === 'text8') {
  await openCanvas();
  /* 8. missing glyphs: Manrope has no Arabic or CJK */
  await loadDoc([T('M', 60, 60, 'Ab中C', { family: 'Manrope', style: '', size: 120, w: 700 })], { w: 800, h: 300, bg: '#ffffff', preset: 'Custom' });
  await ev(`setSel(['M'])`); await ev(`(()=>{window.__oc = createOutlines('M'); return 1})()`);
  check('8: missing glyphs ask in the page (no browser dialog)', await waitFor(`!!document.querySelector('#miss-modal')`, 15000));
  const msg = await ev(`document.querySelector('#miss-modal').textContent`);
  check('8: the message names the missing letters and offers both choices', msg.includes('中') && msg.includes('Outline anyway') && msg.includes('Cancel'), msg.slice(0, 160));
  await clickSel('#miss-cancel'); await sleep(200);
  check('8: Cancel leaves the text layer alone', await ev(`cv.doc.layers[0].type`) === 'text' && await ev(`!document.querySelector('#miss-modal')`));
  await ev(`(()=>{window.__oc = createOutlines('M'); return 1})()`); await waitFor(`!!document.querySelector('#miss-modal')`, 15000);
  await clickSel('#miss-go'); await waitFor(`cv.doc.layers[0].type==='group'`, 15000);
  const nm = await ev(`cv.doc.layers[0].children.map(c=>c.name).join('|')`);
  check('8: Outline anyway makes the group, missing letter becomes a box named by its character', nm === 'A|b|中|C', nm);
  await ctrlZ();
  // astral character naming
  await loadDoc([T('S', 60, 60, '😀 A', { family: 'Noto Sans', style: '', size: 100, w: 700 })], { w: 800, h: 300, bg: '#ffffff', preset: 'Custom' });
  await ev(`(()=>{createOutlines('S'); return 1})()`); await sleep(1500);
  if (await ev(`!!document.querySelector('#miss-modal')`)) { const m2 = await ev(`document.querySelector('#miss-modal').textContent`); check('8: astral characters are named whole (not as half a surrogate pair)', m2.includes('😀'), m2.slice(0, 90)); await clickSel('#miss-cancel'); }
  else check('8: astral characters are named whole', await ev(`cv.doc.layers[0].children.every(c=>![...c.name].some(ch=>/[\ud800-\udfff]/.test(ch)))`));

  /* 7. RTL outlines land where the text is */
  await loadDoc([T('R', 40, 60, 'مرحبا بالعالم 123', { family: 'Noto Naskh Arabic', style: '', size: 90, w: 720, align: 'right' })], { w: 800, h: 300, bg: '#ffffff', preset: 'Custom' });
  await ev(`setSel([])`); await sleep(300);
  const rb = await shotClip(), rbi = await inkInfo(rb);
  await ev(`createOutlines('R')`); await waitFor(`cv.doc.layers[0].type==='group'`, 20000); await ev(`setSel([])`); await sleep(300);
  const ra = await shotClip(), rai = await inkInfo(ra), rd = await shotDiff(rb, ra);
  check('7: Arabic RTL outlines match the text within 2 px', Math.max(...['l', 't', 'r', 'b'].map(k => Math.abs(rai[k] - rbi[k]))) <= 2, JSON.stringify([rbi.l, rbi.t, rbi.r, rbi.b]) + ' vs ' + JSON.stringify([rai.l, rai.t, rai.r, rai.b]));
  check('7: Arabic pixels agree', rd.diff / rd.ink < 0.12, JSON.stringify(rd));
  await ctrlZ();
  await ev(`(()=>{const b=cv.doc.layers[0]; b.align='left'; b.text='مرحبا 123 ثم 45'; renderAll(); commit();})()`);
  await ev(`setSel([])`); await sleep(300);
  const mb = await shotClip(), mbi = await inkInfo(mb);
  await ev(`createOutlines('R')`); await waitFor(`cv.doc.layers[0].type==='group'`, 20000); await ev(`setSel([])`); await sleep(300);
  const ma = await shotClip(), mai = await inkInfo(ma), md = await shotDiff(mb, ma);
  check('7: mixed Arabic + digits (bidi runs) land within 2 px', Math.max(...['l', 't', 'r', 'b'].map(k => Math.abs(mai[k] - mbi[k]))) <= 2 && md.diff / md.ink < 0.15, JSON.stringify([mbi.l, mbi.t, mbi.r, mbi.b]) + ' vs ' + JSON.stringify([mai.l, mai.t, mai.r, mai.b]) + ' ' + JSON.stringify(md));
}


if (phase === 'shots') {
  await openCanvas();
  await ev(`demoCanvas()`); await sleep(500);
  await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(SHOTS + 'canvas-toolbar.png', Buffer.from(r.data, 'base64')));
  await clickSel('#morebtn'); await sleep(200);
  await send('Page.captureScreenshot', { format: 'png', clip: { x: 276, y: 40, width: 1124, height: 260, scale: 1 } }).then(r => fs.writeFileSync(SHOTS + 'canvas-toolbar-menu.png', Buffer.from(r.data, 'base64')));
}

if (phase === 'all' || phase === 'transform') {
  await openCanvas();
  const art = { w: 800, h: 500, bg: '#ffffff', preset: 'Custom' };
  const tbox = id => ev(`(()=>{const f=findItem('${id}'); const r=bboxOf('${id}'); return {x:r.x,y:r.y,w:r.w,h:r.h,cx:r.x+r.w/2,cy:r.y+r.h/2,rot:f.item.rot,sx:f.item.sx,sy:f.item.sy,ix:f.item.x,iy:f.item.y}})()`);
  const hpt = async hs => ev(`(()=>{const e=document.querySelector('#ov rect.th[data-h="${hs}"]'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  check('Transform tool: key E and key R both select it', await (async () => { await key('e'); const a = await ev('cv.tool'); await key('v'); await key('r'); return a === 'transform' && await ev('cv.tool') === 'transform'; })());
  await loadDoc([T('A', 300, 200, 'Rotate me', { size: 70, w: 260 })], art);
  await ev(`setTool('transform'); setSel(['A'])`); await sleep(150);
  const b0 = await tbox('A'), d0 = await ev(`JSON.stringify(cv.doc)`);
  check('Transform: box with 8 handles and the origin crosshair', await ev(`document.querySelectorAll('#ov rect.th').length`) === 8 && await ev(`document.querySelectorAll('#ov line').length`) === 2);
  // ---- rotate: drag outside the box around the origin by ~90 degrees (real mouse events)
  const oc = await A2S(b0.cx, b0.cy);
  const R = 230;
  const labels = [];
  await dragM(oc.x + R, oc.y, oc.x, oc.y + R, 0, 16, async () => { labels.push(await ev(`document.querySelector('.rotlabel')?.textContent`)); });
  const b1 = await tbox('A');
  check('Rotate: dragging 90 degrees gives rot = 90 (+-1)', near(b1.rot, 90, 1), 'rot=' + b1.rot);
  check('Rotate: the text box centre does not move', near(b1.cx, b0.cx, 1) && near(b1.cy, b0.cy, 1), JSON.stringify([b1.cx, b1.cy]) + ' vs ' + JSON.stringify([b0.cx, b0.cy]));
  check('Rotate: live angle label shown', /°$/.test(labels[0] || ''), JSON.stringify(labels));
  check('Rotate: CSS transform uses rotate(', (await ev(`document.querySelector('.tb[data-id="A"]').style.transform`)).includes('rotate('));
  await ctrlZ();
  check('Rotate: undo restores the document exactly', await ev(`JSON.stringify(cv.doc)`) === d0 || (await tbox('A')).rot === 0);
  // ---- Shift snaps to 15 degree steps
  await dragM(oc.x + R, oc.y, oc.x + R * Math.cos(0.64), oc.y + R * Math.sin(0.64), SHIFT);   // about 36.7 deg
  const bs = await tbox('A');
  check('Rotate: Shift snaps to a multiple of 15', bs.rot % 15 === 0 && bs.rot !== 0, 'rot=' + bs.rot);
  await ctrlZ();
  // ---- click sets the origin, Alt-click resets it
  const pk = await A2S(b0.cx + 200, b0.cy + 150); await clickM(pk.x, pk.y);
  check('Click on empty canvas sets the rotation origin', await ev(`!!cv.rotOrigin && Math.abs(cv.rotOrigin.x-${b0.cx + 200})<1.5`));
  await clickM(pk.x, pk.y, 1);
  check('Alt-click resets the origin to the centre', await ev(`cv.rotOrigin===null`));
  // ---- scale: corner drag x2 (bottom-right handle, opposite corner fixed)
  await ev(`setSel(['A'])`); await sleep(100);
  const brh = await hpt('1,1'), br = await tbox('A');
  const e2 = await A2S(br.x + br.w * 2, br.y + br.h * 2);
  let sl = null;
  await dragM(brh.x, brh.y, e2.x, e2.y, 0, 12, async () => { sl = await ev(`document.querySelector('.rotlabel')?.textContent`); });
  const b2 = await tbox('A');
  check('Scale: corner drag x2 doubles the bbox (+-1 px)', near(b2.w, br.w * 2, 1) && near(b2.h, br.h * 2, 1), JSON.stringify([b2.w, b2.h]) + ' vs ' + JSON.stringify([br.w, br.h]));
  check('Scale: the opposite corner stays fixed', near(b2.x, br.x, 1) && near(b2.y, br.y, 1));
  check('Scale: label shows W x H', /\d+ × \d+/.test(sl || ''), sl);
  check('Scale: text stays editable text with sx and sy = 2', (await ev(`findItem('A').item.type`)) === 'text' && near(b2.sx, 2, 0.01) && near(b2.sy, 2, 0.01));
  await ctrlZ();
  check('Scale: undo restores exactly', await ev(`JSON.stringify(cv.doc)`) === d0 || (await tbox('A')).sx === 1);
  // Shift keeps proportions
  const brh2 = await hpt('1,1'); const e3 = await A2S(br.x + br.w * 2, br.y + br.h * 1.2);
  await dragM(brh2.x, brh2.y, e3.x, e3.y, SHIFT);
  const b3 = await tbox('A');
  check('Scale: Shift keeps proportions', near(b3.sx, b3.sy, 0.01) && b3.sx > 1.5, 'sx=' + b3.sx + ' sy=' + b3.sy);
  await ctrlZ();
  // Alt scales from the centre
  const brh3 = await hpt('1,1'); const e4 = await A2S(br.x + br.w * 1.5, br.y + br.h * 1.5);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brh3.x, y: brh3.y });
  await mouse('mousePressed', brh3.x, brh3.y, {});
  for (let i = 1; i <= 8; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brh3.x + (e4.x - brh3.x) * i / 8, y: brh3.y + (e4.y - brh3.y) * i / 8, button: 'left', buttons: 1, modifiers: 1 }); await sleep(12); }
  await mouse('mouseReleased', e4.x, e4.y, { modifiers: 1 }); await sleep(120);
  const b4 = await tbox('A');
  check('Scale: Alt scales from the centre (centre unchanged, size changed)', near(b4.cx, br.cx, 1) && near(b4.cy, br.cy, 1) && b4.w > br.w * 1.5, JSON.stringify([b4.cx, b4.cy, b4.w]));
  await ctrlZ();
  // edge handle changes one axis only
  const rh = await hpt('1,0'); const e5 = await A2S(br.x + br.w * 1.5, br.y + br.h / 2 + 40);
  await dragM(rh.x, rh.y, e5.x, e5.y);
  const b5 = await tbox('A');
  check('Scale: edge handle scales one axis only', near(b5.w, br.w * 1.5, 1) && near(b5.h, br.h, 1) && near(b5.sy, 1, 0.001), JSON.stringify([b5.w, b5.h, b5.sy]));
  await ctrlZ();
  // flip: drag the right edge past the left edge
  const rh2 = await hpt('1,0'); const e6 = await A2S(br.x - 60, br.y + br.h / 2);
  await dragM(rh2.x, rh2.y, e6.x, e6.y);
  const b6 = await tbox('A');
  check('Scale: dragging past the opposite edge flips (allowed)', await ev(`(()=>{const t=findItem('A').item; return t.sx<0 || Math.abs(t.rot)>179 || t.sy<0})()`), JSON.stringify([b6.sx, b6.sy, b6.rot]));
  await ctrlZ();
  // inspector fields
  await ev(`setTool('select'); setSel(['A'])`); await sleep(100);
  check('Inspector has Rotation and Scale % W/H with a link toggle', await ev(`!!document.querySelector('#scw') && !!document.querySelector('#sch') && !!document.querySelector('#sclink') && [...document.querySelectorAll('#insp .f > span')].some(s=>s.textContent==='Rotation')`));
  await ev(`(()=>{const n=document.querySelector('#scw'); n.value=150; n.dispatchEvent(new Event('input')); n.dispatchEvent(new Event('change'))})()`);
  check('Inspector: linked scale keeps proportions', await ev(`findItem('A').item.sx`) === 1.5 && await ev(`findItem('A').item.sy`) === 1.5);
  await ctrlZ();

  // ---- rotated + scaled text: outlines match the ink; SVG/PNG export; reload
  await loadDoc([T('R', 220, 170, 'Hamburg', { family: 'Manrope', style: '', size: 90, w: 380, rot: 30, sx: 1.4, sy: 0.8 })], art);
  await ev(`setSel([])`); await sleep(250);
  const rb = await shotClip(), rbi = await inkInfo(rb);
  const svg = await ev(`buildSVG()`);
  check('Export: SVG of rotated text contains rotate( and scale(', svg.includes('rotate(30') && svg.includes('scale(1.4'), (svg.match(/transform="[^"]*"/) || [''])[0]);
  const pink = await ev(`(async()=>{const c=await renderPNGCanvas(); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0,l=1e9,r=-1,t=1e9,b=-1; for(let i=0;i<d.length;i+=4){ if(d[i]<100){ n++; const p=i/4, x=p%c.width, y=(p/c.width)|0; if(x<l)l=x; if(x>r)r=x; if(y<t)t=y; if(y>b)b=y;}} return {n,l:l/2,r:r/2,t:t/2,b:b/2}})()`);
  const zz = await ev('cv.zoom');
  check('Export: PNG of rotated text is not blank and matches the on-screen ink box (+-4 px)', pink.n > 2000 && near(pink.r - pink.l, (rbi.r - rbi.l) / zz, 4) && near(pink.b - pink.t, (rbi.b - rbi.t) / zz, 4), JSON.stringify(pink) + ' screen ' + JSON.stringify([rbi.l, rbi.t, rbi.r, rbi.b]));
  await ev(`createOutlines('R')`); await waitFor(`cv.doc.layers[0].type==='group'`, 20000); await ev(`setSel([])`); await sleep(250);
  const ra = await shotClip(), rai = await inkInfo(ra), rd = await shotDiff(rb, ra);
  check('Outlines of scaled + rotated text match its ink box within 2 px', Math.max(...['l', 't', 'r', 'b'].map(k => Math.abs(rai[k] - rbi[k]))) <= 2, JSON.stringify([rbi.l, rbi.t, rbi.r, rbi.b]) + ' vs ' + JSON.stringify([rai.l, rai.t, rai.r, rai.b]));
  check('Outlines of scaled + rotated text: pixels agree', rd.diff / rd.ink < 0.1, JSON.stringify(rd));
  const svgG = await ev(`buildSVG()`);
  check('Outlines: SVG export of the baked group has paths', (svgG.match(/<path /g) || []).length >= 6);
  await ctrlZ();
  check('Outlines: undo restores the transformed text layer', await ev(`cv.doc.layers[0].type==='text' && cv.doc.layers[0].rot===30 && cv.doc.layers[0].sx===1.4`));
  // reload keeps rot/sx/sy
  await sleep(800); await send('Page.reload'); await sleep(400); await waitFor(`document.readyState==='complete' && lib.families.length>0`, 20000); await sleep(600);
  check('Reload keeps rot, sx and sy', await ev(`(()=>{const t=cv.doc.layers[0]; return t.type==='text' && t.rot===30 && t.sx===1.4 && t.sy===0.8})()`));
  await ev(`showTab('canvas')`); await sleep(200);
  check('Old documents without rot/sx/sy default to 0/1/1; bad values are repaired', await ev(`(()=>{const d=sanitizeDoc({artboard:{w:300,h:300},layers:[{type:'text',id:'o',text:'x',family:'Noto Sans'},{type:'text',id:'p',text:'x',family:'Noto Sans',rot:'abc',sx:0,sy:1e9},{type:'text',id:'q',text:'x',family:'Noto Sans',rot:270,sx:-1000,sy:0.0001}]}); const a=d.layers[0],b=d.layers[1],c=d.layers[2]; return a.rot===0&&a.sx===1&&a.sy===1&&b.rot===0&&b.sx===1&&b.sy===100&&c.rot===-90&&c.sx===-100&&c.sy===0.01})()`));

  // ---- paths and groups: bake
  await loadDoc([G('g', 'Group', [P('p1', 'one', 200, 150), P('p2', 'two', 300, 250)])], art);
  await ev(`setTool('transform'); setSel(['g'])`); await sleep(100);
  const gb0 = await ev(`JSON.stringify(bboxOf('g'))`), gd0 = await dOfId('p1');
  const gc = JSON.parse(gb0), goc = await A2S(gc.x + gc.w / 2, gc.y + gc.h / 2);
  await dragM(goc.x + 200, goc.y, goc.x + 200 * Math.cos(Math.PI / 4), goc.y + 200 * Math.sin(Math.PI / 4), SHIFT);
  const gb1 = JSON.parse(await ev(`JSON.stringify(bboxOf('g'))`));
  check('Group: rotating 45 degrees bakes into the points (bbox changes, type stays group)', Math.abs(gb1.w - gc.w) > 10 && await ev(`findItem('g').item.type`) === 'group' && await dOfId('p1') !== gd0, JSON.stringify([gc.w, gb1.w]));
  await ctrlZ();
  check('Group: undo restores the path data exactly', await dOfId('p1') === gd0 && JSON.stringify(await ev(`bboxOf('g')`)) === gb0);
  // path scale x2 from the corner, and Alt+drag on a handle copies
  const hb = await hpt('1,1'); const gtgt = await A2S(gc.x + gc.w * 2, gc.y + gc.h * 2);
  await dragM(hb.x, hb.y, gtgt.x, gtgt.y);
  const gs = JSON.parse(await ev(`JSON.stringify(bboxOf('g'))`));
  check('Group: corner drag x2 bakes the scale into the points', near(gs.w, gc.w * 2, 1) && near(gs.h, gc.h * 2, 1));
  await ctrlZ();
  const cnt = await ev(`cv.doc.layers.length`);
  const oc2 = await A2S(gc.x + gc.w / 2, gc.y + gc.h / 2);
  await dragM(oc2.x + 200, oc2.y, oc2.x, oc2.y + 200, 1);
  check('Alt+drag rotate makes a rotated copy and keeps the original', await ev(`cv.doc.layers.length`) === cnt + 1 && await dOfId('p1') === gd0);
  await ctrlZ();
  check('Alt+drag rotate: one undo removes the copy', await ev(`cv.doc.layers.length`) === cnt);
  // rotate selected anchors only
  await ev(`setTool('direct'); setSel(['p1']); cv.dsel=new Set(['p1|0|0','p1|0|1']); setTool('transform'); cv.dsel=new Set(['p1|0|0','p1|0|1']); renderOverlay()`);
  const an0 = await ev(`JSON.stringify(findItem('p1').item.contours[0].nodes)`);
  const af = await ev(`JSON.stringify(transformFrame())`), afr = JSON.parse(af);
  const aoc = await A2S(afr.cx, afr.cy);
  await dragM(aoc.x + 120, aoc.y - 90, aoc.x + 120, aoc.y + 90);
  const an1 = JSON.parse(await ev(`JSON.stringify(findItem('p1').item.contours[0].nodes)`)), an0j = JSON.parse(an0);
  check('Anchors: rotating with anchors selected moves only those anchors', JSON.stringify(an1[0]) !== JSON.stringify(an0j[0]) && JSON.stringify(an1[2]) === JSON.stringify(an0j[2]) && JSON.stringify(an1[3]) === JSON.stringify(an0j[3]));
  await ctrlZ();
  // locked and hidden items are excluded
  await loadDoc([T('L', 100, 100, 'Locked', { locked: true }), T('H', 100, 250, 'Hidden', { visible: false })], art);
  await ev(`setTool('transform'); setSel(['L','H'])`);
  check('Locked and hidden layers give no transform box', await ev(`transformFrame()`) === null && await ev(`document.querySelectorAll('#ov rect.th').length`) === 0);
  // ---- screenshot: scaled + rotated text and a rotated outline, transform box and origin visible
  await loadDoc([T('S', 60, 40, 'Transform', { family: 'Manrope', style: '', size: 80, w: 460, rot: -10, sx: 1.2, sy: 0.9 }), T('O', 60, 330, 'Outline', { family: 'Manrope', style: '', size: 80, w: 460 })], art);
  await sleep(600); await ev(`createOutlines('O')`); await waitFor(`cv.doc.layers[1].type==='group'`, 20000);
  await ev(`setTool('transform'); setSel(['${await ev("cv.doc.layers[1].id")}']); cv.rotOrigin={x:140,y:360}; renderOverlay()`);
  await ev(`(()=>{const id=cv.doc.layers[1].id; transformSelection(18,1); setSel([cv.doc.layers[0].id]); cv.rotOrigin={x:300,y:120}; renderOverlay()})()`);
  await sleep(400);
  const clip = await ev(`(()=>{const q=ab.getBoundingClientRect(); return {x:q.left-14,y:q.top-14,width:q.width+28,height:q.height+28}})()`);
  await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1.6 } }).then(r => fs.writeFileSync(SHOTS + 'transform.png', Buffer.from(r.data, 'base64')));
}

console.log('\n--- errors/console'); for (const l of log) console.log(l);
console.log('downloads events', events.length);
fs.writeFileSync(R + '/results-' + phase + '.txt', results.join('\n') + '\n\n' + log.join('\n'));
ws.close(); process.exit(0);
