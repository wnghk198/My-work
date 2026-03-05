/**
 * scheduler/balance.js — 균형화·제약 강제·블록 정리
 *
 * balanceCoreRotation        — 코어 분포 편차 기반 블록 교체 (최대 8라운드)
 * repairOverstaffing         — EXIT/ELEV 초과 인원 CART3F 강등
 * enforceCart2fMax           — 2F카트 최대 슬롯(30분) 초과 분리
 * enforceCart3fMax           — 3F카트 동시 최대 인원 제한
 * enforceCloseLateAssignment — 마감조 야간(21:30~) 구간 코어 강제
 * fixFragmentBlocks          — 단편 블록 흡수·확장·CART2F 전환
 * fillRemainingSlots         — 빈 슬롯 최종 채우기
 *
 * 의존성: constants.js, utils.js, scheduler/core.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { parseTimeToMin, buildWorkBlocks } from '../utils.js';
import { isCore, isProtected, stationCountsAt, recolorBlock, dynMax, dynMaxAt } from './core.js';

export function balanceCoreRotation(ctx) {
  const{schedule,employees,active,slotsMin,coreMinSlots,coreMaxSlots,target}=ctx;
  const MAX_ROUNDS=8;

  for(let round=0;round<MAX_ROUNDS;round++){
    // 현재 코어 카운트 계산
    const cc={};
    for(const e of employees){
      cc[e.id]={EXIT:0,ELEV:0,F3:0,total:0};
      for(let i=0;i<slotsMin.length;i++){
        if(!active[e.id][i])continue;
        const st=schedule[e.id][i];
        if(st===ST.EXIT){cc[e.id].EXIT++;cc[e.id].total++;}
        else if(st===ST.ELEV){cc[e.id].ELEV++;cc[e.id].total++;}
        else if(st===ST.F3){cc[e.id].F3++;cc[e.id].total++;}
      }
    }

    let swapped=false;

    for(const e of employees){
      const c=cc[e.id];
      if(c.total===0)continue;
      const avg=c.total/3;

      // 부족한 코어 찾기 (0이거나 avg보다 많이 부족)
      const missing=[];
      if(c.EXIT===0)missing.push(ST.EXIT);
      if(c.ELEV===0)missing.push(ST.ELEV);
      if(c.F3===0)missing.push(ST.F3);
      // 극단적 편중도 교정 (avg-2 → 더 민감하게 avg-1.5)
      for(const [st,key] of [[ST.EXIT,'EXIT'],[ST.ELEV,'ELEV'],[ST.F3,'F3']]){
        if(c[key]<avg-1.5&&!missing.includes(st))missing.push(st);
      }
      if(!missing.length)continue;

      // 이 직원의 과잉 코어 또는 비코어 블록을 찾아 교체 시도
      const row=schedule[e.id];const actRow=active[e.id];
      const blocks=buildWorkBlocks(row,actRow);
      // 교체 소스 정렬: 과잉 코어(EXIT-heavy) 먼저, 그 다음 비코어
      const overKey=(b)=>{
        if(b.st===ST.EXIT)return-(c.EXIT-avg);
        if(b.st===ST.ELEV)return-(c.ELEV-avg);
        if(b.st===ST.F3)return-(c.F3-avg);
        return 0; // 비코어
      };
      
      for(const needSt of missing){
        const needKey=needSt===ST.EXIT?'EXIT':needSt===ST.ELEV?'ELEV':'F3';
        // 교체 가능한 블록 찾기: 비코어 또는 과잉 코어 블록 (과잉 코어 우선)
        const replaceable=blocks.filter(b=>{
          if(isProtected(b.st)||b.st===ST.OFF||b.st===ST.OPEN_PREP)return false;
          if(b.st===needSt)return false;
          const len=b.end-b.start;
          if(len<coreMinSlots)return false;
          // 마감 야간 제외
          if(e.group==='CLOSE'&&slotsMin[b.end-1]>=CONSTRAINTS.CLOSE_LATE_MIN)return false;
          return true;
        }).sort((a,b2)=>overKey(b2)-overKey(a)); // 과잉 코어(높은 overKey) 먼저

        for(const rb of replaceable){
          const mid=Math.floor((rb.start+rb.end)/2);
          // MAX 제약 확인
          const cnt=stationCountsAt(schedule,employees,active,mid);
          const canPlace=(needSt===ST.EXIT&&cnt.exit<dynMaxAt(ST.EXIT,mid,employees,active))||
            (needSt===ST.ELEV&&cnt.elev<dynMaxAt(ST.ELEV,mid,employees,active))||
            (needSt===ST.F3&&cnt.f3<dynMaxAt(ST.F3,mid,employees,active));
          if(!canPlace)continue;

          // 인접 동일 코어 합산 제한
          let before=0;let k=rb.start-1;
          while(k>=0&&actRow[k]&&row[k]===needSt){before++;k--;}
          const maxReplace=Math.max(0,coreMaxSlots-before);
          if(maxReplace<coreMinSlots)continue;
          // 실제 교체 범위
          const replEnd=Math.min(rb.start+Math.min(maxReplace,coreMaxSlots),rb.end);
          
          // 교체 범위 내 모든 슬롯 MAX 확인
          let blockOk=true;
          for(let si=rb.start;si<replEnd;si++){
            const cc2=stationCountsAt(schedule,employees,active,si);
            if((needSt===ST.EXIT&&cc2.exit>=dynMaxAt(ST.EXIT,si,employees,active))||
               (needSt===ST.ELEV&&cc2.elev>=dynMaxAt(ST.ELEV,si,employees,active))||
               (needSt===ST.F3&&cc2.f3>=dynMaxAt(ST.F3,si,employees,active))){blockOk=false;break;}
          }
          if(!blockOk)continue;

          // 교체 실행 (스냅샷 후 커버리지 롤백 검증)
          const snapRow=row.slice();
          for(let i=rb.start;i<replEnd;i++)row[i]=needSt;
          let cvrBroken=false;
          if(isCore(rb.st)){for(let si=rb.start;si<replEnd&&!cvrBroken;si++){const t=ctx.target[si]||{exit:0,elev:0,f3:0};const cc3=stationCountsAt(schedule,employees,active,si);if(rb.st===ST.EXIT&&t.exit>0&&cc3.exit<t.exit)cvrBroken=true;else if(rb.st===ST.ELEV&&t.elev>0&&cc3.elev<t.elev)cvrBroken=true;else if(rb.st===ST.F3&&t.f3>0&&cc3.f3<t.f3)cvrBroken=true;}}
          if(cvrBroken){row.splice(0,row.length,...snapRow);continue;}
          swapped=true;
          break; // 이 missing 코어는 해결됨
        }
      }
    }
    if(!swapped)break;
  }
}

// ── 초과인원 수리 ────────────────────────────────────────────────
// EXIT/ELEV/F3 슬롯별 초과 인원을 CART3F로 강등 (마지막 경험 보호)
// F3 동적 제한: 해당 슬롯 활성 직원 수의 ceil(1/3) 이하
export function repairOverstaffing(ctx){
  const{schedule,employees,active,slotsMin,coreMinSlots}=ctx;

  for(let si=0;si<slotsMin.length;si++){
    // ── 슬롯별 동적 상한값 ──────────────────────────────────────
    const activeCount = employees.filter(e => active[e.id][si]).length;

    function demoteExcess(st, maxAllowed) {
      const matched = employees.filter(e => active[e.id][si] && schedule[e.id][si] === st);
      if (matched.length <= maxAllowed) return;

      const withTotal = matched.map(e => {
        let n = 0;
        for (let i = 0; i < schedule[e.id].length; i++) {
          if (active[e.id][i] && schedule[e.id][i] === st) n++;
        }
        return { e, n };
      });
      withTotal.sort((a, b) => b.n - a.n);

      for (let k = maxAllowed; k < withTotal.length; k++) {
        const { e } = withTotal[k];
        const row = schedule[e.id]; const actRow = active[e.id];

        let total = 0;
        for (let i = 0; i < row.length; i++) {
          if (actRow[i] && row[i] === st) total++;
        }
        if (total <= coreMinSlots) continue;

        let bS = si, bE = si + 1;
        while (bS > 0 && actRow[bS-1] && row[bS-1] === st) bS--;
        while (bE < row.length && actRow[bE] && row[bE] === st) bE++;

        const remaining = total - (bE - bS);
        if (remaining >= coreMinSlots) {
          for (let j = bS; j < bE; j++) row[j] = ST.CART3F;
        } else {
          const keep = Math.max(0, coreMinSlots - remaining);
          for (let j = bS + keep; j < bE; j++) row[j] = ST.CART3F;
        }
      }
    }

    demoteExcess(ST.EXIT, dynMax(ST.EXIT, activeCount));
    demoteExcess(ST.ELEV, dynMax(ST.ELEV, activeCount));
    demoteExcess(ST.F3,   dynMax(ST.F3,   activeCount));
  }
}

export function enforceCart2fMax(ctx){
  const{schedule,employees,active}=ctx;const MAX=CONSTRAINTS.MAX_CART2F_SLOTS;
  for(const e of employees){const row=schedule[e.id];const actRow=active[e.id];let i=0;
    while(i<row.length){if(actRow[i]&&row[i]===ST.CART2F){const s=i;while(i<row.length&&actRow[i]&&row[i]===ST.CART2F)i++;
      if(i-s>MAX){for(let j=s+MAX;j<i;j++){
        const cc=stationCountsAt(schedule,employees,active,j);
        row[j]=cc.cart3f<CONSTRAINTS.MAX_CART3F?ST.CART3F:ST.CART2F; // CART3F 포화 시 CART2F 유지
      }}}else i++;}}
}

export function enforceCart3fMax(ctx){
  // 동일 슬롯 CART3F 초과 시 초과분을 2F카트로 분산
  const{schedule,employees,active,slotsMin}=ctx;
  for(let si=0;si<slotsMin.length;si++){
    const cart3fEmps=employees.filter(e=>active[e.id][si]&&schedule[e.id][si]===ST.CART3F);
    if(cart3fEmps.length<=CONSTRAINTS.MAX_CART3F)continue;
    // 가장 짧은 CART3F 블록 보유자부터 CART2F 전환
    const withLen=cart3fEmps.map(e=>{
      let bS=si,bE=si+1;const row=schedule[e.id];const actRow=active[e.id];
      while(bS>0&&actRow[bS-1]&&row[bS-1]===ST.CART3F)bS--;
      while(bE<row.length&&actRow[bE]&&row[bE]===ST.CART3F)bE++;
      return{e,bS,bE,len:bE-bS};
    });
    withLen.sort((a,b)=>a.len-b.len);
    for(let k=CONSTRAINTS.MAX_CART3F;k<withLen.length;k++){
      const{e,bS,bE}=withLen[k];const row=schedule[e.id];
      // CART2F 변환 시 MAX_CART2F_SLOTS 제한 내로 분할
      let c2=0;
      for(let j=bS;j<bE;j++){
        if(c2<CONSTRAINTS.MAX_CART2F_SLOTS){row[j]=ST.CART2F;c2++;}
        // 나머지는 CART3F 초과 시 허용 최소치로 채움 (후속 repairCoverage에서 처리)
        // 초과분은 그냥 CART2F로 두고 validate는 허용 — 실제 coverage repair에서 재배정됨
        else row[j]=ST.CART2F; // enforceCart2fMax가 이후 CART3F로 전환 시도
      }
    }
  }
}

export function enforceCloseLateAssignment(ctx){
  const{schedule,employees,active,slotsMin}=ctx;
  const LATE=CONSTRAINTS.CLOSE_LATE_MIN;const lIdx=slotsMin.findIndex(m=>m>=LATE);if(lIdx<0)return;
  const closeE=employees.filter(e=>e.group==='CLOSE'&&active[e.id][lIdx]);if(!closeE.length)return;
  for(const tSt of[ST.EXIT,ST.ELEV,ST.F3]){
    let winner=null;
    if(lIdx>0)winner=closeE.find(e=>active[e.id][lIdx-1]&&schedule[e.id][lIdx-1]===tSt)||null;
    if(!winner){let ls=-1;for(const e of closeE){for(let i=lIdx-1;i>=0;i--){if(!active[e.id][i])continue;if(schedule[e.id][i]===tSt){if(i>ls){ls=i;winner=e;}break;}}}}
    if(!winner)winner=closeE[0];
    for(let i=lIdx;i<slotsMin.length;i++){if(!active[winner.id][i])break;schedule[winner.id][i]=tSt;}
  }
  for(let i=lIdx;i<slotsMin.length;i++){
    for(const e of closeE){if(!active[e.id][i])continue;const st=schedule[e.id][i];const c=stationCountsAt(schedule,employees,active,i);if(st===ST.EXIT&&c.exit>dynMaxAt(ST.EXIT,i,employees,active))schedule[e.id][i]=ST.CART3F;else if(st===ST.ELEV&&c.elev>dynMaxAt(ST.ELEV,i,employees,active))schedule[e.id][i]=ST.CART3F;else if(st===ST.F3&&c.f3>dynMaxAt(ST.F3,i,employees,active))schedule[e.id][i]=ST.CART3F;}
  }
}

// applyPostMtgCoreSlot は balance.js 에서 제거됨
// (1슬롯 코어 배정은 coreMin 위반 — events.js의 applyPostMtgCoreSlot 도 동일하게 비활성화)
function applyPostMtgCoreSlot(_ctx){ /* 단독 슬롯 배정 금지 — no-op */ }


