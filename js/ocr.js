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
    .map((w, i) => ({ i, text: w.text.trim(), bbox: w.bbox, conf: w.confidence }));
  const good = words.filter((w) => w.conf >= 60).length;
  return { words, width: canvas.width, height: canvas.height, page: guessPage(words, canvas.height), conf: data.confidence || 0, score: (data.confidence || 0) * Math.sqrt(good + 1) };
}

// 위·아래 가장자리에 있는 숫자 단어를 쪽수로 추정
export function guessPage(words, H) {
  const cands = words
    .map((w) => ({ w, n: w.text.replace(/[^0-9]/g, '') }))
    .filter(({ w, n }) => n.length >= 1 && n.length <= 4 && n.length >= w.text.length - 1 &&
      (w.bbox.y0 > H * 0.84 || w.bbox.y1 < H * 0.14))
    .map(({ w, n }) => ({ n: +n, bottom: w.bbox.y0 > H * 0.84, conf: w.conf }))
    .filter((c) => c.n > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => (b.bottom - a.bottom) || (b.conf - a.conf));
  return cands[0].n;
}

// 선택된 단어들을 문장으로 합치기
// 한글은 인식기가 글자 단위로 쪼개는 경우가 많아서, 실제 간격이 좁으면 붙이고 넓으면 띄움
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
      if (!sameLine || gap > h * 0.28) out += ' ';
    }
    out += w.text;
    prev = w;
  }
  return out.replace(/\s+([,.!?…”’)\]])/g, '$1').replace(/([“‘(\[])\s+/g, '$1').replace(/\s+/g, ' ').trim();
}

// 방향 자동 맞춤: 인식 품질이 낮으면 90°/270°로 돌려서 더 잘 읽히는 쪽을 고름
export async function recognizeAuto(canvas, onProgress, onStage) {
  let best = { canvas, r: await recognize(canvas, onProgress) };
  if (best.r.conf >= 65 && best.r.words.length >= 4) return best;
  for (const deg of [90, 270]) {
    onStage?.(deg);
    const c = rotateCanvas(canvas, deg);
    const r = await recognize(c, onProgress);
    if (r.score > best.r.score * 1.15) best = { canvas: c, r };
    if (best.r.conf >= 70) break;
  }
  return best;
}
