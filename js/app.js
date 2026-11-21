// 밑줄서재 — 앱 본체
import { db, uid } from './db.js';
import { lookupISBN, searchTitle, cleanISBN, isISBN13, getKakaoKey } from './bookapi.js';
import { startScan, decodeImageFile } from './scanner.js';
import { fileToCanvas, recognizeAuto, rotateCanvas, cropCanvas, findPageNumber, fitForOcr, joinWords } from './ocr.js';
import { createGraph, REL_KINDS, ALIAS_KINDS, familyColor, visibleAliases, marriedVisible } from './graph.js';
import { Shelf, bookColor, colorOf } from './shelf3d.js';

const APP_VERSION = '1.1.0';
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
  barcode: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6v12M7 6v12M11 6v12M14 6v12M18 6v12M20 6v12"/></svg>',
};

/* ================= 데이터 ================= */
async function loadBooks() {
  state.books = (await db.all('books')).sort((a, b) => a.createdAt - b.createdAt);
}

async function loadCurrent(bookId) {
  const book = await db.get('books', bookId);
  if (!book) { state.current = null; return; }
  const [quotes, people, relations] = await Promise.all([
    db.byBook('quotes', bookId), db.byBook('people', bookId), db.byBook('relations', bookId),
  ]);
  quotes.sort((a, b) => (a.page || 0) - (b.page || 0) || a.createdAt - b.createdAt);
  people.sort((a, b) => (a.firstPage || 0) - (b.firstPage || 0) || a.createdAt - b.createdAt);
  state.current = { book, quotes, people, relations };
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
  const sorted = [...quotes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const q = sorted[seed % sorted.length];
  const b = state.books.find((x) => x.id === q.bookId);
  if (!b) { el.hidden = true; return; }
  el.innerHTML = `<div class="today-label">오늘의 한 줄</div><p class="today-text"><span class="hl">${esc(q.text)}</span></p><div class="today-src">${esc(b.title)} · p.${q.page || '?'}</div>`;
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
    const lines = wrap(x, q.text, 380).slice(0, 3);
    const need = 36 + lines.length * 40 + 24;
    if (y + need > 730) break;
    x.fillStyle = '#c8553d'; x.font = '700 20px Pretendard, sans-serif';
    x.fillText(`p.${q.page || '?'}`, 70, y);
    y += 36;
    x.font = '400 26px "Gowun Batang", serif';
    lines.forEach((l, i) => {
      const w = x.measureText(l).width;
      x.fillStyle = 'rgba(242,201,76,.55)'; x.fillRect(68, y - 12, w + 4, 14);
      x.fillStyle = '#2b2622'; x.fillText(l + (i === 2 && wrap(x, q.text, 380).length > 3 ? '…' : ''), 70, y);
      y += 40;
    });
    y += 24;
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
    <div class="bp-actions">${state.tab === 'quotes'
      ? `<button class="primary" id="addQuote">＋ 밑줄 긋기</button><button class="ghost" id="importBtn">메모장에서 가져오기</button>`
      : `<button class="primary" id="addPerson">＋ 인물</button><button class="ghost" id="addRel">＋ 관계</button>`}</div>`;

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
  $$('.tabs button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderPanel(); }));
  $$('.pb-dot').forEach((d) => (d.onclick = () => { if (state.tab !== 'quotes') { state.tab = 'quotes'; renderPanel(); } focusQuote(d.dataset.q); }));
  if (state.tab === 'quotes') {
    $('#addQuote').onclick = () => quoteSheet();
    $('#importBtn').onclick = () => importSheet();
    renderQuotes();
  } else {
    $('#addPerson').onclick = () => personSheet();
    $('#addRel').onclick = () => relationSheet();
    renderPeople();
  }
}

function renderQuotes() {
  const { quotes, people } = state.current;
  const body = $('#tabBody');
  if (!quotes.length) {
    body.innerHTML = `<div class="empty">마음에 남은 문장이 있으면<br><b>＋ 밑줄 긋기</b>로 쪽수와 함께 남겨두세요.<br><small>사진을 찍으면 글자를 읽어서 형광펜처럼 고를 수 있어요.</small></div>`;
    return;
  }
  body.innerHTML = quotes.map((q) => `
    <article class="q" data-id="${q.id}">
      <div class="q-page">p.${q.page || '?'}</div>
      <blockquote><span class="hl">${linkNames(q.text, people)}</span></blockquote>
      ${q.note ? `<p class="q-note">${esc(q.note)}</p>` : ''}
      ${q.tags?.length ? `<div class="tags">${q.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    </article>`).join('');
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

function personCard(p, page, hit) {
  const al = visibleAliases(p, page);
  const married = marriedVisible(p, page);
  return `<div class="pcard" data-pid="${p.id}">
    <div class="pc-dot" style="background:${familyColor(p.family)};${married ? `box-shadow:0 0 0 3px ${familyColor(p.marriedFamily)}` : ''}"></div>
    <div class="pc-main">
      <div class="pc-name">${esc(p.name)} ${p.family ? `<span class="fam" style="--fc:${familyColor(p.family)}">${esc(p.family)}</span>` : ''}${married ? ` → <span class="fam" style="--fc:${familyColor(p.marriedFamily)}">${esc(p.marriedFamily)}</span>` : ''}</div>
      ${hit && hit.kind !== '대표 이름' ? `<div class="pc-hit">‘${esc(hit.name)}’은(는) ${esc(hit.kind)}예요</div>` : ''}
      ${al.length ? `<div class="aliases">${al.map((a) => `<span class="alias"><i>${esc(a.kind)}</i>${esc(a.name)}${a.page ? `<small>p.${a.page}</small>` : ''}</span>`).join('')}</div>` : ''}
      ${p.desc ? `<div class="pc-desc">${esc(p.desc)}</div>` : ''}
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
  const page = Math.min(state.graphPage, maxP);
  const body = $('#tabBody');
  if (!people.length) {
    body.innerHTML = `<div class="empty">외국 소설처럼 이름·애칭·호칭·결혼 후 성이 헷갈릴 때<br><b>＋ 인물</b>로 한 사람의 여러 이름을 묶어두세요.<br><small>이름마다 처음 나온 쪽을 적어두면 스포일러 없이 볼 수 있어요.</small></div>`;
    return;
  }
  const fams = [...new Set(people.flatMap((p) => [p.family, p.marriedFamily]).filter(Boolean))];
  body.innerHTML = `
    <div class="finder">
      <input id="nameFind" placeholder="이 이름 누구지? 애칭·호칭·성으로도 찾아요" autocomplete="off">
      <div id="findOut"></div>
    </div>
    <div class="graph-box"><svg id="graphSvg"></svg><button class="graph-expand" id="graphExpand" type="button">⤢ 크게 보기</button></div>
    <p class="graph-tip">빈 곳을 쓸면 화면이 내려가고, 인물 동그라미를 끌면 자리를 옮겨요</p>
    <div class="slider">
      <label><b>p.${page}</b>까지 보기 <small>그 뒤에 나오는 이름과 관계는 숨겨요</small></label>
      <input type="range" id="pageSlider" min="0" max="${maxP}" value="${page}">
    </div>
    <div class="legend">
      ${fams.map((f) => `<span><i style="background:${familyColor(f)}"></i>${esc(f)}</span>`).join('')}
      ${Object.values(REL_KINDS).map((k) => `<span><i class="ln" style="border-color:${k.color};border-top-style:${k.dash ? 'dashed' : 'solid'}"></i>${k.label}</span>`).join('')}
      <span><i class="ring"></i>테두리 = 결혼 후 가문</span>
    </div>
    <h4 class="sec">인물</h4>
    <div class="people">${people.filter((p) => (p.firstPage || 0) <= page).map((p) => personCard(p, page)).join('') || '<div class="empty small">이 쪽까지 나온 인물이 없어요</div>'}</div>
    <h4 class="sec">관계</h4>
    <div class="rels">${relations.filter((r) => (r.page || 0) <= page).sort((a, b) => (a.page || 0) - (b.page || 0)).map((r) => {
      const a = people.find((p) => p.id === r.from); const b = people.find((p) => p.id === r.to);
      if (!a || !b) return '';
      const k = REL_KINDS[r.kind] || REL_KINDS.etc;
      return `<button class="rel" data-rid="${r.id}"><span class="rk" style="--rc:${k.color}">${k.label}</span>${esc(a.name)} — ${esc(b.name)}${r.label ? ` <em>${esc(r.label)}</em>` : ''}${r.page ? ` <small>p.${r.page}</small>` : ''}</button>`;
    }).join('') || '<div class="empty small">아직 관계가 없어요</div>'}</div>`;

  state.graph?.destroy();
  state.graph = createGraph($('#graphSvg'), { onNodeTap: (p) => personSheet(p) });
  state.graph.setData(people, relations, page);
  $('#graphExpand').onclick = () => graphSheet(maxP);

  const slider = $('#pageSlider');
  slider.oninput = () => {
    state.graphPage = +slider.value;
    $('.slider b').textContent = `p.${slider.value}`;
    state.graph.setData(people, relations, +slider.value);
  };
  slider.onchange = () => renderPeople();
  const find = $('#nameFind');
  find.oninput = () => {
    const res = findPeople(find.value, state.graphPage);
    $('#findOut').innerHTML = find.value.trim()
      ? (res.length ? res.map(({ p, hit }) => personCard(p, state.graphPage, hit)).join('') : '<div class="empty small">이 쪽까지는 그런 이름이 없어요</div>')
      : '';
    $$('#findOut .pcard').forEach((c) => (c.onclick = () => personSheet(people.find((p) => p.id === c.dataset.pid))));
  };
  $$('.people .pcard').forEach((c) => (c.onclick = () => personSheet(people.find((p) => p.id === c.dataset.pid))));
  $$('.rel').forEach((b) => (b.onclick = () => relationSheet(relations.find((r) => r.id === b.dataset.rid))));
}

// 관계도 전체 화면: 화면 스크롤과 겹치지 않게 넓게 보고 정리
function graphSheet(maxP) {
  const { people, relations } = state.current;
  let g = null;
  const body = openSheet(`
    <h3>인물 관계도</h3>
    <div class="graph-box big"><svg id="graphBig"></svg></div>
    <div class="slider">
      <label><b id="bigLabel">p.${state.graphPage}</b>까지 보기</label>
      <input type="range" id="bigSlider" min="0" max="${maxP}" value="${state.graphPage}">
    </div>`, { full: true, onClose: () => { g?.destroy(); if (state.current && state.tab === 'people') renderPeople(); } });
  requestAnimationFrame(() => {
    g = createGraph($('#graphBig', body), { onNodeTap: (p) => personSheet(p) });
    g.setData(people, relations, state.graphPage);
  });
  const sl = $('#bigSlider', body);
  sl.oninput = () => {
    state.graphPage = +sl.value;
    $('#bigLabel', body).textContent = `p.${sl.value}`;
    g?.setData(state.current.people, state.current.relations, +sl.value);
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
    <label>메모<textarea id="pDesc" rows="2" placeholder="어떤 사람인지 한 줄">${esc(p.desc || '')}</textarea></label>
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
    p.desc = $('#pDesc', body).value.trim();
    p.aliases = $$('.alias-row', list).map((r) => ({
      kind: $('.al-kind', r).value, name: $('.al-name', r).value.trim(), page: +$('.al-page', r).value || 0,
    })).filter((a) => a.name);
    await db.put('people', p);
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
    <div class="grid2">
      <label>인물 A<select id="rA">${opts(r.from)}</select></label>
      <label>인물 B<select id="rB">${opts(r.to)}</select></label>
    </div>
    <label>종류<div class="seg" id="rKind">${Object.entries(REL_KINDS).map(([k, v]) => `<button type="button" data-k="${k}" class="${k === r.kind ? 'on' : ''}" style="--rc:${v.color}">${v.label}</button>`).join('')}</div></label>
    <div class="grid2">
      <label>관계 이름<input id="rLabel" value="${esc(r.label)}" placeholder="예: 남매, 약혼, 하녀"></label>
      <label>드러난 쪽<input id="rPage" type="number" inputmode="numeric" value="${r.page || ''}"></label>
    </div>
    <p class="hint">같은 두 사람이라도 쪽마다 관계를 따로 적으면(친구 → 부부) 슬라이더에 따라 바뀌어 보여요.</p>
    <div class="btn-row">${isNew ? '' : '<button class="danger" id="rDel">삭제</button>'}<button class="primary" id="rSave">저장</button></div>`);
  $$('#rKind button', body).forEach((b) => (b.onclick = () => { $$('#rKind button', body).forEach((x) => x.classList.remove('on')); b.classList.add('on'); r.kind = b.dataset.k; }));
  $('#rSave', body).onclick = async () => {
    r.from = $('#rA', body).value; r.to = $('#rB', body).value;
    if (r.from === r.to) { toast('서로 다른 두 사람을 골라주세요'); return; }
    r.label = $('#rLabel', body).value.trim();
    r.page = +$('#rPage', body).value || 0;
    await db.put('relations', r);
    await afterChange();
    await closeTop();
  };
  $('#rDel', body) && ($('#rDel', body).onclick = async () => {
    await db.del('relations', r.id);
    await afterChange();
    await closeTop();
  });
}

async function afterChange() {
  if (!state.current) return;
  await loadCurrent(state.current.book.id);
  renderPanel();
  refreshPages();
}

/* ================= 글귀 ================= */
function quoteSheet(q) {
  const isNew = !q;
  q = q ? { ...q } : { id: uid(), bookId: state.current.book.id, createdAt: Date.now(), tags: [] };
  const body = openSheet(`
    <h3>${isNew ? '밑줄 긋기' : '밑줄 고치기'}</h3>
    <div class="ocr-btns">
      <label class="ghost">${icon.camera} 사진 찍기<input type="file" accept="image/*" capture="environment" id="qCam" hidden></label>
      <label class="ghost">${icon.image} 앨범에서<input type="file" accept="image/*" id="qAlbum" hidden></label>
    </div>
    <label>쪽<input id="qPage" type="number" inputmode="numeric" value="${q.page || ''}" placeholder="몇 쪽?"></label>
    <label>글귀<textarea id="qText" rows="4" placeholder="마음에 남은 문장">${esc(q.text || '')}</textarea></label>
    <label>내 생각 <small>선택</small><textarea id="qNote" rows="2">${esc(q.note || '')}</textarea></label>
    <label>태그 <small>띄어쓰기로 구분</small><input id="qTags" value="${esc((q.tags || []).map((t) => '#' + t).join(' '))}" placeholder="#위로 #문장력"></label>
    <div class="btn-row">${isNew ? '' : '<button class="danger" id="qDel">삭제</button>'}<button class="primary" id="qSave">저장</button></div>`);
  const onFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) ocrSheet(f, (text, page) => {
      const t = $('#qText', body);
      t.value = t.value.trim() ? t.value.trim() + '\n' + text : text;
      if (page && !$('#qPage', body).value) $('#qPage', body).value = page;
    });
  };
  $('#qCam', body).onchange = onFile;
  $('#qAlbum', body).onchange = onFile;
  if (isNew) setTimeout(() => $('#qPage', body).focus(), 300);
  $('#qSave', body).onclick = async () => {
    q.text = $('#qText', body).value.trim();
    if (!q.text) { toast('글귀를 적어주세요'); return; }
    q.page = +$('#qPage', body).value || 0;
    q.note = $('#qNote', body).value.trim();
    q.tags = parseTags($('#qTags', body).value);
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
      .sort((a, b) => (a.bookId === b.bookId ? (a.page || 0) - (b.page || 0) : books[a.bookId].title.localeCompare(books[b.bookId].title)));
    const nq = normalizeName(raw);
    const ps = tagOnly || !nq ? [] : people.filter((p) => books[p.bookId] && [p.name, ...(p.aliases || []).map((a) => a.name)].some((n) => normalizeName(n).includes(nq)));
    const mark = (s) => esc(s).replace(new RegExp(esc(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    out.innerHTML =
      (ps.length ? `<h4 class="sec">인물</h4>${ps.map((p) => `<button class="sr person" data-b="${p.bookId}"><b>${esc(p.name)}</b> <small>${esc(books[p.bookId].title)}</small><div class="muted">${esc((p.aliases || []).map((a) => a.name).join(' · '))}</div></button>`).join('')}` : '') +
      (qs.length ? `<h4 class="sec">밑줄 ${qs.length}</h4>${qs.slice(0, 100).map((x) => `<button class="sr" data-b="${x.bookId}" data-q="${x.id}"><div class="sr-src">${esc(books[x.bookId].title)} · <b>p.${x.page || '?'}</b></div><div class="sr-text">${tagOnly ? esc(x.text) : mark(x.text)}</div>${x.note ? `<div class="muted">${tagOnly ? esc(x.note) : mark(x.note)}</div>` : ''}</button>`).join('')}` : '') ||
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
        ...['app', 'db', 'bookapi', 'scanner', 'ocr', 'graph', 'shelf3d'].map((n) => `./js/${n}.js`)];
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

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init();