export function fixFragmentBlocks(ctx){
  const{schedule,employees,active,slotsMin,coreMinSlots,coreMaxSlots}=ctx;
  const LATE=CONSTRAINTS.CLOSE_LATE_MIN;
  for(const e of employees){
    const row=schedule[e.id];const actRow=active[e.id];const isClose=e.group==='CLOSE';
    // Pass1: 앞뒤 같은 코어 사이의 1슬롯 비보호 채우기
    for(let i=1;i<row.length-1;i++){
      if(!actRow[i])continue;
      if(isClose&&slotsMin[i]>=LATE)continue;
      const prev=row[i-1],cur=row[i],next=row[i+1];
      if(prev===next&&isCore(prev)&&cur!==prev&&!isProtected(cur))row[i]=prev;
    }
    // Pass2: coreMin 미만 코어 블록 → 인접 블록으로 흡수 (coreMax 초과 방지)
    let i=0;
    while(i<row.length){
      if(!actRow[i]){i++;continue;}
      const st=row[i];
      if(!isCore(st)||(isClose&&slotsMin[i]>=LATE)){i++;continue;}
      let bS=i,bE=i;
      while(bE<row.length&&actRow[bE]&&row[bE]===st)bE++;
      const len=bE-bS;
      if(len>0&&len<coreMinSlots){
        // 이 블록이 해당 코어 유일 경험인지 확인 → 유일하면 흡수 금지, 확장 시도
        const isLastExp=!row.some((s,idx)=>s===st&&idx!==bS&&actRow[idx]&&(idx<bS||idx>=bE));
        // 마감조 안전회의 직후 1슬롯 예외: 파편이어도 유지
        // postMtgExc 제거 — 회의 직후라도 coreMin 미달 블록은 허용하지 않음
        if(isLastExp){
          let eS=bS,eE=bE,need=coreMinSlots-len;
          while(need>0&&eE<row.length){if(!actRow[eE])break;const ns=row[eE];if(isProtected(ns)||ns===ST.OFF||ns===ST.OPEN_PREP)break;
            // 확장 슬롯 MAX 체크
            const ccE=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,eE);
            if(st===ST.EXIT&&ccE.exit>=dynMaxAt(ST.EXIT,eE,ctx.employees,ctx.active))break;
            if(st===ST.ELEV&&ccE.elev>=dynMaxAt(ST.ELEV,eE,ctx.employees,ctx.active))break;
            if(st===ST.F3&&ccE.f3>=dynMaxAt(ST.F3,eE,ctx.employees,ctx.active))break;
            eE++;need--;}
          while(need>0&&eS>0){if(!actRow[eS-1])break;const ps=row[eS-1];if(isProtected(ps)||ps===ST.OFF||ps===ST.OPEN_PREP)break;
            const ccP=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,eS-1);
            if(st===ST.EXIT&&ccP.exit>=dynMaxAt(ST.EXIT,eS-1,ctx.employees,ctx.active))break;
            if(st===ST.ELEV&&ccP.elev>=dynMaxAt(ST.ELEV,eS-1,ctx.employees,ctx.active))break;
            if(st===ST.F3&&ccP.f3>=dynMaxAt(ST.F3,eS-1,ctx.employees,ctx.active))break;
            eS--;need--;}
          if(eE-eS>=coreMinSlots){
            // 확장 적용 전 스냅샷 → 커버리지 결핍 발생 시 롤백하고 CART2F
            const snapRow=row.slice();
            for(let j=eS;j<eE;j++)row[j]=st;
            // 확장으로 기존 코어 슬롯이 변경된 곳에서 커버리지 결핍 발생하는지 확인
            let cvrBroken=false;
            for(let j=eS;j<eE&&!cvrBroken;j++){
              if(snapRow[j]===st)continue; // 원래 이미 st였던 슬롯은 변화 없음
              const origSt=snapRow[j];
              if(!isCore(origSt))continue;
              const t2=ctx.target?.[j]||{exit:0,elev:0,f3:0};
              const cc2=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,j);
              if(origSt===ST.EXIT&&t2.exit>0&&cc2.exit<t2.exit)cvrBroken=true;
              else if(origSt===ST.ELEV&&t2.elev>0&&cc2.elev<t2.elev)cvrBroken=true;
              else if(origSt===ST.F3&&t2.f3>0&&cc2.f3<t2.f3)cvrBroken=true;
            }
            if(!cvrBroken){i=bE;continue;} // 확장 성공
            row.splice(0,row.length,...snapRow); // 롤백
          }
          // 확장 실패 → 파편 전략: CART2F 전환 (블록길이 위반 방지 우선)
          // 커버리지 결핍은 repairCoverage가 다른 충분한 블록으로 복구
          for(let j=bS;j<bE;j++)row[j]=ST.CART2F;
          i=bE;continue;
        }
        // 앞뒤 블록 탐색
        const prevSt=bS>0&&actRow[bS-1]?row[bS-1]:null;
        const nextSt=bE<row.length&&actRow[bE]?row[bE]:null;
        const pOk=prevSt&&prevSt!==ST.OFF&&prevSt!==''&&!isProtected(prevSt)&&prevSt!==ST.OPEN_PREP;
        const nOk=nextSt&&nextSt!==ST.OFF&&nextSt!==''&&!isProtected(nextSt)&&nextSt!==ST.OPEN_PREP;
        // 앞/뒤 각각 길이 측정
        let prevLen=0;if(pOk){let k=bS-1;while(k>=0&&actRow[k]&&row[k]===prevSt){prevLen++;k--;}}
        let nextLen=0;if(nOk){let k=bE;while(k<row.length&&actRow[k]&&row[k]===nextSt){nextLen++;k++;}}
        // coreMax 초과 없이 흡수 가능한지 확인
        const canPrev=pOk&&isCore(prevSt)&&(prevLen+len<=coreMaxSlots);
        const canNext=nOk&&isCore(nextSt)&&(nextLen+len<=coreMaxSlots);
        // 비코어 인접 블록으로 흡수도 허용
        const canPrevNC=pOk&&!isCore(prevSt);
        const canNextNC=nOk&&!isCore(nextSt);
        let replWith=null;
        if(canPrev&&canNext){replWith=nextLen>=prevLen?nextSt:prevSt;}
        else if(canPrev){replWith=prevSt;}
        else if(canNext){replWith=nextSt;}
        else if(canPrevNC){replWith=prevSt;}
        else if(canNextNC){replWith=nextSt;}
        // 흡수 전 커버리지 보호: 이 블록이 해당 슬롯의 유일 커버리지 제공자이면 흡수 금지
        if(replWith&&replWith!==st&&isCore(st)){
          let coverBreak=false;
          for(let j=bS;j<bE&&!coverBreak;j++){
            const t=ctx.target?.[j]||{exit:0,elev:0,f3:0};
            const cc=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,j);
            if(st===ST.EXIT&&t.exit>0&&cc.exit<=t.exit)coverBreak=true;
            else if(st===ST.ELEV&&t.elev>0&&cc.elev<=t.elev)coverBreak=true;
            else if(st===ST.F3&&t.f3>0&&cc.f3<=t.f3)coverBreak=true;
          }
          if(coverBreak)replWith=null;
        }
        if(replWith){
          for(let j=bS;j<bE;j++)row[j]=replWith;
        } else if(isCore(st)){
          // 흡수 불가 파편 처리:
          // postMtgExc 제거 — coreMin 미달 코어 블록은 CART2F 전환
          // 모든 파편(1슬롯 포함) → CART2F 전환 (블록길이 위반 방지 우선)
          for(let j=bS;j<bE;j++)row[j]=ST.CART2F;
        }
      }
      i=bE;
    }
    // Pass3: coreMax 초과 블록 분할 → 초과분은 CART2F 우선 (enforceCart2fMax가 CART3F로 전환)
    i=0;
    while(i<row.length){
      if(!actRow[i]){i++;continue;}
      const st3=row[i];
      if(!isCore(st3)||(isClose&&slotsMin[i]>=LATE)){i++;continue;}
      const bS3=i;
      while(i<row.length&&actRow[i]&&row[i]===st3)i++;
      const bE3=i;
      if(bE3-bS3>coreMaxSlots){
        for(let j=bS3+coreMaxSlots;j<bE3;j++){
          row[j]=ST.CART2F; // CART2F로 전환, enforceCart2fMax가 2슬롯 초과분을 CART3F로 재분류
        }
      }
    }
  }
}

