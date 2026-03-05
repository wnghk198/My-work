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
import { isCore, isProtected, stationCountsAt, recolorBlock } from './core.js';

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
          const canPlace=(needSt===ST.EXIT&&cnt.exit<CONSTRAINTS.MAX_EXIT)||
            (needSt===ST.ELEV&&cnt.elev<CONSTRAINTS.MAX_ELEV)||
            (needSt===ST.F3&&cnt.f3<CONSTRAINTS.MAX_F3);
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
            if((needSt===ST.EXIT&&cc2.exit>=CONSTRAINTS.MAX_EXIT)||
               (needSt===ST.ELEV&&cc2.elev>=CONSTRAINTS.MAX_ELEV)){blockOk=false;break;}
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
// EXIT/ELEV 슬롯별 초과 인원을 CART3F로 강등 (마지막 경험 보호)
export function repairOverstaffing(ctx){
  const{schedule,employees,active,slotsMin,coreMinSlots}=ctx;
  for(let si=0;si<slotsMin.length;si++){
    // EXIT 초과
    const exitEmps=employees.filter(e=>active[e.id][si]&&schedule[e.id][si]===ST.EXIT);
    if(exitEmps.length>CONSTRAINTS.MAX_EXIT){
      // 해당 직원들의 총 EXIT 슬롯 수 계산 (많이 가진 순으로 정렬)
      const withCount=exitEmps.map(e=>{
        let n=0;for(let i=0;i<schedule[e.id].length;i++){if(active[e.id][i]&&schedule[e.id][i]===ST.EXIT)n++;}
        return{e,n};
      });
      withCount.sort((a,b)=>b.n-a.n);
      // MAX_EXIT 이후의 직원들을 CART3F로 변경 (마지막 경험이면 스킵)
      for(let k=CONSTRAINTS.MAX_EXIT;k<withCount.length;k++){
        const{e,n}=withCount[k];
        const row=schedule[e.id];const actRow=active[e.id];
        // 이 직원이 마지막 EXIT 경험인지 확인
        let totalExit=0;for(let i=0;i<row.length;i++){if(actRow[i]&&row[i]===ST.EXIT)totalExit++;}
        if(totalExit<=coreMinSlots){continue;} // 이미 최소 경험 이하면 스킵
        // 이 슬롯에서의 연속 EXIT 블록 범위 찾기
        let bS=si,bE=si+1;
        while(bS>0&&actRow[bS-1]&&row[bS-1]===ST.EXIT)bS--;
        while(bE<row.length&&actRow[bE]&&row[bE]===ST.EXIT)bE++;
        // 블록 전체를 CART3F로 교체 (단, 그래도 coreMinSlots 이상 EXIT 남으면)
        const remaining=totalExit-(bE-bS);
        if(remaining>=coreMinSlots){
          for(let j=bS;j<bE;j++)row[j]=ST.CART3F;
        } else {
          // 일부만 교체 (앞부분 유지, 뒷부분 교체)
          const keep=coreMinSlots-remaining;
          for(let j=bS+keep;j<bE;j++)row[j]=ST.CART3F;
        }
      }
    }
    // ELEV 초과
    const elevEmps=employees.filter(e=>active[e.id][si]&&schedule[e.id][si]===ST.ELEV);
    if(elevEmps.length>CONSTRAINTS.MAX_ELEV){
      const withCount=elevEmps.map(e=>{
        let n=0;for(let i=0;i<schedule[e.id].length;i++){if(active[e.id][i]&&schedule[e.id][i]===ST.ELEV)n++;}
        return{e,n};
      });
      withCount.sort((a,b)=>b.n-a.n);
      for(let k=CONSTRAINTS.MAX_ELEV;k<withCount.length;k++){
        const{e,n}=withCount[k];
        const row=schedule[e.id];const actRow=active[e.id];
        let totalElev=0;for(let i=0;i<row.length;i++){if(actRow[i]&&row[i]===ST.ELEV)totalElev++;}
        if(totalElev<=coreMinSlots){continue;}
        let bS=si,bE=si+1;
        while(bS>0&&actRow[bS-1]&&row[bS-1]===ST.ELEV)bS--;
        while(bE<row.length&&actRow[bE]&&row[bE]===ST.ELEV)bE++;
        const remaining=totalElev-(bE-bS);
        if(remaining>=coreMinSlots){
          for(let j=bS;j<bE;j++)row[j]=ST.CART3F;
        } else {
          const keep=coreMinSlots-remaining;
          for(let j=bS+keep;j<bE;j++)row[j]=ST.CART3F;
        }
      }
    }
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
    for(const e of closeE){if(!active[e.id][i])continue;const st=schedule[e.id][i];const c=stationCountsAt(schedule,employees,active,i);if(st===ST.EXIT&&c.exit>CONSTRAINTS.MAX_EXIT)schedule[e.id][i]=ST.CART3F;else if(st===ST.ELEV&&c.elev>CONSTRAINTS.MAX_ELEV)schedule[e.id][i]=ST.CART3F;}
  }
}

