/**
 * scheduler/assign.js — 사전 배정(preAssign) & 그리디 블록 배정
 *
 * buildPreAssign: 60분 블록 단위로 코어 스테이션 사전 계획
 * assignBlocksGreedy: 스코어 기반 그리디로 모든 빈 블록 배정
 *
 * 의존성: constants.js, utils.js, scheduler/core.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { buildBlockPattern } from '../utils.js';
import { isCore, isProtected, stationCountsAt, dynMax, dynMaxAt } from './core.js';

// ── preAssign ────────────────────────────────────────────────────

/**
 * 60분(4슬롯) 단위 블록을 순회하며 코어 스테이션 사전 배정 맵 생성.
 * 직원 간 균형을 맞추기 위해 코어 카운트가 적은 직원을 우선 선택.
 * @returns {{ preMap, coreCount }}
 */
export function buildPreAssign(ctx) {
  const { employees, active, slotsMin, rng, schedule, coreMinSlots, coreMaxSlots } = ctx;
  const BLOCK_SLOTS = 4;
  const CV_START    = CONSTRAINTS.COVERAGE_START_MIN;

  const preMap    = {};
  const coreCount = {};
  // 직원별 다음 배정 희망 코어 (EXIT→ELEV→F3→EXIT 순환)
  const nextDesired = {};
  // 직원별 직전 블록 배정 코어 (연속 동일 코어 억제)
  const lastAssigned = {};
  const CORE_CYCLE = { EXIT: 'ELEV', ELEV: 'F3', F3: 'EXIT' };

  for (const e of employees) {
    preMap[e.id]       = new Array(slotsMin.length).fill(null);
    coreCount[e.id]    = { EXIT: 0, ELEV: 0, F3: 0 };
    nextDesired[e.id]  = null;
    lastAssigned[e.id] = null;
  }

  const nBlocks = Math.ceil(slotsMin.length / BLOCK_SLOTS);
  for (let b = 0; b < nBlocks; b++) {
    const sS  = b * BLOCK_SLOTS;
    const sE  = Math.min(sS + BLOCK_SLOTS, slotsMin.length);
    const mid = Math.floor((sS + sE) / 2);
    if (slotsMin[mid] < CV_START) continue;

    const avail = employees.filter(e => {
      if (!active[e.id][mid]) return false;
      let fc = 0;
      for (let i = sS; i < sE; i++) {
        if (!active[e.id][i]) continue;
        const st = schedule[e.id][i];
        if (st === '' || st === ST.OFF) fc++;
      }
      return fc >= coreMinSlots;
    });
    if (!avail.length) continue;

    const orders    = [['EXIT','ELEV','F3'],['ELEV','F3','EXIT'],['F3','EXIT','ELEV']];
    const coreOrder = orders[b % 3];
    const assigned  = new Set();

    for (const core of coreOrder) {
      const cands = avail.filter(e => !assigned.has(e.id));
      if (!cands.length) break;
      cands.sort((a, b2) => {
        // 1순위: 직원 개인 순환에서 이 코어가 '희망 다음 코어'인 경우 우선
        const aWant = nextDesired[a.id] === core ? -150 : 0;
        const bWant = nextDesired[b2.id] === core ? -150 : 0;
        // 2순위: 직전 블록에서 같은 코어를 했으면 억제
        const aLast = lastAssigned[a.id] === core ? 120 : 0;
        const bLast = lastAssigned[b2.id] === core ? 120 : 0;
        // 3순위: 해당 코어 누적 횟수 적은 직원 우선
        const d = (coreCount[a.id][core] + aWant + aLast) - (coreCount[b2.id][core] + bWant + bLast);
        if (d !== 0) return d;
        const ta = coreCount[a.id].EXIT + coreCount[a.id].ELEV + coreCount[a.id].F3;
        const tb = coreCount[b2.id].EXIT + coreCount[b2.id].ELEV + coreCount[b2.id].F3;
        return ta - tb;
      });
      const winner = cands[0];
      let marked   = 0;
      for (let i = sS; i < sE && marked < coreMinSlots; i++) {
        if (!active[winner.id][i]) continue;
        const st = schedule[winner.id][i];
        if (st === '' || st === ST.OFF) { preMap[winner.id][i] = core; marked++; }
      }
      if (marked > 0) {
        coreCount[winner.id][core]++;
        assigned.add(winner.id);
        // 개인 순환 업데이트
        lastAssigned[winner.id] = core;
        nextDesired[winner.id]  = CORE_CYCLE[core];
      }
    }
  }

  // 연속 블록 확장 (coreMin 미만 블록을 최소 길이까지 늘림)
  for (const e of employees) {
    const row = preMap[e.id];
    let i = 0;
    while (i < row.length) {
      if (row[i] !== null) {
        const core = row[i];
        const bS   = i;
        while (i < row.length && row[i] === core) i++;
        const len = i - bS;
        if (len < coreMinSlots) {
          let need = coreMinSlots - len;
          let ext  = i;
          while (need > 0 && ext < row.length) {
            if (!active[e.id][ext]) break;
            const st = schedule[e.id][ext];
            if (st !== '' && st !== ST.OFF) break;
            if (row[ext] !== null && row[ext] !== core) break;
            row[ext] = core; ext++; need--;
          }
          let pre = bS - 1;
          while (need > 0 && pre >= 0) {
            if (!active[e.id][pre]) break;
            const st = schedule[e.id][pre];
            if (st !== '' && st !== ST.OFF) break;
            if (row[pre] !== null && row[pre] !== core) break;
            row[pre] = core; pre--; need--;
          }
        }
        // coreMax 초과 잘라내기
        let len2 = 0;
        for (let k = bS; k < row.length; k++) {
          if (row[k] === core) len2++; else break;
          if (len2 > coreMaxSlots) row[k] = null;
        }
      } else {
        i++;
      }
    }
  }

  return { preMap, coreCount };
}

