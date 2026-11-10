'use strict';
/* Typecase canvas, part 2: layers, vector paths, tools, direct selection, outlines.
   Loaded after app.js. Document model: cv.doc.layers is the z-order (last = frontmost).
   Layer types: text, group (children are paths), path (contours of nodes with optional bezier handles). */
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };
const isVec = l => l && (l.type === 'group' || l.type === 'path');
const pathsOf = l => l.type === 'group' ? l.children : l.type === 'path' ? [l] : [];
const deep = o => JSON.parse(JSON.stringify(o));
const fmt = n => +(+n).toFixed(2);

/* ---------------------------------------------------------------- lookup */
function findItem(id) {
  const L = cv.doc.layers;
  for (let i = 0; i < L.length; i++) {
    if (L[i].id === id) return { item: L[i], parent: null, list: L, index: i, top: L[i] };
    if (L[i].type === 'group') for (let k = 0; k < L[i].children.length; k++) if (L[i].children[k].id === id) return { item: L[i].children[k], parent: L[i], list: L[i].children, index: k, top: L[i] };
  }
  return null;
}
const layerLabel = l => l.name || (l.type === 'text' ? (l.text || '').split('\n')[0].slice(0, 40) || 'Text' : l.type === 'group' ? 'Group' : 'Path');
const isLocked = id => { const f = findItem(id); return !f || f.top.locked || f.item.locked; };

/* ---------------------------------------------------------------- selection */
function setSel(ids, primary) {
  cv.selSet = ids.filter(id => findItem(id));
  cv.sel = cv.selSet.includes(primary) ? primary : (cv.selSet[cv.selSet.length - 1] || null);
  cv.dsel = new Set(); cv.rotOrigin = null;
  refreshSel();
}
function refreshSel() {
  ab.querySelectorAll('.tb').forEach(e => e.classList.toggle('sel', cv.selSet.includes(e.dataset.id)));
  renderOverlay(); renderInsp(); renderLayers(); updBtns();
}
const select = id => setSel(id ? [id] : []);
function setTool(t) {
  cv.tool = t;
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('#cv-scroll').dataset.tool = t;
  cv.dsel = new Set(); cv.rotOrigin = null; renderOverlay();
}
document.querySelectorAll('#tools button').forEach(b => b.onclick = () => setTool(b.dataset.tool));

/* ---------------------------------------------------------------- paths */
function contoursToD(cs) {
  let d = '';
  for (const c of cs) {
    const n = c.nodes; if (!n.length) continue;
    d += 'M' + fmt(n[0].x) + ' ' + fmt(n[0].y);
    const seg = (a, b) => {
      if (a.o || b.i) { const o = a.o || [a.x, a.y], i = b.i || [b.x, b.y]; d += 'C' + fmt(o[0]) + ' ' + fmt(o[1]) + ' ' + fmt(i[0]) + ' ' + fmt(i[1]) + ' ' + fmt(b.x) + ' ' + fmt(b.y); }
      else d += 'L' + fmt(b.x) + ' ' + fmt(b.y);
    };
    for (let k = 1; k < n.length; k++) seg(n[k - 1], n[k]);
    if (c.closed) { seg(n[n.length - 1], n[0]); d += 'Z'; }
  }
  return d;
}
/* Parse the absolute M/L/Q/C/Z path string from HarfBuzz into contours. Quadratics become cubics so every curve has two handles. */
function parseGlyphPath(d, tx) {
  const toks = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const contours = []; let cur = null, k = 0;
  const num = () => +toks[k++];
  const P = () => { const x = num(), y = num(); return tx(x, y); };
  const node = (p, i) => ({ x: p[0], y: p[1], i: i || null, o: null });
  const last = () => cur.nodes[cur.nodes.length - 1];
  while (k < toks.length) {
    const c = toks[k++];
    if (c === 'M') { cur = { closed: false, nodes: [] }; contours.push(cur); cur.nodes.push(node(P())); }
    else if (!cur) continue;
    else if (c === 'L') cur.nodes.push(node(P()));
    else if (c === 'Q') {
      const q = P(), p = P(), a = last();
      a.o = [a.x + 2 / 3 * (q[0] - a.x), a.y + 2 / 3 * (q[1] - a.y)];
      cur.nodes.push(node(p, [p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1])]));
    } else if (c === 'C') {
      const c1 = P(), c2 = P(), p = P(); last().o = c1; cur.nodes.push(node(p, c2));
    } else if (c === 'Z') {
      const f = cur.nodes[0], l = last();
      if (cur.nodes.length > 1 && Math.abs(f.x - l.x) < 0.01 && Math.abs(f.y - l.y) < 0.01) { f.i = l.i; cur.nodes.pop(); }
      cur.closed = true;
    }
  }
  return contours.filter(c => c.nodes.length > 1);
}
function translateContours(cs, dx, dy) {
  const mv = p => p ? [p[0] + dx, p[1] + dy] : null;
  return cs.map(c => ({ closed: c.closed, nodes: c.nodes.map(n => ({ x: n.x + dx, y: n.y + dy, i: mv(n.i), o: mv(n.o) })) }));
}
function cloneItem(it) {
  const c = deep(it); c.id = uid();
  if (c.type === 'group') { c.children = c.children.filter(ch => !ch.locked); c.children.forEach(ch => { ch.id = uid(); }); }   /* locked paths are not copied */
  return c;
}
function constrain(dx, dy) {          /* Shift: snap the drag direction to 0, 45 or 90 degrees */
  const r = Math.hypot(dx, dy); if (!r) return [0, 0];
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [r * Math.cos(a), r * Math.sin(a)];
}
function applyOffset(target, snapIt, dx, dy) {
  if (target.type === 'text') { target.x = Math.round(snapIt.x + dx); target.y = Math.round(snapIt.y + dy); }
  else if (target.type === 'path') target.contours = translateContours(snapIt.contours, dx, dy);
  else target.children.forEach((c, i) => { if (!c.locked && snapIt.children[i]) c.contours = translateContours(snapIt.children[i].contours, dx, dy); });   /* a locked path stays where it is */
}

/* ---------------------------------------------------------------- vector elements */
function pathEl(p, gid) {
  const e = sv('path', { d: contoursToD(p.contours), fill: okColor(p.fill, '#111111'), 'fill-opacity': num_(p.op, 1), 'data-pid': p.id, 'data-gid': gid });
  if (p.visible === false) e.style.display = 'none';
  if (p.locked) e.setAttribute('class', 'locked');
  return e;
}
function vecEl(l) {
  const a = cv.doc.artboard;
  const svg = sv('svg', { class: 'vl', 'data-id': l.id, width: a.w, height: a.h, viewBox: '0 0 ' + a.w + ' ' + a.h });
  const g = sv('g'); svg.append(g);
  for (const p of pathsOf(l)) g.append(pathEl(p, l.id));
  svg.style.display = l.visible === false ? 'none' : '';
  if (l.locked) svg.classList.add('locked');
  if (l.locked) g.querySelectorAll('path').forEach(p => p.setAttribute('class', 'locked'));
  return svg;
}
function refreshEl(top) {
  if (top.type === 'text') { renderBoxEl(top); return; }
  const old = ab.querySelector('svg.vl[data-id="' + CSS.escape(top.id) + '"]'); if (!old) return;
  const g = old.firstChild, ps = pathsOf(top);
  if (g.children.length !== ps.length) { old.replaceWith(vecEl(top)); return; }
  ps.forEach((p, i) => g.children[i].setAttribute('d', contoursToD(p.contours)));
}
function bboxOf(id) {                    /* artboard-space rectangle of a layer or child path */
  const f = findItem(id); if (!f) return null;
  if (f.item.type === 'text') {
    const el = ab.querySelector('.tb[data-id="' + CSS.escape(id) + '"]'); if (!el) return null;
    const fr = textFrame(f.item, el); const cs = frameCorners(fr).map(c => c.p);
    const x0 = Math.min(...cs.map(c => c[0])), x1 = Math.max(...cs.map(c => c[0])), y0 = Math.min(...cs.map(c => c[1])), y1 = Math.max(...cs.map(c => c[1]));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  let el = f.item.type === 'path' && f.parent ? ab.querySelector('path[data-pid="' + CSS.escape(id) + '"]') : (ab.querySelector('svg.vl[data-id="' + CSS.escape(id) + '"] > g'));
  if (!el) return null;
  try { const b = el.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (e) { return null; }
}
const unionRect = rs => { rs = rs.filter(Boolean); if (!rs.length) return null; const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y)), x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h)); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };

/* ---------------------------------------------------------------- transform geometry */
const deg2 = a => a * Math.PI / 180;
const rotV = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };
/* A frame is a box with centre, half sizes and an angle; handles sit on its edges */
function textFrame(b, el) { const t = tfOf(b), w = el.offsetWidth, h = el.offsetHeight; return { cx: b.x + w / 2, cy: b.y + h / 2, hw: w / 2 * Math.abs(t.sx), hh: h / 2 * Math.abs(t.sy), ang: deg2(t.r) }; }
const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
function frameCorners(fr) { return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([hx, hy]) => { const v = rotV(hx * fr.hw, hy * fr.hh, fr.ang); return { hx, hy, p: [fr.cx + v[0], fr.cy + v[1]] }; }); }
const handlePt = (fr, hx, hy) => { const v = rotV(hx * fr.hw, hy * fr.hh, fr.ang); return [fr.cx + v[0], fr.cy + v[1]]; };
function selectedAnchorPts() {
  const pts = [];
  for (const k of cv.dsel) { const [id, c, n] = k.split('|'), f = findItem(id); if (!f || isLocked(id) || f.item.type !== 'path') continue; const nd = f.item.contours[c] && f.item.contours[c].nodes[n]; if (nd) pts.push([nd.x, nd.y]); }
  return pts;
}
function transformFrame() {
  if (cv.dsel.size) {
    const pts = selectedAnchorPts(); if (!pts.length) return null;
    const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
    return { kind: 'anchors', cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: Math.max(0.5, (x1 - x0) / 2), hh: Math.max(0.5, (y1 - y0) / 2), ang: 0, ids: [] };
  }
  const ids = topMovers(cv.selSet); if (!ids.length) return null;
  if (ids.length === 1) { const f = findItem(ids[0]); if (f.item.type === 'text') { const el = ab.querySelector('.tb[data-id="' + CSS.escape(ids[0]) + '"]'); if (el) return Object.assign({ kind: 'items', ids }, textFrame(f.item, el)); } }
  const r = unionRect(ids.map(bboxOf)); if (!r) return null;
  return { kind: 'items', cx: r.x + r.w / 2, cy: r.y + r.h / 2, hw: Math.max(0.5, r.w / 2), hh: Math.max(0.5, r.h / 2), ang: 0, ids };
}
const rotOrigin = () => { if (cv.rotOrigin) return cv.rotOrigin; const f = transformFrame(); return f ? { x: f.cx, y: f.cy } : null; };
/* affine map about a pivot: p' = P + A (p - P), A = [a, b, c, d] meaning x' = a x + c y, y' = b x + d y */
const affPt = (x, y, P, A) => [P.x + A[0] * (x - P.x) + A[2] * (y - P.y), P.y + A[1] * (x - P.x) + A[3] * (y - P.y)];
function affContours(cs, P, A) {
  const f = p => p ? affPt(p[0], p[1], P, A) : null;
  return cs.map(k => ({ closed: k.closed, nodes: k.nodes.map(n => { const q = affPt(n.x, n.y, P, A); return { x: q[0], y: q[1], i: f(n.i), o: f(n.o) }; }) }));
}
const clampS = v => Math.sign(v || 1) * Math.min(100, Math.max(0.01, Math.abs(v)));
function affText(b, snap, P, A) {            /* keeps text editable: new centre, rotation and scale from the transformed local axes */
  const r0 = deg2(snap.rot || 0), sx0 = snap.sx || 1, sy0 = snap.sy || 1;
  const c0 = affPt(snap._cx, snap._cy, P, A);
  const ux = rotV(1, 0, r0), uy = rotV(0, 1, r0);
  const c1 = [A[0] * ux[0] * sx0 + A[2] * ux[1] * sx0, A[1] * ux[0] * sx0 + A[3] * ux[1] * sx0], c2 = [A[0] * uy[0] * sy0 + A[2] * uy[1] * sy0, A[1] * uy[0] * sy0 + A[3] * uy[1] * sy0];
  const l1 = Math.hypot(c1[0], c1[1]) || 1e-6, r1 = Math.atan2(c1[1], c1[0]), perp = [-Math.sin(r1), Math.cos(r1)];
  b.sx = +clampS(l1).toFixed(4); b.sy = +clampS(c2[0] * perp[0] + c2[1] * perp[1]).toFixed(4); b.rot = +normDeg(r1 * 180 / Math.PI).toFixed(3);
  b.x = +(c0[0] - snap._w / 2).toFixed(2); b.y = +(c0[1] - snap._h / 2).toFixed(2);
}
function affApply(target, snap, P, A) {
  if (target.type === 'text') affText(target, snap, P, A);
  else if (target.type === 'path') target.contours = affContours(snap.contours, P, A);
  else target.children.forEach((c, i) => { if (!c.locked && snap.children[i]) c.contours = affContours(snap.children[i].contours, P, A); });
}
const snapOf = id => { const f = findItem(id), s = deep(f.item); if (s.type === 'text') { const el = ab.querySelector('.tb[data-id="' + CSS.escape(id) + '"]'); s._w = el.offsetWidth; s._h = el.offsetHeight; s._cx = s.x + s._w / 2; s._cy = s.y + s._h / 2; } return s; };
const rotMat = a => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a)];
/* rotate or scale the current selection (inspector fields); angle in degrees, k = scale factor */
function transformSelection(angDeg, k) {
  const fr = transformFrame(); if (!fr) return;
  const P = rotOrigin(), ids = fr.ids, tops = new Set();
  const A = angDeg ? rotMat(deg2(angDeg)) : [k, 0, 0, k];
  for (const id of ids) { const sn = snapOf(id), f = findItem(id); affApply(f.item, sn, P, A); tops.add(f.top); }
  tops.forEach(refreshEl); renderAll(); commit();
}