// ── 마감조 안전회의 직후 코어 배치 ─────────────────────────────
// 마감조 직원의 안전회의 직후 슬롯(1개)에 커버리지 결핍이 있으면 코어 배정
// 최소 블록 예외 적용 — 15분(1슬롯) 허용
function applyPostMtgCoreSlot(ctx){
  const{schedule,employees,active,slotsMin,target}=ctx;
  const close=employees.filter(e=>e.group==='CLOSE');
  for(const e of close){
    const row=schedule[e.id];const actRow=active[e.id];
    for(let i=1;i<slotsMin.length;i++){
      if(!actRow[i])continue;
      if(row[i-1]!==ST.MTG)continue; // 직전 슬롯이 안전회의가 아니면 스킵
      if(row[i]!==''&&row[i]!==ST.OFF&&row[i]!==ST.CART2F&&row[i]!==ST.CART3F)continue;
      // 이 슬롯 커버리지 결핍 확인
      const t=target[i]||{exit:0,elev:0,f3:0};
      const c=stationCountsAt(schedule,employees,active,i);
      let st=null;
      if(t.elev>0&&c.elev<CONSTRAINTS.MAX_ELEV)st=ST.ELEV;
      else if(t.exit>0&&c.exit<CONSTRAINTS.MAX_EXIT)st=ST.EXIT;
      else if(t.f3>0&&c.f3<CONSTRAINTS.MAX_F3)st=ST.F3;
      if(st)row[i]=st;
    }
  }
}


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
        const postMtgExc=isClose&&len===1&&bS>0&&row[bS-1]===ST.MTG;
        if(postMtgExc){i=bE;continue;}
        if(isLastExp){
          let eS=bS,eE=bE,need=coreMinSlots-len;
          while(need>0&&eE<row.length){if(!actRow[eE])break;const ns=row[eE];if(isProtected(ns)||ns===ST.OFF||ns===ST.OPEN_PREP)break;
            // 확장 슬롯 MAX 체크
            const ccE=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,eE);
            if(st===ST.EXIT&&ccE.exit>=CONSTRAINTS.MAX_EXIT)break;
            if(st===ST.ELEV&&ccE.elev>=CONSTRAINTS.MAX_ELEV)break;
            eE++;need--;}
          while(need>0&&eS>0){if(!actRow[eS-1])break;const ps=row[eS-1];if(isProtected(ps)||ps===ST.OFF||ps===ST.OPEN_PREP)break;
            const ccP=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,eS-1);
            if(st===ST.EXIT&&ccP.exit>=CONSTRAINTS.MAX_EXIT)break;
            if(st===ST.ELEV&&ccP.elev>=CONSTRAINTS.MAX_ELEV)break;
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
          // 마감조 안전회의 직후 1슬롯 예외: CART2F 전환 금지, 코어 유지
          if(isClose&&len===1&&bS>0&&row[bS-1]===ST.MTG){i=bE;continue;}
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
      if(t.exit>0&&c.exit<CONSTRAINTS.MAX_EXIT&&canCore(ST.EXIT))fill=ST.EXIT;
      else if(t.elev>0&&c.elev<CONSTRAINTS.MAX_ELEV&&canCore(ST.ELEV))fill=ST.ELEV;
      else if(t.f3>0&&canCore(ST.F3))fill=ST.F3;
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

