/**
 * scheduler/index.js — 스케줄 생성 진입점
 *
 * generateSchedule(input) → { schedule, slots, slotsMin, employees, violations, stats }
 *
 * 파이프라인:
 *   Step 1  고정 이벤트   (회의 → 오픈식사 → 마감식사 → 오픈준비)
 *   Step 2  preAssign    (60분 블록 단위 코어 사전 계획)
 *   Step 3  휴식 배치    (오픈준비 → 휴식 → 오픈준비 재배치 → 초기 코어)
 *   Step 4  그리디 배정
 *   Step 5  수리 1차     (커버리지 + 코어미경험)
 *   Step 6  후처리       (Cart제한 → 균형화 → ensureCore 3회 → 초과수리)
 *   Step 7  강제 패스    (forceDeficit → rebalance → forceCoreExp → postMtg)
 *   Step 8  검증
 *
 * 의존성: 모든 scheduler/* 서브모듈
 */

import { ST, CONSTRAINTS, DEFAULTS } from '../constants.js';
import { parseTimeToMin, minToTime, buildSlots, minsToSlots, computeActiveMask, buildWorkBlocks, seededRng } from '../utils.js';
import { isProtected, makeCoverageTargets, stationCountsAt } from './core.js';
import { applyMeetings, applyOpenMeals, applyCloseMeals, applyOpenPrep, applyEarlyCoreCoverage, applyRestBreaks, applyPostMtgCoreSlot } from './events.js';
import { buildPreAssign, assignBlocksGreedy } from './assign.js';
import { repairCoverage, repairMissingCoreExperience, ensureCoreExperience } from './repair.js';
import { balanceCoreRotation, repairOverstaffing, enforceCart2fMax, enforceCart3fMax, enforceCloseLateAssignment, fixFragmentBlocks, fillRemainingSlots } from './balance.js';
import { rebalanceVariance, forceCoreExperience, forceDeficitSlots } from './force.js';
import { validate, recomputeCoreCount, computeStats } from './validate.js';