/* ---------------------------------------------------------------- overlay: selection bounds, anchors, handles */
function makeOverlay() { const a = cv.doc.artboard; return sv('svg', { id: 'ov', width: a.w, height: a.h, viewBox: '0 0 ' + a.w + ' ' + a.h }); }
function renderOverlay() {
  const ov = $('#ov'); if (!ov) return;
  ov.replaceChildren();
  const s = 1 / cv.zoom, accent = '#7aa2f7';
  for (const id of cv.selSet) {
    const f = findItem(id); if (!f || f.item.type === 'text' || f.top.visible === false) continue;
    const r = bboxOf(id); if (!r) continue;
    ov.append(sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'none', stroke: accent, 'stroke-width': s }));
  }
  if (cv.tool === 'transform') {
    const fr = transformFrame();
    if (fr) {
      const cs = frameCorners(fr).map(c => c.p.join(',')).join(' ');
      ov.append(sv('polygon', { points: cs, fill: 'none', stroke: accent, 'stroke-width': s }));
      const z = 8 * s;
      HANDLES.forEach(([hx, hy]) => {
        const q = handlePt(fr, hx, hy);
        const hd = sv('rect', { x: q[0] - z / 2, y: q[1] - z / 2, width: z, height: z, class: 'th', 'stroke-width': s, 'data-h': hx + ',' + hy, transform: 'rotate(' + fr.ang * 180 / Math.PI + ' ' + q[0] + ' ' + q[1] + ')' });
        hd.style.cursor = (hx && hy ? (hx * hy > 0 ? 'nwse-resize' : 'nesw-resize') : hx ? 'ew-resize' : 'ns-resize');
        hd.addEventListener('pointerdown', e => startTransform(e, 'scale', hx, hy));
        ov.append(hd);
      });
      const o = rotOrigin(), L = 9 * s;
      ov.append(sv('line', { x1: o.x - L, y1: o.y, x2: o.x + L, y2: o.y, stroke: '#ff4fa0', 'stroke-width': 1.5 * s }), sv('line', { x1: o.x, y1: o.y - L, x2: o.x, y2: o.y + L, stroke: '#ff4fa0', 'stroke-width': 1.5 * s }), sv('circle', { cx: o.x, cy: o.y, r: 4 * s, fill: 'none', stroke: '#ff4fa0', 'stroke-width': 1.5 * s }));
    }
    return;
  }
  if (cv.tool !== 'direct') return;
  for (const id of cv.selSet) {
    const f = findItem(id); if (!f || f.item.type !== 'path' || f.top.visible === false) continue;
    const p = f.item;
    if (isLocked(id)) continue;                 /* locked items show no anchors */
    ov.append(sv('path', { d: contoursToD(p.contours), fill: 'none', stroke: accent, 'stroke-width': s }));
    const z = 7 * s;
    p.contours.forEach((c, ci) => c.nodes.forEach((n, ni) => {
      const key = p.id + '|' + ci + '|' + ni, on = cv.dsel.has(key);
      if (on) for (const w of ['i', 'o']) if (n[w]) {
        ov.append(sv('line', { x1: n.x, y1: n.y, x2: n[w][0], y2: n[w][1], stroke: accent, 'stroke-width': s }));
        const hd = sv('circle', { cx: n[w][0], cy: n[w][1], r: 3.5 * s, class: 'hd', 'stroke-width': s, 'data-key': key, 'data-w': w });
        hd.addEventListener('pointerdown', e => nodeDown(e, p.id, ci, ni, w));
        ov.append(hd);
      }
    }));
    p.contours.forEach((c, ci) => c.nodes.forEach((n, ni) => {
      const key = p.id + '|' + ci + '|' + ni;
      const a = sv('rect', { x: n.x - z / 2, y: n.y - z / 2, width: z, height: z, class: 'anc' + (cv.dsel.has(key) ? ' sel' : ''), 'stroke-width': s, 'data-key': key });
      a.addEventListener('pointerdown', e => nodeDown(e, p.id, ci, ni, null));
      ov.append(a);
    }));
  }
}

/* anchor and handle dragging */
function nodeDown(e, pid, ci, ni, which) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  if (isLocked(pid)) return;
  const key = pid + '|' + ci + '|' + ni;
  if (!which) {
    if (e.shiftKey) { cv.dsel.has(key) ? cv.dsel.delete(key) : cv.dsel.add(key); renderOverlay(); if (!cv.dsel.has(key)) return; }
    else if (!cv.dsel.has(key)) { cv.dsel = new Set([key]); renderOverlay(); }
  }
  const f = findItem(pid); if (!f) return;
  const p0 = artPoint(e);
  const snaps = new Map();        /* pid -> deep copy of contours */
  const keys = (which ? [key] : [...cv.dsel]).filter(k => !isLocked(k.split('|')[0]));
  for (const k of keys) { const id = k.split('|')[0]; if (!snaps.has(id)) snaps.set(id, deep(findItem(id).item.contours)); }
  /* a smooth point has two handles on one straight line, on opposite sides of the anchor */
  const sn0 = which ? snaps.get(pid)[ci].nodes[ni] : null;
  let smooth = false;
  if (sn0 && sn0.i && sn0.o) {
    const v1 = [sn0.i[0] - sn0.x, sn0.i[1] - sn0.y], v2 = [sn0.o[0] - sn0.x, sn0.o[1] - sn0.y], l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    smooth = l1 > 0.01 && l2 > 0.01 && Math.abs(v1[0] * v2[1] - v1[1] * v2[0]) <= 0.02 * l1 * l2 && v1[0] * v2[0] + v1[1] * v2[1] < 0;
  }
  let moved = false;
  const move = ev => {
    const p = artPoint(ev); let dx = p.x - p0.x, dy = p.y - p0.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true; if (!moved) return;
    if (ev.shiftKey) [dx, dy] = constrain(dx, dy);
    for (const k of keys) {
      const [id, c, n] = k.split('|'), it = findItem(id).item, sn = snaps.get(id)[c].nodes[n], node = it.contours[c].nodes[n];
      if (which) {
        node[which] = [sn[which][0] + dx, sn[which][1] + dy];
        const other = which === 'i' ? 'o' : 'i';
        if (sn[other]) {
          if (smooth && !ev.altKey) {        /* keep the pair on one line, and keep the other handle's length */
            const v = [node[which][0] - sn.x, node[which][1] - sn.y], vl = Math.hypot(...v), len = Math.hypot(sn[other][0] - sn.x, sn[other][1] - sn.y);
            if (vl > 0.001) node[other] = [sn.x - v[0] / vl * len, sn.y - v[1] / vl * len];
          } else node[other] = [sn[other][0], sn[other][1]];       /* Alt breaks the pair: the other handle stays */
        }
      } else { node.x = sn.x + dx; node.y = sn.y + dy; if (sn.i) node.i = [sn.i[0] + dx, sn.i[1] + dy]; if (sn.o) node.o = [sn.o[0] + dx, sn.o[1] + dy]; }
    }
    for (const id of snaps.keys()) refreshEl(findItem(id).top);
    renderOverlay();
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (moved) commit();
    else if (!which && !e.shiftKey && cv.dsel.size > 1) { cv.dsel = new Set([key]); renderOverlay(); }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

/* ---------------------------------------------------------------- canvas pointer handling */
let altDown = false;
const setAlt = v => { altDown = v; ab.classList.toggle('copy', v); };
document.addEventListener('keydown', e => { if (e.key === 'Alt') setAlt(true); });
document.addEventListener('keyup', e => { if (e.key === 'Alt') setAlt(false); });
window.addEventListener('blur', () => setAlt(false));
ab.addEventListener('pointermove', e => { if (e.altKey !== altDown) setAlt(e.altKey); });

function topMovers(ids) {            /* selected items to move: not locked, not hidden, and not a child whose group is also selected */
  const out = [];
  for (const id of ids) {
    const f = findItem(id); if (!f || f.top.locked || f.item.locked || f.top.visible === false || f.item.visible === false) continue;
    if (f.parent && ids.includes(f.parent.id)) continue;
    out.push(id);
  }
  return out;
}
function showGuides(sx, sy) { const gv = $('#gv'), gh = $('#gh'); if (gv) gv.style.display = sx ? 'block' : 'none'; if (gh) gh.style.display = sy ? 'block' : 'none'; }

ab.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('#ov .anc, #ov .hd')) return;
  if (cv.editing) {
    const el = ab.querySelector('[data-id="' + CSS.escape(cv.editing) + '"]');
    if (el && el.contains(e.target)) return;
    document.activeElement.blur();
  }
  const t = e.target, p0 = artPoint(e);
  const tbEl = t.closest('.tb'), vp = t.closest('path[data-pid]');
  if (cv.tool === 'text') {
    e.preventDefault();
    if (tbEl) { setSel([tbEl.dataset.id]); setTimeout(() => beginEdit(tbEl.dataset.id), 10); return; }
    const b = addBox(null, { x: Math.round(p0.x), y: Math.round(p0.y) }); setTimeout(() => beginEdit(b.id), 20);
    return;
  }
  if (cv.tool === 'transform') {
    const fr = transformFrame();
    if (fr) {
      const lp = rotV(p0.x - fr.cx, p0.y - fr.cy, -fr.ang), ax = Math.abs(lp[0]) - fr.hw, ay = Math.abs(lp[1]) - fr.hh;
      const inside = ax <= 0 && ay <= 0, hitEl = tbEl || vp;
      if (!inside && !hitEl) { startTransform(e, 'rotate'); return; }
      if (inside && !hitEl && fr.kind === 'items') { e.preventDefault(); startItemDrag(e, p0, { top: fr.ids[0], item: fr.ids[0] }, false); return; }
    }
  }
  if (tbEl && t.closest('.hdl')) { startResize(e, tbEl); return; }
  let hit = null;
  if (tbEl) hit = { top: tbEl.dataset.id, item: tbEl.dataset.id };
  else if (vp) hit = { top: vp.dataset.gid, item: cv.tool === 'direct' ? vp.dataset.pid : vp.dataset.gid };
  e.preventDefault();
  if (!hit) { startMarquee(e, p0); return; }
  let defer = false;
  if (e.shiftKey) {
    if (cv.selSet.includes(hit.item)) defer = true;          /* Shift on a selected object: toggle it off only if this turns out to be a click, not a drag */
    else setSel([...cv.selSet, hit.item], hit.item);
  } else if (!cv.selSet.includes(hit.item)) setSel([hit.item]);
  startItemDrag(e, p0, hit, defer);
});