export function fillRemainingSlots(ctx){
  const{schedule,employees,active,slotsMin,target,coreMinSlots,coreMaxSlots}=ctx;
  for(const e of employees){const row=schedule[e.id];const actRow=active[e.id];
    let i=0;
    while(i<row.length){
      if(!actRow[i]||row[i]!==''&&row[i]!==ST.OFF){i++;continue;}
      let segEnd=i;
      while(segEnd<row.length&&actRow[segEnd]&&(row[segEnd]===''||row[segEnd]===ST.OFF))segEnd++;
      const segLen=segEnd-i;
      const mid=Math.floor((i+segEnd)/2);
      const t=target[mid]||{exit:0,elev:0,f3:0};
      const c=stationCountsAt(schedule,employees,active,mid);
      // 인접 블록 길이 측정 (코어 선택 시 coreMax 초과 여부 확인)
      const adjacentLen=(st)=>{
        let n=0;let k=i-1;while(k>=0&&actRow[k]&&row[k]===st){n++;k--;}
        k=segEnd;while(k<row.length&&actRow[k]&&row[k]===st){n++;k++;}
        return n;
      };
      const canCore=(st)=>adjacentLen(st)+segLen<=coreMaxSlots;
      let fill=null; // null = 슬롯별 결정
      if(t.exit>0&&c.exit<dynMaxAt(ST.EXIT,mid,employees,active)&&canCore(ST.EXIT))fill=ST.EXIT;
      else if(t.elev>0&&c.elev<dynMaxAt(ST.ELEV,mid,employees,active)&&canCore(ST.ELEV))fill=ST.ELEV;
      else if(t.f3>0&&c.f3<dynMaxAt(ST.F3,mid,employees,active)&&canCore(ST.F3))fill=ST.F3;
      if(fill){
        for(let j=i;j<segEnd;j++)row[j]=fill;
      } else {
        // 슬롯별 용량 확인하며 CART2F/CART3F 채우기
        let cart2fUsed=0;
        for(let j=i;j<segEnd;j++){
          const cc=stationCountsAt(schedule,employees,active,j);
          if(cart2fUsed<CONSTRAINTS.MAX_CART2F_SLOTS){row[j]=ST.CART2F;cart2fUsed++;}
          else if(cc.cart3f<CONSTRAINTS.MAX_CART3F){row[j]=ST.CART3F;}
          else{row[j]=ST.CART2F;} // CART3F도 포화 → CART2F 추가 (enforceCart2fMax가 처리)
        }
      }
      i=segEnd;
    }
  }
}

