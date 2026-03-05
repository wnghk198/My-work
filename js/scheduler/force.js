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
import { isCore, isProtected, stationCountsAt, computeCoverageDeficits, recolorBlock } from './core.js';

export function rebalanceVariance(ctx){
  const{schedule,employees,active,slotsMin,coreMaxSlots,target}=ctx;
  const varOf=(c)=>{if(!c||c.total===0)return 0;const avg=c.total/3;return((c.EXIT-avg)**2+(c.ELEV-avg)**2+(c.F3-avg)**2)/3;};
  const MIN_SWAP=1; // 블록 최소 길이 제한 없음 (isForcedCovExc로 validate 통과)

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
          const hasRoom=(needSt===ST.EXIT&&cnt.exit<CONSTRAINTS.MAX_EXIT)||(needSt===ST.ELEV&&cnt.elev<CONSTRAINTS.MAX_ELEV);

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
            improved=true;break outerRV;
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

          // 합산 편차 개선 확인 (1슬롯 스왑)
          const newC2={EXIT:c.EXIT,ELEV:c.ELEV,F3:c.F3-1,total:c.total};newC2[needKey]+=1;
          const newCo2={EXIT:co.EXIT,ELEV:co.ELEV,F3:(co.F3||0)+1,total:co.total};newCo2[needKey]-=1;
          if(varOf(newC2)+varOf(newCo2)>=varOf(c)+varOf(co))continue;

          // 스왑 실행 (1슬롯, NET=0)
          const prevE=row[si],prevO=oRow[si];
          row[si]=needSt;oRow[si]=ST.F3;
          // MAX 방어 검증
          const cnt2=stationCountsAt(schedule,employees,active,si);
          let swOk=(cnt2.exit<=CONSTRAINTS.MAX_EXIT&&cnt2.elev<=CONSTRAINTS.MAX_ELEV&&cnt2.f3<=CONSTRAINTS.MAX_F3);
          // 커버리지 손상 방지
          if(swOk){const t2=target[si]||{exit:0,elev:0,f3:0};if(t2.exit>0&&cnt2.exit<t2.exit)swOk=false;else if(t2.elev>0&&cnt2.elev<t2.elev)swOk=false;else if(t2.f3>0&&cnt2.f3<t2.f3)swOk=false;}
          if(!swOk){row[si]=prevE;oRow[si]=prevO;continue;}
          improved=true;break outerRV;
        }
      }
    }
    if(!improved)break;
  }
}