function startItemDrag(e, p0, hit, defer) {
  const origIds = topMovers(cv.selSet);
  const origSnaps = new Map(origIds.map(id => [id, deep(findItem(id).item)]));
  let ids = origIds.slice(), snaps = new Map(origSnaps), clones = null;
  const rect0 = unionRect(ids.map(bboxOf));
  const a = cv.doc.artboard;
  let moved = false, dup = false, last = [0, 0];
  const wasMulti = cv.selSet.length > 1;
  const makeCopies = () => {
    /* originals go back to where they started, copies are inserted above them and become the drag targets */
    for (const id of origIds) { const f = findItem(id); if (f) applyOffset(f.item, origSnaps.get(id), 0, 0); }
    clones = [];
    for (const id of origIds) { const f = findItem(id), c = cloneItem(origSnaps.get(id)); f.list.splice(f.index + 1, 0, c); clones.push(c.id); }
    ids = clones.slice(); snaps = new Map(ids.map(id => [id, deep(findItem(id).item)]));
    dup = true; cv.selSet = clones.slice(); cv.sel = clones[clones.length - 1]; cv.dsel = new Set();
    renderAll();
  };
  const dropCopies = () => {                  /* Alt released: no copies after all, the originals move instead */
    for (const id of clones) { const f = findItem(id); if (f) f.list.splice(f.index, 1); }
    clones = null; ids = origIds.slice(); snaps = new Map(origSnaps); dup = false;
    cv.selSet = origIds.slice(); cv.sel = origIds[origIds.length - 1] || null; cv.dsel = new Set();
    renderAll();
  };
  const place = (dx, dy) => {
    const tops = new Set();
    for (const id of ids) { const f = findItem(id); if (!f) continue; applyOffset(f.item, snaps.get(id), dx, dy); tops.add(f.top); }
    tops.forEach(refreshEl); renderOverlay(); if (typeof syncInspNums === 'function') syncInspNums();
  };
  const move = ev => {
    let { x, y } = artPoint(ev); let dx = x - p0.x, dy = y - p0.y;
    if (!moved) { if (Math.abs(dx) + Math.abs(dy) < 2 / cv.zoom) return; moved = true; }
    if (!ids.length) return;
    if (ev.altKey && !dup) makeCopies(); else if (!ev.altKey && dup) dropCopies();
    if (ev.shiftKey) [dx, dy] = constrain(dx, dy);
    let sx = false, sy = false;
    if (rect0) {
      const th = 6 / cv.zoom;
      if (Math.abs(rect0.x + rect0.w / 2 + dx - a.w / 2) < th) { dx = a.w / 2 - (rect0.x + rect0.w / 2); sx = true; }
      if (Math.abs(rect0.y + rect0.h / 2 + dy - a.h / 2) < th) { dy = a.h / 2 - (rect0.y + rect0.h / 2); sy = true; }
    }
    showGuides(sx, sy); last = [dx, dy]; place(dx, dy);
  };
  const up = ev => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    showGuides(false, false);
    if (moved && ids.length) {
      if (dup && !ev.altKey) { dropCopies(); place(last[0], last[1]); }
      commit(); renderLayers();
    } else if (!moved) {
      if (defer) setSel(cv.selSet.filter(i => i !== hit.item));
      else if (!e.shiftKey && wasMulti) setSel([hit.item]);
    }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function startTransform(e, mode, hx, hy) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const fr = transformFrame(); if (!fr) return;
  const p0 = artPoint(e), O = rotOrigin(), anchors = fr.kind === 'anchors';
  const copyMode = e.altKey && !anchors;                 /* Alt held at the start: transform a copy */
  const origIds = anchors ? [] : fr.ids.slice();
  let ids = origIds.slice(), snaps = new Map(ids.map(id => [id, snapOf(id)]));
  const nodeSnaps = new Map(); const keys = anchors ? [...cv.dsel].filter(k => !isLocked(k.split('|')[0])) : [];
  for (const k of keys) { const id = k.split('|')[0]; if (!nodeSnaps.has(id)) nodeSnaps.set(id, deep(findItem(id).item.contours)); }
  let moved = false, dup = false, acc = 0, prev = Math.atan2(p0.y - O.y, p0.x - O.x), A = [1, 0, 0, 1], P = O, text = '';
  const label = h('div', { class: 'rotlabel' }); document.body.append(label);
  const makeCopies = () => {
    const clones = [];
    for (const id of origIds) { const f = findItem(id), c = cloneItem(snaps.get(id)); delete c._w; delete c._h; delete c._cx; delete c._cy; f.list.splice(f.index + 1, 0, c); clones.push(c.id); }
    ids = clones; renderAll(); snaps = new Map(ids.map(id => [id, snapOf(id)])); dup = true; cv.selSet = clones.slice(); cv.sel = clones[clones.length - 1]; cv.rotOrigin = O;
  };
  const move = ev => {
    const p = artPoint(ev);
    if (!moved) { if (Math.hypot(p.x - p0.x, p.y - p0.y) * cv.zoom < 3) return; moved = true; if (copyMode && !dup) makeCopies(); }
    if (mode === 'rotate') {
      const cur = Math.atan2(p.y - O.y, p.x - O.x); let d = cur - prev; d = Math.atan2(Math.sin(d), Math.cos(d)); acc += d; prev = cur;
      let deg = acc * 180 / Math.PI; if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      A = rotMat(deg2(deg)); P = O; text = (Math.round(deg * 10) / 10) + '\u00b0';
    } else {
      const lp = rotV(p.x - fr.cx, p.y - fr.cy, -fr.ang), oc = rotV(O.x - fr.cx, O.y - fr.cy, -fr.ang);
      const fromO = !copyMode && ev.altKey, piv = fromO ? oc : [-hx * fr.hw, -hy * fr.hh], h0 = [hx * fr.hw, hy * fr.hh];
      let kx = hx ? (lp[0] - piv[0]) / (h0[0] - piv[0] || 1e-6) : 1, ky = hy ? (lp[1] - piv[1]) / (h0[1] - piv[1] || 1e-6) : 1;
      if (hx && hy && ev.shiftKey) { const m = Math.max(Math.abs(kx), Math.abs(ky)); kx = Math.sign(kx || 1) * m; ky = Math.sign(ky || 1) * m; }
      kx = clampS(kx); ky = clampS(ky);
      const R = rotMat(fr.ang), Ri = rotMat(-fr.ang), D = [kx, 0, 0, ky];
      const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3]];
      A = mul(R, mul(D, Ri));
      const pw = rotV(piv[0], piv[1], fr.ang); P = { x: fr.cx + pw[0], y: fr.cy + pw[1] };
      text = Math.round(fr.hw * 2 * Math.abs(kx)) + ' \u00d7 ' + Math.round(fr.hh * 2 * Math.abs(ky));
    }
    if (anchors) {
      for (const k of keys) { const [id, c, n] = k.split('|'), sn = nodeSnaps.get(id)[c].nodes[n], nd = findItem(id).item.contours[c].nodes[n];
        const q = affPt(sn.x, sn.y, P, A); nd.x = q[0]; nd.y = q[1]; nd.i = sn.i ? affPt(sn.i[0], sn.i[1], P, A) : null; nd.o = sn.o ? affPt(sn.o[0], sn.o[1], P, A) : null; }
      for (const id of nodeSnaps.keys()) refreshEl(findItem(id).top);
    } else {
      const tops = new Set();
      for (const id of ids) { const f = findItem(id); if (f) { affApply(f.item, snaps.get(id), P, A); tops.add(f.top); } }
      tops.forEach(refreshEl);
    }
    label.textContent = text; label.style.left = (ev.clientX + 16) + 'px'; label.style.top = (ev.clientY + 16) + 'px';
    renderOverlay(); if (typeof syncInspNums === 'function') syncInspNums();
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); label.remove();
    if (moved) { commit(); renderLayers(); renderInsp(); }
    else if (mode === 'rotate') { cv.rotOrigin = e.altKey ? null : { x: p0.x, y: p0.y }; renderOverlay(); }      /* a click moves the origin; Alt-click resets it */
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function startResize(e, tbEl) {
  const b = boxById(tbEl.dataset.id); if (!b || b.locked) return;
  setSel([b.id]);
  const p0 = artPoint(e), w0 = b.w; let moved = false;
  const tf = tfOf(b), cr = Math.cos(deg2(tf.r)), sr = Math.sin(deg2(tf.r));
  const move = ev => { const p = artPoint(ev); moved = true; b.w = Math.max(20, Math.round(w0 + ((p.x - p0.x) * cr + (p.y - p0.y) * sr) / tf.sx)); renderBoxEl(b); syncInspNums(); renderOverlay(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) commit(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  e.preventDefault(); e.stopPropagation();
}

function startMarquee(e, p0) {
  const m = h('div', { class: 'marq' }); ab.append(m);
  const base = e.shiftKey ? cv.selSet.slice() : [], baseD = e.shiftKey ? new Set(cv.dsel) : new Set();
  if (!e.shiftKey) { setSel([]); }
  let moved = false, r = null;
  const move = ev => {
    const p = artPoint(ev);
    if (!moved && Math.abs(p.x - p0.x) + Math.abs(p.y - p0.y) < 3 / cv.zoom) return; moved = true;
    r = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
    Object.assign(m.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); m.remove();
    if (!moved || !r) return;
    const hitRect = b => b && b.x <= r.x + r.w && b.x + b.w >= r.x && b.y <= r.y + r.h && b.y + b.h >= r.y;
    if (cv.tool === 'direct') {
      const keys = new Set(), pids = new Set();
      for (const L of cv.doc.layers) {
        if (!isVec(L) || L.visible === false || L.locked) continue;
        for (const pth of pathsOf(L)) {
          if (pth.visible === false || pth.locked) continue;
          pth.contours.forEach((c, ci) => c.nodes.forEach((n, ni) => { if (n.x >= r.x && n.x <= r.x + r.w && n.y >= r.y && n.y <= r.y + r.h) { keys.add(pth.id + '|' + ci + '|' + ni); pids.add(pth.id); } }));
        }
      }
      setSel([...new Set([...base, ...pids])]);
      cv.dsel = new Set([...baseD, ...keys]); renderOverlay();     /* Shift adds to what was already selected */
    } else {
      const ids = cv.doc.layers.filter(L => L.visible !== false && !L.locked && hitRect(bboxOf(L.id))).map(L => L.id);
      setSel([...new Set([...base, ...ids])]);
    }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

ab.addEventListener('dblclick', e => {
  if (cv.tool === 'text') return;
  const tbEl = e.target.closest('.tb');
  if (tbEl) { if (!tbEl.classList.contains('locked')) beginEdit(tbEl.dataset.id); return; }
  if (e.target.closest('path[data-pid], #ov')) return;
  if (cv.tool !== 'select') return;
  const p = artPoint(e); const b = addBox(null, { x: Math.round(p.x), y: Math.round(p.y) }); setTimeout(() => beginEdit(b.id), 20);
});

/* ---------------------------------------------------------------- selection actions */
function pruneEmpty() {               /* paths with no anchors and groups with no paths disappear */
  const L = cv.doc.layers;
  for (let i = L.length - 1; i >= 0; i--) {
    const l = L[i];
    if (l.type === 'group') { l.children = l.children.filter(c => c.contours.length); if (!l.children.length) L.splice(i, 1); }
    else if (l.type === 'path' && !l.contours.length) L.splice(i, 1);
  }
}
function delSel() {
  if (cv.dsel.size && cv.tool === 'direct') {   /* deleting anchors: remove those nodes */
    const byPath = new Map();
    for (const k of cv.dsel) { const [id, c, n] = k.split('|'); if (isLocked(id)) continue; if (!byPath.has(id)) byPath.set(id, []); byPath.get(id).push([+c, +n]); }
    for (const [id, list] of byPath) {
      const f = findItem(id); if (!f) continue;
      f.item.contours.forEach((c, ci) => { const del = new Set(list.filter(x => x[0] === ci).map(x => x[1])); c.nodes = c.nodes.filter((_, ni) => !del.has(ni)); if (c.nodes.length <= 2) c.closed = false; });
      f.item.contours = f.item.contours.filter(c => c.nodes.length >= 1);
    }
    pruneEmpty();
    cv.dsel = new Set(); cv.selSet = cv.selSet.filter(id => findItem(id)); cv.sel = cv.selSet.includes(cv.sel) ? cv.sel : (cv.selSet[cv.selSet.length - 1] || null);
    renderAll(); commit(); return;
  }
  const ids = cv.selSet.filter(id => { const f = findItem(id); return f && !f.top.locked && !f.item.locked; });
  if (!ids.length) return;
  let kept = false;
  for (const id of ids) {
    const f = findItem(id); if (!f) continue;
    if (f.item.type === 'group') {               /* locked paths inside a group survive the delete */
      const keep = f.item.children.filter(c => c.locked); kept = kept || keep.length > 0;
      if (keep.length) { f.item.children = keep; continue; }
    }
    f.list.splice(f.index, 1);
    if (f.parent && !f.parent.children.length) { const g = findItem(f.parent.id); if (g) g.list.splice(g.index, 1); }
  }
  setSel([]); renderAll(); commit();
  if (kept) toast('Locked paths were kept.');
}
function dupSel() {
  const ids = topMovers(cv.selSet); if (!ids.length) return;
  const out = [];
  for (const id of ids) {
    const f = findItem(id), c = cloneItem(f.item);
    applyOffset(c, deep(c), 0, 0);
    if (c.type === 'text') { c.x += 20; c.y += 20; } else { const sn = deep(c); applyOffset(c, sn, 20, 20); }
    f.list.splice(f.index + 1, 0, c); out.push(c.id);
  }
  setSel(out); renderAll(); commit();
}
$('#dup').onclick = dupSel; $('#del').onclick = delSel;

function reorder(kind) {
  const L = cv.doc.layers, sel = new Set(cv.selSet.filter(id => L.some(l => l.id === id)));
  if (!sel.size) return;
  if (kind === 'fwd') { for (let i = L.length - 2; i >= 0; i--) if (sel.has(L[i].id) && !sel.has(L[i + 1].id)) [L[i], L[i + 1]] = [L[i + 1], L[i]]; }
  else if (kind === 'bwd') { for (let i = 1; i < L.length; i++) if (sel.has(L[i].id) && !sel.has(L[i - 1].id)) [L[i], L[i - 1]] = [L[i - 1], L[i]]; }
  else if (kind === 'front') cv.doc.layers = [...L.filter(l => !sel.has(l.id)), ...L.filter(l => sel.has(l.id))];
  else cv.doc.layers = [...L.filter(l => sel.has(l.id)), ...L.filter(l => !sel.has(l.id))];
  renderAll(); commit();
}

function nudge(dx, dy) {
  if (cv.tool === 'direct' && cv.dsel.size) {
    const tops = new Set();
    for (const k of cv.dsel) {
      const [id, c, n] = k.split('|'), f = findItem(id); if (!f || f.top.locked || f.item.locked) continue;
      const node = f.item.contours[c].nodes[n]; node.x += dx; node.y += dy;
      if (node.i) node.i = [node.i[0] + dx, node.i[1] + dy]; if (node.o) node.o = [node.o[0] + dx, node.o[1] + dy];
      tops.add(f.top);
    }
    tops.forEach(refreshEl); renderOverlay(); commit(); return;
  }
  const ids = topMovers(cv.selSet); if (!ids.length) return;
  const tops = new Set();
  for (const id of ids) {
    const f = findItem(id), it = f.item;
    if (it.type === 'text') { it.x += dx; it.y += dy; } else applyOffset(it, deep(it), dx, dy);
    tops.add(f.top);
  }
  tops.forEach(refreshEl); renderOverlay(); if (typeof syncInspNums === 'function') syncInspNums(); commit();
}

document.addEventListener('keydown', e => {
  const t = e.target, typing = t.matches && t.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])');
  if (!$('#v-canvas').classList.contains('active') || typing || cv.editing) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 'd') { e.preventDefault(); dupSel(); }
  else if (mod && e.shiftKey && e.code === 'KeyO') { e.preventDefault(); if (cv.sel && boxById(cv.sel)) createOutlines(cv.sel); }
  else if (mod && e.code === 'BracketRight') { e.preventDefault(); reorder(e.shiftKey ? 'front' : 'fwd'); }
  else if (mod && e.code === 'BracketLeft') { e.preventDefault(); reorder(e.shiftKey ? 'back' : 'bwd'); }
  else if (!mod && !e.altKey && e.key === 'Escape') { if (cv.tool !== 'select') setTool('select'); else if (cv.dsel.size) { cv.dsel = new Set(); renderOverlay(); } }
  else if (!mod && !e.altKey && k === 'v' && e.key.length === 1) setTool('select');
  else if (!mod && !e.altKey && k === 'a' && e.key.length === 1) setTool('direct');
  else if (!mod && !e.altKey && k === 't' && e.key.length === 1) setTool('text');
  else if (!mod && !e.altKey && k === 'h' && e.key.length === 1) setTool('hand');
  else if (!mod && !e.altKey && (k === 'e' || k === 'r') && e.key.length === 1) setTool('transform');
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delSel(); }
  else if (e.key === 'Enter' && cv.sel && boxById(cv.sel)) { e.preventDefault(); beginEdit(cv.sel); }
  else if (e.key.startsWith('Arrow') && cv.selSet.length) {
    e.preventDefault(); const d = e.shiftKey ? 10 : 1;
    nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
  }
});

