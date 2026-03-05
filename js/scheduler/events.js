/**
 * scheduler/events.js — 고정 이벤트 배치
 *
 * applyMeetings           — 안전회의 (마감조 + 중간조 2명)
 * applyOpenMeals          — 오픈조 식사
 * applyMidMeals           — 중간조 식사 (출근 후 60~150분 창)
 * applyCloseMeals         — 마감조 식사 (17:00 / 17:30)
 * applyOpenPrep           — 오픈준비 (10:30 이전)
 * applyEarlyCoreCoverage  — 오픈조 초기 코어 커버리지
 * applyRestBreaks         — 휴식 배치 (1·2·3차)
 * applyPostMtgFixedSlots  — 마감조 MTG 직후 2F카트 → 휴식 고정
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
// 개인별 출근 시각 기준 +60~150분 창에서 dur 슬롯 연속 빈 구간 탐색.
// 창 내 빈 구간 없으면 전체 근무 범위로 확장.

export function applyMidMeals(ctx) {
  const { schedule, employees, active, slotsMin, mealDurMin } = ctx;
  const dur     = minsToSlots(mealDurMin, 15);
  const midEmps = employees.filter(e => e.group === 'MID');
  if (!midEmps.length) return;

  const findMealSlot = (row, actRow, from, to) => {
    for (let i = from; i <= to - dur; i++) {
      let ok = true;
      for (let j = i; j < i + dur; j++) {
        if (!actRow[j] || (row[j] !== '' && row[j] !== ST.OFF)) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  };

  for (const e of midEmps) {
    const row    = schedule[e.id];
    const actRow = active[e.id];

    let eS = -1, eE = -1;
    for (let i = 0; i < slotsMin.length; i++) {
      if (actRow[i]) { if (eS < 0) eS = i; eE = i + 1; }
    }
    if (eS < 0) continue;

    // 식사 창: 출근 후 60~150분
    const wS = Math.max(eS, slotsMin.findIndex(t => t >= e.startMin + 60));
    let wEIdx = slotsMin.findIndex(t => t >= e.startMin + 150);
    const wE  = Math.min(eE, wEIdx >= 0 ? wEIdx + 1 : eE);

    let mealStart = findMealSlot(row, actRow, wS, wE);
    if (mealStart < 0) mealStart = findMealSlot(row, actRow, eS, eE);
    if (mealStart < 0) continue;

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

  const assignCore = (emp, st, fromIdx) => {
    const row    = schedule[emp.id];
    const actRow = active[emp.id];
    let count = 0;
    for (let i = fromIdx; i < slotsMin.length && count < coreMaxSlots; i++) {
      if (!actRow[i]) break;
      const cur = row[i];
      if (isProtected(cur) || cur === ST.OPEN_PREP || (cur !== '' && cur !== ST.OFF)) break;
      const cnt = stationCountsAt(schedule, employees, active, i);
      const ok  =
        (st === ST.EXIT && cnt.exit < dynMaxAt(ST.EXIT, i, employees, active)) ||
        (st === ST.ELEV && cnt.elev < dynMaxAt(ST.ELEV, i, employees, active)) ||
        (st === ST.F3   && cnt.f3   < dynMaxAt(ST.F3,   i, employees, active));
      if (!ok) break;
      row[i] = st; count++;
    }
  };

  assignCore(opens[0], ST.EXIT, cvIdx);
  assignCore(opens[1], ST.ELEV, cvIdx);
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
        const restSlot = mtgEnd + 1; // applyPostMtgFixedSlots의 s2
        if (restSlot < eE && active[e.id][restSlot] && row[restSlot] === ST.REST)
          r1 = restSlot;
        break;
      }
    } else if (e.group === 'MID' && e.startMin <= parseTimeToMin('10:30') && i1130 >= 0) {
      // 조기 출근 중간조: 11:30 식사 전에 배치
      let idx = findEmpty(e.id, eS + minBlock, Math.min(i1130, eE));
      if (idx < 0) idx = findEmpty(e.id, eS + minBlock, eE);
      if (idx >= 0) { row[idx] = ST.REST; r1 = idx; }
    } else {
      // 오픈·일반 중간조: 출근 후 60~90분
      const s  = eS + Math.ceil(60 / 15);
      const en = Math.min(eS + Math.ceil(90 / 15), eE);
      let idx  = findEmpty(e.id, s, en);
      if (idx < 0) idx = findEmpty(e.id, eS, s);
      if (idx >= 0) { row[idx] = ST.REST; r1 = idx; }
    }

    // ── 3차 휴식: 퇴근 전 70~90분 ──────────────────────────────
    let r3 = -1;
    {
      const s  = Math.max(eS, eE - Math.ceil(90 / 15));
      const en = Math.max(eS, eE - Math.ceil(70 / 15));
      let idx  = findEmpty(e.id, s, en);
      if (idx < 0) idx = findEmpty(e.id, en, eE);
      if (idx >= 0) { row[idx] = ST.REST; r3 = idx; }
    }

    // ── 2차 휴식: 8시간 근무자만 ────────────────────────────────
    if (e.hours !== 6) {
      const s  = r1 >= 0 ? r1 + 1 : eS + Math.ceil(90 / 15);
      const en = r3 >= 0 ? r3     : eE - Math.ceil(70 / 15);
      if (en > s + 1) {
        const mid = Math.floor((s + en) / 2);
        const jt  = rng ? Math.floor(rng() * 4) - 2 : 0;
        const ss  = clamp(mid + jt - 2, s, en - 1);
        let idx   = findEmpty(e.id, ss, Math.min(ss + 5, en));
        if (idx < 0) idx = findEmpty(e.id, s, en);
        if (idx >= 0) row[idx] = ST.REST;
      }
    }
  }
}

// ── 마감조 MTG 직후 고정 배치 ───────────────────────────────────
// MTG 블록 종료 슬롯 기준:
//   +0슬롯(15분): 2F카트(CART2F)  ← 현장 복귀 준비
//   +1슬롯(15분): 휴식(REST)       ← 마감조 1차 휴식
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
      const s1 = i + 1, s2 = i + 2;
      if (s1 < slotsMin.length && actRow[s1] && row[s1] !== ST.MEAL) row[s1] = ST.CART2F;
      if (s2 < slotsMin.length && actRow[s2] && row[s2] !== ST.MEAL) row[s2] = ST.REST;
    }
  }
}
