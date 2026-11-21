// ISBN 바코드 스캔: 브라우저 기본 BarcodeDetector가 있으면 사용, 없으면(iOS 사파리 등) zxing
// 초점 문제 대응: 고해상도 요청 + 연속 자동초점 + 줌(멀리서 찍기) + 탭해서 초점 + 사진으로 인식
import { isISBN13 } from './bookapi.js';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';

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
    const { BrowserMultiFormatReader } = await import(ZXING_URL);
    if (stopped) return stop;
    const reader = new BrowserMultiFormatReader();
    zxControls = await reader.decodeFromVideoElement(video, (res) => {
      if (res) found(res.getText());
    });
    if (stopped) { try { zxControls.stop(); } catch {} }
  }
  return stop;
}

// 사진 파일에서 바코드 읽기 (폰 기본 카메라 앱의 자동초점을 쓰는 방법)
export async function decodeImageFile(file) {
  const bmp = await createImageBitmap(file);
  // 너무 큰 사진은 줄이고, 작게도 한 번 더 시도
  const sizes = [1600, 1000];
  const det = await nativeDetector();
  let zx = null;
  for (const maxSide of sizes) {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (det) {
      try {
        const codes = await det.detect(c);
        const hit = codes.find((x) => isISBN13(x.rawValue));
        if (hit) return hit.rawValue;
      } catch {}
    } else {
      if (!zx) {
        const { BrowserMultiFormatReader } = await import(ZXING_URL);
        zx = new BrowserMultiFormatReader();
      }
      try {
        const res = zx.decodeFromCanvas(c);
        if (res && isISBN13(res.getText())) return res.getText();
      } catch {}
    }
  }
  return null;
}
