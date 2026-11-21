// 인물 관계도: SVG + 간단한 힘 기반 배치, 쪽수 기준으로 보이는 정보 제한(스포일러 방지)
const NS = 'http://www.w3.org/2000/svg';
const FAMILY_COLORS = ['#c8553d', '#3d7ec8', '#4f9d69', '#b0589e', '#d39b2a', '#5b6ccf', '#2a9d9d', '#8c6b4f', '#d0607e', '#6f8f2f'];

export const REL_KINDS = {
  family: { label: '가족', color: '#8a6a3f', dash: '' },
  love: { label: '연인·부부', color: '#e0628a', dash: '' },
  friend: { label: '친구·동료', color: '#4f9d69', dash: '' },
  enemy: { label: '적대·갈등', color: '#c0392b', dash: '6 5' },
  etc: { label: '기타', color: '#9a8f84', dash: '2 4' },
};

export const ALIAS_KINDS = ['본명', '성', '애칭', '호칭', '결혼 후 이름', '별명', '직함'];

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function familyColor(name) {
  if (!name) return '#b8a99a';
  return FAMILY_COLORS[hash(name.trim()) % FAMILY_COLORS.length];
}

// 그 쪽까지 드러난 이름들
export function visibleAliases(person, page) {
  return (person.aliases || []).filter((a) => a.name && (a.page || 0) <= page);
}
export function marriedVisible(person, page) {
  return person.marriedFamily && (person.marriedPage || 0) <= page;
}

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};

export function createGraph(svg, { onNodeTap } = {}) {
  let nodes = new Map();
  let edges = [];
  let alpha = 0;
  let raf = 0;
  const gEdges = el('g', {}, svg);
  const gNodes = el('g', {}, svg);
  const gLabels = el('g', {}, svg);
  const size = () => ({ w: svg.clientWidth || 360, h: svg.clientHeight || 340 });

  function setData(people, relations, page) {
    const { w, h } = size();
    const next = new Map();
    const vis = people.filter((p) => (p.firstPage || 0) <= page);
    vis.forEach((p, i) => {
      const old = nodes.get(p.id);
      const ang = (i / Math.max(vis.length, 1)) * Math.PI * 2;
      next.set(p.id, old ? Object.assign(old, { p }) : {
        p, x: w / 2 + Math.cos(ang) * 90, y: h / 2 + Math.sin(ang) * 90, vx: 0, vy: 0,
      });
    });
    nodes = next;
    const byPair = new Map();
    relations
      .filter((r) => (r.page || 0) <= page && nodes.has(r.from) && nodes.has(r.to))
      .forEach((r) => {
        const k = [r.from, r.to].sort().join('|');
        const cur = byPair.get(k);
        if (!cur || (r.page || 0) >= (cur.page || 0)) byPair.set(k, r);
      });
    edges = [...byPair.values()];
    build(page);
    alpha = 1;
    kick();
  }

  function build(page) {
    gEdges.textContent = '';
    gNodes.textContent = '';
    gLabels.textContent = '';
    for (const e of edges) {
      const k = REL_KINDS[e.kind] || REL_KINDS.etc;
      e._line = el('line', { stroke: k.color, 'stroke-width': e.kind === 'family' || e.kind === 'love' ? 2.6 : 1.8, 'stroke-dasharray': k.dash }, gEdges);
      if (e.label) {
        e._lg = el('g', { 'pointer-events': 'none' }, gLabels);
        e._bg = el('rect', { rx: 6, fill: '#fffaf0', stroke: k.color, 'stroke-width': 1 }, e._lg);
        e._tx = el('text', { 'font-size': 11, fill: k.color, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-weight': 600 }, e._lg);
        e._tx.textContent = e.label;
      }
    }
    for (const n of nodes.values()) {
      const p = n.p;
      const g = el('g', { class: 'gnode' }, gNodes);
      const married = marriedVisible(p, page);
      el('circle', { r: 30, fill: 'transparent' }, g); // 손가락으로 잡기 쉬운 영역
      el('circle', { r: 20, fill: familyColor(p.family), stroke: married ? familyColor(p.marriedFamily) : '#fffaf0', 'stroke-width': married ? 5 : 2 }, g);
      const ini = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#fff', 'font-size': 14, 'font-weight': 700 }, g);
      ini.textContent = [...(p.name || '?')][0];
      const name = el('text', { y: 36, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#2b2622', class: 'halo' }, g);
      name.textContent = p.name;
      const al = visibleAliases(p, page).map((a) => a.name).filter((x) => x !== p.name);
      if (al.length) {
        const t = el('text', { y: 51, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#6b5f55', class: 'halo' }, g);
        t.textContent = al.slice(0, 3).join(' · ') + (al.length > 3 ? ` +${al.length - 3}` : '');
      }
      n._g = g;
      bindDrag(n);
    }
    draw();
  }

  function bindDrag(n) {
    let start = null;
    let moved = 0;
    n._g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      n._g.setPointerCapture(e.pointerId);
      const pt = toLocal(e);
      start = { dx: n.x - pt.x, dy: n.y - pt.y };
      moved = 0;
      n.fixed = true;
    });
    n._g.addEventListener('pointermove', (e) => {
      if (!start) return;
      const pt = toLocal(e);
      const nx = pt.x + start.dx;
      const ny = pt.y + start.dy;
      moved += Math.abs(nx - n.x) + Math.abs(ny - n.y);
      n.x = nx; n.y = ny;
      alpha = Math.max(alpha, 0.3);
      kick();
    });
    const up = () => {
      if (!start) return;
      start = null;
      n.fixed = false;
      if (moved < 5) onNodeTap?.(n.p);
    };
    n._g.addEventListener('pointerup', up);
    n._g.addEventListener('pointercancel', up);
  }

  function toLocal(e) {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function tick() {
    const { w, h } = size();
    const arr = [...nodes.values()];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]; const b = arr[j];
        let dx = b.x - a.x; let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random(); dy = Math.random(); d2 = 1; }
        const f = (5200 / d2) * alpha;
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 120) * 0.035 * alpha;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of arr) {
      n.vx += (w / 2 - n.x) * 0.012 * alpha;
      n.vy += (h / 2 - n.y) * 0.012 * alpha;
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x = Math.max(30, Math.min(w - 30, n.x + n.vx));
      n.y = Math.max(26, Math.min(h - 56, n.y + n.vy));
    }
    alpha *= 0.975;
  }

  function draw() {
    for (const e of edges) {
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      e._line.setAttribute('x1', a.x); e._line.setAttribute('y1', a.y);
      e._line.setAttribute('x2', b.x); e._line.setAttribute('y2', b.y);
      if (e._lg) {
        const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
        const tw = e._tx.getComputedTextLength?.() || e.label.length * 11;
        e._tx.setAttribute('x', mx); e._tx.setAttribute('y', my);
        e._bg.setAttribute('x', mx - tw / 2 - 6); e._bg.setAttribute('y', my - 9);
        e._bg.setAttribute('width', tw + 12); e._bg.setAttribute('height', 18);
      }
    }
    for (const n of nodes.values()) n._g.setAttribute('transform', `translate(${n.x},${n.y})`);
  }

  function kick() {
    if (raf) return;
    const loop = () => {
      tick();
      draw();
      if (alpha > 0.02) raf = requestAnimationFrame(loop);
      else raf = 0;
    };
    raf = requestAnimationFrame(loop);
  }

  return { setData, destroy: () => { cancelAnimationFrame(raf); svg.textContent = ''; } };
}