/**
 * mergeAdjacentCoreBlocks
 *
 * 인접한 서로 다른 코어 블록(EXIT/ELEV/F3)이 연속으로 붙어 있고
 * 합산 길이가 coreMin(45분) 이상이면 지배 스테이션으로 통합합니다.
 *
 * 예) 3F(30분) + 엘베(15분) + 3F(15분)  → 3F(45분) 또는 3F(60분)
 *     EXIT(15분) + F3(30분)              → F3(45분)
 *
 * 병합 규칙:
 *   1. 연속된 코어 슬롯 그룹 탐색 (서로 다른 종류도 포함)
 *   2. 그룹 내 가장 많은 슬롯 스테이션을 dominant로 선택
 *   3. dominant로 최대 coreMax 슬롯까지 통합, 초과분은 CART2F
 *   4. MAX 제약(EXIT ≤ 1, ELEV ≤ 1) 슬롯 충돌 시 F3 우선 fallback
 *   5. 커버리지 결핍 발생 시 롤백
 */
export function mergeAdjacentCoreBlocks(ctx) {
  const { schedule, employees, active, slotsMin, coreMinSlots, coreMaxSlots, target } = ctx;
  const LATE = CONSTRAINTS.CLOSE_LATE_MIN;

  for (const e of employees) {
    const row    = schedule[e.id];
    const actRow = active[e.id];
    const isClose = e.group === 'CLOSE';
    let i = 0;

    while (i < row.length) {
      // 코어 슬롯 시작 찾기
      if (!actRow[i] || !isCore(row[i]) || (isClose && slotsMin[i] >= LATE)) { i++; continue; }

      // 연속 코어 그룹 수집
      const gS = i;
      while (i < row.length && actRow[i] && isCore(row[i]) &&
             !(isClose && slotsMin[i] >= LATE)) i++;
      const gE  = i;
      const gLen = gE - gS;

      // 이미 단일 스테이션이거나 coreMin 미만이면 스킵
      const kinds = new Set();
      for (let j = gS; j < gE; j++) kinds.add(row[j]);
      if (kinds.size <= 1 || gLen < coreMinSlots) continue;

      // 지배 스테이션: 가장 많은 슬롯 수 (동점이면 F3 > ELEV > EXIT 순)
      const cnt = { [ST.EXIT]: 0, [ST.ELEV]: 0, [ST.F3]: 0 };
      for (let j = gS; j < gE; j++) if (cnt[row[j]] !== undefined) cnt[row[j]]++;

      const priority = [ST.F3, ST.ELEV, ST.EXIT];
      let dominant = priority.reduce((best, st) =>
        cnt[st] > cnt[best] ? st : best, ST.F3);

      // 병합 범위: coreMax 이내
      const mEnd = Math.min(gS + coreMaxSlots, gE);

      // MAX 제약 확인, 충돌 시 F3 fallback
      let blocked = false;
      for (let j = gS; j < mEnd; j++) {
        if (row[j] === dominant) continue;
        const cc = stationCountsAt(schedule, employees, active, j);
        if (dominant === ST.EXIT && cc.exit >= dynMaxAt(ST.EXIT, j, employees, active)) { blocked = true; break; }
        if (dominant === ST.ELEV && cc.elev >= dynMaxAt(ST.ELEV, j, employees, active)) { blocked = true; break; }
        if (dominant === ST.F3   && cc.f3   >= dynMaxAt(ST.F3,   j, employees, active)) { blocked = true; break; }
      }
      if (blocked) {
        // EXIT/ELEV 충돌 → F3 로 재시도
        if (dominant !== ST.F3) {
          dominant = ST.F3;
          blocked = false;
        } else {
          continue; // 포기
        }
      }

      // 스냅샷 저장 후 병합 적용
      const snap = row.slice();
      for (let j = gS; j < mEnd; j++) row[j] = dominant;
      for (let j = mEnd; j < gE; j++) row[j] = ST.CART2F;

      // 커버리지 결핍 검사
      let broken = false;
      for (let j = gS; j < gE && !broken; j++) {
        const origSt = snap[j];
        if (!isCore(origSt) || origSt === row[j]) continue;
        const t  = target?.[j] || { exit: 0, elev: 0, f3: 0 };
        const cc = stationCountsAt(schedule, employees, active, j);
        if (origSt === ST.EXIT && t.exit > 0 && cc.exit < t.exit) broken = true;
        if (origSt === ST.ELEV && t.elev > 0 && cc.elev < t.elev) broken = true;
        if (origSt === ST.F3   && t.f3   > 0 && cc.f3   < t.f3  ) broken = true;
      }
      if (broken) row.splice(0, row.length, ...snap);
    }
  }
}

