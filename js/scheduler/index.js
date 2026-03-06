/**
 * scheduler/index.js — 스케줄 생성 진입점 (재설계 v19)
 *
 * generateSchedule(input) → { schedule, slots, slotsMin, employees, violations, stats }
 *
 * 파이프라인 (5단계):
 *   Phase 1  고정 이벤트   회의 → MTG직후고정 → 식사 → 오픈준비 → 휴식
 *   Phase 2  초기 배정    커버리지 목표 → preAssign → 그리디
 *   Phase 3  수렴 수리    변화 없을 때까지 반복 (MAX 15회):
 *              postClean → repairCoverage → ensureCoreExperience
 *              → repairOverstaffing → balanceCoreRotation
 *   Phase 4  강제 패스    enforceCloseLate → forceDeficit → forceCoreExp → rebalance
 *   Phase 5  최종 정리    spreadRests → fillRemaining → validate
 *
 * 설계 원칙:
 *   - 수리 함수는 bool 반환 → 수렴 조건 판별
 *   - 동일 함수 반복 호출 제거, 수렴 루프 1개로 통합
 *   - 커버리지 목표는 루프 진입마다 재계산
 *
 * 의존성: 모든 scheduler/* 서브모듈
 */

import { ST, CONSTRAINTS, DEFAULTS } from '../constants.js';
import { parseTimeToMin, minToTime, buildSlots, minsToSlots, computeActiveMask, seededRng } from '../utils.js';
import { isCore, isProtected, makeCoverageTargets, stationCountsAt, computeCoverageDeficits } from './core.js';
import { applyMeetings, applyOpenMeals, applyMidMeals, applyCloseMeals, applyOpenPrep, applyEarlyCoreCoverage, applyRestBreaks, applyPostMtgFixedSlots, spreadSimultaneousRests } from './events.js';
import { buildPreAssign, assignBlocksGreedy } from './assign.js';
import { repairCoverage, ensureCoreExperience } from './repair.js';
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

  // ── 직원 정규화 ─────────────────────────────────────────────────
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

  // ── 스케줄 초기화 ───────────────────────────────────────────────
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
  const initTarget = makeCoverageTargets(slotsMin, closeEndMin, employees, active);

  const ctx = {
    slotsMin, slots, employees, schedule, active,
    target      : initTarget,
    coreMinSlots, coreMaxSlots, anyMinSlots,
    mealDurMin, meetingDurMin,
    mtg1Min      : parseTimeToMin(input.mtg1 || DEFAULTS.MTG1_TIME),
    mtg2Min      : parseTimeToMin(input.mtg2 || DEFAULTS.MTG2_TIME),
    openMeal1130 : Number(input.openMeal1130) || DEFAULTS.OPEN_MEAL_1130,
    openMeal1230 : Number(input.openMeal1230) || DEFAULTS.OPEN_MEAL_1230,
    closeMealMode: input.closeMealMode || DEFAULTS.CLOSE_MEAL_MODE,
    rng, preMap: null, coreCount: null,
  };

  // ── 커버리지 목표 계산기 ────────────────────────────────────────
  // 가용 인원(보호·준비·OFF·CART2F·CART3F 제외)에 따라 슬롯별 목표 결정
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

  // 공격적 목표: CART3F도 avail에 포함 (Phase 4 forceDeficit 전용)
  // CART3F는 파이프라인 내부 임시 스테이션으로 avail에 포함해 더 적극적 배정 유도
  const calcTargetAggressive = () => slotsMin.map((t, i) => {
    if (t < CONSTRAINTS.COVERAGE_START_MIN || t >= closeEndMin) return { exit: 0, elev: 0, f3: 0 };
    const avail = employees.filter(e => {
      if (!active[e.id][i]) return false;
      const st = schedule[e.id][i];
      return !isProtected(st) && st !== ST.OPEN_PREP && st !== ST.OFF && st !== ST.CART2F;
    }).length;
    if (avail <= 0) return { exit: 0, elev: 0, f3: 0 };
    if (avail === 1) return { exit: 1, elev: 0, f3: 0 };
    if (avail === 2) return { exit: 1, elev: 1, f3: 0 };
    return { exit: 1, elev: 1, f3: 1 };
  });

  // 파편 정리 + 제약 강제 (반복 사용 헬퍼)
  const postClean = () => {
    fixFragmentBlocks(ctx);
    mergeAdjacentCoreBlocks(ctx);
    enforceMaxBlockLength(ctx);
    enforceCart2fMax(ctx);
    enforceCart3fMax(ctx);
    // Fix-v20-1: enforceCart3fMax가 CART3F→CART2F 재변환 시 MAX_CART2F_SLOTS 초과분 재처리
    enforceCart2fMax(ctx);
  };

  // 현재 위반 수 (커버리지 결핍 + 코어 미경험)
  const countViolations = () => {
    const defs = computeCoverageDeficits(schedule, employees, active, slotsMin, ctx.target);
    const missing = employees.filter(e => {
      const row = schedule[e.id], act = active[e.id];
      return !row.some((s, i) => act[i] && s === ST.EXIT)
          || !row.some((s, i) => act[i] && s === ST.ELEV)
          || !row.some((s, i) => act[i] && s === ST.F3);
    }).length;
    return defs.length + missing;
  };

  // ── Phase 1: 고정 이벤트 ───────────────────────────────────────
  applyMeetings(ctx);
  applyPostMtgFixedSlots(ctx);
  applyOpenMeals(ctx);
  applyMidMeals(ctx);
  applyCloseMeals(ctx);
  applyOpenPrep(ctx);

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

  // ── Phase 2: 초기 배정 ────────────────────────────────────────
  ctx.target = calcTarget();
  const { preMap, coreCount } = buildPreAssign(ctx);
  ctx.preMap    = preMap;
  ctx.coreCount = coreCount;
  assignBlocksGreedy(ctx);

  // ── Phase 3: 수렴 수리 루프 ──────────────────────────────────
  // 각 반복에서 수리 함수가 하나라도 변화를 일으키면 계속,
  // 모든 함수가 변화 없으면(또는 위반 수 0) 강제 패스로 진행
  let prevViolations = Infinity;

  for (let pass = 0; pass < 15; pass++) {
    postClean();
    ctx.target = calcTarget();

    let changed = false;
    if (repairCoverage(ctx))         changed = true;
    // v24: 커버리지 결핍이 있는 동안은 ensureCoreExperience 건너뜀
    // — 코어미경험 수리가 coverage를 깨뜨리는 부작용을 줄여 coverage 우선 수렴
    const stillHasDefs = computeCoverageDeficits(schedule, employees, active, slotsMin, ctx.target).length > 0;
    if (!stillHasDefs && ensureCoreExperience(ctx)) changed = true;
    if (repairOverstaffing(ctx))     changed = true;
    if (balanceCoreRotation(ctx))    changed = true;
    recomputeCoreCount(ctx);

    const v = countViolations();
    if (v === 0)              break;  // 완전 해소
    if (!changed)             break;  // 개선 불가 → 강제 패스로
    if (v >= prevViolations)  break;  // 진전 없음 → 강제 패스로
    prevViolations = v;
  }

  // ── Phase 4: 강제 패스 ───────────────────────────────────────
  enforceCloseLateAssignment(ctx);
  postClean();

  // 공격적 목표로 커버리지 강제 달성
  ctx.target = calcTargetAggressive();
  forceDeficitSlots(ctx);
  recomputeCoreCount(ctx);

  // 코어 미경험 강제 해소 + 로테이션 균형화
  forceCoreExperience(ctx);
  rebalanceVariance(ctx);

  // 강제 패스 후 부작용 수리
  ctx.target = calcTarget();
  repairCoverage(ctx);
  repairOverstaffing(ctx);
  postClean();
  recomputeCoreCount(ctx);

  // ── Phase 5: 최종 정리 ───────────────────────────────────────
  // Bug Fix: 순서 교체 — applyPostMtgFixedSlots를 먼저 호출해 s1(CART2F)·restSlotIdx(REST)를
  // 재고정한 뒤 spreadSimultaneousRests로 동시 REST를 분산한다.
  // (기존 역순: spread가 s3 REST를 이동 → s3이 ''로 클리어 → applyPostMtgFixedSlots가
  //  s3에 REST 재배치 → 이동 슬롯과 s3에 이중(4회) REST 발생)
  applyPostMtgFixedSlots(ctx);          // MTG직후 슬롯 재고정 (CART2F·REST 복원)
  spreadSimultaneousRests(ctx);         // 동시 휴식 분산 (재고정 완료 후 적용)
  ctx.target = calcTarget();

  repairCoverage(ctx);
  postClean();
  fillRemainingSlots(ctx);
  repairOverstaffing(ctx);
  repairCoverage(ctx);
  enforceMaxBlockLength(ctx);
  enforceCart2fMax(ctx);
  enforceCart3fMax(ctx);
  // Fix-v20-1: enforceCart3fMax 이후 CART2F 초과분 재처리
  enforceCart2fMax(ctx);
  // Fix-v20-5: Fix2(lastExp 보호) 이후 인접 슬롯 커버리지 누락 보완
  repairCoverage(ctx);
  recomputeCoreCount(ctx);

  // ── v23: 잉여 자원 = 모두 2F카트내림 최종 변환 ──────────────
  // 파이프라인 내부에서는 CART3F를 임시 스테이징 영역으로 사용하지만,
  // 최종 스케줄에서는 잉여 자원을 모두 2F카트내림(CART2F)으로 표시.
  for (const e of employees) {
    const row = schedule[e.id], actRow = active[e.id];
    for (let i = 0; i < row.length; i++) {
      if (actRow[i] && row[i] === ST.CART3F) row[i] = ST.CART2F;
    }
  }

  // ── v24: 최종 커버리지 1슬롯 패스 ──────────────────────────
  // CART3F→CART2F 변환 후에도 남은 커버리지 결핍을 1슬롯 강제 배정으로 해소.
  // fixFragmentBlocks 없이 직접 배정 → 1슬롯 보호 (v24 fixFragmentBlocks 개선과 쌍).
  ctx.target = calcTargetAggressive();
  forceDeficitSlots(ctx);

  // Fix-v25-2: validate 직전 target을 calcTarget()으로 재계산
  // calcTargetAggressive()가 세팅된 채로 validate가 실행되면 향후 CART3F 부활 시
  // 잘못된 target 기준으로 검증하는 위험을 방어.
  // (CART3F→CART2F 변환 완료 후에는 결과가 동일하나 명시적 재계산으로 안전성 확보)
  ctx.target = calcTarget();

  // ── Phase 6: 검증 ────────────────────────────────────────────
  const violations = validate(ctx);
  const stats      = computeStats(ctx);

  return { schedule, slots, slotsMin, employees, violations, stats };
}
