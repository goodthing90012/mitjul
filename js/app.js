// 밑줄서재 — 앱 본체
import { db, uid } from './db.js';
import { lookupISBN, searchTitle, cleanISBN, isISBN13, getKakaoKey } from './bookapi.js';
import { startScan, decodeImageFile } from './scanner.js';
import { fileToCanvas, recognizeAuto, rotateCanvas, cropCanvas, findPageNumber, fitForOcr, joinWords, WORD_END } from './ocr.js';
import { createGraph, REL_KINDS, ALIAS_KINDS, familyColor, visibleAliases, marriedVisible } from './graph.js';
import { Shelf, bookColor, colorOf } from './shelf3d.js';
import { parseText, guessKind, ALIAS_WORDS } from './peopletext.js';

const APP_VERSION = '1.6.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { reading: '읽는 중', done: '다 읽음', want: '읽을 책' };
const HONORIFICS = /(\s*(양|씨|님|군|부인|여사|아가씨|도련님|경|선생|선생님|씨네))$/;
const EN_TITLES = /^(mr|mrs|ms|miss|dr|sir|lady|lord|madame|mme|monsieur|mademoiselle)\.?\s+/i;

const state = {
  books: [],
  current: null, // { book, quotes, people, relations }
  tab: 'quotes',
  shelfDirty: false,
  graph: null,
  graphPage: null,
};

/* ================= 레이어(뒤로가기) ================= */
const layers = [];
let ignorePop = 0;
let popWaiters = [];
function pushLayer(close) {
  layers.push(close);
  history.pushState({ n: layers.length }, '');
}
function back() { if (layers.length) history.back(); }
function closeTop() {
  return new Promise((resolve) => {
    const c = layers.pop();
    if (!c) return resolve();
    c();
    ignorePop++;
    popWaiters.push(resolve);
    history.back();
    setTimeout(() => { const i = popWaiters.indexOf(resolve); if (i >= 0) { popWaiters.splice(i, 1); resolve(); } }, 400);
  });
}
addEventListener('popstate', () => {
  if (ignorePop) {
    ignorePop--;
    const w = popWaiters.shift();
    w?.();
    return;
  }
  const c = layers.pop();
  c?.();
});

/* ================= 공통 UI ================= */
let toastTimer;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  // 글자 수에 맞춰 충분히 보여주기 (최소 3.5초), 누르면 닫힘
  toastTimer = setTimeout(() => t.classList.remove('on'), ms || Math.max(3500, msg.length * 120));
  t.onclick = () => t.classList.remove('on');
}
function notice(el, html, kind = 'warn') {
  el.innerHTML = `<div class="notice ${kind}">${html}</div>`;
}

function openSheet(html, { full = false, onClose, cls = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-bg"></div><div class="sheet ${full ? 'full' : ''} ${cls}"><div class="drag-zone" title="위로 올리면 전체 화면, 내리면 원래대로"><div class="sheet-grab"></div></div><button class="sheet-x" aria-label="닫기">✕</button><div class="sheet-body">${html}</div></div>`;
  $('#sheetRoot').append(wrap);
  const sheet = wrap.querySelector('.sheet');
  const sbody = wrap.querySelector('.sheet-body');
  // 시트는 항상 화면 높이이고, 아래로 밀어둔 거리(--off)만 바꿔서 움직임 → GPU로 부드럽게
  const naturalOff = () => {
    const H = innerHeight;
    if (full) return Math.round(H * 0.06);
    const need = wrap.querySelector('.drag-zone').offsetHeight + sbody.offsetHeight + 28 + safeBottom();
    return Math.round(Math.max(H * 0.08, H - need));
  };
  const apply = (expanded) => {
    sheet.classList.toggle('expanded', expanded);
    const off = expanded ? 0 : naturalOff();
    setOff(sheet, off);
    sheet.style.paddingBottom = `calc(${off}px + var(--safe-b) + 20px)`;
  };
  apply(false);
  void sheet.offsetHeight;
  requestAnimationFrame(() => wrap.classList.add('on'));
  // 내용이 바뀌면(스캔 결과 등) 높이 다시 맞추기
  const ro = new ResizeObserver(() => { if (!sheet.classList.contains('expanded') && !sheet.classList.contains('dragging')) apply(false); });
  ro.observe(sbody);
  const close = () => {
    ro.disconnect();
    onClose?.();
    wrap.classList.remove('on');
    setTimeout(() => wrap.remove(), 360);
  };
  pushLayer(close);
  wrap.querySelector('.sheet-bg').onclick = back;
  wrap.querySelector('.sheet-x').onclick = back;
  bindDrag(wrap.querySelector('.drag-zone'), sheet, (dy, v) => {
    const expanded = sheet.classList.contains('expanded');
    if (expanded) apply(!(dy > 60 || v > 0.5));
    else if (dy < -40 || v < -0.5) apply(true);
    else if (dy > 110 || v > 0.8) back();
    else apply(false);
  });
  return sbody;
}

function safeBottom() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--safe-b-px');
  return parseFloat(v) || 0;
}
function setOff(el, px) { el.style.setProperty('--off', px + 'px'); }
function getOff(el) { return parseFloat(el.style.getPropertyValue('--off')) || 0; }

// 손잡이를 끄는 동안 손가락을 1:1로 따라가고, 놓으면 onEnd(이동거리, 속도)로 자리 결정
function bindDrag(zone, el, onEnd) {
  let st = null;
  zone.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    st = { y: e.clientY, off: getOff(el), id: e.pointerId, lastY: e.clientY, lastT: performance.now(), v: 0 };
    try { zone.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
  });
  zone.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const now = performance.now();
    const dt = Math.max(1, now - st.lastT);
    st.v = 0.7 * ((e.clientY - st.lastY) / dt) + 0.3 * st.v; // 손을 놓을 때의 속도(플릭) 판단용
    st.lastY = e.clientY; st.lastT = now;
    const off = Math.min(innerHeight, Math.max(0, st.off + (e.clientY - st.y)));
    setOff(el, off);
  });
  const end = (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dy = e.clientY - st.y;
    const v = performance.now() - st.lastT > 120 ? 0 : st.v;
    st = null;
    el.classList.remove('dragging');
    onEnd(dy, v);
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
}

const icon = {
  search: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 3 3 2-2 4 4"/></svg>',
  paste: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 12h6M9 16h4"/></svg>',
  barcode: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6v12M7 6v12M11 6v12M14 6v12M18 6v12M20 6v12"/></svg>',
};

/* ================= 데이터 ================= */
// 쪽수 순, 쪽수 없는 밑줄은 맨 아래
const pageKey = (q) => q.page || Infinity;

async function loadBooks() {
  state.books = (await db.all('books')).sort((a, b) => a.createdAt - b.createdAt);
}

async function loadCurrent(bookId) {
  const book = await db.get('books', bookId);
  if (!book) { state.current = null; return; }
  const [quotes, people, relations] = await Promise.all([
    db.byBook('quotes', bookId), db.byBook('people', bookId), db.byBook('relations', bookId),
  ]);
  quotes.sort((a, b) => (pageKey(a) === pageKey(b) ? a.createdAt - b.createdAt : pageKey(a) - pageKey(b)));
  people.sort((a, b) => (a.firstPage || 0) - (b.firstPage || 0) || a.createdAt - b.createdAt);
  // 스포일러 방지: AI로 가져온 건 가려진 채로 들어오고, '지금 몇 장'에 닿거나 직접 열어야 보임
  const ch = book.chapter || 0;
  const shown = people.filter((p) => isRevealed(p, ch)).map((p) => sanitizePerson(p, ch));
  const ids = new Set(shown.map((p) => p.id));
  const relShown = relations.filter((r) => isRevealed(r, ch) && ids.has(r.from) && ids.has(r.to));
  const relIds = new Set(relShown.map((r) => r.id));
  state.current = {
    book, quotes, people: shown, relations: relShown,
    allPeople: people, allRelations: relations,
    hiddenPeople: people.filter((p) => !ids.has(p.id)),
    hiddenRels: relations.filter((r) => !relIds.has(r.id)),
  };
}

/* ---------- 가림(스포일러 방지) ---------- */
const chOK = (x, ch) => !!(x.chapter && ch && x.chapter <= ch);
function isRevealed(x, ch) { return !x.hidden || chOK(x, ch); }
// 보이는 인물에서도 아직 가려진 다른 이름·결혼 정보는 빼서 보여줌 (저장할 땐 restoreHidden으로 되돌림)
function sanitizePerson(p, ch) {
  const vis = []; const hid = [];
  for (const a of p.aliases || []) (isRevealed(a, ch) ? vis : hid).push(a);
  const out = { ...p, aliases: vis, _hiddenAliases: hid };
  if (p.marriedFamily && p.marriedHidden && !(p.marriedChapter && ch && p.marriedChapter <= ch)) {
    out._hiddenMarried = { marriedFamily: p.marriedFamily, marriedPage: p.marriedPage || 0, marriedChapter: p.marriedChapter || 0, marriedHidden: true };
    out.marriedFamily = ''; out.marriedPage = 0;
  }
  return out;
}
function restoreHidden(p) {
  const out = { ...p, aliases: [...(p.aliases || []), ...(p._hiddenAliases || [])] };
  if (p._hiddenMarried && !p.marriedFamily) Object.assign(out, p._hiddenMarried);
  delete out._hiddenAliases; delete out._hiddenMarried;
  return out;
}
async function revealPerson(id) {
  const raw = state.current.allPeople.find((x) => x.id === id);
  if (!raw) return;
  const p = { ...raw, hidden: false };
  if (!p.firstPage) p.firstPage = currentReadPage();
  // 결혼 후 이름처럼 뒤에 드러나는 이름은 계속 가려둠
  p.aliases = (p.aliases || []).map((a) => (a.hidden && a.kind !== '결혼 후 이름' ? { ...a, hidden: false } : a));
  await db.put('people', p);
  await afterChange();
  toast(`${p.name}을(를) 열었어요`);
}
async function revealRelation(id) {
  const raw = state.current.allRelations.find((x) => x.id === id);
  if (!raw) return;
  await db.put('relations', { ...raw, hidden: false, page: raw.page || currentReadPage() });
  await afterChange();
}
async function revealAll() {
  if (!confirm('가려진 인물·관계·이름을 모두 열까요?\n결말까지의 정보가 보일 수 있어요.')) return;
  for (const p of state.current.allPeople) {
    if (p.hidden || p.marriedHidden || (p.aliases || []).some((a) => a.hidden)) {
      await db.put('people', { ...p, hidden: false, marriedHidden: false, aliases: (p.aliases || []).map((a) => ({ ...a, hidden: false })) });
    }
  }
  for (const r of state.current.allRelations) if (r.hidden) await db.put('relations', { ...r, hidden: false });
  await afterChange();
}
async function setChapter(v) {
  const book = { ...state.current.book, chapter: Math.max(0, v | 0) };
  await db.put('books', book);
  const before = state.current.people.length + state.current.relations.length;
  await afterChange();
  const after = state.current.people.length + state.current.relations.length;
  if (after > before) toast(`${book.chapter}장까지 나온 ${after - before}개가 열렸어요`);
}

function bookPages(book, quotes) {
  if (book.pages) return book.pages;
  const maxQ = Math.max(0, ...quotes.map((q) => q.page || 0));
  return Math.max(100, Math.ceil(maxQ * 1.1));
}

function parseTags(s) {
  return [...new Set(String(s || '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];
}

/* ================= 3D 책장 ================= */
let shelf;
async function reloadShelf() {
  await loadBooks();
  if (shelf.openState) { state.shelfDirty = true; return; }
  const quotes = await db.all('quotes');
  const byBook = {};
  for (const q of quotes) (byBook[q.bookId] ||= []).push(q.page || 0);
  shelf.setBooks(state.books.map((b) => ({ ...b, quotePages: (byBook[b.id] || []).sort((a, c) => a - c) })));
  state.shelfDirty = false;
  $('#emptyHint').hidden = state.books.length > 0;
  renderToday(quotes);
}

function renderToday(quotes) {
  const el = $('#today');
  if (!quotes.length || state.current) { el.hidden = true; return; }
  const d = new Date();
  const seed = d.getFullYear() * 1000 + d.getMonth() * 40 + d.getDate();
  const pool = quotes.filter((x) => !x.draft);
  if (!pool.length) { el.hidden = true; return; }
  const sorted = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1));
  const q = sorted[seed % sorted.length];
  const b = state.books.find((x) => x.id === q.bookId);
  if (!b) { el.hidden = true; return; }
  el.innerHTML = `<div class="today-label">오늘의 한 줄</div>${q.text ? `<p class="today-text"><span class="hl">${esc(q.text)}</span></p>` : ''}${q.image && !q.text ? `<img class="today-img" src="${q.image}" alt="">` : ''}<div class="today-src">${esc(b.title)} · p.${q.page || '?'}</div>`;
  el.hidden = false;
  el.onclick = () => openBook(b.id, q.id);
}

/* 펼친 책 안쪽 페이지 그림 */
function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function wrap(ctx, text, maxW) {
  const out = [];
  let line = '';
  for (const ch of String(text).replace(/\s+/g, ' ')) {
    if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch.trim() ? ch : ''; } else line += ch;
  }
  if (line) out.push(line);
  return out;
}
function paper(x, w, h, gutterLeft) {
  x.fillStyle = '#f6efdc'; x.fillRect(0, 0, w, h);
  const g = gutterLeft ? x.createLinearGradient(0, 0, 70, 0) : x.createLinearGradient(w, 0, w - 70, 0);
  g.addColorStop(0, 'rgba(90,60,20,.28)'); g.addColorStop(1, 'rgba(90,60,20,0)');
  x.fillStyle = g;
  if (gutterLeft) x.fillRect(0, 0, 70, h); else x.fillRect(w - 70, 0, 70, h);
}
function leftPageCanvas() {
  const { book, quotes, people } = state.current;
  const [c, x] = mkCanvas(512, 760);
  paper(x, 512, 760, false);
  x.fillStyle = '#2b2622';
  x.font = '700 40px "Gowun Batang", serif';
  const lines = wrap(x, book.title, 400).slice(0, 4);
  lines.forEach((l, i) => x.fillText(l, 50, 120 + i * 54));
  let y = 120 + lines.length * 54;
  x.fillStyle = 'rgba(242,201,76,.75)'; x.fillRect(50, y - 30, 200, 12);
  x.fillStyle = '#6b5f55'; x.font = '500 24px Pretendard, sans-serif';
  x.fillText((book.authors || []).join(', ').slice(0, 26), 50, y + 30);
  y += 110;
  x.fillStyle = '#2b2622'; x.font = '700 30px Pretendard, sans-serif';
  x.fillText(`밑줄 ${quotes.length}개`, 50, y);
  x.fillText(`인물 ${people.length}명`, 50, y + 48);
  x.fillStyle = '#6b5f55'; x.font = '500 24px Pretendard, sans-serif';
  x.fillText(`${STATUS[book.status || 'reading']}${book.pages ? ` · ${book.pages}쪽` : ''}`, 50, y + 96);
  // 미니 페이지 막대
  const pages = bookPages(book, quotes);
  const by = 640;
  x.fillStyle = 'rgba(43,38,34,.15)'; x.fillRect(50, by, 400, 6);
  x.fillStyle = '#c8553d';
  for (const q of quotes) { x.beginPath(); x.arc(50 + Math.min(1, (q.page || 0) / pages) * 400, by + 3, 8, 0, Math.PI * 2); x.fill(); }
  x.fillStyle = '#a2968a'; x.font = '500 20px Pretendard, sans-serif';
  x.fillText('1', 46, by + 40); x.textAlign = 'right'; x.fillText(String(pages), 454, by + 40);
  x.textAlign = 'left'; x.fillText('밑줄서재', 50, 730);
  return c;
}
const imgCache = new Map();
function cachedImg(src) {
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.onload = () => refreshPages(); im.src = src; imgCache.set(src, im); }
  return im.complete && im.naturalWidth ? im : null;
}
function rightPageCanvas() {
  const { quotes } = state.current;
  const [c, x] = mkCanvas(512, 760);
  paper(x, 512, 760, true);
  x.fillStyle = '#a2968a'; x.font = '600 22px Pretendard, sans-serif';
  x.fillText('밑줄 그은 문장', 70, 70);
  if (!quotes.length) {
    x.fillStyle = '#6b5f55'; x.font = '400 28px "Gowun Batang", serif';
    x.fillText('아직 밑줄이 없어요.', 70, 340);
    x.fillText('아래에서 첫 밑줄을', 70, 390);
    x.fillText('그어보세요.', 70, 440);
    return c;
  }
  let y = 120;
  for (const q of quotes) {
    x.font = '400 26px "Gowun Batang", serif';
    const lines = q.text ? wrap(x, q.text + (q.draft ? '…' : ''), 380).slice(0, q.image ? 1 : 3) : [];
    const im = q.image ? cachedImg(q.image) : null;
    const imgH = q.image ? (im ? Math.min(150, (380 * im.naturalHeight) / im.naturalWidth) : 60) : 0;
    const need = 36 + imgH + (imgH ? 10 : 0) + lines.length * 40 + 24;
    if (y + need > 730) break;
    x.fillStyle = '#c8553d'; x.font = '700 20px Pretendard, sans-serif';
    x.fillText(`${q.draft ? '🔖 ' : ''}p.${q.page || '?'}`, 70, y);
    y += 20;
    if (q.image) {
      if (im) {
        const w = Math.min(380, (imgH * im.naturalWidth) / im.naturalHeight);
        x.drawImage(im, 70, y, w, imgH);
      } else { x.fillStyle = 'rgba(43,38,34,.08)'; x.fillRect(70, y, 380, imgH); }
      y += imgH + 10;
    }
    y += 16;
    x.font = '400 26px "Gowun Batang", serif';
    lines.forEach((l) => {
      const w = x.measureText(l).width;
      if (!q.draft) { x.fillStyle = 'rgba(242,201,76,.55)'; x.fillRect(68, y - 12, w + 4, 14); }
      x.fillStyle = q.draft ? '#8a7e72' : '#2b2622'; x.fillText(l, 70, y);
      y += 40;
    });
    y += 24 - (lines.length ? 0 : 16);
  }
  return c;
}
function refreshPages() {
  if (state.current && shelf.openState) shelf.setPageCanvases(leftPageCanvas(), rightPageCanvas());
}

