/**
 * scheduler/events.js — 고정 이벤트 배치
 *
 * 안전회의, 식사(오픈·마감), 오픈준비, 초기 코어 커버리지,
 * 휴식, 마감조 안전회의 직후 코어 슬롯 배치.
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

  const close    = employees.filter(e => e.group === 'CLOSE');
  const mid      = employees.filter(e => e.group === 'MID');
  const elig     = mid.filter(e => active[e.id][i1]);
  shuffleInPlace(elig, rng);
  const picked   = elig.slice(0, Math.min(2, elig.length));
  const pickedIds = new Set(picked.map(e => e.id));

  for (const e of [...close, ...picked]) {
    if (!active[e.id][i1]) continue;
    markRange(schedule, e.id, i1, Math.min(i1 + dur, slotsMin.length), ST.MTG);
  }
  for (const e of employees) {
    if (!active[e.id][i2]) continue;
    if (e.group === 'CLOSE' || pickedIds.has(e.id)) continue;
    markRange(schedule, e.id, i2, Math.min(i2 + dur, slotsMin.length), ST.MTG);
  }
}

// ── 오픈조 식사 ─────────────────────────────────────────────────

export function applyOpenMeals(ctx) {
  const { schedule, employees, active, slotsMin, rng, mealDurMin, openMeal1130, openMeal1230 } = ctx;
  const dur   = minsToSlots(mealDurMin, 15);
  const open  = employees.filter(e => e.group === 'OPEN');
  if (!open.length) return;

  const i1130 = slotIndexOf(slotsMin, parseTimeToMin('11:30'));
  const i1230 = slotIndexOf(slotsMin, parseTimeToMin('12:30'));
  const pickedSet = new Set();
  const pick = (idx, cnt) => {
    if (idx < 0 || cnt <= 0) return [];
    const elig = open.filter(e => active[e.id][idx] && !pickedSet.has(e.id));
    shuffleInPlace(elig, rng);
    return elig.slice(0, Math.min(cnt, elig.length));
  };

  const p1 = pick(i1130, openMeal1130);
  for (const e of p1) pickedSet.add(e.id);
  const p2 = pick(i1230, openMeal1230);

  for (const e of p1) markRange(schedule, e.id, i1130, Math.min(i1130 + dur, slotsMin.length), ST.MEAL);
  for (const e of p2) markRange(schedule, e.id, i1230, Math.min(i1230 + dur, slotsMin.length), ST.MEAL);
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
  const dur   = minsToSlots(mealDurMin, 15);
  const close = employees.filter(e => e.group === 'CLOSE');
  if (!close.length) return;

  const i1700 = slotIndexOf(slotsMin, parseTimeToMin('17:00'));
  const i1730 = slotIndexOf(slotsMin, parseTimeToMin('17:30'));
  if (i1700 < 0 && i1730 < 0) return;

  let mode = closeMealMode || 'auto';
  let counts;

  if (mode === 'auto') {
    const opts = ['2-2', '3-1', '4-0'];
    const scored = opts.map(op => {
      const c  = chooseCloseMealCounts(op, close.length);
      let def  = 0;
      const wS = i1700 >= 0 ? Math.max(0, i1700 - 2) : 0;
      const wE = i1730 >= 0
        ? Math.min(slotsMin.length, i1730 + dur + 8)
        : Math.min(slotsMin.length, wS + 20);
      for (let i = wS; i < wE; i++) {
        let rm = 0;
        if (i1700 >= 0 && i >= i1700 && i < i1700 + dur) rm += c.n1700;
        if (i1730 >= 0 && i >= i1730 && i < i1730 + dur) rm += c.n1730;
        const totalActive    = employees.filter(e => active[e.id][i]).length;
        const closeActive    = close.filter(e => active[e.id][i]).length;
        const nonCloseActive = totalActive - closeActive;
        const av = (closeActive - rm) + nonCloseActive;
        def += Math.max(0, 3 - av);
      }
      return { op, def, c };
    });
    scored.sort((a, b) => a.def - b.def);
    mode   = scored[0].op;
    counts = scored[0].c;
  } else {
    counts = chooseCloseMealCounts(mode, close.length);
  }

  const pickedSet = new Set();
  const pick = (idx, cnt) => {
    if (idx < 0 || cnt <= 0) return [];
    const elig = close.filter(e => active[e.id][idx] && !pickedSet.has(e.id));
    shuffleInPlace(elig, rng);
    const out = elig.slice(0, Math.min(cnt, elig.length));
    out.forEach(e => pickedSet.add(e.id));
    return out;
  };

  for (const e of pick(i1700, counts.n1700)) markRange(schedule, e.id, i1700, Math.min(i1700 + dur, slotsMin.length), ST.MEAL);
  for (const e of pick(i1730, counts.n1730)) markRange(schedule, e.id, i1730, Math.min(i1730 + dur, slotsMin.length), ST.MEAL);
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

// ── 오픈 초기 코어 커버리지 ─────────────────────────────────────

export function applyEarlyCoreCoverage(ctx) {
  const { schedule, employees, active, slotsMin, coreMaxSlots } = ctx;
  const CV_START = CONSTRAINTS.COVERAGE_START_MIN;
  const opens    = employees.filter(e => e.group === 'OPEN');
  if (opens.length < 2) return;

  const cvIdx = slotsMin.findIndex(t => t >= CV_START);
  if (cvIdx < 0) return;

  const [first, second] = opens;
  const assignCore = (emp, st, fromIdx) => {
    const row    = schedule[emp.id];
    const actRow = active[emp.id];
    let count = 0;
    for (let i = fromIdx; i < slotsMin.length && count < coreMaxSlots; i++) {
      if (!actRow[i]) break;
      const cur = row[i];
      if (isProtected(cur) || cur === ST.OPEN_PREP) break;
      if (cur === '' || cur === ST.OFF) {
        const cnt = stationCountsAt(schedule, employees, active, i);
        const maxOk =
          (st === ST.EXIT  && cnt.exit  < dynMaxAt(ST.EXIT,  i, employees, active)) ||
          (st === ST.ELEV  && cnt.elev  < dynMaxAt(ST.ELEV,  i, employees, active)) ||
          (st === ST.F3    && cnt.f3    < dynMaxAt(ST.F3,    i, employees, active));
        if (!maxOk) break;
        row[i] = st; count++;
      } else break;
    }
    return count;
  };

  assignCore(first,  ST.EXIT, cvIdx);
  assignCore(second, ST.ELEV, cvIdx);
}

// ── 휴식 배치 ────────────────────────────────────────────────────

export function applyRestBreaks(ctx) {
  const { schedule, employees, active, slotsMin, rng, openMeal1130, coreMinSlots } = ctx;
  const minBlockSlots = coreMinSlots || 3;

  function findEmpty(id, from, to) {
    for (let i = from; i < to; i++) {
      if (i < 0 || i >= slotsMin.length) continue;
      if (!active[id][i]) continue;
      const st = schedule[id][i];
      if (st === '' || st === ST.OFF) return i;
    }
    return -1;
  }

  const openMealStart1130 = openMeal1130 > 0
    ? slotIndexOf(slotsMin, parseTimeToMin('11:30')) : -1;

  for (const e of employees) {
    const row = schedule[e.id];
    let eS = -1, eE = -1;
    for (let i = 0; i < slotsMin.length; i++) {
      if (active[e.id][i]) { if (eS < 0) eS = i; eE = i + 1; }
    }
    if (eS < 0) continue;

    const earlyMid = e.group === 'MID' && e.startMin <= parseTimeToMin('10:30');
    let r1 = -1;

    if (earlyMid && openMealStart1130 >= 0) {
      const s  = eS + minBlockSlots;
      const en = Math.min(openMealStart1130, eE);
      let idx  = findEmpty(e.id, s, en);
      if (idx < 0) idx = findEmpty(e.id, s, eE);
      if (idx >= 0) { row[idx] = ST.REST; r1 = idx; }
    } else {
      const s  = eS + Math.ceil(60 / 15);
      const en = Math.min(eS + Math.ceil(90 / 15), eE);
      let idx  = findEmpty(e.id, s, en);
      if (idx < 0) idx = findEmpty(e.id, eS, s);
      if (idx >= 0) { row[idx] = ST.REST; r1 = idx; }
    }

    // 3차 휴식 (퇴근 전)
    let r3 = -1;
    {
      const s  = Math.max(eS, eE - Math.ceil(90 / 15));
      const en = Math.max(eS, eE - Math.ceil(70 / 15));
      let idx  = findEmpty(e.id, s, en);
      if (idx < 0) idx = findEmpty(e.id, en, eE);
      if (idx >= 0) { row[idx] = ST.REST; r3 = idx; }
    }

    // 2차 휴식 (8시간 근무자만)
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

// ── 마감조 안전회의 직후 코어 슬롯 ─────────────────────────────

export function applyPostMtgCoreSlot(ctx) {
  const { schedule, employees, active, slotsMin, target } = ctx;
  const close = employees.filter(e => e.group === 'CLOSE');
  for (const e of close) {
    const row    = schedule[e.id];
    const actRow = active[e.id];
    for (let i = 1; i < slotsMin.length; i++) {
      if (!actRow[i]) continue;
      if (row[i - 1] !== ST.MTG) continue;
      if (row[i] !== '' && row[i] !== ST.OFF && row[i] !== ST.CART2F && row[i] !== ST.CART3F) continue;
      const t  = target[i] || { exit: 0, elev: 0, f3: 0 };
      const c  = stationCountsAt(schedule, employees, active, i);
      let st   = null;
      if      (t.elev > 0 && c.elev < dynMaxAt(ST.ELEV, i, employees, active)) st = ST.ELEV;
      else if (t.exit > 0 && c.exit < dynMaxAt(ST.EXIT, i, employees, active)) st = ST.EXIT;
      else if (t.f3   > 0 && c.f3   < dynMaxAt(ST.F3,   i, employees, active)) st = ST.F3;
      if (st) row[i] = st;
    }
  }
}