/* ---------------------------------------------------------------- layers panel */
const ICON = {
  eye: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.3"/></svg>',
  lock: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="currentColor"/><path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  unlock: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5.3a2.5 2.5 0 0 1 4.8-1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'
};
const typeGlyph = l => l.type === 'text' ? 'T' : l.type === 'group' ? 'G' : 'P';
function lbtn(cls, icon, title, fn, off) {
  const b = h('button', { class: 'lb ' + cls + (off ? ' off' : ''), title, onclick: e => { e.stopPropagation(); fn(); } });
  b.innerHTML = icon; return b;
}
function caretBtn(l) {
  const open = cv.open.has(l.id);
  const b = h('button', { class: 'lcaret lb', title: 'Show or hide the paths in this group', onclick: e => { e.stopPropagation(); open ? cv.open.delete(l.id) : cv.open.add(l.id); renderLayers(); } });
  b.innerHTML = open ? '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M1.5 3l3.5 4 3.5-4z" fill="currentColor"/></svg>' : '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 1.5l4 3.5-4 3.5z" fill="currentColor"/></svg>';
  return b;
}
function layerRow(l, top, depth) {
  const sel = cv.selSet.includes(l.id);
  const row = h('div', { class: 'lrow' + (sel ? ' sel' : '') + (l.visible === false ? ' hid' : '') + (l.locked ? ' locked' : '') + (depth ? ' child' : ''), 'data-id': l.id, 'data-top': depth ? null : '1', style: { paddingLeft: (4 + depth * 16) + 'px' } });
  row.append(l.type === 'group' ? caretBtn(l) : h('span', { class: 'lcaret' }));
  row.append(lbtn('leye', l.visible === false ? ICON.eyeOff : ICON.eye, l.visible === false ? 'Show' : 'Hide', () => { l.visible = l.visible === false; renderAll(); commit(); }, l.visible === false));
  row.append(lbtn('llock', l.locked ? ICON.lock : ICON.unlock, l.locked ? 'Unlock' : 'Lock', () => { l.locked = !l.locked; renderAll(); commit(); }, !l.locked));
  row.append(h('span', { class: 'lic' }, typeGlyph(l)));
  row.append(h('span', { class: 'lname', title: 'Double-click to rename', ondblclick: e => { e.stopPropagation(); renameLayer(row, l); } }, layerLabel(l)));
  row.addEventListener('pointerdown', e => rowDown(e, row, l, !!depth));
  return row;
}
function renderLayers() {
  const box = $('#lyr-list'); if (!box) return;
  const rows = [];
  for (const l of cv.doc.layers.slice().reverse()) {
    rows.push(layerRow(l, true, 0));
    if (l.type === 'group' && cv.open.has(l.id)) for (const c of l.children.slice().reverse()) rows.push(layerRow(c, false, 1));
  }
  box.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty', style: { padding: '20px 12px' } }, 'No layers yet. Add text to start.')]));
}
function renameLayer(row, l) {
  const nameEl = row.querySelector('.lname'); if (!nameEl) return;
  const inp = h('input', { type: 'text', class: 'lren', value: layerLabel(l) });
  let done = false;
  const finish = ok => { if (done) return; done = true; if (ok && inp.value.trim() && inp.value.trim() !== layerLabel(l)) { l.name = inp.value.trim().slice(0, 80); commit(); } renderLayers(); };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
  inp.onpointerdown = e => e.stopPropagation();
  nameEl.replaceWith(inp); inp.focus(); inp.select();
}
function rowDown(e, row, l, isChild) {
  if (e.button !== 0 || e.target.closest('button, input')) return;
  const y0 = e.clientY; let dragging = false, line = null, drop = null;
  const list = $('#lyr-list');
  const topRows = () => [...list.querySelectorAll('.lrow[data-top]')];
  const move = ev => {
    if (!dragging) { if (isChild || Math.abs(ev.clientY - y0) < 5) return; dragging = true; row.classList.add('dragging'); line = h('div', { class: 'dropline' }); list.append(line); }
    const rows = topRows(), lr = list.getBoundingClientRect();
    let k = rows.length;
    for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { k = i; break; } }
    drop = k;
    const y = k < rows.length ? rows[k].getBoundingClientRect().top : rows[rows.length - 1].getBoundingClientRect().bottom;
    line.style.top = (y - lr.top + list.scrollTop - 1) + 'px';
  };
  const up = ev => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (dragging) {
      row.classList.remove('dragging'); line.remove();
      const L = cv.doc.layers, n = L.length, di = L.findIndex(x => x.id === l.id);
      let ins = drop < n ? n - 1 - drop + 1 : 0;     /* visual row k is array index n-1-k; dropping above it means just after it */
      if (di < ins) ins--;
      if (ins !== di) { const [it] = L.splice(di, 1); L.splice(ins, 0, it); renderAll(); commit(); } else renderLayers();
      return;
    }
    /* a plain click selects */
    if (isChild) { setTool('direct'); setSel([l.id]); }
    else if (ev.shiftKey || ev.ctrlKey || ev.metaKey) setSel(cv.selSet.includes(l.id) ? cv.selSet.filter(i => i !== l.id) : [...cv.selSet.filter(i => cv.doc.layers.some(x => x.id === i)), l.id], l.id);
    else if (!(cv.selSet.length === 1 && cv.selSet[0] === l.id)) setSel([l.id]);     /* no rebuild on a repeat click, so a double-click can reach the name */
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

