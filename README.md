# 밑줄서재

책에 직접 쓰지 않고 긋는 밑줄. 글귀와 쪽수, 인물 관계도를 3D 책장에 정리하는 PWA예요.

## 배포 (GitHub Pages)
1. 이 폴더 내용을 레포(예: `mitjul`) 루트에 올리기
2. Settings → Pages → Branch `main` / root
3. `https://<아이디>.github.io/mitjul/` 접속 → 홈 화면에 추가

카메라(바코드·사진)는 https에서만 동작해요. 로컬에서 보려면 `python3 -m http.server`로 띄운 뒤 localhost로 접속하세요.

## 업데이트할 때
- `sw.js`의 `VERSION`을 올려주세요 (`mitjul-v1` → `mitjul-v2`).

## 구조
- `js/shelf3d.js` 3D 책장, 꺼내서 펼치기 (three.js)
- `js/bookapi.js` ISBN 조회: 구글 북스, 키가 있으면 카카오도 함께 조회
- `js/scanner.js` 바코드: BarcodeDetector가 있으면 사용, 없으면 zxing
- `js/ocr.js` 사진 글자 인식 (Tesseract.js, 기기 안에서 처리)
- `js/graph.js` 인물 관계도 (쪽수 슬라이더로 스포일러 방지)
- `js/db.js` IndexedDB (기기에만 저장 → 설정에서 백업 내보내기)