/* ================= 책 열기 / 패널 ================= */
async function openBook(id, focusQuoteId) {
  if (shelf.busy) return;
  await loadCurrent(id);
  if (!state.current) return;
  state.tab = 'quotes';
  state.graphPage = null;
  document.body.classList.add('book-open');
  $('#today').hidden = true;
  setPanel(false);
  renderPanel();
  $('#bookPanel').hidden = false;
  requestAnimationFrame(() => $('#bookPanel').classList.add('on'));
  pushLayer(closeBookUI);
  if (focusQuoteId) setTimeout(() => focusQuote(focusQuoteId), 350);
  shelf.focusBook(id);
  shelf.topFrac = panelOff() / innerHeight;
  await shelf.openBook(id, leftPageCanvas(), rightPageCanvas());
}

function closeBookUI() {
  document.body.classList.remove('book-open');
  const p = $('#bookPanel');
  p.classList.remove('on');
  setTimeout(() => { p.hidden = true; p.classList.remove('expanded'); }, 300);
  state.graph?.destroy();
  state.graph = null;
  state.current = null;
  const doClose = async () => {
    if (shelf.busy) { setTimeout(doClose, 100); return; }
    await shelf.closeBook();
    if (state.shelfDirty) await reloadShelf();
    else renderToday(await db.all('quotes'));
  };
  doClose();
}

function focusQuote(qid) {
  const el = $(`.q[data-id="${qid}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1500);
}

function nameIndex(people) {
  // 이름·애칭·호칭 → 인물
  const list = [];
  for (const p of people) {
    for (const n of [p.name, ...(p.aliases || []).map((a) => a.name)]) {
      if (n && n.trim().length >= 2) list.push({ n: n.trim(), p });
    }
  }
  list.sort((a, b) => b.n.length - a.n.length);
  return list;
}

function linkNames(text, people) {
  const idx = nameIndex(people);
  let html = esc(text);
  if (!idx.length) return html;
  const re = new RegExp(idx.map((x) => esc(x.n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return html.replace(re, (m) => {
    const hit = idx.find((x) => esc(x.n) === m);
    return hit ? `<span class="nm" data-pid="${hit.p.id}" style="--fc:${familyColor(hit.p.family)}">${m}</span>` : m;
  });
}

// 책 패널: 기본은 화면 42% 지점, 펼치면 맨 위까지
function panelOff() { return Math.round(innerHeight * (innerWidth >= 900 ? 0.44 : 0.42)); }
function setPanel(expanded) {
  const panel = $('#bookPanel');
  panel.classList.toggle('expanded', expanded);
  const off = expanded ? 0 : panelOff();
  setOff(panel, off);
  panel.style.paddingBottom = `calc(${off}px + var(--safe-b) + 90px)`;
}
addEventListener('resize', () => { if (state.current) setPanel($('#bookPanel').classList.contains('expanded')); });

function renderPanel() {
  const { book, quotes, people } = state.current;
  const pages = bookPages(book, quotes);
  const cover = book.cover
    ? `<img class="bp-cover" src="${esc(book.cover)}" alt="" referrerpolicy="no-referrer">`
    : `<div class="bp-cover ph" style="background:${colorOf(book.id) || bookColor(book.id + book.title)}">${esc([...book.title][0] || '')}</div>`;
  const dots = quotes.map((q) => `<button class="pb-dot" data-q="${q.id}" style="left:${Math.min(100, ((q.page || 0) / pages) * 100)}%" title="p.${q.page}"></button>`).join('');
  $('#bookPanel').innerHTML = `
    <div class="drag-zone" id="bpDrag"><div class="bp-grab"></div></div>
    <div class="bp-head">
      ${cover}
      <div class="bp-info">
        <h2>${esc(book.title)}</h2>
        <div class="bp-auth">${esc((book.authors || []).join(', '))}</div>
        <div class="bp-meta">
          <select id="bpStatus">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === (book.status || 'reading') ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span>${book.pages ? `${book.pages}쪽` : '<button class="link" id="bpSetPages">쪽수 입력</button>'}</span>
        </div>
      </div>
      <button class="ghost" id="bpEdit">편집</button>
    </div>
    <div class="pagebar">
      <div class="pb-track">${dots}</div>
      <div class="pb-labels"><span>1</span><span>${quotes.length ? `밑줄 ${quotes.length}개` : '아직 밑줄 없음'}</span><span>${pages}${book.pages ? '' : '?'}</span></div>
    </div>
    <div class="tabs">
      <button data-tab="quotes" class="${state.tab === 'quotes' ? 'on' : ''}">밑줄 <b>${quotes.length}</b></button>
      <button data-tab="people" class="${state.tab === 'people' ? 'on' : ''}">인물 <b>${people.length}</b></button>
    </div>
    <div class="tab-body" id="tabBody"></div>
`;
  // 아래 버튼은 패널 밖(화면 고정)에 두어 스크롤·전체 화면 전환과 상관없이 항상 바닥에 붙어 있게
  $('#bpActions').innerHTML = state.tab === 'quotes'
    ? `<button class="primary" id="addQuote">＋ 밑줄 긋기</button><button class="ghost" id="addMark">🔖 책갈피</button>`
    : `<button class="primary" id="addPerson">＋ 인물</button><button class="ghost" id="addRel">＋ 관계</button><button class="ghost" id="addFamily">👪 가족</button>`;

  const panel = $('#bookPanel');
  bindDrag($('#bpDrag'), panel, (dy, v) => {
    const expanded = panel.classList.contains('expanded');
    setPanel(expanded ? !(dy > 60 || v > 0.5) : (dy < -40 || v < -0.5));
  });
  $('#bpStatus').onchange = async (e) => {
    book.status = e.target.value;
    await db.put('books', book);
    state.shelfDirty = true;
    refreshPages();
    toast(`'${STATUS[book.status]}' 칸으로 옮길게요`);
  };
  $('#bpSetPages') && ($('#bpSetPages').onclick = () => editBookSheet());
  $('#bpEdit').onclick = () => editBookSheet();
  $$('.tabs button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; state.selMode = null; renderPanel(); }));
  $$('.pb-dot').forEach((d) => (d.onclick = () => { if (state.tab !== 'quotes') { state.tab = 'quotes'; renderPanel(); } focusQuote(d.dataset.q); }));
  if (state.tab === 'quotes') {
    $('#addQuote').onclick = () => quoteSheet();
    $('#addMark').onclick = () => bookmarkSheet();
    renderQuotes();
  } else {
    $('#addPerson').onclick = () => personSheet();
    $('#addRel').onclick = () => relationSheet();
    $('#addFamily').onclick = () => familySheet();
    renderPeople();
  }
}

function renderQuotes() {
  const { quotes, people } = state.current;
  const body = $('#tabBody');
  if (!quotes.length) {
    body.innerHTML = `<div class="empty">마음에 남은 문장이 있으면 <b>＋ 밑줄 긋기</b>로,<br>읽는 흐름을 끊기 싫으면 <b>🔖 책갈피</b>로 쪽수만 남겨두세요.<br><small>사진 위에 형광펜을 그으면 그대로 밑줄이 돼요.</small></div>
      <button class="link wide" id="importLink">메모장에 적어둔 글귀 가져오기</button>`;
    $('#importLink').onclick = () => importSheet();
    return;
  }
  const drafts = quotes.filter((q) => q.draft);
  if (!drafts.length) state.onlyDrafts = false;
  const list = state.onlyDrafts ? drafts : quotes;
  body.innerHTML = `<div class="q-head">${drafts.length ? `<button class="chip ${state.onlyDrafts ? 'on' : ''}" id="draftChip">🔖 채울 밑줄 ${drafts.length}</button>` : '<span></span>'}<button class="link" id="importLink">메모장에서 가져오기</button></div>` +
    list.map((q) => `
    <article class="q ${q.draft ? 'draft' : ''}" data-id="${q.id}">
      <div class="q-page">p.${q.page || '?'}${q.draft ? '<span class="badge">🔖 채우기</span>' : ''}</div>
      ${q.image ? `<img class="q-img" src="${q.image}" alt="사진 밑줄">` : ''}
      ${q.text ? (q.draft ? `<blockquote class="draft-text">${esc(q.text)}…</blockquote>` : `<blockquote><span class="hl">${linkNames(q.text, people)}</span></blockquote>`) : ''}
      ${q.note ? `<p class="q-note">${esc(q.note)}</p>` : ''}
      ${q.tags?.length ? `<div class="tags">${q.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    </article>`).join('');
  $('#importLink').onclick = () => importSheet();
  $('#draftChip') && ($('#draftChip').onclick = () => { state.onlyDrafts = !state.onlyDrafts; renderQuotes(); });
  $$('.q', body).forEach((a) => (a.onclick = (e) => {
    const nm = e.target.closest('.nm');
    const q = quotes.find((x) => x.id === a.dataset.id);
    if (nm) { e.stopPropagation(); personPopover(nm.dataset.pid, q.page || 0); return; }
    quoteSheet(q);
  }));
}

/* ================= 인물 ================= */
function normalizeName(s) {
  return String(s || '').trim().replace(EN_TITLES, '').replace(HONORIFICS, '').trim().toLowerCase();
}

function findPeople(query, page) {
  const q = normalizeName(query);
  if (!q) return [];
  const { people } = state.current;
  const out = [];
  for (const p of people) {
    if ((p.firstPage || 0) > page) continue;
    const names = [{ name: p.name, kind: '대표 이름' }, ...visibleAliases(p, page)];
    if (p.family) names.push({ name: p.family, kind: '가문' });
    if (marriedVisible(p, page)) names.push({ name: p.marriedFamily, kind: '결혼 후 가문' });
    const hit = names.find((n) => normalizeName(n.name).includes(q) || q.includes(normalizeName(n.name)) && normalizeName(n.name).length >= 2);
    if (hit) out.push({ p, hit });
  }
  return out;
}

function personCard(p, page, hit, checked) {
  const al = visibleAliases(p, page);
  const married = marriedVisible(p, page);
  return `<div class="pcard ${checked ? 'picked' : ''}" data-pid="${p.id}">${checked !== undefined ? `<span class="ck ${checked ? 'on' : ''}"></span>` : ''}
    <div class="pc-dot" style="background:${familyColor(p.family)};${married ? `box-shadow:0 0 0 3px ${familyColor(p.marriedFamily)}` : ''}"></div>
    <div class="pc-main">
      <div class="pc-name">${esc(p.name)} ${p.family ? `<span class="fam" style="--fc:${familyColor(p.family)}">${esc(p.family)}</span>` : ''}${married ? ` → <span class="fam" style="--fc:${familyColor(p.marriedFamily)}">${esc(p.marriedFamily)}</span>` : ''}</div>
      ${hit && hit.kind !== '대표 이름' ? `<div class="pc-hit">‘${esc(hit.name)}’은(는) ${esc(hit.kind)}예요</div>` : ''}
      ${al.length ? `<div class="aliases">${al.map((a) => `<span class="alias"><i>${esc(a.kind)}</i>${esc(a.name)}${a.page ? `<small>p.${a.page}</small>` : ''}</span>`).join('')}</div>` : ''}
      ${p.desc ? (p.descSpoiler ? `<div class="pc-desc spoil-blur" data-unblur title="톡해서 보기"><span>${esc(p.desc)}</span><em>AI 설명 · 스포 주의 · 톡해서 보기</em></div>` : `<div class="pc-desc">${esc(p.desc)}</div>`) : ''}
    </div>
  </div>`;
}

function personPopover(pid, page) {
  const p = state.current.people.find((x) => x.id === pid);
  if (!p) return;
  const body = openSheet(`<h3>이 이름은</h3>${personCard(p, page || 99999)}<button class="ghost wide" id="ppEdit">인물 편집</button>`);
  $('#ppEdit', body).onclick = async () => { await closeTop(); personSheet(p); };
}

function renderPeople() {
  const { book, quotes, people, relations } = state.current;
  const pages = bookPages(book, quotes);
  const maxP = Math.max(pages, ...people.map((p) => p.firstPage || 0), ...relations.map((r) => r.page || 0));
  if (state.graphPage == null) state.graphPage = maxP;
  state.graphMax = maxP;
  const page = Math.min(state.graphPage, maxP);
  const body = $('#tabBody');
  const tools = `<div class="people-tools"><button class="chip" id="ptText" type="button">✍ 문장으로 적기</button><button class="chip" id="ptJson" type="button">🤖 AI로 한번에</button></div>`;
  const bindTools = () => { $('#ptText').onclick = () => textPeopleSheet(); $('#ptJson').onclick = () => jsonPeopleSheet(); };
  const { hiddenPeople, hiddenRels } = state.current;
  const ch = book.chapter || 0;
  const hasHidden = hiddenPeople.length || hiddenRels.length || state.current.allPeople.some((p) => p.chapter || (p.aliases || []).some((a) => a.hidden));
  const chapterBar = hasHidden || ch ? `<div class="chapter-bar">📖 지금 <button type="button" class="mini" id="chMinus">−</button><b id="chNum">${ch ? ch + '장' : '?장'}</b><button type="button" class="mini" id="chPlus">＋</button> 읽는 중 <small>AI로 가져온 정보는 이 장까지만 열려요</small></div>` : '';
  const hiddenBox = hiddenPeople.length || hiddenRels.length ? `<div class="hidden-box">
      <div class="hb-head">🙈 가려진 인물 ${hiddenPeople.length}명 · 관계 ${hiddenRels.length}개<button class="link" id="openAll" type="button">모두 열기</button></div>
      <p class="hint">책에서 처음 보는 이름이 나오면 위 <b>이 이름 누구지?</b>에 쳐보세요. 가려진 인물이면 바로 열 수 있어요. <b>지금 몇 장</b>을 올리면 그 장까지 나온 것은 저절로 열려요. 아래는 언제 드러나는지 모르는 관계예요.</p>
      ${hiddenRels.filter((r) => !r.chapter && people.some((p) => p.id === r.from) && people.some((p) => p.id === r.to)).map((r) => {
        const a = people.find((p) => p.id === r.from); const b = people.find((p) => p.id === r.to);
        return `<div class="hrel"><span>${esc(a.name)} — ${esc(b.name)} <small>관계 가려짐</small></span><button class="mini" data-open-rel="${r.id}" type="button">열기</button></div>`;
      }).join('')}
    </div>` : '';
  const bindHidden = () => {
    $('#chMinus') && ($('#chMinus').onclick = () => setChapter((book.chapter || 0) - 1));
    $('#chPlus') && ($('#chPlus').onclick = () => setChapter((book.chapter || 0) + 1));
    $('#chNum') && ($('#chNum').onclick = () => { const v = prompt('지금 몇 장까지 읽었나요?', book.chapter || ''); if (v !== null && !isNaN(+v)) setChapter(+v); });
    $('#openAll') && ($('#openAll').onclick = () => revealAll());
    $$('[data-open-rel]').forEach((b) => (b.onclick = () => revealRelation(b.dataset.openRel)));
  };
  if (!people.length) {
    body.innerHTML = `${tools}${chapterBar}${hiddenBox}${hiddenPeople.length ? `<div class="finder"><input id="nameFind" placeholder="이 이름 누구지? 책에 나온 이름을 쳐보세요" autocomplete="off"><div id="findOut"></div></div>` : ''}<div class="empty">외국 소설처럼 이름·애칭·호칭·결혼 후 성이 헷갈릴 때<br><b>＋ 인물</b>로 한 사람의 여러 이름을 묶어두세요.<br><small>"엘리자베스와 제인은 자매"처럼 <b>문장으로 적기</b>가 제일 빨라요.</small></div>`;
    bindTools();
    bindHidden();
    bindFinder();
    return;
  }
  const fams = [...new Set(people.flatMap((p) => [p.family, p.marriedFamily]).filter(Boolean))];
  const sel = state.selMode;
  if (!state.sel) state.sel = new Set();
  body.innerHTML = `
    ${tools}
    ${chapterBar}
    <div class="finder">
      <input id="nameFind" placeholder="이 이름 누구지? 애칭·호칭·성으로도 찾아요" autocomplete="off">
      <div id="findOut"></div>
    </div>
    <div class="graph-box"><svg id="graphSvg"></svg><button class="graph-expand" id="graphExpand" type="button">⤢ 크게 보기</button></div>
    <p class="graph-tip"><b>톡</b> = 그 인물 관계만 보기 · <b>한 번 더 톡</b> = 편집 · <b>길게 눌러 끌기</b> = 잇기 · 빈 곳 <b>두 번 톡</b> = 인물 추가 · 사람이 많으면 <b>크게 보기</b>에서 확대해요</p>
    <div class="slider">
      <label><b>p.${page}</b>까지 보기 <small>그 뒤에 나오는 이름과 관계는 숨겨요</small></label>
      <input type="range" id="pageSlider" min="0" max="${maxP}" value="${page}">
    </div>
    <div class="legend">
      ${fams.map((f) => `<span><i style="background:${familyColor(f)}"></i>${esc(f)}</span>`).join('')}
      ${Object.values(REL_KINDS).map((k) => `<span><i class="ln" style="border-color:${k.color};border-top-style:${k.dash ? 'dashed' : 'solid'}"></i>${k.label}</span>`).join('')}
      <span><i class="ring"></i>테두리 = 결혼 후 가문</span>
    </div>
    <h4 class="sec">인물 ${sel === 'people' ? `<small>전체 ${people.length + hiddenPeople.length}명 · 쪽수와 상관없이 모두 보여요</small>` : ''}${!sel ? '<button class="link sec-act" id="selPeople" type="button">선택 삭제</button>' : ''}</h4>
    <div class="people ${sel === 'people' ? 'selecting' : ''}">${(sel === 'people' ? people : people.filter((p) => (p.firstPage || 0) <= page)).map((p) => personCard(p, page, null, sel === 'people' ? state.sel.has(p.id) : undefined)).join('') || '<div class="empty small">이 쪽까지 나온 인물이 없어요</div>'}${sel === 'people' ? hiddenPeople.map((p) => `<div class="pcard ${state.sel.has(p.id) ? 'picked' : ''}" data-pid="${p.id}"><span class="ck ${state.sel.has(p.id) ? 'on' : ''}"></span><div class="pc-main"><div class="pc-name">??? <small class="muted">가려진 인물</small></div></div></div>`).join('') : ''}</div>
    ${sel ? '' : hiddenBox}
    ${sel === 'people' ? '' : `<h4 class="sec">관계 ${sel === 'rels' ? `<small>전체 ${relations.length + hiddenRels.length}개</small>` : ''}${!sel && (relations.length || hiddenRels.length) ? '<button class="link sec-act" id="selRels" type="button">선택 삭제</button>' : ''}</h4>
    <div class="rels ${sel === 'rels' ? 'selecting' : ''}">${sel === 'rels' ? hiddenRels.map((r) => `<button class="rel ${state.sel.has(r.id) ? 'picked' : ''}" data-rid="${r.id}"><span class="ck ${state.sel.has(r.id) ? 'on' : ''}"></span>??? <small class="muted">가려진 관계</small></button>`).join('') : ''}${(sel === 'rels' ? relations : relations.filter((r) => (r.page || 0) <= page)).slice().sort((a, b) => (a.page || 0) - (b.page || 0)).map((r) => {
      const a = people.find((p) => p.id === r.from); const b = people.find((p) => p.id === r.to);
      if (!a || !b) return '';
      const k = REL_KINDS[r.kind] || REL_KINDS.etc;
      const chk = sel === 'rels' ? `<span class="ck ${state.sel.has(r.id) ? 'on' : ''}"></span>` : '';
      return `<button class="rel ${sel === 'rels' && state.sel.has(r.id) ? 'picked' : ''}" data-rid="${r.id}">${chk}<span class="rk" style="--rc:${k.color}">${k.label}</span>${esc(a.name)} — ${esc(b.name)}${r.label ? ` <em>${esc(r.label)}</em>` : ''}${r.page ? ` <small>p.${r.page}</small>` : ''}</button>`;
    }).join('') || '<div class="empty small">아직 관계가 없어요</div>'}</div>`}`;

  state.graph?.destroy();
  bindTools();
  state.graph = createGraph($('#graphSvg'), graphHandlers());
  state.graph.setData(people, relations, page);
  $('#graphExpand').onclick = () => graphSheet(maxP);

  const slider = $('#pageSlider');
  slider.oninput = () => {
    state.graphPage = +slider.value;
    $('.slider b').textContent = `p.${slider.value}`;
    state.graph.setData(people, relations, +slider.value);
  };
  slider.onchange = () => renderPeople();
  bindFinder();
  bindHidden();
  if (sel) {
    // 선택 모드: 카드 누르면 체크, 아래 버튼으로 삭제
    const toggle = (id) => { state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id); renderPeople(); };
    $$('.people .pcard').forEach((c) => (c.onclick = () => toggle(c.dataset.pid)));
    $$('.rel').forEach((b) => (b.onclick = () => toggle(b.dataset.rid)));
    renderSelBar();
    return;
  }
  $('#selPeople') && ($('#selPeople').onclick = () => startSelect('people'));
  $('#selRels') && ($('#selRels').onclick = () => startSelect('rels'));
  $$('.people .pcard').forEach((c) => (c.onclick = () => personSheet(people.find((p) => p.id === c.dataset.pid))));
  $$('.rel').forEach((b) => (b.onclick = () => relationSheet(relations.find((r) => r.id === b.dataset.rid))));
}