// ── 그리디 블록 배정 ─────────────────────────────────────────────

function buildBlockPlans(ctx) {
  const { schedule, employees, active, slotsMin, coreMinSlots, coreMaxSlots, anyMinSlots } = ctx;
  const plans = {};
  for (const e of employees) {
    plans[e.id] = [];
    const row    = schedule[e.id];
    const actRow = active[e.id];
    let i = 0;
    while (i < row.length) {
      if (actRow[i] && (row[i] === '' || row[i] === ST.OFF)) {
        const sS   = i;
        while (i < row.length && actRow[i] && (row[i] === '' || row[i] === ST.OFF)) i++;
        const L      = i - sS;
        const isLate = e.group === 'CLOSE' && slotsMin[sS] >= CONSTRAINTS.CLOSE_LATE_MIN;
        const minS   = isLate ? 1 : coreMinSlots;
        const maxS   = isLate ? L : coreMaxSlots;
        const pat    = buildBlockPattern(L, minS, maxS, anyMinSlots);
        let pos      = sS;
        for (const len of pat) { plans[e.id].push({ start: pos, end: pos + len }); pos += len; }
      } else {
        i++;
      }
    }
  }
  return plans;
}

function adjacentSameLen(row, actRow, blockStart, blockEnd, st) {
  let before = 0, after = 0;
  for (let i = blockStart - 1; i >= 0; i--) { if (!actRow[i]) break; if (row[i] === st) before++; else break; }
  for (let i = blockEnd; i < row.length; i++) { if (!actRow[i]) break; if (row[i] === st) after++;  else break; }
  return before + after;
}

function scoreStation(ctx, e, block, st, cvMap) {
  const { slotsMin, target, schedule, employees, active, preMap, coreMaxSlots } = ctx;
  const midSlot  = Math.floor((block.start + block.end) / 2);
  const blockLen = block.end - block.start;
  const row      = schedule[e.id];
  const actRow   = active[e.id];
  let score      = 0;

  if (isCore(st)) {
    const adjLen = adjacentSameLen(row, actRow, block.start, block.end, st);
    if (blockLen + adjLen > coreMaxSlots) score += 1000;
  }

  const preCore   = preMap?.[e.id]?.[midSlot];
  const preStName = preCore ? ST[preCore] || preCore : null;
  if (preStName && st === preStName)              score -= 200;
  else if (preCore && isCore(st) && st !== preStName) score += 100;

  const cnt = stationCountsAt(schedule, employees, active, midSlot);
  const tgt = target[midSlot] || { exit: 0, elev: 0, f3: 0 };

  // 동적 최대값: 해당 슬롯 활성 인원의 1/3 올림 (각 스테이션 물리 상한 내)
  const activeAtSlot = employees.filter(e2 => active[e2.id][midSlot]).length;

  if      (st === ST.EXIT)  { if (cnt.exit  < tgt.exit)  score -= 50;  else if (cnt.exit  >= dynMax(ST.EXIT, activeAtSlot))  score += 500; }
  else if (st === ST.ELEV)  { if (cnt.elev  < tgt.elev)  score -= 50;  else if (cnt.elev  >= dynMax(ST.ELEV, activeAtSlot))  score += 500; }
  else if (st === ST.F3)    { if (cnt.f3    < tgt.f3)    score -= 30;  else if (cnt.f3    >= dynMax(ST.F3,   activeAtSlot))  score += 400; }

  if (isCore(st) && cvMap) {
    const cv = cvMap[e.id];
    if (cv) {
      const key = st === ST.EXIT ? 'EXIT' : st === ST.ELEV ? 'ELEV' : 'F3';
      score += (cv[key] - cv.avg) * 80; // 로테이션 가중치 강화 (30→80)
    }
  }

  if (st === ST.CART2F || st === ST.CART3F) {
    const ok = cnt.exit >= tgt.exit && cnt.elev >= tgt.elev && cnt.f3 >= tgt.f3;
    if (!ok) score += 300;
  }

  return score;
}

