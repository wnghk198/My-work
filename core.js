/**
 * scheduler/index.js — 스케줄 생성 진입점
 *
 * generateSchedule(input) → { schedule, slots, slotsMin, employees, violations, stats }
 *
 * 파이프라인:
 *   Step 1  고정 이벤트   회의 → MTG직후고정 → 전원식사(오픈·중간·마감) → 오픈준비
 *   Step 2  preAssign    60분 블록 단위 코어 사전 계획
 *   Step 3  휴식 배치    오픈준비 임시해제 → 휴식 → 오픈준비 복원 → 초기코어커버리지
 *   Step 4  그리디 배정
 *   Step 5  수리 1차     커버리지 + 코어미경험
 *   Step 6  후처리       Cart제한 → 균형화 → ensureCore → 초과수리 → 커버리지
 *   Step 7  강제 패스    forceDeficit → rebalance → forceCoreExp → 최종정리
 *   Step 8  검증
 *
 * 규칙:
 *   - 식사는 근무 시간 외: endMin = startMin + hours*60 + mealDurMin (전 직군)
 *   - 마감조 21:30 이후: 코어·CART2F 블록 길이 제한 없음
 *   - 초과 배정 = 즉시 취소 (coreMin 보호 없음), 나중 출근자 블록과 맞물림
 *
 * 의존성: 모든 scheduler/* 서브모듈
 */