// 이름 찾기: 보이는 인물 + 가려진 인물(책에서 그 이름을 만났을 때 열 수 있게)
function bindFinder() {
  const find = $('#nameFind');
  if (!find) return;
  const { people, hiddenPeople } = state.current;
  find.oninput = () => {
    const q = find.value.trim();
    const page = state.graphPage ?? 99999;
    const res = findPeople(q, page);
    const nq = normalizeName(q);
    const hid = nq.length >= 2 ? hiddenPeople.filter((p) => [p.name, ...(p.aliases || []).map((a) => a.name)].some((n) => { const x = normalizeName(n); return x === nq || x.split(' ').includes(nq) || (nq.length >= 3 && x.includes(nq)); })) : [];
    $('#findOut').innerHTML = q
      ? (res.map(({ p, hit }) => personCard(p, page, hit)).join('') +
        hid.map((p) => `<div class="pcard hidden-hit"><div class="pc-dot" style="background:#c9bda8"></div><div class="pc-main"><div class="pc-name">‘${esc(q)}’은(는) 가려진 인물이에요</div><div class="pc-desc">책에서 만났다면 열어보세요. 지금 쪽(p.${currentReadPage() || '?'})이 처음 나온 쪽으로 저장돼요.</div></div><button class="mini" data-reveal="${p.id}" type="button">만났어요</button></div>`).join('') ||
        '<div class="empty small">이 쪽까지는 그런 이름이 없어요</div>')
      : '';
    $$('#findOut .pcard[data-pid]').forEach((c) => (c.onclick = () => personSheet(people.find((p) => p.id === c.dataset.pid))));
    $$('#findOut [data-reveal]').forEach((b) => (b.onclick = () => revealPerson(b.dataset.reveal)));
  };
}