function canAssign(ctx, e, block, st) {
  const { schedule, employees, active, coreMaxSlots } = ctx;
  if (st === ST.CART2F && (block.end - block.start) > CONSTRAINTS.MAX_CART2F_SLOTS) return false;

  if (isCore(st)) {
    const row    = schedule[e.id];
    const actRow = active[e.id];
    const postMtgExc = e.group === 'CLOSE'
      && (block.end - block.start) === 1
      && block.start > 0
      && row[block.start - 1] === ST.MTG;
    if (!postMtgExc) {
      let before = 0, k = block.start - 1;
      while (k >= 0 && actRow[k] && row[k] === st) { before++; k--; }
      let after = 0; k = block.end;
      while (k < row.length && actRow[k] && row[k] === st) { after++; k++; }
      if (before + (block.end - block.start) + after > coreMaxSlots) return false;
    }
  }

  for (let i = block.start; i < block.end; i++) {
    if (!active[e.id][i]) continue;
    const cnt = stationCountsAt(schedule, employees, active, i);
    if (st === ST.EXIT   && cnt.exit   >= dynMaxAt(ST.EXIT,  i, employees, active)) return false;
    if (st === ST.ELEV   && cnt.elev   >= dynMaxAt(ST.ELEV,  i, employees, active)) return false;
    if (st === ST.F3     && cnt.f3     >= dynMaxAt(ST.F3,    i, employees, active)) return false;
    if (st === ST.CART3F && cnt.cart3f >= CONSTRAINTS.MAX_CART3F) return false;
  }
  return true;
}

export function assignBlocksGreedy(ctx) {
  const { schedule, employees, active, slotsMin, preMap } = ctx;
  const plans     = buildBlockPlans(ctx);
  const cvMap     = {};
  const ASSIGNABLE = [ST.EXIT, ST.ELEV, ST.F3, ST.CART2F, ST.CART3F];

  for (const e of employees) cvMap[e.id] = { EXIT: 0, ELEV: 0, F3: 0, total: 0, avg: 0 };

  const allBlocks = [];
  for (const e of employees) for (const b of plans[e.id]) allBlocks.push({ e, block: b });
  allBlocks.sort((a, b) => a.block.start - b.block.start);

  for (const { e, block } of allBlocks) {
    const mid    = Math.floor((block.start + block.end) / 2);
    const isLate = e.group === 'CLOSE' && slotsMin[block.start] >= CONSTRAINTS.CLOSE_LATE_MIN;
    let cands    = isLate ? [ST.EXIT, ST.ELEV, ST.F3] : [...ASSIGNABLE];

    const preCore = preMap?.[e.id]?.[mid];
    if (preCore) {
      const stn = ST[preCore] || preCore;
      if (!isLate) cands = [stn, ...cands.filter(s => s !== stn)];
    }

    const scored = cands.map(st => ({ st, score: scoreStation(ctx, e, block, st, cvMap) }));
    scored.sort((a, b) => a.score - b.score);

    let chosen = null;
    for (const { st } of scored) { if (canAssign(ctx, e, block, st)) { chosen = st; break; } }
    if (!chosen) chosen = ST.CART3F;

    for (let i = block.start; i < block.end; i++) {
      if (!active[e.id][i]) continue;
      const cur = schedule[e.id][i];
      if (cur === '' || cur === ST.OFF) schedule[e.id][i] = chosen;
    }

    if (isCore(chosen)) {
      const key = chosen === ST.EXIT ? 'EXIT' : chosen === ST.ELEV ? 'ELEV' : 'F3';
      cvMap[e.id][key]++;
      cvMap[e.id].total++;
      cvMap[e.id].avg = cvMap[e.id].total / 3;
    }
  }
}
