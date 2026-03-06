/**
 * scheduler/events.js — 고정 이벤트 배치
 *
 * applyMeetings           — 안전회의 (마감조 + 중간조 2명)
 * applyOpenMeals          — 오픈조 식사
 * applyMidMeals           — 중간조 식사 (11:45전 출근 → +3시간 고정 / 11:45·12:00·12:30·13:00 → 16:30 고정)
 *                           Fix23: FIXED 식사 동시 배정 분산 (두 번째 직원 → 16:15 우선)
 * applyCloseMeals         — 마감조 식사 (17:00 / 17:30)
 * applyOpenPrep           — 오픈준비 (10:30 이전)
 * applyEarlyCoreCoverage  — 오픈조 초기 코어 커버리지
 * applyRestBreaks         — 휴식 배치 (1·2·3차)
 *                           Fix19: 8h 2차 휴식 피크 회피 (13:30~14:30 / 18:30~19:00)
 *                           Fix21: MID 1차 휴식도 피크 회피 적용
 * applyPostMtgFixedSlots  — 마감조 MTG 직후 2F카트 → 휴식 고정
 * spreadSimultaneousRests — 동슬롯 REST 분산 (Fix18-A/Fix20)
 *                           Fix22: 탐색 범위 ±2 → ±6슬롯 확대
 *
 * 규칙:
 *   - 식사는 근무 시간 외 → endMin = startMin + hours*60 + mealDurMin (전 직군)
 *   - 마감조 1차 휴식 = MTG 직후 고정 REST (applyPostMtgFixedSlots)
 *   - 식사·휴식은 코어 배정 전 최우선 배치
 *
 * 의존성: constants.js, utils.js, scheduler/core.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { parseTimeToMin, minsToSlots, slotIndexOf, markRange, shuffleInPlace, clamp } from '../utils.js';
import { isProtected, stationCountsAt, dynMaxAt } from './core.js';

// ── 안전회의 ────────────────────────────────────────────────────

export function applyMeetings(ctx) {
  const { schedule, employees, active, slotsMin, rng, mtg1Min, mtg2Min, meetingDurMin } = ctx;
  const dur = minsToSlots(meetingDurMin, 15);
  const i1  = slotIndexOf(slotsMin, mtg1Min);
  const i2  = slotIndexOf(slotsMin, mtg2Min);
  if (i1 < 0 || i2 < 0) return;

  // 마감조 전원 + 중간조 최대 2명 → 15:00 회의
  const close        = employees.filter(e => e.group === 'CLOSE');
  const midElig      = employees.filter(e => e.group === 'MID' && active[e.id][i1]);
  shuffleInPlace(midElig, rng);
  const midPicked    = midElig.slice(0, Math.min(2, midElig.length));
  const midPickedIds = new Set(midPicked.map(e => e.id));

  for (const e of [...close, ...midPicked]) {
    if (!active[e.id][i1]) continue;
    markRange(schedule, e.id, i1, Math.min(i1 + dur, slotsMin.length), ST.MTG);
  }
  // 나머지 직원 → 15:15 회의
  for (const e of employees) {
    if (!active[e.id][i2]) continue;
    if (e.group === 'CLOSE' || midPickedIds.has(e.id)) continue;
    markRange(schedule, e.id, i2, Math.min(i2 + dur, slotsMin.length), ST.MTG);
  }
}

// ── 오픈조 식사 ─────────────────────────────────────────────────

export function applyOpenMeals(ctx) {
  const { schedule, employees, active, slotsMin, rng, mealDurMin, openMeal1130, openMeal1230 } = ctx;
  const dur      = minsToSlots(mealDurMin, 15);
  const openEmps = employees.filter(e => e.group === 'OPEN');
  if (!openEmps.length) return;

  const i1130 = slotIndexOf(slotsMin, parseTimeToMin('11:30'));
  const i1230 = slotIndexOf(slotsMin, parseTimeToMin('12:30'));

  const pickedSet = new Set();
  const pick = (idx, cnt) => {
    if (idx < 0 || cnt <= 0) return [];
    const elig = openEmps.filter(e => active[e.id][idx] && !pickedSet.has(e.id));
    shuffleInPlace(elig, rng);
    return elig.slice(0, Math.min(cnt, elig.length));
  };

  const p1 = pick(i1130, openMeal1130);
  p1.forEach(e => pickedSet.add(e.id));
  const p2 = pick(i1230, openMeal1230);

  for (const e of p1) markRange(schedule, e.id, i1130, Math.min(i1130 + dur, slotsMin.length), ST.MEAL);
  for (const e of p2) markRange(schedule, e.id, i1230, Math.min(i1230 + dur, slotsMin.length), ST.MEAL);
}

// ── 중간조 식사 ─────────────────────────────────────────────────
// 규칙:
//   - 11:45 이전 출근자 → 출근 후 정확히 +180분(3시간) 슬롯에 식사
//   - 11:45 / 12:00 / 12:30 / 13:00 출근자 → 16:30 고정 식사
//   - 그 외(13:30 이후 등) → 출근 후 +180분 적용

export function applyMidMeals(ctx) {
  const { schedule, employees, active, slotsMin, mealDurMin } = ctx;
  const dur     = minsToSlots(mealDurMin, 15);
  const midEmps = employees.filter(e => e.group === 'MID');
  if (!midEmps.length) return;

  // 16:30 고정 식사 대상 출근 시각 (분 단위)
  const FIXED_MEAL_STARTS = new Set([
    parseTimeToMin('11:45'),
    parseTimeToMin('12:00'),
    parseTimeToMin('12:30'),
    parseTimeToMin('13:00'),
  ]);
  const FIXED_MEAL_TIME = parseTimeToMin('16:30');

  // 16:30 이후 가장 가까운 유효 슬롯 인덱스 (findIndex로 정확한 매칭 없어도 안전하게 처리)
  const fixedMealIdx = slotsMin.findIndex(t => t >= FIXED_MEAL_TIME);

  // 슬롯이 보호되지 않고 활성화된 상태인지 확인 후 dur 슬롯 연속 배정 가능 여부
  const canPlaceMeal = (row, actRow, start) => {
    for (let j = start; j < start + dur; j++) {
      if (j >= slotsMin.length) return false;
      if (!actRow[j]) return false;
      const st = row[j];
      if (st !== '' && st !== ST.OFF) return false; // 이미 배정된 슬롯
    }
    return true;
  };

  // 목표 슬롯 근방에서 배정 가능한 슬롯 탐색 (앞뒤 ±4슬롯 = ±1시간 범위)
  const findNearestSlot = (row, actRow, target, eS, eE) => {
    for (let delta = 0; delta <= 4; delta++) {
      for (const d of (delta === 0 ? [0] : [delta, -delta])) {
        const idx = target + d;
        if (idx < eS || idx + dur > eE) continue;
        if (canPlaceMeal(row, actRow, idx)) return idx;
      }
    }
    return -1;
  };

  // Fix23: FIXED 식사 대상자 중 16:30 동시 식사 분산
  // 같은 슬롯에 2명 이상이 FIXED 식사를 배정받으면, 두 번째부터 ±1슬롯 우선 시도
  const fixedMealEmps = midEmps.filter(e => FIXED_MEAL_STARTS.has(e.startMin));
  const fixedMealCount = {};  // fixedMealIdx → 배정된 인원 수
  fixedMealEmps.forEach(e => {
    let eS = -1, eE = -1;
    for (let i = 0; i < slotsMin.length; i++) {
      if (active[e.id][i]) { if (eS < 0) eS = i; eE = i + 1; }
    }
    if (eS < 0) return;
    const row    = schedule[e.id];
    const actRow = active[e.id];
    let mealStart = -1;
    if (fixedMealIdx >= 0) {
      // 이미 이 슬롯에 식사가 배정된 인원 수에 따라 후보 순서 결정
      const count = fixedMealCount[fixedMealIdx] || 0;
      // 첫 번째: 16:30, 두 번째: 16:15 우선 → 16:45, 세 번째 이상: 더 먼 슬롯
      const candidates = count === 0
        ? [0, -1, 1, -2, 2]      // 첫 번째: 16:30 우선
        : count === 1
          ? [-1, 1, -2, 2, 0]    // 두 번째: 16:15(앞) 우선 → 16:45 → 16:30(최후)
          : [-2, 2, -1, 1, 0];   // 세 번째: 16:00(앞) 우선
      for (const delta of candidates) {
        const idx = fixedMealIdx + delta;
        if (idx < eS || idx + dur > eE) continue;
        if (canPlaceMeal(row, actRow, idx)) { mealStart = idx; break; }
      }
    }
    if (mealStart < 0 || mealStart + dur > slotsMin.length) return;
    if (!canPlaceMeal(row, actRow, mealStart)) return;
    markRange(schedule, e.id, mealStart, mealStart + dur, ST.MEAL);
    // Fix-v25-1: fixedMealIdx 키로 통일 — mealStart 키를 사용하면 분산 우선순위 계산 시
    // 항상 count=0으로 읽혀 3번째 이상 직원의 슬롯 선택 순서가 의도와 다르게 작동하던 버그 수정
    fixedMealCount[fixedMealIdx] = (fixedMealCount[fixedMealIdx] || 0) + 1;
  });

  // FIXED 아닌 나머지 MID 직원 처리 (+3시간 규칙 적용)
  for (const e of midEmps) {
    if (FIXED_MEAL_STARTS.has(e.startMin)) continue;  // Fix23: FIXED는 위에서 처리됨

    const row    = schedule[e.id];
    const actRow = active[e.id];

    let eS = -1, eE = -1;
    for (let i = 0; i < slotsMin.length; i++) {
      if (actRow[i]) { if (eS < 0) eS = i; eE = i + 1; }
    }
    if (eS < 0) continue;

    let mealStart = -1;

    // +3시간 규칙 (FIXED_MEAL_STARTS 아닌 직원: 11:45 미만 / 13:30+ 등)
    const targetMin = e.startMin + 180;
    const targetIdx = slotsMin.findIndex(t => t >= targetMin);
    if (targetIdx >= 0) {
      mealStart = findNearestSlot(row, actRow, targetIdx, eS, eE);
    }
    // fallback: 근무 전체 범위에서 탐색
    if (mealStart < 0) {
      for (let i = eS; i + dur <= eE; i++) {
        if (canPlaceMeal(row, actRow, i)) { mealStart = i; break; }
      }
    }

    if (mealStart < 0 || mealStart + dur > slotsMin.length) continue;
    // Bug Fix 3: markRange 전 canPlaceMeal로 보호 슬롯 덮어쓰기 방지
    if (!canPlaceMeal(row, actRow, mealStart)) continue;
    markRange(schedule, e.id, mealStart, mealStart + dur, ST.MEAL);
  }
}

// ── 마감조 식사 ─────────────────────────────────────────────────

function chooseCloseMealCounts(mode, n) {
  if (n <= 0) return { n1700: 0, n1730: 0 };
  if (mode === '2-2') return { n1700: Math.min(2, n), n1730: Math.max(0, n - 2) };
  if (mode === '3-1') return { n1700: Math.min(3, n), n1730: Math.max(0, n - 3) };
  if (mode === '4-0') return { n1700: n, n1730: 0 };
  if (n >= 4) return { n1700: 3, n1730: 1 };
  if (n === 3) return { n1700: 2, n1730: 1 };
  if (n === 2) return { n1700: 1, n1730: 1 };
  return { n1700: 1, n1730: 0 };
}

export function applyCloseMeals(ctx) {
  const { schedule, employees, active, slotsMin, rng, mealDurMin, closeMealMode } = ctx;
  const dur       = minsToSlots(mealDurMin, 15);
  const closeEmps = employees.filter(e => e.group === 'CLOSE');
  if (!closeEmps.length) return;

  const i1700 = slotIndexOf(slotsMin, parseTimeToMin('17:00'));
  const i1730 = slotIndexOf(slotsMin, parseTimeToMin('17:30'));
  if (i1700 < 0 && i1730 < 0) return;

  let counts;
  if ((closeMealMode || 'auto') === 'auto') {
    // 커버리지 결핍 최소 방식 자동 선택
    const scored = ['2-2', '3-1', '4-0'].map(op => {
      const c  = chooseCloseMealCounts(op, closeEmps.length);
      let def  = 0;
      const wS = i1700 >= 0 ? Math.max(0, i1700 - 2) : 0;
      const wE = i1730 >= 0
        ? Math.min(slotsMin.length, i1730 + dur + 8)
        : Math.min(slotsMin.length, wS + 20);
      for (let i = wS; i < wE; i++) {
        let rm = 0;
        if (i1700 >= 0 && i >= i1700 && i < i1700 + dur) rm += c.n1700;
        if (i1730 >= 0 && i >= i1730 && i < i1730 + dur) rm += c.n1730;
        const closeActive    = closeEmps.filter(e => active[e.id][i]).length;
        const nonCloseActive = employees.filter(e => e.group !== 'CLOSE' && active[e.id][i]).length;
        def += Math.max(0, 3 - ((closeActive - rm) + nonCloseActive));
      }
      // Fix18-B: 17:30 슬롯에서 마감조 잔류 인원 < 2 시 가중 패널티
      if (i1730 >= 0) {
        const closeActiveAt1730 = closeEmps.filter(e => active[e.id][i1730]).length;
        const removedAt1730 = c.n1700 + c.n1730; // 17:00·17:30 식사 인원 합산
        if (closeActiveAt1730 - removedAt1730 < 2) def += 50;
      }
      return { op, def, c };
    });
    scored.sort((a, b) => a.def - b.def);
    counts = scored[0].c;
  } else {
    counts = chooseCloseMealCounts(closeMealMode, closeEmps.length);
  }

  const pickedSet = new Set();
  const pick = (idx, cnt) => {
    if (idx < 0 || cnt <= 0) return [];
    const elig = closeEmps.filter(e => active[e.id][idx] && !pickedSet.has(e.id));
    shuffleInPlace(elig, rng);
    const out = elig.slice(0, Math.min(cnt, elig.length));
    out.forEach(e => pickedSet.add(e.id));
    return out;
  };

  for (const e of pick(i1700, counts.n1700))
    markRange(schedule, e.id, i1700, Math.min(i1700 + dur, slotsMin.length), ST.MEAL);
  for (const e of pick(i1730, counts.n1730))
    markRange(schedule, e.id, i1730, Math.min(i1730 + dur, slotsMin.length), ST.MEAL);
}

// ── 오픈준비 ────────────────────────────────────────────────────

export function applyOpenPrep(ctx) {
  const { schedule, employees, active, slotsMin } = ctx;
  const limit = parseTimeToMin('10:30');
  for (const e of employees) {
    if (e.group !== 'OPEN') continue;
    for (let i = 0; i < slotsMin.length; i++) {
      if (!active[e.id][i]) continue;
      if (slotsMin[i] >= limit) break;
      if (schedule[e.id][i] === '' || schedule[e.id][i] === ST.OFF)
        schedule[e.id][i] = ST.OPEN_PREP;
    }
  }
}

// ── 오픈조 초기 코어 커버리지 ───────────────────────────────────

export function applyEarlyCoreCoverage(ctx) {
  const { schedule, employees, active, slotsMin, coreMaxSlots } = ctx;
  const opens = employees.filter(e => e.group === 'OPEN');
  if (opens.length < 2) return;

  const cvIdx = slotsMin.findIndex(t => t >= CONSTRAINTS.COVERAGE_START_MIN);
  if (cvIdx < 0) return;

  // ★ Fix2: MEAL(isProtected) 슬롯에서 break하지 않고 건너뜀 → 식사 후 구간도 연속 배정
  // MEAL 종료 후 새 세그먼트 시작 시 segCount 리셋 → 각 세그먼트 최대 coreMaxSlots
  const assignCore = (emp, st, fromIdx) => {
    const row    = schedule[emp.id];
    const actRow = active[emp.id];
    let segCount = 0; // 현재 세그먼트(MEAL/보호 사이 구간) 배정 슬롯 수
    for (let i = fromIdx; i < slotsMin.length; i++) {
      if (!actRow[i]) break;
      const cur = row[i];
      if (cur === ST.OPEN_PREP) break; // 오픈준비 구간은 완전 정지
      if (isProtected(cur)) {
        segCount = 0; // 보호 슬롯(MEAL/REST/MTG) 통과 → 다음 세그먼트 카운트 초기화
        continue;
      }
      if (segCount >= coreMaxSlots) break; // 현재 세그먼트 한도 도달
      if (cur !== '' && cur !== ST.OFF) break; // 이미 배정된 비보호 슬롯 → 중단
      const cnt = stationCountsAt(schedule, employees, active, i);
      const ok  =
        (st === ST.EXIT && cnt.exit < dynMaxAt(ST.EXIT, i, employees, active)) ||
        (st === ST.ELEV && cnt.elev < dynMaxAt(ST.ELEV, i, employees, active)) ||
        (st === ST.F3   && cnt.f3   < dynMaxAt(ST.F3,   i, employees, active));
      if (!ok) break;
      row[i] = st; segCount++;
    }
  };

  // ★ 11:30 식사 전환 구간 EXIT 공백 방지
  // openMeal1130=1 설정 시 OPEN 직원 중 한 명이 11:30에 식사 → EXIT 공백 발생 가능
  // 11:30에 식사가 없는 OPEN 직원을 EXIT 담당으로 지정해 연속 커버리지 보장
  const i1130 = slotsMin.findIndex(t => t >= parseTimeToMin('11:30'));
  const has1130Meal = (e) =>
    i1130 >= 0 && schedule[e.id][i1130] === ST.MEAL;

  let exitOpen = opens[0], elevOpen = opens[1];
  if (opens.length >= 2 && i1130 >= 0
      && has1130Meal(opens[0]) && !has1130Meal(opens[1])) {
    // opens[0]가 11:30 식사 → opens[1]이 EXIT 담당이어야 11:30 커버 가능
    exitOpen = opens[1];
    elevOpen = opens[0];
  }

  assignCore(exitOpen, ST.EXIT, cvIdx);
  assignCore(elevOpen, ST.ELEV, cvIdx);
}

// ── 휴식 배치 ────────────────────────────────────────────────────
//
// 마감조: 1차 = MTG 직후 고정 REST (applyPostMtgFixedSlots 배치분 인식)
//          2차 = 1차 이후 ~ 3차 사이 중간 (8시간만)
//          3차 = 퇴근 전 70~90분
// 기 타: 1차 = 출근 후 60~90분
//          2차 = 1차 이후 ~ 3차 사이 중간 (8시간만)
//          3차 = 퇴근 전 70~90분

export function applyRestBreaks(ctx) {
  const { schedule, employees, active, slotsMin, rng, openMeal1130, coreMinSlots } = ctx;
  const minBlock = coreMinSlots || 3;
  const i1130    = openMeal1130 > 0 ? slotIndexOf(slotsMin, parseTimeToMin('11:30')) : -1;

  const findEmpty = (id, from, to) => {
    for (let i = from; i < to; i++) {
      if (i < 0 || i >= slotsMin.length || !active[id][i]) continue;
      const st = schedule[id][i];
      if (st === '' || st === ST.OFF) return i;
    }
    return -1;
  };

  // Fix19/Fix25: 피크 결핍 시간대를 피해 빈 슬롯 탐색
  // Fix25 확장:
  //   [12:00, 12:30] — mid8_0 r1 충돌 구간
  //   [13:30, 14:30] — 기존 피크
  //   [18:30, 19:30] — mid8_1·close6 r3 충돌 구간 (기존 19:00→19:30으로 확대)
  //   [20:45, 21:30] — close2/3 r2 + close1 r3 충돌 구간
  const PEAK_RANGES = [
    [parseTimeToMin('12:00'), parseTimeToMin('12:30')],
    [parseTimeToMin('13:30'), parseTimeToMin('14:30')],
    [parseTimeToMin('18:30'), parseTimeToMin('19:30')],
    [parseTimeToMin('20:45'), parseTimeToMin('21:30')],
  ];
  const isPeakSlot = (si) => {
    const m = slotsMin[si];
    return PEAK_RANGES.some(([lo, hi]) => m >= lo && m < hi);
  };
  const findEmptyAvoidPeak = (id, from, to) => {
    // 1차: 피크 제외
    for (let i = from; i < to; i++) {
      if (i < 0 || i >= slotsMin.length || !active[id][i]) continue;
      if (isPeakSlot(i)) continue;
      const st = schedule[id][i];
      if (st === '' || st === ST.OFF) return i;
    }
    // fallback: 피크 포함
    return findEmpty(id, from, to);
  };

  for (const e of employees) {
    const row = schedule[e.id];

    let eS = -1, eE = -1;
    for (let i = 0; i < slotsMin.length; i++) {
      if (active[e.id][i]) { if (eS < 0) eS = i; eE = i + 1; }
    }
    if (eS < 0) continue;

    // ── 1차 휴식 ──────────────────────────────────────────────
    let r1 = -1;

    if (e.group === 'CLOSE') {
      // 마감조: MTG 직후 REST 슬롯을 1차 기준점으로 찾기 (배치는 applyPostMtgFixedSlots)
      for (let i = eS; i < eE; i++) {
        if (!active[e.id][i] || row[i] !== ST.MTG) continue;
        let mtgEnd = i;
        while (mtgEnd < eE && active[e.id][mtgEnd] && row[mtgEnd] === ST.MTG) mtgEnd++;
        // Fix27: REST는 s3(mtgEnd+2) 우선, 불가 시 s2(mtgEnd+1) fallback
        // Bug Fix: s3뿐 아니라 s2 위치도 확인해야 applyPostMtgFixedSlots의 fallback 배치를 인식
        const restSlotS3 = mtgEnd + 2;  // s3 위치
        const restSlotS2 = mtgEnd + 1;  // s2 fallback 위치
        if (restSlotS3 < eE && active[e.id][restSlotS3] && row[restSlotS3] === ST.REST)
          r1 = restSlotS3;
        else if (restSlotS2 < eE && active[e.id][restSlotS2] && row[restSlotS2] === ST.REST)
          r1 = restSlotS2;  // s2 fallback 감지 — 이중 REST 방지
        break;
      }
      // Fallback: MTG 없는 늦은 출근 마감조(15:30/15:50 등) → 출근 후 60~90분 창
      if (r1 < 0) {
        const s  = eS + Math.ceil(60 / 15);
        const en = Math.min(eS + Math.ceil(90 / 15), eE);
        let idx  = findEmpty(e.id, s, en);
        if (idx < 0) idx = findEmpty(e.id, eS + 1, s);
        if (idx >= 0) { row[idx] = ST.REST; r1 = idx; }
      }
    } else if (e.group === 'MID' && e.startMin <= parseTimeToMin('10:30') && i1130 >= 0) {
      // 조기 출근 중간조: 11:30 식사 전에 배치
      let idx = findEmpty(e.id, eS + minBlock, Math.min(i1130, eE));
      if (idx < 0) idx = findEmpty(e.id, eS + minBlock, eE);
      if (idx >= 0) { row[idx] = ST.REST; r1 = idx; }
    } else {
      // 오픈·일반 중간조: 출근 후 60~90분
      // Fix21: MID 그룹은 r1도 피크 회피 시도 → 13:30~14:30 창 직접 배치 방지
      const s  = eS + Math.ceil(60 / 15);
      const en = Math.min(eS + Math.ceil(90 / 15), eE);
      let idx = -1;
      if (e.group === 'MID') {
        idx = findEmptyAvoidPeak(e.id, s, en);
        if (idx < 0) idx = findEmptyAvoidPeak(e.id, eS, s);
      }
      if (idx < 0) idx = findEmpty(e.id, s, en);
      if (idx < 0) idx = findEmpty(e.id, eS, s);
      if (idx >= 0) { row[idx] = ST.REST; r1 = idx; }
    }

    // ── 3차 휴식: 퇴근 전 70~90분 ──────────────────────────────
    // Fix26: 피크 회피 + 후방 우선 탐색 (늦은 슬롯 → 이른 슬롯 순)
    // → close1처럼 21:00~21:15 창이 피크 구간에 걸릴 때 21:15를 우선 선택해 21:00 커버리지 보호
    let r3 = -1;
    {
      const s  = Math.max(eS, eE - Math.ceil(90 / 15));
      const en = Math.max(eS, eE - Math.ceil(70 / 15));
      // 1차: 피크 회피 후방 우선 (en-1 → s)
      for (let i = en - 1; i >= s; i--) {
        if (i < 0 || i >= slotsMin.length || !active[e.id][i]) continue;
        if (isPeakSlot(i)) continue;
        const st = schedule[e.id][i];
        if (st === '' || st === ST.OFF) { row[i] = ST.REST; r3 = i; break; }
      }
      // 2차: 피크 포함 후방 우선
      if (r3 < 0) {
        for (let i = en - 1; i >= s; i--) {
          if (i < 0 || i >= slotsMin.length || !active[e.id][i]) continue;
          const st = schedule[e.id][i];
          if (st === '' || st === ST.OFF) { row[i] = ST.REST; r3 = i; break; }
        }
      }
      // 3차: 전방 fallback (eE 방향)
      if (r3 < 0) {
        const idx = findEmpty(e.id, en, eE);
        if (idx >= 0) { row[idx] = ST.REST; r3 = idx; }
      }
    }

    // ── 2차 휴식: 8시간 근무자만 (Fix19: 피크 시간대 회피) ─────
    if (e.hours !== 6) {
      const s  = r1 >= 0 ? r1 + 1 : eS + Math.ceil(90 / 15);
      const en = r3 >= 0 ? r3     : eE - Math.ceil(70 / 15);
      if (en > s + 1) {
        const mid = Math.floor((s + en) / 2);
        const jt  = rng ? Math.floor(rng() * 4) - 2 : 0;
        const ss  = clamp(mid + jt - 2, s, en - 1);
        // Fix19: 피크 회피 우선, fallback으로 전체 탐색
        let idx = findEmptyAvoidPeak(e.id, ss, Math.min(ss + 5, en));
        if (idx < 0) idx = findEmptyAvoidPeak(e.id, s, en);
        if (idx < 0) idx = findEmpty(e.id, s, en); // 최종 fallback
        if (idx >= 0) row[idx] = ST.REST;
      }
    }
  }
}

// ── 마감조 MTG 직후 고정 배치 ───────────────────────────────────
// MTG 블록 종료(마지막 MTG 슬롯 = i) 기준 (Fix27 적용):
//   +1슬롯(s1, 15분): 2F카트(CART2F)  ← 현장 복귀 준비
//   +3슬롯(s3, 45분): 휴식(REST)       ← 마감조 1차 휴식 (s3 불가 시 +2슬롯 s2로 fallback)
// MEAL 슬롯은 덮어쓰지 않음.

export function applyPostMtgFixedSlots(ctx) {
  const { schedule, employees, active, slotsMin } = ctx;
  for (const e of employees) {
    if (e.group !== 'CLOSE') continue;
    const row    = schedule[e.id];
    const actRow = active[e.id];
    for (let i = 0; i < slotsMin.length - 1; i++) {
      if (!actRow[i] || row[i] !== ST.MTG) continue;
      if (i + 1 < slotsMin.length && row[i + 1] === ST.MTG) continue; // MTG 블록 내부
      const s1 = i + 1, s2 = i + 2, s3 = i + 3;
      if (s1 < slotsMin.length && actRow[s1] && row[s1] !== ST.MEAL) row[s1] = ST.CART2F;
      // Fix27: REST를 s2(+2)→s3(+3)으로 1슬롯 후방 이동
      // → 15:30(s2) 커버리지 보호: close6/close1의 REST가 15:30을 빠져나와 15:45에 배치
      const restSlotIdx = (s3 < slotsMin.length && actRow[s3] && row[s3] !== ST.MEAL) ? s3 : s2;
      if (restSlotIdx < slotsMin.length && actRow[restSlotIdx] && row[restSlotIdx] !== ST.MEAL)
        row[restSlotIdx] = ST.REST;
    }
  }
}

// ── Fix18-A / Fix20: Post-greedy 동슬롯 REST 분산 ───────────────
//
// 호출 위치: index.js Step 7(ensureCoreExperience) 직후, 최종 validate 전
//
// Fix18-A (v15): CLOSE 그룹 전용, computeCoverageDeficits 전체 재계산
// Fix20  (v16):
//   - 전 그룹(CLOSE + MID) 확장 → 13:45/14:00 MID REST 충돌 해소
//   - computeCoverageDeficits 전체 재계산 → 슬롯 단위 경량 비교로 성능 개선
//   - CLOSE: CLOSE_LATE_MIN 상한 유지 / MID: 근무 범위 내 자유 이동
//
// 제약 (공통):
//   - 3차 휴식 하한(eE - 6슬롯 = 90분 전) 이상 유지
//   - 이동 후 해당 슬롯 결핍이 악화되면 rollback
//   - 최소 출근 인원 10명 환경 기준

export function spreadSimultaneousRests(ctx) {
  const { schedule, employees, active, slotsMin, target } = ctx;
  if (!target) return;

  // 슬롯 단위 경량 결핍 체크 (전체 재계산 대신 슬롯 하나만 비교)
  const slotDeficit = (si) => {
    const t = target[si];
    if (!t || (t.exit === 0 && t.elev === 0 && t.f3 === 0)) return 0;
    const cnt = stationCountsAt(schedule, employees, active, si);
    return Math.max(0, t.exit - cnt.exit)
         + Math.max(0, t.elev - cnt.elev)
         + Math.max(0, t.f3   - cnt.f3);
  };

  // 그룹별 설정
  const groupCfg = [
    {
      group: 'CLOSE',
      getLateLimit: (eE) => {
        const lateIdx = slotsMin.findIndex(t => t >= CONSTRAINTS.CLOSE_LATE_MIN);
        return lateIdx >= 0 ? Math.min(lateIdx, eE) : eE;
      },
    },
    {
      group: 'MID',
      getLateLimit: (eE) => eE, // MID는 CLOSE_LATE_MIN 제한 없음
    },
  ];

  for (const { group, getLateLimit } of groupCfg) {
    const groupEmps = employees.filter(e => e.group === group);
    if (groupEmps.length < 2) continue;

    // Fix-v20-4: 외부 루프 추가 — 동시 REST가 3명 이상일 때 1회 패스로 1명만 이동하던 문제 수정
    // 이동이 발생하는 동안 슬롯을 반복 탐색해 완전 분산
    let anyMoved = true;
    while (anyMoved) {
      anyMoved = false;

    for (let si = 0; si < slotsMin.length; si++) {
      // 이 슬롯에서 REST 중인 해당 그룹 직원 수집
      const restEmps = groupEmps.filter(e =>
        active[e.id][si] && schedule[e.id][si] === ST.REST
      );
      if (restEmps.length < 2) continue;

      // 해당 슬롯에 실제 커버리지 결핍 없으면 스킵
      const defBefore = slotDeficit(si);
      if (defBefore === 0) continue;

      // 2번째 이후 직원 REST 이동 시도
      for (let k = 1; k < restEmps.length; k++) {
        const e = restEmps[k];

        // 근무 끝 슬롯(eE) 계산
        let eE = -1;
        for (let i = 0; i < slotsMin.length; i++) {
          if (active[e.id][i]) eE = i + 1;
        }
        if (eE < 0) continue;

        const r3Min = eE - Math.ceil(90 / 15); // 3차 휴식 하한
        const limit = getLateLimit(eE);

        let moved = false;
        // Fix22: ±6슬롯(±90분)으로 확대 — 더 넓은 범위에서 REST 분산 가능
        for (const delta of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
          const alt = si + delta;
          if (alt < r3Min || alt >= limit) continue;
          if (!active[e.id][alt]) continue;
          const cur = schedule[e.id][alt];
          if (cur !== '' && cur !== ST.OFF) continue;

          // 이동 적용 후 슬롯 단위 비교 (경량)
          schedule[e.id][si]  = '';
          schedule[e.id][alt] = ST.REST;

          const defAfter = slotDeficit(si);
          if (defAfter <= defBefore) {
            moved = true;
            anyMoved = true; // Fix-v20-4: 외부 루프 반복 트리거
            break; // 개선 또는 유지 → 확정
          }

          // rollback
          schedule[e.id][alt] = '';
          schedule[e.id][si]  = ST.REST;
        }

        if (moved) break;
      }
    }

    } // end while (anyMoved)
  }
}