/* ---------------------------------------------------------------- inspector for vector layers */
function renderVecInsp(box) {
  const items = cv.selSet.map(id => findItem(id)).filter(f => f && f.item.type !== 'text');
  if (!items.length) { box.replaceChildren(h('h3', {}, 'Inspector'), h('div', { class: 'muted' }, 'Select a layer to change it. Use the Text tool, or double-click the page, to add text.')); return; }
  const paths = items.flatMap(f => pathsOf(f.item)), one = items.length === 1 ? items[0].item : null;
  const name = h('input', { type: 'text', value: one ? layerLabel(one) : items.length + ' layers', disabled: !one, onchange: e => { if (one) { one.name = e.target.value.slice(0, 80); renderLayers(); commit(); } } });
  const fill = h('input', { type: 'color', value: paths[0] ? okColor(paths[0].fill, '#111111') : '#111111',
    oninput: e => { paths.forEach(p => p.fill = okColor(e.target.value, '#111111')); items.forEach(f => refreshFill(f.top)); }, onchange: commit });
  const op0 = paths[0] ? paths[0].op : 1;
  const opN = h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: op0 }), opR = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: op0 });
  const setOp = v => { paths.forEach(p => p.op = Math.min(1, Math.max(0, +v))); items.forEach(f => refreshFill(f.top)); };
  opN.oninput = () => { setOp(opN.value); opR.value = opN.value; }; opR.oninput = () => { setOp(opR.value); opN.value = opR.value; }; opN.onchange = opR.onchange = commit;
  box.replaceChildren(h('h3', {}, one ? (one.type === 'group' ? 'Group' : 'Path') : 'Selection'),
    h('div', { class: 'f' }, h('span', {}, 'Name'), name),
    h('div', { class: 'f' }, h('span', {}, 'Fill'), fill),
    h('div', { class: 'f' }, h('span', {}, 'Opacity'), h('div', { class: 'row' }, opR, opN)),
    (() => { const a = h('input', { type: 'number', value: 0, step: 1, id: 'rotby' }); return h('div', { class: 'f' }, h('span', {}, 'Rotate by'), h('div', { class: 'row' }, a, h('button', { id: 'rotapply', onclick: () => { if (+a.value) transformSelection(+a.value, 1); } }, 'Apply'))); })(),
    (() => { const a = h('input', { type: 'number', value: 100, step: 5, id: 'scaleby' }); return h('div', { class: 'f' }, h('span', {}, 'Scale %'), h('div', { class: 'row' }, a, h('button', { id: 'scaleapply', onclick: () => { if (+a.value > 0) transformSelection(0, +a.value / 100); } }, 'Apply'))); })(),
    h('div', { class: 'hint' }, paths.length + (paths.length === 1 ? ' path' : ' paths') + '. Use the Direct Selection tool (A) to edit points.'));
}
function refreshFill(top) {
  const svg = ab.querySelector('svg.vl[data-id="' + CSS.escape(top.id) + '"]'); if (!svg) return;
  pathsOf(top).forEach((p, i) => { const e = svg.firstChild.children[i]; if (e) { e.setAttribute('fill', okColor(p.fill, '#111111')); e.setAttribute('fill-opacity', num_(p.op, 1)); } });
}