/* ---------- 인물·관계 선택 삭제 / 전체 삭제 ---------- */
function startSelect(mode) {
  state.selMode = mode;
  state.sel = new Set();
  renderPeople();
  const target = $(mode === 'people' ? '.people' : '.rels');
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function endSelect() {
  state.selMode = null;
  state.sel = new Set();
  renderPanel();
}
function renderSelBar() {
  const { people, relations } = state.current;
  const mode = state.selMode;
  const all = mode === 'people' ? [...people, ...state.current.hiddenPeople].map((p) => p.id) : [...relations, ...state.current.hiddenRels].map((r) => r.id);
  const n = state.sel.size;
  const allOn = n === all.length && n > 0;
  $('#bpActions').innerHTML = `<button class="ghost" id="selAll">${allOn ? '모두 해제' : '모두 선택'}</button><button class="primary danger-fill" id="selDel" ${n ? '' : 'disabled'}>${n ? `${n}개 삭제` : '골라주세요'}</button><button class="ghost" id="selCancel">취소</button>`;
  $('#selAll').onclick = () => { state.sel = allOn ? new Set() : new Set(all); renderPeople(); };
  $('#selCancel').onclick = endSelect;
  $('#selDel').onclick = async () => {
    const what = mode === 'people' ? '인물' : '관계';
    const extra = mode === 'people' ? '\n이 인물들이 들어간 관계도 함께 지워져요.' : '';
    if (!confirm(`${allOn ? `${what} 전체(` : ''}${n}개${allOn ? ')' : ''}를 지울까요?${extra}`)) return;
    const bookId = state.current.book.id;
    if (mode === 'people') for (const id of state.sel) await db.deletePerson(id, bookId);
    else for (const id of state.sel) await db.del('relations', id);
    state.selMode = null;
    state.sel = new Set();
    await afterChange();
    toast(`${what} ${n}개를 지웠어요`);
  };
}

// 관계도 전체 화면: 화면 스크롤과 겹치지 않게 넓게 보고 정리
function graphSheet(maxP) {
  const { people, relations } = state.current;
  let g = null;
  const body = openSheet(`
    <h3>인물 관계도</h3>
    <div class="graph-box big"><svg id="graphBig"></svg><button class="graph-expand" id="graphFit" type="button">⤢ 전체 보기</button></div>
    <p class="graph-tip">두 손가락으로 확대 · 빈 곳을 끌어 이동 · 톡 = 관계 보기, 한 번 더 = 편집 · 길게 눌러 끌기 = 잇기</p>
    <div class="slider">
      <label><b id="bigLabel">p.${state.graphPage}</b>까지 보기</label>
      <input type="range" id="bigSlider" min="0" max="${maxP}" value="${state.graphPage}">
    </div>`, { full: true, onClose: () => { g?.destroy(); if (state.current && state.tab === 'people') renderPeople(); } });
  requestAnimationFrame(() => {
    g = createGraph($('#graphBig', body), { ...graphHandlers(() => g?.setData(state.current.people, state.current.relations, state.graphPage)), zoomable: true });
    g.setData(people, relations, state.graphPage);
    $('#graphFit', body).onclick = () => g.fit();
  });
  const sl = $('#bigSlider', body);
  sl.oninput = () => {
    state.graphPage = +sl.value;
    $('#bigLabel', body).textContent = `p.${sl.value}`;
    g?.setData(state.current.people, state.current.relations, +sl.value);
  };
}

/* ---------- 관계도에서 바로 잇기 / 추가 ---------- */
// 지금 보고 있는 쪽(슬라이더가 끝이 아니면 그 쪽)을 새 정보가 드러난 쪽으로 씀
function currentReadPage() {
  return state.graphPage != null && state.graphMax && state.graphPage < state.graphMax ? state.graphPage : 0;
}
function graphHandlers(after) {
  return {
    onNodeTap: (p) => personSheet(p),
    onLink: (a, b) => quickRelSheet(a, b, after),
    onEmptyDoubleTap: () => quickPersonSheet(after),
  };
}
function quickRelSheet(a, b, after) {
  const body = openSheet(`
    <h3>${esc(a.name)} — ${esc(b.name)}</h3>
    <div class="grid2">
      <label>관계 이름 <small>선택</small><input id="qrLabel" placeholder="예: 자매, 약혼"></label>
      <label>드러난 쪽<input id="qrPage" type="number" inputmode="numeric" value="${currentReadPage() || ''}"></label>
    </div>
    <div class="field-title">종류를 누르면 바로 이어져요</div>
    <div class="kind-grid">${Object.entries(REL_KINDS).map(([k, v]) => `<button type="button" data-k="${k}" style="--rc:${v.color}">${v.label}</button>`).join('')}</div>`);
  const label = $('#qrLabel', body);
  label.oninput = () => {
    const g = label.value.trim() ? guessKind(label.value) : null;
    $$('.kind-grid button', body).forEach((x) => x.classList.toggle('suggest', x.dataset.k === g));
  };
  $$('.kind-grid button', body).forEach((btn) => (btn.onclick = async () => {
    await db.put('relations', { id: uid(), bookId: state.current.book.id, from: a.id, to: b.id, kind: btn.dataset.k, label: label.value.trim(), page: +$('#qrPage', body).value || 0, createdAt: Date.now() });
    await afterChange();
    await closeTop();
    after?.();
    toast(`${a.name} — ${b.name} 이었어요`);
  }));
}
function quickPersonSheet(after) {
  const body = openSheet(`
    <h3>인물 추가</h3>
    <div class="grid2">
      <label>이름<input id="qpName" placeholder="예: 샬럿" enterkeyhint="done"></label>
      <label>처음 나온 쪽<input id="qpPage" type="number" inputmode="numeric" value="${currentReadPage() || ''}"></label>
    </div>
    <div class="btn-row"><button class="primary" id="qpSave">추가</button></div>`);
  setTimeout(() => $('#qpName', body).focus(), 300);
  const save = async () => {
    const name = $('#qpName', body).value.trim();
    if (!name) { toast('이름을 적어주세요'); return; }
    await db.put('people', { id: uid(), bookId: state.current.book.id, name, aliases: [], firstPage: +$('#qpPage', body).value || 0, createdAt: Date.now() });
    await afterChange();
    await closeTop();
    after?.();
  };
  $('#qpSave', body).onclick = save;
  $('#qpName', body).onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

/* ---------- 문장·JSON으로 한꺼번에 ---------- */
// 이름으로 인물 찾기: 정확히 같은 이름·다른 이름 우선, 없으면 '엘리자베스' ↔ '엘리자베스 베넷'처럼
// 이름 한 단어만 쓴 경우를 딱 한 명일 때만 같은 사람으로 봄 ('베넷 씨'와 '베넷 부인'은 다른 사람)
function findPersonIn(list, name) {
  const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const n = norm(name);
  if (!n) return null;
  const names = (p) => [p.name, ...(p.aliases || []).map((x) => x.name)].map(norm);
  const exact = list.find((p) => names(p).includes(n));
  if (exact) return exact;
  // 한 단어 이름 맞추기는 대표 이름끼리만 ('다아시 부인' 같은 호칭 때문에 엉뚱한 사람과 합쳐지지 않게)
  const one = (arr) => (arr.length === 1 ? arr[0] : null);
  if (!n.includes(' ')) return one(list.filter((p) => { const x = norm(p.name); return x.includes(' ') && x.split(' ')[0] === n; }));
  const first = n.split(' ')[0];
  return one(list.filter((p) => { const x = norm(p.name); return !x.includes(' ') && x === first; }));
}

// 계획(plan)을 실제 데이터로: 없는 인물은 만들고, 이름·가문·관계를 붙임. dry=true면 미리보기만
async function applyPeoplePlan(plan, { dry = false, hide = false } = {}) {
  const bookId = state.current.book.id;
  const people = (await db.byBook('people', bookId)).map((p) => ({ ...p, aliases: [...(p.aliases || [])] }));
  const rels = await db.byBook('relations', bookId);
  const created = new Set();
  const touched = new Set();
  let t = Date.now();
  const get = (name, page = 0, chapter = 0) => {
    let p = findPersonIn(people, name);
    if (!p) {
      p = { id: uid(), bookId, name: name.trim(), aliases: [], firstPage: page, createdAt: t++ };
      if (hide) { p.hidden = true; p.chapter = chapter || 0; }
      people.push(p);
      created.add(p.id);
    }
    return p;
  };
  const newRels = [];
  const out = [];
  for (const it of plan) {
    if (it.type === 'rel') {
      const a = get(it.a, it.page); const b = get(it.b, it.page);
      if (a === b) { out.push({ ok: false, text: it.raw, why: '같은 사람이에요' }); continue; }
      const kind = it.kind || guessKind(it.label);
      const dup = [...rels, ...newRels].some((r) => ((r.from === a.id && r.to === b.id) || (r.from === b.id && r.to === a.id)) && r.kind === kind && (r.label || '') === (it.label || '') && (r.page || 0) === (it.page || 0));
      if (!dup) newRels.push({ id: uid(), bookId, from: a.id, to: b.id, kind, label: it.label || '', page: it.page || 0, createdAt: t++, ...(hide ? { hidden: true, chapter: it.chapter || 0 } : {}) });
      out.push({ ok: true, text: `${a.name} — ${b.name}`, sub: `${REL_KINDS[kind].label}${it.label ? ' · ' + it.label : ''}${it.page ? ' · p.' + it.page : ''}${dup ? ' (이미 있음)' : ''}`, kind });
    } else if (it.type === 'alias') {
      const p = get(it.name, it.page);
      if (!p.aliases.some((x) => normalizeName(x.name) === normalizeName(it.alias)) && normalizeName(p.name) !== normalizeName(it.alias)) {
        p.aliases.push({ kind: ALIAS_WORDS.includes(it.kind) ? it.kind.replace('결혼후', '결혼 후') : '별명', name: it.alias, page: it.page || 0 });
        touched.add(p.id);
      }
      out.push({ ok: true, text: `${p.name} = ${it.alias}`, sub: `${it.kind}${it.page ? ' · p.' + it.page : ''}` });
    } else if (it.type === 'family') {
      for (const n of it.names) { const p = get(n, it.page); if (!p.family) { p.family = it.family; touched.add(p.id); } }
      out.push({ ok: true, text: `${it.names.join(', ')}`, sub: `가문: ${it.family}` });
    } else if (it.type === 'person') {
      const p = get(it.name, it.firstPage || 0, it.chapter || 0);
      for (const k of ['family', 'marriedFamily', 'desc']) if (it[k] && !p[k]) {
        p[k] = it[k]; touched.add(p.id);
        if (k === 'marriedFamily' && hide) { p.marriedHidden = true; p.marriedChapter = it.marriedChapter || 0; }
        if (k === 'desc' && hide) p.descSpoiler = true; // AI 설명엔 뒷이야기가 섞일 수 있어 가려서 보여줌
      }
      if (it.marriedPage && !p.marriedPage) p.marriedPage = it.marriedPage;
      if (it.firstPage && !p.firstPage) { p.firstPage = it.firstPage; touched.add(p.id); }
      for (const al of it.aliases || []) {
        if (al?.name && !p.aliases.some((x) => normalizeName(x.name) === normalizeName(al.name))) { p.aliases.push({ kind: al.kind || '별명', name: al.name, page: al.page || 0, ...(hide ? { hidden: true, chapter: +al.chapter || 0 } : {}) }); touched.add(p.id); }
      }
      out.push({ ok: true, text: p.name, sub: '인물' });
    } else {
      out.push({ ok: false, text: it.raw, why: '못 알아들었어요' });
    }
  }
  if (!dry) {
    for (const p of people) if (created.has(p.id) || touched.has(p.id)) await db.put('people', p);
    for (const r of newRels) await db.put('relations', r);
  }
  const newNames = people.filter((p) => created.has(p.id)).map((p) => p.name);
  return { out, newNames, relCount: newRels.length };
}

function textPeopleSheet() {
  let rec = null;
  const body = openSheet(`
    <h3>✍ 문장으로 적기</h3>
    <p class="hint">한 줄에 하나씩 적으면 인물을 만들고 이어줘요. 쪽수(p.120, 120쪽)를 붙이면 그 쪽에서 드러난 걸로 해요.</p>
    <div class="examples">
      <code>엘리자베스와 제인은 자매</code><code>다아시의 친구는 빙리</code><code>베넷 부인은 엘리자베스의 어머니</code>
      <code>리지는 엘리자베스의 애칭</code><code>엘리자베스, 제인, 리디아는 베넷가</code><code>위컴과 다아시는 원수 p.120</code>
    </div>
    <div class="field-row"><span class="field-title">적기</span><button class="mini" id="ptMic" type="button">🎤 말하기</button></div>
    <textarea id="ptIn" rows="6" placeholder="엘리자베스와 제인은 자매&#10;다아시의 친구는 빙리"></textarea>
    <div id="ptPrev" class="pt-prev"></div>
    <div class="btn-row"><button class="primary" id="ptApply" disabled>이대로 넣기</button></div>`, { full: true, onClose: () => { try { rec?.stop(); } catch {} } });
  const ta = $('#ptIn', body);
  const preview = async () => {
    const plan = parseText(ta.value);
    if (!plan.length) { $('#ptPrev', body).innerHTML = ''; $('#ptApply', body).disabled = true; return; }
    const { out, newNames } = await applyPeoplePlan(plan, { dry: true });
    $('#ptPrev', body).innerHTML = out.map((o) => o.ok
      ? `<div class="pp ok"><b>${esc(o.text)}</b><small>${esc(o.sub)}</small></div>`
      : `<div class="pp bad"><b>${esc(o.text)}</b><small>${esc(o.why)} · "A와 B는 관계" 모양으로 적어보세요</small></div>`).join('') +
      (newNames.length ? `<div class="pp new">새 인물: ${newNames.map(esc).join(', ')}</div>` : '');
    $('#ptApply', body).disabled = !out.some((o) => o.ok);
  };
  let tmr = 0;
  ta.oninput = () => { clearTimeout(tmr); tmr = setTimeout(preview, 200); };
  setTimeout(() => ta.focus(), 300);
  $('#ptMic', body).onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = $('#ptMic', body);
    if (!SR) { ta.focus(); toast('키보드의 🎤 버튼을 눌러 말해보세요'); return; }
    if (rec) { rec.stop(); return; }
    const base = ta.value.trim();
    rec = new SR(); rec.lang = 'ko-KR'; rec.interimResults = true; rec.continuous = true;
    rec.onresult = (ev) => {
      // 문장이 끝날 때마다 줄을 바꿔서 한 줄 = 관계 하나가 되게
      const said = [...ev.results].map((r) => r[0].transcript.trim()).filter(Boolean).join('\n');
      ta.value = (base ? base + '\n' : '') + said;
      ta.oninput();
    };
    rec.onend = () => { rec = null; mic.classList.remove('rec'); mic.textContent = '🎤 말하기'; };
    rec.onerror = (ev) => toast(ev.error === 'not-allowed' ? '마이크 권한을 허용해 주세요' : '음성 입력이 끊겼어요');
    try { rec.start(); mic.classList.add('rec'); mic.textContent = '■ 멈추기'; } catch { rec = null; }
  };
  $('#ptApply', body).onclick = async () => {
    try { rec?.stop(); } catch {}
    const { newNames, relCount } = await applyPeoplePlan(parseText(ta.value));
    await afterChange();
    await closeTop();
    toast(`새 인물 ${newNames.length}명, 관계 ${relCount}개를 넣었어요`);
  };
}

// JSON 가져오기 (AI에게 받아온 등장인물 정리 등)
const JSON_EXAMPLE = {
  people: [
    { name: '엘리자베스 베넷', family: '베넷가', chapter: 1, aliases: [{ kind: '애칭', name: '리지', chapter: 1 }], desc: '베넷가 둘째 딸' },
    { name: '제인 베넷', family: '베넷가', chapter: 1, aliases: [] },
  ],
  relations: [
    { a: '엘리자베스 베넷', b: '제인 베넷', kind: '가족', label: '자매', chapter: 1 },
    { a: '제인 베넷', b: '빙리', kind: '연인', label: '호감', chapter: 3 },
    { a: '제인 베넷', b: '빙리', kind: '연인', label: '약혼', chapter: 55 },
  ],
};
const KIND_KO = { 가족: 'family', 연인: 'love', 부부: 'love', '연인·부부': 'love', 친구: 'friend', 동료: 'friend', '친구·동료': 'friend', 적대: 'enemy', 갈등: 'enemy', '적대·갈등': 'enemy', 기타: 'etc' };
function jsonToPlan(data) {
  const plan = [];
  const ppl = Array.isArray(data) ? data : data.people || data.characters || [];
  for (const p of ppl) {
    if (!p?.name) continue;
    plan.push({ type: 'person', name: String(p.name), family: p.family || '', marriedFamily: p.marriedFamily || '', marriedPage: +p.marriedPage || 0, marriedChapter: +p.marriedChapter || 0, firstPage: +p.firstPage || 0, chapter: +p.chapter || 0, desc: p.desc || p.description || '', aliases: (p.aliases || []).map((a) => (typeof a === 'string' ? { name: a, kind: '별명' } : a)) });
  }
  for (const r of data.relations || data.relationships || []) {
    const a = r.a || r.from; const b = r.b || r.to;
    if (!a || !b) continue;
    const kind = REL_KINDS[r.kind] ? r.kind : KIND_KO[r.kind] || guessKind(r.label || r.kind || '');
    plan.push({ type: 'rel', a: String(a), b: String(b), kind, label: r.label || '', page: +r.page || 0, chapter: +r.chapter || 0, raw: `${a} — ${b}` });
  }
  return plan;
}
function jsonPeopleSheet() {
  const { book } = state.current;
  const makePrompt = (ch) => `'${book.title}'${book.authors?.length ? `(${book.authors.join(', ')})` : ''}의 등장인물과 관계를 아래 JSON 형식으로만 답해줘. 설명 문장 없이 JSON만.
${ch ? `나는 ${ch}장까지 읽었어. ${ch}장보다 뒤에서 처음 등장하거나 드러나는 인물·관계·이름(결혼, 정체, 죽음, 배신 등)은 절대 넣지 마.\n` : ''}- 이름은 한국어 번역본 표기로
- chapter에는 그 인물·관계·이름이 처음 드러나는 장 번호를 꼭 넣어줘 (모르면 0)
- 애칭·호칭·결혼 후 이름·별명은 aliases에 (kind: 애칭/호칭/결혼 후 이름/별명)
- kind는 가족/연인/친구/적대/기타 중 하나, label에는 자매·약혼 같은 구체적인 관계
- 관계가 이야기 중에 바뀌면(예: 호감 → 약혼 → 파혼) 하나로 합치지 말고 단계마다 따로 적고, 단계마다 그 장 번호(chapter)를 넣어줘
- desc에는 처음 등장할 때 알 수 있는 정보만 짧게. 나중에 밝혀지는 사실(정체, 결말, 파혼, 죽음 등)은 desc에 쓰지 마

${JSON.stringify(JSON_EXAMPLE, null, 2)}`;
  const body = openSheet(`
    <h3>🤖 AI로 한번에 정리</h3>
    <p class="hint"><b>① 요청문 복사</b> → <b>② ChatGPT·Claude 같은 AI에 붙여넣기</b> → <b>③ AI가 준 답을 아래에 그대로 붙여넣기</b>.</p>
    <div class="notice warn">🙈 <b>스포일러 방지</b>: 가져온 인물·관계는 <b>가려진 채로</b> 들어와요. 지금 읽는 장까지 나온 것만 저절로 열리고, 나머지는 책에서 만났을 때 이름으로 찾아 열면 돼요.</div>
    <label>지금 몇 장까지 읽었나요? <small>AI에게 그 뒤는 빼달라고 하고, 그 장까지만 열어요</small><input id="pjCh" type="number" inputmode="numeric" value="${book.chapter || ''}" placeholder="예: 7"></label>
    <button class="ghost wide" id="pjPrompt" type="button">① 📋 AI에게 보낼 요청문 복사</button>
    <textarea id="pjIn" rows="6" placeholder='③ AI가 준 답을 여기에 붙여넣기'></textarea>
    <label class="ghost wide">파일로 불러오기 <small>(.json)</small><input type="file" accept=".json,application/json,text/plain" id="pjFile" hidden></label>
    <div id="pjPrev" class="pt-prev"></div>
    <div class="btn-row"><button class="primary" id="pjApply" disabled>가려서 넣기</button></div>`, { full: true });
  const ta = $('#pjIn', body);
  let plan = [];
  const parse = async () => {
    const raw = ta.value.trim();
    plan = [];
    if (!raw) { $('#pjPrev', body).innerHTML = ''; $('#pjApply', body).disabled = true; return; }
    try {
      const jsonText = raw.slice(raw.search(/[[{]/), Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']')) + 1); // 앞뒤 설명·코드블록 표시 무시
      plan = jsonToPlan(JSON.parse(jsonText));
    } catch {
      $('#pjPrev', body).innerHTML = '<div class="pp bad"><b>AI 답을 알아보지 못했어요</b><small>AI 답에서 { 로 시작해 } 로 끝나는 부분 전체를 붙여넣어 주세요</small></div>';
      $('#pjApply', body).disabled = true;
      return;
    }
    const ch = +$('#pjCh', body).value || 0;
    const { out, newNames, relCount } = await applyPeoplePlan(plan, { dry: true, hide: true });
    const people = plan.filter((x) => x.type === 'person');
    const openNow = ch ? people.filter((x) => x.chapter && x.chapter <= ch).length : 0;
    // 미리보기도 스포가 될 수 있어서 기본은 개수만
    $('#pjPrev', body).innerHTML = `<div class="pp new">인물 ${people.length}명 (새로 ${newNames.length}명) · 새 관계 ${relCount}개${ch ? ` · ${ch}장까지 나온 인물 ${openNow}명은 바로 열려요` : ''}</div>
      <details class="spoil"><summary>⚠ 스포 주의 · 내용 펼쳐보기</summary>${out.filter((o) => o.sub !== '인물').slice(0, 60).map((o) => `<div class="pp ok"><b>${esc(o.text)}</b><small>${esc(o.sub || '')}</small></div>`).join('')}</details>`;
    $('#pjApply', body).disabled = !plan.length;
  };
  ta.oninput = () => parse();
  $('#pjCh', body).oninput = () => parse();
  $('#pjFile', body).onchange = async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { ta.value = await f.text(); parse(); } };
  $('#pjPrompt', body).onclick = async () => {
    const prompt = makePrompt(+$('#pjCh', body).value || 0);
    try { await navigator.clipboard.writeText(prompt); toast('요청문을 복사했어요. AI에게 붙여넣으세요'); }
    catch { ta.value = prompt; toast('복사가 안 돼서 아래 칸에 넣어뒀어요. 직접 복사해 주세요'); }
  };
  $('#pjApply', body).onclick = async () => {
    const ch = +$('#pjCh', body).value || 0;
    if (ch && ch !== (book.chapter || 0)) await db.put('books', { ...book, chapter: ch });
    const { newNames, relCount } = await applyPeoplePlan(plan, { hide: true });
    await afterChange();
    await closeTop();
    const opened = state.current.people.length;
    toast(`가려서 넣었어요: 인물 ${newNames.length}명, 관계 ${relCount}개 · 지금 보이는 인물 ${opened}명`);
  };
}

function aliasRow(a = {}) {
  return `<div class="alias-row">
    <select class="al-kind">${ALIAS_KINDS.map((k) => `<option ${k === (a.kind || '애칭') ? 'selected' : ''}>${k}</option>`).join('')}</select>
    <input class="al-name" placeholder="예: 리지, 베넷 양" value="${esc(a.name || '')}">
    <input class="al-page" type="number" inputmode="numeric" placeholder="쪽" value="${a.page || ''}">
    <button class="al-del" type="button" aria-label="삭제">✕</button>
  </div>`;
}

function personSheet(p) {
  const isNew = !p;
  p = p ? structuredClone(p) : { id: uid(), bookId: state.current.book.id, name: '', aliases: [], createdAt: Date.now() };
  const body = openSheet(`
    <h3>${isNew ? '인물 추가' : '인물 편집'}</h3>
    <label>대표 이름<input id="pName" value="${esc(p.name)}" placeholder="예: 엘리자베스 베넷"></label>
    <div class="grid2">
      <label>본가 · 성<input id="pFam" value="${esc(p.family || '')}" placeholder="예: 베넷가"></label>
      <label>처음 나온 쪽<input id="pFirst" type="number" inputmode="numeric" value="${p.firstPage || ''}"></label>
    </div>
    <div class="grid2">
      <label>결혼 후 가문<input id="pMar" value="${esc(p.marriedFamily || '')}" placeholder="예: 다아시가"></label>
      <label>결혼한 쪽<input id="pMarP" type="number" inputmode="numeric" value="${p.marriedPage || ''}"></label>
    </div>
    <div class="field-title">다른 이름들 <small>애칭 · 호칭 · 결혼 후 이름 · 별명</small></div>
    <div id="aliasList">${(p.aliases || []).map(aliasRow).join('')}</div>
    <button class="ghost wide" id="addAlias" type="button">＋ 이름 추가</button>
    <label>메모${p.descSpoiler ? ' <small>AI 설명 · 스포 주의</small>' : ''}<div class="${p.descSpoiler ? 'spoil-blur' : ''}" ${p.descSpoiler ? 'data-unblur' : ''}><textarea id="pDesc" rows="2" placeholder="어떤 사람인지 한 줄">${esc(p.desc || '')}</textarea>${p.descSpoiler ? '<em>톡해서 보기</em>' : ''}</div></label>
    <div class="btn-row">${isNew ? '' : '<button class="danger" id="pDel">삭제</button>'}<button class="primary" id="pSave">저장</button></div>`);
  const list = $('#aliasList', body);
  const bindDel = () => $$('.al-del', list).forEach((b) => (b.onclick = () => b.parentElement.remove()));
  bindDel();
  $('#addAlias', body).onclick = () => { list.insertAdjacentHTML('beforeend', aliasRow()); bindDel(); $$('.al-name', list).at(-1).focus(); };
  if (isNew) setTimeout(() => $('#pName', body).focus(), 300);
  $('#pSave', body).onclick = async () => {
    p.name = $('#pName', body).value.trim();
    if (!p.name) { toast('대표 이름을 적어주세요'); return; }
    p.family = $('#pFam', body).value.trim();
    p.firstPage = +$('#pFirst', body).value || 0;
    p.marriedFamily = $('#pMar', body).value.trim();
    p.marriedPage = +$('#pMarP', body).value || 0;
    const newDesc = $('#pDesc', body).value.trim();
    if (newDesc !== (p.desc || '')) p.descSpoiler = false; // 직접 고친 설명은 가리지 않음
    p.desc = newDesc;
    p.aliases = $$('.alias-row', list).map((r) => ({
      kind: $('.al-kind', r).value, name: $('.al-name', r).value.trim(), page: +$('.al-page', r).value || 0,
    })).filter((a) => a.name);
    await db.put('people', restoreHidden(p));
    await afterChange();
    await closeTop();
  };
  $('#pDel', body) && ($('#pDel', body).onclick = async () => {
    if (!confirm(`${p.name}을(를) 지울까요? 이 인물의 관계도 함께 지워져요.`)) return;
    await db.deletePerson(p.id, p.bookId);
    await afterChange();
    await closeTop();
  });
}

function relationSheet(r) {
  const { people } = state.current;
  if (people.length < 2) { toast('인물을 두 명 이상 먼저 추가해 주세요'); return; }
  const isNew = !r;
  r = r ? { ...r } : { id: uid(), bookId: state.current.book.id, from: people[0].id, to: people[1].id, kind: 'family', label: '', page: 0, createdAt: Date.now() };
  const opts = (sel) => people.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const body = openSheet(`
    <h3>${isNew ? '관계 추가' : '관계 편집'}</h3>
    ${isNew ? `
      <label>누구와<select id="rA">${opts(r.from)}</select></label>
      <div class="field-title">누구누구 <small>여러 명 골라도 돼요 · 같은 관계로 한 번에 이어져요</small></div>
      <div class="pchips" id="rBs"></div>`
    : `<div class="grid2">
      <label>인물 A<select id="rA">${opts(r.from)}</select></label>
      <label>인물 B<select id="rB">${opts(r.to)}</select></label>
    </div>`}
    <label>종류<div class="seg" id="rKind">${Object.entries(REL_KINDS).map(([k, v]) => `<button type="button" data-k="${k}" class="${k === r.kind ? 'on' : ''}" style="--rc:${v.color}">${v.label}</button>`).join('')}</div></label>
    <div class="grid2">
      <label>관계 이름<input id="rLabel" value="${esc(r.label)}" placeholder="예: 남매, 약혼, 하녀"></label>
      <label>드러난 쪽<input id="rPage" type="number" inputmode="numeric" value="${r.page || ''}"></label>
    </div>
    <p class="hint">같은 두 사람이라도 쪽마다 관계를 따로 적으면(친구 → 부부) 슬라이더에 따라 바뀌어 보여요.</p>
    <div class="btn-row">${isNew ? '' : '<button class="danger" id="rDel">삭제</button>'}<button class="primary" id="rSave">저장</button></div>`);
  $$('#rKind button', body).forEach((b) => (b.onclick = () => { $$('#rKind button', body).forEach((x) => x.classList.remove('on')); b.classList.add('on'); r.kind = b.dataset.k; }));
  const picked = new Set();
  const drawChips = () => {
    const a = $('#rA', body).value;
    [...picked].forEach((id) => { if (id === a) picked.delete(id); });
    $('#rBs', body).innerHTML = people.filter((p) => p.id !== a).map((p) => `<button type="button" class="pchip ${picked.has(p.id) ? 'on' : ''}" data-id="${p.id}"><i style="background:${familyColor(p.family)}"></i>${esc(p.name)}</button>`).join('');
    $$('#rBs .pchip', body).forEach((c) => (c.onclick = () => { picked.has(c.dataset.id) ? picked.delete(c.dataset.id) : picked.add(c.dataset.id); drawChips(); }));
  };
  if (isNew) { drawChips(); $('#rA', body).onchange = drawChips; }
  $('#rSave', body).onclick = async () => {
    const label = $('#rLabel', body).value.trim();
    const page = +$('#rPage', body).value || 0;
    if (isNew) {
      if (!picked.size) { toast('이어줄 인물을 한 명 이상 골라주세요'); return; }
      const from = $('#rA', body).value;
      let i = 0;
      for (const to of picked) {
        await db.put('relations', { id: uid(), bookId: r.bookId, from, to, kind: r.kind, label, page, createdAt: Date.now() + i++ });
      }
      if (picked.size > 1) toast(`${picked.size}명과 한 번에 이었어요`);
    } else {
      r.from = $('#rA', body).value; r.to = $('#rB', body).value;
      if (r.from === r.to) { toast('서로 다른 두 사람을 골라주세요'); return; }
      r.label = label; r.page = page;
      await db.put('relations', r);
    }
    await afterChange();
    await closeTop();
  };
  $('#rDel', body) && ($('#rDel', body).onclick = async () => {
    await db.del('relations', r.id);
    await afterChange();
    await closeTop();
  });
}

// 가족 한 번에: 가문 이름 + 구성원(부모·자녀·기타)을 적으면 인물 만들고 관계까지 자동으로 이어줌
const FAMILY_ROLES = ['부모', '자녀', '친척'];
function familySheet() {
  const { people, book } = state.current;
  const famRow = (v = {}) => `<div class="fam-row" data-pid="${v.pid || ''}">
    <input class="fr-name" placeholder="이름" value="${esc(v.name || '')}" list="famNames">
    <select class="fr-role">${FAMILY_ROLES.map((r) => `<option ${r === (v.role || '자녀') ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <input class="fr-page" type="number" inputmode="numeric" placeholder="쪽" value="${v.page || ''}">
    <button class="al-del" type="button" aria-label="빼기">✕</button>
  </div>`;
  const body = openSheet(`
    <h3>👪 가족 한 번에</h3>
    <p class="hint">가문과 구성원을 적으면 인물을 만들고 <b>부부(부모 두 명)·부모·자녀·형제자매 관계를 자동으로</b> 이어요. 이미 있는 인물은 아래에서 눌러 넣으세요. 다른 집안과의 결혼은 <b>＋ 관계</b>에서 이어주세요.</p>
    <label>가문 · 성<input id="fName" placeholder="예: 베넷가" list="famList"></label>
    <datalist id="famList">${[...new Set(people.flatMap((p) => [p.family, p.marriedFamily]).filter(Boolean))].map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
    <datalist id="famNames">${people.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
    ${people.length ? `<div class="field-title">이미 있는 인물 <small>누르면 구성원에 들어가요</small></div><div class="pchips" id="fExist">${people.map((p) => `<button type="button" class="pchip" data-id="${p.id}"><i style="background:${familyColor(p.family)}"></i>${esc(p.name)}</button>`).join('')}</div>` : ''}
    <div class="field-title">구성원 <small>이름 · 역할 · 처음 나온 쪽</small></div>
    <div id="fRows">${famRow({ role: '부모' })}${famRow({ role: '부모' })}${famRow()}${famRow()}</div>
    <button class="ghost wide" id="fAdd" type="button">＋ 구성원 추가</button>
    <label class="check"><input type="checkbox" id="fSib"> 자녀끼리 형제자매 선도 잇기 <small>(관계도가 복잡해질 수 있어요)</small></label>
    <label>관계가 드러난 쪽 <small>선택</small><input id="fPage" type="number" inputmode="numeric" placeholder="모르면 비워두세요"></label>
    <div class="btn-row"><button class="primary" id="fSave">가족 묶기</button></div>`, { full: true });
  const rows = $('#fRows', body);
  const bindRows = () => $$('.al-del', rows).forEach((b) => (b.onclick = () => b.parentElement.remove()));
  bindRows();
  $('#fAdd', body).onclick = () => { rows.insertAdjacentHTML('beforeend', famRow()); bindRows(); $$('.fr-name', rows).at(-1).focus(); };
  $$('#fExist .pchip', body).forEach((c) => (c.onclick = () => {
    const p = people.find((x) => x.id === c.dataset.id);
    if ($(`.fam-row[data-pid="${p.id}"]`, rows)) return;
    const empty = $$('.fam-row', rows).find((r) => !$('.fr-name', r).value.trim());
    if (empty) { empty.dataset.pid = p.id; $('.fr-name', empty).value = p.name; $('.fr-page', empty).value = p.firstPage || ''; }
    else { rows.insertAdjacentHTML('beforeend', famRow({ pid: p.id, name: p.name, page: p.firstPage })); bindRows(); }
    c.classList.add('on');
    if (!$('#fName', body).value && p.family) $('#fName', body).value = p.family;
  }));
  $('#fSave', body).onclick = async () => {
    const fam = $('#fName', body).value.trim();
    const page = +$('#fPage', body).value || 0;
    const members = $$('.fam-row', rows).map((r) => ({
      pid: r.dataset.pid, name: $('.fr-name', r).value.trim(), role: $('.fr-role', r).value, page: +$('.fr-page', r).value || 0,
    })).filter((m) => m.name);
    if (members.length < 2) { toast('구성원을 두 명 이상 적어주세요'); return; }
    // 인물 찾기/만들기
    const all = [...people];
    let t = Date.now();
    for (const m of members) {
      let p = (m.pid && all.find((x) => x.id === m.pid)) || all.find((x) => x.name.trim() === m.name);
      if (!p) {
        p = { id: uid(), bookId: book.id, name: m.name, family: fam, firstPage: m.page || page, aliases: [], createdAt: t++ };
        all.push(p);
      } else {
        p = { ...p };
        if (fam && !p.family) p.family = fam;
        if (m.page && !p.firstPage) p.firstPage = m.page;
      }
      await db.put('people', restoreHidden(p));
      m.id = p.id;
    }
    // 관계 만들기 (이미 같은 관계가 있으면 건너뜀)
    const existing = await db.byBook('relations', book.id);
    const has = (a, b2, kind) => existing.some((r) => r.kind === kind && ((r.from === a && r.to === b2) || (r.from === b2 && r.to === a)));
    const rels = [];
    const link = (a, b2, kind, label) => { if (a !== b2 && !has(a, b2, kind) && !rels.some((r) => r.kind === kind && ((r.from === a && r.to === b2) || (r.from === b2 && r.to === a)))) rels.push({ from: a, to: b2, kind, label }); };
    const parents = members.filter((m) => m.role === '부모');
    const kids = members.filter((m) => m.role === '자녀');
    const kin = members.filter((m) => m.role === '친척');
    if (parents.length >= 2) link(parents[0].id, parents[1].id, 'love', '부부');
    for (const pa of parents) for (const k of kids) link(pa.id, k.id, 'family', '부모·자식');
    if (!parents.length || $('#fSib', body).checked) for (let i = 1; i < kids.length; i++) link(kids[i - 1].id, kids[i].id, 'family', '형제자매');
    for (const k of kin) { const to = parents[0] || kids[0]; if (to) link(k.id, to.id, 'family', '친척'); }
    let i = 0;
    for (const r of rels) await db.put('relations', { id: uid(), bookId: book.id, ...r, page, createdAt: Date.now() + i++ });
    await afterChange();
    await closeTop();
    toast(`${fam || '가족'}: ${members.length}명, 관계 ${rels.length}개를 이었어요`);
  };
}

async function afterChange() {
  if (!state.current) return;
  await loadCurrent(state.current.book.id);
  renderPanel();
  refreshPages();
}

/* ================= 글귀 ================= */
// 폰(구글 렌즈·갤러리 글자 인식·라이브 텍스트)에서 복사한 글을 정리: 줄바꿈 합치고, 혼자 있는 숫자 줄은 쪽수로
function cleanPasted(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let page = 0;
  let out = '';
  for (const l of lines) {
    if (/^\d{1,4}$/.test(l)) { if (!page) page = +l; continue; }
    if (!out) out = l;
    else if (/[a-z]-$/i.test(out) && /^[a-z]/i.test(l)) out = out.slice(0, -1) + l; // 영어 하이픈 줄바꿈
    else if (/[가-힣]$/.test(out) && /^[가-힣]/.test(l) && !WORD_END.test(out.slice(-1))) out += l; // 한글 책은 낱말 중간에서도 줄이 바뀜 → 붙이기
    else out += ' ' + l;
  }
  return { text: out.replace(/\s+/g, ' ').trim(), page };
}

function quoteSheet(q, prefill) {
  const isNew = !q;
  q = q ? { ...q } : { id: uid(), bookId: state.current.book.id, createdAt: Date.now(), tags: [], text: prefill?.text || '', page: prefill?.page || 0 };
  let rec = null;
  const body = openSheet(`
    <h3>${isNew ? '밑줄 긋기' : q.draft ? '책갈피 채우기' : '밑줄 고치기'}</h3>
    ${q.draft ? '<div class="notice warn">🔖 책갈피로 남겨둔 밑줄이에요. 문장을 채우고 저장하면 보통 밑줄이 돼요.</div>' : ''}
    <div class="ocr-btns">
      <label class="primary">${icon.camera} 사진 밑줄<input type="file" accept="image/*" capture="environment" id="qCam" hidden></label>
      <label class="ghost">${icon.image} 앨범에서<input type="file" accept="image/*" id="qAlbum" hidden></label>
    </div>
    <div class="q-imgbox" ${q.image ? '' : 'hidden'}><img id="qImg" src="${q.image || ''}" alt="사진 밑줄"><button class="ghost" id="qImgDel" type="button">✕ 사진 빼기</button></div>
    <label>쪽<input id="qPage" type="number" inputmode="numeric" value="${q.page || ''}" placeholder="몇 쪽?"></label>
    <div class="field-row"><span class="field-title">글귀 <small>사진 밑줄만 있어도 돼요</small></span>
      <div class="text-tools">
        <button class="mini" id="qPaste" type="button">${icon.paste} 붙여넣기</button>
        <button class="mini" id="qMic" type="button">🎤 말하기</button>
        <label class="mini">🔤 글자 인식<input type="file" accept="image/*" id="qOcr" hidden></label>
      </div>
    </div>
    <textarea id="qText" rows="4" placeholder="마음에 남은 문장 (나중에 채워도 돼요)">${esc(q.text || '')}</textarea>
    <details class="howto"><summary>글자로 빨리 넣는 법</summary>
      <ol>
        <li><b>말하기</b>: 🎤를 누르고 문장을 소리 내어 읽어요</li>
        <li><b>폰 기본 카메라 앱</b>(앱 안 사진 버튼 말고)이나 <b>갤러리 T 버튼</b>, <b>구글 렌즈</b>에서 문장 선택 → 복사 → 여기서 붙여넣기<br><small>앱 안 사진 버튼은 간단한 촬영 화면이라 글자 복사 기능이 안 떠요</small></li>
        <li><b>렌즈 공유</b>: 렌즈에서 문장 선택 → 공유 → 밑줄서재 (홈 화면에 추가한 경우)</li>
      </ol>
    </details>
    ${q.draft ? '<label class="check"><input type="checkbox" id="qKeepDraft"> 아직 책갈피로 두기</label>' : ''}
    <label>내 생각 <small>선택</small><textarea id="qNote" rows="2">${esc(q.note || '')}</textarea></label>
    <label>태그 <small>띄어쓰기로 구분</small><input id="qTags" value="${esc((q.tags || []).map((t) => '#' + t).join(' '))}" placeholder="#위로 #문장력"></label>
    <div class="btn-row">${isNew ? '' : '<button class="danger" id="qDel">삭제</button>'}<button class="primary" id="qSave">저장</button></div>`, { onClose: () => { try { rec?.stop(); } catch {} } });
  const t = $('#qText', body);
  const setPage = (page) => { if (page && !$('#qPage', body).value) $('#qPage', body).value = page; };
  const setImage = (img) => {
    q.image = img || '';
    $('#qImg', body).src = q.image;
    $('.q-imgbox', body).hidden = !q.image;
  };
  // 사진 밑줄
  const onPhoto = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) underlineSheet(f, (img) => setImage(img), setPage);
  };
  $('#qCam', body).onchange = onPhoto;
  $('#qAlbum', body).onchange = onPhoto;
  $('#qImgDel', body).onclick = () => setImage('');
  // 글자 인식(실험)
  $('#qOcr', body).onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) ocrSheet(f, (text, page) => { t.value = t.value.trim() ? t.value.trim() + ' ' + text : text; setPage(page); });
  };
  // 붙여넣기
  const putText = (raw) => {
    const { text, page } = cleanPasted(raw);
    if (!text) return false;
    t.value = t.value.trim() ? t.value.trim() + ' ' + text : text;
    setPage(page);
    return true;
  };
  $('#qPaste', body).onclick = async () => {
    try {
      const raw = await navigator.clipboard.readText();
      if (!putText(raw)) toast('복사된 글자가 없어요. 먼저 문장을 복사해 주세요');
      else toast('붙여넣었어요. 틀린 글자만 고쳐주세요');
    } catch {
      t.focus();
      toast('글귀 칸을 길게 눌러 붙여넣기 해주세요');
    }
  };
  t.addEventListener('paste', (e) => {
    const raw = e.clipboardData?.getData('text') || '';
    if (!raw.includes('\n')) return;
    e.preventDefault();
    putText(raw);
  });
  // 말하기 (음성 받아쓰기)
  const mic = $('#qMic', body);
  mic.onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { t.focus(); toast('여기서는 음성 입력이 안 돼요. 키보드의 🎤 버튼을 눌러 말해보세요'); return; }
    if (rec) { rec.stop(); return; }
    const base = t.value.trim();
    rec = new SR();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (ev) => {
      let said = '';
      for (const r of ev.results) said += r[0].transcript;
      t.value = (base ? base + ' ' : '') + said.trim();
    };
    rec.onerror = (ev) => toast(ev.error === 'not-allowed' ? '마이크 권한을 허용해 주세요' : ev.error === 'no-speech' ? '목소리가 안 들렸어요' : '음성 입력이 끊겼어요');
    rec.onend = () => { rec = null; mic.classList.remove('rec'); mic.textContent = '🎤 말하기'; };
    try {
      rec.start();
      mic.classList.add('rec');
      mic.textContent = '■ 멈추기';
    } catch { rec = null; }
  };
  if (isNew && !prefill) setTimeout(() => $('#qPage', body).focus(), 300);
  $('#qSave', body).onclick = async () => {
    try { rec?.stop(); } catch {}
    q.text = t.value.trim();
    if (!q.text && !q.image) { toast('문장을 적거나 사진 밑줄을 그어주세요'); return; }
    q.page = +$('#qPage', body).value || 0;
    q.note = $('#qNote', body).value.trim();
    q.tags = parseTags($('#qTags', body).value);
    if (q.draft) q.draft = !!$('#qKeepDraft', body)?.checked;
    q.updatedAt = Date.now();
    await db.put('quotes', q);
    state.shelfDirty = true;
    await afterChange();
    await closeTop();
    if (isNew) toast(`p.${q.page || '?'}에 밑줄을 그었어요`);
  };
  $('#qDel', body) && ($('#qDel', body).onclick = async () => {
    if (!confirm('이 밑줄을 지울까요?')) return;
    await db.del('quotes', q.id);
    state.shelfDirty = true;
    await afterChange();
    await closeTop();
  });
}

// 책갈피 밑줄: 쪽수와 앞 몇 글자만 남기고 나중에 채우기
function bookmarkSheet() {
  const body = openSheet(`
    <h3>🔖 책갈피</h3>
    <p class="hint">읽는 흐름을 끊지 말고 쪽수랑 앞 몇 글자만 남겨두세요. 목록의 <b>채울 밑줄</b>에서 나중에 채우면 돼요.</p>
    <label>쪽<input id="bPage" type="number" inputmode="numeric" placeholder="몇 쪽?" enterkeyhint="next"></label>
    <label>앞 몇 글자 <small>선택</small><input id="bWords" placeholder="예: 엘리자베스는 그의" enterkeyhint="done"></label>
    <div class="btn-row"><button class="primary" id="bSave">책갈피 꽂기</button></div>`);
  setTimeout(() => $('#bPage', body).focus(), 300);
  const save = async () => {
    const page = +$('#bPage', body).value || 0;
    const words = $('#bWords', body).value.trim();
    if (!page && !words) { toast('쪽수나 앞 몇 글자를 적어주세요'); return; }
    await db.put('quotes', { id: uid(), bookId: state.current.book.id, page, text: words, draft: true, tags: [], note: '', createdAt: Date.now() });
    state.shelfDirty = true;
    await afterChange();
    await closeTop();
    toast(`p.${page || '?'}에 책갈피를 꽂았어요`);
  };
  $('#bSave', body).onclick = save;
  $('#bPage', body).onkeydown = (e) => { if (e.key === 'Enter') $('#bWords', body).focus(); };
  $('#bWords', body).onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

// 사진 밑줄: 범위 고르기 → 형광펜 긋기 → 그은 부분만 잘라 이미지로 저장 (글자 인식 없음)
async function underlineSheet(file, onUse, onPage) {
  const body = openSheet(`
    <h3>사진 밑줄</h3>
    <div class="ocr-status"><div class="bar"><i></i></div><span>사진 준비 중…</span></div>
    <div class="crop-step" hidden>
      <p class="hint">밑줄 그을 문장이 들어가게 범위를 정하세요. 모서리·변을 끌어 조절해요.</p>
      <div class="crop-wrap"><img alt=""><div class="crop-box">${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i class="ch ch-${h}" data-h="${h}"></i>`).join('')}</div></div>
      <div class="btn-row"><button class="ghost" id="cropRotate" type="button">↻ 돌리기</button><button class="primary" id="cropGo" type="button">다음: 밑줄 긋기</button></div>
    </div>
    <div class="hl-step" hidden>
      <p class="hint">문장 위를 <b>손가락으로 쭉 그으세요</b>. 여러 줄이면 줄마다 한 번씩 그어요.</p>
      <div class="hl-wrap"><canvas></canvas></div>
      <div class="hl-tools">
        <div class="seg" id="hlSize"><button type="button" data-s="0.026">가늘게</button><button type="button" data-s="0.038" class="on">보통</button><button type="button" data-s="0.055">굵게</button></div>
        <button class="ghost" id="hlUndo" type="button">↶</button>
        <button class="ghost" id="hlBack" type="button">✂</button>
      </div>
      <div class="btn-row"><button class="primary" id="hlUse">이 밑줄 쓰기</button></div>
    </div>`, { full: true });
  const maxPage = state.current?.book?.pages || 0;
  let src = null;
  let crop = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
  let part = null;
  let strokes = [];
  let size = 0.038;
  const step = (name) => {
    $('.ocr-status', body).hidden = name !== 'status';
    $('.crop-step', body).hidden = name !== 'crop';
    $('.hl-step', body).hidden = name !== 'hl';
  };
  const fitBox = (el, w, h, hFrac) => {
    const maxH = Math.round(innerHeight * hFrac);
    const maxW = body.clientWidth || innerWidth - 36;
    const k = Math.min(maxW / w, maxH / h);
    el.style.width = Math.round(w * k) + 'px';
    el.style.height = Math.round(h * k) + 'px';
  };
  // 범위 고르기
  const cropWrap = $('.crop-wrap', body);
  const cropBox = $('.crop-box', body);
  const drawCrop = () => Object.assign(cropBox.style, { left: crop.x * 100 + '%', top: crop.y * 100 + '%', width: crop.w * 100 + '%', height: crop.h * 100 + '%' });
  const showCrop = () => {
    $('img', cropWrap).src = fitForOcr(src, 1400).toDataURL('image/jpeg', 0.85);
    fitBox(cropWrap, src.width, src.height, 0.62);
    drawCrop();
    step('crop');
  };
  let drag = null;
  cropWrap.addEventListener('pointerdown', (e) => {
    const h = e.target.dataset.h || (e.target === cropBox ? 'move' : null);
    if (!h) return;
    e.preventDefault();
    cropWrap.setPointerCapture(e.pointerId);
    drag = { h, x: e.clientX, y: e.clientY, start: { ...crop } };
  });
  cropWrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = cropWrap.getBoundingClientRect();
    const dx = (e.clientX - drag.x) / r.width;
    const dy = (e.clientY - drag.y) / r.height;
    const s0 = drag.start;
    const MIN = 0.08;
    let { x, y, w, h } = s0;
    if (drag.h === 'move') {
      x = Math.min(1 - w, Math.max(0, s0.x + dx));
      y = Math.min(1 - h, Math.max(0, s0.y + dy));
    } else {
      if (drag.h.includes('w')) { const nx = Math.min(s0.x + s0.w - MIN, Math.max(0, s0.x + dx)); w = s0.w + (s0.x - nx); x = nx; }
      if (drag.h.includes('e')) w = Math.min(1 - s0.x, Math.max(MIN, s0.w + dx));
      if (drag.h.includes('n')) { const ny = Math.min(s0.y + s0.h - MIN, Math.max(0, s0.y + dy)); h = s0.h + (s0.y - ny); y = ny; }
      if (drag.h.includes('s')) h = Math.min(1 - s0.y, Math.max(MIN, s0.h + dy));
    }
    crop = { x, y, w, h };
    drawCrop();
  });
  const endDrag = () => { drag = null; };
  cropWrap.addEventListener('pointerup', endDrag);
  cropWrap.addEventListener('pointercancel', endDrag);
  $('#cropRotate', body).onclick = () => {
    src = rotateCanvas(src, 90);
    crop = { x: 1 - crop.y - crop.h, y: crop.x, w: crop.h, h: crop.w };
    showCrop();
  };

  // 형광펜 긋기
  const cv = $('.hl-wrap canvas', body);
  const ctx = cv.getContext('2d');
  let cur = null;
  const lw = () => Math.max(6, part.width * size);
  const paintHl = () => {
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(part, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineCap = 'round';
    for (const st of cur ? [...strokes, cur] : strokes) {
      ctx.strokeStyle = 'rgba(247, 203, 72, 0.9)';
      ctx.lineWidth = st.w;
      ctx.beginPath();
      ctx.moveTo(st.x0, st.y0);
      ctx.lineTo(st.x1, st.y1);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  };
  const toImg = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height };
  };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = toImg(e);
    cur = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, w: lw() };
    paintHl();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const p = toImg(e);
    cur.x1 = p.x;
    // 거의 수평이면 반듯하게 (책 줄은 수평이니까)
    cur.y1 = Math.abs(p.y - cur.y0) < Math.abs(p.x - cur.x0) * 0.12 ? cur.y0 : p.y;
    paintHl();
  });
  const endHl = () => {
    if (!cur) return;
    if (Math.hypot(cur.x1 - cur.x0, cur.y1 - cur.y0) > cur.w * 0.6) strokes.push(cur);
    cur = null;
    paintHl();
  };
  cv.addEventListener('pointerup', endHl);
  cv.addEventListener('pointercancel', endHl);
  $$('#hlSize button', body).forEach((b) => (b.onclick = () => {
    $$('#hlSize button', body).forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    size = +b.dataset.s;
  }));
  $('#hlUndo', body).onclick = () => { strokes.pop(); paintHl(); };
  $('#hlBack', body).onclick = () => showCrop();
  $('#cropGo', body).onclick = () => {
    part = fitForOcr(cropCanvas(src, crop), 1600);
    cv.width = part.width; cv.height = part.height;
    fitBox(cv, part.width, part.height, 0.58);
    strokes = [];
    paintHl();
    step('hl');
  };
  $('#hlUse', body).onclick = async () => {
    paintHl();
    // 그은 줄 위아래로 조금 여유를 두고 잘라서 카드에 쓰기
    let y0 = 0; let y1 = cv.height;
    if (strokes.length) {
      const pad = Math.max(...strokes.map((s) => s.w)) * 1.3;
      y0 = Math.max(0, Math.min(...strokes.map((s) => Math.min(s.y0, s.y1) - s.w / 2)) - pad);
      y1 = Math.min(cv.height, Math.max(...strokes.map((s) => Math.max(s.y0, s.y1) + s.w / 2)) + pad);
    }
    const k = Math.min(1, 1000 / cv.width);
    const out = document.createElement('canvas');
    out.width = Math.round(cv.width * k);
    out.height = Math.round((y1 - y0) * k);
    out.getContext('2d').drawImage(cv, 0, y0, cv.width, y1 - y0, 0, 0, out.width, out.height);
    onUse(out.toDataURL('image/jpeg', 0.82));
    const full = fitForOcr(src);
    const c = crop;
    await closeTop();
    // 쪽수는 뒤에서 조용히 찾아서, 비어 있으면 채움
    findPageNumber(full, maxPage, c).then((pg) => pg && onPage(pg)).catch(() => {});
  };

  step('status');
  try {
    src = await fileToCanvas(file, 3200);
    showCrop();
  } catch (e) {
    $('.ocr-status span', body).textContent = '사진을 열지 못했어요: ' + e.message;
  }
}

