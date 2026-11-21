// ISBN 바코드 스캔: 브라우저 기본 BarcodeDetector가 있으면 사용, 없으면(iOS 사파리 등) zxing
import { isISBN13 } from './bookapi.js';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';

export async function startScan(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

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

  let native = false;
  if ('BarcodeDetector' in window) {
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats();
      native = fmts.includes('ean_13');
    } catch {}
  }

  if (native) {
    const det = new window.BarcodeDetector({ formats: ['ean_13'] });
    const loop = async () => {
      if (stopped) return;
      try {
        const codes = await det.detect(video);
        for (const c of codes) if (found(c.rawValue)) return;
      } catch {}
      setTimeout(loop, 180);
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
