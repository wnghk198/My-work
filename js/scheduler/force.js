/**
 * scheduler/force.js — 강제 해소 패스 (최후 수단)
 *
 * rebalanceVariance   — 합산 편차가 감소할 때만 F3↔EXIT/ELEV 스왑
 * forceCoreExperience — 1슬롯 강제 코어 경험 보장 (3-pass 후 잔여)
 * forceDeficitSlots   — coreMin 제약 우회 단독 배정으로 커버리지 강제 달성
 *
 * 의존성: constants.js, utils.js, scheduler/core.js
 */

import { ST, CONSTRAINTS } from '../constants.js';
import { buildWorkBlocks } from '../utils.js';
import { isCore, isProtected, stationCountsAt, computeCoverageDeficits, recolorBlock, dynMax, dynMaxAt } from './core.js';

// 반환: 스왑 발생 시 true
export function rebalanceVariance(ctx){
  const{schedule,employees,active,slotsMin,coreMinSlots,coreMaxSlots,target}=ctx;
  const varOf=(c)=>{if(!c||c.total===0)return 0;const avg=c.total/3;return((c.EXIT-avg)**2+(c.ELEV-avg)**2+(c.F3-avg)**2)/3;};
  const MIN_SWAP=1; // rebalanceVariance는 1슬롯 스왑 허용 (코어→코어 교환이므로 블록길이 불변)

  let anyImproved = false;
  for(let iter=0;iter<80;iter++){
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

    let improved=false;
    const sorted=[...employees].sort((a,b)=>varOf(cc[b.id])-varOf(cc[a.id]));

    outerRV:
    for(const e of sorted){
      const c=cc[e.id];
      if(!c||c.total===0||varOf(c)<4)continue;
      const avg=c.total/3;
      const row=schedule[e.id];const actRow=active[e.id];

      for(const needSt of[ST.EXIT,ST.ELEV]){
        const needKey=needSt===ST.EXIT?'EXIT':'ELEV';
        if(c.F3<=avg+1)continue;        // F3 과잉 아님
        if(c[needKey]>=avg-0.5)continue; // needSt 이미 충분

        // e의 F3 슬롯 전체 순회 (야간 마감 제외)
        for(let si=0;si<slotsMin.length;si++){
          if(!actRow[si])continue;
          if(row[si]!==ST.F3)continue;
          if(e.group==='CLOSE'&&slotsMin[si]>=CONSTRAINTS.CLOSE_LATE_MIN)continue;

          const cnt=stationCountsAt(schedule,employees,active,si);
          const hasRoom=(needSt===ST.EXIT&&cnt.exit<dynMaxAt(ST.EXIT,si,employees,active))||
                        (needSt===ST.ELEV&&cnt.elev<dynMaxAt(ST.ELEV,si,employees,active))||
                        (needSt===ST.F3&&cnt.f3<dynMaxAt(ST.F3,si,employees,active));

          if(hasRoom){
            // 직접 배정: coreMax 체크
            let adj=0;for(let k=si-1;k>=0&&actRow[k]&&row[k]===needSt;k--)adj++;
            let adjAft=0;for(let k=si+1;k<row.length&&actRow[k]&&row[k]===needSt;k++)adjAft++;
            if(adj+1+adjAft>coreMaxSlots)continue;
            // F3 커버리지 손상 방지
            const t=target[si]||{exit:0,elev:0,f3:0};
            if(t.f3>0&&cnt.f3<=t.f3)continue;
            // 편차 개선 확인 (1슬롯)
            const newC={EXIT:c.EXIT,ELEV:c.ELEV,F3:c.F3-1,total:c.total};newC[needKey]+=1;
            if(varOf(newC)>=varOf(c))continue;
            row[si]=needSt;
            improved=true; anyImproved=true; break outerRV;
          }

          // MAX 초과 → 점유자와 스왑
          const occ=employees.find(e2=>e2.id!==e.id&&active[e2.id][si]&&schedule[e2.id][si]===needSt);
          if(!occ)continue;
          const co=cc[occ.id];if(!co||co.total===0)continue;
          const oRow=schedule[occ.id];const oActRow=active[occ.id];

          // coreMax 체크 (e 쪽 needSt)
          let eAdj=0;for(let k=si-1;k>=0&&actRow[k]&&row[k]===needSt;k--)eAdj++;
          let eAdjAft=0;for(let k=si+1;k<row.length&&actRow[k]&&row[k]===needSt;k++)eAdjAft++;
          if(eAdj+1+eAdjAft>coreMaxSlots)continue;
          // coreMax 체크 (occ 쪽 F3)
          let oFAdj=0;for(let k=si-1;k>=0&&oActRow[k]&&oRow[k]===ST.F3;k--)oFAdj++;
          let oFAdjAft=0;for(let k=si+1;k<oRow.length&&oActRow[k]&&oRow[k]===ST.F3;k++)oFAdjAft++;
          if(oFAdj+1+oFAdjAft>coreMaxSlots)continue;
          // occ 잔류 체크 (경험 완전 박탈 방지)
          const occTotal=oRow.filter((s,j)=>oActRow[j]&&s===needSt).length;
          if(occTotal<=0)continue;
          // Fix-v26-1: 스왑 후 occ의 잔여가 coreMinSlots 미만이면 스킵
          // (잔여=0: 경험 박탈, 잔여=1~(coreMinSlots-1): 파편→fixFragmentBlocks 제거 위험)
          if(occTotal-1 < coreMinSlots)continue;

          // 합산 편차 개선 확인 (1슬롯 스왑)
          const newC2={EXIT:c.EXIT,ELEV:c.ELEV,F3:c.F3-1,total:c.total};newC2[needKey]+=1;
          const newCo2={EXIT:co.EXIT,ELEV:co.ELEV,F3:(co.F3||0)+1,total:co.total};newCo2[needKey]-=1;
          if(varOf(newC2)+varOf(newCo2)>=varOf(c)+varOf(co))continue;

          // 스왑 실행 (1슬롯, NET=0)
          const prevE=row[si],prevO=oRow[si];
          row[si]=needSt;oRow[si]=ST.F3;
          // MAX 방어 검증
          const cnt2=stationCountsAt(schedule,employees,active,si);
          let swOk=(cnt2.exit<=dynMaxAt(ST.EXIT,si,employees,active)&&cnt2.elev<=dynMaxAt(ST.ELEV,si,employees,active)&&cnt2.f3<=dynMaxAt(ST.F3,si,employees,active));
          // 커버리지 손상 방지
          if(swOk){const t2=target[si]||{exit:0,elev:0,f3:0};if(t2.exit>0&&cnt2.exit<t2.exit)swOk=false;else if(t2.elev>0&&cnt2.elev<t2.elev)swOk=false;else if(t2.f3>0&&cnt2.f3<t2.f3)swOk=false;}
          if(!swOk){row[si]=prevE;oRow[si]=prevO;continue;}
          improved=true; anyImproved=true; break outerRV;
        }
      }
    }
    if(!improved)break;
  }
  return anyImproved;
}