async function ocrSheet(file, onUse) {
  const body = openSheet(`
    <h3>문장 고르기</h3>
    <div class="ocr-status"><div class="bar"><i></i></div><span>사진 준비 중…</span></div>
    <div class="crop-step" hidden>
      <p class="hint">읽을 부분만 남기세요. 모서리·변을 끌어 조절해요. <b>옆 페이지는 빼면</b> 훨씬 정확해요.</p>
      <div class="crop-wrap"><img alt=""><div class="crop-box">${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i class="ch ch-${h}" data-h="${h}"></i>`).join('')}</div></div>
      <div class="btn-row"><button class="ghost" id="cropRotate" type="button">↻ 돌리기</button><button class="ghost" id="cropAll" type="button">전체 읽기</button><button class="primary" id="cropGo" type="button">이 범위 읽기</button></div>
    </div>
    <div class="pick-step" hidden>
      <div class="ocr-stage"><div class="ocr-img"></div></div>
      <div class="ocr-tools"><p class="hint">형광펜처럼 <b>문장 위를 손가락으로 쭉 그으세요</b>. 다시 그으면 새로 골라져요.</p><button class="ghost" id="ocrRecrop" type="button">✂ 범위 다시</button></div>
      <div class="ocr-pick"><div class="ocr-page"></div><div class="ocr-text"></div></div>
      <div class="btn-row"><button class="ghost" id="ocrAll" disabled>전체 쓰기</button><button class="primary" id="ocrUse" disabled>이 문장 쓰기</button></div>
    </div>`, { full: true });
  const status = $('.ocr-status span', body);
  const bar = $('.ocr-status i', body);
  const stage = $('.ocr-img', body);
  const maxPage = state.current?.book?.pages || 0;
  let src = null; // 원본(방향 보정된) 사진
  let crop = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
  let result = null;
  let canvas = null;
  let page = null;
  let sel = [];
  let busy = false;

  const step = (name) => {
    $('.ocr-status', body).hidden = name !== 'status';
    $('.crop-step', body).hidden = name !== 'crop';
    $('.pick-step', body).hidden = name !== 'pick';
  };
  const fitBox = (el, w, h, hFrac) => {
    const maxH = Math.round(innerHeight * hFrac);
    const maxW = body.clientWidth || innerWidth - 36;
    const k = Math.min(maxW / w, maxH / h);
    el.style.width = Math.round(w * k) + 'px';
    el.style.height = Math.round(h * k) + 'px';
  };
  const progress = (m) => {
    if (m.status === 'recognizing text') { bar.style.width = Math.round(m.progress * 100) + '%'; status.textContent = `글자 읽는 중 ${Math.round(m.progress * 100)}%`; }
    else if (/load|initializ/.test(m.status)) status.textContent = '한글 인식 준비 중… (처음 한 번은 조금 걸려요)';
  };

  /* ---- 1단계: 범위 고르기 ---- */
  const cropWrap = $('.crop-wrap', body);
  const cropBox = $('.crop-box', body);
  const drawCrop = () => {
    Object.assign(cropBox.style, { left: crop.x * 100 + '%', top: crop.y * 100 + '%', width: crop.w * 100 + '%', height: crop.h * 100 + '%' });
  };
  const showCrop = () => {
    $('img', cropWrap).src = fitForOcr(src, 1400).toDataURL('image/jpeg', 0.85);
    fitBox(cropWrap, src.width, src.height, 0.6);
    drawCrop();
    step('crop');
  };
  let drag = null;
  cropWrap.addEventListener('pointerdown', (e) => {
    const h = e.target.dataset.h || (e.target === cropBox ? 'move' : null);
    if (!h) return;
    e.preventDefault();
    cropWrap.setPointerCapture(e.pointerId);
    drag = { h, x: e.clientX, y: e.clientY, start: { ...crop } };
  });
  cropWrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = cropWrap.getBoundingClientRect();
    const dx = (e.clientX - drag.x) / r.width;
    const dy = (e.clientY - drag.y) / r.height;
    const s0 = drag.start;
    const MIN = 0.08;
    let { x, y, w, h } = s0;
    if (drag.h === 'move') {
      x = Math.min(1 - w, Math.max(0, s0.x + dx));
      y = Math.min(1 - h, Math.max(0, s0.y + dy));
    } else {
      if (drag.h.includes('w')) { const nx = Math.min(s0.x + s0.w - MIN, Math.max(0, s0.x + dx)); w = s0.w + (s0.x - nx); x = nx; }
      if (drag.h.includes('e')) w = Math.min(1 - s0.x, Math.max(MIN, s0.w + dx));
      if (drag.h.includes('n')) { const ny = Math.min(s0.y + s0.h - MIN, Math.max(0, s0.y + dy)); h = s0.h + (s0.y - ny); y = ny; }
      if (drag.h.includes('s')) h = Math.min(1 - s0.y, Math.max(MIN, s0.h + dy));
    }
    crop = { x, y, w, h };
    drawCrop();
  });
  const endDrag = () => { drag = null; };
  cropWrap.addEventListener('pointerup', endDrag);
  cropWrap.addEventListener('pointercancel', endDrag);

  $('#cropRotate', body).onclick = () => {
    src = rotateCanvas(src, 90);
    crop = { x: crop.y, y: 1 - crop.x - crop.w, w: crop.h, h: crop.w }; // 범위도 같이 회전
    crop = { x: 1 - crop.x - crop.w, y: crop.y, w: crop.w, h: crop.h };
    showCrop();
  };
  $('#cropAll', body).onclick = () => { crop = { x: 0, y: 0, w: 1, h: 1 }; read(); };
  $('#cropGo', body).onclick = () => read();

  /* ---- 2단계: 읽고 문장 고르기 ---- */
  const read = async () => {
    if (busy) return;
    busy = true;
    step('status');
    bar.style.width = '3%';
    status.textContent = '글자 읽는 중…';
    try {
      const part = fitForOcr(cropCanvas(src, crop));
      const best = await recognizeAuto(part, progress, () => { status.textContent = '사진 방향 맞추는 중…'; bar.style.width = '3%'; });
      canvas = best.canvas; result = best.r;
      page = result.page && result.page <= (maxPage || 99999) ? result.page : null;
      showPick();
      // 본문만 잘라낸 경우에도 쪽수는 원본 사진 위·아래에서 찾기
      $('.ocr-page', body).textContent = page ? `쪽수 p.${page} 로 보여요` : '쪽수 찾는 중…';
      const full = fitForOcr(best.deg ? rotateCanvas(src, best.deg) : src);
      const found = await findPageNumber(full, maxPage, best.deg ? { x: 0, y: 0, w: 1, h: 1 } : crop).catch(() => null);
      if (found) page = found;
      $('.ocr-page', body).textContent = page ? `쪽수 p.${page} 로 보여요` : '쪽수는 못 찾았어요 · 직접 적어주세요';
    } catch (e) {
      status.textContent = '글자를 읽지 못했어요: ' + e.message;
    }
    busy = false;
  };

  let blkCols = new Map();
  const showPick = () => {
    const url = canvas.toDataURL('image/jpeg', 0.85);
    fitBox(stage, result.width, result.height, 0.5);
    stage.innerHTML = `<img src="${url}" alt="">` + result.words.map((w) => {
      const b = w.bbox;
      return `<i class="wbox" data-i="${w.i}" style="left:${(b.x0 / result.width) * 100}%;top:${(b.y0 / result.height) * 100}%;width:${((b.x1 - b.x0) / result.width) * 100}%;height:${((b.y1 - b.y0) / result.height) * 100}%"></i>`;
    }).join('');
    // 블록별 가로 범위 (다른 단·옆 페이지가 선택에 섞이지 않게)
    blkCols = new Map();
    for (const w of result.words) {
      const c = blkCols.get(w.blk) || { x0: Infinity, x1: -Infinity };
      c.x0 = Math.min(c.x0, w.bbox.x0); c.x1 = Math.max(c.x1, w.bbox.x1);
      blkCols.set(w.blk, c);
    }
    step('pick');
    $('#ocrAll', body).disabled = !result.words.length;
    sel = [];
    paint();
    if (!result.words.length) $('.ocr-text', body).textContent = '글자를 찾지 못했어요. ✂ 범위 다시에서 ↻ 돌리기로 방향을 맞추거나 범위를 좁혀보세요.';
    else if (result.conf < 45) $('.ocr-text', body).innerHTML = '<span class="muted">글자가 이상하게 읽혔다면 ✂ 범위 다시에서 방향과 범위를 맞춰보세요.</span>';
  };
  const sameColumn = (a, b) => {
    if (a === b) return true;
    const A = blkCols.get(a); const B = blkCols.get(b);
    if (!A || !B) return true;
    const overlap = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
    return overlap > 0.5 * Math.min(A.x1 - A.x0, B.x1 - B.x0);
  };

  const hitWord = (e) => {
    if (!result) return null;
    const r = stage.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * result.width;
    const y = ((e.clientY - r.top) / r.height) * result.height;
    const pad = 6;
    let best = null; let bd = Infinity;
    for (const w of result.words) {
      const b = w.bbox;
      if (y < b.y0 - pad || y > b.y1 + pad) continue;
      const dx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0;
      if (dx < bd && dx < 40) { bd = dx; best = w; }
    }
    return best;
  };
  function paint() {
    const set = new Set(sel.map((w) => w.i));
    $$('.wbox', stage).forEach((b) => b.classList.toggle('on', set.has(+b.dataset.i)));
    const text = joinWords(sel);
    $('.ocr-text', body).innerHTML = text ? `<span class="hl">${esc(text)}</span>` : '<span class="muted">아직 고른 문장이 없어요</span>';
    $('#ocrUse', body).disabled = !text;
  }
  let startW = null;
  stage.addEventListener('pointerdown', (e) => {
    const w = hitWord(e);
    if (!w) return;
    stage.setPointerCapture(e.pointerId);
    startW = w;
    sel = [w];
    paint();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!startW) return;
    const w = hitWord(e);
    if (!w || !sameColumn(startW.blk, w.blk)) return;
    const a = Math.min(startW.i, w.i); const b = Math.max(startW.i, w.i);
    sel = result.words.filter((x) => x.i >= a && x.i <= b && sameColumn(startW.blk, x.blk));
    paint();
  });
  const up = () => { startW = null; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  $('#ocrRecrop', body).onclick = () => { if (!busy) showCrop(); };
  $('#ocrUse', body).onclick = async () => { onUse(joinWords(sel), page); await closeTop(); };
  $('#ocrAll', body).onclick = async () => { onUse(joinWords(result.words.filter((w) => w.text !== String(page))), page); await closeTop(); };

  try {
    src = await fileToCanvas(file, 3200); // 원본 해상도 최대한 유지 (작은 글씨 인식용)
    showCrop();
  } catch (e) {
    status.textContent = '사진을 열지 못했어요: ' + e.message;
  }
}

/* ================= 책 등록 ================= */
function addBookSheet() {
  let stopScan = null;
  const body = openSheet(`
    <h3>책 꽂기</h3>
    <button class="primary big" id="scanBtn">${icon.barcode} 바코드 스캔</button>
    <div class="scan-box" hidden><video playsinline muted></video><div class="scan-guide"></div><p>폰을 <b>한 뼘(15~20cm)</b> 떨어뜨려 바코드를 네모에 맞춰주세요 · 흐리면 화면을 톡</p>
      <div class="scan-tools"><label class="zoom" hidden>줌 <input type="range" id="zoomIn"></label><button type="button" class="torch" hidden>🔦</button></div></div>
    <label class="ghost wide photo-scan">${icon.camera} 그래도 안 되면 사진으로 찍기<input type="file" accept="image/*" capture="environment" id="scanPhoto" hidden></label>
    <div class="or">또는</div>
    <div class="inline"><input id="isbnIn" inputmode="numeric" placeholder="ISBN 13자리 (978…)"><button class="ghost" id="isbnGo">찾기</button></div>
    <div class="inline"><input id="titleIn" placeholder="제목으로 찾기"><button class="ghost" id="titleGo">검색</button></div>
    <div id="results"></div>
    <button class="link wide" id="manual">직접 입력할게요</button>
    ${getKakaoKey() ? '' : '<p class="hint">국내 책이 잘 안 찾아지면 설정에서 카카오 REST 키를 넣어보세요.</p>'}`, { onClose: () => stopScan?.() });
  const results = $('#results', body);

  const lookup = async (isbn) => {
    results.innerHTML = '<div class="loading">책 정보를 찾는 중…</div>';
    const info = await lookupISBN(isbn).catch(() => null);
    if (!info) {
      confirmBook({ isbn, title: '', authors: [], pages: 0, cover: '', notFound: true });
      return;
    }
    confirmBook(info);
  };

  $('#scanBtn', body).onclick = async () => {
    const box = $('.scan-box', body);
    if (stopScan) { stopScan(); stopScan = null; box.hidden = true; return; }
    box.hidden = false;
    try {
      stopScan = await startScan($('video', box), (code) => {
        stopScan = null;
        box.hidden = true;
        navigator.vibrate?.(60);
        lookup(code);
      });
      const ctl = stopScan;
      const zl = $('.zoom', box);
      if (ctl.zoom) {
        const zi = $('#zoomIn', box);
        Object.assign(zi, { min: ctl.zoom.min, max: ctl.zoom.max, step: ctl.zoom.step, value: ctl.zoom.value });
        zi.oninput = () => ctl.setZoom(+zi.value);
        zl.hidden = false;
      }
      const tb = $('.torch', box);
      if (ctl.torch) { tb.hidden = false; tb.onclick = () => tb.classList.toggle('on', ctl.toggleTorch()); }
      $('video', box).onclick = () => { ctl.focus?.(); box.classList.add('focusing'); setTimeout(() => box.classList.remove('focusing'), 600); };
    } catch (e) {
      box.hidden = true;
      toast(e.name === 'NotAllowedError' ? '카메라 권한이 필요해요' : '카메라를 열 수 없어요');
    }
  };
  $('#scanPhoto', body).onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (stopScan) { stopScan(); stopScan = null; $('.scan-box', body).hidden = true; }
    results.innerHTML = '<div class="loading">사진에서 바코드 찾는 중…</div>';
    const code = await decodeImageFile(f).catch(() => null);
    if (code) { navigator.vibrate?.(60); lookup(code); return; }
    notice(results, `<b>사진에서 바코드를 못 읽었어요.</b><br>
      · 바코드가 사진 가로폭의 절반 이상 차게, 비스듬하지 않게 찍어주세요<br>
      · 반사광이 바코드를 가리지 않게 조명 각도를 바꿔보세요<br>
      · 그래도 안 되면 바코드 아래 숫자(978… / 979…)를 위 ISBN 칸에 입력하세요`);
  };
  $('#isbnGo', body).onclick = () => {
    const v = cleanISBN($('#isbnIn', body).value);
    if (!isISBN13(v)) { toast('ISBN 13자리를 확인해 주세요'); return; }
    lookup(v);
  };
  const doTitle = async () => {
    const q = $('#titleIn', body).value.trim();
    if (!q) return;
    results.innerHTML = '<div class="loading">찾는 중…</div>';
    const list = await searchTitle(q).catch(() => []);
    if (!list.length) { results.innerHTML = '<div class="empty small">검색 결과가 없어요</div>'; return; }
    results.innerHTML = list.map((b, i) => `<button class="res" data-i="${i}">${b.cover ? `<img src="${esc(b.cover)}" alt="" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}<div><b>${esc(b.title)}</b><small>${esc(b.authors.join(', '))}${b.publisher ? ' · ' + esc(b.publisher) : ''}${b.pages ? ` · ${b.pages}쪽` : ''}</small></div></button>`).join('');
    $$('.res', results).forEach((el) => (el.onclick = async () => {
      const b = list[+el.dataset.i];
      if (!b.pages && b.isbn) {
        const more = await lookupISBN(b.isbn).catch(() => null);
        if (more?.pages) b.pages = more.pages;
      }
      confirmBook(b);
    }));
  };
  $('#titleGo', body).onclick = doTitle;
  $('#titleIn', body).onkeydown = (e) => { if (e.key === 'Enter') doTitle(); };
  $('#isbnIn', body).onkeydown = (e) => { if (e.key === 'Enter') $('#isbnGo', body).click(); };
  $('#manual', body).onclick = () => confirmBook({ title: '', authors: [], pages: 0, cover: '', isbn: '' });

  function confirmBook(info) {
    stopScan?.(); stopScan = null;
    const dup = info.isbn && state.books.find((b) => b.isbn === info.isbn);
    body.innerHTML = `
      <h3>${info.notFound ? '책 정보를 직접 넣어주세요' : '이 책이 맞나요?'}</h3>
      ${info.notFound ? `<div class="notice warn"><b>바코드는 읽었어요 (ISBN ${esc(info.isbn)})</b><br>그런데 ${getKakaoKey() ? '연결된 곳들에' : '구글 북스·오픈 라이브러리에'} 이 책 정보가 없어요.${getKakaoKey() ? '' : ' 국내 책은 <b>설정 → 카카오 REST 키</b>를 넣으면 대부분 찾아져요.'} 지금은 아래에 제목만 적어도 꽂을 수 있어요.</div>` : ''}
      ${dup ? '<p class="warn">이미 책장에 있는 책이에요.</p>' : ''}
      <div class="confirm">
        ${info.cover ? `<img src="${esc(info.cover)}" alt="" referrerpolicy="no-referrer">` : '<div class="noimg big"></div>'}
        <div class="cf-fields">
          <label>제목<input id="cTitle" value="${esc(info.title)}"></label>
          <label>저자<input id="cAuth" value="${esc((info.authors || []).join(', '))}"></label>
          <label>전체 쪽수${info.pages ? '' : ' <small class="warn">못 찾았어요, 직접 입력해 주세요</small>'}<input id="cPages" type="number" inputmode="numeric" value="${info.pages || ''}"></label>
        </div>
      </div>
      <label>어느 칸에 꽂을까요?<div class="seg" id="cStatus">${Object.entries(STATUS).map(([k, v], i) => `<button type="button" data-k="${k}" class="${i === 0 ? 'on' : ''}">${v}</button>`).join('')}</div></label>
      <div class="btn-row"><button class="primary" id="cSave">책장에 꽂기</button></div>`;
    let status = 'reading';
    $$('#cStatus button', body).forEach((b) => (b.onclick = () => { $$('#cStatus button', body).forEach((x) => x.classList.remove('on')); b.classList.add('on'); status = b.dataset.k; }));
    if (!info.title) setTimeout(() => $('#cTitle', body).focus(), 200);
    $('#cSave', body).onclick = async () => {
      const title = $('#cTitle', body).value.trim();
      if (!title) { toast('제목을 적어주세요'); return; }
      const book = {
        id: uid(), title,
        authors: $('#cAuth', body).value.split(',').map((s) => s.trim()).filter(Boolean),
        pages: +$('#cPages', body).value || 0,
        cover: info.cover || '', isbn: info.isbn || '', publisher: info.publisher || '',
        status, createdAt: Date.now(),
      };
      await db.put('books', book);
      await closeTop();
      await reloadShelf();
      shelf.focusBook(book.id);
      toast(`'${title}'을(를) 꽂았어요`);
    };
  }
}

