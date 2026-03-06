/**
 * scheduler/core.js — 스케줄링 핵심 헬퍼
 *
 * 스테이션 분류, 슬롯별 배치 카운트, 커버리지 목표·결핍 계산,
 * 공정성 비용, 블록 재색칠 등 알고리즘 전반에서 공유하는 함수들.
 *
 * 의존성: constants.js, utils.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { minToTime } from '../utils.js';

// ── 스테이션 분류 ───────────────────────────────────────────────

/** EXIT / ELEV / F3 여부 */
export function isCore(st) {
  return st === ST.EXIT || st === ST.ELEV || st === ST.F3;
}

/** REST / MEAL / MTG (보호 슬롯) 여부 */
export function isProtected(st) {
  return st === ST.REST || st === ST.MEAL || st === ST.MTG;
}

/**
 * dynMax(st, activeCount) — 스테이션별 동적 최대 동시 배치 인원
 *
 * 활성 직원 수를 3개 코어 스테이션에 고르게 분배하는 상한값.
 * 공식: ceil(activeCount / 3), 단 각 스테이션의 물리적 상한(MAX_*)을 초과하지 않음.
 *
 *   activeCount=3  → EXIT=1, ELEV=1, F3=1
 *   activeCount=6  → EXIT=1, ELEV=1, F3=2
 *   activeCount=9  → EXIT=1, ELEV=1, F3=3
 */
export function dynMax(st, activeCount) {
  const share = Math.max(1, Math.ceil(activeCount / 3));
  if (st === ST.EXIT) return Math.min(CONSTRAINTS.MAX_EXIT, share);
  if (st === ST.ELEV) return Math.min(CONSTRAINTS.MAX_ELEV, share);
  if (st === ST.F3)   return Math.min(CONSTRAINTS.MAX_F3,   share);
  return 0;
}

/**
 * dynMaxAt(st, si, employees, active) — 슬롯 인덱스 기준 dynMax
 * 슬롯별 실제 활성 인원을 직접 계산해 dynMax에 전달합니다.
 */
export function dynMaxAt(st, si, employees, active) {
  const count = employees.filter(e => active[e.id][si]).length;
  return dynMax(st, count);
}

// ── 커버리지 목표 ────────────────────────────────────────────────

/**
 * 슬롯별 코어 커버리지 목표 배열 생성
 * 가용 직원 수에 따라 요구치 자동 축소
 */
export function makeCoverageTargets(slotsMin, closeEndMin, employees, active) {
  const start = CONSTRAINTS.COVERAGE_START_MIN;
  const end   = closeEndMin || (slotsMin[slotsMin.length - 1] + 15);
  return slotsMin.map((t, i) => {
    if (t < start || t >= end) return { exit: 0, elev: 0, f3: 0 };
    if (employees && active) {
      const activeCount = employees.filter(e => active[e.id] && active[e.id][i]).length;
      if (activeCount < 3) return {
        exit: Math.min(1, activeCount > 0 ? 1 : 0),
        elev: Math.min(1, activeCount > 1 ? 1 : 0),
        f3:   Math.min(1, activeCount > 2 ? 1 : 0),
      };
    }
    return { exit: 1, elev: 1, f3: 1 };
  });
}

// ── 슬롯별 카운트 ────────────────────────────────────────────────

/**
 * 특정 슬롯 인덱스에서 각 스테이션 배치 인원 수 반환
 * @returns {{ exit, elev, f3, cart2f, cart3f }}
 */
export function stationCountsAt(schedule, employees, active, tIdx) {
  let exit = 0, elev = 0, f3 = 0, cart2f = 0, cart3f = 0;
  for (const e of employees) {
    if (!active[e.id][tIdx]) continue;
    const st = schedule[e.id][tIdx];
    if      (st === ST.EXIT)   exit++;
    else if (st === ST.ELEV)   elev++;
    else if (st === ST.F3)     f3++;
    else if (st === ST.CART2F) cart2f++;
    else if (st === ST.CART3F) cart3f++;
  }
  return { exit, elev, f3, cart2f, cart3f };
}

// ── 커버리지 결핍 ────────────────────────────────────────────────

/**
 * 목표 대비 결핍 슬롯 목록 반환
 * @returns {{ idx, time, exit, elev, f3 }[]}
 */
export function computeCoverageDeficits(schedule, employees, active, slotsMin, target) {
  const d = [];
  for (let i = 0; i < slotsMin.length; i++) {
    const t = target[i];
    if (!t || (t.exit === 0 && t.elev === 0 && t.f3 === 0)) continue;
    const c  = stationCountsAt(schedule, employees, active, i);
    const dd = {
      idx:  i,
      time: minToTime(slotsMin[i]),
      exit: Math.max(0, t.exit - c.exit),
      elev: Math.max(0, t.elev - c.elev),
      f3:   Math.max(0, t.f3   - c.f3),
    };
    if (dd.exit > 0 || dd.elev > 0 || dd.f3 > 0) d.push(dd);
  }
  return d;
}

// ── 공정성 비용 ─────────────────────────────────────────────────

/**
 * 특정 직원에게 targetSt를 배정했을 때의 코어 분배 불균형 비용
 * (값이 낮을수록 해당 직원에게 배정이 공정함)
 */