/* ---------------------------------------------------------------- export of vectors */
function svgVec(l) {
  const A = (k, v) => ' ' + k + '="' + esc(String(v)) + '"';
  const ps = pathsOf(l).filter(p => p.visible !== false).map(p => '<path' + A('d', contoursToD(p.contours)) + A('fill', okColor(p.fill, '#111111')) + A('fill-opacity', num_(p.op, 1)) + A('data-name', layerLabel(p)) + '/>').join('');
  return l.type === 'group' ? '<g' + A('data-name', layerLabel(l)) + '>' + ps + '</g>\n' : ps + '\n';
}
function drawVecPNG(ctx, l, S) {
  for (const p of pathsOf(l)) {
    if (p.visible === false) continue;
    ctx.save(); ctx.scale(S, S); ctx.globalAlpha = num_(p.op, 1); ctx.fillStyle = okColor(p.fill, '#111111');
    ctx.fill(new Path2D(contoursToD(p.contours))); ctx.restore();
  }
}

/* ---------------------------------------------------------------- Create outlines (HarfBuzz compiled to WASM, vendored in static/vendor/harfbuzz) */
let hbP = null;
const loadHB = () => hbP || (hbP = import('./vendor/harfbuzz/index.mjs'));
const fontBytes = new Map();
async function getFontBytes(file, index) {
  const k = file + '#' + (index || 0);
  if (!fontBytes.has(k)) { const r = await fetch(fontUrl(file, index)); if (!r.ok) throw new Error('Could not read the font file.'); fontBytes.set(k, await r.arrayBuffer()); }
  return fontBytes.get(k);
}
let outlining = false;
const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const dirOf = ch => RTL_RE.test(ch) ? 'r' : /[\p{L}\p{N}]/u.test(ch) ? 'l' : null;     /* null = neutral (space, punctuation) */
function askMissing(chars) {            /* in-page question, no browser dialog */
  return new Promise(res => {
    const done = v => { m.remove(); document.removeEventListener('keydown', onKey, true); res(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    const m = h('div', { class: 'modal', id: 'miss-modal' }, h('div', { class: 'box' },
      h('h2', {}, 'This font is missing some letters'),
      h('p', { style: { margin: '0 0 8px' } }, 'The font has no glyph for: ' + chars.join(' ')),
      h('p', { class: 'muted', style: { margin: '0 0 16px' } }, 'You can still make outlines. The missing letters become empty boxes.'),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { id: 'miss-cancel', onclick: () => done(false) }, 'Cancel'),
        h('button', { id: 'miss-go', class: 'primary', onclick: () => done(true) }, 'Outline anyway (missing letters become boxes)'))));
    document.addEventListener('keydown', onKey, true);
    document.body.append(m); $('#miss-go').focus();
  });
}
async function createOutlines(id) {
  const b = boxById(id);
  if (!b) { toast('Select a text layer first.'); return null; }
  if (outlining) return null;
  if (b.locked) { toast('Unlock the layer first.'); return null; }
  if (cv.editing) document.activeElement.blur();
  const r = resolveStyle(b), el = ab.querySelector('.tb[data-id="' + CSS.escape(id) + '"]');
  const node = el && el.firstChild && el.firstChild.firstChild;
  if (!r || !node || !node.data.trim()) { toast('This text layer has no text to outline.'); return null; }
  outlining = true; toast('Creating outlines...');
  try {
    const hb = await loadHB();
    await faceInfo(r.s.file, r.s.variable, r.s.index).p;
    const bytes = await getFontBytes(r.s.file, r.s.index);
    const face = new hb.Face(new hb.Blob(bytes.slice(0)), 0), font = new hb.Font(face), upem = face.upem;
    font.setScale(upem, upem);
    /* axis values the browser uses: style weight and width, automatic optical size, then the box's own axis overrides */
    const info = await getInfo(r.s.file, r.s.index);
    const axes = {};
    if (r.s.variable) { axes.wght = r.s.weight; axes.wdth = r.s.width; if (info.axes.some(a => a.tag === 'opsz')) { const oa = info.axes.find(a => a.tag === 'opsz'); axes.opsz = Math.min(oa.max, Math.max(oa.min, b.size)); } }
    if (r.s.variable) Object.assign(axes, b.vars || {});
    const vs = Object.entries(axes).filter(([t]) => info.axes.some(a => a.tag === t)).map(([t, v]) => new hb.Variation(t, v));
    if (vs.length) font.setVariations(vs);
    const featMap = Object.assign({}, b.feat || {});
    if (b.ls) { if (featMap.liga == null) featMap.liga = 0; if (featMap.clig == null) featMap.clig = 0; }   /* the browser turns ligatures off when letters are spaced */
    const feats = Object.entries(featMap).map(([t, v]) => new hb.Feature(t, v));
    /* line layout comes from the DOM so breaks, alignment and spacing match what is on screen */
    const z = cv.zoom, ar = ab.getBoundingClientRect(), text = node.data, range = document.createRange();
    const savedTf = el.style.transform; el.style.transform = '';          /* measure the untransformed text, then bake the transform into the paths */
    const lines = [];
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i), len = cp > 0xffff ? 2 : 1;
      if (text[i] !== '\n') {
        range.setStart(node, i); range.setEnd(node, i + len);
        const rc = range.getClientRects()[0];
        if (rc && rc.height > 0) {
          const box = { left: (rc.left - ar.left) / z, top: (rc.top - ar.top) / z, h: rc.height / z };
          let ln = lines[lines.length - 1];
          if (!ln || Math.abs(box.top - ln.top) > box.h * 0.5) { ln = { top: box.top, chars: [] }; lines.push(ln); }
          ln.chars.push({ i, len, left: box.left });
        }
      }
      i += len;
    }
    const boxW = el.offsetWidth, boxH = el.offsetHeight; el.style.transform = savedTf;
    const mctx = document.createElement('canvas').getContext('2d'); setCtxFont(mctx, b, r, 1);
    const asc = Math.round(mctx.measureText('Hg').fontBoundingBoxAscent), k = b.size / upem;
    const children = [], missing = new Set();
    for (const ln of lines) {
      /* split the line into direction runs (Arabic and Hebrew right to left, the rest left to right); each run starts at its leftmost character on screen */
      const runs = []; let pend = [];
      for (const c of ln.chars) {
        const ch = text.slice(c.i, c.i + c.len), d = dirOf(ch);
        let run = runs[runs.length - 1];
        if (d === null) { if (run) run.chars.push(c); else pend.push(c); continue; }
        if (!run || run.dir !== d) { run = { dir: d, chars: pend }; pend = []; runs.push(run); }
        run.chars.push(c);
      }
      if (!runs.length) runs.push({ dir: 'l', chars: pend });
      for (const run of runs) {
        const first = run.chars[0], lastc = run.chars[run.chars.length - 1];
        const strong = run.chars.filter(c => dirOf(text.slice(c.i, c.i + c.len)) !== null);      /* spaces and punctuation may sit on either side of a run on screen */
        const sf = strong.length ? strong[0] : first, sl = strong.length ? strong[strong.length - 1] : lastc;
        let src = text.slice(sf.i, sl.i + sl.len);
        if (b.tt === 'upper') src = src.toUpperCase();
        let x = Math.min(...(strong.length ? strong : run.chars).map(c => c.left));
        const buf = new hb.Buffer(); buf.addText(src); buf.guessSegmentProperties();
        hb.shape(font, buf, feats);
        const infos = buf.getGlyphInfos(), pos = buf.getGlyphPositions(), base = ln.top + asc;
        infos.forEach((g, gi) => {
          const d = font.glyphToPath(g.codepoint), p = pos[gi];
          const cpt = src.codePointAt(Math.min(g.cluster, src.length - 1)), ch = cpt === undefined ? '' : String.fromCodePoint(cpt);
          if (g.codepoint === 0 && ch && !/\s/.test(ch)) missing.add(ch);
          if (d) {
            const gx = x + p.xOffset * k, gy = base - p.yOffset * k;
            const contours = parseGlyphPath(d, (px, py) => [gx + px * k, gy - py * k]);
            if (contours.length) children.push({ id: uid(), type: 'path', name: ch.trim() || 'Glyph', visible: true, locked: false, contours, fill: okColor(b.color, '#111111'), op: b.op });
          }
          x += p.xAdvance * k + (b.ls || 0);
        });
      }
    }
    if (!children.length) throw new Error('The font has no outlines for this text.');
    { const tf = tfOf(b); if (tf.r || tf.sx !== 1 || tf.sy !== 1) {
      const cr = Math.cos(deg2(tf.r)), sr = Math.sin(deg2(tf.r)), C = { x: b.x + boxW / 2, y: b.y + boxH / 2 }, M = [cr * tf.sx, sr * tf.sx, -sr * tf.sy, cr * tf.sy];
      children.forEach(c => { c.contours = affContours(c.contours, C, M); }); } }
    if (missing.size && !(await askMissing([...missing]))) { toast('Outlines cancelled.'); return null; }
    const f = findItem(id); if (!f) return null;
    const group = { id: uid(), type: 'group', name: (b.name || text.replace(/\s+/g, ' ').trim()).slice(0, 40) || 'Outlines', visible: true, locked: false, children };
    f.list.splice(f.index, 1, group);
    cv.open.add(group.id); setTool('select'); setSel([group.id]); renderAll(); commit();
    toast('Created ' + children.length + ' outlined glyphs');
    return group;
  } catch (e) { toast('Create outlines failed: ' + e.message); console.error(e); return null; }
  finally { outlining = false; }
}

