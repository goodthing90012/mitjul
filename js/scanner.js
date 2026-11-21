// ISBN 바코드 스캔: 브라우저 기본 BarcodeDetector가 있으면 사용, 없으면(iOS 사파리 등) zxing
// 초점 문제 대응: 고해상도 요청 + 연속 자동초점 + 줌(멀리서 찍기) + 탭해서 초점 + 사진으로 인식
import { isISBN13 } from './bookapi.js';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';
const ZXING_LIB_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/+esm';

// EAN-13만, 더 꼼꼼하게(TRY_HARDER) 찾는 zxing 리더
let zxReaderP = null;
function zxReader() {
  if (!zxReaderP) {
    zxReaderP = Promise.all([import(ZXING_URL), import(ZXING_LIB_URL)]).then(([br, lib]) => {
      const hints = new Map([
        [lib.DecodeHintType.POSSIBLE_FORMATS, [lib.BarcodeFormat.EAN_13]],
        [lib.DecodeHintType.TRY_HARDER, true],
      ]);
      return new br.BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
    }).catch((e) => { zxReaderP = null; throw e; });
  }
  return zxReaderP;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats();
    if (fmts.includes('ean_13')) return new window.BarcodeDetector({ formats: ['ean_13'] });
  } catch {}
  return null;
}

// 반환값: stop 함수. 추가 기능은 stop.zoom / stop.setZoom / stop.torch / stop.toggleTorch / stop.focus 로 사용
export async function startScan(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: 'continuous' }],
    },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  const track = stream.getVideoTracks()[0];
  const caps = (track.getCapabilities && track.getCapabilities()) || {};

  let stopped = false;
  let zxControls = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { zxControls?.stop(); } catch {}
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const found = (text) => {
    if (stopped || !isISBN13(text)) return false;
    stop();
    onCode(text);
    return true;
  };

  const apply = (c) => track.applyConstraints({ advanced: [c] }).catch(() => {});

  // 연속 자동초점
  if (caps.focusMode?.includes('continuous')) apply({ focusMode: 'continuous' });

  // 줌: 가까이 대면 초점이 안 잡히므로 2배 정도 당겨서 15~20cm 거리에서 찍게
  if (caps.zoom) {
    const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2));
    stop.zoom = { min: caps.zoom.min, max: Math.min(caps.zoom.max, 5), step: caps.zoom.step || 0.1, value: z };
    stop.setZoom = (v) => apply({ zoom: v });
    stop.setZoom(z);
  }
  // 손전등
  if (caps.torch) {
    let on = false;
    stop.torch = true;
    stop.toggleTorch = () => { on = !on; apply({ torch: on }); return on; };
  }
  // 탭해서 다시 초점
  stop.focus = async () => {
    if (caps.focusMode?.includes('single-shot')) {
      await apply({ focusMode: 'single-shot' });
      setTimeout(() => { if (!stopped && caps.focusMode.includes('continuous')) apply({ focusMode: 'continuous' }); }, 1200);
    } else if (caps.focusMode?.includes('continuous')) {
      await apply({ focusMode: 'manual' });
      await apply({ focusMode: 'continuous' });
    }
  };

  const det = await nativeDetector();
  if (det) {
    const loop = async () => {
      if (stopped) return;
      try {
        const codes = await det.detect(video);
        for (const c of codes) if (found(c.rawValue)) return;
      } catch {}
      setTimeout(loop, 150);
    };
    loop();
  } else {
    const reader = await zxReader();
    if (stopped) return stop;
    zxControls = await reader.decodeFromVideoElement(video, (res) => {
      if (res) found(res.getText());
    });
    if (stopped) { try { zxControls.stop(); } catch {} }
  }
  return stop;
}

// 사진 파일에서 바코드 읽기 (폰 기본 카메라 앱의 자동초점을 쓰는 방법)
// 여러 크기, 가운데 잘라내기, 90도 회전까지 시도. 기본 인식기가 실패하면 zxing으로 한 번 더
export async function decodeImageFile(file) {
  const bmp = await createImageBitmap(file);
  const det = await nativeDetector();
  let zx = null;
  try { zx = await zxReader(); } catch {}

  const variants = [];
  const make = (maxSide, crop = null, rotate = false) => {
    const sx = crop ? bmp.width * crop[0] : 0;
    const sy = crop ? bmp.height * crop[1] : 0;
    const sw = crop ? bmp.width * crop[2] : bmp.width;
    const sh = crop ? bmp.height * crop[3] : bmp.height;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const c = document.createElement('canvas');
    c.width = rotate ? h : w;
    c.height = rotate ? w : h;
    const x = c.getContext('2d');
    if (rotate) { x.translate(h, 0); x.rotate(Math.PI / 2); }
    x.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    return c;
  };
  variants.push(() => make(1600));
  variants.push(() => make(2400));
  variants.push(() => make(1600, [0.1, 0.25, 0.8, 0.5])); // 가운데 띠
  variants.push(() => make(1000));
  variants.push(() => make(1600, null, true)); // 세로로 찍힌 바코드

  for (const v of variants) {
    const c = v();
    if (det) {
      try {
        const hit = (await det.detect(c)).find((x) => isISBN13(x.rawValue));
        if (hit) return hit.rawValue;
      } catch {}
    }
    if (zx) {
      try {
        const res = zx.decodeFromCanvas(c);
        if (res && isISBN13(res.getText())) return res.getText();
      } catch {}
    }
  }
  return null;
}
