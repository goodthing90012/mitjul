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
export function fileToCanvas(file, maxSide = 1800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없어요')); };
    img.src = url;
  });
}

export async function recognize(canvas, onProgress) {
  progressCb = onProgress;
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  progressCb = null;
  const words = (data.words || [])
    .filter((w) => w.text && w.text.trim())
    .map((w, i) => ({ i, text: w.text.trim(), bbox: w.bbox, conf: w.confidence }));
  return { words, width: canvas.width, height: canvas.height, page: guessPage(words, canvas.height) };
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

// 선택된 단어들을 문장으로 합치기 (한국어는 단어 사이 공백 유지)
export function joinWords(words) {
  return words.map((w) => w.text).join(' ').replace(/\s+([,.!?…”’)\]])/g, '$1').replace(/([“‘(\[])\s+/g, '$1');
}