/* ---------------------------------------------------------------- More menu in the canvas toolbar */
(() => {
  const btn = $('#morebtn'), menu = $('#more-menu');
  const close = () => { menu.hidden = true; btn.classList.remove('on'); };
  btn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.classList.toggle('on', !menu.hidden); };
  menu.addEventListener('click', () => setTimeout(close, 0));
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); e.stopPropagation(); } }, true);
})();

/* Scale % row for text layers (W and H, with a link toggle) */
let scaleLink = true;
function scaleRow(b) {
  const t = tfOf(b);
  const w = h('input', { type: 'number', id: 'scw', title: 'Width %', style: { width: '48px', flex: '0 0 48px' }, min: 1, max: 10000, step: 1, value: Math.round(Math.abs(t.sx) * 100) }), hh = h('input', { type: 'number', id: 'sch', title: 'Height %', style: { width: '48px', flex: '0 0 48px' }, min: 1, max: 10000, step: 1, value: Math.round(Math.abs(t.sy) * 100) });
  const link = h('button', { class: 'ghost' + (scaleLink ? ' on' : ''), title: 'Keep proportions', id: 'sclink', style: { padding: '5px 6px', flex: '0 0 auto' }, onclick: e => { scaleLink = !scaleLink; e.target.classList.toggle('on', scaleLink); e.target.textContent = scaleLink ? 'Link' : 'Free'; } }, scaleLink ? 'Link' : 'Free');
  const set = (which) => () => {
    const cur = tfOf(b), sgnx = Math.sign(cur.sx), sgny = Math.sign(cur.sy);
    let nx = +w.value / 100, ny = +hh.value / 100; if (!(nx > 0) || !(ny > 0)) return;
    if (scaleLink) { if (which === 'w') ny = Math.abs(cur.sy) * nx / Math.abs(cur.sx); else nx = Math.abs(cur.sx) * ny / Math.abs(cur.sy); }
    b.sx = sgnx * Math.min(100, Math.max(0.01, nx)); b.sy = sgny * Math.min(100, Math.max(0.01, ny));
    if (which === 'w' && scaleLink) hh.value = Math.round(Math.abs(b.sy) * 100); if (which === 'h' && scaleLink) w.value = Math.round(Math.abs(b.sx) * 100);
    renderBoxEl(b); renderOverlay();
  };
  w.oninput = set('w'); hh.oninput = set('h'); w.onchange = hh.onchange = commit;
  return h('div', { class: 'f' }, h('span', {}, 'Scale %'), h('div', { class: 'row' }, w, hh, link));
}

/* Transform tool: the pointer just outside a corner shows a rotate cursor */
const ROT_CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2724%27 height=%2724%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27M18 8a7 7 0 1 0 1.5 6%27 fill=%27none%27 stroke=%27white%27 stroke-width=%273.4%27/%3E%3Cpath d=%27M18 8a7 7 0 1 0 1.5 6%27 fill=%27none%27 stroke=%27black%27 stroke-width=%271.6%27/%3E%3Cpath d=%27M14 5.5l5 .5-1 5z%27 fill=%27black%27 stroke=%27white%27/%3E%3C/svg%3E") 12 12, crosshair';
ab.addEventListener('pointermove', e => {
  if (cv.tool !== 'transform' || e.buttons) return;
  const fr = transformFrame(); let c = '';
  if (fr) { const p = artPoint(e), lp = rotV(p.x - fr.cx, p.y - fr.cy, -fr.ang), ax = Math.abs(lp[0]) - fr.hw, ay = Math.abs(lp[1]) - fr.hh, z = cv.zoom;
    if (ax > 0 && ay > 0 && ax * z < 24 && ay * z < 24 && ax * z > 0) c = ROT_CURSOR; else if (ax > 0 || ay > 0) c = ROT_CURSOR; }
  ab.style.cursor = c;
});