// ── 코어 미경험 강제 해소 ────────────────────────────────────────
// ensureCoreExperience 3패스로도 해결 못한 미경험을 블록 단위 스왑으로 강제 해결
// coreMinSlots 이상의 연속 블록만 배정 (1슬롯 단독 배정 금지)
// 반환: 코어 배정 발생 시 true
export function forceCoreExperience(ctx){
  const{schedule,employees,active,slotsMin,coreMinSlots,coreMaxSlots,target}=ctx;

  let anyPlacedFCE=false;
  for(const e of employees){
    const row=schedule[e.id];
    const actRow=active[e.id];

    for(const nSt of [ST.EXIT,ST.ELEV,ST.F3]){
      let hasIt=false;
      for(let i=0;i<row.length;i++){if(actRow[i]&&row[i]===nSt){hasIt=true;break;}}
      if(hasIt)continue;

      // 연속 블록(coreMinSlots 이상) 내에서 배정 시도
      let placed=false;

      // Pass A: 직접 배정 — 비보호 연속 구간에서 coreMinSlots 이상 확보
      outer_a:
      for(let si=0;si<slotsMin.length&&!placed;si++){
        if(!actRow[si])continue;
        if(e.group==='CLOSE'&&slotsMin[si]>=CONSTRAINTS.CLOSE_LATE_MIN)continue;
        const st=row[si];
        if(isProtected(st)||st===ST.OFF||st===ST.OPEN_PREP||st===nSt)continue;

        // si부터 최대 coreMaxSlots 슬롯 범위에서 연속 배정 가능 길이 측정
        let adjBefore=0;
        for(let k=si-1;k>=0&&actRow[k]&&row[k]===nSt;k--)adjBefore++;
        if(adjBefore>=coreMaxSlots)continue;

        let we=si;
        for(let j=si;j<slotsMin.length&&we-si+adjBefore<coreMaxSlots;j++){
          if(!actRow[j])break;
          if(e.group==='CLOSE'&&slotsMin[j]>=CONSTRAINTS.CLOSE_LATE_MIN)break;
          const s=row[j];
          if(isProtected(s)||s===ST.OFF||s===ST.OPEN_PREP)break;
          const cnt=stationCountsAt(schedule,employees,active,j);
          if(nSt===ST.EXIT&&cnt.exit>=dynMaxAt(ST.EXIT,j,employees,active))break;
          if(nSt===ST.ELEV&&cnt.elev>=dynMaxAt(ST.ELEV,j,employees,active))break;
          if(nSt===ST.F3&&cnt.f3>=dynMaxAt(ST.F3,j,employees,active))break;
          // 코어 교체 시 커버리지 손상 방지
          // ★ Fix4a: 잉여(count > target)인 스테이션은 교체 허용 — 커버리지 손상 없음
          if(isCore(s)&&s!==nSt){
            const tgt=target[j]||{exit:0,elev:0,f3:0};
            const cj=stationCountsAt(schedule,employees,active,j);
            const surplus=
              (s===ST.EXIT&&(tgt.exit===0||cj.exit>tgt.exit))||
              (s===ST.ELEV&&(tgt.elev===0||cj.elev>tgt.elev))||
              (s===ST.F3&&(tgt.f3===0||cj.f3>tgt.f3));
            if(!surplus){
              if(s===ST.EXIT&&tgt.exit>0&&cj.exit<=tgt.exit)break;
              if(s===ST.ELEV&&tgt.elev>0&&cj.elev<=tgt.elev)break;
              if(s===ST.F3&&tgt.f3>0&&cj.f3<=tgt.f3)break;
            }
          }
          we=j+1;
          if(we-si>=coreMinSlots){
            // 충분한 길이 확보 → 배정
            for(let j2=si;j2<we;j2++)row[j2]=nSt;
            placed=true; hasIt=true; anyPlacedFCE=true; break outer_a;
          }
        }
        // 3F: 어쩔 수 없는 경우 1슬롯(15분) 허용 — coreMinSlots 미달이어도 배정
        // (fixFragmentBlocks Fix24에서 이미 보호되므로 추후 CART2F 전환 없음)
        if(!placed&&nSt===ST.F3&&we>si){
          const cnt1=stationCountsAt(schedule,employees,active,si);
          if(cnt1.f3<dynMaxAt(ST.F3,si,employees,active)){
            row[si]=ST.F3;
            placed=true; hasIt=true; anyPlacedFCE=true; break outer_a;
          }
        }
      }

      // Pass B: 스왑 — 점유자의 nSt 블록(coreMinSlots 이상)과 E의 블록을 교환
      if(!placed){
        outer_b:
        for(let si=0;si<slotsMin.length&&!placed;si++){
          if(!actRow[si])continue;
          if(e.group==='CLOSE'&&slotsMin[si]>=CONSTRAINTS.CLOSE_LATE_MIN)continue;
          const st=row[si];
          if(isProtected(st)||st===ST.OFF||st===ST.OPEN_PREP||st===nSt)continue;

          const occ=employees.find(e2=>e2.id!==e.id&&active[e2.id][si]&&schedule[e2.id][si]===nSt);
          if(!occ)continue;

          const oRow=schedule[occ.id];const oActRow=active[occ.id];
          // 점유자의 연속 nSt 블록 범위
          let ibS=si,ibE=si+1;
          while(ibS>0&&oActRow[ibS-1]&&oRow[ibS-1]===nSt)ibS--;
          while(ibE<oRow.length&&oActRow[ibE]&&oRow[ibE]===nSt)ibE++;
          const ibLen=ibE-ibS;
          if(ibLen<coreMinSlots)continue; // 점유자 블록이 너무 짧음

          // E의 교체 가능 연속 범위 (si 기준)
          let eS=si,eE=si+1;
          while(eS>0&&actRow[eS-1]&&!isProtected(row[eS-1])&&row[eS-1]!==ST.OFF&&row[eS-1]!==ST.OPEN_PREP)eS--;
          while(eE<row.length&&actRow[eE]&&!isProtected(row[eE])&&row[eE]!==ST.OFF&&row[eE]!==ST.OPEN_PREP)eE++;

          // 스왑은 si부터 시작 → 앞쪽 비보호 범위(eS..si)가 아닌 뒤쪽(si..eE)만 유효
          // eE-si 로 경계 제한 (보호 슬롯 REST/MEAL/MTG 덮어쓰기 방지)
          const swapLen=Math.min(ibLen,eE-si,coreMaxSlots);
          if(swapLen<coreMinSlots)continue;

          // occTotal을 swapLen 계산에 포함 → 스왑 후 점유자 잔여 ≥ 0 보장
          // (잔여=0 허용: 이후 ensureCoreExperience가 복구)
          const occTotal=oRow.filter((s,ii)=>oActRow[ii]&&s===nSt).length;

          // ★ 점유자 보호 슬롯 검사: oRow[si+j]가 REST/MEAL/MTG이면 스왑 불가
          // 스왑 루프 `oRow[si+j]=snapE[si+j]`가 점유자의 보호 슬롯을 덮어쓰는 버그 방지
          let occSafe=0;
          for(let j=0;j<swapLen;j++){
            if(si+j>=oRow.length)break;
            if(!oActRow[si+j])break;
            if(isProtected(oRow[si+j])||oRow[si+j]===ST.OFF||oRow[si+j]===ST.OPEN_PREP)break;
            occSafe++;
          }

          const swapLenFinal=Math.min(swapLen,occTotal,occSafe);
          if(swapLenFinal<coreMinSlots)continue;

          // 파편 방지: 스왑 후 점유자 잔여가 1~(coreMinSlots-1)이면 fixFragmentBlocks가
          // CART2F로 변환 → 커버리지 손실. 잔여=0(허용) 또는 >=coreMinSlots(정상)만 허용
          const remain=occTotal-swapLenFinal;
          if(remain>0&&remain<coreMinSlots)continue;

          const snapE=row.slice();const snapO=oRow.slice();
          // Fix-v25-4: occ 슬롯 교체 시 snapE[si+j]가 코어 스테이션이면 과잉 오류 방지를 위해
          // CART3F로 대체. 비코어(CART2F 등)는 기존대로 snapE 사용.
          // (이전: snapE[si+j] 고정 사용 → e의 3F 슬롯을 occ에 복사할 때 3F 초과 발생 → 스왑 롤백)
          for(let j=0;j<swapLenFinal;j++){
            row[si+j]=nSt;
            const origSt=snapE[si+j];
            if(isCore(origSt)){
              // 코어 슬롯 복사 시 과잉 여부 사전 확인 → 과잉이면 CART3F fallback
              const cc2=stationCountsAt(schedule,employees,active,si+j);
              const wouldOver=
                (origSt===ST.EXIT &&cc2.exit >=dynMaxAt(ST.EXIT, si+j,employees,active))||
                (origSt===ST.ELEV &&cc2.elev >=dynMaxAt(ST.ELEV, si+j,employees,active))||
                (origSt===ST.F3   &&cc2.f3   >=dynMaxAt(ST.F3,   si+j,employees,active));
              oRow[si+j]=wouldOver?ST.CART3F:origSt;
            } else {
              oRow[si+j]=origSt;
            }
          }

          // 방어 검증: dynMax 초과 체크
          let ok=true;
          for(let j=si;j<si+swapLenFinal&&ok;j++){
            const cnt2=stationCountsAt(schedule,employees,active,j);
            if(cnt2.exit>dynMaxAt(ST.EXIT,j,employees,active))ok=false;
            if(cnt2.elev>dynMaxAt(ST.ELEV,j,employees,active))ok=false;
            if(cnt2.f3>dynMaxAt(ST.F3,j,employees,active))ok=false;
          }
          if(!ok){row.splice(0,row.length,...snapE);oRow.splice(0,oRow.length,...snapO);continue;}
          placed=true; hasIt=true; anyPlacedFCE=true;
        }
      }
    }
  }
  return anyPlacedFCE;
}