export function getFairnessCost(coreCount, empId, targetSt) {
  if (!coreCount?.[empId]) return 0;
  const c   = coreCount[empId];
  const key = targetSt === ST.EXIT ? 'EXIT' : targetSt === ST.ELEV ? 'ELEV' : 'F3';
  const total = c.EXIT + c.ELEV + c.F3 + 1;
  const exp   = total / 3;
  const a = { EXIT: c.EXIT, ELEV: c.ELEV, F3: c.F3, [key]: c[key] + 1 };
  return Math.pow(a.EXIT - exp, 2) + Math.pow(a.ELEV - exp, 2) + Math.pow(a.F3 - exp, 2);
}

// ── 블록 재색칠 ─────────────────────────────────────────────────

/**
 * empId의 tIdx 슬롯(및 인접 블록)을 targetSt로 변경.
 * coreMax·MAX 제약을 준수하며, 실패 시 false 반환.
 */
export function recolorBlock(ctx, empId, tIdx, targetSt) {
  const { schedule, active, slotsMin, coreMinSlots, coreMaxSlots } = ctx;
  const row    = schedule[empId];
  const actRow = active[empId];

  // 마감 야간 면제: 마감조 직원의 21:30 이후 슬롯만 적용
  const emp = ctx.employees?.find(e => e.id === empId);
  if (emp?.group === 'CLOSE' && slotsMin[tIdx] >= CONSTRAINTS.CLOSE_LATE_MIN) {
    row[tIdx] = targetSt; return true;
  }

  function existingRunOf(st, from, dir) {
    let n = 0, i = from;
    while (i >= 0 && i < row.length) {
      if (!actRow[i]) break;
      if (row[i] === st) n++; else break;
      i += dir;
    }
    return n;
  }

  const curSt = row[tIdx];
  let bS = tIdx, bE = tIdx + 1;
  if (curSt !== '' && curSt !== ST.OFF) {
    while (bS > 0 && actRow[bS - 1] && row[bS - 1] === curSt) bS--;
    while (bE < row.length && actRow[bE] && row[bE] === curSt) bE++;
  }
  const blockLen   = bE - bS;
  const beforeRun  = existingRunOf(targetSt, bS - 1, -1);
  // Bug Fix 11: afterRun(블록 뒤쪽 인접 targetSt 연속 길이)도 포함해야 함
  // 미포함 시: beforeRun=3, replaceCount=2, afterRun=2 → 총 7슬롯으로 coreMax 초과 가능
  const afterRun   = existingRunOf(targetSt, bE, +1);
  const maxNew     = Math.max(0, coreMaxSlots - beforeRun - afterRun);
  if (maxNew === 0) return false;

  const replaceCount = Math.min(blockLen, maxNew);
  const _maxOkAt = (si) => {
    if (row[si] === targetSt) return true;
    const cc = stationCountsAt(schedule, ctx.employees, active, si);
    if (targetSt === ST.EXIT  && cc.exit  >= dynMax(ST.EXIT,  ctx.employees.filter(e=>active[e.id][si]).length))  return false;
    if (targetSt === ST.ELEV  && cc.elev  >= dynMax(ST.ELEV,  ctx.employees.filter(e=>active[e.id][si]).length))  return false;
    if (targetSt === ST.F3    && cc.f3    >= dynMax(ST.F3,    ctx.employees.filter(e=>active[e.id][si]).length))  return false;
    return true;
  };

  if (blockLen >= coreMinSlots || replaceCount >= coreMinSlots) {
    let repS = Math.max(bS, tIdx - Math.floor(replaceCount / 2));
    let repE = Math.min(bE, repS + replaceCount);
    repS = Math.max(bS, repE - replaceCount);
    let winOk = true;
    for (let i = repS; i < repE; i++) { if (!_maxOkAt(i)) { winOk = false; break; } }
    if (!winOk) {
      let found = -1;
      const win = Math.min(replaceCount, bE - bS);
      for (let ws = bS; ws + win <= bE; ws++) {
        let ok = true;
        for (let j = ws; j < ws + win; j++) { if (!_maxOkAt(j)) { ok = false; break; } }
        if (ok) { found = ws; break; }
      }
      if (found >= 0) {
        for (let i = found; i < found + Math.min(replaceCount, bE - found); i++) row[i] = targetSt;
        return true;
      }
    } else {
      for (let i = repS; i < repE; i++) row[i] = targetSt;
      return true;
    }
  }

  // 확장 시도
  let eS = bS, eE = bS + replaceCount, need = coreMinSlots - replaceCount;
  let ext = eE;
  while (need > 0 && ext < row.length) {
    if (!actRow[ext]) break;
    const s = row[ext];
    if (isProtected(s) || s === ST.OFF || s === ST.OPEN_PREP) break;
    if (beforeRun + (eE - bS) + afterRun + 1 > coreMaxSlots) break;
    if (!_maxOkAt(ext)) break;
    eE++; ext++; need--;
  }
  if (eE - eS < coreMinSlots) {
    let pre = eS - 1; let need2 = coreMinSlots - (eE - eS);
    while (need2 > 0 && pre >= 0) {
      if (!actRow[pre]) break;
      const s = row[pre];
      if (isProtected(s) || s === ST.OFF || s === ST.OPEN_PREP) break;
      if (!_maxOkAt(pre)) break;
      eS = pre; pre--; need2--;
    }
  }
  if (eE - eS >= coreMinSlots) { for (let i = eS; i < eE; i++) row[i] = targetSt; return true; }

  // 마감조 안전회의 직후 1슬롯 예외
  if (emp?.group === 'CLOSE' && eE - eS === 1 && eS > 0 && row[eS - 1] === ST.MTG) {
    row[eS] = targetSt; return true;
  }
  return false;
}