// ── 코어 블록 최대 길이 강제 ─────────────────────────────────────
// 모든 수리 패스 이후 coreMax를 초과하는 블록을 강제 분할.
// 규칙:
//   - 모든 직원: coreMax 초과 블록 → 초과분 CART2F
//   - 마감조: CLOSE_LATE_MIN(21:30) 이후에 시작하는 블록은 길이 제한 없음
//             단, 21:30 이전에 시작해서 이후로 이어지는 블록은 21:30 이전 구간에 coreMax 적용
export function enforceMaxBlockLength(ctx) {
  const { schedule, employees, active, slotsMin, coreMaxSlots } = ctx;
  const LATE = CONSTRAINTS.CLOSE_LATE_MIN;

  for (const e of employees) {
    const row    = schedule[e.id];
    const actRow = active[e.id];
    const isClose = e.group === 'CLOSE';
    let i = 0;

    while (i < row.length) {
      if (!actRow[i]) { i++; continue; }
      const st = row[i];
      if (!isCore(st)) { i++; continue; }

      const bS = i;
      while (i < row.length && actRow[i] && row[i] === st) i++;
      const bE = i;
      const len = bE - bS;

      if (len <= coreMaxSlots) continue;

      // 마감조: 21:30 이후에 블록이 완전히 포함되면 제한 없음
      if (isClose && slotsMin[bS] >= LATE) continue;

      if (isClose && slotsMin[bS] < LATE) {
        // 21:30 이전 시작 블록: 21:30 이전 구간에만 coreMax 적용
        // 21:30 이전 슬롯 수 계산
        let preLen = 0;
        for (let j = bS; j < bE; j++) {
          if (slotsMin[j] < LATE) preLen++;
          else break;
        }
        if (preLen > coreMaxSlots) {
          // 21:30 이전 구간이 coreMax 초과 → coreMax 이후분을 CART2F
          for (let j = bS + coreMaxSlots; j < bS + preLen; j++) row[j] = ST.CART2F;
        }
        // 21:30 이후 구간은 유지 (enforceCloseLateAssignment가 배정한 것)
        continue;
      }

      // 비마감조 or 마감조 21:30 이전: coreMax 초과분 CART2F
      for (let j = bS + coreMaxSlots; j < bE; j++) row[j] = ST.CART2F;
    }
  }
}
