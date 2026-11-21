// 사진 → 글자 인식 (Tesseract.js, 기기 안에서 처리)
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

let workerPromise = null;
let progressCb = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('OCR 라이브러리를 불러오지 못했어요'));
    document.head.appendChild(s);
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESS_URL);
      return window.Tesseract.createWorker('kor+eng', 1, {
        logger: (m) => progressCb && progressCb(m),
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// 이미지 파일을 적당한 크기의 캔버스로 (인식 속도와 정확도 균형)
// 사진의 회전 정보(EXIF)를 반영해서 세로 사진이 눕지 않게
export async function fileToCanvas(file, maxSide = 1800) {
  let src = null;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  if (!src) {
    src = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.style.imageOrientation = 'from-image';
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없어요')); };
      img.src = url;
    });
  }
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * scale);
  c.height = Math.round(h0 * scale);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  src.close?.();
  return c;
}

// 시계 방향으로 deg(90/180/270)만큼 돌린 새 캔버스
export function rotateCanvas(c, deg) {
  const r = document.createElement('canvas');
  const quarter = deg % 180 !== 0;
  r.width = quarter ? c.height : c.width;
  r.height = quarter ? c.width : c.height;
  const x = r.getContext('2d');
  x.translate(r.width / 2, r.height / 2);
  x.rotate((deg * Math.PI) / 180);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  return r;
}

export async function recognize(canvas, onProgress) {
  progressCb = onProgress;
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  progressCb = null;
  const words = (data.words || [])
    .filter((w) => w.text && w.text.trim())
    .map((w, i) => ({ i, text: w.text.trim(), bbox: w.bbox, conf: w.confidence, blk: data.blocks ? data.blocks.indexOf(w.block) : 0, lineN: w.line?.words?.length || 1, lineHangul: ((w.line?.text || '').match(/[가-힣]/g) || []).length }));
  const good = words.filter((w) => w.conf >= 60).length;
  return { words, width: canvas.width, height: canvas.height, page: guessPage(words, canvas.height), conf: data.confidence || 0, score: (data.confidence || 0) * Math.sqrt(good + 1) };
}

// 위·아래 가장자리에 있는 숫자 단어를 쪽수로 추정
export function guessPage(words, H) {
  const cands = words
    .map((w) => ({ w, n: w.text.replace(/[^0-9]/g, '') }))
    .filter(({ w, n }) => n.length >= 1 && n.length <= 4 && n.length >= w.text.length - 1 && w.lineHangul <= 4 &&
      (w.bbox.y0 > H * 0.84 || w.bbox.y1 < H * 0.14))
    .map(({ w, n }) => ({ n: +n, bottom: w.bbox.y0 > H * 0.84, conf: w.conf }))
    .filter((c) => c.n > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => (b.bottom - a.bottom) || (b.conf - a.conf));
  return cands[0].n;
}

// 선택된 단어들을 문장으로 합치기
// 한글은 인식기가 글자 단위로 쪼개는 경우가 많아서, 실제 간격이 좁으면 붙이고 넓으면 띄움
// 낱말 끝에 자주 오는 글자(조사·어미). 줄 끝 글자가 이 중 하나면 낱말이 끝난 것으로 보고 띄움
export const WORD_END = /[다요고는은을를이가에의도로서며면지게와과께만나데니네죠군걸것듯랑한할된될던운울인일적들럼야여아어든록]/;