function editBookSheet() {
  const book = { ...state.current.book };
  const body = openSheet(`
    <h3>책 정보</h3>
    <label>제목<input id="eTitle" value="${esc(book.title)}"></label>
    <label>저자<input id="eAuth" value="${esc((book.authors || []).join(', '))}"></label>
    <div class="grid2">
      <label>전체 쪽수<input id="ePages" type="number" inputmode="numeric" value="${book.pages || ''}"></label>
      <label>ISBN<input id="eIsbn" value="${esc(book.isbn || '')}"></label>
    </div>
    <div class="btn-row"><button class="danger" id="eDel">책 빼기</button><button class="primary" id="eSave">저장</button></div>`);
  $('#eSave', body).onclick = async () => {
    book.title = $('#eTitle', body).value.trim() || book.title;
    book.authors = $('#eAuth', body).value.split(',').map((s) => s.trim()).filter(Boolean);
    book.pages = +$('#ePages', body).value || 0;
    book.isbn = cleanISBN($('#eIsbn', body).value);
    await db.put('books', book);
    state.shelfDirty = true;
    await closeTop();
    await afterChange();
  };
  $('#eDel', body).onclick = async () => {
    if (!confirm(`'${book.title}'을(를) 책장에서 뺄까요?\n밑줄과 인물 정리도 모두 지워져요.`)) return;
    await closeTop();
    await closeTop(); // 책 패널 닫기
    const wait = () => new Promise((r) => { const t = () => (shelf.openState || shelf.busy ? setTimeout(t, 80) : r()); t(); });
    await wait();
    await db.deleteBook(book.id);
    await reloadShelf();
    toast('책을 뺐어요');
  };
}

