/**
 * scheduler/repair.js — 커버리지 수리 & 코어 경험 보장 (재설계 v19)
 *
 * repairCoverage            — 커버리지 결핍 수리 (최대 200회, bool 반환)
 * ensureCoreExperience      — 3-pass 보장: 직접배정 → 자연스왑 → 상호교환 (bool 반환)
 *
 * 재설계 포인트:
 *   - 모든 수리 함수가 bool 반환 → index.js 수렴 루프에서 활용
 *   - repairCoverage: 후보 선택 시 과잉 스테이션 보유 직원 우선 (자연스왑 유도)
 *   - ensureCoreExperience: 3개 pass를 단일 함수에서 순차 시도, 성공 시 즉시 반환
 *
 * 의존성: constants.js, utils.js, scheduler/core.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { buildWorkBlocks } from '../utils.js';
import { isCore, isProtected, stationCountsAt, computeCoverageDeficits, getFairnessCost, recolorBlock, dynMax, dynMaxAt } from './core.js';

// ── 커버리지 수리 ────────────────────────────────────────────────
// 결핍 슬롯마다 최적 후보를 선정해 recolorBlock으로 수정.
// 후보 정렬 우선순위:
//   1. 해당 슬롯에서 targetSt를 교체해도 커버리지를 유지할 수 있는 직원
//   2. targetSt 과잉 보유자가 아닌 직원 (자연스왑 유도)
//   3. 공정성 비용(fairnessCost) 낮은 직원
// 반환: 변화 발생 시 true

export function repairCoverage(ctx) {
  const { schedule, employees, active, slotsMin, target, coreCount } = ctx;
  let anyFixed = false;

  for (let iter = 0; iter < 200; iter++) {
    const defs = computeCoverageDeficits(schedule, employees, active, slotsMin, target);
    if (!defs.length) break;

    let fixed = false;
    for (const d of defs) {
      const needs = [];
      if (d.exit > 0) needs.push(ST.EXIT);
      if (d.elev > 0) needs.push(ST.ELEV);
      if (d.f3   > 0) needs.push(ST.F3);

      for (const nSt of needs) {
        const cntAtD = stationCountsAt(schedule, employees, active, d.idx);
        const tAtD   = ctx.target[d.idx] || { exit: 0, elev: 0, f3: 0 };

        // 용량 초과 시 스킵
        if (nSt === ST.EXIT && cntAtD.exit >= dynMaxAt(ST.EXIT, d.idx, employees, active)) continue;
        if (nSt === ST.ELEV && cntAtD.elev >= dynMaxAt(ST.ELEV, d.idx, employees, active)) continue;
        if (nSt === ST.F3   && cntAtD.f3   >= dynMaxAt(ST.F3,   d.idx, employees, active)) continue;

        const cands = [];
        for (const e of employees) {
          if (!active[e.id][d.idx]) continue;
          const cur = schedule[e.id][d.idx];
          if (isProtected(cur) || cur === ST.OFF || cur === nSt) continue;
          // 현재 슬롯이 다른 스테이션의 유일 커버리지 제공자면 스킵
          if (cur === ST.EXIT && tAtD.exit > 0 && cntAtD.exit <= tAtD.exit) continue;
          if (cur === ST.ELEV && tAtD.elev > 0 && cntAtD.elev <= tAtD.elev) continue;
          if (cur === ST.F3   && tAtD.f3   > 0 && cntAtD.f3   <= tAtD.f3)   continue;

          // 과잉 여부: nSt를 이미 많이 보유한 직원보다 적게 보유한 직원 우선
          const cc  = coreCount?.[e.id] || { EXIT: 0, ELEV: 0, F3: 0 };
          const key = nSt === ST.EXIT ? 'EXIT' : nSt === ST.ELEV ? 'ELEV' : 'F3';
          cands.push({ e, cur, fairCost: getFairnessCost(coreCount, e.id, nSt), nStCount: cc[key] });
        }
        if (!cands.length) continue;

        // 정렬: 공정성 비용 낮음 → nSt 보유 수 적음 → 비코어 우선
        cands.sort((a, b) => {
          const d0 = a.fairCost - b.fairCost;
          if (d0 !== 0) return d0;
          const d1 = a.nStCount - b.nStCount;
          if (d1 !== 0) return d1;
          return (isCore(a.cur) ? 1 : 0) - (isCore(b.cur) ? 1 : 0);
        });

        // 최소 블록 형성 가능한 후보 우선 (파편 생성 방지)
        const canFormBlock = (e) => {
          const row = schedule[e.id], actRow = active[e.id];
          const minBlk = ctx.coreMinSlots || 3;
          const curSt  = row[d.idx];
          let bS = d.idx, bE = d.idx + 1;
          while (bS > 0 && actRow[bS-1] && row[bS-1] === curSt && !isProtected(row[bS-1])) bS--;
          while (bE < row.length && actRow[bE] && row[bE] === curSt && !isProtected(row[bE])) bE++;
          return (bE - bS) >= minBlk;
        };
        const blockable = cands.filter(c => canFormBlock(c.e));
        const winner    = (blockable.length ? blockable : cands)[0].e;

        // MAX 제약 재확인
        const cntCheck = stationCountsAt(schedule, employees, active, d.idx);
        const maxOk = (nSt === ST.EXIT && cntCheck.exit < dynMaxAt(ST.EXIT, d.idx, employees, active))
                   || (nSt === ST.ELEV && cntCheck.elev < dynMaxAt(ST.ELEV, d.idx, employees, active))
                   || (nSt === ST.F3   && cntCheck.f3   < dynMaxAt(ST.F3,   d.idx, employees, active));
        if (!maxOk) continue;

        const snapshot = schedule[winner.id].slice();
        recolorBlock(ctx, winner.id, d.idx, nSt);

        // 롤백 검증: 새 MAX 초과 또는 기존 커버리지 결핍 발생 시 되돌림
        let violated = false;
        for (let si = 0; si < slotsMin.length && !violated; si++) {
          if (!active[winner.id][si]) continue;
          if (schedule[winner.id][si] !== nSt || snapshot[si] === nSt) continue;
          const cc = stationCountsAt(schedule, employees, active, si);
          if (nSt === ST.EXIT && cc.exit > dynMaxAt(ST.EXIT, si, employees, active)) violated = true;
          if (nSt === ST.ELEV && cc.elev > dynMaxAt(ST.ELEV, si, employees, active)) violated = true;
          if (nSt === ST.F3   && cc.f3   > dynMaxAt(ST.F3,   si, employees, active)) violated = true;
        }
        if (!violated) {
          for (let si = 0; si < slotsMin.length && !violated; si++) {
            if (!active[winner.id][si]) continue;
            const origSt = snapshot[si];
            if (!isCore(origSt) || origSt === nSt || schedule[winner.id][si] === origSt) continue;
            const tsi = ctx.target[si] || { exit: 0, elev: 0, f3: 0 };
            const cc2 = stationCountsAt(schedule, employees, active, si);
            if (origSt === ST.EXIT && tsi.exit > 0 && cc2.exit < tsi.exit) violated = true;
            if (origSt === ST.ELEV && tsi.elev > 0 && cc2.elev < tsi.elev) violated = true;
            if (origSt === ST.F3   && tsi.f3   > 0 && cc2.f3   < tsi.f3)   violated = true;
          }
        }
        if (violated) { schedule[winner.id] = snapshot; continue; }

        // 직원 coreCount 재계산
        if (coreCount?.[winner.id]) {
          const cc2 = { EXIT: 0, ELEV: 0, F3: 0 };
          for (let si = 0; si < slotsMin.length; si++) {
            if (!active[winner.id][si]) continue;
            const s = schedule[winner.id][si];
            if (s === ST.EXIT) cc2.EXIT++; else if (s === ST.ELEV) cc2.ELEV++; else if (s === ST.F3) cc2.F3++;
          }
          coreCount[winner.id] = cc2;
        }
        fixed = true;
        anyFixed = true;
      }
    }
    if (!fixed) break;
  }
  return anyFixed;
}

// ── 코어 미경험 강제 보장 (3-pass) ──────────────────────────────
// Pass1: 슬라이딩 윈도우 직접 배정
// Pass2: 자연 스왑 (E의 블록 ↔ 점유자의 nSt, NET=0)
// Pass3: 상호 부분 교환 (점유자 잔여 보장 포함)
// 반환: 어느 직원에서든 변화 발생 시 true

export function ensureCoreExperience(ctx) {
  const { schedule, employees, active, slotsMin, coreMinSlots, coreMaxSlots } = ctx;

  const cntOf        = (cc, st) => st === ST.EXIT ? cc.exit : st === ST.ELEV ? cc.elev : cc.f3;
  const maxOf        = (st, si) => dynMaxAt(st, si, employees, active);
  const totalSlotsOf = (row, actRow, st) => {
    let n = 0;
    for (let i = 0; i < row.length; i++) if (actRow[i] && row[i] === st) n++;
    return n;
  };

  let anyPlaced = false;

  for (const e of employees) {
    const row    = schedule[e.id];
    const actRow = active[e.id];

    for (const nSt of [ST.EXIT, ST.ELEV, ST.F3]) {
      let hasIt = false;
      for (let i = 0; i < row.length; i++) { if (actRow[i] && row[i] === nSt) { hasIt = true; break; } }
      if (hasIt) continue;

      // 교체 후보 블록: 보호·OFF·준비·nSt 제외, 최소 길이 이상, 마감 야간 제외
      const candBlocks = buildWorkBlocks(row, actRow).filter(b => {
        if (b.st === nSt || isProtected(b.st) || b.st === ST.OFF || b.st === ST.OPEN_PREP) return false;
        if (b.end - b.start < coreMinSlots) return false;
        if (e.group === 'CLOSE' && slotsMin[b.end - 1] >= CONSTRAINTS.CLOSE_LATE_MIN) return false;
        return true;
      });

      let placed = false;

      // ── Pass1: 슬라이딩 윈도우 직접 배정 ───────────────────
      outer1:
      for (const b of candBlocks) {
        for (let ws = b.start; ws + coreMinSlots <= b.end; ws++) {
          let adjBefore = 0;
          for (let k = ws - 1; k >= 0 && actRow[k] && row[k] === nSt; k--) adjBefore++;
          if (adjBefore >= coreMaxSlots) continue;
          const cap = Math.min(ws + coreMaxSlots - adjBefore, b.end);

          let we = ws;
          for (let si = ws; si < cap; si++) {
            const cc = stationCountsAt(schedule, employees, active, si);
            if (cntOf(cc, nSt) >= maxOf(nSt, si)) break;
            // 코어 슬롯은 잉여(count > target)인 경우만 교체 허용
            const curSlot = row[si];
            if (isCore(curSlot) && curSlot !== nSt) {
              const tgt  = ctx?.target?.[si] || { exit: 0, elev: 0, f3: 0 };
              const ccC  = stationCountsAt(schedule, employees, active, si);
              const surplus = (curSlot === ST.EXIT && (tgt.exit === 0 || ccC.exit > tgt.exit))
                           || (curSlot === ST.ELEV && (tgt.elev === 0 || ccC.elev > tgt.elev))
                           || (curSlot === ST.F3   && (tgt.f3   === 0 || ccC.f3   > tgt.f3));
              if (!surplus) break;
            }
            we = si + 1;
          }
          if (we - ws < coreMinSlots) continue;
          for (let i = ws; i < we; i++) row[i] = nSt;
          placed = true; hasIt = true;
          anyPlaced = true;
          break outer1;
        }
      }
      if (placed) continue;

      // ── Pass2: 자연 스왑 (E ↔ 점유자, NET=0) ───────────────
      outer2:
      for (const b of candBlocks) {
        let wi = b.start;
        while (wi + coreMinSlots <= b.end) {
          const inc = employees.find(e2 =>
            e2.id !== e.id && active[e2.id][wi] && schedule[e2.id][wi] === nSt
          );
          if (!inc) { wi++; continue; }

          const iRow    = schedule[inc.id];
          const iActRow = active[inc.id];

          let ibS = wi, ibE = wi + 1;
          while (ibS > 0 && iActRow[ibS - 1] && iRow[ibS - 1] === nSt) ibS--;
          while (ibE < iRow.length && iActRow[ibE] && iRow[ibE] === nSt) ibE++;

          const swapS = Math.max(b.start, ibS);
          const swapE = Math.min(b.end, ibE);
          if (swapE - swapS < coreMinSlots) { wi = ibE; continue; }

          let adjE = 0;
          for (let k = swapS - 1; k >= 0 && actRow[k] && row[k] === nSt; k--) adjE++;

          const iTotal    = totalSlotsOf(iRow, iActRow, nSt);
          let inWindow    = 0;
          for (let si = swapS; si < swapE; si++) { if (iActRow[si] && iRow[si] === nSt) inWindow++; }
          const residualInc = iTotal - inWindow;

          const maxSwapLen = residualInc > 0
            ? Math.min(swapE - swapS, coreMaxSlots - adjE)
            : Math.min(swapE - swapS - 1, coreMaxSlots - adjE);

          // 점유자 보호 슬롯 범위 확인
          let iSafe = 0;
          for (let j = 0; j < maxSwapLen; j++) {
            const k = swapS + j;
            if (k >= iRow.length || !iActRow[k]) break;
            if (isProtected(iRow[k]) || iRow[k] === ST.OFF || iRow[k] === ST.OPEN_PREP) break;
            iSafe++;
          }

          const swapLen = Math.max(0, Math.min(maxSwapLen, iSafe));
          if (swapLen < coreMinSlots) { wi = ibE; continue; }

          const snapE = row.slice(), snapI = iRow.slice();
          const eSt   = b.st;
          for (let i = swapS; i < swapS + swapLen; i++) { iRow[i] = eSt; row[i] = nSt; }

          // 방어 검증
          let ok = true;
          if (isCore(eSt)) {
            let eRemain = 0;
            for (let i = 0; i < row.length; i++) { if (actRow[i] && row[i] === eSt) eRemain++; }
            if (eRemain < coreMinSlots) ok = false;
          }
          for (let si = swapS; si < swapS + swapLen && ok; si++) {
            const cc = stationCountsAt(schedule, employees, active, si);
            if (cc.exit   > dynMaxAt(ST.EXIT,  si, employees, active)) ok = false;
            if (cc.elev   > dynMaxAt(ST.ELEV,  si, employees, active)) ok = false;
            if (cc.f3     > dynMaxAt(ST.F3,    si, employees, active)) ok = false;
            if (cc.cart3f > CONSTRAINTS.MAX_CART3F)                    ok = false;
          }
          if (ok) { placed = true; anyPlaced = true; break outer2; }
          row.splice(0, row.length, ...snapE);
          iRow.splice(0, iRow.length, ...snapI);
          wi = swapS + swapLen;
        }
      }
      if (placed) continue;

      // ── Pass3: 상호 부분 교환 ─────────────────────────────
      outer3:
      for (const b of candBlocks) {
        let wi = b.start;
        while (wi < b.end) {
          const inc = employees.find(e2 =>
            e2.id !== e.id && active[e2.id][wi] && schedule[e2.id][wi] === nSt
          );
          if (!inc) { wi++; continue; }

          const iRow    = schedule[inc.id];
          const iActRow = active[inc.id];
          let ibS = wi, ibE = wi + 1;
          while (ibS > 0 && iActRow[ibS - 1] && iRow[ibS - 1] === nSt) ibS--;
          while (ibE < iRow.length && iActRow[ibE] && iRow[ibE] === nSt) ibE++;

          const swapS = Math.max(b.start, ibS);
          const swapE = Math.min(b.end, ibE);
          if (swapE - swapS < coreMinSlots) { wi = ibE; continue; }

          const eSt    = b.st;
          const eTotal = b.end - b.start;
          let maxUse   = Math.min(swapE - swapS, coreMaxSlots);
          if (isCore(eSt)) {
            const eTotalAll = row.filter((s, i) => actRow[i] && s === eSt).length;
            maxUse = Math.min(maxUse, eTotalAll - coreMinSlots);
          }
          if (maxUse < coreMinSlots) { wi = ibE; continue; }

          let adjE = 0;
          for (let k = swapS - 1; k >= 0 && actRow[k] && row[k] === nSt; k--) adjE++;
          if (adjE + maxUse > coreMaxSlots) { wi = ibE; continue; }

          const snapE = row.slice(), snapI = iRow.slice();
          for (let i = swapS; i < swapS + maxUse; i++) { row[i] = nSt; iRow[i] = eSt; }

          let ok3 = true;
          for (let si = swapS; si < swapS + maxUse && ok3; si++) {
            const cc = stationCountsAt(schedule, employees, active, si);
            if (cc.exit > dynMaxAt(ST.EXIT, si, employees, active)) ok3 = false;
            if (cc.elev > dynMaxAt(ST.ELEV, si, employees, active)) ok3 = false;
            if (cc.f3   > dynMaxAt(ST.F3,   si, employees, active)) ok3 = false;
          }
          if (ok3) { placed = true; anyPlaced = true; break outer3; }
          row.splice(0, row.length, ...snapE);
          iRow.splice(0, iRow.length, ...snapI);
          wi = ibE;
        }
      }
    }
  }
  return anyPlaced;
}
