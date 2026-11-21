// 책 정보 조회: 구글 북스(키 없음) → 카카오(설정에 키가 있을 때) → 직접 입력
export function getKakaoKey() {
  try { return localStorage.getItem('kakaoKey') || ''; } catch { return ''; }
}

export function cleanISBN(raw) {
  return String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

export function isISBN13(code) {
  const c = cleanISBN(code);
  if (!/^97[89]\d{10}$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+c[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === +c[12];
}

function fixGoogleCover(links) {
  if (!links) return '';
  const u = links.thumbnail || links.smallThumbnail || '';
  return u.replace(/^http:/, 'https:').replace('&edge=curl', '');
}

function fromGoogle(v) {
  return {
    title: v.title + (v.subtitle ? ': ' + v.subtitle : ''),
    authors: v.authors || [],
    pages: v.pageCount || 0,
    cover: fixGoogleCover(v.imageLinks),
    publisher: v.publisher || '',
    isbn: (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13')?.identifier || '',
  };
}

function fromKakao(d) {
  const isbn13 = (d.isbn || '').split(' ').find((x) => x.length === 13) || '';
  return {
    title: d.title || '',
    authors: d.authors || [],
    pages: 0, // 카카오 응답에는 쪽수가 없음
    cover: d.thumbnail || '',
    publisher: d.publisher || '',
    isbn: isbn13,
  };
}

async function google(q) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10`);
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json();
  return (j.items || []).map((it) => fromGoogle(it.volumeInfo || {}));
}

async function kakao(params) {
  const key = getKakaoKey();
  if (!key) return [];
  const qs = new URLSearchParams({ size: '10', ...params });
  const r = await fetch(`https://dapi.kakao.com/v3/search/book?${qs}`, {
    headers: { Authorization: 'KakaoAK ' + key },
  });
  if (!r.ok) throw new Error('kakao ' + r.status);
  const j = await r.json();
  return (j.documents || []).map(fromKakao);
}

// 오픈 라이브러리 (키 없음, 해외 책 위주)
async function openLibrary(isbn) {
  const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  if (!r.ok) throw new Error('ol ' + r.status);
  const d = (await r.json())['ISBN:' + isbn];
  if (!d) return [];
  return [{
    title: d.title + (d.subtitle ? ': ' + d.subtitle : ''),
    authors: (d.authors || []).map((a) => a.name),
    pages: d.number_of_pages || 0,
    cover: d.cover?.medium || '',
    publisher: d.publishers?.[0]?.name || '',
    isbn,
  }];
}

const settle = (p) => p.then((v) => v, () => []);

// ISBN 하나로 조회. 한국 책은 카카오 정보(제목·표지)를 우선하고 쪽수는 구글에서 채움
export async function lookupISBN(raw) {
  const isbn = cleanISBN(raw);
  const [g, k, o] = await Promise.all([
    settle(google('isbn:' + isbn)), settle(kakao({ target: 'isbn', query: isbn })), settle(openLibrary(isbn)),
  ]);
  const gi = g[0] || o[0];
  const ki = k[0];
  if (!gi && !ki) return null;
  const base = ki || gi;
  return {
    title: base.title || gi?.title || '',
    authors: base.authors?.length ? base.authors : (gi?.authors || []),
    pages: gi?.pages || o[0]?.pages || 0,
    cover: ki?.cover || gi?.cover || '',
    publisher: base.publisher || gi?.publisher || '',
    isbn,
  };
}

// 제목 검색: 카카오 결과를 앞에, 구글 결과를 뒤에
export async function searchTitle(q) {
  const [k, g] = await Promise.all([settle(kakao({ target: 'title', query: q })), settle(google('intitle:' + q))]);
  const seen = new Set();
  const out = [];
  for (const b of [...k, ...g]) {
    const key = b.isbn || b.title + '|' + b.authors.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out.slice(0, 15);
}