/* ================= 메모장에서 가져오기 ================= */
const PAGE_RE = /(?:^|[\s(\[])(?:p\.?|P\.?|pp\.?)\s*(\d{1,4})\b|(\d{1,4})\s*(?:쪽|페이지|page|p\b)/;
export function parseMemo(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  const chunks = /\n\s*\n/.test(raw) ? raw.split(/\n\s*\n+/) : raw.split('\n');
  return chunks.map((c) => {
    let t = c.trim().replace(/^[-*•·]\s*/, '');
    const m = t.match(PAGE_RE);
    let page = 0;
    if (m) {
      page = +(m[1] || m[2]);
      t = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
    }
    t = t.replace(/^[\s:–—\-|)]+|[\s:–—\-|(]+$/g, '').replace(/^["“'‘]|["”'’]$/g, '').trim();
    return { text: t, page };
  }).filter((x) => x.text.length > 1);
}

function importSheet() {
  const body = openSheet(`
    <h3>메모장에서 가져오기</h3>
    <p class="hint">메모장 내용을 그대로 붙여넣으세요. 빈 줄로 나뉜 덩어리(없으면 한 줄)를 글귀 하나로 보고, <b>p.123 · 123쪽 · 123p</b> 같은 표시는 쪽수로 읽어요.</p>
    <textarea id="memo" rows="9" placeholder="p.23 행복한 가정은 모두 엇비슷하고…&#10;&#10;45쪽 - 사람은 무엇으로 사는가"></textarea>
    <div id="memoPrev" class="memo-prev"></div>
    <div class="btn-row"><button class="primary" id="memoSave" disabled>가져오기</button></div>`, { full: true });
  let parsed = [];
  $('#memo', body).oninput = (e) => {
    parsed = parseMemo(e.target.value);
    const withPage = parsed.filter((p) => p.page).length;
    $('#memoPrev', body).innerHTML = parsed.length
      ? `<div class="mp-sum">글귀 ${parsed.length}개 · 쪽수 인식 ${withPage}개</div>` + parsed.slice(0, 30).map((p) => `<div class="mp"><b>${p.page ? 'p.' + p.page : '쪽?'}</b> ${esc(p.text.slice(0, 80))}</div>`).join('')
      : '';
    $('#memoSave', body).disabled = !parsed.length;
  };
  $('#memoSave', body).onclick = async () => {
    const bookId = state.current.book.id;
    let i = 0;
    for (const p of parsed) await db.put('quotes', { id: uid(), bookId, text: p.text, page: p.page, tags: [], note: '', createdAt: Date.now() + i++ });
    state.shelfDirty = true;
    await closeTop();
    await afterChange();
    toast(`글귀 ${parsed.length}개를 가져왔어요`);
  };
}

/* ================= 검색 ================= */
async function searchSheet() {
  const [quotes, people] = await Promise.all([db.all('quotes'), db.all('people')]);
  const books = Object.fromEntries(state.books.map((b) => [b.id, b]));
  const tagCount = {};
  quotes.forEach((q) => (q.tags || []).forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1)));
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const body = openSheet(`
    <h3>찾기</h3>
    <input id="sq" class="search-in" placeholder="글귀, 생각, 태그, 책 제목, 인물 이름" autocomplete="off">
    ${tags.length ? `<div class="tags tag-filter">${tags.map(([t, n]) => `<button class="tag" data-t="${esc(t)}">#${esc(t)} <small>${n}</small></button>`).join('')}</div>` : ''}
    <div id="sres"></div>`, { full: true });
  const input = $('#sq', body);
  setTimeout(() => input.focus(), 300);
  const run = () => {
    const raw = input.value.trim();
    const out = $('#sres', body);
    if (!raw) { out.innerHTML = '<div class="empty small">모든 책의 밑줄에서 찾아요</div>'; return; }
    const tagOnly = raw.startsWith('#') ? raw.slice(1).toLowerCase() : null;
    const q = raw.toLowerCase();
    const qs = quotes.filter((x) => books[x.bookId] && (tagOnly
      ? (x.tags || []).some((t) => t.toLowerCase() === tagOnly)
      : (x.text + ' ' + (x.note || '') + ' ' + (x.tags || []).join(' ') + ' ' + books[x.bookId].title).toLowerCase().includes(q)))
      .sort((a, b) => (a.bookId === b.bookId ? (pageKey(a) === pageKey(b) ? a.createdAt - b.createdAt : pageKey(a) - pageKey(b)) : books[a.bookId].title.localeCompare(books[b.bookId].title)));
    const nq = normalizeName(raw);
    const ps = tagOnly || !nq ? [] : people.filter((p) => books[p.bookId] && isRevealed(p, books[p.bookId].chapter || 0)).map((p) => sanitizePerson(p, books[p.bookId].chapter || 0)).filter((p) => [p.name, ...(p.aliases || []).map((a) => a.name)].some((n) => normalizeName(n).includes(nq)));
    const mark = (s) => esc(s).replace(new RegExp(esc(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    out.innerHTML =
      (ps.length ? `<h4 class="sec">인물</h4>${ps.map((p) => `<button class="sr person" data-b="${p.bookId}"><b>${esc(p.name)}</b> <small>${esc(books[p.bookId].title)}</small><div class="muted">${esc((p.aliases || []).map((a) => a.name).join(' · '))}</div></button>`).join('')}` : '') +
      (qs.length ? `<h4 class="sec">밑줄 ${qs.length}</h4>${qs.slice(0, 100).map((x) => `<button class="sr" data-b="${x.bookId}" data-q="${x.id}"><div class="sr-src">${esc(books[x.bookId].title)} · <b>p.${x.page || '?'}</b></div>${x.image ? `<img class="sr-img" src="${x.image}" alt="">` : ''}${x.text ? `<div class="sr-text">${tagOnly ? esc(x.text) : mark(x.text)}</div>` : ''}${x.note ? `<div class="muted">${tagOnly ? esc(x.note) : mark(x.note)}</div>` : ''}</button>`).join('')}` : '') ||
      '<div class="empty small">찾는 내용이 없어요</div>';
    $$('.sr', out).forEach((b) => (b.onclick = async () => {
      await closeTop();
      if (state.current) await closeTop();
      const wait = () => new Promise((r) => { const t = () => (shelf.openState || shelf.busy ? setTimeout(t, 80) : r()); t(); });
      await wait();
      await openBook(b.dataset.b, b.dataset.q);
      if (b.classList.contains('person')) { state.tab = 'people'; renderPanel(); }
    }));
  };
  input.oninput = run;
  $$('.tag-filter .tag', body).forEach((b) => (b.onclick = () => { input.value = '#' + b.dataset.t; run(); }));
  run();
}

/* ================= 설정 ================= */
function settingsSheet() {
  const body = openSheet(`
    <h3>설정</h3>
    <label>카카오 REST API 키 <small>선택 · 국내 책 정보를 더 잘 찾아요</small>
      <input id="kKey" value="${esc(getKakaoKey())}" placeholder="developers.kakao.com 에서 발급" autocomplete="off"></label>
    <p class="hint">키는 이 기기에만 저장돼요. 없으면 구글 북스로만 찾아요.</p>
    <button class="ghost wide" id="kSave">키 저장</button>
    <h4 class="sec">백업</h4>
    <p class="hint">기록은 이 기기의 브라우저에만 저장돼요. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 꼭 내보내 두세요.</p>
    <div class="btn-row"><button class="ghost" id="bExport">내보내기</button><label class="ghost">불러오기<input type="file" accept="application/json,.json" id="bImport" hidden></label></div>
    <h4 class="sec">앱 업데이트</h4>
    <p class="hint">새 버전을 올렸는데 화면이 그대로면 눌러주세요. 기록은 지워지지 않아요.</p>
    <button class="ghost wide" id="appReload">새로고침</button>
    <p class="muted center">밑줄서재 v${APP_VERSION}</p>`);
  $('#appReload', body).onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = '새 버전 받는 중…';
    try {
      // 브라우저 HTTP 캐시까지 새로 받기
      const files = ['./', './index.html', './style.css', './sw.js', './manifest.webmanifest',
        ...['app', 'db', 'bookapi', 'scanner', 'ocr', 'graph', 'shelf3d', 'peopletext'].map((n) => `./js/${n}.js`)];
      await Promise.all(files.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    } catch {}
    location.reload();
  };
  $('#kSave', body).onclick = () => {
    try { localStorage.setItem('kakaoKey', $('#kKey', body).value.trim()); } catch {}
    toast('저장했어요');
  };
  $('#bExport', body).onclick = async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `밑줄서재-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#bImport', body).onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const replace = confirm('지금 기록을 지우고 백업으로 바꿀까요?\n취소를 누르면 지금 기록에 합쳐요.');
      await db.importAll(data, { replace });
      await closeTop();
      await reloadShelf();
      toast('백업을 불러왔어요');
    } catch (err) { toast(err.message || '불러오지 못했어요'); }
  };
}

/* ================= 다른 앱에서 공유받기 (구글 렌즈 → 공유 → 밑줄서재) ================= */
function handleShared() {
  const sp = new URLSearchParams(location.search);
  const raw = [sp.get('text'), sp.get('title')].filter(Boolean).join('\n');
  if (!raw) return;
  history.replaceState(null, '', location.pathname);
  const { text, page } = cleanPasted(raw.replace(/https?:\/\/\S+/g, ''));
  if (!text) return;
  if (!state.books.length) { toast('먼저 책을 꽂은 뒤 다시 공유해 주세요'); return; }
  const order = { reading: 0, want: 1, done: 2 };
  const books = [...state.books].sort((a, b) => (order[a.status || 'reading'] - order[b.status || 'reading']) || b.createdAt - a.createdAt);
  const body = openSheet(`
    <h3>어느 책의 밑줄인가요?</h3>
    <blockquote class="shared"><span class="hl">${esc(text.slice(0, 160))}${text.length > 160 ? '…' : ''}</span></blockquote>
    <div class="pick-books">${books.map((b) => `<button class="res" data-id="${b.id}">${b.cover ? `<img src="${esc(b.cover)}" alt="" referrerpolicy="no-referrer">` : `<div class="noimg" style="background:${colorOf(b.id) || bookColor(b.id + b.title)}"></div>`}<div><b>${esc(b.title)}</b><small>${STATUS[b.status || 'reading']}</small></div></button>`).join('')}</div>`);
  $$('.pick-books .res', body).forEach((el) => (el.onclick = async () => {
    await closeTop();
    await openBook(el.dataset.id);
    quoteSheet(null, { text, page });
  }));
}

// 가려진 설명: 톡하면 그 자리에서만 보이기 (카드 열기보다 먼저 처리)
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-unblur]');
  if (!el || el.classList.contains('open')) return;
  e.stopPropagation();
  e.preventDefault();
  el.classList.add('open');
}, true);

/* ================= 시작 ================= */
async function init() {
  $('#btnSearch').innerHTML = icon.search;
  $('#btnSettings').innerHTML = icon.gear;
  $('#btnSearch').onclick = searchSheet;
  $('#btnSettings').onclick = settingsSheet;
  $('#fab').onclick = addBookSheet;
  $('#btnBack').onclick = back;

  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('700 40px Pretendard', '가'),
        document.fonts.load('400 26px "Gowun Batang"', '가'),
      ]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch {}

  try {
    shelf = new Shelf($('#stage'), {
      onBookTap: (id) => { if (!state.current) openBook(id); },
      onEmptyTap: () => { if (state.current && !shelf.busy) back(); },
    });
  } catch (e) {
    $('#stage').innerHTML = '<div class="nogl">이 기기에서는 3D 책장을 띄울 수 없어요.</div>';
    console.error(e);
    return;
  }
  await reloadShelf();

  handleShared();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init();
