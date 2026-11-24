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

const SPOILER_KIND = { label: '스포', color: '#a89c8e', dash: '3 4' };

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
const GP = { rep: 0.02, grav: 0.06, spring: 0.05, kmin: 85, kmax: 150, kf: 0.8 }; // 간격·끌어당김 세기
function splitLabel(t) {
  if (t.length <= 8) return [t];
  const mid = t.length / 2; let best = -1;
  for (let i = 1; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  if (best > 0 && Math.abs(best - mid) <= t.length * 0.3) return [t.slice(0, best), t.slice(best + 1)];
  const c = Math.ceil(mid); return [t.slice(0, c), t.slice(c)];
}

export function createGraph(svg, { onNodeTap, onLink, onEmptyDoubleTap, onSpoilerTap, zoomable = false } = {}) {
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
  const gLabels = el('g', { class: 'glabels' }, gView);
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
    // 관계 이름이 선 위에 들어갈 만큼 간격 확보
    const avgLabel = relations.length ? relations.reduce((sum, r) => sum + Math.min(10, Math.ceil((r.label || '').length / ((r.label || '').length > 8 ? 2 : 1)) + 2), 0) / relations.length : 0;
    K = Math.max(GP.kmin, 55 + avgLabel * 12, Math.min(GP.kmax, Math.sqrt((w * h) / n) * GP.kf));
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
    if (focus) { focus = null; saved = null; } // 데이터가 바뀌면 강조를 풀고 새로 배치
    const byPair = new Map();
    relations
      .filter((r) => (r.page || 0) <= page && nodes.has(r.from) && nodes.has(r.to))
      .forEach((r) => {
        const k = [r.from, r.to].sort().join('|');
        const cur = byPair.get(k);
        // 같은 두 사람 사이에 관계가 여러 단계면 지금까지 드러난 것 중 가장 나중 것(장 → 쪽 순)
        const later = !cur || (r._seq != null && cur._seq != null ? r._seq > cur._seq
          : (r.chapter || 0) > (cur.chapter || 0) || ((r.chapter || 0) === (cur.chapter || 0) && (r.page || 0) >= (cur.page || 0)));
        if (later) byPair.set(k, r);
      });
    // 관계 원본에 그림 요소를 붙이지 않게 복사본으로 (작은 관계도와 크게 보기가 같은 관계를 공유해서 선이 어긋나던 문제)
    edges = [...byPair.values()].map((r) => ({ ...r }));
    build(page);
    // 새로 생긴 게 많으면 미리 계산해서 정돈된 상태로 보여줌
    if (fresh) {
      alpha = 1;
      for (let i = 0; i < 320; i++) tick();
      separate(80);
      placeLabels();
      for (let round = 0; round < 4 && growHidden(); round++) {
        alpha = 0.5;
        for (let i = 0; i < 90; i++) tick();
        separate(40);
        placeLabels();
      }
      fit(false);
    }
    // 관계 이름이 길어져서(스포 관계가 열리는 등) 선이 짧으면 힘을 더 줘서 부드럽게 벌어지게
    const tight = edges.some((e) => { if (!e._lg) return false; const a = nodes.get(e.from); const b = nodes.get(e.to); return Math.hypot(b.x - a.x, b.y - a.y) < needLen(e, a, b) - 8; });
    alpha = fresh ? 0.04 : Math.max(alpha, tight ? 0.8 : 0.25);
    draw();
    kick();
  }

  function build(page) {
    gEdges.textContent = '';
    gNodes.textContent = '';
    gLabels.textContent = '';
    for (const e of edges) {
      // 스포 관계: 종류 색도 힌트가 되니 회색 점선 + 🙈 (톡 하면 '이 일이 일어났어요')
      const k = e.spoiler ? SPOILER_KIND : REL_KINDS[e.kind] || REL_KINDS.etc;
      e._line = el('line', { stroke: k.color, 'stroke-width': !e.spoiler && (e.kind === 'family' || e.kind === 'love') ? 2.6 : 1.8, 'stroke-dasharray': k.dash }, gEdges);
      e._lg = null;
      if (e.spoiler) e.label = '🙈 ?';
      if (e.label) {
        const tap = e.spoiler && onSpoilerTap;
        e._lg = el('g', { 'pointer-events': tap ? 'auto' : 'none', class: tap ? 'glabel-tap' : '' }, gLabels);
        if (tap) {
          // 폰에선 손가락이 살짝만 움직여도 pointerup이 안 올 수 있어서 click으로 (브라우저가 톡을 판정)
          e._lg.addEventListener('pointerdown', (ev) => ev.stopPropagation());
          e._lg.addEventListener('pointerup', (ev) => ev.stopPropagation());
          e._lg.addEventListener('click', (ev) => { ev.stopPropagation(); onSpoilerTap?.(e.id); });
          e._hit = el('rect', { fill: 'transparent' }, e._lg); // 손가락으로 누르기 쉽게 넓은 영역
        }
        e._bg = el('rect', { rx: 6, fill: '#fffaf0', stroke: k.color, 'stroke-width': 1 }, e._lg);
        e._tx = el('text', { 'font-size': 11, fill: k.color, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-weight': 600 }, e._lg);
        // 말줄임 없이 전부. 길면 띄어쓰기 기준으로 두 줄
        e._rows = splitLabel(e.label);
        e._ts = e._rows.map((r) => { const t = el('tspan', {}, e._tx); t.textContent = r; return t; });
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

  // 강조: 고른 인물과 이어진 것만 진하게. 관계 이름은 겹치지 않게 톡 한 인물의 것만 보여줌
  function styleFocus() {
    const near = new Set();
    if (focus) {
      near.add(focus);
      for (const e of edges) if (e.from === focus || e.to === focus) { near.add(e.from); near.add(e.to); }
    }
    for (const e of edges) {
      const on = !focus || e.from === focus || e.to === focus;
      e._line.setAttribute('opacity', on ? 1 : 0.1);
    }
    for (const n of nodes.values()) {
      n._g.setAttribute('opacity', !focus || near.has(n.p.id) ? 1 : 0.22);
      n._g.classList.toggle('focused', n.p.id === focus);
    }
    placeLabels();
  }

  /* ---- 스포트라이트: 톡 한 인물을 가운데, 이어진 사람을 둥글게, 관계 이름은 선 위에 겹치지 않게 ---- */
  let saved = null;   // 강조 전 자리 (풀면 되돌아감)
  let tween = 0;
  // 확대/이동은 svg 전체를 GPU로 늘였다 줄이는 방식(글자를 매 순간 다시 그리지 않음): 목표 화면을 먼저 적용해 두고
  // CSS 변환으로 시작 화면에서 목표 화면까지 이어줌. 끝나면 변환을 지우고 선명하게 한 번 다시 그림
  let finishTween = null;
  function animateTo(targets, dur, viewTo, done) {
    finishTween?.(true);
    cancelAnimationFrame(raf); raf = 0;
    cancelAnimationFrame(fitAnim); fitAnim = 0;
    const from = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    const v0 = { ...view };
    if (viewTo) { view = { ...viewTo }; applyView(); }
    const css = (vi) => {
      const sc = vi.k / view.k;
      svg.style.transformOrigin = '0 0';
      svg.style.transform = `translate3d(${vi.x - sc * view.x}px, ${vi.y - sc * view.y}px, 0) scale(${sc})`;
    };
    let t0 = 0;
    gLabels.style.opacity = '0';
    labelsOff = true;
    svg.classList.add('anim');
    svg.style.willChange = 'transform';
    const finish = (skip) => {
      cancelAnimationFrame(tween); tween = 0; finishTween = null;
      if (skip) for (const [n, t] of targets) { n.x = t.x; n.y = t.y; }
      if (viewTo) { svg.style.transform = ''; }
      if (!zoomable) svg.style.willChange = '';
      labelsOff = false; placeLabels(); draw();
      svg.classList.remove('anim'); gLabels.style.opacity = '';
      done?.();
    };
    finishTween = finish;
    const step = (now) => {
      if (!t0) t0 = now;
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 5); // 빠르게 출발해서 아주 천천히 멈춤
      for (const [n, t] of targets) { const f = from.get(n); n.x = f.x + (t.x - f.x) * e; n.y = f.y + (t.y - f.y) * e; }
      if (viewTo) {
        // 배율은 곱셈으로 이어야 확대·축소 속도가 고르게 느껴짐
        const k = v0.k * Math.pow(viewTo.k / v0.k, e);
        // 화면 가운데 기준으로 같은 비율로 이동
        const { w, h } = size();
        const c0 = { x: (w / 2 - v0.x) / v0.k, y: (h / 2 - v0.y) / v0.k };
        const c1 = { x: (w / 2 - viewTo.x) / viewTo.k, y: (h / 2 - viewTo.y) / viewTo.k };
        const cx = c0.x + (c1.x - c0.x) * e; const cy = c0.y + (c1.y - c0.y) * e;
        css({ k, x: w / 2 - cx * k, y: h / 2 - cy * k });
      }
      draw();
      if (p < 1) tween = requestAnimationFrame(step);
      else finish(false);
    };
    tween = requestAnimationFrame(step);
  }
  function setFocus(id) {
    if (id === focus) return;
    stopInertia(); commitGesture(); // 톡 직후 남은 이동 상태를 먼저 정리
    if (!id) {
      focus = null;
      styleFocus();
      if (saved) {
        const back = new Map([...nodes.values()].filter((n) => saved.has(n)).map((n) => [n, saved.get(n)]));
        saved = null;
        autoFit = true;
        animateTo(back, 900, fitTargetFor(back, null));
      }
      return;
    }
    if (!saved) saved = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    focus = id;
    styleFocus();
    const c = nodes.get(id);
    const center = saved.get(c);
    const mine = edges.filter((e) => e.from === id || e.to === id);
    const nbrs = [...new Set(mine.map((e) => (e.from === id ? e.to : e.from)))].map((x) => nodes.get(x));
    // 지금 보이는 방향을 유지한 채 고르게 둥글게 배치
    nbrs.sort((a, b) => Math.atan2(saved.get(a).y - center.y, saved.get(a).x - center.x) - Math.atan2(saved.get(b).y - center.y, saved.get(b).x - center.x));
    const lw = Math.max(60, ...mine.map((e) => (e._lg ? labelW(e) : 0) + 16));
    const ringByCount = (nbrs.length * Math.max(lw, 70)) / (2 * Math.PI) * 1.3; // 둘레에 이름·관계 이름이 들어갈 만큼
    const R = Math.max(K * 1.4, 120, ringByCount);
    const a0 = nbrs.length ? Math.atan2(saved.get(nbrs[0]).y - center.y, saved.get(nbrs[0]).x - center.x) : 0;
    const targets = new Map();
    targets.set(c, { ...center });
    nbrs.forEach((n, i) => {
      const a = a0 + (i / nbrs.length) * Math.PI * 2;
      targets.set(n, { x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R });
    });
    // 나머지 인물은 바깥으로 밀어두기 (흐리게)
    for (const n of nodes.values()) {
      if (targets.has(n)) continue;
      const s0 = saved.get(n);
      const dx = s0.x - center.x; const dy = s0.y - center.y; const d = Math.hypot(dx, dy) || 1;
      const out = Math.max(d, R + K);
      targets.set(n, { x: center.x + (dx / d) * out, y: center.y + (dy / d) * out });
    }
    animateTo(targets, 900, fitTargetFor(targets, id));
  }
  // 관계 이름은 항상 두 원 사이 선 위에. 원·이름표·다른 관계 이름과 겹치지 않는 자리를 선을 따라 찾고,
  // 도저히 자리가 없으면 그 이름만 숨김(톡 하면 그 인물 중심으로 펼쳐져서 보임)
  function labelW(e) {
    if (e._tw) return e._tw;
    let w = 0; for (const t of e._ts) w = Math.max(w, t.getComputedTextLength?.() || 0);
    return (e._tw = w || Math.max(...e._rows.map((r) => r.length)) * 11);
  }
  // 관계 이름 + 양쪽 이름표가 겹치지 않으려면 필요한 선 길이
  function needLen(e, a, b) { return labelW(e) + 14 + (a.bw + b.bw) / 2 + 16 + (e._extra || 0); }
  function labelH(e) { return e._rows.length > 1 ? 31 : 18; }
  // 자리가 없어 숨은 관계 이름이 있으면 그 선만 조금 더 늘려달라고 표시 (최대 몇 번)
  function growHidden() {
    let grew = false;
    for (const e of edges) if (e._lg && !e._vis && (e._extra || 0) < 120) { e._extra = (e._extra || 0) + 30; grew = true; }
    return grew;
  }
  // 미리 계산해서 숨은 이름이 다 들어가는 자리를 찾고, 그 자리로 부드럽게 옮김
  function settleHidden() {
    if (!growHidden()) return false;
    const start = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    for (let round = 0; round < 4; round++) {
      alpha = 0.3;
      for (let i = 0; i < 60; i++) tick();
      separate(30);
      placeLabels();
      if (!growHidden()) break;
    }
    alpha = 0;
    const targets = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    for (const [n, p] of start) { n.x = p.x; n.y = p.y; }
    animateTo(targets, 700, autoFit && !gest ? fitTargetFor(targets, null) : null);
    return true;
  }
  function placeLabels() {
    const boxes = [...nodes.values()].map((n) => ({ x0: n.x - n.bw / 2 - 2, x1: n.x + n.bw / 2 + 2, y0: n.y - NODE_R - 2, y1: n.y - NODE_R + n.bh }));
    const hit = (b) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    // 짧은 선부터 자리를 잡으면 긴 선에 여유가 생김
    const list = edges.filter((e) => e._lg && (!focus || e.from === focus || e.to === focus))
      .map((e) => { const a = nodes.get(e.from); const b = nodes.get(e.to); return { e, a, b, len: Math.hypot(b.x - a.x, b.y - a.y) }; })
      .sort((x, y) => x.len - y.len);
    for (const e of edges) if (e._lg) e._vis = false;
    for (const { e, a: a0, b: b0 } of list) {
      // 강조 중이면 가운데 인물 쪽에서부터 재기
      const a = focus && e.to === focus ? b0 : a0; const b = focus && e.to === focus ? a0 : b0;
      const tw = labelW(e) + 14; const hh = labelH(e) / 2 + 2;
      for (const t of [0.5, 0.42, 0.58, 0.35, 0.65, 0.28, 0.72]) {
        const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t;
        const box = { x0: x - tw / 2, x1: x + tw / 2, y0: y - hh, y1: y + hh };
        if (!hit(box)) { e._t = t; e._from = a.p.id; e._vis = true; boxes.push(box); break; }
      }
    }
    for (const e of edges) if (e._lg) e._lg.setAttribute('visibility', e._vis ? 'visible' : 'hidden');
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
  let dragFrame = 0;
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
      finishTween?.(true); // 움직이는 중이면 바로 끝내서 손가락 위치가 정확하게
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
      // 끄는 동안엔 잡은 인물만 손가락을 따라감 (나머지는 놓았을 때 부드럽게 정리)
      if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; draw(); });
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
        else setFocus(n.p.id);
      } else if (!focus) {
        // 놓은 자리는 그대로 두고 주변만 정리
        n.fixed = true; alpha = 0.3; relax(550); n.fixed = false;
      } else { placeLabels(); draw(); }
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
    finishTween?.(true);
    cancelAnimationFrame(fitAnim);
    autoFit = false;
    if (gest) return;
    gest = { v0: { ...view }, r0: svg.getBoundingClientRect() };
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
    if (e.target.closest?.('.gnode, .glabel-tap')) return;
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
      if (focus) setFocus(null);
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
      // 관계 이름이 두 원 사이에 들어갈 만큼은 선을 늘림
      const rest = e._lg ? Math.max(K, needLen(e, a, b)) : K;
      const f = (d - rest) * GP.spring * alpha;
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
    // 관계 이름이 들어갈 최소 길이는 힘이 아니라 '자리'로 보장 (가운데로 당기는 힘에 눌려 짧아지지 않게)
    for (const e of edges) {
      if (!e._lg) continue;
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
      const need = needLen(e, a, b);
      if (d >= need) continue;
      const m = (need - d) * 0.2;
      const ux = dx / d; const uy = dy / d;
      if (!a.fixed) { a.x -= ux * m * (b.fixed ? 2 : 1); a.y -= uy * m * (b.fixed ? 2 : 1); }
      if (!b.fixed) { b.x += ux * m * (a.fixed ? 2 : 1); b.y += uy * m * (a.fixed ? 2 : 1); }
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
  function viewFor(x0, y0, x1, y1, w, h) {
    const pad = 14;
    const k = Math.max(0.35, Math.min(zoomable ? 1.6 : 1, (w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0)));
    return { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
  }
  // 애니메이션이 끝났을 때의 자리로 미리 화면 맞춤 값을 계산 (이동과 확대를 한 번에)
  function fitTargetFor(targets, focusId) {
    const { w, h } = size();
    let near = null;
    if (focusId) { near = new Set([focusId]); for (const e of edges) if (e.from === focusId || e.to === focusId) { near.add(e.from); near.add(e.to); } }
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of nodes.values()) {
      if (near && !near.has(n.p.id)) continue;
      const t = targets.get(n) || n;
      x0 = Math.min(x0, t.x - n.bw / 2); x1 = Math.max(x1, t.x + n.bw / 2);
      y0 = Math.min(y0, t.y - NODE_R - 4); y1 = Math.max(y1, t.y + n.bh - NODE_R);
    }
    return viewFor(x0, y0, x1, y1, w, h);
  }
  let fitAnim = 0;
  let autoFit = true; // 사용자가 직접 옮기거나 확대하기 전까지는 항상 전체가 보이게
  function fit(animate = true) {
    if (!nodes.size) return;
    autoFit = !focus;
    const { w, h } = size();
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    // 강조 중이면 가운데 인물과 이어진 사람들만 화면에 맞춤
    let list = [...nodes.values()];
    if (focus) {
      const near = new Set([focus]);
      for (const e of edges) if (e.from === focus || e.to === focus) { near.add(e.from); near.add(e.to); }
      list = list.filter((n) => near.has(n.p.id));
    }
    for (const n of list) {
      x0 = Math.min(x0, n.x - n.bw / 2); x1 = Math.max(x1, n.x + n.bw / 2);
      y0 = Math.min(y0, n.y - NODE_R - 4); y1 = Math.max(y1, n.y + n.bh - NODE_R);
    }
    const target = viewFor(x0, y0, x1, y1, w, h);
    if (!animate) { view = target; applyView(); return; }
    // svg 요소를 CSS로 줄이면 바깥이 잘려 보이므로, 맞추기 애니메이션은 안쪽 그룹만 움직임
    stopInertia();
    commitGesture();
    cancelAnimationFrame(fitAnim);
    const from = { ...view }; const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 320);
      const e = 1 - Math.pow(1 - p, 3);
      view = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      applyView();
      fitAnim = p < 1 ? requestAnimationFrame(step) : 0;
    };
    step();
  }

  let labelsOff = false; // 애니메이션 중엔 관계 이름을 감추고 다시 그리지 않음
  function draw() {
    for (const e of edges) {
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      e._line.setAttribute('x1', a.x); e._line.setAttribute('y1', a.y);
      e._line.setAttribute('x2', b.x); e._line.setAttribute('y2', b.y);
      if (e._lg && !labelsOff) {
        let mx = (a.x + b.x) / 2; let my = (a.y + b.y) / 2;
        if (e._t != null) {
          const f = e._from === b.p.id ? b : a; const o = f === a ? b : a;
          mx = f.x + (o.x - f.x) * e._t; my = f.y + (o.y - f.y) * e._t;
        }
        const tw = labelW(e); const lh = labelH(e);
        e._tx.setAttribute('x', mx); e._tx.setAttribute('y', my);
        e._ts.forEach((t, i) => { t.setAttribute('x', mx); t.setAttribute('y', my + (i - (e._ts.length - 1) / 2) * 13); });
        e._bg.setAttribute('x', mx - tw / 2 - 6); e._bg.setAttribute('y', my - lh / 2);
        e._bg.setAttribute('width', tw + 12); e._bg.setAttribute('height', lh);
        if (e._hit) { e._hit.setAttribute('x', mx - tw / 2 - 18); e._hit.setAttribute('y', my - lh / 2 - 12); e._hit.setAttribute('width', tw + 36); e._hit.setAttribute('height', lh + 24); }
      }
    }
    for (const n of nodes.values()) n._g.setAttribute('transform', `translate(${n.x},${n.y})`);
  }

  // 배치 바꾸기: 물리 계산을 화면 밖에서 끝까지 돌려 최종 자리를 구하고, 그 자리로 한 번에 미끄러지듯 이동
  // (화면에서 꿈틀거리며 자리 잡는 모습 대신)
  function relax(dur = 650) {
    const start = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    alpha = Math.max(alpha, 0.05);
    for (let i = 0; i < 420 && alpha > 0.02; i++) tick();
    separate(40);
    placeLabels();
    for (let round = 0; round < 4 && growHidden(); round++) {
      alpha = 0.3;
      for (let i = 0; i < 60; i++) tick();
      separate(30);
      placeLabels();
    }
    alpha = 0;
    const targets = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    const moved = [...targets].some(([n, t]) => Math.hypot(t.x - start.get(n).x, t.y - start.get(n).y) > 0.5);
    for (const [n, p] of start) { n.x = p.x; n.y = p.y; }
    const viewTo = autoFit && !gest ? fitTargetFor(targets, null) : null;
    if (!moved) { for (const [n, t] of targets) { n.x = t.x; n.y = t.y; } placeLabels(); draw(); if (viewTo) fit(true); return; }
    animateTo(targets, dur, viewTo);
  }
  function kick() {
    if (tween) return;
    if (focus) { placeLabels(); draw(); return; } // 강조 중엔 배치를 흔들지 않음
    relax();
  }

  if (zoomable) { svg.style.transformOrigin = '0 0'; svg.style.willChange = 'transform'; } // 미리 GPU 층으로 (끌기 시작할 때 첫 프레임 끊김 방지)
  applyView();
  return {
    setData,
    fit: () => { if (focus) setFocus(null); else fit(true); }, // 전체 보기 = 강조 풀고 전체 맞춤
    focusOn: (id) => { if (nodes.has(id)) { if (focus === id) fit(true); else setFocus(id); return true; } return false; }, // 검색 결과로 이동
    clearFocus: () => { if (focus) setFocus(null); },
    destroy: () => { finishTween = null; cancelAnimationFrame(raf); cancelAnimationFrame(tween); cancelAnimationFrame(inertia); cancelAnimationFrame(wheelAnim); svg.style.transform = ''; svg.textContent = ''; },
  };
}
