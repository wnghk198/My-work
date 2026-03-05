/**
 * scheduler/validate.js — 검증 & 통계
 *
 * validate         — 블록길이·코어미경험·휴식·커버리지·초과 위반 목록 반환
 * recomputeCoreCount — ctx.coreCount 갱신 (수리 패스 사이 재계산)
 * computeStats     — 커버리지 결핍·코어 분산 통계 반환
 *
 * 의존성: constants.js, utils.js, scheduler/core.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { parseTimeToMin, minToTime, buildWorkBlocks } from '../utils.js';
import { isCore, stationCountsAt, computeCoverageDeficits } from './core.js';

export function validate(ctx) {
  const { schedule, employees, active, slotsMin, target, coreMinSlots, coreMaxSlots } = ctx;
  const v   = [];
  const add = (type, detail) => v.push({ type, detail });

  for (const e of employees) {
    const row    = schedule[e.id];
    const actRow = active[e.id];
    let eS = -1, eE = -1;
    for (let i = 0; i < row.length; i++) { if (actRow[i]) { if (eS < 0) eS = i; eE = i + 1; } }
    if (eS < 0) continue;

    const blocks  = buildWorkBlocks(row, actRow);
    const isClose = e.group === 'CLOSE';

    for (const b of blocks) {
      if (b.st === ST.REST || b.st === ST.MEAL || b.st === ST.MTG || b.st === ST.OPEN_PREP) continue;
      const len    = b.end - b.start;
      const isLate = isClose && slotsMin[b.end - 1] >= CONSTRAINTS.CLOSE_LATE_MIN;
      if (isLate) continue;

      // 모든 코어 블록은 coreMinSlots 이상이어야 함 (예외 없음)
      if (isCore(b.st) && len < coreMinSlots)
        add('블록길이', `${e.name} ${minToTime(slotsMin[b.start])} ${b.st} ${len * 15}분 < 최소 ${coreMinSlots * 15}분`);
      if (isCore(b.st) && len > coreMaxSlots)
        add('블록길이', `${e.name} ${minToTime(slotsMin[b.start])} ${b.st} ${len * 15}분 > 최대 ${coreMaxSlots * 15}분`);
      if (b.st === ST.CART2F && len > CONSTRAINTS.MAX_CART2F_SLOTS)
        add('2F카트', `${e.name} 2F카트 ${len * 15}분 > 최대 30분`);
    }

    const hasExit = blocks.some(b => b.st === ST.EXIT);
    const hasElev = blocks.some(b => b.st === ST.ELEV);
    const hasF3   = blocks.some(b => b.st === ST.F3);
    const ms = [];
    if (!hasExit) ms.push('2F출차');
    if (!hasElev) ms.push('2F엘베');
    if (!hasF3)   ms.push('3F');
    if (ms.length) add('코어미경험', `${e.name}: ${ms.join(', ')}`);

    const rests = [];
    for (let i = eS; i < eE; i++) { if (actRow[i] && row[i] === ST.REST) rests.push(i); }
    if (!rests.some(i => i < eS + Math.ceil(90 / 15)))  add('휴식', `${e.name} 1차 휴식 미배치`);
    if (!rests.some(i => i >= eE - Math.ceil(90 / 15))) add('휴식', `${e.name} 3차 휴식 미배치`);
    if (e.hours === 8 && rests.length < 3)               add('휴식', `${e.name} 2차 휴식 미배치`);
  }

  for (let i = 0; i < slotsMin.length; i++) {
    const t = target[i];
    if (!t || (t.exit === 0 && t.elev === 0 && t.f3 === 0)) continue;
    const c = stationCountsAt(schedule, employees, active, i);
    if (c.exit < t.exit) add('커버리지', `출차 미배치: ${minToTime(slotsMin[i])}`);
    if (c.elev < t.elev) add('커버리지', `엘베 미배치: ${minToTime(slotsMin[i])}`);
    if (c.f3   < t.f3)   add('커버리지', `3F 미배치: ${minToTime(slotsMin[i])}`);
  }

  for (let i = 0; i < slotsMin.length; i++) {
    const c = stationCountsAt(schedule, employees, active, i);
    if (c.exit   > CONSTRAINTS.MAX_EXIT)   add('초과', `출차초과: ${minToTime(slotsMin[i])} ${c.exit}명`);
    if (c.elev   > CONSTRAINTS.MAX_ELEV)   add('초과', `엘베초과: ${minToTime(slotsMin[i])} ${c.elev}명`);
    if (c.cart3f > CONSTRAINTS.MAX_CART3F) add('초과', `3F카트초과: ${minToTime(slotsMin[i])} ${c.cart3f}명`);
  }

  return v;
}

export function recomputeCoreCount(ctx) {
  const { schedule, employees, active, slotsMin } = ctx;
  const cc = {};
  for (const e of employees) {
    cc[e.id] = { EXIT: 0, ELEV: 0, F3: 0 };
    for (let i = 0; i < slotsMin.length; i++) {
      if (!active[e.id][i]) continue;
      const st = schedule[e.id][i];
      if      (st === ST.EXIT) cc[e.id].EXIT++;
      else if (st === ST.ELEV) cc[e.id].ELEV++;
      else if (st === ST.F3)   cc[e.id].F3++;
    }
  }
  ctx.coreCount = cc;
}

export function computeStats(ctx) {
  const { schedule, employees, active } = ctx;
  const cc = {};
  for (const e of employees) {
    cc[e.id] = { EXIT: 0, ELEV: 0, F3: 0, total: 0 };
    for (let i = 0; i < schedule[e.id].length; i++) {
      if (!active[e.id][i]) continue;
      const st = schedule[e.id][i];
      if      (st === ST.EXIT) { cc[e.id].EXIT++;  cc[e.id].total++; }
      else if (st === ST.ELEV) { cc[e.id].ELEV++;  cc[e.id].total++; }
      else if (st === ST.F3)   { cc[e.id].F3++;    cc[e.id].total++; }
    }
  }
  const cv = {};
  for (const [id, c] of Object.entries(cc)) {
    const avg = c.total / 3;
    cv[id] = {
      ...c, avg,
      variance: (Math.pow(c.EXIT - avg, 2) + Math.pow(c.ELEV - avg, 2) + Math.pow(c.F3 - avg, 2)) / 3,
    };
  }
  const defs = computeCoverageDeficits(ctx.schedule, ctx.employees, ctx.active, ctx.slotsMin, ctx.target);
  const vars = Object.values(cv).map(v => v.variance);
  return {
    coreCounts    : cc,
    coreVariance  : cv,
    totalDeficits : defs.length,
    deficits      : defs,
    maxVariance   : Math.max(0, ...vars),
    avgVariance   : vars.reduce((s, v) => s + v, 0) / Math.max(1, vars.length),
  };
}
