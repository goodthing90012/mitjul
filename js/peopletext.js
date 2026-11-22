// 인물 관계를 한 줄 문장으로 적으면 알아듣기 (규칙 기반, 인터넷 필요 없음)
// 알아듣는 모양
//   엘리자베스와 제인은 자매          → 관계
//   다아시의 친구는 빙리              → 관계
//   제인은 엘리자베스의 언니          → 관계
//   리지는 엘리자베스의 애칭          → 다른 이름
//   리지 = 엘리자베스 (애칭)          → 다른 이름
//   엘리자베스, 제인, 리디아는 베넷가 → 가문
//   어느 문장이든 p.120 / 120쪽 을 붙이면 그 쪽에서 드러난 것으로

export const ALIAS_WORDS = ['애칭', '별명', '호칭', '본명', '결혼 후 이름', '결혼후 이름', '직함', '가명', '세례명'];

const KIND_WORDS = [
  ['love', /부부|남편|아내|연인|애인|약혼|사랑|결혼|짝사랑|첫사랑/],
  ['enemy', /원수|적대|라이벌|갈등|악연|앙숙|복수|배신/],
  ['friend', /친구|동료|벗|동창|동업|하인|하녀|집사|스승|제자|후원|비서|이웃|파트너/],
  ['family', /가족|자매|형제|남매|언니|누나|오빠|형|동생|아버지|어머니|아빠|엄마|부모|자식|아들|딸|삼촌|이모|고모|숙모|외삼촌|조카|사촌|할머니|할아버지|손자|손녀|친척|장인|장모|시어머니|시아버지|며느리|사위|처제|처남|매형|올케|시누이/],
];
export function guessKind(label) {
  for (const [k, re] of KIND_WORDS) if (re.test(label || '')) return k;
  return 'etc';
}

const PAGE_RE = /(?:^|\s|\()(?:p\.?\s*(\d{1,4})|(\d{1,4})\s*(?:쪽|p\b|페이지))\)?/i;
const TAIL_RE = /\s*(?:이다|입니다|이에요|예요|이야|야|임|이고|다)?\s*[.!。]*$/;
const clean = (x) => String(x || '').trim().replace(/^["'“‘(]+|["'”’)]+$/g, '').trim();
const cleanLabel = (x) => clean(String(x || '').replace(TAIL_RE, ''));

function splitNames(x) {
  return String(x).split(/\s*(?:,|，|·|그리고|(?<=\S)(?:와|과|랑|이랑|하고)\s)\s*/).map(clean).filter(Boolean);
}

export function parseLine(raw) {
  let line = String(raw || '').trim().replace(/^[-*•·]\s*/, '');
  if (!line) return null;
  let page = 0;
  const pm = line.match(PAGE_RE);
  if (pm) {
    page = +(pm[1] || pm[2]);
    line = (line.slice(0, pm.index) + ' ' + line.slice(pm.index + pm[0].length)).replace(/\s+/g, ' ').trim();
  }
  line = line.replace(/[.!。]+$/, '').trim();
  let m;
  const aliasAlt = ALIAS_WORDS.map((w) => w.replace(/ /g, '\\s*')).join('|');

  // 리지 = 엘리자베스 (애칭)
  if ((m = line.match(new RegExp(`^(.+?)\\s*=\\s*(.+?)(?:\\s*\\(?\\s*(${aliasAlt})\\s*\\)?)?$`)))) {
    return { type: 'alias', alias: clean(m[1]), name: clean(m[2]), kind: (m[3] || '별명').replace(/\s+/g, ' '), page, raw };
  }
  // 리지는 엘리자베스의 애칭
  if ((m = line.match(new RegExp(`^(.+?)(?:은|는|이|가)\\s+(.+?)의\\s*(${aliasAlt})${TAIL_RE.source}`)))) {
    return { type: 'alias', alias: clean(m[1]), name: clean(m[2]), kind: m[3].replace(/\s+/g, ' '), page, raw };
  }
  // 엘리자베스, 제인, 리디아는 베넷가 / 베넷 집안
  if ((m = line.match(/^(.+?)(?:은|는|이|가)\s+(\S+(?:가|가문|집안|家))(?:\s*(?:사람|사람들|출신))?(?:이다|입니다|예요|이에요|야|임|다)?$/))) {
    const names = splitNames(m[1]);
    if (names.length) return { type: 'family', names, family: clean(m[2]).replace(/\s*(가문|집안)$/, '가').replace(/家$/, '가'), page, raw };
  }
  // 제인은 엘리자베스의 언니
  if ((m = line.match(/^(.+?)(?:은|는|이|가)\s+(.+?)의\s+(.+)$/))) {
    return { type: 'rel', a: clean(m[1]), b: clean(m[2]), label: cleanLabel(m[3]), page, raw };
  }
  // 다아시의 친구는 빙리
  if ((m = line.match(/^(.+?)의\s+(.+?)(?:은|는|이|가)\s+(.+)$/))) {
    return { type: 'rel', a: clean(m[1]), b: cleanLabel(m[3]), label: clean(m[2]), page, raw };
  }
  // 엘리자베스와 제인은 자매 (사이)
  if ((m = line.match(/^(.+?)(?:와|과|랑|이랑|하고)\s+(.+?)(?:은|는|이|가)\s+(.+)$/))) {
    return { type: 'rel', a: clean(m[1]), b: clean(m[2]), label: cleanLabel(m[3].replace(/\s*(?:사이|관계)(?=\S*$)/, '')), page, raw };
  }
  return { type: 'unknown', raw };
}

export function parseText(text) {
  return String(text || '').split(/\n|;/).map(parseLine).filter(Boolean);
}
