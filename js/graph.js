// 인물 관계도: 캔버스 + 간단한 힘 기반 배치, 쪽수 기준으로 보이는 정보 제한(스포일러 방지)
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

// cubic-bezier(.33, 0, .15, 1): 살며시 출발해서 길게 감속
function ease(t) {
  const x1 = 0.33; const y1 = 0; const x2 = 0.15; const y2 = 1;
  const bx = (u) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  let lo = 0; let hi = 1; let u = t;
  for (let i = 0; i < 20; i++) { u = (lo + hi) / 2; if (bx(u) < t) lo = u; else hi = u; }
  return by(u);
}

const onIdle = (f) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout: 200 }) : setTimeout(f, 16));
const cancelIdle = (id) => (window.cancelIdleCallback ? cancelIdleCallback(id) : clearTimeout(id));

/* 캔버스 관계도
   - 인물(원·이름·별칭)과 관계 이름은 처음에 한 번 작은 그림(스프라이트)으로 구워두고, 매 프레임엔 붙이기만 함
   - 확대 배율이 많이 바뀌면 멈춘 뒤에 그 배율로 다시 구워서 선명하게
   - 그래서 끌기·확대·강조 애니메이션이 폰에서도 매끄러움 */
export function createGraph(canvas, { onNodeTap, onLink, onEmptyDoubleTap, onSpoilerTap, zoomable = false, layout = null } = {}) {
  let nodes = new Map();
  let edges = [];
  let alpha = 0;
  let focus = null;
  let view = { k: 1, x: 0, y: 0 };
  let K = 120;
  const NODE_R = 20;
  // 배치 기억: { 인물id: {x, y} }. 저장된 인물은 그 자리에 고정(pin)
  const savePins = () => {
    if (!layout) return;
    const L = { ...(layout.get() || {}) };
    for (const n of nodes.values()) if (n.pin) L[n.p.id] = { x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 };
    layout.set(L);
  };
  const ctx = canvas.getContext('2d');
  const font = (getComputedStyle(canvas).fontFamily || 'sans-serif');
  const mctx = document.createElement('canvas').getContext('2d'); // 글자 폭 재기용
  const measure = (text, px, weight) => { mctx.font = `${weight} ${px}px ${font}`; return mctx.measureText(text).width; };
  let W = 360; let H = 300; let dpr = 1;
  const size = () => ({ w: W, h: H });
  const resize = () => {
    const w = canvas.clientWidth || 360; const h = canvas.clientHeight || 300;
    const d = Math.min(2, devicePixelRatio || 1); // 3배 화면도 2배로 (눈엔 거의 같고 그리는 양은 절반 가까이)
    if (w === W && h === H && d === dpr && canvas.width) return false;
    W = w; H = h; dpr = d;
    canvas.width = Math.round(w * d); canvas.height = Math.round(h * d);
    return true;
  };
  resize();
  const ro = new ResizeObserver(() => { if (resize()) requestRender(); });
  ro.observe(canvas);
  const rect = () => canvas.getBoundingClientRect();
  const toLocal = (e) => { const r = rect(); return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }; };

  /* ---- 그리기 ---- */
  let rq = 0;
  const requestRender = () => { if (!rq) rq = requestAnimationFrame(() => { rq = 0; render(); }); };
  let bakeS = 0; // 스프라이트를 구운 배율 (그래프 1 = 픽셀 몇 개)
  const wantS = () => { const s = Math.max(1, Math.min(6, view.k * dpr)); return Math.pow(2, Math.round(Math.log2(s) * 2) / 2); };
  let labelFade = 1; // 관계 이름 투명도 (애니메이션 끝나면 0→1)
  let temp = null;   // 잇기 중 임시 선 { from, x, y, target }
  let page = 0;

  function bakeNode(n, S) {
    const p = n.p;
    const married = marriedVisible(p, page);
    const pad = 6;
    const x0 = -n.bw / 2 - pad; const y0 = -NODE_R - pad;
    const w = n.bw + pad * 2; const h = n.bh + pad * 2;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * S); c.height = Math.ceil(h * S);
    const x = c.getContext('2d');
    x.scale(S, S); x.translate(-x0, -y0);
    x.beginPath(); x.arc(0, 0, NODE_R, 0, Math.PI * 2);
    x.fillStyle = familyColor(p.family); x.fill();
    x.lineWidth = married ? 5 : 2; x.strokeStyle = married ? familyColor(p.marriedFamily) : '#fffaf0'; x.stroke();
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `700 14px ${font}`; x.fillStyle = '#fff';
    x.fillText([...(p.name || '?')][0], 0, 1);
    x.textBaseline = 'alphabetic';
    x.lineJoin = 'round'; x.strokeStyle = '#f7f0e3'; x.lineWidth = 4;
    x.font = `700 13px ${font}`;
    x.strokeText(p.name, 0, 36); x.fillStyle = '#2b2622'; x.fillText(p.name, 0, 36);
    if (n.alias) {
      x.font = `400 10.5px ${font}`;
      x.strokeText(n.alias, 0, 51); x.fillStyle = '#6b5f55'; x.fillText(n.alias, 0, 51);
    }
    n._spr = { c, x0, y0, w, h };
  }
  function bakeEdge(e, S) {
    const tw = e._tw; const lh = labelH(e);
    const w = tw + 14; const h = lh + 2;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * S); c.height = Math.ceil(h * S);
    const x = c.getContext('2d');
    x.scale(S, S); x.translate(w / 2, h / 2);
    const rw = tw + 12;
    x.beginPath();
    x.roundRect ? x.roundRect(-rw / 2, -lh / 2, rw, lh, 6) : x.rect(-rw / 2, -lh / 2, rw, lh);
    x.fillStyle = '#fffaf0'; x.fill();
    x.lineWidth = 1; x.strokeStyle = e._k.color; x.stroke();
    x.font = `600 11px ${font}`; x.fillStyle = e._k.color; x.textAlign = 'center'; x.textBaseline = 'middle';
    e._rows.forEach((r, i) => x.fillText(r, 0, (i - (e._rows.length - 1) / 2) * 13 + 0.5));
    e._spr = { c, w, h };
  }
  // force = 지금 바로 전부 (데이터가 바뀔 때). 아니면 배율이 바뀌었을 때만, 몇 개씩 나눠 쉬는 틈에 (끝날 때 멈칫 방지)
  let bakeJob = 0;
  function bakeAll(force) {
    const S = wantS();
    if (!force && S === bakeS) return;
    bakeS = S;
    cancelIdle(bakeJob);
    const items = [...[...nodes.values()].map((n) => () => bakeNode(n, S)), ...edges.filter((e) => e._lg).map((e) => () => bakeEdge(e, S))];
    if (force) { items.forEach((f) => f()); return; }
    const run = (dl) => {
      const t0 = performance.now();
      while (items.length && (dl?.timeRemaining ? dl.timeRemaining() > 2 : performance.now() - t0 < 6)) items.shift()();
      if (items.length) bakeJob = onIdle(run); else requestRender();
    };
    bakeJob = onIdle(run);
  }
  let near = null; // 강조 중 이어진 인물
  function render() {
    resize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    // 선
    ctx.lineCap = 'butt';
    for (const e of edges) {
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      ctx.globalAlpha = !focus || e.from === focus || e.to === focus ? 1 : 0.1;
      ctx.strokeStyle = e._k.color; ctx.lineWidth = e._wid;
      ctx.setLineDash(e._dash);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // 인물
    for (const n of nodes.values()) {
      if (!n._spr) continue;
      ctx.globalAlpha = !focus || near?.has(n.p.id) ? 1 : 0.22;
      const s = n._spr;
      ctx.drawImage(s.c, n.x + s.x0, n.y + s.y0, s.w, s.h);
      if (n.p.id === focus || n === temp?.from) {
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2);
        ctx.lineWidth = n === temp?.from ? 5 : 4; ctx.strokeStyle = n === temp?.from ? '#c8553d' : '#2b2622'; ctx.stroke();
      }
    }
    // 관계 이름
    if (labelFade > 0) {
      ctx.globalAlpha = labelFade;
      for (const e of edges) {
        if (!e._lg || !e._vis || !e._spr) continue;
        const { x, y } = labelPos(e);
        const s = e._spr;
        ctx.drawImage(s.c, x - s.w / 2, y - s.h / 2, s.w, s.h);
      }
    }
    // 잇기 중 임시 선
    if (temp) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#c8553d'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(temp.from.x, temp.from.y); ctx.lineTo(temp.x, temp.y); ctx.stroke();
      ctx.setLineDash([]);
      if (temp.target) { ctx.beginPath(); ctx.arc(temp.target.x, temp.target.y, 27, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }
  const draw = requestRender;
  function labelPos(e) {
    const a = nodes.get(e.from); const b = nodes.get(e.to);
    if (e._t == null) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const f = e._from === b.p.id ? b : a; const o = f === a ? b : a;
    return { x: f.x + (o.x - f.x) * e._t, y: f.y + (o.y - f.y) * e._t };
  }
  // 멈춘 뒤: 필요하면 지금 배율로 다시 굽고, 관계 이름을 살며시 보이기
  let fadeAnim = 0;
  function settled() {
    bakeAll();
    cancelAnimationFrame(fadeAnim);
    const t0 = performance.now();
    const step = (now) => {
      labelFade = Math.min(1, (now - t0) / 200);
      render();
      if (labelFade < 1) fadeAnim = requestAnimationFrame(step);
    };
    fadeAnim = requestAnimationFrame(step);
  }

  /* ---- 데이터 ---- */
  function setData(people, relations, pg) {
    page = pg;
    resize();
    const { w, h } = size();
    const vis = people.filter((p) => (p.firstPage || 0) <= page);
    const n = Math.max(vis.length, 1);
    const avgLabel = relations.length ? relations.reduce((sum, r) => sum + Math.min(10, Math.ceil((r.label || '').length / ((r.label || '').length > 8 ? 2 : 1)) + 2), 0) / relations.length : 0;
    K = Math.max(GP.kmin, 55 + avgLabel * 12, Math.min(GP.kmax, Math.sqrt((w * h) / n) * GP.kf));
    // 강조 중이었다면 원래 자리로 먼저 돌려놓기
    if (saved) for (const [n, q] of saved) { n.x = q.x; n.y = q.y; }
    finishTween?.(true);
    const L = layout?.get() || null;
    const next = new Map();
    let fresh = 0;
    vis.forEach((p, i) => {
      const old = nodes.get(p.id);
      if (old) { next.set(p.id, Object.assign(old, { p })); return; }
      if (L?.[p.id]) { next.set(p.id, { p, x: L[p.id].x, y: L[p.id].y, vx: 0, vy: 0, pin: true }); return; }
      fresh++;
      // 새 인물: 이어진 사람(관계) → 같은 가문 근처
      const rel = relations.find((r) => (r.from === p.id && (next.has(r.to) || nodes.has(r.to))) || (r.to === p.id && (next.has(r.from) || nodes.has(r.from))));
      const relId = rel ? (rel.from === p.id ? rel.to : rel.from) : null;
      const kin = (relId && (next.get(relId) || nodes.get(relId))) || [...next.values(), ...nodes.values()].find((m) => m.p.family && m.p.family === p.family);
      const ang = (i / n) * Math.PI * 2;
      const R = K * Math.sqrt(n) * 0.45;
      next.set(p.id, kin
        ? { p, x: kin.x + (Math.random() - 0.5) * K, y: kin.y + (Math.random() - 0.5) * K, vx: 0, vy: 0 }
        : { p, x: w / 2 + Math.cos(ang) * R, y: h / 2 + Math.sin(ang) * R, vx: 0, vy: 0 });
    });
    nodes = next;
    if (focus) { focus = null; saved = null; near = null; }
    const byPair = new Map();
    relations
      .filter((r) => (r.page || 0) <= page && nodes.has(r.from) && nodes.has(r.to))
      .forEach((r) => {
        const k = [r.from, r.to].sort().join('|');
        const cur = byPair.get(k);
        const later = !cur || (r._seq != null && cur._seq != null ? r._seq > cur._seq
          : (r.chapter || 0) > (cur.chapter || 0) || ((r.chapter || 0) === (cur.chapter || 0) && (r.page || 0) >= (cur.page || 0)));
        if (later) byPair.set(k, r);
      });
    edges = [...byPair.values()].map((r) => ({ ...r }));
    build();
    if (fresh) {
      // 고정된 인물은 그대로 두고 새 인물만 자리 잡기 (처음이거나 '자동 정리'면 전부)
      const anyPin = [...nodes.values()].some((m) => m.pin);
      alpha = 1;
      for (let i = 0; i < (anyPin ? 200 : 320); i++) tick();
      separate(80);
      placeLabels();
      for (let round = 0; round < 4 && growHidden(); round++) {
        alpha = 0.5;
        for (let i = 0; i < 90; i++) tick();
        separate(40);
        placeLabels();
      }
      for (const m of nodes.values()) m.pin = true;
      savePins();
      fit(false);
    } else placeLabels();
    const tight = edges.some((e) => { if (!e._lg) return false; const a = nodes.get(e.from); const b = nodes.get(e.to); return Math.hypot(b.x - a.x, b.y - a.y) < needLen(e, a, b) - 8; });
    alpha = fresh ? 0.04 : Math.max(alpha, tight ? 0.8 : 0.25);
    bakeAll(true);
    render();
    kick();
  }

  // 크기 재기 + 스타일 정하기 (그림은 bakeAll에서)
  function build() {
    for (const e of edges) {
      e._k = e.spoiler ? SPOILER_KIND : REL_KINDS[e.kind] || REL_KINDS.etc;
      e._wid = !e.spoiler && (e.kind === 'family' || e.kind === 'love') ? 2.6 : 1.8;
      e._dash = e._k.dash ? e._k.dash.split(' ').map(Number) : [];
      if (e.spoiler) e.label = '🙈 ?';
      e._lg = !!e.label;
      if (e._lg) {
        e._rows = splitLabel(e.label);
        e._tw = Math.max(...e._rows.map((r) => measure(r, 11, 600)));
      }
    }
    for (const n of nodes.values()) {
      const p = n.p;
      const al = visibleAliases(p, page).map((a) => a.name).filter((x) => x !== p.name);
      n.alias = al.length ? al.slice(0, 2).join(' · ') + (al.length > 2 ? ` +${al.length - 2}` : '') : '';
      const tw = Math.max(measure(p.name, 13, 700), n.alias ? measure(n.alias, 10.5, 400) : 0);
      n.bw = Math.max(46, tw + 10);
      n.bh = n.alias ? 72 : 58;
    }
  }
  function nearOf(id) {
    const s = new Set([id]);
    for (const e of edges) if (e.from === id || e.to === id) { s.add(e.from); s.add(e.to); }
    return s;
  }

  /* ---- 강조(스포트라이트) 애니메이션 ---- */
  let saved = null;
  let tween = 0;
  let finishTween = null;
  function animateTo(targets, dur, viewTo, done) {
    finishTween?.(true);
    cancelAnimationFrame(fitAnim); fitAnim = 0;
    cancelAnimationFrame(fadeAnim);
    const from = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    const v0 = { ...view };
    labelFade = 0;
    let t0 = 0;
    const finish = (skip) => {
      cancelAnimationFrame(tween); tween = 0; finishTween = null;
      if (skip) {
        for (const [n, t] of targets) { n.x = t.x; n.y = t.y; }
        if (viewTo) view = { ...viewTo };
      }
      placeLabels();
      settled();
      done?.();
    };
    finishTween = finish;
    const { w, h } = size();
    const c0 = { x: (w / 2 - v0.x) / v0.k, y: (h / 2 - v0.y) / v0.k };
    const c1 = viewTo ? { x: (w / 2 - viewTo.x) / viewTo.k, y: (h / 2 - viewTo.y) / viewTo.k } : null;
    const step = (now) => {
      if (!t0) t0 = now;
      const p = Math.min(1, (now - t0) / dur);
      const e = ease(p);
      for (const [n, t] of targets) { const f = from.get(n); n.x = f.x + (t.x - f.x) * e; n.y = f.y + (t.y - f.y) * e; }
      if (viewTo) {
        const k = v0.k * Math.pow(viewTo.k / v0.k, e);
        const cx = c0.x + (c1.x - c0.x) * e; const cy = c0.y + (c1.y - c0.y) * e;
        view = { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
      }
      render();
      if (p < 1) tween = requestAnimationFrame(step);
      else finish(false);
    };
    tween = requestAnimationFrame(step);
  }
  function setFocus(id) {
    if (id === focus) return;
    stopInertia();
    if (!id) {
      focus = null; near = null;
      if (saved) {
        const back = new Map([...nodes.values()].filter((n) => saved.has(n)).map((n) => [n, saved.get(n)]));
        saved = null;
        autoFit = true;
        animateTo(back, 900, fitTargetFor(back, null));
      } else { placeLabels(); render(); }
      return;
    }
    if (!saved) saved = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
    focus = id;
    near = nearOf(id);
    const c = nodes.get(id);
    const center = saved.get(c);
    const mine = edges.filter((e) => e.from === id || e.to === id);
    const nbrs = [...new Set(mine.map((e) => (e.from === id ? e.to : e.from)))].map((x) => nodes.get(x));
    nbrs.sort((a, b) => Math.atan2(saved.get(a).y - center.y, saved.get(a).x - center.x) - Math.atan2(saved.get(b).y - center.y, saved.get(b).x - center.x));
    const lw = Math.max(60, ...mine.map((e) => (e._lg ? labelW(e) : 0) + 16));
    const ringByCount = (nbrs.length * Math.max(lw, 70)) / (2 * Math.PI) * 1.3;
    const R = Math.max(K * 1.4, 120, ringByCount);
    const a0 = nbrs.length ? Math.atan2(saved.get(nbrs[0]).y - center.y, saved.get(nbrs[0]).x - center.x) : 0;
    const targets = new Map();
    targets.set(c, { ...center });
    nbrs.forEach((n, i) => {
      const a = a0 + (i / nbrs.length) * Math.PI * 2;
      targets.set(n, { x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R });
    });
    for (const n of nodes.values()) {
      if (targets.has(n)) continue;
      const s0 = saved.get(n);
      const dx = s0.x - center.x; const dy = s0.y - center.y; const d = Math.hypot(dx, dy) || 1;
      const out = Math.max(d, R + K);
      targets.set(n, { x: center.x + (dx / d) * out, y: center.y + (dy / d) * out });
    }
    animateTo(targets, 900, fitTargetFor(targets, id));
  }

  /* ---- 관계 이름 자리 ---- */
  function labelW(e) { return e._tw || 0; }
  function needLen(e, a, b) { return labelW(e) + 14 + (a.bw + b.bw) / 2 + 16 + (e._extra || 0); }
  function labelH(e) { return e._rows.length > 1 ? 31 : 18; }
  function growHidden() {
    let grew = false;
    for (const e of edges) if (e._lg && !e._vis && (e._extra || 0) < 120) { e._extra = (e._extra || 0) + 30; grew = true; }
    return grew;
  }
  function placeLabels() {
    const boxes = [...nodes.values()].map((n) => ({ x0: n.x - n.bw / 2 - 2, x1: n.x + n.bw / 2 + 2, y0: n.y - NODE_R - 2, y1: n.y - NODE_R + n.bh }));
    const hit = (b) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    const list = edges.filter((e) => e._lg && (!focus || e.from === focus || e.to === focus))
      .map((e) => { const a = nodes.get(e.from); const b = nodes.get(e.to); return { e, a, b, len: Math.hypot(b.x - a.x, b.y - a.y) }; })
      .sort((x, y) => x.len - y.len);
    for (const e of edges) if (e._lg) e._vis = false;
    for (const { e, a: a0, b: b0 } of list) {
      const a = focus && e.to === focus ? b0 : a0; const b = focus && e.to === focus ? a0 : b0;
      const tw = labelW(e) + 14; const hh = labelH(e) / 2 + 2;
      for (const t of [0.5, 0.42, 0.58, 0.35, 0.65, 0.28, 0.72]) {
        const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t;
        const box = { x0: x - tw / 2, x1: x + tw / 2, y0: y - hh, y1: y + hh };
        if (!hit(box)) { e._t = t; e._from = a.p.id; e._vis = true; boxes.push(box); break; }
      }
    }
  }

  /* ---- 손가락 조작 (인물 / 빈 곳 / 관계 이름 모두 캔버스 하나에서 판정) ---- */
  function nodeAt(pt, except) {
    let best = null; let bd = 34;
    for (const m of nodes.values()) {
      if (m === except) continue;
      const d = Math.hypot(m.x - pt.x, m.y - pt.y);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  // 인물 누르기: 원 근처 또는 이름 글자 위
  function nodeHit(pt) {
    let best = null; let bd = Infinity;
    for (const m of nodes.values()) {
      const d = Math.hypot(m.x - pt.x, m.y - pt.y);
      const onName = Math.abs(pt.x - m.x) < m.bw / 2 && pt.y > m.y && pt.y < m.y - NODE_R + m.bh;
      if ((d < 30 || onName) && d < bd) { bd = d; best = m; }
    }
    return best;
  }
  function spoilerHit(pt) {
    if (!onSpoilerTap) return null;
    return edges.find((e) => {
      if (!e.spoiler || !e._vis) return false;
      const { x, y } = labelPos(e);
      return Math.abs(pt.x - x) < labelW(e) / 2 + 18 && Math.abs(pt.y - y) < labelH(e) / 2 + 12;
    });
  }

  // 작은 관계도는 화면 스크롤(pan-y)이 되게 두되, 인물을 눌렀을 땐 스크롤 대신 인물을 끌 수 있게
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (nodeHit(toLocal(t))) e.preventDefault();
  }, { passive: false });

  let drag = null; // 인물 조작 { n, start, moved, timer, linking }
  const nodeDown = (n, e) => {
    const pt = toLocal(e);
    drag = { n, dx: n.x - pt.x, dy: n.y - pt.y, sx: pt.x, sy: pt.y, moved: 0, linking: false, timer: 0, id: e.pointerId };
    n.fixed = true;
    if (onLink) {
      drag.timer = setTimeout(() => {
        if (!drag || drag.moved > 6) return;
        drag.linking = true;
        navigator.vibrate?.(25);
        temp = { from: n, x: drag.sx, y: drag.sy, target: null };
        render();
      }, 380);
    }
  };
  const nodeMove = (e) => {
    const pt = toLocal(e);
    const { n } = drag;
    if (drag.linking) {
      temp.x = pt.x; temp.y = pt.y; temp.target = nodeAt(pt, n);
      requestRender();
      return;
    }
    const nx = pt.x + drag.dx; const ny = pt.y + drag.dy;
    drag.moved += (Math.abs(nx - n.x) + Math.abs(ny - n.y)) * view.k;
    if (drag.moved < 6) return;
    clearTimeout(drag.timer);
    n.x = nx; n.y = ny;
    requestRender();
  };
  const nodeUp = (cancel) => {
    const d = drag; drag = null;
    clearTimeout(d.timer);
    d.n.fixed = false;
    if (d.linking) {
      const tgt = temp?.target;
      temp = null; render();
      if (!cancel && tgt) onLink?.(d.n.p, tgt.p);
      return;
    }
    if (cancel) return;
    if (d.moved < 6) {
      if (focus === d.n.p.id) onNodeTap?.(d.n.p);
      else setFocus(d.n.p.id);
    } else if (!focus) {
      // 놓은 자리에 고정. 다른 이름표와 겹치면 놓은 인물만 살짝 비킴, 나머지는 그대로
      const n = d.n; const others = [...nodes.values()].filter((m) => m !== n);
      for (let t = 0; t < 30; t++) {
        let any = false;
        for (const m of others) {
          const dx = n.x - m.x; const dy = n.y - m.y;
          const ox = (n.bw + m.bw) / 2 + 8 - Math.abs(dx); const oy = (n.bh + m.bh) / 2 + 4 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          any = true;
          if (ox / (n.bw + m.bw) < oy / (n.bh + m.bh)) n.x += (dx >= 0 ? 1 : -1) * ox; else n.y += (dy >= 0 ? 1 : -1) * oy;
        }
        if (!any) break;
      }
      n.pin = true;
      savePins();
      placeLabels();
      settled();
    } else { placeLabels(); render(); }
  };

  let inertia = 0;
  let wheelAnim = 0;
  const stopInertia = () => { cancelAnimationFrame(inertia); inertia = 0; };
  const clampK = (k) => Math.max(0.35, Math.min(3, k));
  const pts = new Map();
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let bgMoved = 0;
  let vel = { x: 0, y: 0, t: 0 };
  let userMoved = false;
  const beginView = () => { finishTween?.(true); cancelAnimationFrame(fitAnim); autoFit = false; userMoved = true; };
  const endView = () => { if (userMoved) { userMoved = false; settled(); } };

  canvas.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pts.size === 1) {
      finishTween?.(true);
      const pt = toLocal(e);
      const sp = spoilerHit(pt);
      if (sp) { drag = null; pan = null; pts.delete(e.pointerId); onSpoilerTap(sp.id); return; }
      const n = nodeHit(pt);
      if (n) { stopInertia(); nodeDown(n, e); return; }
    }
    // 두 번째 손가락이 오면 인물 조작은 그만두고 확대로
    if (drag && pts.size >= 2) { nodeUp(true); }
    bgMoved = 0;
    if (!zoomable) return;
    stopInertia();
    cancelAnimationFrame(wheelAnim); wheelAnim = 0;
    beginView();
    if (pts.size === 1) { pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; vel = { x: 0, y: 0, t: performance.now() }; }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const r = rect();
      const mx = (a.x + b.x) / 2 - r.left; const my = (a.y + b.y) / 2 - r.top;
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, wx: (mx - view.x) / view.k, wy: (my - view.y) / view.k };
      pan = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag && drag.id === e.pointerId) { nodeMove(e); return; }
    bgMoved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    if (!zoomable) return;
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const r = rect();
      const mx = (a.x + b.x) / 2 - r.left; const my = (a.y + b.y) / 2 - r.top;
      view.k = clampK(pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(pinch.d, 1)));
      view.x = mx - pinch.wx * view.k; view.y = my - pinch.wy * view.k;
    } else if (pan) {
      const now = performance.now();
      const dt = Math.max(1, now - vel.t);
      vel.x = 0.75 * ((e.clientX - prev.x) / dt) + 0.25 * vel.x;
      vel.y = 0.75 * ((e.clientY - prev.y) / dt) + 0.25 * vel.y;
      vel.t = now;
      view.x = pan.vx + (e.clientX - pan.x); view.y = pan.vy + (e.clientY - pan.y);
    }
    requestRender();
  });
  const up = (e, cancel) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (drag && drag.id === e.pointerId) { nodeUp(cancel); return; }
    if (zoomable) {
      if (pts.size === 1 && pinch) {
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
        if (!cancel && wasPan && Math.hypot(vx, vy) > 0.25) {
          let last = performance.now();
          const step = (now) => {
            const dt = Math.min(40, now - last); last = now;
            view.x += vx * dt; view.y += vy * dt;
            const decay = Math.pow(0.9, dt / 16);
            vx *= decay; vy *= decay;
            render();
            if (Math.hypot(vx, vy) > 0.02) inertia = requestAnimationFrame(step);
            else { inertia = 0; endView(); }
          };
          inertia = requestAnimationFrame(step);
        } else endView();
      }
    }
    if (cancel || bgMoved > 8) return;
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
  canvas.addEventListener('pointerup', (e) => up(e, false));
  canvas.addEventListener('pointercancel', (e) => up(e, true));
  if (zoomable) {
    let wheel = null;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      stopInertia();
      beginView();
      const r = rect();
      const mx = e.clientX - r.left; const my = e.clientY - r.top;
      if (!wheel) wheel = { k: view.k };
      wheel.k = clampK(wheel.k * Math.exp(-e.deltaY * 0.0015));
      wheel.mx = mx; wheel.my = my;
      if (wheelAnim) return;
      const step = () => {
        const nk = view.k + (wheel.k - view.k) * 0.25;
        const wx = (wheel.mx - view.x) / view.k; const wy = (wheel.my - view.y) / view.k;
        view.k = nk;
        view.x = wheel.mx - wx * nk; view.y = wheel.my - wy * nk;
        render();
        if (Math.abs(wheel.k - view.k) > 0.002) wheelAnim = requestAnimationFrame(step);
        else { wheelAnim = 0; wheel = null; endView(); }
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
            if (!a.fixed && !a.pin) a.x -= s; if (!b.fixed && !b.pin) b.x += s;
          } else {
            const s = (dy >= 0 ? 1 : -1) * oy * 0.5;
            if (!a.fixed && !a.pin) a.y -= s; if (!b.fixed && !b.pin) b.y += s;
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
      if (n.fixed || n.pin) { n.vx = 0; n.vy = 0; continue; }
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
      const fa = a.fixed || a.pin; const fb = b.fixed || b.pin;
      if (!fa) { a.x -= ux * m * (fb ? 2 : 1); a.y -= uy * m * (fb ? 2 : 1); }
      if (!fb) { b.x += ux * m * (fa ? 2 : 1); b.y += uy * m * (fa ? 2 : 1); }
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
          // 고정된 인물끼리는 그대로(직접 놓은 자리), 한쪽만 고정이면 다른 쪽이 다 비킴
          const ma = !(a.pin || a.fixed); const mb = !(b.pin || b.fixed);
          if (!ma && !mb) continue;
          any = true;
          const wa = ma && mb ? 0.5 : ma ? 1 : 0; const wb = ma && mb ? 0.5 : mb ? 1 : 0;
          if (ox / (a.bw + b.bw) < oy / (a.bh + b.bh)) { const s2 = (dx >= 0 ? 1 : -1) * ox; a.x -= s2 * wa; b.x += s2 * wb; }
          else { const s2 = (dy >= 0 ? 1 : -1) * oy; a.y -= s2 * wa; b.y += s2 * wb; }
        }
      }
      if (!any) break;
    }
  }

  // 전체가 화면에 들어오게 (작은 관계도는 축소만, 크게 보기는 확대도)
  function viewFor(x0, y0, x1, y1, w, h) {
    const pad = 14;
    const k = Math.max(0.35, Math.min(zoomable ? 1.6 : 1, (w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0)));
    return { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
  }
  function fitTargetFor(targets, focusId) {
    const { w, h } = size();
    const nr = focusId ? nearOf(focusId) : null;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of nodes.values()) {
      if (nr && !nr.has(n.p.id)) continue;
      const t = targets.get(n) || n;
      x0 = Math.min(x0, t.x - n.bw / 2); x1 = Math.max(x1, t.x + n.bw / 2);
      y0 = Math.min(y0, t.y - NODE_R - 4); y1 = Math.max(y1, t.y + n.bh - NODE_R);
    }
    return viewFor(x0, y0, x1, y1, w, h);
  }
  let fitAnim = 0;
  let autoFit = true;
  function fit(animate = true) {
    if (!nodes.size) return;
    autoFit = !focus;
    const target = fitTargetFor(new Map(), focus);
    if (!animate) { view = target; return; }
    stopInertia();
    cancelAnimationFrame(fitAnim);
    const from = { ...view }; let t0 = 0;
    const step = (now) => {
      if (!t0) t0 = now;
      const p = Math.min(1, (now - t0) / 420);
      const e = ease(p);
      view = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      render();
      if (p < 1) fitAnim = requestAnimationFrame(step);
      else { fitAnim = 0; settled(); }
    };
    fitAnim = requestAnimationFrame(step);
  }

  // 배치 바꾸기: 계산은 화면 밖에서 끝까지, 그 자리로 한 번에 미끄러지듯
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
    const viewTo = autoFit && !pts.size ? fitTargetFor(targets, null) : null;
    if (!moved) {
      for (const [n, t] of targets) { n.x = t.x; n.y = t.y; }
      placeLabels();
      if (viewTo) fit(true); else settled();
      return;
    }
    animateTo(targets, dur, viewTo);
  }
  function kick() {
    if (tween) return;
    if (focus) { placeLabels(); render(); return; }
    relax();
  }

  // 테스트·디버그용: 인물의 화면 위치
  canvas._gdebug = () => ({ focus, view: { ...view }, nodes: [...nodes.values()].map((n) => ({ id: n.p.id, name: n.p.name, x: n.x * view.k + view.x, y: n.y * view.k + view.y })) });
  return {
    setData,
    fit: () => { if (focus) setFocus(null); else fit(true); },
    focusOn: (id) => { if (nodes.has(id)) { if (focus === id) fit(true); else setFocus(id); return true; } return false; },
    clearFocus: () => { if (focus) setFocus(null); },
    // 자동 정리: 기억한 배치를 지우고 처음처럼 자동으로 다시 (부드럽게 이동)
    resetLayout: () => {
      if (focus) { for (const [n, q] of saved || []) { n.x = q.x; n.y = q.y; } focus = null; near = null; saved = null; }
      layout?.set({});
      for (const n of nodes.values()) { n.pin = false; n._extra = 0; }
      for (const e of edges) e._extra = 0;
      const start = new Map([...nodes.values()].map((n) => [n, { x: n.x, y: n.y }]));
      const { w, h } = size();
      const arr = [...nodes.values()];
      arr.forEach((n, i) => { const a = (i / arr.length) * Math.PI * 2; const R = K * Math.sqrt(arr.length) * 0.45; n.x = w / 2 + Math.cos(a) * R; n.y = h / 2 + Math.sin(a) * R; n.vx = 0; n.vy = 0; });
      alpha = 1;
      for (let i = 0; i < 320; i++) tick();
      separate(80);
      placeLabels();
      for (let round = 0; round < 4 && growHidden(); round++) { alpha = 0.5; for (let i = 0; i < 90; i++) tick(); separate(40); placeLabels(); }
      alpha = 0;
      const targets = new Map(arr.map((n) => [n, { x: n.x, y: n.y }]));
      for (const [n, q] of start) { n.x = q.x; n.y = q.y; }
      for (const n of arr) n.pin = true;
      autoFit = true;
      animateTo(targets, 800, fitTargetFor(targets, null), savePins);
    },
    destroy: () => {
      finishTween = null;
      ro.disconnect();
      for (const f of [rq, tween, inertia, wheelAnim, fitAnim, fadeAnim]) cancelAnimationFrame(f);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
