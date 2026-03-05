/**
 * utils.js — 순수 유틸리티 함수
 *
 * 시간 파싱·변환, 슬롯 계산, 난수 생성, 배열 조작.
 * 부작용 없는 순수 함수로만 구성됩니다.
 *
 * 의존성: 없음
 * 공개 API: 아래 export 목록 참조
 */

/** "HH:MM" 문자열 → 분(number) */
export function parseTimeToMin(h) {
  if (!h || typeof h !== 'string') return 0;
  const [a, b] = h.split(':').map(Number);
  return (a || 0) * 60 + (b || 0);
}

/** 분(number) → "HH:MM" 문자열 */
export function minToTime(m) {
  const h = Math.floor(m / 60);
  const n = m % 60;
  return `${String(h).padStart(2, '0')}:${String(n).padStart(2, '0')}`;
}

/** [startMin, endMin) 범위를 step 간격으로 채운 배열 */
export function buildSlots(s, e, step = 15) {
  const a = [];
  for (let t = s; t <= e; t += step) a.push(t);
  return a;
}

/** 슬롯 배열에서 특정 시각(분)의 인덱스 반환 */
export function slotIndexOf(sl, t) {
  return sl.indexOf(t);
}

/** 분 → 슬롯 수 (step 기준, 최소 1) */
export function minsToSlots(m, step = 15) {
  return Math.max(1, Math.round(m / step));
}

/** 값을 [lo, hi] 범위로 고정 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 시드 기반 결정적 난수 생성기 (Mulberry32 변형)
 * @param {number} seed
 * @returns {() => number} 0~1 사이 난수 반환 함수
 */
export function seededRng(seed = 112) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 배열 인플레이스 셔플 */
export function shuffleInPlace(a, rng) {
  const r = rng || Math.random.bind(Math);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** schedule[id][s..e) 범위를 값 v로 채움 */
export function markRange(sc, id, s, e, v) {
  for (let i = s; i < e; i++) sc[id][i] = v;
}

/**
 * 각 직원의 활성 슬롯 마스크 계산
 * @returns {{ [empId]: boolean[] }}
 */
export function computeActiveMask(emps, sl) {
  const a = {};
  for (const e of emps) {
    a[e.id] = sl.map(t => t >= e.startMin && t < e.endMin);
  }
  return a;
}

/**
 * 스케줄 행에서 연속 블록 목록 추출
 * @returns {{ start, end, st }[]}
 */
export function buildWorkBlocks(row, actRow) {
  const b = [];
  let i = 0;
  while (i < row.length) {
    if (actRow[i] && row[i] && row[i] !== 'OFF') {
      const s = i;
      const st = row[i];
      while (i < row.length && actRow[i] && row[i] === st) i++;
      b.push({ start: s, end: i, st });
    } else {
      i++;
    }
  }
  return b;
}

/**
 * DP로 길이 L을 블록 크기 조합으로 분해
 * (minS ≤ 블록 ≤ maxS 선호, anyS 허용)
 * @returns {number[]} 블록 크기 배열
 */
export function buildBlockPattern(L, minS, maxS, anyS) {
  const pref = [];
  for (let s = minS; s <= maxS; s++) pref.push(s);
  if (!pref.includes(anyS)) pref.push(anyS);
  if (!pref.includes(2))    pref.push(2);
  if (!pref.includes(3))    pref.push(3);
  const cand = [...new Set(pref)].filter(x => x >= 2 && x <= 12).sort((a, b) => b - a);

  const INF = 1e12;
  const dp = Array(L + 1).fill(null).map(() => ({ cost: INF, prev: -1, step: -1 }));
  dp[0] = { cost: 0, prev: -1, step: -1 };

  for (let i = 0; i <= L; i++) {
    if (dp[i].cost >= INF) continue;
    for (const step of cand) {
      const j = i + step;
      if (j > L) continue;
      let p = 1;
      if (step === 2)                       p += 80;
      if (step < minS || step > maxS)       p += 15;
      if (dp[i].cost + p < dp[j].cost) dp[j] = { cost: dp[i].cost + p, prev: i, step };
    }
  }

  // fallback: greedy
  if (dp[L].cost >= INF) {
    const out = [];
    let rem = L;
    while (rem >= maxS) { out.push(maxS); rem -= maxS; }
    if (rem >= 2)             out.push(rem);
    else if (rem === 1 && out.length) out[out.length - 1] += rem; // 1슬롯 잔여를 마지막 블록에 병합
    else if (rem === 1)       out.push(1); // 단독 1슬롯 (최소 블록 없는 경우 안전 처리)
    return out;
  }

  const res = [];
  let pos = L;
  while (pos > 0) { res.unshift(dp[pos].step); pos = dp[pos].prev; }
  return res;
}