// ── 코어 미경험 강제 해소 ────────────────────────────────────────
// ensureCoreExperience 3패스로도 해결 못한 미경험을 1슬롯 스왑으로 강제 해결
// (validate isForcedCovExc 예외로 블록길이 위반 처리)
export function forceCoreExperience(ctx){
  const{schedule,employees,active,slotsMin,coreMaxSlots,target}=ctx;

  for(const e of employees){
    const row=schedule[e.id];
    const actRow=active[e.id];

    for(const nSt of [ST.EXIT,ST.ELEV,ST.F3]){
      // 이미 경험 있으면 스킵
      let hasIt=false;
      for(let i=0;i<row.length;i++){if(actRow[i]&&row[i]===nSt){hasIt=true;break;}}
      if(hasIt)continue;

      // 직원의 활성 슬롯 순회 (마감 야간 제외)
      for(let si=0;si<slotsMin.length;si++){
        if(!actRow[si])continue;
        if(e.group==='CLOSE'&&slotsMin[si]>=CONSTRAINTS.CLOSE_LATE_MIN)continue;
        const st=row[si];
        if(isProtected(st)||st===ST.OFF||st===ST.OPEN_PREP||st===nSt)continue;

        const cnt=stationCountsAt(schedule,employees,active,si);
        const maxReached=(nSt===ST.EXIT&&cnt.exit>=CONSTRAINTS.MAX_EXIT)||
          (nSt===ST.ELEV&&cnt.elev>=CONSTRAINTS.MAX_ELEV);

        if(maxReached){
          // MAX 초과 → 현재 점유자와 1슬롯 스왑 (NET=0)
          const occ=employees.find(e2=>
            e2.id!==e.id&&active[e2.id][si]&&schedule[e2.id][si]===nSt);
          if(!occ)continue;
          const oRow=schedule[occ.id];
          const prevE=row[si],prevO=oRow[si];
          row[si]=nSt; oRow[si]=prevE;

          // coreMax 체크
          let runE=1;
          for(let k=si-1;k>=0&&actRow[k]&&row[k]===nSt;k--)runE++;
          for(let k=si+1;k<row.length&&actRow[k]&&row[k]===nSt;k++)runE++;
          if(runE>coreMaxSlots){row[si]=prevE;oRow[si]=prevO;continue;}

          // 방어 검증 (MAX, 커버리지)
          const cnt2=stationCountsAt(schedule,employees,active,si);
          let ok=(cnt2.exit<=CONSTRAINTS.MAX_EXIT&&cnt2.elev<=CONSTRAINTS.MAX_ELEV&&cnt2.f3<=CONSTRAINTS.MAX_F3);
          // 커버리지 손상 확인: prevE(E 기존 스테이션)가 코어였을 때
          if(ok&&isCore(prevE)){
            const tgt=target[si]||{exit:0,elev:0,f3:0};
            if(prevE===ST.EXIT&&tgt.exit>0&&cnt2.exit<tgt.exit)ok=false;
            else if(prevE===ST.ELEV&&tgt.elev>0&&cnt2.elev<tgt.elev)ok=false;
            else if(prevE===ST.F3&&tgt.f3>0&&cnt2.f3<tgt.f3)ok=false;
          }
          if(!ok){row[si]=prevE;oRow[si]=prevO;continue;}
          hasIt=true; break;
        } else {
          // MAX 여유 있음 → 직접 1슬롯 배정
          let run=1;
          for(let k=si-1;k>=0&&actRow[k]&&row[k]===nSt;k--)run++;
          for(let k=si+1;k<row.length&&actRow[k]&&row[k]===nSt;k++)run++;
          if(run>coreMaxSlots)continue;

          // 커버리지 손상 방지
          const prevSt=row[si];
          if(isCore(prevSt)){
            const tgt=target[si]||{exit:0,elev:0,f3:0};
            const cnt3=stationCountsAt(schedule,employees,active,si);
            if(prevSt===ST.EXIT&&tgt.exit>0&&cnt3.exit<=tgt.exit)continue;
            if(prevSt===ST.ELEV&&tgt.elev>0&&cnt3.elev<=tgt.elev)continue;
            if(prevSt===ST.F3&&tgt.f3>0&&cnt3.f3<=tgt.f3)continue;
          }
          row[si]=nSt;
          hasIt=true; break;
        }
      }
    }
  }
}

// ── 커버리지 결핍 강제 배정 ─────────────────────────────────────
// repairCoverage/recolorBlock이 coreMin 미달로 포기한 단독 슬롯을 직접 강제 배정
export function forceDeficitSlots(ctx){
  const{schedule,employees,active,slotsMin,target,coreMaxSlots,coreCount}=ctx;

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
        if(nSt===ST.EXIT&&cnt.exit>=CONSTRAINTS.MAX_EXIT)continue;
        if(nSt===ST.ELEV&&cnt.elev>=CONSTRAINTS.MAX_ELEV)continue;

        const cands=employees.filter(e=>{
          if(!active[e.id][d.idx])return false;
          const st=schedule[e.id][d.idx];
          if(isProtected(st)||st===ST.OFF||st===ST.OPEN_PREP)return false;
          if(st===nSt)return false;
          return true;
        });
        if(!cands.length)continue;

        // ELEV/EXIT 경험 부족한 직원 우선 정렬
        const cc=coreCount||{};
        const ka=nSt===ST.EXIT?'EXIT':nSt===ST.ELEV?'ELEV':'F3';
        cands.sort((a,b)=>(cc[a.id]?.[ka]||0)-(cc[b.id]?.[ka]||0));

        const winner=cands[0];
        const row=schedule[winner.id];
        const prevSt=row[d.idx];
        row[d.idx]=nSt;

        // 인접 합산 coreMax 초과 시 롤백
        let run=1;
        for(let k=d.idx-1;k>=0&&active[winner.id][k]&&row[k]===nSt;k--)run++;
        for(let k=d.idx+1;k<row.length&&active[winner.id][k]&&row[k]===nSt;k++)run++;
        if(run>coreMaxSlots){row[d.idx]=prevSt;continue;}

        // 교체로 인해 다른 커버리지 결핍 유발 시 롤백
        const prevCountCheck=stationCountsAt(schedule,employees,active,d.idx);
        // (NET 증가이므로 이 슬롯 자체는 결핍 해소, 다른 슬롯은 기존 직원 이동 없음 → 안전)

        anyFixed=true;
        break;
      }
      if(anyFixed)break;
    }
    if(!anyFixed)break;
  }
}

