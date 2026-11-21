// 밑줄서재 — 3D 책장과 책 펼치기 (three.js)
import * as THREE from 'three';

export const ROWS = [
  { key: 'reading', label: '읽는 중' },
  { key: 'done', label: '다 읽은 책' },
  { key: 'want', label: '읽을 책' },
];
const ROW_H = 2.95;
const BOARD = 0.12;
const CASE_D = 1.9;
const FLAG_COLORS = ['#f2c94c', '#f28b82', '#81c995', '#8ab4f8', '#fdd663', '#c58af9'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// 책 표지 색: 서로 잘 구분되는 색 목록에서 고르고, 바로 옆 책과는 겹치지 않게
export const BOOK_COLORS = ['#7a2e2a', '#2f4a6b', '#3d6b4f', '#b5813a', '#5b3a6b', '#2d6a6e', '#a0522d', '#45494f', '#b0605a', '#6b7a2f', '#8a3d5c', '#3b5f8a'];
const assignedColors = new Map();
export function colorOf(id) { return assignedColors.get(id); }
export function bookColor(seed) {
  const h = hash(seed);
  return `hsl(${h % 360}, ${32 + ((h >> 9) % 28)}%, ${28 + ((h >> 17) % 22)}%)`;
}

function bookDims(b) {
  const h0 = hash(b.id);
  return {
    h: 2.05 + (h0 % 40) / 100,
    t: clamp(0.16 + ((b.pages || 300) / 1000) * 0.45, 0.16, 0.62),
    d: 1.45 + ((h0 >> 6) % 15) / 100,
    c: 0.035,
  };
}

function canvasTex(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function fitText(ctx, text, maxW, size, weight = 600, family = 'Pretendard, sans-serif') {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${family}`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 10);
  return s + 2;
}

function wrapLines(ctx, text, maxW, maxLines) {
  const out = [];
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW && line) {
      out.push(line);
      line = ch;
      if (out.length === maxLines) break;
    } else line += ch;
  }
  if (out.length < maxLines && line) out.push(line);
  return out;
}

function spineCanvas(b, dims, color) {
  const H = 1024;
  const W = Math.max(48, Math.round((H * dims.t) / dims.h));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, W, H);
  const g = x.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,.25)'); g.addColorStop(0.25, 'rgba(255,255,255,.08)');
  g.addColorStop(0.7, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.3)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(232,200,120,.85)';
  x.fillRect(0, 40, W, 6); x.fillRect(0, H - 46, W, 6);
  x.save();
  x.translate(W / 2, 90);
  x.rotate(Math.PI / 2);
  x.fillStyle = '#f7f1e3';
  const size = fitText(x, b.title, H - 330, Math.min(W * 0.55, 64), 700);
  x.font = `700 ${size}px Pretendard, sans-serif`;
  x.textBaseline = 'middle';
  x.fillText(b.title, 0, 0);
  x.restore();
  const author = (b.authors || [])[0] || '';
  if (author) {
    x.save();
    x.translate(W / 2, H - 200);
    x.rotate(Math.PI / 2);
    x.fillStyle = 'rgba(247,241,227,.75)';
    const s2 = fitText(x, author, 140, Math.min(W * 0.36, 34), 500);
    x.font = `500 ${s2}px Pretendard, sans-serif`;
    x.textBaseline = 'middle';
    x.fillText(author, 0, 0);
    x.restore();
  }
  return c;
}

function coverCanvas(b, dims, color) {
  const W = 512;
  const H = Math.round((W * dims.h) / dims.d);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,.06)';
  x.fillRect(0, 0, 26, H);
  x.fillStyle = '#f7f1e3';
  x.font = '700 46px "Gowun Batang", serif';
  const lines = wrapLines(x, b.title, W - 110, 4);
  lines.forEach((l, i) => x.fillText(l, 60, 150 + i * 62));
  const yLine = 150 + lines.length * 62 - 18;
  x.fillStyle = '#f2c94c';
  x.fillRect(60, yLine, Math.min(W - 120, 260), 10);
  x.fillStyle = 'rgba(247,241,227,.8)';
  x.font = '500 28px Pretendard, sans-serif';
  x.fillText((b.authors || []).join(', ').slice(0, 30), 60, H - 80);
  return c;
}

function woodCanvas() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#8a5a35'; x.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 60; i++) {
    x.strokeStyle = `rgba(${60 + Math.random() * 40},${30 + Math.random() * 20},10,${0.08 + Math.random() * 0.12})`;
    x.lineWidth = 1 + Math.random() * 2;
    x.beginPath();
    const y = Math.random() * 128;
    x.moveTo(0, y);
    for (let px = 0; px <= 512; px += 32) x.lineTo(px, y + Math.sin(px / 60 + i) * 3);
    x.stroke();
  }
  return c;
}

function labelCanvas(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 120;
  const x = c.getContext('2d');
  x.fillStyle = '#d9b56a';
  x.beginPath(); x.roundRect(4, 4, 504, 112, 18); x.fill();
  x.strokeStyle = 'rgba(80,50,10,.45)'; x.lineWidth = 4; x.stroke();
  x.fillStyle = '#3b2a12';
  x.font = '700 54px Pretendard, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 256, 62);
  return c;
}

export class Shelf {
  constructor(container, { onBookTap, onEmptyTap } = {}) {
    this.container = container;
    this.onBookTap = onBookTap;
    this.onEmptyTap = onEmptyTap;
    this.groups = new Map();
    this.tweens = [];
    this.dirty = true;
    this.topFrac = 0.42; // 책을 펼쳤을 때 위쪽에서 3D가 차지하는 비율
    this.openState = null;
    this.busy = false;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e8dfcf');
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    this.scene.add(new THREE.HemisphereLight('#fff8ec', '#8a7660', 1.6));
    const sun = new THREE.DirectionalLight('#fff3dc', 1.6);
    sun.position.set(-4, 9, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -14; sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -4;
    sun.shadow.bias = -0.002;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.mats = {
      page: new THREE.MeshStandardMaterial({ color: '#f3ecd9', roughness: 0.95 }),
      wood: new THREE.MeshStandardMaterial({ map: canvasTex(woodCanvas()), roughness: 0.8 }),
      back: new THREE.MeshStandardMaterial({ color: '#6e4528', roughness: 0.9 }),
    };

    this.caseGroup = new THREE.Group();
    this.scene.add(this.caseGroup);

    // 펼친 책 뒤를 어둡게 하는 막
    this.dim = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshBasicMaterial({ color: '#1d1610', transparent: true, opacity: 0, depthWrite: false }),
    );
    this.dim.visible = false;
    this.scene.add(this.dim);

    this.cam = { x: 0, y: 0, dist: 10, fitDist: 10, minDist: 4, maxDist: 12, W: 7, H: 9 };
    this.raycaster = new THREE.Raycaster();
    this._bindInput();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    const loop = () => {
      requestAnimationFrame(loop);
      this._step();
    };
    loop();
  }

  /* ---------- 렌더 루프 / 트윈 ---------- */
  _step() {
    const now = performance.now();
    if (this.tweens.length) {
      this.tweens = this.tweens.filter((tw) => {
        const p = clamp((now - tw.t0) / tw.dur, 0, 1);
        tw.fn(tw.ease(p));
        if (p >= 1) { tw.res(); return false; }
        return true;
      });
      this.dirty = true;
    }
    if (this.dirty) {
      this._applyCam();
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }
  tween(dur, fn, ease = easeInOut) {
    return new Promise((res) => this.tweens.push({ t0: performance.now(), dur, fn, ease, res }));
  }
  invalidate() { this.dirty = true; }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._fitCam(false);
    if (this.openState && !this.busy) this._placeOpenBook();
    this.dirty = true;
  }

  /* ---------- 카메라 ---------- */
  _tan() { return Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)); }
  _fitCam(reset) {
    const tan = this._tan();
    const { H } = this.cam;
    const fit = (H / 2 + 0.3) / tan;
    this.cam.fitDist = fit;
    this.cam.maxDist = fit * 1.08;
    this.cam.minDist = Math.min(fit, 4.2);
    if (reset) {
      this.cam.dist = fit;
      this.cam.y = H / 2;
      this.cam.x = -9999;
    }
    this._clampCam();
  }
  _clampCam() {
    const c = this.cam;
    if (!this.openState) c.dist = clamp(c.dist, c.minDist, c.maxDist);
    const tan = this._tan();
    const visH = 2 * c.dist * tan;
    const visW = visH * this.camera.aspect;
    const bx = Math.max(0, (c.W + 0.6) / 2 - visW / 2);
    const by = Math.max(0, (c.H + 0.4) / 2 - visH / 2);
    c.x = clamp(c.x, -bx, bx);
    c.y = clamp(c.y, c.H / 2 - by, c.H / 2 + by);
  }
  _applyCam() {
    this.camera.position.set(this.cam.x, this.cam.y, CASE_D / 2 + this.cam.dist);
    this.camera.lookAt(this.cam.x, this.cam.y, CASE_D / 2);
    this.camera.updateMatrixWorld();
  }

  /* ---------- 입력 ---------- */
  _bindInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    const pts = new Map();
    let start = null;
    let moved = 0;
    let pinch0 = null;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { start = { x: e.clientX, y: e.clientY }; moved = 0; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.cam.dist };
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (this.openState) return;
      if (pts.size === 2 && pinch0) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.cam.dist = pinch0.dist * (pinch0.d / Math.max(d, 1));
        moved += 20;
      } else if (pts.size === 1) {
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        moved += Math.abs(dx) + Math.abs(dy);
        const k = (2 * this.cam.dist * this._tan()) / el.clientHeight;
        this.cam.x -= dx * k;
        this.cam.y += dy * k;
      }
      this._clampCam();
      this.dirty = true;
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = null;
      if (pts.size === 0 && start && moved < 8) this._tap(e.clientX, e.clientY);
      if (pts.size === 0) start = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); start = null; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.openState) return;
      this.cam.dist *= Math.exp(e.deltaY * 0.0012);
      this._clampCam();
      this.dirty = true;
    }, { passive: false });
  }

  _tap(cx, cy) {
    if (this.busy) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = this.openState ? [this.openState.g] : [...this.groups.values()];
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    let o = hit?.object;
    while (o && !o.userData.bookId) o = o.parent;
    if (o) this.onBookTap?.(o.userData.bookId);
    else this.onEmptyTap?.();
  }

  /* ---------- 책장 만들기 ---------- */
  _disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) {
        if (Object.values(this.mats).includes(m)) continue;
        m.map?.dispose();
        m.dispose();
      }
    });
  }

  setBooks(books) {
    for (const g of this.groups.values()) { this.scene.remove(g); this._disposeGroup(g); }
    this.groups.clear();
    this._disposeGroup(this.caseGroup);
    this.caseGroup.clear();

    const gap = 0.03;
    const rows = ROWS.map((r) => ({ ...r, books: books.filter((b) => (b.status || 'reading') === r.key) }));
    const items = rows.map((r) => r.books.map((b) => ({ b, dims: bookDims(b) })));
    const rowW = items.map((list) => list.reduce((s, it) => s + it.dims.t + gap, 0));
    const W = Math.max(6.5, Math.max(...rowW) + 1.4);
    const H = ROWS.length * ROW_H + BOARD;
    const firstSetup = !this._didFit;
    this._didFit = true;
    this.cam.W = W; this.cam.H = H;

    // 책장 틀
    const add = (geo, mat, x, y, z, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.receiveShadow = true;
      m.castShadow = shadow;
      this.caseGroup.add(m);
      return m;
    };
    add(new THREE.BoxGeometry(W, H, 0.06), this.mats.back, 0, H / 2, -CASE_D / 2, false);
    add(new THREE.BoxGeometry(BOARD * 1.6, H + BOARD, CASE_D), this.mats.wood, -W / 2 - BOARD * 0.8, H / 2, 0);
    add(new THREE.BoxGeometry(BOARD * 1.6, H + BOARD, CASE_D), this.mats.wood, W / 2 + BOARD * 0.8, H / 2, 0);
    for (let i = 0; i <= ROWS.length; i++) {
      add(new THREE.BoxGeometry(W, BOARD, CASE_D), this.mats.wood, 0, i * ROW_H + BOARD / 2, 0);
    }
    // 바닥
    const floor = add(new THREE.PlaneGeometry(60, 30), new THREE.MeshStandardMaterial({ color: '#cbb89a', roughness: 1 }), 0, 0, 6, false);
    floor.rotation.x = -Math.PI / 2;

    rows.forEach((row, ri) => {
      const base = (ROWS.length - 1 - ri) * ROW_H + BOARD;
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(1.25, 0.3),
        new THREE.MeshStandardMaterial({ map: canvasTex(labelCanvas(`${row.label} · ${row.books.length}`)), roughness: 0.5, metalness: 0.2 }),
      );
      label.position.set(-W / 2 + 0.85, base - BOARD / 2, CASE_D / 2 + 0.012);
      this.caseGroup.add(label);

      let x = -W / 2 + 0.45;
      let prevIdx = -1;
      let prev2Idx = -1;
      items[ri].forEach(({ b, dims }) => {
        let idx = hash(b.id) % BOOK_COLORS.length;
        while (idx === prevIdx || idx === prev2Idx) idx = (idx + 1) % BOOK_COLORS.length;
        prev2Idx = prevIdx;
        prevIdx = idx;
        assignedColors.set(b.id, BOOK_COLORS[idx]);
        const g = this._buildBook(b, dims, BOOK_COLORS[idx]);
        g.position.set(x + dims.t / 2, base + dims.h / 2 + 0.002, CASE_D / 2 - dims.d / 2 - 0.06);
        g.userData.home = { pos: g.position.clone(), quat: g.quaternion.clone() };
        this.scene.add(g);
        this.groups.set(b.id, g);
        x += dims.t + gap;
      });
    });

    this.sun.target.position.set(0, H / 2, 0);
    this._fitCam(firstSetup);
    this.dirty = true;
  }

  _buildBook(b, dims, color) {
    const { h, t, d, c } = dims;
    const coverMat = new THREE.MeshStandardMaterial({ color, roughness: 0.65 });
    const spineMat = new THREE.MeshStandardMaterial({ map: canvasTex(spineCanvas(b, dims, color)), roughness: 0.6 });
    const outerMat = new THREE.MeshStandardMaterial({ map: canvasTex(coverCanvas(b, dims, color)), roughness: 0.6 });
    const innerMat = new THREE.MeshStandardMaterial({ color: '#efe6d0', roughness: 0.95 });
    const rightMat = new THREE.MeshStandardMaterial({ color: '#f6f0e0', roughness: 0.95 });

    const g = new THREE.Group();
    g.userData = { bookId: b.id, dims, mats: { innerMat, rightMat } };
    const mesh = (geo, mat, x, y, z, parent = g) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // 속지 덩어리 (+x 면이 펼쳤을 때 오른쪽 페이지)
    const bodyD = d - 0.04;
    mesh(new THREE.BoxGeometry(t - 2 * c, h - 0.06, bodyD),
      [rightMat, this.mats.page, this.mats.page, this.mats.page, this.mats.page, this.mats.page],
      0, 0, -0.02);
    // 뒤표지
    mesh(new THREE.BoxGeometry(c, h, d), coverMat, -t / 2 + c / 2, 0, 0);
    // 책등
    mesh(new THREE.BoxGeometry(t - 2 * c, h, c), [coverMat, coverMat, coverMat, coverMat, spineMat, coverMat], 0, 0, d / 2 - c / 2);
    // 앞표지 (책등 바깥 모서리에 경첩)
    const pivot = new THREE.Group();
    pivot.position.set(t / 2, 0, d / 2);
    g.add(pivot);
    mesh(new THREE.BoxGeometry(c, h, d), [outerMat, innerMat, coverMat, coverMat, coverMat, coverMat], -c / 2, 0, -d / 2, pivot);
    g.userData.pivot = pivot;

    // 글귀 플래그 (쪽 위치에 맞춰 위로 튀어나온 포스트잇)
    const pages = b.pages || Math.max(100, ...(b.quotePages || [0])) * 1.1;
    (b.quotePages || []).slice(0, 14).forEach((p, i) => {
      const ratio = clamp(p / pages, 0.02, 0.98);
      const fx = -t / 2 + c + ratio * (t - 2 * c);
      const m = mesh(new THREE.BoxGeometry(0.03, 0.3, 0.22),
        new THREE.MeshStandardMaterial({ color: FLAG_COLORS[i % FLAG_COLORS.length], roughness: 0.8 }),
        fx, h / 2 + 0.02, d / 2 - 0.16 - (i % 3) * 0.1);
      m.rotation.x = ((hash(b.id + i) % 9) - 4) * 0.02;
    });

    // 표지 이미지 (CORS가 허용되는 이미지일 때만 텍스처로 쓸 수 있음)
    if (b.cover) {
      new THREE.TextureLoader().setCrossOrigin('anonymous').load(b.cover, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        outerMat.map?.dispose();
        outerMat.map = tex;
        outerMat.needsUpdate = true;
        this.dirty = true;
      }, undefined, () => {});
    }
    return g;
  }

  /* ---------- 책 꺼내서 펼치기 ---------- */
  _openTarget(g) {
    const { h, d } = g.userData.dims;
    const tan = this._tan();
    const aspect = this.camera.aspect;
    const top = this.topFrac;
    const D = Math.max((h * 1.32) / (2 * top * tan), (2 * d * 1.18) / (2 * tan * aspect));
    const camPos = new THREE.Vector3(this.cam.x, this.cam.y, CASE_D / 2 + this.cam.dist);
    const ndcY = 1 - top * 1.06;
    const pos = new THREE.Vector3(camPos.x + d / 2, camPos.y + ndcY * D * tan, camPos.z - D);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0));
    return { pos, quat, D };
  }

  _placeOpenBook() {
    const { g } = this.openState;
    const { pos, quat } = this._openTarget(g);
    g.position.copy(pos);
    g.quaternion.copy(quat);
    this.dim.position.set(this.cam.x, this.cam.y, pos.z - 1.2);
    this.dirty = true;
  }

  setPageCanvases(left, right) {
    if (!this.openState) return;
    const { innerMat, rightMat } = this.openState.g.userData.mats;
    for (const [mat, cv] of [[innerMat, left], [rightMat, right]]) {
      if (!cv) continue;
      mat.map?.dispose();
      mat.map = canvasTex(cv);
      mat.color.set('#ffffff');
      mat.needsUpdate = true;
    }
    this.dirty = true;
  }

  async openBook(id, left, right) {
    if (this.busy) return;
    if (this.openState) {
      if (this.openState.id === id) return;
      await this.closeBook();
    }
    const g = this.groups.get(id);
    if (!g) return;
    this.busy = true;
    this.openState = { id, g };
    this.setPageCanvases(left, right);

    // 카메라가 너무 가까우면 책을 띄울 공간이 생기도록 살짝 뒤로
    const need = this._openTarget(g).D + 2.2;
    if (this.cam.dist < need) {
      const a = this.cam.dist;
      await this.tween(320, (p) => { this.cam.dist = a + (need - a) * p; });
    }

    const home = g.userData.home;
    const out = home.pos.clone().add(new THREE.Vector3(0, 0.05, g.userData.dims.d * 0.75));
    const { pos, quat } = this._openTarget(g);
    this.dim.visible = true;
    this.dim.position.set(this.cam.x, this.cam.y, pos.z - 1.2);

    await this.tween(260, (p) => g.position.lerpVectors(home.pos, out, p), easeOut);
    await this.tween(620, (p) => {
      g.position.lerpVectors(out, pos, p);
      g.quaternion.slerpQuaternions(home.quat, quat, p);
      this.dim.material.opacity = 0.55 * p;
    });
    const pivot = g.userData.pivot;
    await this.tween(650, (p) => { pivot.rotation.y = -Math.PI * 0.985 * p; });
    this.busy = false;
  }

  async closeBook() {
    if (!this.openState || this.busy) return;
    this.busy = true;
    const { g } = this.openState;
    const home = g.userData.home;
    const pivot = g.userData.pivot;
    const from = g.position.clone();
    const fromQ = g.quaternion.clone();
    const out = home.pos.clone().add(new THREE.Vector3(0, 0.05, g.userData.dims.d * 0.75));
    await this.tween(420, (p) => { pivot.rotation.y = -Math.PI * 0.985 * (1 - p); });
    await this.tween(520, (p) => {
      g.position.lerpVectors(from, out, p);
      g.quaternion.slerpQuaternions(fromQ, home.quat, p);
      this.dim.material.opacity = 0.55 * (1 - p);
    });
    await this.tween(220, (p) => g.position.lerpVectors(out, home.pos, p), easeOut);
    this.dim.visible = false;
    const { innerMat, rightMat } = g.userData.mats;
    for (const m of [innerMat, rightMat]) { m.map?.dispose(); m.map = null; m.color.set('#f3ecd9'); m.needsUpdate = true; }
    this.openState = null;
    this.busy = false;
    this.dirty = true;
  }

  // 특정 책이 보이도록 카메라 이동
  focusBook(id) {
    const g = this.groups.get(id);
    if (!g) return;
    this.cam.x = g.position.x;
    this.cam.y = g.position.y;
    this._clampCam();
    this.dirty = true;
  }
}
