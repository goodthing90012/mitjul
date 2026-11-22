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

// 관계도
// - 인물 수와 화면 크기에 맞춰 간격을 정하고, 이름표끼리 겹치지 않게 밀어냄
// - 같은 가문끼리는 살짝 모이게
// - 처음엔 계산을 미리 돌려서 정리된 모습으로 보여주고, 전체가 화면에 들어오게 맞춤
// - 톡 = 그 인물의 관계만 강조(관계 이름 표시), 한 번 더 톡 = 편집
// - zoomable이면 빈 곳 끌기 = 이동, 두 손가락 = 확대/축소
const GP = { rep: 0.02, grav: 0.06, spring: 0.05, kmin: 60, kmax: 150, kf: 0.7 }; // 간격·끌어당김 세기
export function createGraph(svg, { onNodeTap, onLink, onEmptyDoubleTap, zoomable = false } = {}) {
  let nodes = new Map();
  let edges = [];
  let alpha = 0;
  let raf = 0;
  let focus = null;
  let view = { k: 1, x: 0, y: 0 };
  let K = 120; // 이상적인 간격
  const NODE_R = 20;
  const gView = el('g', {}, svg);
  const gEdges = el('g', {}, gView);
  const gNodes = el('g', {}, gView);
  const gLabels = el('g', {}, gView);
  const gTemp = el('g', { 'pointer-events': 'none' }, gView);
  const tempLine = el('line', { stroke: '#c8553d', 'stroke-width': 3, 'stroke-dasharray': '6 5', 'stroke-linecap': 'round', visibility: 'hidden' }, gTemp);
  const tempRing = el('circle', { r: 27, fill: 'none', stroke: '#c8553d', 'stroke-width': 3, visibility: 'hidden' }, gTemp);
  const size = () => ({ w: svg.clientWidth || 360, h: svg.clientHeight || 300 });
  const applyView = () => gView.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  // 확대·이동 중엔 svg 자체를 CSS로 움직이므로, 위치 계산은 움직이기 전 크기(r0)로
  let gest = null;
  const svgRect = () => (gest ? gest.r0 : svg.getBoundingClientRect());
  const toLocal = (e) => {
    const r = svgRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  function setData(people, relations, page) {
    const { w, h } = size();
    const vis = people.filter((p) => (p.firstPage || 0) <= page);
    const n = Math.max(vis.length, 1);
    K = Math.max(GP.kmin, Math.min(GP.kmax, Math.sqrt((w * h) / n) * GP.kf));
    const next = new Map();
    let fresh = 0;
    // 새 인물은 같은 가문 사람 근처, 없으면 원형으로 배치
    vis.forEach((p, i) => {
      const old = nodes.get(p.id);
      if (old) { next.set(p.id, Object.assign(old, { p })); return; }
      fresh++;
      const kin = [...nodes.values()].find((m) => m.p.family && m.p.family === p.family);
      const ang = (i / n) * Math.PI * 2;
      const R = K * Math.sqrt(n) * 0.45;
      next.set(p.id, kin
        ? { p, x: kin.x + (Math.random() - 0.5) * K, y: kin.y + (Math.random() - 0.5) * K, vx: 0, vy: 0 }
        : { p, x: w / 2 + Math.cos(ang) * R, y: h / 2 + Math.sin(ang) * R, vx: 0, vy: 0 });
    });
    nodes = next;
    if (focus && !nodes.has(focus)) focus = null;
    const byPair = new Map();
    relations
      .filter((r) => (r.page || 0) <= page && nodes.has(r.from) && nodes.has(r.to))
      .forEach((r) => {
        const k = [r.from, r.to].sort().join('|');
        const cur = byPair.get(k);
        // 같은 두 사람 사이에 관계가 여러 단계면 지금까지 드러난 것 중 가장 나중 것(장 → 쪽 순)
        const later = !cur || (r.chapter || 0) > (cur.chapter || 0) || ((r.chapter || 0) === (cur.chapter || 0) && (r.page || 0) >= (cur.page || 0));
        if (later) byPair.set(k, r);
      });
    edges = [...byPair.values()];
    build(page);
    // 새로 생긴 게 많으면 미리 계산해서 정돈된 상태로 보여줌
    if (fresh) {
      alpha = 1;
      for (let i = 0; i < 320; i++) tick();
      separate(80);
      fit(false);
    }
    alpha = fresh ? 0.04 : Math.max(alpha, 0.25);
    draw();
    kick();
  }

  function build(page) {
    gEdges.textContent = '';
    gNodes.textContent = '';
    gLabels.textContent = '';
    for (const e of edges) {
      const k = REL_KINDS[e.kind] || REL_KINDS.etc;
      e._line = el('line', { stroke: k.color, 'stroke-width': e.kind === 'family' || e.kind === 'love' ? 2.6 : 1.8, 'stroke-dasharray': k.dash }, gEdges);
      e._lg = null;
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
      el('circle', { r: 30, fill: 'transparent' }, g);
      el('circle', { r: NODE_R, fill: familyColor(p.family), stroke: married ? familyColor(p.marriedFamily) : '#fffaf0', 'stroke-width': married ? 5 : 2 }, g);
      const ini = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#fff', 'font-size': 14, 'font-weight': 700 }, g);
      ini.textContent = [...(p.name || '?')][0];
      const name = el('text', { y: 36, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#2b2622', class: 'halo' }, g);
      name.textContent = p.name;
      const al = visibleAliases(p, page).map((a) => a.name).filter((x) => x !== p.name);
      let aliasT = null;
      if (al.length) {
        aliasT = el('text', { y: 51, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#6b5f55', class: 'halo' }, g);
        aliasT.textContent = al.slice(0, 2).join(' · ') + (al.length > 2 ? ` +${al.length - 2}` : '');
      }
      // 이름표 크기 (겹침 방지용)
      const tw = Math.max(name.getComputedTextLength?.() || p.name.length * 13, aliasT?.getComputedTextLength?.() || 0);
      n.bw = Math.max(46, tw + 10);
      n.bh = aliasT ? 72 : 58;
      n._g = g;
      bindNode(n);
    }
    styleFocus();
  }

  // 강조: 고른 인물과 이어진 것만 진하게, 관계 이름은 많을 땐 강조된 것만
  function styleFocus() {
    const many = edges.length > 8;
    const near = new Set();
    if (focus) {
      near.add(focus);
      for (const e of edges) if (e.from === focus || e.to === focus) { near.add(e.from); near.add(e.to); }
    }
    for (const e of edges) {
      const on = !focus || e.from === focus || e.to === focus;
      e._line.setAttribute('opacity', on ? 1 : 0.12);
      if (e._lg) e._lg.setAttribute('visibility', (focus ? on : !many) ? 'visible' : 'hidden');
    }
    for (const n of nodes.values()) {
      n._g.setAttribute('opacity', !focus || near.has(n.p.id) ? 1 : 0.28);
      n._g.classList.toggle('focused', n.p.id === focus);
    }
  }

  /* ---- 노드 조작: 톡 = 강조/편집, 짧게 끌기 = 옮기기, 길게 눌러 끌기 = 잇기 ---- */
  function nodeAt(pt, except) {
    let best = null; let bd = 34;
    for (const m of nodes.values()) {
      if (m === except) continue;
      const d = Math.hypot(m.x - pt.x, m.y - pt.y);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  function bindNode(n) {
    let start = null;
    let moved = 0;
    let timer = 0;
    let linking = false;
    let target = null;
    const showTemp = (pt) => {
      tempLine.setAttribute('x1', n.x); tempLine.setAttribute('y1', n.y);
      tempLine.setAttribute('x2', pt.x); tempLine.setAttribute('y2', pt.y);
      tempLine.setAttribute('visibility', 'visible');
      target = nodeAt(pt, n);
      if (target) { tempRing.setAttribute('cx', target.x); tempRing.setAttribute('cy', target.y); tempRing.setAttribute('visibility', 'visible'); }
      else tempRing.setAttribute('visibility', 'hidden');
    };
    const hideTemp = () => { tempLine.setAttribute('visibility', 'hidden'); tempRing.setAttribute('visibility', 'hidden'); };
    n._g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      n._g.setPointerCapture(e.pointerId);
      const pt = toLocal(e);
      start = { dx: n.x - pt.x, dy: n.y - pt.y, x: pt.x, y: pt.y };
      moved = 0; linking = false; target = null;
      n.fixed = true;
      clearTimeout(timer);
      if (onLink) {
        timer = setTimeout(() => {
          if (!start || moved > 6) return;
          linking = true;
          navigator.vibrate?.(25);
          n._g.classList.add('linking');
          showTemp({ x: start.x, y: start.y });
        }, 380);
      }
    });
    n._g.addEventListener('pointermove', (e) => {
      if (!start) return;
      const pt = toLocal(e);
      if (linking) { showTemp(pt); return; }
      const nx = pt.x + start.dx;
      const ny = pt.y + start.dy;
      moved += (Math.abs(nx - n.x) + Math.abs(ny - n.y)) * view.k;
      if (moved < 6) return;
      clearTimeout(timer);
      n.x = nx; n.y = ny;
      alpha = Math.max(alpha, 0.25);
      kick();
    });
    const up = (e) => {
      if (!start) return;
      e?.stopPropagation?.();
      clearTimeout(timer);
      start = null;
      n.fixed = false;
      n._g.classList.remove('linking');
      if (linking) {
        hideTemp();
        linking = false;
        if (target) onLink?.(n.p, target.p);
        return;
      }
      if (moved < 6) {
        if (focus === n.p.id) onNodeTap?.(n.p);
        else { focus = n.p.id; styleFocus(); }
      }
    };
    n._g.addEventListener('pointerup', up);
    n._g.addEventListener('pointercancel', () => { clearTimeout(timer); start = null; n.fixed = false; linking = false; hideTemp(); n._g.classList.remove('linking'); });
  }

  /* ---- 빈 곳: 톡 = 강조 풀기, 두 번 톡 = 인물 추가, (zoomable) 끌기 = 이동, 두 손가락 = 확대 ----
     부드럽게: 움직이는 동안엔 svg 요소를 CSS transform으로만 옮기고(GPU), 손을 떼면 한 번에 반영.
     놓을 때 속도가 있으면 미끄러지듯 멈추고(관성), 휠 확대는 목표 배율로 천천히 따라감 */
  let frame = 0;
  let inertia = 0;
  let wheelAnim = 0;
  const beginGesture = () => {
    if (gest) return;
    gest = { v0: { ...view }, r0: svg.getBoundingClientRect() };
    svg.style.transformOrigin = '0 0';
    svg.style.willChange = 'transform';
  };
  const renderGesture = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!gest) return;
      const s0 = view.k / gest.v0.k;
      svg.style.transform = `translate3d(${view.x - s0 * gest.v0.x}px, ${view.y - s0 * gest.v0.y}px, 0) scale(${s0})`;
    });
  };
  const commitGesture = () => {
    if (!gest) return;
    cancelAnimationFrame(frame); frame = 0;
    applyView();
    svg.style.transform = '';
    svg.style.willChange = '';
    gest = null;
  };
  const stopInertia = () => { cancelAnimationFrame(inertia); inertia = 0; };
  const clampK = (k) => Math.max(0.35, Math.min(3, k));

  const pts = new Map();
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let bgMoved = 0;
  let vel = { x: 0, y: 0, t: 0 };
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.gnode')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    bgMoved = 0;
    if (!zoomable) return;
    stopInertia();
    cancelAnimationFrame(wheelAnim); wheelAnim = 0;
    beginGesture();
    svg.setPointerCapture(e.pointerId);
    if (pts.size === 1) { pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; vel = { x: 0, y: 0, t: performance.now() }; }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const r = gest.r0;
      const mx = (a.x + b.x) / 2 - r.left; const my = (a.y + b.y) / 2 - r.top;
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, wx: (mx - view.x) / view.k, wy: (my - view.y) / view.k };
      pan = null;
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    bgMoved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    if (!zoomable || !gest) return;
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const r = gest.r0;
      const mx = (a.x + b.x) / 2 - r.left; const my = (a.y + b.y) / 2 - r.top;
      view.k = clampK(pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(pinch.d, 1)));
      view.x = mx - pinch.wx * view.k; view.y = my - pinch.wy * view.k;
    } else if (pan) {
      const now = performance.now();
      const dt = Math.max(1, now - vel.t);
      // 놓을 때 관성용 속도 (부드럽게 평균)
      vel.x = 0.75 * ((e.clientX - prev.x) / dt) + 0.25 * vel.x;
      vel.y = 0.75 * ((e.clientY - prev.y) / dt) + 0.25 * vel.y;
      vel.t = now;
      view.x = pan.vx + (e.clientX - pan.x); view.y = pan.vy + (e.clientY - pan.y);
    }
    renderGesture();
  });
  const bgUp = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (zoomable) {
      if (pts.size === 1 && pinch) {
        // 두 손가락 중 하나만 떼면 남은 손가락으로 이어서 이동
        pinch = null;
        const [rest] = [...pts.values()];
        pan = { x: rest.x, y: rest.y, vx: view.x, vy: view.y };
        vel = { x: 0, y: 0, t: performance.now() };
      }
      if (pts.size === 0) {
        const wasPan = !!pan;
        pan = null; pinch = null;
        const idle = performance.now() - vel.t;
        let vx = idle > 80 ? 0 : vel.x; let vy = idle > 80 ? 0 : vel.y;
        if (wasPan && Math.hypot(vx, vy) > 0.25) {
          let last = performance.now();
          const step = (now) => {
            const dt = Math.min(40, now - last); last = now;
            view.x += vx * dt; view.y += vy * dt;
            const decay = Math.pow(0.9, dt / 16);
            vx *= decay; vy *= decay;
            renderGesture();
            if (Math.hypot(vx, vy) > 0.02) inertia = requestAnimationFrame(step);
            else { inertia = 0; commitGesture(); }
          };
          inertia = requestAnimationFrame(step);
        } else commitGesture();
      }
    }
    if (bgMoved > 8) return;
    const now = performance.now();
    const pt = { x: e.clientX, y: e.clientY };
    if (lastTap && now - lastTap.t < 350 && Math.hypot(pt.x - lastTap.x, pt.y - lastTap.y) < 30) {
      lastTap = null;
      onEmptyDoubleTap?.();
    } else {
      lastTap = { t: now, ...pt };
      if (focus) { focus = null; styleFocus(); }
    }
  };
  svg.addEventListener('pointerup', bgUp);
  svg.addEventListener('pointercancel', (e) => {
    pts.delete(e.pointerId);
    if (pts.size === 0) { pan = null; pinch = null; if (!inertia) commitGesture(); }
  });
  if (zoomable) {
    // 휠: 목표 배율로 부드럽게 따라가기
    let wheel = null;
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      stopInertia();
      beginGesture();
      const r = gest.r0;
      const mx = e.clientX - r.left; const my = e.clientY - r.top;
      if (!wheel) wheel = { k: view.k };
      wheel.k = clampK(wheel.k * Math.exp(-e.deltaY * 0.0015));
      wheel.mx = mx; wheel.my = my;
      wheel.wx = (mx - view.x) / view.k; wheel.wy = (my - view.y) / view.k;
      if (wheelAnim) return;
      const step = () => {
        const nk = view.k + (wheel.k - view.k) * 0.25;
        const wx = (wheel.mx - view.x) / view.k; const wy = (wheel.my - view.y) / view.k;
        view.k = nk;
        view.x = wheel.mx - wx * nk; view.y = wheel.my - wy * nk;
        renderGesture();
        if (Math.abs(wheel.k - view.k) > 0.002) wheelAnim = requestAnimationFrame(step);
        else { wheelAnim = 0; wheel = null; commitGesture(); }
      };
      wheelAnim = requestAnimationFrame(step);
    }, { passive: false });
  }

  /* ---- 배치 계산 ---- */
  function tick() {
    const { w, h } = size();
    const arr = [...nodes.values()];
    const cx = w / 2; const cy = h / 2;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        let dx = b.x - a.x; let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.5) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 0.5; }
        // 밀어내기
        const rep = ((K * K) / d) * GP.rep * alpha;
        a.vx -= (dx / d) * rep; a.vy -= (dy / d) * rep;
        b.vx += (dx / d) * rep; b.vy += (dy / d) * rep;
        // 같은 가문은 살짝 당기기
        if (a.p.family && a.p.family === b.p.family && d > K * 0.9) {
          const f = (d - K * 0.9) * 0.008 * alpha;
          a.vx += (dx / d) * f; a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
        }
        // 이름표 겹침 막기 (사각형 겹침을 직접 밀어냄)
        const ox = (a.bw + b.bw) / 2 + 6 - Math.abs(dx);
        const oy = (a.bh + b.bh) / 2 - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox / (a.bw + b.bw) < oy / (a.bh + b.bh)) {
            const s = (dx >= 0 ? 1 : -1) * ox * 0.5;
            if (!a.fixed) a.x -= s; if (!b.fixed) b.x += s;
          } else {
            const s = (dy >= 0 ? 1 : -1) * oy * 0.5;
            if (!a.fixed) a.y -= s; if (!b.fixed) b.y += s;
          }
        }
      }
    }
    for (const e of edges) {
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - K) * GP.spring * alpha;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of arr) {
      n.vx += (cx - n.x) * GP.grav * alpha;
      n.vy += (cy - n.y) * GP.grav * alpha;
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > 30) { n.vx *= 30 / sp; n.vy *= 30 / sp; }
      n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.985;
  }

  // 이름표가 겹친 곳만 반복해서 떼어놓기 (배치 계산 끝에 한 번)
  function separate(iter) {
    const arr = [...nodes.values()];
    for (let t = 0; t < iter; t++) {
      let any = false;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i]; const b = arr[j];
          const dx = b.x - a.x; const dy = b.y - a.y;
          const ox = (a.bw + b.bw) / 2 + 8 - Math.abs(dx);
          const oy = (a.bh + b.bh) / 2 + 4 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          any = true;
          if (ox / (a.bw + b.bw) < oy / (a.bh + b.bh)) { const s2 = ((dx >= 0 ? 1 : -1) * ox) / 2; a.x -= s2; b.x += s2; }
          else { const s2 = ((dy >= 0 ? 1 : -1) * oy) / 2; a.y -= s2; b.y += s2; }
        }
      }
      if (!any) break;
    }
  }

  // 전체가 화면에 들어오게 (인라인은 축소만, 크게 보기는 확대도)
  function fit(animate = true) {
    if (!nodes.size) return;
    const { w, h } = size();
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of nodes.values()) {
      x0 = Math.min(x0, n.x - n.bw / 2); x1 = Math.max(x1, n.x + n.bw / 2);
      y0 = Math.min(y0, n.y - NODE_R - 4); y1 = Math.max(y1, n.y + n.bh - NODE_R);
    }
    const pad = 14;
    const k = Math.max(0.35, Math.min(zoomable ? 1.6 : 1, (w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0)));
    const target = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    if (!animate) { view = target; applyView(); return; }
    stopInertia();
    beginGesture();
    const from = { ...view }; const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 320);
      const e = 1 - Math.pow(1 - p, 3);
      view = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      renderGesture();
      if (p < 1) requestAnimationFrame(step);
      else requestAnimationFrame(commitGesture);
    };
    step();
  }

  function draw() {
    for (const e of edges) {
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      e._line.setAttribute('x1', a.x); e._line.setAttribute('y1', a.y);
      e._line.setAttribute('x2', b.x); e._line.setAttribute('y2', b.y);
      if (e._lg) {
        const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
        const tw = e._tw || (e._tw = e._tx.getComputedTextLength?.() || e.label.length * 11);
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

  applyView();
  return {
    setData,
    fit: () => fit(true),
    destroy: () => { cancelAnimationFrame(raf); cancelAnimationFrame(inertia); cancelAnimationFrame(wheelAnim); svg.style.transform = ''; svg.textContent = ''; },
  };
}