export function generateSchedule(input) {
  const STEP        = 15;
  const dayStartMin = parseTimeToMin(input.dayStart || DEFAULTS.DAY_START);
  const dayEndMin   = parseTimeToMin(input.dayEnd   || DEFAULTS.DAY_END);
  const slotsMin    = buildSlots(dayStartMin, dayEndMin, STEP);
  const slots       = slotsMin.map(minToTime);
  const rng         = seededRng(Number(input.seed) || DEFAULTS.SEED);

  const mealDurMin    = Number(input.mealDur)    || DEFAULTS.MEAL_DUR_MIN;
  const meetingDurMin = Number(input.meetingDur) || DEFAULTS.MTG_DUR_MIN;
  const coreMinSlots  = minsToSlots(Number(input.coreMin) || DEFAULTS.CORE_MIN_MIN, STEP);
  const coreMaxSlots  = minsToSlots(Number(input.coreMax) || DEFAULTS.CORE_MAX_MIN, STEP);
  const anyMinSlots   = minsToSlots(Number(input.anyMin)  || DEFAULTS.ANY_MIN_MIN,  STEP);

  // ── 직원 정규화 ──────────────────────────────────────────────
  const seenIds = new Set();
  const employees = (input.employees || []).map((e, idx) => {
    let id = e?.id ? String(e.id) : `E${idx + 1}`;
    if (seenIds.has(id)) { let k = 2; while (seenIds.has(`${id}_${k}`)) k++; id = `${id}_${k}`; }
    seenIds.add(id);
    const group    = ['OPEN','MID','CLOSE'].includes(String(e?.group || 'MID').toUpperCase())
      ? String(e.group).toUpperCase() : 'MID';
    const hours    = Number(e?.hours) === 6 ? 6 : 8;
    const startMin = parseTimeToMin(e?.start || '08:00');
    const hasMeal  = group === 'OPEN' || group === 'CLOSE';
    const endMin   = startMin + hours * 60 + (hasMeal ? mealDurMin : 0);
    return { ...e, id, group, hours, startMin, endMin, hasMeal, idx };
  });

  // ── 스케줄 초기화 ────────────────────────────────────────────
  const nSlots   = slotsMin.length;
  const schedule = {};
  for (const e of employees) schedule[e.id] = new Array(nSlots).fill('');
  const active = computeActiveMask(employees, slotsMin);
  for (const e of employees)
    for (let i = 0; i < nSlots; i++)
      if (!active[e.id][i]) schedule[e.id][i] = ST.OFF;

  const closeEmps  = employees.filter(e => e.group === 'CLOSE');
  const closeEndMin = closeEmps.length > 0
    ? Math.max(...closeEmps.map(e => e.endMin)) : dayEndMin;
  const target = makeCoverageTargets(slotsMin, closeEndMin, employees, active);

  const ctx = {
    slotsMin, slots, employees, schedule, active, target,
    coreMinSlots, coreMaxSlots, anyMinSlots,
    mealDurMin, meetingDurMin,
    mtg1Min        : parseTimeToMin(input.mtg1 || DEFAULTS.MTG1_TIME),
    mtg2Min        : parseTimeToMin(input.mtg2 || DEFAULTS.MTG2_TIME),
    openMeal1130   : Number(input.openMeal1130) || DEFAULTS.OPEN_MEAL_1130,
    openMeal1230   : Number(input.openMeal1230) || DEFAULTS.OPEN_MEAL_1230,
    closeMealMode  : input.closeMealMode || DEFAULTS.CLOSE_MEAL_MODE,
    rng, preMap: null, coreCount: null,
  };

  // ── Step 1: 고정 이벤트 ──────────────────────────────────────
  applyMeetings(ctx);
  applyOpenMeals(ctx);
  applyCloseMeals(ctx);
  applyOpenPrep(ctx);

  // ── Step 2: preAssign ────────────────────────────────────────
  const { preMap, coreCount } = buildPreAssign(ctx);
  ctx.preMap    = preMap;
  ctx.coreCount = coreCount;

  // ── Step 3: 휴식 배치 ────────────────────────────────────────
  // 오픈준비 임시 해제 → 휴식 배치 → 오픈준비 복원
  for (const e of employees) {
    if (e.group !== 'OPEN') continue;
    const limit = parseTimeToMin('10:30');
    for (let i = 0; i < nSlots; i++) {
      if (!active[e.id][i]) continue;
      if (slotsMin[i] >= limit) break;
      if (schedule[e.id][i] === ST.OPEN_PREP) schedule[e.id][i] = '';
    }
  }
  applyRestBreaks(ctx);
  applyOpenPrep(ctx);
  applyEarlyCoreCoverage(ctx);

  // 고정이벤트+휴식 후 실제 가용인원 기준으로 커버리지 목표 재계산
  ctx.target = slotsMin.map((t, i) => {
    if (t < CONSTRAINTS.COVERAGE_START_MIN || t >= closeEndMin) return { exit: 0, elev: 0, f3: 0 };
    const avail = employees.filter(e => {
      if (!active[e.id][i]) return false;
      const st = schedule[e.id][i];
      return !isProtected(st) && st !== ST.OPEN_PREP && st !== ST.OFF;
    }).length;
    if (avail <= 0) return { exit: 0, elev: 0, f3: 0 };
    if (avail === 1) return { exit: 1, elev: 0, f3: 0 };
    if (avail === 2) return { exit: 1, elev: 1, f3: 0 };
    return { exit: 1, elev: 1, f3: 1 };
  });

  // ── Step 4: 그리디 배정 ──────────────────────────────────────
  assignBlocksGreedy(ctx);

  // ── Step 5: 수리 1차 ─────────────────────────────────────────
  repairCoverage(ctx);
  repairMissingCoreExperience(ctx);

  // ── Step 6: 후처리 ───────────────────────────────────────────
  enforceCart2fMax(ctx);
  enforceCloseLateAssignment(ctx);
  fixFragmentBlocks(ctx);
  fillRemainingSlots(ctx);

  balanceCoreRotation(ctx);
  recomputeCoreCount(ctx);

  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);
  repairCoverage(ctx);
  recomputeCoreCount(ctx);

  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);
  enforceCart3fMax(ctx);
  enforceCart2fMax(ctx);

  // ensureCoreExperience: 변화가 없을 때까지 최대 3회
  for (let _pass = 0; _pass < 3; _pass++) {
    const countMissing = () => employees.filter(e => {
      const bl = buildWorkBlocks(schedule[e.id], active[e.id]);
      return !bl.some(b => b.st === ST.EXIT)
          || !bl.some(b => b.st === ST.ELEV)
          || !bl.some(b => b.st === ST.F3);
    }).length;
    const before = countMissing();
    ensureCoreExperience(ctx);
    fixFragmentBlocks(ctx);
    enforceCart2fMax(ctx);
    enforceCart3fMax(ctx);
    enforceCart2fMax(ctx);
    if (countMissing() === 0 || countMissing() === before) break;
  }

  enforceCart2fMax(ctx);
  enforceCart3fMax(ctx);
  enforceCart2fMax(ctx);
  recomputeCoreCount(ctx);

  repairOverstaffing(ctx);
  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);
  enforceCart3fMax(ctx);
  enforceCart2fMax(ctx);

  // target 재계산: CART2F 전환 후 실제 가용 인원 기준으로 갱신
  ctx.target = slotsMin.map((t, i) => {
    if (t < CONSTRAINTS.COVERAGE_START_MIN || t >= closeEndMin) return { exit: 0, elev: 0, f3: 0 };
    const avail = employees.filter(e => {
      if (!active[e.id][i]) return false;
      const st = schedule[e.id][i];
      return !isProtected(st) && st !== ST.OPEN_PREP && st !== ST.OFF
          && st !== ST.CART2F && st !== ST.CART3F;
    }).length;
    if (avail <= 0) return { exit: 0, elev: 0, f3: 0 };
    if (avail === 1) return { exit: 1, elev: 0, f3: 0 };
    if (avail === 2) return { exit: 1, elev: 1, f3: 0 };
    return { exit: 1, elev: 1, f3: 1 };
  });

  repairCoverage(ctx);
  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);

  // ── Step 7: 최종 강제 패스 ───────────────────────────────────
  // coreMax 초과 블록 강제 분할
  const LATE_F = CONSTRAINTS.CLOSE_LATE_MIN;
  for (const e of employees) {
    const row    = schedule[e.id];
    const actRow = active[e.id];
    let fi = 0;
    while (fi < row.length) {
      if (!actRow[fi]) { fi++; continue; }
      const fst = row[fi];
      if (!isCore(fst)) { fi++; continue; }
      const fbS = fi;
      while (fi < row.length && actRow[fi] && row[fi] === fst) fi++;
      const fbE        = fi;
      const isLateBlock = e.group === 'CLOSE' && slotsMin[fbE - 1] >= LATE_F;
      if (!isLateBlock && fbE - fbS > coreMaxSlots) {
        for (let j = fbS + coreMaxSlots; j < fbE; j++) row[j] = ST.CART2F;
      }
    }
  }

  repairCoverage(ctx);
  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);
  repairOverstaffing(ctx);

  forceDeficitSlots(ctx);
  recomputeCoreCount(ctx);
  rebalanceVariance(ctx);
  recomputeCoreCount(ctx);
  forceCoreExperience(ctx);
  recomputeCoreCount(ctx);

  applyPostMtgCoreSlot(ctx);
  repairCoverage(ctx);

  // ── Step 8: 검증 ─────────────────────────────────────────────
  const violations = validate(ctx);
  const stats      = computeStats(ctx);

  return { schedule, slots, slotsMin, employees, violations, stats };
}