// ── 커버리지 결핍 강제 배정 ─────────────────────────────────────
// coreMinSlots 이상의 블록을 d.idx 중심으로 배정 (단독 슬롯 배정 금지)
// 반환: 배정 발생 시 true
export function forceDeficitSlots(ctx){
  const{schedule,employees,active,slotsMin,target,coreMinSlots,coreMaxSlots,coreCount}=ctx;

  let anyPlaced=false;
  for(let iter=0;iter<50;iter++){
    const defs=computeCoverageDeficits(schedule,employees,active,slotsMin,target);
    if(!defs.length)break;

    let anyFixed=false;
    for(const d of defs){
      const needs=[];
      if(d.exit>0)needs.push(ST.EXIT);
      if(d.elev>0)needs.push(ST.ELEV);
      if(d.f3>0)needs.push(ST.F3);

      for(const nSt of needs){
        const cnt=stationCountsAt(schedule,employees,active,d.idx);
        if(nSt===ST.EXIT&&cnt.exit>=dynMaxAt(ST.EXIT,d.idx,employees,active))continue;
        if(nSt===ST.ELEV&&cnt.elev>=dynMaxAt(ST.ELEV,d.idx,employees,active))continue;
        if(nSt===ST.F3&&cnt.f3>=dynMaxAt(ST.F3,d.idx,employees,active))continue;

        // d.idx 를 포함할 수 있는 coreMinSlots 블록을 갖는 후보 탐색
        // ★ Fix7: 뒤로 확장 시에도 dynMax 체크 + bwd 확장 범위 확대 (최대 coreMaxSlots-1까지)
        const cands=employees.filter(e=>{
          if(!active[e.id][d.idx])return false;
          const st=schedule[e.id][d.idx];
          if(isProtected(st)||st===ST.OFF||st===ST.OPEN_PREP||st===nSt)return false;
          // d.idx부터 전진 측정
          let fwd=0;
          for(let k=d.idx;k<slotsMin.length;k++){
            if(!active[e.id][k])break;
            const s=schedule[e.id][k];
            if(isProtected(s)||s===ST.OFF||s===ST.OPEN_PREP)break;
            const cc=stationCountsAt(schedule,employees,active,k);
            if(nSt===ST.EXIT&&cc.exit>=dynMaxAt(ST.EXIT,k,employees,active)&&s!==nSt)break;
            if(nSt===ST.ELEV&&cc.elev>=dynMaxAt(ST.ELEV,k,employees,active)&&s!==nSt)break;
            if(nSt===ST.F3&&cc.f3>=dynMaxAt(ST.F3,k,employees,active)&&s!==nSt)break;
            fwd++;
            if(fwd>=coreMinSlots)return true;
          }
          // fwd 부족하면 역방향 확장 시도 (dynMax 체크 포함)
          let bwd=0;
          const maxBwd=coreMaxSlots-1; // coreMax 이내에서만 역방향 허용
          for(let k=d.idx-1;k>=0&&bwd<maxBwd;k--){
            if(!active[e.id][k])break;
            const s=schedule[e.id][k];
            if(isProtected(s)||s===ST.OFF||s===ST.OPEN_PREP)break;
            // 역방향 슬롯도 dynMax 여유 확인
            const cc=stationCountsAt(schedule,employees,active,k);
            if(nSt===ST.EXIT&&cc.exit>=dynMaxAt(ST.EXIT,k,employees,active)&&s!==nSt)break;
            if(nSt===ST.ELEV&&cc.elev>=dynMaxAt(ST.ELEV,k,employees,active)&&s!==nSt)break;
            if(nSt===ST.F3&&cc.f3>=dynMaxAt(ST.F3,k,employees,active)&&s!==nSt)break;
            bwd++;
            if(fwd+bwd>=coreMinSlots)return true;
          }
          // v24: 1슬롯(15분)이라도 배정 가능하면 후보 포함 (최후수단)
          return fwd+bwd>=1;
        });
        if(!cands.length)continue;

        const cc=coreCount||{};
        const ka=nSt===ST.EXIT?'EXIT':nSt===ST.ELEV?'ELEV':'F3';
        cands.sort((a,b)=>(cc[a.id]?.[ka]||0)-(cc[b.id]?.[ka]||0));

        // ── 모든 후보를 순서대로 시도 (cands[0] 실패 시 다음 후보로 넘어감) ──
        let placedForDeficit=false;
        for(const winner of cands){
          if(placedForDeficit)break;
          const row=schedule[winner.id];
          const actRow=active[winner.id];

          // d.idx 기준 전진 확장
          let adjBefore=0;
          for(let k=d.idx-1;k>=0&&actRow[k]&&row[k]===nSt;k--)adjBefore++;

          let blockEnd=d.idx;
          for(let k=d.idx;k<slotsMin.length&&blockEnd-d.idx+adjBefore<coreMaxSlots;k++){
            if(!actRow[k])break;
            const s=row[k];
            if(isProtected(s)||s===ST.OFF||s===ST.OPEN_PREP)break;
            const cc2=stationCountsAt(schedule,employees,active,k);
            if(nSt===ST.EXIT&&cc2.exit>=dynMaxAt(ST.EXIT,k,employees,active)&&s!==nSt)break;
            if(nSt===ST.ELEV&&cc2.elev>=dynMaxAt(ST.ELEV,k,employees,active)&&s!==nSt)break;
            if(nSt===ST.F3&&cc2.f3>=dynMaxAt(ST.F3,k,employees,active)&&s!==nSt)break;
            blockEnd=k+1;
            if(blockEnd-d.idx>=coreMinSlots)break;
          }

          // coreMinSlots 미달이면 역방향으로도 확장 (dynMax 체크 포함)
          let blockStart=d.idx;
          while(blockEnd-blockStart<coreMinSlots&&blockStart>0){
            const k=blockStart-1;
            if(!actRow[k])break;
            const s=row[k];
            if(isProtected(s)||s===ST.OFF||s===ST.OPEN_PREP)break;
            if(adjBefore+blockEnd-blockStart+1>coreMaxSlots)break;
            // bwd 슬롯 dynMax 체크 — 현재 슬롯에서 이미 nSt이면 추가 체크 불필요
            if(s!==nSt){
              const ccB=stationCountsAt(schedule,employees,active,k);
              if(nSt===ST.EXIT&&ccB.exit>=dynMaxAt(ST.EXIT,k,employees,active))break;
              if(nSt===ST.ELEV&&ccB.elev>=dynMaxAt(ST.ELEV,k,employees,active))break;
              if(nSt===ST.F3&&ccB.f3>=dynMaxAt(ST.F3,k,employees,active))break;
            }
            blockStart=k;
          }

          // 최소 길이 미달 검사
          // v24: EXIT/ELEV/F3 모두 1슬롯(15분) 최후수단 허용
          // — fixFragmentBlocks가 유일 커버리지 1슬롯을 CART2F로 전환하지 않으므로 안전
          if(blockEnd-blockStart<coreMinSlots){
            if(blockEnd-blockStart>=1){
              blockStart=d.idx; blockEnd=d.idx+1;
            } else {
              continue; // 슬롯 없음 → 다음 후보
            }
          }

          const snap=row.slice();
          for(let k=blockStart;k<blockEnd;k++)row[k]=nSt;

          // coreMax 초과 검사
          let run=blockEnd-blockStart;
          for(let k=blockStart-1;k>=0&&actRow[k]&&row[k]===nSt;k--)run++;
          for(let k=blockEnd;k<row.length&&actRow[k]&&row[k]===nSt;k++)run++;
          if(run>coreMaxSlots){row.splice(0,row.length,...snap);continue;}

          // 기존 커버리지 손상 검사 (★ Fix6b: 잉여 스테이션은 손상 아님)
          let coverDamaged=false;
          for(let k=blockStart;k<blockEnd&&!coverDamaged;k++){
            const origSt=snap[k];
            if(!isCore(origSt)||origSt===nSt)continue;
            const t2=target?.[k]||{exit:0,elev:0,f3:0};
            if(t2.exit===0&&t2.elev===0&&t2.f3===0)continue;
            const cc3=stationCountsAt(schedule,employees,active,k);
            // v24: cc3 < t2 일 때만 손상 — 정확히 충족(==)은 손상 아님
            if(origSt===ST.EXIT&&t2.exit>0&&cc3.exit<t2.exit)coverDamaged=true;
            else if(origSt===ST.ELEV&&t2.elev>0&&cc3.elev<t2.elev)coverDamaged=true;
            else if(origSt===ST.F3&&t2.f3>0&&cc3.f3<t2.f3)coverDamaged=true;
          }
          if(coverDamaged){row.splice(0,row.length,...snap);continue;}

          placedForDeficit=true;
        }
        if(!placedForDeficit)continue;

        anyFixed=true; anyPlaced=true;
        break;
      }
      if(anyFixed)break;
    }
    if(!anyFixed)break;
  }
  return anyPlaced;
}

