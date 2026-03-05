/**
 * scheduler/repair.js — 커버리지 수리 & 코어 경험 보장
 *
 * repairCoverage            — 커버리지 결핍 반복 수리 (최대 400회)
 * repairMissingCoreExperience — 코어 미경험 직원 보완
 * ensureCoreExperience      — 3-pass 보장 (직접배정 → 자연스왑 → 상호교환)
 *
 * 의존성: constants.js, utils.js, scheduler/core.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { buildWorkBlocks } from '../utils.js';
import { isCore, isProtected, stationCountsAt, computeCoverageDeficits, getFairnessCost, recolorBlock, dynMax, dynMaxAt } from './core.js';

export function repairCoverage(ctx){
  const{schedule,employees,active,slotsMin,target,coreCount}=ctx;
  for(let iter=0;iter<400;iter++){
    const defs=computeCoverageDeficits(schedule,employees,active,slotsMin,target);
    if(!defs.length)break;let fixed=false;
    for(const d of defs){
      const needs=[];if(d.exit>0)needs.push(ST.EXIT);if(d.elev>0)needs.push(ST.ELEV);if(d.f3>0)needs.push(ST.F3);
      for(const nSt of needs){
        const cands=[];
        const cntAtD=stationCountsAt(schedule,employees,active,d.idx);
        const tAtD=ctx.target[d.idx]||{exit:0,elev:0,f3:0};
        for(const e of employees){
          if(!active[e.id][d.idx])continue;const cur=schedule[e.id][d.idx];
          if(isProtected(cur)||cur===ST.OFF||cur===nSt)continue;
          if(nSt===ST.EXIT){if(cntAtD.exit>=dynMaxAt(ST.EXIT,d.idx,employees,active))continue;}
          else if(nSt===ST.ELEV){if(cntAtD.elev>=dynMaxAt(ST.ELEV,d.idx,employees,active))continue;}
          else if(nSt===ST.F3){if(cntAtD.f3>=dynMaxAt(ST.F3,d.idx,employees,active))continue;}
          // 이미 필요한 코어 스테이션을 제공 중인 직원은 건드리지 않음 (새 결핍 방지)
          if(cur===ST.EXIT&&tAtD.exit>0&&cntAtD.exit<=tAtD.exit)continue;
          if(cur===ST.ELEV&&tAtD.elev>0&&cntAtD.elev<=tAtD.elev)continue;
          if(cur===ST.F3&&tAtD.f3>0&&cntAtD.f3<=tAtD.f3)continue;
          cands.push({e,cur,fairCost:getFairnessCost(coreCount,e.id,nSt)});
        }
        if(!cands.length)continue;
        cands.sort((a,b)=>{const d=a.fairCost-b.fairCost;if(d!==0)return d;return(isCore(a.cur)?1:0)-(isCore(b.cur)?1:0);});
        // 후보 중 최소 블록 형성 가능한 직원 우선 선택
        // (단일 슬롯만 가능한 직원은 제외 — 파편 생성 방지)
        const canFormBlock=(e)=>{
          const row=schedule[e.id];const actRow=active[e.id];
          const minBlk=ctx.coreMinSlots||3;
          let cnt=1;
          for(let k=d.idx+1;k<slotsMin.length&&actRow[k];k++){const s=row[k];if(isProtected(s)||s===ST.OFF||s===ST.OPEN_PREP)break;cnt++;}
          for(let k=d.idx-1;k>=0&&actRow[k];k--){const s=row[k];if(isProtected(s)||s===ST.OFF||s===ST.OPEN_PREP)break;cnt++;}
          return cnt>=minBlk;
        };
        const blockable=cands.filter(c=>canFormBlock(c.e));
        const winner=(blockable.length?blockable:cands)[0].e;
        // recolor 전 MAX 제약 재확인
        const cntCheck=stationCountsAt(schedule,employees,active,d.idx);
        const maxOk=(nSt===ST.EXIT&&cntCheck.exit<dynMaxAt(ST.EXIT,d.idx,employees,active))||
                    (nSt===ST.ELEV&&cntCheck.elev<dynMaxAt(ST.ELEV,d.idx,employees,active))||
                    (nSt===ST.F3&&cntCheck.f3<dynMaxAt(ST.F3,d.idx,employees,active));
        if(!maxOk)continue;
        const snapshot=schedule[winner.id].slice();
        recolorBlock(ctx,winner.id,d.idx,nSt);
        let violated=false;
        for(let si=0;si<slotsMin.length;si++){
          if(!active[winner.id][si])continue;
          if(schedule[winner.id][si]!==nSt||snapshot[si]===nSt)continue;
          const cc=stationCountsAt(schedule,employees,active,si);
          if(nSt===ST.EXIT&&cc.exit>dynMaxAt(ST.EXIT,si,employees,active)){violated=true;break;}
          if(nSt===ST.ELEV&&cc.elev>dynMaxAt(ST.ELEV,si,employees,active)){violated=true;break;}
          if(nSt===ST.F3&&cc.f3>dynMaxAt(ST.F3,si,employees,active)){violated=true;break;}
        }
        // 추가: recolor로 인해 기존 코어 커버리지 결핍이 생기는지 확인
        if(!violated){
          for(let si=0;si<slotsMin.length&&!violated;si++){
            if(!active[winner.id][si])continue;
            const origSt=snapshot[si];
            if(!isCore(origSt)||origSt===nSt||schedule[winner.id][si]===origSt)continue;
            const tsi=ctx.target[si]||{exit:0,elev:0,f3:0};
            const cc2=stationCountsAt(schedule,employees,active,si);
            if(origSt===ST.EXIT&&tsi.exit>0&&cc2.exit<tsi.exit)violated=true;
            else if(origSt===ST.ELEV&&tsi.elev>0&&cc2.elev<tsi.elev)violated=true;
            else if(origSt===ST.F3&&tsi.f3>0&&cc2.f3<tsi.f3)violated=true;
          }
        }
        if(violated){schedule[winner.id]=snapshot;continue;}
        if(coreCount[winner.id]){const key=nSt===ST.EXIT?'EXIT':nSt===ST.ELEV?'ELEV':'F3';coreCount[winner.id][key]++;}
        fixed=true;
      }
    }
    if(!fixed)break;
  }
}

export function repairMissingCoreExperience(ctx){
  const{schedule,employees,active,slotsMin,coreMinSlots,coreMaxSlots}=ctx;
  for(const e of employees){
    const row=schedule[e.id];const actRow=active[e.id];
    const blocks=buildWorkBlocks(row,actRow);
    const hasExit=blocks.some(b=>b.st===ST.EXIT);
    const hasElev=blocks.some(b=>b.st===ST.ELEV);
    const hasF3=blocks.some(b=>b.st===ST.F3);
    const missing=[];if(!hasExit)missing.push(ST.EXIT);if(!hasElev)missing.push(ST.ELEV);if(!hasF3)missing.push(ST.F3);
    for(const nSt of missing){
      const nc=blocks.filter(b=>!isCore(b.st)&&!isProtected(b.st)&&b.st!==ST.OFF&&b.st!==ST.OPEN_PREP&&(b.end-b.start)>=coreMinSlots);
      for(const nb of nc){
        const mid=Math.floor((nb.start+nb.end)/2);
        const cnt=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,mid);
        const maxOk=(nSt===ST.EXIT&&cnt.exit<dynMaxAt(ST.EXIT,mid,ctx.employees,ctx.active))||
                    (nSt===ST.ELEV&&cnt.elev<dynMaxAt(ST.ELEV,mid,ctx.employees,ctx.active))||
                    (nSt===ST.F3&&cnt.f3<dynMaxAt(ST.F3,mid,ctx.employees,ctx.active));
        if(!maxOk)continue;
        let before=0;let k=nb.start-1;while(k>=0&&actRow[k]&&row[k]===nSt){before++;k--;}
        const maxReplace=Math.max(0,coreMaxSlots-before);
        if(maxReplace<coreMinSlots)continue;
        const replEnd=Math.min(nb.start+Math.min(coreMaxSlots,maxReplace),nb.end);
        let blockViolated=false;
        for(let si=nb.start;si<replEnd;si++){
          const cc=stationCountsAt(ctx.schedule,ctx.employees,ctx.active,si);
          if(nSt===ST.EXIT&&cc.exit>=dynMaxAt(ST.EXIT,si,ctx.employees,ctx.active)){blockViolated=true;break;}
          if(nSt===ST.ELEV&&cc.elev>=dynMaxAt(ST.ELEV,si,ctx.employees,ctx.active)){blockViolated=true;break;}
          if(nSt===ST.F3&&cc.f3>=dynMaxAt(ST.F3,si,ctx.employees,ctx.active)){blockViolated=true;break;}
        }
        if(blockViolated)continue;
        for(let i=nb.start;i<replEnd;i++)row[i]=nSt;
        break;
      }
    }
  }
}

// ── 코어 미경험 강제 보장 패스 ─────────────────────────────────
// 알고리즘:
//   Pass1: 슬라이딩 윈도우로 직접 배정 가능한 연속 구간 탐색
//   Pass2: "자연 스왑" — E의 현재 스테이션 ↔ 점유자의 nSt
//          NET 카운트 변화 = 0 → MAX 위반 원천 불가

export function ensureCoreExperience(ctx){
  const{schedule,employees,active,slotsMin,coreMinSlots,coreMaxSlots}=ctx;

  const cntOf=(cc,st)=>st===ST.EXIT?cc.exit:st===ST.ELEV?cc.elev:cc.f3;
  const maxOf=(st,si)=>dynMaxAt(st,si,employees,active);
  const totalSlotsOf=(iRow,iActRow,st)=>{let n=0;for(let i=0;i<iRow.length;i++){if(iActRow[i]&&iRow[i]===st)n++;}return n;};

  for(const e of employees){
    const row=schedule[e.id];const actRow=active[e.id];

    for(const nSt of [ST.EXIT,ST.ELEV,ST.F3]){
      // 이미 경험 있으면 스킵
      let hasIt=false;
      for(let i=0;i<row.length;i++){if(actRow[i]&&row[i]===nSt){hasIt=true;break;}}
      if(hasIt)continue;

      // 교체 후보 블록: 보호·OFF·오픈준비 제외, 최소 길이 이상, 마감 야간 제외
      // 코어 블록도 허용 — 단, 스왑 시 방어 검증에서 E의 기존 코어 경험 유지 확인
      const candBlocks=buildWorkBlocks(row,actRow).filter(b=>{
        if(b.st===nSt||isProtected(b.st)||b.st===ST.OFF||b.st===ST.OPEN_PREP)return false;
        if(b.end-b.start<coreMinSlots)return false;
        if(e.group==='CLOSE'&&slotsMin[b.end-1]>=CONSTRAINTS.CLOSE_LATE_MIN)return false;
        return true;
      });

      let placed=false;

      // ── Pass1: 직접 배정 (슬라이딩 윈도우) ─────────────────
      // 후보 블록 내에서 nSt 배정이 가능한 최장 연속 구간을 탐색
      outer1:
      for(const b of candBlocks){
        for(let ws=b.start;ws+coreMinSlots<=b.end;ws++){
          // ws 앞 인접 nSt (coreMax 체크)
          let adjBefore=0;
          for(let k=ws-1;k>=0&&actRow[k]&&row[k]===nSt;k--)adjBefore++;
          if(adjBefore>=coreMaxSlots)continue;
          const cap=Math.min(ws+coreMaxSlots-adjBefore,b.end);

          // ws 부터 MAX 허용 구간 측정
          let we=ws;
          for(let si=ws;si<cap;si++){
            const cc=stationCountsAt(schedule,employees,active,si);
            if(cntOf(cc,nSt)>=maxOf(nSt,si))break;
            we=si+1;
          }
          if(we-ws<coreMinSlots)continue;

          for(let i=ws;i<we;i++)row[i]=nSt;
          placed=true;break outer1;
        }
      }

      if(placed)continue;

      // ── Pass2: 자연 스왑 (EXIT / ELEV / F3 모두) ────────────
      // E의 현재 스테이션(b.st) ↔ 점유자의 nSt — 1:1 교환
      // NET 카운트 = 0 이므로 MAX 초과 이론상 불가 (방어 검증 포함)
      // 점유자 보호: 스왑 후 점유자의 nSt 잔여 슬롯 >= coreMinSlots
      outer2:
      for(const b of candBlocks){
        let wi=b.start;
        while(wi+coreMinSlots<=b.end){
          // wi 슬롯에서 nSt 점유자 탐색
          const inc=employees.find(e2=>{
            return e2.id!==e.id&&active[e2.id][wi]&&schedule[e2.id][wi]===nSt;
          });
          if(!inc){wi++;continue;}

          const iRow=schedule[inc.id];const iActRow=active[inc.id];

          // 점유자의 연속 nSt 블록 범위 (wi 기준)
          let ibS=wi,ibE=wi+1;
          while(ibS>0&&iActRow[ibS-1]&&iRow[ibS-1]===nSt)ibS--;
          while(ibE<iRow.length&&iActRow[ibE]&&iRow[ibE]===nSt)ibE++;

          // 스왑 윈도우 = E 후보 블록 ∩ 점유자 nSt 블록
          const swapS=Math.max(b.start,ibS);
          const swapE=Math.min(b.end,ibE);
          if(swapE-swapS<coreMinSlots){wi=ibE;continue;}
          // (선행 fragment 방지 조건 제거: fixFragmentBlocks의 isLastExp 보호로 처리)

          // E 인접 nSt coreMax 제한 + 점유자 경험 보호
          let adjE=0;
          for(let k=swapS-1;k>=0&&actRow[k]&&row[k]===nSt;k--)adjE++;
          // 점유자가 스왑 후에도 최소 1슬롯 이상 nSt 경험을 유지하면 OK
          // (스왑 윈도우 밖에 nSt 슬롯이 있으면 경험 보존)
          const iTotal=totalSlotsOf(iRow,iActRow,nSt);
          // 스왑 범위(swapS~swapE) 안에서 incumbent의 nSt 슬롯 수
          let inWindow=0;
          for(let si=swapS;si<swapE;si++){if(iActRow[si]&&iRow[si]===nSt)inWindow++;}
          const residualInc=iTotal-inWindow; // 스왑 후 점유자의 nSt 잔류 슬롯
          // 잔류 0이면 점유자 경험 완전 박탈 → swapLen을 줄여 최소 1슬롯 보존
          const maxSwapLen=residualInc>0
            ? Math.min(swapE-swapS, coreMaxSlots-adjE)
            : Math.min(swapE-swapS-1, coreMaxSlots-adjE); // 마지막 1슬롯 남김
          const swapLen=Math.max(0, maxSwapLen);
          if(swapLen<coreMinSlots){wi=ibE;continue;}

          // 원자적 스왑: snapshot → 교환 → 방어 검증 → 실패 시 rollback
          const snapE=row.slice();const snapI=iRow.slice();
          const eSt=b.st; // E가 원래 갖고 있던 스테이션
          for(let i=swapS;i<swapS+swapLen;i++){iRow[i]=eSt;row[i]=nSt;}

          // 방어 검증 (NET=0 이므로 통상 통과, overflow·E 코어 보존 확인)
          let ok=true;
          // E의 eSt(기존 스테이션) 코어 경험 보존 확인 (스왑 이미 적용 상태에서 잔여 수 계산)
          if(isCore(eSt)){
            let eRemain=0;
            for(let i=0;i<row.length;i++){if(actRow[i]&&row[i]===eSt)eRemain++;}
            if(eRemain<coreMinSlots)ok=false;
          }
          for(let si=swapS;si<swapS+swapLen&&ok;si++){
            const cc=stationCountsAt(schedule,employees,active,si);
            if(cc.exit>dynMaxAt(ST.EXIT,si,employees,active))ok=false;
            if(cc.elev>dynMaxAt(ST.ELEV,si,employees,active))ok=false;
            if(cc.f3>dynMaxAt(ST.F3,si,employees,active))ok=false;
            if(cc.cart3f>CONSTRAINTS.MAX_CART3F)ok=false;
          }

          if(ok){placed=true;break outer2;}
          row.splice(0,row.length,...snapE);iRow.splice(0,iRow.length,...snapI);
          wi=swapS+swapLen;
        }
      }

      if(placed)continue;

      // ── Pass3: 상호 완전 교환 ────────────────────────────────
      // Pass2에서 잔류 0으로 차단된 케이스:
      // E의 후보 블록 일부(coreMinSlots)와 점유자 nSt 블록 일부를 교환
      // E의 기존 스테이션 최소 경험(coreMinSlots) 보존 조건 포함
      outer3:
      for(const b of candBlocks){
        let wi=b.start;
        while(wi<b.end){
          const inc=employees.find(e2=>e2.id!==e.id&&active[e2.id][wi]&&schedule[e2.id][wi]===nSt);
          if(!inc){wi++;continue;}
          const iRow=schedule[inc.id];const iActRow=active[inc.id];
          let ibS=wi,ibE=wi+1;
          while(ibS>0&&iActRow[ibS-1]&&iRow[ibS-1]===nSt)ibS--;
          while(ibE<iRow.length&&iActRow[ibE]&&iRow[ibE]===nSt)ibE++;
          const swapS=Math.max(b.start,ibS);
          const swapE=Math.min(b.end,ibE);
          if(swapE-swapS<coreMinSlots){wi=ibE;continue;}
          // E의 eSt 경험 보존: 스왑 후 E에게 eSt 슬롯이 coreMinSlots 이상 남아야 함
          const eSt=b.st;
          const eTotal=b.end-b.start; // 이 블록의 총 길이
          // useLen: E가 nSt로 바꿀 슬롯 수 (나머지는 eSt 유지)
          // E의 eSt 잔류 보장: eTotal - useLen >= coreMinSlots (eSt가 코어일 때)
          // 단, eSt가 비코어면 잔류 불필요
          let maxUse=Math.min(swapE-swapS,coreMaxSlots);
          if(isCore(eSt)){
            const eTotalAll=row.filter((s,i)=>actRow[i]&&s===eSt).length;
            // 전체 eSt 슬롯 중 useLen만큼 제거 후 coreMinSlots 이상 남아야 함
            maxUse=Math.min(maxUse,eTotalAll-coreMinSlots);
          }
          if(maxUse<coreMinSlots){wi=ibE;continue;}
          const useLen=maxUse;
          // E 인접 nSt coreMax 체크
          let adjE=0;for(let k=swapS-1;k>=0&&actRow[k]&&row[k]===nSt;k--)adjE++;
          if(adjE+useLen>coreMaxSlots){wi=ibE;continue;}
          const snapE=row.slice();const snapI=iRow.slice();
          for(let i=swapS;i<swapS+useLen;i++){row[i]=nSt;iRow[i]=eSt;}
          let ok3=true;
          for(let si=swapS;si<swapS+useLen&&ok3;si++){
            const cc=stationCountsAt(schedule,employees,active,si);
            if(cc.exit>dynMaxAt(ST.EXIT,si,employees,active))ok3=false;
            if(cc.elev>dynMaxAt(ST.ELEV,si,employees,active))ok3=false;
            if(cc.f3>dynMaxAt(ST.F3,si,employees,active))ok3=false;
          }
          if(ok3){placed=true;break outer3;}
          row.splice(0,row.length,...snapE);iRow.splice(0,iRow.length,...snapI);
          wi=ibE;
        }
      }
    }
  }
}




// ── 코어 균형화 패스 ────────────────────────────────────────────
// greedy 후 코어 분포가 극단적으로 편중된 직원을 찾아 블록을 교체