export function joinWords(words) {
  let out = '';
  let prev = null;
  for (const w of words) {
    if (prev) {
      const ph = prev.bbox.y1 - prev.bbox.y0;
      const h = Math.max(ph, w.bbox.y1 - w.bbox.y0, 1);
      const pc = (prev.bbox.y0 + prev.bbox.y1) / 2;
      const wc = (w.bbox.y0 + w.bbox.y1) / 2;
      const sameLine = Math.abs(wc - pc) < h * 0.6 && w.bbox.x0 > prev.bbox.x0;
      const gap = w.bbox.x0 - prev.bbox.x1;
      if (sameLine) {
        if (gap > h * 0.28) out += ' ';
      } else {
        // 다음 줄로 넘어갈 때: 한글 책은 낱말 중간에서도 줄이 바뀜 ("그\n런") → 줄 끝이 낱말 끝 글자가 아니면 붙임
        const last = out.slice(-1);
        const first = w.text[0] || '';
        const hangul = /[가-힣]/;
        if (!(hangul.test(last) && hangul.test(first) && !WORD_END.test(last))) out += ' ';
      }
    }
    out += w.text;
    prev = w;
  }
  return out.replace(/\s+([,.!?…”’)\]])/g, '$1').replace(/([“‘(\[])\s+/g, '$1').replace(/\s+/g, ' ').trim();
}

// 방향 자동 맞춤: 인식 품질이 낮으면 90°/270°로 돌려서 더 잘 읽히는 쪽을 고름
export async function recognizeAuto(canvas, onProgress, onStage) {
  let best = { canvas, deg: 0, r: await recognize(canvas, onProgress) };
  if (best.r.conf >= 65 && best.r.words.length >= 4) return best;
  for (const deg of [90, 270]) {
    onStage?.(deg);
    const c = rotateCanvas(canvas, deg);
    const r = await recognize(c, onProgress);
    if (r.score > best.r.score * 1.15) best = { canvas: c, deg, r };
    if (best.r.conf >= 70) break;
  }
  return best;
}

// 잘라낸 캔버스 (x, y, w, h는 0~1 비율)
export function cropCanvas(c, r) {
  const sx = Math.round(r.x * c.width);
  const sy = Math.round(r.y * c.height);
  const sw = Math.max(10, Math.round(r.w * c.width));
  const sh = Math.max(10, Math.round(r.h * c.height));
  const out = document.createElement('canvas');
  out.width = sw; out.height = sh;
  out.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

// 쪽수만 찾기: 고른 범위 바로 아래·위 띠와 사진 아래쪽을 따로 읽어 숫자를 찾음
// (본문만 잘라내도 쪽수는 살리고, 본문 속 숫자는 무시)
export async function findPageNumber(full, maxPage = 0, crop = { x: 0, y: 0, w: 1, h: 1 }) {
  const clamp = (r) => {
    const x = Math.max(0, r.x); const y = Math.max(0, r.y);
    const w = Math.min(1, r.x + r.w) - x; const h = Math.min(1, r.y + r.h) - y;
    return w > 0.05 && h > 0.03 ? { x, y, w, h } : null;
  };
  const bands = [
    { r: clamp({ x: crop.x - 0.06, y: crop.y + crop.h - 0.02, w: crop.w + 0.12, h: 0.16 }), bonus: 25 },
    { r: clamp({ x: crop.x - 0.06, y: crop.y - 0.12, w: crop.w + 0.12, h: 0.14 }), bonus: 10 },
    { r: clamp({ x: 0, y: 0.75, w: 1, h: 0.25 }), bonus: 0 },
  ].filter((b) => b.r);
  // 작은 숫자를 잘 읽도록: 키우고, 흑백으로 또렷하게, 흰 여백 추가
  const prep = (c, scale) => {
    const pad = 30;
    const u = document.createElement('canvas');
    u.width = Math.round(c.width * scale) + pad * 2;
    u.height = Math.round(c.height * scale) + pad * 2;
    const x = u.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, u.width, u.height);
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, pad, pad, u.width - pad * 2, u.height - pad * 2);
    const d = x.getImageData(0, 0, u.width, u.height);
    const a = d.data;
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) { const g = 0.3 * a[i] + 0.59 * a[i + 1] + 0.11 * a[i + 2]; a[i] = g; sum += g; }
    const cut = (sum / (a.length / 4)) * 0.75;
    for (let i = 0; i < a.length; i += 4) { const v = a[i] < cut ? 0 : 255; a[i] = a[i + 1] = a[i + 2] = v; }
    x.putImageData(d, 0, 0);
    return u;
  };
  const votes = new Map();
  for (const b of bands) {
    const c = cropCanvas(full, b.r);
    const base = Math.min(3, Math.max(1, 900 / Math.max(c.width, 1)));
    for (const scale of [base * 2, base * 3].map((v) => Math.min(v, 3.5))) {
      const r = await recognize(prep(c, scale));
      for (const w of r.words) {
        const n = w.text.replace(/[^0-9]/g, '');
        if (!n || n.length > 4 || n.length < w.text.length - 1) continue;
        const v = +n;
        if (!v || (maxPage && v > maxPage)) continue;
        if (w.lineHangul > 4) continue; // 본문 줄 속 숫자(예: 2년)는 제외. 쪽수 줄은 '1부 113'처럼 글자가 적음
        if (w.conf < 50 || (n.length === 1 && w.conf < 85)) continue; // 한 자리 숫자는 잡음이 많아서 아주 확실할 때만
        votes.set(v, (votes.get(v) || 0) + w.conf + b.bonus + n.length * 10);
      }
    }
    const top = Math.max(0, ...votes.values());
    if (top >= 200) break;
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 130 ? best[0] : null; // 확실하지 않으면 비워두고 직접 적게
}

// 잘라낸 부분이 인식하기 좋은 크기가 되도록 (너무 크면 줄이고, 원본 해상도는 최대한 유지)
export function fitForOcr(c, maxSide = 2200) {
  const k = Math.min(1, maxSide / Math.max(c.width, c.height));
  if (k === 1) return c;
  const o = document.createElement('canvas');
  o.width = Math.round(c.width * k); o.height = Math.round(c.height * k);
  o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
  return o;
}