import { ST, CONSTRAINTS, DEFAULTS } from '../constants.js';
import { parseTimeToMin, minToTime, buildSlots, minsToSlots, computeActiveMask, buildWorkBlocks, seededRng } from '../utils.js';
import { isCore, isProtected, makeCoverageTargets, stationCountsAt } from './core.js';
import { applyMeetings, applyOpenMeals, applyMidMeals, applyCloseMeals, applyOpenPrep, applyEarlyCoreCoverage, applyRestBreaks, applyPostMtgFixedSlots } from './events.js';
import { buildPreAssign, assignBlocksGreedy } from './assign.js';
import { repairCoverage, repairMissingCoreExperience, ensureCoreExperience } from './repair.js';
import { balanceCoreRotation, repairOverstaffing, enforceCart2fMax, enforceCart3fMax, enforceCloseLateAssignment, fixFragmentBlocks, fillRemainingSlots, mergeAdjacentCoreBlocks, enforceMaxBlockLength } from './balance.js';
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
  // 식사는 근무 시간 외 → 전 직군 endMin에 mealDurMin 추가
  const seenIds = new Set();
  const employees = (input.employees || []).map((e, idx) => {
    let id = e?.id ? String(e.id) : `E${idx + 1}`;
    if (seenIds.has(id)) { let k = 2; while (seenIds.has(`${id}_${k}`)) k++; id = `${id}_${k}`; }
    seenIds.add(id);
    const group    = ['OPEN','MID','CLOSE'].includes(String(e?.group || 'MID').toUpperCase())
      ? String(e.group).toUpperCase() : 'MID';
    const hours    = Number(e?.hours) === 6 ? 6 : 8;
    const startMin = parseTimeToMin(e?.start || '08:00');
    const endMin   = startMin + hours * 60 + mealDurMin;
    return { ...e, id, group, hours, startMin, endMin, idx };
  });

  // ── 스케줄 초기화 ────────────────────────────────────────────
  const nSlots   = slotsMin.length;
  const schedule = {};
  for (const e of employees) schedule[e.id] = new Array(nSlots).fill('');
  const active = computeActiveMask(employees, slotsMin);
  for (const e of employees)
    for (let i = 0; i < nSlots; i++)
      if (!active[e.id][i]) schedule[e.id][i] = ST.OFF;

  const closeEmps   = employees.filter(e => e.group === 'CLOSE');
  const closeEndMin = closeEmps.length > 0
    ? Math.max(...closeEmps.map(e => e.endMin)) : dayEndMin;
  const target = makeCoverageTargets(slotsMin, closeEndMin, employees, active);

  const ctx = {
    slotsMin, slots, employees, schedule, active, target,
    coreMinSlots, coreMaxSlots, anyMinSlots,
    mealDurMin, meetingDurMin,
    mtg1Min      : parseTimeToMin(input.mtg1 || DEFAULTS.MTG1_TIME),
    mtg2Min      : parseTimeToMin(input.mtg2 || DEFAULTS.MTG2_TIME),
    openMeal1130 : Number(input.openMeal1130) || DEFAULTS.OPEN_MEAL_1130,
    openMeal1230 : Number(input.openMeal1230) || DEFAULTS.OPEN_MEAL_1230,
    closeMealMode: input.closeMealMode || DEFAULTS.CLOSE_MEAL_MODE,
    rng, preMap: null, coreCount: null,
  };

  // ── Step 1: 고정 이벤트 (식사·휴식 최우선) ───────────────────
  applyMeetings(ctx);
  applyPostMtgFixedSlots(ctx);  // 마감조 MTG 직후: 2F카트 → 1차 휴식
  applyOpenMeals(ctx);
  applyMidMeals(ctx);
  applyCloseMeals(ctx);
  applyOpenPrep(ctx);

  // ── Step 2: preAssign ────────────────────────────────────────
  const { preMap, coreCount } = buildPreAssign(ctx);
  ctx.preMap    = preMap;
  ctx.coreCount = coreCount;

  // ── Step 3: 휴식 배치 ────────────────────────────────────────
  // 오픈준비 임시 해제 → 휴식 배치 → 오픈준비 복원 → 초기 코어
  for (const e of employees) {
    if (e.group !== 'OPEN') continue;
    const limit = parseTimeToMin('10:30');
    for (let i = 0; i < nSlots; i++) {
      if (!active[e.id][i]) continue;   // 비활성 슬롯은 건너뜀 (break 아님)
      if (slotsMin[i] >= limit) break;   // 10:30 이후는 종료
      if (schedule[e.id][i] === ST.OPEN_PREP) schedule[e.id][i] = '';
    }
  }
  applyRestBreaks(ctx);
  applyOpenPrep(ctx);
  applyEarlyCoreCoverage(ctx);

  // 고정이벤트·휴식 반영 후 가용 인원 기준으로 커버리지 목표 재계산
  const calcTarget = () => slotsMin.map((t, i) => {
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
  ctx.target = calcTarget();

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

  // ensureCoreExperience: 변화 없을 때까지 최대 3회
  for (let pass = 0; pass < 3; pass++) {
    const countMissing = () => employees.filter(e => {
      const bl = buildWorkBlocks(schedule[e.id], active[e.id]);
      return !bl.some(b => b.st === ST.EXIT)
          || !bl.some(b => b.st === ST.ELEV)
          || !bl.some(b => b.st === ST.F3);
    }).length;
    const before = countMissing();
    ensureCoreExperience(ctx);
    fixFragmentBlocks(ctx);
    mergeAdjacentCoreBlocks(ctx);
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

  ctx.target = calcTarget();
  repairCoverage(ctx);
  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);

  // ── Step 7: 강제 패스 ────────────────────────────────────────
  enforceMaxBlockLength(ctx);

  repairCoverage(ctx);
  fixFragmentBlocks(ctx);
  mergeAdjacentCoreBlocks(ctx);
  enforceCart2fMax(ctx);
  repairOverstaffing(ctx);

  forceDeficitSlots(ctx);
  recomputeCoreCount(ctx);
  rebalanceVariance(ctx);
  recomputeCoreCount(ctx);

  forceCoreExperience(ctx);
  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);
  ensureCoreExperience(ctx);
  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);
  mergeAdjacentCoreBlocks(ctx);
  recomputeCoreCount(ctx);

  applyPostMtgFixedSlots(ctx);  // 수리 패스 후 MTG직후 슬롯 재적용
  repairCoverage(ctx);

  // 최종 정리: 짧은 코어 블록 제거 (최대 4회 반복)
  for (let fin = 0; fin < 4; fin++) {
    fixFragmentBlocks(ctx);
    enforceCart2fMax(ctx);
    enforceCart3fMax(ctx);
    repairCoverage(ctx);
    recomputeCoreCount(ctx);
    const stillShort = employees.some(e => {
      const row = schedule[e.id], actRow = active[e.id];
      let i = 0;
      while (i < row.length) {
        if (!actRow[i]) { i++; continue; }
        const st = row[i];
        if (!isCore(st)) { i++; continue; }
        const bS = i;
        while (i < row.length && actRow[i] && row[i] === st) i++;
        const isLate = e.group === 'CLOSE' && slotsMin[i - 1] >= CONSTRAINTS.CLOSE_LATE_MIN;
        if (!isLate && i - bS < coreMinSlots) return true;
      }
      return false;
    });
    if (!stillShort) break;
  }

  // coreMin 미달 블록 최종 강제 처리 (인접 블록 흡수 → 불가시 CART2F)
  for (const e of employees) {
    const row = schedule[e.id], actRow = active[e.id];
    let i = 0;
    while (i < row.length) {
      if (!actRow[i]) { i++; continue; }
      const st = row[i];
      if (!isCore(st)) { i++; continue; }
      const bS = i;
      while (i < row.length && actRow[i] && row[i] === st) i++;
      const bE     = i;
      const isLate = e.group === 'CLOSE' && slotsMin[bE - 1] >= CONSTRAINTS.CLOSE_LATE_MIN;
      if (isLate || bE - bS >= coreMinSlots) continue;
      const prevSt  = bS > 0 && actRow[bS - 1] ? row[bS - 1] : null;
      const nextSt  = bE < row.length && actRow[bE] ? row[bE] : null;
      let prevLen = 0; if (prevSt && isCore(prevSt)) { let k = bS - 1; while (k >= 0 && actRow[k] && row[k] === prevSt) { prevLen++; k--; } }
      let nextLen = 0; if (nextSt && isCore(nextSt)) { let k = bE; while (k < row.length && actRow[k] && row[k] === nextSt) { nextLen++; k++; } }
      if (prevSt && isCore(prevSt) && prevLen + (bE - bS) <= coreMaxSlots)
        { for (let j = bS; j < bE; j++) row[j] = prevSt; }
      else if (nextSt && isCore(nextSt) && nextLen + (bE - bS) <= coreMaxSlots)
        { for (let j = bS; j < bE; j++) row[j] = nextSt; }
      else
        { for (let j = bS; j < bE; j++) row[j] = ST.CART2F; }
    }
  }

  enforceMaxBlockLength(ctx);
  enforceCart2fMax(ctx);
  enforceCart3fMax(ctx);

  // 2차 FCE: 파이프라인 후반 변화로 해결 가능해진 코어미경험 처리
  forceCoreExperience(ctx);
  fixFragmentBlocks(ctx);
  enforceCart2fMax(ctx);
  ensureCoreExperience(ctx);
  repairCoverage(ctx);
  enforceCart3fMax(ctx);
  enforceMaxBlockLength(ctx);
  enforceCart2fMax(ctx);

  // ── Step 8: 검증 ─────────────────────────────────────────────
  const violations = validate(ctx);
  const stats      = computeStats(ctx);

  return { schedule, slots, slotsMin, employees, violations, stats };
}
