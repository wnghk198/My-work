window.Scheduler = (() => {
  const { WORKPLACES, FIXED_EVENTS, MEAL_STARTS, MEAL_DURATION_MIN, BREAKS, SIX_HOUR_BREAKS } = window.Data;
  const BREAK_RULE_TEXT = '8시간은 휴식 15분·15분·10분, 6시간은 15분·10분이며 휴식과 휴식 사이는 60분을 초과하고 마지막 휴식은 퇴근 1시간 30분~2시간 전에 배치';
  const { timeToMin, minToTime, overlap } = window.Utils;

  const EXTRA_WP = '2F 카트 내림';
  const EXTRA_WP_3F = '3F 카트 내림';
  const ASSIST_WP = '2F 보조';
  const MAX_ASSIST_PER_WORKER = 2;
  const CART_WPS = [EXTRA_WP, EXTRA_WP_3F];
  const NON_CART_WPS = ['2F 엘베', '2F 출차', '3F', ASSIST_WP];
  const MAIN_2F_WPS = ['2F 엘베', '2F 출차'];
  const FIXED_60_WPS = ['2F 엘베', '2F 출차', '3F'];
  const FLEX_WPS = [ASSIST_WP, EXTRA_WP, EXTRA_WP_3F];
  const AUTO_ASSIGN_WPS = WORKPLACES.slice();
  const MAIN_2F_CAPS = { '2F 엘베': 1, '2F 출차': 1 };
  const WP_CAPS = { '2F 엘베': 1, '2F 출차': 1, '3F': 3, '3F 카트 내림': 3, '2F 보조': 1, '2F 카트 내림': Number.POSITIVE_INFINITY };
  const DEFAULT_WORK_BLOCK_BY_WP = { '2F 엘베': 60, '2F 출차': 60, '3F': 60, '3F 카트 내림': 30, '2F 보조': 30, '2F 카트 내림': 30 };

// ===== 근무지 로테이션 엔진 v3 (완전 재작성) =====
// 목표:
// 1) 같은 근무지 연속 배치는 60분을 초과하지 않음 (연속 시간 제한은 workplaceScore에서 강제)
// 2) 가능한 범위에서 근무지를 '순차적으로' 순환: 직전 근무지 기준으로 사이클의 '다음 가능한' 근무지를 선택
//    사이클: 2F 엘베 → 2F 출차 → 3F → 3F 카트 내림 → 2F 카트 내림 → 2F 보조 → (반복)
//
// 설계:
// - 로테이션 정책을 하나의 객체로 캡슐화(함수 누락/스코프 오류 방지)
// - 제약(정원/식사·휴식 중 카트 금지 등) 때문에 '다음'이 불가능하면, 사이클에서 다음 가능한 자리로 스킵
// - 2F 보조는 후보가 여럿이면 자동으로 건너뜀(필요할 때만 선택)
const RotationPolicy = (() => {
  const cycle = ['2F 엘베', '2F 출차', '3F', EXTRA_WP_3F, EXTRA_WP, ASSIST_WP];
  const idx = Object.create(null);
  for (let i = 0; i < cycle.length; i++) idx[cycle[i]] = i;

  const OPTIONAL = new Set([ASSIST_WP]);

  function indexOf(wp) {
    return Object.prototype.hasOwnProperty.call(idx, wp) ? idx[wp] : -1;
  }

  function forwardDistance(from, to) {
    const a = indexOf(from);
    const b = indexOf(to);
    if (a < 0 || b < 0) return Number.POSITIVE_INFINITY;
    const n = cycle.length;
    let d = (b - a + n) % n;
    if (d === 0) d = n;
    return d;
  }

  function pickNextByCycle(prevWp, candidates) {
    const a = indexOf(prevWp);
    if (a < 0 || !candidates || candidates.length <= 1) return candidates;

    const candSet = new Set(candidates.map(c => c.wp));
    const allowOptional = candSet.size <= 1;
    const n = cycle.length;

    for (let step = 1; step <= n; step++) {
      const wp = cycle[(a + step) % n];
      if (!candSet.has(wp)) continue;
      if (!allowOptional && OPTIONAL.has(wp)) continue;
      const picked = candidates.filter(c => c.wp === wp);
      if (picked.length) return picked;
    }
    return candidates;
  }

  function chooseNearestForward(prevWp, candidates) {
    if (!prevWp || !candidates || candidates.length <= 1) return candidates;

    let best = Number.POSITIVE_INFINITY;
    for (const c of candidates) best = Math.min(best, forwardDistance(prevWp, c.wp));
    if (!Number.isFinite(best) || best === Number.POSITIVE_INFINITY) return candidates;

    const group = candidates.filter(c => forwardDistance(prevWp, c.wp) === best);
    return group.length ? group : candidates;
  }

  function filterCandidates(prevWp, candidates) {
    if (!prevWp || !candidates || candidates.length <= 1) return candidates;

    const forced = pickNextByCycle(prevWp, candidates);
    if (forced && forced.length && forced.length < candidates.length) return forced;

    const diff = candidates.filter(c => c.wp !== prevWp);
    const pool = diff.length ? diff : candidates;
    return chooseNearestForward(prevWp, pool);
  }

  return { cycle, forwardDistance, filterCandidates };
})();

function getDailyWpCapMin(worker, wp) {
  const isSix = worker && Number(worker.hours) === 6;
  // 업무별 1일(해당 근무자) 과도 반복 방지용 '소프트 상한'(분). 필요 시 초과 배정은 가능하되 강한 패널티가 붙음.
  if (wp === ASSIST_WP) return isSix ? 60 : 120;
  if (wp === EXTRA_WP || wp === EXTRA_WP_3F) return isSix ? 90 : 150; // 카트 내림(30분 블록이 많음)
  if (wp === '2F 엘베' || wp === '2F 출차' || wp === '3F') return isSix ? 120 : 180; // 60분 블록 중심
  return isSix ? 120 : 180;
}

function wouldBeOverused(worker, wp, addMin) {
  if (!worker || !worker.placeMinutes) return false;
  const cap = getDailyWpCapMin(worker, wp);
  const next = (worker.placeMinutes[wp] || 0) + addMin;
  return next > cap;
}

function applySequentialRotationFilter(candidates, rotationCtx, worker) {
  const prevWp = rotationCtx && rotationCtx.lastWp ? rotationCtx.lastWp : null;
  if (!prevWp || !candidates || candidates.length <= 1) return candidates;
  // 오픈조는 10:30 이후 초반 2~3블록에서 '미수행 근무지' 우선 로테이션을 강하게 적용하므로,
  // 순차 사이클 강제(필터)를 잠시 완화해 선택 폭을 넓힌다.
  if (worker && worker.group === '오픈조' && (worker._openWorkBlocksAfter1030 || 0) < 3) return candidates;

  const forced = RotationPolicy.filterCandidates(prevWp, candidates);
  const forcedIsSubset = forced && forced.length && forced.length < candidates.length;

  // 로테이션이 특정 업무로 '강제'되는 상황에서, 그 업무가 이미 하루 기준으로 과도 반복이라면 강제력을 완화한다.
  const nonOverused = candidates.filter(c => !wouldBeOverused(worker, c.wp, c.duration));
  const nonOverusedForced = (forced || candidates).filter(c => !wouldBeOverused(worker, c.wp, c.duration));

  if (nonOverusedForced.length) return nonOverusedForced;
  if (nonOverused.length) return RotationPolicy.filterCandidates(prevWp, nonOverused);

  // 모두 과도 반복 상태라면(인원 부족/제약 과다), 기존 강제 로테이션 유지
  return forcedIsSubset ? forced : candidates;
}


// ===== 1일 업무 편중(과도 반복) 방지: 하드 캡 기반 로테이션(구조 변경) =====
// v99의 '점수/패널티(소프트)' 방식만으로는 편중이 고착되는 케이스가 있어,
// '대안이 존재하면 상한 초과 업무를 후보에서 제외'하는 구조로 변경한다.

function computeExpectedWorkMin(worker) {
  if (!worker) return 0;
  const total = (worker.endMin - worker.startMin);
  let nonWork = 0;
  (worker.segments || []).forEach(function(seg) {
    if (!seg) return;
    if (seg.type === 'work') return;
    nonWork += (seg.end - seg.start);
  });
  return Math.max(0, total - nonWork);
}

// ===== Equal work-block counts by hours group (structural) =====
function computeWorkGapStats(worker) {
  if (!worker) return { minSeg: 0, maxSeg: 0 };
  const segs = (worker.segments || [])
    .filter(function(s) { return s && s.type !== 'work'; })
    .slice()
    .sort(function(a, b) {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });

  let cursor = worker.startMin;
  let minSeg = 0;
  let maxSeg = 0;

  for (const seg of segs) {
    if (cursor < seg.start) {
      const len = seg.start - cursor;
      if (len >= 30) {
        minSeg += Math.ceil(len / 60);
        maxSeg += Math.floor(len / 30);
      }
    }
    cursor = Math.max(cursor, seg.end);
  }
  if (cursor < worker.endMin) {
    const len = worker.endMin - cursor;
    if (len >= 30) {
      minSeg += Math.ceil(len / 60);
      maxSeg += Math.floor(len / 30);
    }
  }
  return { minSeg, maxSeg };
}

function initEqualWorkBlockTargets(workers, globalWarnings) {
  const byHours = new Map();
  (workers || []).forEach(function(w) {
    const h = Number(w.hours);
    if (!byHours.has(h)) byHours.set(h, []);
    byHours.get(h).push(w);
  });

  [6, 8].forEach(function(h) {
    const group = byHours.get(h) || [];
    if (!group.length) return;

    group.forEach(function(w) {
      const stats = computeWorkGapStats(w);
      w._minPossibleBlocks = stats.minSeg;
      w._maxPossibleBlocks = stats.maxSeg;
    });

    let groupMin = Math.max.apply(null, group.map(function(w) { return w._minPossibleBlocks || 0; }));
    let groupMax = Math.min.apply(null, group.map(function(w) { return w._maxPossibleBlocks || 0; }));

    // 모든 근무지 최소 1회 조건 때문에 최소 6블록 필요
    groupMin = Math.max(6, groupMin);
    groupMax = Math.max(6, groupMax);

    // 교집합이 없는 경우 경고
    let target = groupMin;
    if (groupMin > groupMax) {
      target = groupMin;
      if (globalWarnings) {
        globalWarnings.push('주의: ' + h + '시간 그룹에서 배치 횟수 동일 조건의 교집합이 비어 일부 완화될 수 있습니다. (min ' + groupMin + ' / max ' + groupMax + ')');
      }
    }

    group.forEach(function(w) {
      w._targetWorkBlocks = target;
      w._workBlocksAssigned = 0;
    });
  });
}


function computeDailyHardCaps(worker) {
  const isSix = worker && Number(worker.hours) === 6;
  const expected = computeExpectedWorkMin(worker);

  // 엄격한 기본 점유율 캡: 8h는 ~28%, 6h는 ~36%
  const baseShare = isSix ? 0.36 : 0.28;
  const base = Math.max(60, Math.round((expected * baseShare) / 5) * 5);

  const caps = Object.fromEntries(WORKPLACES.map(function(wp) { return [wp, base]; }));

  function setCap(wp, factor) {
    const v = Math.max(30, Math.round((base * factor) / 5) * 5);
    caps[wp] = v;
  }

  // 수요가 높은 3F는 약간 완화, 카트/보조는 더 엄격
  setCap('3F', 1.12);
  setCap(EXTRA_WP_3F, 0.88);
  setCap(EXTRA_WP, 0.88);
  setCap(ASSIST_WP, 0.70);

  // 안전장치: 기존 소프트 상한의 105%를 넘지 않도록 (필요 시 초과 배정은 '대안 없음'일 때만)
  WORKPLACES.forEach(function(wp) {
    const soft = getDailyWpCapMin(worker, wp);
    const maxAllowed = Math.round((soft * 1.05) / 5) * 5;
    caps[wp] = Math.min(caps[wp], maxAllowed);
    caps[wp] = Math.max(60, caps[wp]);
  });

  return { expectedWorkMin: expected, caps: caps };
}

function initWorkerRotationLimits(worker) {
  if (!worker) return;
  const res = computeDailyHardCaps(worker);
  worker.expectedWorkMin = res.expectedWorkMin;
  worker.rotationHardCaps = res.caps;
}

function applyDailyHardCapFilter(candidates, worker) {
  if (!worker || !worker.rotationHardCaps || !candidates || candidates.length <= 1) return candidates;
  const caps = worker.rotationHardCaps;
  const under = candidates.filter(function(c) {
    const used = (worker.placeMinutes && worker.placeMinutes[c.wp]) ? worker.placeMinutes[c.wp] : 0;
    const cap = Number.isFinite(caps[c.wp]) ? caps[c.wp] : Number.POSITIVE_INFINITY;
    return (used + c.duration) <= cap;
  });
  return under.length ? under : candidates;
}

function applyAntiPingPongFilter(candidates, rotationCtx, worker) {
  if (!candidates || candidates.length <= 1 || !rotationCtx || !worker) return candidates;

  // 초반엔 과도 제약 금지. 업무 누적 2시간 이상부터 동작.
  const progressed = (worker.totalWorkMinutesAssigned || 0) >= 120;
  if (!progressed) return candidates;

  // 사용한 업무 종류가 2개 이하일 때만 '두 업무 핑퐁' 차단을 강하게 건다.
  const usedPlaces = worker.placeMinutes ? Object.values(worker.placeMinutes).filter(function(m) { return m > 0; }).length : 0;
  if (usedPlaces > 2) return candidates;

  const last = rotationCtx.lastWp;
  const prev2 = rotationCtx.prev2Wp;
  const prev3 = rotationCtx.prev3Wp;

  if (!last || !prev2) return candidates;

  const avoid = new Set();

  // A-B-A: 다시 A(=prev2)로 돌아가는 후보를 우선 회피
  if (last !== prev2) avoid.add(prev2);

  // A-B-A-B: (가능하면) B로도 다시 돌아가지 않게 완화
  if (prev3 && prev3 === last) avoid.add(last);

  const filtered = candidates.filter(function(c) { return !avoid.has(c.wp); });
  return filtered.length ? filtered : candidates;
}


// ===== 1일 전체 근무지 1회 이상 보장(구조 변경) =====
// 각 근무자는 출근한 하루 동안 WORKPLACES의 모든 근무지를 최소 1회 이상 수행해야 한다.
// 이 조건은 '점수 우선'이 아니라, 가능한 후보가 있는 한 "미수행 근무지"만 후보로 제한하는 하드 제약으로 적용한다.

const MIN_ONCE_BLOCK_BY_WP = {
  '2F 엘베': 60,
  '2F 출차': 60,
  '3F': 60,
  '3F 카트 내림': 30,
  '2F 보조': 30,       // 보조는 30분도 허용(필요 시)
  '2F 카트 내림': 30
};

function initWorkerAllWpRequirement(worker) {
  if (!worker) return;
  worker.requiredWps = new Set(WORKPLACES);
  const requiredMin = WORKPLACES.reduce(function(sum, wp) { return sum + (MIN_ONCE_BLOCK_BY_WP[wp] || 30); }, 0);
  worker._allWpRequiredMin = requiredMin;
  const expected = computeExpectedWorkMin(worker);
  worker._allWpImpossible = expected < requiredMin;
}

function updateWorkerAllWpRequirement(worker, wp) {
  if (!worker || !worker.requiredWps) return;
  if (worker.requiredWps.has(wp)) worker.requiredWps.delete(wp);
}

function applyAllWpRequirementFilter(candidates, worker) {
  if (!worker || !worker.requiredWps || worker.requiredWps.size === 0 || !candidates || candidates.length <= 1) return candidates;
  const needed = candidates.filter(function(c) { return worker.requiredWps.has(c.wp); });
  return needed.length ? needed : candidates;
}

function applyAllWpRequirementFilterToWps(wpList, worker) {
  if (!worker || !worker.requiredWps || worker.requiredWps.size === 0 || !wpList || wpList.length <= 1) return wpList;
  const needed = wpList.filter(function(wp) { return worker.requiredWps.has(wp); });
  return needed.length ? needed : wpList;
}



// 오픈조 10:30 이후 초반 로테이션 강화: 첫 2~3블록은 '미수행 근무지'를 더 빠르게 채우도록
// (특히 카트/보조 같은 비고정 근무지를 먼저 채우고, 3번째 블록에서 고정(60분) 근무지를 우선)
function getOpenKickoffStage(worker, start) {
  if (!worker || worker.group !== '오픈조') return null;
  if (start < OPEN_NO_ASSIGN_UNTIL) return null;
  const idx = (worker._openWorkBlocksAfter1030 || 0);
  if (idx >= 3) return null;
  return idx; // 0,1,2
}

function applyOpenKickoffFilter(candidates, worker, start) {
  const stage = getOpenKickoffStage(worker, start);
  if (stage === null || !candidates || candidates.length <= 1) return candidates;
  if (!worker.requiredWps || worker.requiredWps.size === 0) return candidates;

  const needed = Array.from(worker.requiredWps);

  // stage 0~1: 비고정(카트/보조) 우선 + 가능한 경우 30~40분 블록으로 쪼개서 다양성 확보
  if (stage < 2) {
    const flexNeeded = needed.filter(wp => FIXED_60_WPS.indexOf(wp) === -1);
    if (flexNeeded.length) {
      const cartNeeded = flexNeeded.filter(wp => CART_WPS.indexOf(wp) !== -1);
      const target = cartNeeded.length ? new Set(cartNeeded) : new Set(flexNeeded);

      // 가능하면 30~40분으로 먼저 채우기
      const short = candidates.filter(c => target.has(c.wp) && c.duration <= 40);
      if (short.length) return short;

      const only = candidates.filter(c => target.has(c.wp));
      if (only.length) return only;
    }
  }

  // stage 2: 고정(60분) 근무지 우선 배치로 1회 수행을 빠르게 확보
  if (stage === 2) {
    const fixedNeeded = needed.filter(wp => FIXED_60_WPS.indexOf(wp) !== -1);
    if (fixedNeeded.length) {
      const target = new Set(fixedNeeded);
      const full = candidates.filter(c => target.has(c.wp) && c.duration === 60);
      if (full.length) return full;

      const only = candidates.filter(c => target.has(c.wp));
      if (only.length) return only;
    }
  }

  return candidates;
}

function applyOpenKickoffWpListFilter(wpList, worker, start) {
  const stage = getOpenKickoffStage(worker, start);
  if (stage === null || !wpList || wpList.length <= 1) return wpList;
  if (!worker.requiredWps || worker.requiredWps.size === 0) return wpList;

  const neededSet = worker.requiredWps;

  if (stage < 2) {
    const flex = wpList.filter(wp => neededSet.has(wp) && FIXED_60_WPS.indexOf(wp) === -1);
    if (flex.length) {
      const cart = flex.filter(wp => CART_WPS.indexOf(wp) !== -1);
      return cart.length ? cart : flex;
    }
  }

  if (stage === 2) {
    const fixed = wpList.filter(wp => neededSet.has(wp) && FIXED_60_WPS.indexOf(wp) !== -1);
    if (fixed.length) return fixed;
  }

  return wpList;
}

  const NON_CART_CAP_TOTAL = NON_CART_WPS.reduce(function(sum, wp) { return sum + (Number.isFinite(WP_CAPS[wp]) ? WP_CAPS[wp] : 0); }, 0);
  let CURRENT_MEAL_BREAK_COVERAGE = null;
  const CLOSE_GROUP_START = timeToMin('13:30');
  const OPEN_GROUP_START = timeToMin('08:30');
  const OPEN_FIXED_BREAK_START = timeToMin('09:30');
  const OPEN_NO_ASSIGN_UNTIL = timeToMin('10:30');
  const OPEN_FIXED_BREAK_MIN = 15;

  const CLOSING_LAST_BREAK_START = timeToMin('21:30');

  function getGroup(startMin) {
    if (startMin <= OPEN_GROUP_START + 5) return '오픈조';
    if (startMin >= CLOSE_GROUP_START) return '마감조';
    return '중간조';
  }

  function cloneWorker(w) {
    const startMin = timeToMin(w.startTime);
    const paidWorkMin = Number(w.hours) * 60;
    const endMin = startMin + paidWorkMin + MEAL_DURATION_MIN; // 식사 1시간 별도
    return {
      ...w,
      startMin,
      paidWorkMin,
      endMin,
      group: getGroup(startMin),
      segments: [],
      placeCounts: Object.fromEntries(WORKPLACES.map(p => [p, 0])),
      placeMinutes: Object.fromEntries(WORKPLACES.map(p => [p, 0])),
      totalWorkMinutesAssigned: 0,
      warnings: [],
      firstAssignedWp: null,
      _firstWpState: null,
      _openWorkBlocksAfter1030: 0,
      _segId: 0
    };
  }

  function normalizeClosingShiftWorkers(workers) {
    const closers = (workers || []).filter(function(w) { return w.group === '마감조'; });
    if (!closers.length) return { commonEnd: null, adjustments: [] };

    const commonEnd = Math.max.apply(null, closers.map(function(w) {
      return w.startMin + w.paidWorkMin + MEAL_DURATION_MIN;
    }));
    const adjustments = [];

    closers.forEach(function(w) {
      const originalStart = w.startMin;
      const originalEnd = w.endMin;
      const normalizedStart = commonEnd - (w.paidWorkMin + MEAL_DURATION_MIN);
      w.startMin = normalizedStart;
      w.startTime = minToTime(normalizedStart);
      w.endMin = commonEnd;
      w.group = getGroup(w.startMin);
      w._closeCommonEndMin = commonEnd;
      if (originalStart !== normalizedStart || originalEnd !== commonEnd) {
        adjustments.push(w.name + ' ' + minToTime(originalStart) + '→' + minToTime(normalizedStart));
        w.warnings.push('마감조 공통 퇴근시간 ' + minToTime(commonEnd) + ' 기준으로 출근 ' + minToTime(normalizedStart) + ' 조정');
      }
    });

    return { commonEnd: commonEnd, adjustments: adjustments };
  }

  function addSegment(worker, start, end, type, label) {
    if (end <= start) return null;
    const seg = { id: ++worker._segId, start, end, type, label };
    worker.segments.push(seg);
    return seg;
  }

  function canPlace(worker, start, end) {
    return !worker.segments.some(s => overlap(s.start, s.end, start, end));
  }

  function preservesMinWorkGap(worker, start, end) {
    if (!canPlace(worker, start, end)) return false;
    const segs = (worker.segments || []).slice().sort(function(a, b) {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });

    let prevBoundary = worker.startMin;
    let nextBoundary = worker.endMin;

    for (const seg of segs) {
      if (seg.end <= start) {
        prevBoundary = Math.max(prevBoundary, seg.end);
        continue;
      }
      if (seg.start >= end) {
        nextBoundary = seg.start;
        break;
      }
    }

    const leftGap = start - prevBoundary;
    const rightGap = nextBoundary - end;
    return (leftGap === 0 || leftGap >= 30) && (rightGap === 0 || rightGap >= 30);
  }

  function chooseGapChunkDuration(remain) {
    if (remain < 30) return 0;
    if (remain <= 60) return remain;
    if (remain < 90) return remain - 30;
    return 60;
  }

  function slotRange(start, end) {
    const out = [];
    for (let t = start; t < end; t += 5) out.push(t);
    return out;
  }

  function initCoverage() { return {}; }
  function getCounts(coverage, t) {
    if (!coverage[t]) coverage[t] = { '2F 엘베': 0, '2F 출차': 0, '3F': 0, '3F 카트 내림': 0, '2F 보조': 0, '2F 카트 내림': 0 };
    return coverage[t];
  }

  function getMealCount(mealCoverage, t) {
    if (mealCoverage[t] == null) mealCoverage[t] = 0;
    return mealCoverage[t];
  }

  function getSimpleCount(counter, t) {
    if (counter[t] == null) counter[t] = 0;
    return counter[t];
  }

  function addSimpleCoverage(counter, start, end, delta) {
    const d = Number.isFinite(delta) ? delta : 1;
    for (const t of slotRange(start, end)) counter[t] = getSimpleCount(counter, t) + d;
  }

  function buildPresentCoverage(workers) {
    const present = {};
    (workers || []).forEach(function(worker) {
      for (const t of slotRange(worker.startMin, worker.endMin)) present[t] = getSimpleCount(present, t) + 1;
    });
    return present;
  }

  function buildNonWorkCoverage(workers) {
    const nonWork = {};
    const mealBreak = {};
    (workers || []).forEach(function(worker) {
      (worker.segments || []).forEach(function(seg) {
        if (seg.type === 'meal' || seg.type === 'break' || seg.type === 'meeting' || seg.type === 'prep') addSimpleCoverage(nonWork, seg.start, seg.end, 1);
        if (seg.type === 'meal' || seg.type === 'break') addSimpleCoverage(mealBreak, seg.start, seg.end, 1);
      });
    });
    return { nonWork: nonWork, mealBreak: mealBreak };
  }

  function overlapsMealBreakWindow(start, end, mealBreakCoverage) {
    const ref = mealBreakCoverage || CURRENT_MEAL_BREAK_COVERAGE || {};
    for (const t of slotRange(start, end)) {
      if (getSimpleCount(ref, t) > 0) return true;
    }
    return false;
  }

  function canSupportCartFreeAbsence(start, end, presentCoverage, nonWorkCoverage) {
    for (const t of slotRange(start, end)) {
      const present = getSimpleCount(presentCoverage, t);
      const futureNonWork = getSimpleCount(nonWorkCoverage, t) + 1;
      const active = present - futureNonWork;
      if (active > NON_CART_CAP_TOTAL) return false;
    }
    return true;
  }


  function createSeed() {
    let seed = Date.now() ^ Math.floor(Math.random() * 0x7fffffff);
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        window.crypto.getRandomValues(buf);
        seed = (seed ^ buf[0]) >>> 0;
      }
    } catch (_) {}
    return (seed >>> 0) || 1;
  }

  function createRng(seed) {
    let state = (seed >>> 0) || 1;
    return {
      seed: state,
      next() {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      },
      int(max) {
        if (!Number.isFinite(max) || max <= 0) return 0;
        return Math.floor(this.next() * max);
      },
      pick(arr) {
        if (!arr || !arr.length) return null;
        return arr[this.int(arr.length)];
      }
    };
  }

  function randomizeEqualCandidates(items, getScore, rng, epsilon) {
    const eps = Number.isFinite(epsilon) ? epsilon : 0.000001;
    return items
      .map(function(item) { return { item: item, score: getScore(item), tie: rng ? rng.next() : Math.random() }; })
      .sort(function(a, b) {
        if (Math.abs(a.score - b.score) > eps) return a.score - b.score;
        return a.tie - b.tie;
      })
      .map(function(entry) { return entry.item; });
  }

  let lastScheduleFingerprint = null;

  function insertFixedMeeting(worker, meetingCounts, rng) {
    const overlapped = FIXED_EVENTS
      .map(ev => ({ ...ev, s: timeToMin(ev.start), e: timeToMin(ev.end) }))
      .filter(ev => overlap(worker.startMin, worker.endMin, ev.s, ev.e));
    if (!overlapped.length) return;

    let meetingCandidates = overlapped.slice();
    const minGapSafe = meetingCandidates.filter(function(ev) {
      return preservesMinWorkGap(worker, ev.s, ev.e);
    });
    if (minGapSafe.length) meetingCandidates = minGapSafe;

    const ordered = randomizeEqualCandidates(meetingCandidates, function(ev) {
      const gapPenalty = preservesMinWorkGap(worker, ev.s, ev.e) ? 0 : 100000;
      return gapPenalty + ((meetingCounts[ev.label] || 0) * 1000) + ev.s;
    }, rng, 0.5);

    const ev = ordered[0];
    addSegment(worker, ev.s, ev.e, ev.type, ev.label);
    meetingCounts[ev.label] = (meetingCounts[ev.label] || 0) + 1;
  }


function insertOpenShiftFixedBlocks(worker) {
  if (!worker || worker.group !== '오픈조') return;
  if (worker.endMin <= worker.startMin) return;

  const assignStart = OPEN_NO_ASSIGN_UNTIL;
  if (worker.startMin >= assignStart) return;

  const prepLabel = '오픈 준비(배정 없음)';
  const bStart = OPEN_FIXED_BREAK_START;
  const bEnd = bStart + OPEN_FIXED_BREAK_MIN;

  // 10:30까지는 근무지(work) 배정을 하지 않도록 prep 블록을 삽입
  const p1s = worker.startMin;
  const p1e = Math.min(bStart, assignStart, worker.endMin);
  if (p1e > p1s && canPlace(worker, p1s, p1e)) {
    addSegment(worker, p1s, p1e, 'prep', prepLabel);
  }

  // 09:30 1차 휴식(15분) 고정
  if (bStart >= worker.startMin && bEnd <= worker.endMin && bEnd <= assignStart && canPlace(worker, bStart, bEnd)) {
    addSegment(worker, bStart, bEnd, 'break', '휴식1(' + OPEN_FIXED_BREAK_MIN + '분)');
  }

  const p2s = Math.max(bEnd, worker.startMin);
  const p2e = Math.min(assignStart, worker.endMin);
  if (p2e > p2s && canPlace(worker, p2s, p2e)) {
    addSegment(worker, p2s, p2e, 'prep', prepLabel);
  }

  // 안내용(운영 규칙이므로 표시)
  worker.warnings.push('오픈조: 09:30 휴식1 고정 · 10:30까지 근무지 배정 없음');
}

  function canMealSlot(worker, start, end, mealCoverage) {
    if (worker.group !== '마감조') {
      for (const t of slotRange(start, end)) {
        if (getMealCount(mealCoverage, t) >= 2) return false;
      }
    }
    return true;
  }

  function canMealSlotCartFree(worker, start, end, mealCoverage, presentCoverage, nonWorkCoverage) {
    if (!canMealSlot(worker, start, end, mealCoverage)) return false;
    return canSupportCartFreeAbsence(start, end, presentCoverage, nonWorkCoverage);
  }

  function reserveMealSlot(worker, start, end, mealCoverage, nonWorkCoverage, mealBreakCoverage) {
    if (worker.group !== '마감조') {
      for (const t of slotRange(start, end)) mealCoverage[t] = getMealCount(mealCoverage, t) + 1;
    }
    addSimpleCoverage(nonWorkCoverage, start, end, 1);
    addSimpleCoverage(mealBreakCoverage, start, end, 1);
  }

  function mealLoadScore(start, end, mealCoverage) {
    let total = 0;
    for (const t of slotRange(start, end)) total += getMealCount(mealCoverage, t);
    return total;
  }

  function chooseMeal(worker, mealCoverage, preferredStartMin, rng, presentCoverage, nonWorkCoverage, mealBreakCoverage) {
    const target = worker.startMin + 195; // 출근 후 3시간15분
    const winStart = worker.startMin + 180;
    const winEnd = worker.startMin + 210;
    const earliest = Math.max(winStart, worker.startMin);
    const latest = Math.min(winEnd, worker.endMin - MEAL_DURATION_MIN);

    const candidates = [];
    function pushCandidate(s, preferred) {
      const e = s + MEAL_DURATION_MIN;
      if (s < earliest || s > latest) return;
      if (!preservesMinWorkGap(worker, s, e)) return;
      if (!canMealSlot(worker, s, e, mealCoverage)) return;
      const cartSafe = canSupportCartFreeAbsence(s, e, presentCoverage, nonWorkCoverage);
      candidates.push({
        s, e,
        preferred,
        cartSafe: cartSafe,
        load: mealLoadScore(s, e, mealCoverage),
        dist: Math.abs(s - target)
      });
    }

    if (Number.isFinite(preferredStartMin)) pushCandidate(preferredStartMin, -2);
    for (const t of MEAL_STARTS) pushCandidate(timeToMin(t), 0);
    for (let s = earliest; s <= latest; s += 5) {
      const isFixed = MEAL_STARTS.some(function(t) { return timeToMin(t) === s; });
      const preferred = (Number.isFinite(preferredStartMin) && s === preferredStartMin) ? -2 : (isFixed ? 0 : 1);
      pushCandidate(s, preferred);
    }

    if (candidates.length) {
      const ordered = randomizeEqualCandidates(candidates, function(c) {
        return (c.preferred * 1000000) + (c.cartSafe ? 0 : 20000) + (c.load * 1000) + c.dist + (c.s / 100000);
      }, rng, 0.5);
      const c = ordered[0];
      addSegment(worker, c.s, c.e, 'meal', '식사');
      reserveMealSlot(worker, c.s, c.e, mealCoverage, nonWorkCoverage, mealBreakCoverage);
      return;
    }

    // 1차: 카트내림 제외 조건까지 만족하는 식사 후보가 없을 수 있음
    worker.warnings.push('식사: 카트내림 제외 조건을 만족하는 시간대가 부족하여 일부 예외 배치');

    const fallback = [];
    for (let s = worker.startMin + 120; s + 60 <= worker.endMin - 30; s += 5) {
      const e = s + 60;
      if (!preservesMinWorkGap(worker, s, e)) continue;
      // 2차: 식사 보장을 위해 카트 제외 조건은 완화(식사 동시 인원 제한은 유지)
      if (!canMealSlot(worker, s, e, mealCoverage)) continue;
      const fixedDist = Math.min.apply(null, MEAL_STARTS.map(function(t) { return Math.abs(s - timeToMin(t)); }));
      const preferredDist = Number.isFinite(preferredStartMin) ? Math.abs(s - preferredStartMin) : 9999;
      fallback.push({ s: s, e: e, fixedDist: fixedDist, preferredDist: preferredDist, cartSafe: canSupportCartFreeAbsence(s, e, presentCoverage, nonWorkCoverage), load: mealLoadScore(s, e, mealCoverage), dist: Math.abs(s - target) });
    }
    if (fallback.length) {
      const ordered = randomizeEqualCandidates(fallback, function(c) {
        return (c.preferredDist * 1000000) + (c.cartSafe ? 0 : 20000) + (c.fixedDist * 10000) + (c.load * 100) + c.dist + (c.s / 100000);
      }, rng, 0.5);
      const c = ordered[0];
      addSegment(worker, c.s, c.e, 'meal', '식사');
      reserveMealSlot(worker, c.s, c.e, mealCoverage, nonWorkCoverage, mealBreakCoverage);
      if (Number.isFinite(preferredStartMin) && c.s !== preferredStartMin) {
        worker.warnings.push('선호 식사시각 ' + minToTime(preferredStartMin) + ' 대신 ' + minToTime(c.s) + ' 배치');
      }
    } else {
      // 3차: 식사는 최우선 보장 — 동시간 2명 제한/카트 제외 조건/30분 간격 규칙이 충돌해도 가능한 슬롯을 강제 탐색
      const forced = [];
      const earliestF = worker.startMin + 30;
      const latestF = worker.endMin - 30 - MEAL_DURATION_MIN;
      for (let s2 = earliestF; s2 <= latestF; s2 += 5) {
        const e2 = s2 + MEAL_DURATION_MIN;
        if (!canPlace(worker, s2, e2)) continue;
        const preserveOk = preservesMinWorkGap(worker, s2, e2);
        const cartSafe2 = canSupportCartFreeAbsence(s2, e2, presentCoverage, nonWorkCoverage);
        // 동시간 2명 제한은 '가중치'로만 반영 (초과 허용)
        const load2 = mealLoadScore(s2, e2, mealCoverage);
        const overCapPenalty = worker.group !== '마감조' ? Math.max(0, load2 - 2) * 120 : 0;
        const score2 = (Math.abs(s2 - target) / 5) + (cartSafe2 ? 0 : 40) + (preserveOk ? 0 : 140) + overCapPenalty;
        forced.push({ s: s2, e: e2, score: score2, cartSafe: cartSafe2 });
      }
      if (forced.length) {
        forced.sort(function(a, b) { return a.score - b.score; });
        const pick2 = rng ? (rng.pick(forced.slice(0, Math.min(8, forced.length))) || forced[0]) : forced[0];
        addSegment(worker, pick2.s, pick2.e, 'meal', '식사');
        reserveMealSlot(worker, pick2.s, pick2.e, mealCoverage, nonWorkCoverage, mealBreakCoverage);
        worker.warnings.push('식사 최우선 보장으로 강제 배치: ' + minToTime(pick2.s));
      } else {
        worker.warnings.push('식사 배치 불가(근무시간 내 빈 슬롯 부족)');
      }
    }
  }

  function validateFixedDurationPlaces(workers, labelFilter) {
    const issues = [];
    const allowed = Array.isArray(labelFilter) && labelFilter.length ? new Set(labelFilter) : null;
    for (const worker of workers) {
      const segments = (worker.segments || []).slice().sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
      for (const seg of segments) {
        if (seg.type !== 'work') continue;
        if (allowed && !allowed.has(seg.label)) continue;
        const duration = seg.end - seg.start;
        if (duration !== 60) {
          issues.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' ' + seg.label + ' ' + duration + '분');
        }
      }
    }
    return issues;
  }

  function validateMinWorkBlockDuration(workers) {
    const issues = [];
    for (const worker of (workers || [])) {
      const segments = (worker.segments || []).slice().sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
      for (const seg of segments) {
        if (seg.type !== 'work') continue;
        const duration = seg.end - seg.start;
        if (duration < 30) {
          issues.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' ' + seg.label + ' ' + duration + '분');
        }
      }
    }
    return issues;
  }

  function validateMaxWorkPerPlace(workers, labelFilter) {
    const issues = [];
    const allowed = Array.isArray(labelFilter) && labelFilter.length ? new Set(labelFilter) : null;
    for (const worker of workers) {
      const segments = (worker.segments || []).slice().sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });

      for (const seg of segments) {
        if (seg.type !== 'work') continue;
        if (allowed && !allowed.has(seg.label)) continue;
        if ((seg.end - seg.start) > 60) {
          issues.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' ' + seg.label + ' 단일 블록 ' + (seg.end - seg.start) + '분');
        }
      }

      let prev = null;
      let total = 0;
      for (const seg of segments) {
        if (seg.type !== 'work' || (allowed && !allowed.has(seg.label))) {
          prev = null;
          total = 0;
          continue;
        }
        if (prev && prev.type === 'work' && prev.label === seg.label && prev.end === seg.start) {
          total += (seg.end - seg.start);
        } else {
          total = (seg.end - seg.start);
        }
        if (total > 60) {
          issues.push(worker.name + ' ' + seg.label + ' 연속 근무 ' + total + '분');
        }
        prev = seg;
      }
    }
    return issues;
  }


  function validatePlaceCapViolations(coverage, placeFilter) {
    const issues = [];
    const allowed = Array.isArray(placeFilter) && placeFilter.length ? new Set(placeFilter) : null;
    const times = Object.keys(coverage || {}).map(Number).sort(function(a, b) { return a - b; });
    times.forEach(function(t) {
      const counts = coverage[t] || {};
      Object.keys(WP_CAPS).forEach(function(wp) {
        if (allowed && !allowed.has(wp)) return;
        const cap = WP_CAPS[wp];
        if (!Number.isFinite(cap)) return;
        const used = counts[wp] || 0;
        if (used > cap) issues.push(minToTime(t) + ' ' + wp + ' ' + used + '/' + cap);
      });
    });
    return issues;
  }

  function normalizePlaceCapViolations(workers, targetPlaces) {
    const targets = (targetPlaces || []).slice();
    const fixes = [];
    let changed = true;
    let pass = 0;

    function firstWorkSeg(worker) {
      const segs = (worker.segments || []).filter(function(s) { return s.type === 'work'; }).sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
      return segs[0] || null;
    }

    while (changed && pass < 12) {
      changed = false;
      pass += 1;
      const state = rebuildDerivedState(workers);
      const coverage = state.coverage;
      const times = Object.keys(coverage || {}).map(Number).sort(function(a, b) { return a - b; });

      outer:
      for (const t of times) {
        for (const wp of targets) {
          const used = ((coverage[t] || {})[wp]) || 0;
          const cap = WP_CAPS[wp];
          if (!Number.isFinite(cap) || used <= cap) continue;

          const offenders = [];
          workers.forEach(function(worker) {
            const seg = (worker.segments || []).find(function(s) {
              return s.type === 'work' && s.label === wp && s.start <= t && t < s.end;
            });
            if (seg) {
              const firstSeg = firstWorkSeg(worker);
              offenders.push({ worker: worker, seg: seg, isFirstWork: !!(firstSeg && firstSeg.start === seg.start && firstSeg.end === seg.end && firstSeg.label === seg.label) });
            }
          });

          offenders.sort(function(a, b) {
            if (a.isFirstWork !== b.isFirstWork) return a.isFirstWork ? 1 : -1;
            if (a.seg.start !== b.seg.start) return b.seg.start - a.seg.start;
            return (a.seg.end - a.seg.start) - (b.seg.end - b.seg.start);
          });

          for (const item of offenders) {
            const altOrder = [EXTRA_WP_3F, EXTRA_WP, '3F', '2F 엘베', '2F 출차'];
            const alternatives = altOrder.filter(function(alt) {
              if (alt === wp) return false;
              if ((item.seg.end - item.seg.start) !== 60 && FIXED_60_WPS.indexOf(alt) !== -1) return false;
              return true;
            });
            let moved = false;
            for (const alt of alternatives) {
              if (!canAssignToWp(alt, item.seg.start, item.seg.end, coverage)) continue;
              item.seg.label = alt;
              if (!item.worker.firstAssignedWp || item.worker.firstAssignedWp === wp) {
                const firstSeg = firstWorkSeg(item.worker);
                if (firstSeg && firstSeg.start === item.seg.start && firstSeg.end === item.seg.end) {
                  item.worker.firstAssignedWp = alt;
                }
              }
              fixes.push(item.worker.name + ' ' + minToTime(item.seg.start) + '~' + minToTime(item.seg.end) + ' ' + wp + '→' + alt);
              changed = true;
              moved = true;
              break;
            }
            if (moved) break outer;
          }
        }
      }
    }

    return fixes;
  }

  function pickRepairWorkplace(worker, blockedWp, start, end, coverage) {
    const duration = end - start;
    let candidateWps = AUTO_ASSIGN_WPS.filter(function(wp) { return wp !== blockedWp; });
    if (duration !== 60) {
      const flexOnly = candidateWps.filter(function(wp) { return FIXED_60_WPS.indexOf(wp) === -1; });
      if (flexOnly.length) candidateWps = flexOnly;
    }

    // 보조는 30분 블록에서만 사용
    if (duration !== 30) {
      const noAssistDur = candidateWps.filter(function(wp) { return wp !== ASSIST_WP; });
      if (noAssistDur.length) candidateWps = noAssistDur;
    }
    const nonAssist = candidateWps.filter(function(wp) { return wp !== ASSIST_WP; });
    if (nonAssist.length) candidateWps = nonAssist;
    if (worker && (worker.placeCounts[ASSIST_WP] || 0) >= MAX_ASSIST_PER_WORKER) {
      const noAssistRepair = candidateWps.filter(function(wp) { return wp !== ASSIST_WP; });
      if (noAssistRepair.length) candidateWps = noAssistRepair;
    }
    const candidates = candidateWps.map(function(wp) {
      let score = 0;
      for (const t of slotRange(start, end)) {
        const c = getCounts(coverage, t);
        const cap = WP_CAPS[wp];
        if (Number.isFinite(cap) && (c[wp] + 1) > cap) score += 1000;
        score += (c[wp] || 0) * 4;
        if (duration !== 60 && FIXED_60_WPS.indexOf(wp) !== -1) score += 5000;
        if (wp === ASSIST_WP) score += 220;
        if (wp === EXTRA_WP) score += 10;
        if (wp === EXTRA_WP_3F) score += 8;
        if (wp === '3F') score -= 10;
        if (wp === '2F 엘베' || wp === '2F 출차') score += 4;
      }
      if (worker && worker.placeCounts && (worker.placeCounts[ASSIST_WP] || 0) > 0 && wp === ASSIST_WP) score += 300;
      if (worker && worker.firstAssignedWp && wp === worker.firstAssignedWp) score += 8;
      return { wp: wp, score: score };
    }).sort(function(a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return a.wp.localeCompare(b.wp);
    });
    return candidates.length ? candidates[0].wp : ASSIST_WP;
  }

  function normalizeFixed60PlaceDurations(workers, fixedPlaces) {
    const fixedSet = new Set(fixedPlaces || []);
    const fixes = [];
    const state = rebuildDerivedState(workers);
    const coverage = state.coverage;

    workers.forEach(function(worker) {
      const segments = (worker.segments || []).slice().sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
      segments.forEach(function(seg) {
        if (seg.type !== 'work' || !fixedSet.has(seg.label)) return;
        const duration = seg.end - seg.start;
        if (duration === 60) return;

        for (const t of slotRange(seg.start, seg.end)) {
          const counts = getCounts(coverage, t);
          counts[seg.label] = Math.max(0, (counts[seg.label] || 0) - 1);
        }

        const oldLabel = seg.label;
        const replacement = pickRepairWorkplace(worker, seg.label, seg.start, seg.end, coverage);
        seg.label = replacement;
        fixes.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' ' + oldLabel + ' ' + duration + '분 → ' + replacement + ' 재배정');

        for (const t of slotRange(seg.start, seg.end)) {
          getCounts(coverage, t)[replacement] += 1;
        }
        if (worker.firstAssignedWp === oldLabel) {
          const firstSeg = segments.find(function(s) { return s.type === 'work'; });
          if (firstSeg && firstSeg.start === seg.start && firstSeg.end === seg.end) worker.firstAssignedWp = replacement;
        }
      });
      worker.segments = segments.sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
    });

    return fixes;
  }

  function normalizeProtectedPlaceChains(workers, protectedPlaces) {
    const protectedSet = new Set(protectedPlaces || []);
    const fixes = [];
    let changed = true;
    let pass = 0;

    while (changed && pass < 8) {
      changed = false;
      pass += 1;
      const state = rebuildDerivedState(workers);
      const coverage = state.coverage;

      workers.forEach(function(worker) {
        const segments = (worker.segments || []).slice().sort(function(a, b) {
          if (a.start !== b.start) return a.start - b.start;
          return a.end - b.end;
        });
        let chainLabel = null;
        let chainTotal = 0;
        let prevSeg = null;

        segments.forEach(function(seg) {
          if (seg.type !== 'work' || !protectedSet.has(seg.label)) {
            chainLabel = null;
            chainTotal = 0;
            prevSeg = seg;
            return;
          }

          const duration = seg.end - seg.start;
          const isContiguous = !!(prevSeg && prevSeg.type === 'work' && prevSeg.label === seg.label && prevSeg.end === seg.start && chainLabel === seg.label);
          const nextTotal = isContiguous ? (chainTotal + duration) : duration;

          if (!isContiguous || nextTotal <= 60) {
            chainLabel = seg.label;
            chainTotal = isContiguous ? nextTotal : duration;
            prevSeg = seg;
            return;
          }

          for (const t of slotRange(seg.start, seg.end)) {
            const counts = getCounts(coverage, t);
            counts[seg.label] = Math.max(0, (counts[seg.label] || 0) - 1);
          }

          const replacement = pickRepairWorkplace(worker, seg.label, seg.start, seg.end, coverage);
          const oldLabel = seg.label;
          seg.label = replacement;
          changed = true;
          fixes.push(worker.name + ' ' + oldLabel + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' → ' + replacement + ' 재배정');

          for (const t of slotRange(seg.start, seg.end)) {
            getCounts(coverage, t)[replacement] += 1;
          }

          if (protectedSet.has(replacement) && prevSeg && prevSeg.type === 'work' && prevSeg.label === replacement && prevSeg.end === seg.start) {
            chainLabel = replacement;
            chainTotal = (prevSeg.end - prevSeg.start) + duration;
          } else {
            chainLabel = replacement;
            chainTotal = duration;
          }
          prevSeg = seg;
        });

        worker.segments = segments.sort(function(a, b) {
          if (a.start !== b.start) return a.start - b.start;
          return a.end - b.end;
        });
      });
    }

    return fixes;
  }

  function ensureFullWorkAssignment(workers) {
    const fixes = [];
    const state = rebuildDerivedState(workers);
    const coverage = state.coverage;

    workers.forEach(function(worker) {
      const original = (worker.segments || []).slice().sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
      const rebuilt = [];
      let cursor = worker.startMin;

      function fillGap(start, end) {
        let t = start;
        while (t < end) {
          const remain = end - t;
          const dur = chooseGapChunkDuration(remain);
          if (dur <= 0) {
            fixes.push(worker.name + ' ' + minToTime(t) + '~' + minToTime(end) + ' 30분 미만 근무는 생성하지 않도록 보정에서 제외');
            break;
          }
          const forcedWp = chooseForcedWorkplace(worker, t, t + dur, coverage);
          rebuilt.push({ id: 'auto_fill_' + worker.id + '_' + t + '_' + (t + dur), start: t, end: t + dur, type: 'work', label: forcedWp });
          fixes.push(worker.name + ' ' + minToTime(t) + '~' + minToTime(t + dur) + ' ' + forcedWp + ' 보정배정');
          t += dur;
        }
      }

      original.forEach(function(seg) {
        if (cursor < seg.start) fillGap(cursor, seg.start);
        rebuilt.push(seg);
        cursor = Math.max(cursor, seg.end);
      });
      if (cursor < worker.endMin) fillGap(cursor, worker.endMin);

      worker.segments = rebuilt.sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
    });

    return fixes;
  }

  function countUnassignedMinutes(workers) {
    let total = 0;
    workers.forEach(function(worker) {
      const segments = (worker.segments || []).slice().sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
      let cursor = worker.startMin;
      segments.forEach(function(seg) {
        if (cursor < seg.start) total += (seg.start - cursor);
        cursor = Math.max(cursor, seg.end);
      });
      if (cursor < worker.endMin) total += (worker.endMin - cursor);
    });
    return total;
  }

  function normalizeCartDuringMealBreak(workers) {
    const fixes = [];
    const state = rebuildDerivedState(workers);
    const coverage = state.coverage;
    workers.forEach(function(worker) {
      const segments = (worker.segments || []).slice().sort(function(a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });
      segments.forEach(function(seg) {
        if (seg.type !== 'work' || CART_WPS.indexOf(seg.label) === -1) return;
        if (!overlapsMealBreakWindow(seg.start, seg.end)) return;

        for (const t of slotRange(seg.start, seg.end)) {
          const counts = getCounts(coverage, t);
          counts[seg.label] = Math.max(0, (counts[seg.label] || 0) - 1);
        }

        const alternatives = NON_CART_WPS.slice().filter(function(wp) { return canAssignToWp(wp, seg.start, seg.end, coverage); });
        if (alternatives.length) {
          const replacement = alternatives.sort(function(a, b) {
            const sa = workplaceScore(worker, a, seg.start, seg.end, coverage, getPrevContiguousWorkInfo(worker, seg.start));
            const sb = workplaceScore(worker, b, seg.start, seg.end, coverage, getPrevContiguousWorkInfo(worker, seg.start));
            return sa - sb;
          })[0];
          const old = seg.label;
          seg.label = replacement;
          for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[replacement] += 1;
          fixes.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' ' + old + '→' + replacement);
        } else {
          for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[seg.label] += 1;
        }
      });
      worker.segments = segments;
    });
    return fixes;
  }

  function normalizeAssistUsage(workers) {
    const fixes = [];
    let changed = true;
    let pass = 0;

    while (changed && pass < 6) {
      changed = false;
      pass += 1;
      const state = rebuildDerivedState(workers);
      const coverage = state.coverage;

      workers.forEach(function(worker) {
        const segments = (worker.segments || []).slice().sort(function(a, b) {
          if (a.start !== b.start) return a.start - b.start;
          return a.end - b.end;
        });
        const firstWork = segments.find(function(s) { return s.type === 'work'; }) || null;

        segments.forEach(function(seg) {
          if (seg.type !== 'work' || seg.label !== ASSIST_WP) return;

          for (const t of slotRange(seg.start, seg.end)) {
            const counts = getCounts(coverage, t);
            counts[ASSIST_WP] = Math.max(0, (counts[ASSIST_WP] || 0) - 1);
          }

          let candidateWps = ['3F', EXTRA_WP_3F, EXTRA_WP, '2F 엘베', '2F 출차'].filter(function(wp) {
            if ((seg.end - seg.start) !== 60 && FIXED_60_WPS.indexOf(wp) !== -1) return false;
            if (firstWork && firstWork.start === seg.start && firstWork.end === seg.end && CART_WPS.indexOf(wp) !== -1) return false;
            return canAssignToWp(wp, seg.start, seg.end, coverage);
          });

          if (!candidateWps.length) {
            if (canAssignToWp(ASSIST_WP, seg.start, seg.end, coverage)) {
              for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[ASSIST_WP] += 1;
            } else {
              const emergency = [EXTRA_WP_3F, EXTRA_WP, '3F', '2F 엘베', '2F 출차'].find(function(wp) {
                if ((seg.end - seg.start) !== 60 && FIXED_60_WPS.indexOf(wp) !== -1) return false;
                if (firstWork && firstWork.start === seg.start && firstWork.end === seg.end && CART_WPS.indexOf(wp) !== -1) return false;
                return canAssignToWp(wp, seg.start, seg.end, coverage);
              });
              if (emergency) {
                seg.label = emergency;
                for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[emergency] += 1;
                fixes.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' ' + ASSIST_WP + '→' + emergency);
              } else {
                for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[ASSIST_WP] += 1;
              }
            }
            return;
          }

          candidateWps = candidateWps.sort(function(a, b) {
            function scoreFor(wp) {
              let score = workplaceScore(worker, wp, seg.start, seg.end, coverage, getPrevContiguousWorkInfo(worker, seg.start));
              if (wp === '3F') score -= 20;
              if (wp === EXTRA_WP_3F) score -= 14;
              if (wp === EXTRA_WP) score -= 10;
              if (wp === '2F 엘베' || wp === '2F 출차') score += 8;
              return score;
            }
            const sa = scoreFor(a);
            const sb = scoreFor(b);
            if (sa !== sb) return sa - sb;
            return a.localeCompare(b);
          });

          const replacement = candidateWps[0];
          seg.label = replacement;
          for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[replacement] += 1;
          fixes.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' 보조→' + replacement + ' 축소');
          changed = true;
        });

        worker.segments = segments;
      });
    }

    return fixes;
  }


  function validateAssistLimit(workers) {
    const issues = [];
    (workers || []).forEach(function(worker) {
      const assistCount = (worker.segments || []).filter(function(seg) { return seg.type === 'work' && seg.label === ASSIST_WP; }).length;
      if (assistCount > MAX_ASSIST_PER_WORKER) {
        issues.push(worker.name + ' 보조 ' + assistCount + '회 / 기준 ' + MAX_ASSIST_PER_WORKER + '회');
      }
    });
    return issues;
  }
  function validateAllWorkplacesAtLeastOnce(workers) {
    const issues = [];
    (workers || []).forEach(function(w) {
      const missing = WORKPLACES.filter(function(wp) { return (w.placeCounts && (w.placeCounts[wp] || 0) > 0) ? false : true; });
      if (missing.length) {
        issues.push(w.name + ': ' + missing.join(', '));
      }
    });
    return issues;
  }



  function validateCartDuringMealBreak(workers) {
    const issues = [];
    (workers || []).forEach(function(worker) {
      (worker.segments || []).forEach(function(seg) {
        if (seg.type !== 'work' || CART_WPS.indexOf(seg.label) === -1) return;
        if (overlapsMealBreakWindow(seg.start, seg.end)) {
          issues.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' ' + seg.label);
        }
      });
    });
    return issues;
  }

  function rebuildDerivedState(workers) {
    const coverage = initCoverage();
    const mealCoverage = {};
    const meetingCounts = Object.fromEntries(FIXED_EVENTS.map(function(ev) { return [ev.label, 0]; }));

    workers.forEach(function(worker) {
      worker.placeCounts = Object.fromEntries(WORKPLACES.map(function(p) { return [p, 0]; }));
      worker.placeMinutes = Object.fromEntries(WORKPLACES.map(function(p) { return [p, 0]; }));
      worker.totalWorkMinutesAssigned = 0;
      (worker.segments || []).forEach(function(seg) {
        if (seg.type === 'work' && seg.label && coverage) {
          for (const t of slotRange(seg.start, seg.end)) {
            getCounts(coverage, t)[seg.label] += 1;
          }
          worker.placeCounts[seg.label] = (worker.placeCounts[seg.label] || 0) + 1;
          if (worker.placeMinutes) worker.placeMinutes[seg.label] = (worker.placeMinutes[seg.label] || 0) + (seg.end - seg.start);
          worker.totalWorkMinutesAssigned = (worker.totalWorkMinutesAssigned || 0) + (seg.end - seg.start);
        }
        if (seg.type === 'meal' && worker.group !== '마감조') {
          for (const t of slotRange(seg.start, seg.end)) {
            mealCoverage[t] = getMealCount(mealCoverage, t) + 1;
          }
        }
        if (seg.type === 'meeting') {
          meetingCounts[seg.label] = (meetingCounts[seg.label] || 0) + 1;
        }
      });
    });

    return { coverage: coverage, mealCoverage: mealCoverage, meetingCounts: meetingCounts };
  }

  function getBreaksForWorker(worker) {
    return Number(worker.hours) === 6 ? SIX_HOUR_BREAKS.slice() : BREAKS.slice();
  }

  function chooseBreaks(worker, rng, presentCoverage, nonWorkCoverage, mealBreakCoverage) {
    const breaks = getBreaksForWorker(worker);
    const isSixHour = Number(worker.hours) === 6;
    const targetOffsets = isSixHour ? [90, null] : [90, 185, null];
    const lastBreakIndex = breaks.length - 1;
    let lastBreakEnd = null;
    let startIndex = 0;

    // 오픈조: 09:30 1차 휴식이 고정된 경우(휴식1), 나머지 휴식만 배치
    if (worker.group === '오픈조') {
      const fixed = (worker.segments || [])
        .filter(function(s) { return s && s.type === 'break'; })
        .slice()
        .sort(function(a, b) { return a.start - b.start; })
        .find(function(s) { return s.start === OPEN_FIXED_BREAK_START && (s.end - s.start) === OPEN_FIXED_BREAK_MIN; });
      if (fixed) {
        startIndex = 1;
        lastBreakEnd = fixed.end;
      }
    }

    function getBreakTargetWindow(index, dur) {
      if (index === lastBreakIndex) {
        if (worker.group === '마감조') {
          return {
            target: CLOSING_LAST_BREAK_START,
            minStart: CLOSING_LAST_BREAK_START,
            maxStart: CLOSING_LAST_BREAK_START
          };
        }
        return {
          target: worker.endMin - 105,
          minStart: worker.endMin - 120,
          maxStart: worker.endMin - 90
        };
      }
      return {
        target: worker.startMin + targetOffsets[index],
        minStart: worker.startMin + 30,
        maxStart: worker.endMin - 30 - dur
      };
    }

    function isBreakWindowValid(index, s, e, dur) {
      if (s < worker.startMin + 30) return false;
      if (e > worker.endMin - 30) return false;
      const win = getBreakTargetWindow(index, dur);
      if (index === lastBreakIndex) {
        if (s < win.minStart || s > win.maxStart) return false;
      }
      if (lastBreakEnd == null) {
        if (s - worker.startMin > 120) return false;
      } else {
        const gapFromPrevBreak = s - lastBreakEnd;
        if (gapFromPrevBreak <= 60) return false;
        if (gapFromPrevBreak > 120) return false;
      }
      return true;
    }

    for (let i = startIndex; i < breaks.length; i++) {
      const dur = breaks[i];
      const breakWindow = getBreakTargetWindow(i, dur);
      const target = breakWindow.target;
      let candidates = [];
      let bestScore = Number.POSITIVE_INFINITY;

      for (let delta = 0; delta <= 120; delta += 5) {
        const tryStarts = delta === 0 ? [target] : [target - delta, target + delta];
        for (const s of tryStarts) {
          const e = s + dur;
          if (!isBreakWindowValid(i, s, e, dur)) continue;
          if (!preservesMinWorkGap(worker, s, e)) continue;
          // 1차: 카트내림 제외(남은 인원 수용 가능) 후보를 우선하되, 식사/휴식 보장을 위해 불가 후보도 허용(가중치로만 불리)
          const cartSafe = canSupportCartFreeAbsence(s, e, presentCoverage, nonWorkCoverage);
          const cartPenalty = cartSafe ? 0 : 250;
          const gapPenalty = lastBreakEnd == null ? 0 : Math.abs((s - lastBreakEnd) - 70) / 10;
          const score = Math.abs(s - target) + gapPenalty + cartPenalty;
          if (score < bestScore) {
            bestScore = score;
            candidates = [{ s: s, e: e, score: score }];
          } else if (score === bestScore) {
            candidates.push({ s: s, e: e, score: score });
          }
        }
        if (candidates.length) break;
      }

      const best = candidates.length ? (rng ? rng.pick(candidates) : candidates[0]) : null;
      if (best) {
        addSegment(worker, best.s, best.e, 'break', '휴식' + (i + 1) + '(' + dur + '분)');
        addSimpleCoverage(nonWorkCoverage, best.s, best.e, 1);
        addSimpleCoverage(mealBreakCoverage, best.s, best.e, 1);
        lastBreakEnd = best.e;
      } else {
        // 2차: 휴식 보장을 위해 카트 제외 수용 조건은 완화(간격 규칙/배치 가능 여부는 유지)
        const relaxed = [];
        for (let delta = 0; delta <= 120; delta += 5) {
          const tryStarts = delta === 0 ? [target] : [target - delta, target + delta];
          for (const s of tryStarts) {
            const e = s + dur;
            if (!isBreakWindowValid(i, s, e, dur)) continue;
            if (!preservesMinWorkGap(worker, s, e)) continue;
            const cartSafe2 = canSupportCartFreeAbsence(s, e, presentCoverage, nonWorkCoverage);
            const cartPenalty2 = cartSafe2 ? 0 : 150;
            const score = Math.abs(s - target) + cartPenalty2;
            relaxed.push({ s: s, e: e, score: score });
          }
          if (relaxed.length) break;
        }
        if (relaxed.length) {
          worker.warnings.push('휴식: 카트내림 제외 조건을 만족하는 시간대가 부족하여 예외 배치');
          const pick = rng ? rng.pick(relaxed) : relaxed[0];
          addSegment(worker, pick.s, pick.e, 'break', '휴식' + (i + 1) + '(' + dur + '분)');
          addSimpleCoverage(nonWorkCoverage, pick.s, pick.e, 1);
          addSimpleCoverage(mealBreakCoverage, pick.s, pick.e, 1);
          lastBreakEnd = pick.e;
        } else {
          // 3차: 어떤 경우에도 휴식은 '최우선 보장' — 가능한 모든 시간대에서 강제 탐색
          const forced = [];
          const earliestForce = worker.startMin + 30;
          const latestForce = worker.endMin - 30 - dur;
          for (let s2 = earliestForce; s2 <= latestForce; s2 += 5) {
            const e2 = s2 + dur;
            if (!canPlace(worker, s2, e2)) continue;

            const preserveOk = preservesMinWorkGap(worker, s2, e2);
            const cartSafe2 = canSupportCartFreeAbsence(s2, e2, presentCoverage, nonWorkCoverage);

            const gapFromPrev = lastBreakEnd == null ? (s2 - worker.startMin) : (s2 - lastBreakEnd);
            const gapPenalty2 = (lastBreakEnd == null)
              ? (gapFromPrev > 120 ? (gapFromPrev - 120) / 5 : 0)
              : (gapFromPrev <= 60 ? 80 : 0);

            const targetPenalty2 = Math.abs(s2 - target) / 5;
            const preservePenalty2 = preserveOk ? 0 : 120;
            const cartPenalty2 = cartSafe2 ? 0 : 40;
            const lastBias = (i === lastBreakIndex && worker.group === '마감조') ? (Math.abs(s2 - CLOSING_LAST_BREAK_START) / 5) : 0;

            forced.push({ s: s2, e: e2, score: targetPenalty2 + gapPenalty2 + preservePenalty2 + cartPenalty2 + lastBias });
          }

          if (forced.length) {
            forced.sort(function(a, b) { return a.score - b.score; });
            const top = forced.slice(0, Math.min(8, forced.length));
            const pick2 = rng ? (rng.pick(top) || top[0]) : top[0];
            worker.warnings.push('휴식 ' + (i + 1) + ' (' + dur + '분) 최우선 보장으로 강제 배치: ' + minToTime(pick2.s));
            addSegment(worker, pick2.s, pick2.e, 'break', '휴식' + (i + 1) + '(' + dur + '분)');
            addSimpleCoverage(nonWorkCoverage, pick2.s, pick2.e, 1);
            addSimpleCoverage(mealBreakCoverage, pick2.s, pick2.e, 1);
            lastBreakEnd = pick2.e;
          } else {
            worker.warnings.push('휴식 ' + (i + 1) + ' (' + dur + '분) 배치 실패(근무시간 내 빈 슬롯 부족)');
          }
        }
      }
    }
  }

  function validateBreakRules(workers) {
    const issues = [];
    (workers || []).forEach(function(worker) {
      const breakSegs = (worker.segments || [])
        .filter(function(seg) { return seg.type === 'break'; })
        .slice()
        .sort(function(a, b) { return a.start - b.start; });
      const expected = getBreaksForWorker(worker);
      const actual = breakSegs.map(function(seg) { return seg.end - seg.start; });

      if (actual.length !== expected.length) {
        issues.push(worker.name + ' 휴식 개수 ' + actual.length + '회 / 기준 ' + expected.length + '회');
        return;
      }

      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
          issues.push(worker.name + ' 휴식' + (i + 1) + ' ' + actual[i] + '분 / 기준 ' + expected[i] + '분');
        }
      }

      for (let i = 1; i < breakSegs.length; i++) {
        const gap = breakSegs[i].start - breakSegs[i - 1].end;
        if (gap <= 60) {
          issues.push(worker.name + ' 휴식' + i + '→' + (i + 1) + ' 간격 ' + gap + '분 / 기준 60분 초과');
        }
      }

      if (breakSegs.length) {
        const lastBreak = breakSegs[breakSegs.length - 1];
        if (worker.group === '마감조') {
          if (lastBreak.start !== CLOSING_LAST_BREAK_START) {
            issues.push(worker.name + ' 마지막 휴식 시작 ' + minToTime(lastBreak.start) + ' / 기준 21:30');
          }
        } else {
          const minsBeforeEnd = worker.endMin - lastBreak.start;
          if (minsBeforeEnd < 90 || minsBeforeEnd > 120) {
            issues.push(worker.name + ' 마지막 휴식 시작 ' + minsBeforeEnd + '분 전 / 기준 퇴근 90~120분 전');
          }
        }
      }
    });
    return issues;
  }

  function getPrevContiguousWorkInfo(worker, atTime) {
    // atTime 직전까지 연속된 같은 근무지 누적 시간을 계산 + 최근 작업 히스토리(ABA/ABAB 회피용)
    let cursor = atTime;
    let lastWp = null;
    let total = 0;

    function findPrevWorkEnding(endMin) {
      return worker.segments
        .filter(s => s.type === 'work' && s.end === endMin)
        .sort((a, b) => a.start - b.start)
        .slice(-1)[0] || null;
    }

    while (true) {
      const prev = findPrevWorkEnding(cursor);
      if (!prev) break;

      if (lastWp == null) {
        lastWp = prev.label;
        total += (prev.end - prev.start);
        cursor = prev.start;
        continue;
      }

      if (prev.label !== lastWp) break;
      total += (prev.end - prev.start);
      cursor = prev.start;
    }

    // 연속 구간 직전의 근무지(2번째, 3번째 최근) 기록
    let prev2Wp = null;
    let prev3Wp = null;
    const prev2 = findPrevWorkEnding(cursor);
    if (prev2) {
      prev2Wp = prev2.label;
      const prev3 = findPrevWorkEnding(prev2.start);
      if (prev3) prev3Wp = prev3.label;
    }

    return { lastWp, contiguousMin: total, prev2Wp, prev3Wp };
  }

  function canAssignToWp(wp, start, end, coverage) {
    if (CART_WPS.indexOf(wp) !== -1 && overlapsMealBreakWindow(start, end)) return false;
    for (const t of slotRange(start, end)) {
      const c = getCounts(coverage, t);
      if (wp === ASSIST_WP && (c[ASSIST_WP] || 0) >= 1) return false;
      if ((c[wp] + 1) > WP_CAPS[wp]) return false;
    }
    return true;
  }


  function normalizeSingleAssistPerTimeslot(workers) {
    const fixes = [];
    let changed = true;
    let pass = 0;

    function candidateScore(worker, seg, wp, coverage) {
      let score = workplaceScore(worker, wp, seg.start, seg.end, coverage, getPrevContiguousWorkInfo(worker, seg.start));
      if (!Number.isFinite(score)) score = 1e9;
      if (wp === '3F') score -= 20;
      if (wp === EXTRA_WP_3F) score -= 14;
      if (wp === EXTRA_WP) score -= 10;
      if (wp === '2F 엘베' || wp === '2F 출차') score += 8;
      return score;
    }

    while (changed && pass < 8) {
      changed = false;
      pass += 1;

      const state = rebuildDerivedState(workers);
      const coverage = state.coverage;
      const overloaded = Object.keys(coverage)
        .map(function(k) { return Number(k); })
        .sort(function(a, b) { return a - b; })
        .filter(function(t) { return ((coverage[t] && coverage[t][ASSIST_WP]) || 0) > 1; });

      if (!overloaded.length) break;

      let movedInPass = false;

      for (let idx = 0; idx < overloaded.length; idx += 1) {
        const t = overloaded[idx];
        const active = [];
        (workers || []).forEach(function(worker) {
          (worker.segments || []).forEach(function(seg) {
            if (seg.type !== 'work' || seg.label !== ASSIST_WP) return;
            if (seg.start <= t && seg.end > t) active.push({ worker: worker, seg: seg });
          });
        });

        if (active.length <= 1) continue;

        active.sort(function(a, b) {
          const aCount = a.worker.placeCounts ? (a.worker.placeCounts[ASSIST_WP] || 0) : 0;
          const bCount = b.worker.placeCounts ? (b.worker.placeCounts[ASSIST_WP] || 0) : 0;
          if (aCount !== bCount) return aCount - bCount;
          if (a.seg.start !== b.seg.start) return a.seg.start - b.seg.start;
          return a.worker.name.localeCompare(b.worker.name);
        });

        for (let i = 1; i < active.length; i += 1) {
          const item = active[i];
          const worker = item.worker;
          const seg = item.seg;
          const firstWork = (worker.segments || []).find(function(s) { return s.type === 'work'; }) || null;
          const duration = seg.end - seg.start;

          for (const slot of slotRange(seg.start, seg.end)) {
            const counts = getCounts(coverage, slot);
            counts[ASSIST_WP] = Math.max(0, (counts[ASSIST_WP] || 0) - 1);
          }

          let candidates = ['3F', EXTRA_WP_3F, EXTRA_WP, '2F 엘베', '2F 출차'].filter(function(wp) {
            if (FIXED_60_WPS.indexOf(wp) !== -1 && duration !== 60) return false;
            if (firstWork && firstWork.start === seg.start && firstWork.end === seg.end && CART_WPS.indexOf(wp) !== -1) return false;
            return canAssignToWp(wp, seg.start, seg.end, coverage);
          });

          if (!candidates.length) {
            candidates = ['3F', EXTRA_WP_3F, EXTRA_WP, '2F 엘베', '2F 출차'].filter(function(wp) {
              if (FIXED_60_WPS.indexOf(wp) !== -1 && duration !== 60) return false;
              return canAssignToWp(wp, seg.start, seg.end, coverage);
            });
          }

          if (!candidates.length) {
            for (const slot of slotRange(seg.start, seg.end)) {
              const counts = getCounts(coverage, slot);
              counts[ASSIST_WP] = (counts[ASSIST_WP] || 0) + 1;
            }
            continue;
          }

          candidates.sort(function(a, b) {
            const sa = candidateScore(worker, seg, a, coverage);
            const sb = candidateScore(worker, seg, b, coverage);
            if (sa !== sb) return sa - sb;
            return a.localeCompare(b);
          });

          const replacement = candidates[0];
          seg.label = replacement;
          for (const slot of slotRange(seg.start, seg.end)) {
            const counts = getCounts(coverage, slot);
            counts[replacement] = (counts[replacement] || 0) + 1;
          }
          fixes.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' 2F 보조→' + replacement + ' (동시간 보조 1명 초과 보정)');
          changed = true;
          movedInPass = true;
          break;
        }

        if (movedInPass) break;
      }

      if (!movedInPass) break;
    }

    return fixes;
  }

  function demoteAutoAssistToNonAssist(workers) {
    const fixes = [];
    const state = rebuildDerivedState(workers);
    const coverage = state.coverage;
    (workers || []).forEach(function(worker) {
      const firstWork = (worker.segments || []).find(function(s) { return s.type === 'work'; }) || null;
      (worker.segments || []).forEach(function(seg) {
        if (seg.type !== 'work' || seg.label !== ASSIST_WP) return;
        for (const t of slotRange(seg.start, seg.end)) {
          const counts = getCounts(coverage, t);
          counts[ASSIST_WP] = Math.max(0, (counts[ASSIST_WP] || 0) - 1);
        }
        const duration = seg.end - seg.start;
        const candidates = [EXTRA_WP_3F, EXTRA_WP, '3F', '2F 엘베', '2F 출차'].filter(function(wp) {
          if (FIXED_60_WPS.indexOf(wp) !== -1 && duration !== 60) return false;
          if (firstWork && firstWork.start === seg.start && firstWork.end === seg.end && CART_WPS.indexOf(wp) !== -1) return false;
          return canAssignToWp(wp, seg.start, seg.end, coverage);
        });
        if (candidates.length) {
          const replacement = candidates[0];
          seg.label = replacement;
          for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[replacement] += 1;
          fixes.push(worker.name + ' ' + minToTime(seg.start) + '~' + minToTime(seg.end) + ' 2F 보조→' + replacement + ' (자동 생성 보조 축소)');
        } else {
          for (const t of slotRange(seg.start, seg.end)) getCounts(coverage, t)[ASSIST_WP] += 1;
        }
      });
    });
    return fixes;
  }

  function validateSingleAssistPerTimeslot(workers) {
    const coverage = {};
    const issues = [];
    (workers || []).forEach(function(worker) {
      (worker.segments || []).forEach(function(seg) {
        if (seg.type !== 'work' || seg.label !== ASSIST_WP) return;
        for (const t of slotRange(seg.start, seg.end)) {
          const counts = getCounts(coverage, t);
          counts[ASSIST_WP] = (counts[ASSIST_WP] || 0) + 1;
        }
      });
    });
    const times = Object.keys(coverage).map(function(k) { return Number(k); }).sort(function(a, b) { return a - b; });
    let runStart = null;
    let prev = null;
    let peak = 0;
    times.forEach(function(t) {
      const current = ((coverage[t] && coverage[t][ASSIST_WP]) || 0);
      if (current > 1) {
        if (runStart === null) {
          runStart = t;
          peak = current;
        }
        peak = Math.max(peak, current);
        prev = t;
      } else if (runStart !== null) {
        issues.push(minToTime(runStart) + '~' + minToTime(prev + 5) + ' 2F 보조 ' + peak + '명');
        runStart = null;
        prev = null;
        peak = 0;
      }
    });
    if (runStart !== null) issues.push(minToTime(runStart) + '~' + minToTime(prev + 5) + ' 2F 보조 ' + peak + '명');
    return issues;
  }

// ===== 스왑 후처리: 커버리지는 유지하면서 '개인별 업무 과도 반복'을 추가 완화 =====
// 같은 시간 구간(start-end)이 동일한 work 세그먼트끼리 업무(label)를 교환하면
// 시간대별 근무지 인원 수(coverage)는 유지되면서, 개인 편중만 줄일 수 있다.
function rebalanceDailyJobRepetitionBySwaps(workers, rng) {
  const list = Array.isArray(workers) ? workers.slice() : [];
  const state = new Map();

  function isFixed60(wp) { return FIXED_60_WPS.indexOf(wp) !== -1; }

  list.forEach(function(w) {
    w.segments = (w.segments || []).slice().sort(function(a, b) {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });
    const workSegs = w.segments.filter(function(s) { return s.type === 'work'; });
    const firstWork = workSegs.length ? workSegs[0] : null;

    const minutes = Object.fromEntries(WORKPLACES.map(function(p) { return [p, 0]; }));
    workSegs.forEach(function(seg) {
      if (!seg.label) return;
      minutes[seg.label] = (minutes[seg.label] || 0) + (seg.end - seg.start);
    });

    state.set(w.id, { worker: w, workSegs: workSegs, firstWork: firstWork, minutes: minutes });
  });

  const byKey = new Map();
  list.forEach(function(w) {
    const st = state.get(w.id);
    st.workSegs.forEach(function(seg) {
      const key = seg.start + '-' + seg.end;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ worker: w, seg: seg });
    });
  });

  function getCap(w, wp) {
    if (w && w.rotationHardCaps && Number.isFinite(w.rotationHardCaps[wp])) return w.rotationHardCaps[wp];
    return getDailyWpCapMin(w, wp);
  }

  function maxExcess(st) {
    const w = st.worker;
    let bestWp = null;
    let bestEx = 0;
    WORKPLACES.forEach(function(wp) {
      const cap = getCap(w, wp);
      const used = st.minutes[wp] || 0;
      const ex = Math.max(0, used - cap);
      if (ex > bestEx) { bestEx = ex; bestWp = wp; }
    });
    return { wp: bestWp, excess: bestEx };
  }

  function wouldViolateChain(w, seg, newWp) {
    const segs = (w.segments || []).filter(function(s) { return s.type === 'work'; })
      .slice().sort(function(a,b) { return a.start - b.start; });
    const i = segs.indexOf(seg);
    if (i < 0) return false;

    const dur = seg.end - seg.start;
    // 3F/엘베/출차는 연속 반복 금지(기존 정책 유지)
    const noRepeat = (newWp === '3F' || newWp === '2F 엘베' || newWp === '2F 출차');
    let total = dur;

    let cursorStart = seg.start;
    for (let k = i - 1; k >= 0; k--) {
      const p = segs[k];
      if (p.end !== cursorStart) break;
      if (p.label !== newWp) break;
      if (noRepeat) return true;
      total += (p.end - p.start);
      cursorStart = p.start;
    }

    let cursorEnd = seg.end;
    for (let k = i + 1; k < segs.length; k++) {
      const n = segs[k];
      if (n.start !== cursorEnd) break;
      if (n.label !== newWp) break;
      if (noRepeat) return true;
      total += (n.end - n.start);
      cursorEnd = n.end;
    }

    return total > 60;
  }

  function canWorkerTake(st, seg, newWp) {
    const w = st.worker;
    const dur = seg.end - seg.start;

    // 첫 work 세그먼트는 스왑하지 않는다(첫 배정 정책/표시 일관성 유지)
    if (st.firstWork && seg === st.firstWork) return false;

    if (isFixed60(newWp) && dur !== 60) return false;
    if (newWp === EXTRA_WP && st.firstWork && seg.start === st.firstWork.start) return false;

    // 1인당 보조 최대 2회 (기존 규칙과 동일)
    if (newWp === ASSIST_WP) {
      const count = (w.placeCounts && w.placeCounts[ASSIST_WP]) ? w.placeCounts[ASSIST_WP] : 0;
      if (count >= MAX_ASSIST_PER_WORKER && seg.label !== ASSIST_WP) return false;
    }

    // 연속 60분 초과/반복 금지 규칙 유지
    if (wouldViolateChain(w, seg, newWp)) return false;

    return true;
  }

  function applySwap(stA, stB, segA, segB) {
    if (segA.start !== segB.start || segA.end !== segB.end) return false;
    if (segA.label === segB.label) return false;

    const wpA = segA.label;
    const wpB = segB.label;
    const d = segA.end - segA.start;

    if (!canWorkerTake(stA, segA, wpB)) return false;
    if (!canWorkerTake(stB, segB, wpA)) return false;

    segA.label = wpB;
    segB.label = wpA;

    stA.minutes[wpA] -= d; stA.minutes[wpB] = (stA.minutes[wpB] || 0) + d;
    stB.minutes[wpB] -= d; stB.minutes[wpA] = (stB.minutes[wpA] || 0) + d;

    return true;
  }

  const MAX_ITERS = 220;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // 가장 초과가 큰 worker를 선택
    let target = null;
    list.forEach(function(w) {
      const st = state.get(w.id);
      const ex = maxExcess(st);
      if (ex.excess <= 0 || !ex.wp) return;
      if (!target || ex.excess > target.excess) target = { st: st, wp: ex.wp, excess: ex.excess };
    });
    if (!target) break;

    const stA = target.st;
    const wpA = target.wp;

    // 대상 worker의 "초과 업무" 세그먼트 중 하나를 고르고, 같은 시간대의 다른 worker와 swap을 시도
    const poolA = stA.workSegs.filter(function(seg) {
      if (seg.label !== wpA) return false;
      if (stA.firstWork && seg === stA.firstWork) return false;
      const key = seg.start + '-' + seg.end;
      const peers = byKey.get(key) || [];
      return peers.length >= 2;
    });

    if (!poolA.length) break;

    const segA = rng ? rng.pick(poolA) : poolA[0];
    const key = segA.start + '-' + segA.end;
    const peers = (byKey.get(key) || []).filter(function(p) { return p.worker.id !== stA.worker.id; });

    // 초과 감소가 가장 큰 swap을 선택
    let best = null;
    let bestGain = 0;

    const oldExA = Math.max(0, (stA.minutes[wpA] || 0) - getCap(stA.worker, wpA));

    for (const p of peers) {
      const stB = state.get(p.worker.id);
      const segB = p.seg;
      const wpB = segB.label;

      if (wpB === wpA) continue;
      if (stB.firstWork && segB === stB.firstWork) continue;

      if (!canWorkerTake(stA, segA, wpB)) continue;
      if (!canWorkerTake(stB, segB, wpA)) continue;

      const d = segA.end - segA.start;

      const newExA =
        Math.max(0, ((stA.minutes[wpA] || 0) - d) - getCap(stA.worker, wpA)) +
        Math.max(0, ((stA.minutes[wpB] || 0) + d) - getCap(stA.worker, wpB));

      const oldExB =
        Math.max(0, (stB.minutes[wpB] || 0) - getCap(stB.worker, wpB)) +
        Math.max(0, (stB.minutes[wpA] || 0) - getCap(stB.worker, wpA));

      const newExB =
        Math.max(0, ((stB.minutes[wpB] || 0) - d) - getCap(stB.worker, wpB)) +
        Math.max(0, ((stB.minutes[wpA] || 0) + d) - getCap(stB.worker, wpA));

      const gain = (oldExA + oldExB) - (newExA + newExB);
      if (gain > bestGain) { bestGain = gain; best = { stB: stB, segB: segB }; }
    }

    if (best && bestGain > 0) {
      applySwap(stA, best.stB, segA, best.segB);
    } else {
      // 개선 여지가 없으면 종료
      break;
    }
  }
}



  // ===== 1일 전체 근무지 1회 이상 보장: 스왑(교환) 후처리 =====
// 가능한 범위에서 "같은 시간 구간(start~end)"의 근무지 라벨만 교환하여,
// 커버리지(시간대별 인원수)는 유지하면서 각 근무자가 모든 근무지를 최소 1회 이상 수행하도록 보정한다.
function ensureAllWorkplacesAtLeastOnceBySwaps(workers, rng) {
  const fixes = [];
  const list = (workers || []).slice();

  function isFixed60(wp) { return FIXED_60_WPS.indexOf(wp) !== -1; }

  function getWorkSegs(w) {
    return (w.segments || []).filter(s => s.type === 'work' && s.label).slice().sort((a,b)=>a.start-b.start);
  }

  function buildCounts(segs) {
    const counts = Object.fromEntries(WORKPLACES.map(p => [p, 0]));
    segs.forEach(seg => { if (counts[seg.label] != null) counts[seg.label] += 1; });
    return counts;
  }

  function missingFromCounts(counts) {
    const miss = new Set();
    WORKPLACES.forEach(function(wp) { if ((counts[wp] || 0) <= 0) miss.add(wp); });
    return miss;
  }

  function firstWorkSeg(segs) { return segs && segs.length ? segs[0] : null; }

  function wouldViolateChain(w, seg, newWp) {
    const segs = getWorkSegs(w);
    const i = segs.indexOf(seg);
    if (i < 0) return false;

    const noRepeat = (newWp === '3F' || newWp === EXTRA_WP || newWp === EXTRA_WP_3F);
    const dur = seg.end - seg.start;

    let total = dur;

    // backward contiguous
    let cursorStart = seg.start;
    for (let k = i - 1; k >= 0; k--) {
      const p = segs[k];
      if (p.end !== cursorStart) break;
      if (p.label !== newWp) break;
      if (noRepeat) return true;
      total += (p.end - p.start);
      cursorStart = p.start;
    }
    // forward contiguous
    let cursorEnd = seg.end;
    for (let k = i + 1; k < segs.length; k++) {
      const n = segs[k];
      if (n.start !== cursorEnd) break;
      if (n.label !== newWp) break;
      if (noRepeat) return true;
      total += (n.end - n.start);
      cursorEnd = n.end;
    }

    return total > 60;
  }

  function canWorkerTake(w, counts, seg, newWp) {
    const dur = seg.end - seg.start;
    if (dur > 60) return false;
    if (isFixed60(newWp) && dur !== 60) return false;

    const segs = getWorkSegs(w);
    const first = firstWorkSeg(segs);

    // 첫 근무지 2F 카트 내림 금지
    if (first && first === seg && newWp === EXTRA_WP) return false;

    // 식사/휴식 중 카트 금지
    if (CART_WPS.indexOf(newWp) !== -1 && overlapsMealBreakWindow(seg.start, seg.end)) return false;

    // 보조 최대 1회
    if (newWp === ASSIST_WP) {
      const cur = counts[ASSIST_WP] || 0;
      const selfWasAssist = seg.label === ASSIST_WP;
      const next = selfWasAssist ? cur : (cur + 1);
      if (next > MAX_ASSIST_PER_WORKER) return false;
    }

    // 연속 60분 제한 + 3F/카트는 연속 금지
    if (wouldViolateChain(w, seg, newWp)) return false;

    return true;
  }

  // worker state
  const state = new Map();
  list.forEach(function(w) {
    const segs = getWorkSegs(w);
    const counts = buildCounts(segs);
    state.set(w.id, { worker: w, segs, counts, missing: missingFromCounts(counts) });
  });

  // by time window
  const byKey = new Map();
  list.forEach(function(w) {
    const st = state.get(w.id);
    st.segs.forEach(function(seg) {
      const key = seg.start + '-' + seg.end;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ worker: w, seg });
    });
  });

  function pick(arr) {
    if (!arr || !arr.length) return null;
    if (!rng) return arr[0];
    if (typeof rng === "function") return arr[Math.floor(rng() * arr.length)];
    if (rng && typeof rng.pick === "function") return rng.pick(arr);
    if (rng && typeof rng.next === "function") return arr[Math.floor(rng.next() * arr.length)];
    return arr[0];
  }

  function updateAfterSwap(stA, stB, wpHave, wpNeed) {
    stA.counts[wpHave] = Math.max(0, (stA.counts[wpHave] || 0) - 1);
    stA.counts[wpNeed] = (stA.counts[wpNeed] || 0) + 1;

    stB.counts[wpNeed] = Math.max(0, (stB.counts[wpNeed] || 0) - 1);
    stB.counts[wpHave] = (stB.counts[wpHave] || 0) + 1;

    stA.missing = missingFromCounts(stA.counts);
    stB.missing = missingFromCounts(stB.counts);
  }

  const MAX_ITERS = 1200;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const targets = Array.from(state.values()).filter(st => st.missing.size > 0);
    if (!targets.length) break;
    targets.sort((a,b)=>b.missing.size - a.missing.size);
    const stA = targets[0];

    const needList = Array.from(stA.missing);
    const need = pick(needList) || needList[0];

    // A가 2회 이상 수행한 근무지 블록을 교환 대상으로 선택(교환 후에도 그 근무지를 잃지 않게)
    const segAChoices = stA.segs.filter(function(seg) { return (stA.counts[seg.label] || 0) >= 2; });
    const fallbackSegAChoices = segAChoices.length ? segAChoices : stA.segs.slice(); // 그래도 없으면 모든 블록 허용(마지막 수단)

    let swapped = false;

    for (let attempt = 0; attempt < Math.min(36, fallbackSegAChoices.length); attempt++) {
      const segA = pick(fallbackSegAChoices);
      if (!segA) continue;

      const wpHave = segA.label;
      if ((stA.counts[wpHave] || 0) <= 1) continue; // A가 wpHave를 0회로 만들지 않도록 방지

      const key = segA.start + '-' + segA.end;
      const peers = (byKey.get(key) || []).filter(p => p.worker.id !== stA.worker.id);

      // 같은 시간대에 need를 수행 중이며, 그 근무지를 2회 이상 수행한 사람만 donor로 사용
      const donorPeers = peers.filter(function(p) {
        if (p.seg.label !== need) return false;
        const stB = state.get(p.worker.id);
        return stB && (stB.counts[need] || 0) >= 2;
      });
      if (!donorPeers.length) continue;

      const pickedPeer = pick(donorPeers);
      const stB = state.get(pickedPeer.worker.id);
      const segB = pickedPeer.seg;

      const wpNeed = need;

      if (!canWorkerTake(stA.worker, stA.counts, segA, wpNeed)) continue;
      if (!canWorkerTake(stB.worker, stB.counts, segB, wpHave)) continue;

      // swap
      segA.label = wpNeed;
      segB.label = wpHave;
      updateAfterSwap(stA, stB, wpHave, wpNeed);

      fixes.push(stA.worker.name + '↔' + stB.worker.name + ' ' + minToTime(segA.start) + '~' + minToTime(segA.end));
      swapped = true;
      break;
    }

    if (!swapped) break;
  }

  return fixes;
}


function workplaceScore(worker, wp, start, end, coverage, rotationCtx) {
    if (!canAssignToWp(wp, start, end, coverage)) return Number.POSITIVE_INFINITY;

    // 보조: 1인당 최대 2회, 1회=30분 (구조적 제한)
    if (wp === ASSIST_WP) {
      if ((worker.placeCounts[ASSIST_WP] || 0) >= MAX_ASSIST_PER_WORKER) return Number.POSITIVE_INFINITY;
      if ((end - start) !== 30) return Number.POSITIVE_INFINITY;
    }

    // 순환 규칙: 동일 근무지 연속 배치는 최대 60분까지만 허용 (일반 근무 기본 60분, 2F 카트 내림 기본 30분)
    if (rotationCtx && rotationCtx.lastWp === wp) {
      // 추가 규칙: 3F / 2F 카트 내림은 블록이 끝나면 반드시 다른 근무지로 순환
      if (wp === '3F' || wp === EXTRA_WP || wp === EXTRA_WP_3F) return Number.POSITIVE_INFINITY;
      const nextContiguous = (rotationCtx.contiguousMin || 0) + (end - start);
      if ((rotationCtx.contiguousMin || 0) >= 60) return Number.POSITIVE_INFINITY;
      if (nextContiguous > 60) return Number.POSITIVE_INFINITY;
    }

    const dur = (end - start);

    let score = (worker.placeCounts[wp] || 0) * 3;

    // === 1일(해당 근무자) 업무 과도 반복 방지 ===
    const usedMin = worker && worker.placeMinutes ? (worker.placeMinutes[wp] || 0) : 0;
    const totalMin = worker ? (worker.totalWorkMinutesAssigned || 0) : 0;

    // 같은 업무 누적 시간이 늘어날수록 기본 패널티(30분 단위)
    score += (usedMin / 30) * 0.8;

    // 아직 한 번도 안 한 업무는 약간 우선
    if (usedMin === 0) score -= 4;

    // 업무별 소프트 상한(분)을 넘기면 강한 패널티(필요하면 초과 배정은 가능)
    const capMin = getDailyWpCapMin(worker, wp);
    const nextMin = usedMin + dur;
    if (nextMin > capMin) {
      score += 180 + (nextMin - capMin) * 2;
    }

    // 하루 업무 중 특정 업무 점유율이 과도하면 추가 패널티
    const nextTotalMin = totalMin + dur;
    if (nextTotalMin >= 180) {
      const ratio = nextMin / nextTotalMin;
      const maxShare = (worker && Number(worker.hours) === 6) ? 0.42 : 0.36;
      if (ratio > maxShare) score += (ratio - maxShare) * 600;
    }

    // ABA / ABAB 패턴(두 업무만 번갈아 과도 반복)을 억제
    if (rotationCtx && rotationCtx.prev2Wp && rotationCtx.lastWp && rotationCtx.lastWp !== wp && rotationCtx.prev2Wp === wp) {
      score += 20; // A-B-A
    }
    if (rotationCtx && rotationCtx.prev3Wp && rotationCtx.prev2Wp && rotationCtx.lastWp && rotationCtx.lastWp !== wp
        && rotationCtx.prev3Wp === wp && rotationCtx.prev2Wp === rotationCtx.lastWp) {
      score += 12; // A-B-A-B
    }

    // 일정 시점 이후에도 업무 종류가 2개 이하로 고착되면, 이미 수행한 업무에 추가 패널티
    if (nextTotalMin >= 240 && worker && worker.placeMinutes) {
      const uniq = Object.values(worker.placeMinutes).filter(m => m > 0).length;
      if (uniq <= 2 && usedMin > 0) score += 18;
    }

    // 순환 선호 규칙: 2F 메인 근무 후에는 3F / 3F 카트 내림 / 2F 카트 내림을 우선 고려
    const prevWp = rotationCtx && rotationCtx.lastWp ? rotationCtx.lastWp : null;
    if (prevWp) {
      const dist = RotationPolicy.forwardDistance(prevWp, wp);
      if (Number.isFinite(dist)) score += dist * 2; // 사이클 '다음'에 가까울수록 유리
      else score += 6;
    }
    if (prevWp && MAIN_2F_WPS.indexOf(prevWp) !== -1) {
      if (MAIN_2F_WPS.indexOf(wp) !== -1) score += 24; // 2F 메인 -> 2F 메인 연속은 강한 패널티
      if (wp === '3F') score -= 8;
      if (wp === ASSIST_WP) score += 18; // 보조는 메인/3F가 가능하면 가급적 후순위
      if (wp === EXTRA_WP_3F) score -= 6;
      if (wp === EXTRA_WP) score -= 6;
    }
    // 3F / 3F 카트 내림 / 2F 카트 내림 이후에도 같은 자리 반복보다 다른 근무지 순환을 우선
    // (단, 인원/상한/최소배치 제약이 강하면 예외적으로 같은 자리 배치가 선택될 수 있음)
    if (prevWp === '3F') {
      if (wp === '3F') score += 22; // 3F -> 3F 연속은 강한 패널티(순환 유도)
      if (MAIN_2F_WPS.indexOf(wp) !== -1) score -= 6; // 3F 다음엔 2F 메인 우선
      if (wp === ASSIST_WP) score += 16;
      if (wp === EXTRA_WP_3F) score -= 4;
      if (wp === EXTRA_WP) score -= 4; // 또는 카트 내림도 허용
    }
    if (prevWp === EXTRA_WP) {
      if (wp === EXTRA_WP) score += 22; // 카트 -> 카트 연속도 회피
      if (MAIN_2F_WPS.indexOf(wp) !== -1) score -= 6;
      if (wp === ASSIST_WP) score += 14;
      if (wp === '3F') score -= 4;
      if (wp === EXTRA_WP_3F) score -= 4;
    }
    if (prevWp === EXTRA_WP_3F) {
      if (wp === EXTRA_WP_3F) score += 22;
      if (MAIN_2F_WPS.indexOf(wp) !== -1) score -= 6;
      if (wp === ASSIST_WP) score += 14;
      if (wp === '3F') score -= 4;
      if (wp === EXTRA_WP) score -= 4;
    }

    for (const t of slotRange(start, end)) {
      const c = getCounts(coverage, t);
      const next = { ...c, [wp]: c[wp] + 1 };

      // 기본 배치 우선: 2F 메인 2명(엘베/출차 각1), 3F 최소 2명
      score += (1 - Math.min(next['2F 엘베'], 1)) * 10;
      score += (1 - Math.min(next['2F 출차'], 1)) * 10;
      score += Math.max(0, 2 - next['3F']) * 8;

      // 3F 기본 2명까지 우선 채우기 / 추가 1명 허용(최대 3)
      if (wp === '3F' && c['3F'] < 2) score -= 3;
      if ((wp === '2F 엘베' || wp === '2F 출차') && c[wp] < 1) score -= 4;

      // 보조/카트는 별도 자리이지만, 메인 자리와 3F 최소 충족 전에는 후순위
      if (wp === EXTRA_WP_3F) {
        if (next['2F 엘베'] < 1 || next['2F 출차'] < 1 || next['3F'] < 2) score += 90;
        if (c['3F'] < 3) score += 25;
        score += 8;
      }
      if (wp === ASSIST_WP) {
        if (next['2F 엘베'] < 1 || next['2F 출차'] < 1 || next['3F'] < 2) score += 140;
        score += 55; // 보조는 정말 필요할 때만 선택
      }
      if (wp === EXTRA_WP) {
        if (next['2F 엘베'] < 1 || next['2F 출차'] < 1 || next['3F'] < 2) score += 100;
        // 3F 추가 여유 있으면 3F를 더 우선
        if (c['3F'] < 3) score += 40;
        score += 6;
      }
    }

    return score;
  }

  function assignCoverage(worker, wp, start, end, coverage) {
    const dur = (end - start);
    for (const t of slotRange(start, end)) getCounts(coverage, t)[wp] += 1;
    if (worker && worker.placeCounts) worker.placeCounts[wp] = (worker.placeCounts[wp] || 0) + 1;
    if (worker && worker.placeMinutes) worker.placeMinutes[wp] = (worker.placeMinutes[wp] || 0) + dur;
    if (worker) worker.totalWorkMinutesAssigned = (worker.totalWorkMinutesAssigned || 0) + dur;
    updateWorkerAllWpRequirement(worker, wp);
    if (worker && worker.group === '오픈조' && start >= OPEN_NO_ASSIGN_UNTIL) {
      worker._openWorkBlocksAfter1030 = (worker._openWorkBlocksAfter1030 || 0) + 1;
    }
    if (worker && !worker.firstAssignedWp) {
      worker.firstAssignedWp = wp;
      if (worker.group === '마감조' && worker._firstWpState && worker._firstWpState.closeCounts) {
        worker._firstWpState.closeCounts[wp] = (worker._firstWpState.closeCounts[wp] || 0) + 1;
      }
    }
  }

  function chooseWorkplace(worker, start, end, coverage, rotationCtx, rng) {
    const isFirstAssignment = !worker.firstAssignedWp;
    let candidates = AUTO_ASSIGN_WPS
      .map(wp => ({ wp, score: workplaceScore(worker, wp, start, end, coverage, rotationCtx) }))
      .filter(x => Number.isFinite(x.score));

    // 첫 배정은 모든 근무자에게 카트 내림 금지
    if (isFirstAssignment) {
      candidates = candidates.filter(function(x) { return x.wp !== EXTRA_WP; });
    } else {
      // 로테이션을 위해 2F 카트 내림을 후보에서 제거하지 않습니다(점수에서만 후순위 처리).
    }
    // '하루 동안 모든 근무지 1회 이상' 조건: 가능하면 미수행 근무지로 후보를 제한
    candidates = applyAllWpRequirementFilter(candidates, worker);
    // 보조는 다른 일반 근무지가 가능하면 후순위 (단, 미수행이면 제외하지 않음)
    if (!(worker.requiredWps && worker.requiredWps.has(ASSIST_WP))) {
      const nonAssistCandidates = candidates.filter(function(x) { return x.wp !== ASSIST_WP; });
      if (nonAssistCandidates.length) candidates = nonAssistCandidates;
    }

    // 1인당 보조 최대 배치 횟수 제한
    if ((worker.placeCounts[ASSIST_WP] || 0) >= MAX_ASSIST_PER_WORKER) {
      const noAssist = candidates.filter(function(x) { return x.wp !== ASSIST_WP; });
      if (noAssist.length) candidates = noAssist;
    }

    // 마감조 첫 배정은 엘베/출차/3F를 가능한 범위에서 균형 분배
    if (isFirstAssignment && worker.group === '마감조' && candidates.length) {
      const closeCounts = (worker._firstWpState && worker._firstWpState.closeCounts) || {};
      const mainCandidates = candidates.filter(function(x) { return x.wp === '2F 엘베' || x.wp === '2F 출차' || x.wp === '3F'; });
      if (mainCandidates.length) {
        const minCount = Math.min.apply(null, mainCandidates.map(function(x) { return closeCounts[x.wp] || 0; }));
        candidates = mainCandidates.filter(function(x) { return (closeCounts[x.wp] || 0) === minCount; });
      }
    }

    if (!candidates.length) return null;
    const ordered = randomizeEqualCandidates(candidates, function(c) { return c.score; }, rng, 0.0001);
    const wp = ordered[0].wp;
    assignCoverage(worker, wp, start, end, coverage);
    return wp;
  }

  function chooseWorkAssignment(worker, start, gapEnd, coverage, rotationCtx, rng, allocCtx) {
    const remain = gapEnd - start;
    const maxDur = Math.min(60, remain);
    const candidates = [];
    const isFirstAssignment = !worker.firstAssignedWp;

    for (let duration = maxDur; duration >= 30; duration -= 5) {
      const leftover = remain - duration;
      if (!(leftover === 0 || leftover >= 30)) continue;

      for (const wp of AUTO_ASSIGN_WPS) {
        if (isFirstAssignment && wp === EXTRA_WP) continue;
        const isFixed60Wp = FIXED_60_WPS.indexOf(wp) !== -1;
        if (isFixed60Wp && duration !== 60) continue;
        if (wp === ASSIST_WP && duration !== 30) continue;
        const score = workplaceScore(worker, wp, start, start + duration, coverage, rotationCtx);
        if (!Number.isFinite(score)) continue;
        const targetDuration = DEFAULT_WORK_BLOCK_BY_WP[wp] || 60;
        const durationGap = Math.abs(targetDuration - duration);
        const isFlexibleWp = FIXED_60_WPS.indexOf(wp) === -1;
        const durationPriorityCost = durationGap * (isFlexibleWp ? 18 : 120);
        const exactMatchBonus = durationGap === 0 ? (isFlexibleWp ? -18 : -60) : 0;
        const isFullHourPreferred = FIXED_60_WPS.indexOf(wp) !== -1 && duration === 60;
        candidates.push({
          wp,
          duration,
          baseScore: score,
          durationPriorityCost,
          targetDuration,
          isFlexibleWp,
          isFullHourPreferred,
          score: (score * 1000) + durationPriorityCost + exactMatchBonus - (duration / 1000)
        });
      }
    }

    if (!candidates.length) return null;

    let filtered = isFirstAssignment ? candidates.filter(function(x) { return x.wp !== EXTRA_WP; }) : candidates;

    if (!filtered.length) return null;
    // 보조는 다른 일반 근무지가 가능하면 후순위 (단, '하루 동안 모든 근무지 1회 이상' 조건으로 보조가 미수행이면 제외하지 않음)
    if (!(worker.requiredWps && worker.requiredWps.has(ASSIST_WP))) {
      const nonAssistFiltered = filtered.filter(function(x) { return x.wp !== ASSIST_WP; });
      if (nonAssistFiltered.length) filtered = nonAssistFiltered;
    }


    // 보조 연속 배정 금지(보조는 30분 단위로만, 가능한 경우 연속은 피함)
    if (rotationCtx && rotationCtx.lastWp === ASSIST_WP) {
      const noConsecutiveAssist = filtered.filter(function(x) { return x.wp !== ASSIST_WP; });
      if (noConsecutiveAssist.length) filtered = noConsecutiveAssist;
    }
    // 1인당 보조 최대 배치 횟수 제한
    if ((worker.placeCounts[ASSIST_WP] || 0) >= MAX_ASSIST_PER_WORKER) {
      const noAssist = filtered.filter(function(x) { return x.wp !== ASSIST_WP; });
      if (noAssist.length) filtered = noAssist;
    }

    // 마감조 첫 배정은 엘베/출차/3F를 가능한 범위에서 균형 분배
    if (isFirstAssignment && worker.group === '마감조') {
      const closeCounts = (worker._firstWpState && worker._firstWpState.closeCounts) || {};
      const mainCandidates = filtered.filter(function(x) { return x.wp === '2F 엘베' || x.wp === '2F 출차' || x.wp === '3F'; });
      if (mainCandidates.length) {
        const minCount = Math.min.apply(null, mainCandidates.map(function(x) { return closeCounts[x.wp] || 0; }));
        filtered = mainCandidates.filter(function(x) { return (closeCounts[x.wp] || 0) === minCount; });
      }
    }

    // 2F 출차/2F 엘베/3F는 어쩔 수 없는 구간이 아니면 60분만 사용
    // (단, '하루 동안 모든 근무지 1회 이상' 조건을 충족하기 전까지는 비고정 근무지도 선택 가능하도록 강제력을 약화)
    const fixed60Candidates = filtered.filter(function(x) { return FIXED_60_WPS.indexOf(x.wp) !== -1 && x.duration === 60; });
    const missingNonFixed = (worker.requiredWps && worker.requiredWps.size > 0)
      ? Array.from(worker.requiredWps).some(function(wp) { return FIXED_60_WPS.indexOf(wp) === -1; })
      : false;
    if (fixed60Candidates.length && !missingNonFixed) {
      filtered = fixed60Candidates;
    } else {
      const shortestGap = filtered.reduce(function(minGap, x) {
        return Math.min(minGap, Math.abs((DEFAULT_WORK_BLOCK_BY_WP[x.wp] || 60) - x.duration));
      }, Number.POSITIVE_INFINITY);
      filtered = filtered.filter(function(x) {
        return Math.abs((DEFAULT_WORK_BLOCK_BY_WP[x.wp] || 60) - x.duration) === shortestGap;
      });
    }



    // 배치 횟수 동일(하드) 제약: 남은 gap 구조에서 목표 블록 수를 만족할 수 있는 duration만 허용
    if (allocCtx && Number.isFinite(allocCtx.blocksLeft) && Number.isFinite(allocCtx.restMinSeg) && Number.isFinite(allocCtx.restMaxSeg)) {
      const restMin = allocCtx.restMinSeg;
      const restMax = allocCtx.restMaxSeg;
      const blocksLeft = allocCtx.blocksLeft;

      const filteredByBlocks = filtered.filter(function(c) {
        const afterLen = remain - c.duration;
        const minAfterCur = afterLen <= 0 ? 0 : Math.ceil(afterLen / 60);
        const maxAfterCur = afterLen <= 0 ? 0 : Math.floor(afterLen / 30);
        const minAfter = restMin + minAfterCur;
        const maxAfter = restMax + maxAfterCur;
        const blocksLeftAfter = blocksLeft - 1;
        return (blocksLeftAfter >= minAfter && blocksLeftAfter <= maxAfter);
      });
      if (filteredByBlocks.length) filtered = filteredByBlocks;
    }
    // '하루 동안 모든 근무지 1회 이상' 하드 제약: 가능한 후보가 있으면 미수행 근무지로 후보를 제한
    filtered = applyAllWpRequirementFilter(filtered, worker);

    // 오픈조 초반(10:30 이후 2~3블록) 미수행 근무지 채우기 강화
    filtered = applyOpenKickoffFilter(filtered, worker, start);

    // 1일 편중 방지(구조 변경): 대안이 있는 한 근무자별 하드 캡을 초과하는 업무는 후보에서 제외
    filtered = applyDailyHardCapFilter(filtered, worker);

    // 두 업무만 번갈아 반복(핑퐁) 고착을 끊기(구조 변경)
    filtered = applyAntiPingPongFilter(filtered, rotationCtx, worker);

    // 순차 로테이션 필터: 이전 근무지 기준으로 다음 근무지로 가능한 범위에서 순환
    filtered = applySequentialRotationFilter(filtered, rotationCtx, worker);

    const ordered = randomizeEqualCandidates(filtered, function(c) {
      return c.score;
    }, rng, 0.75);

    const picked = ordered[0];
    assignCoverage(worker, picked.wp, start, start + picked.duration, coverage);
    return picked;
  }

  function tryExtendPrevWork(worker, prevSeg, extendMin, coverage) {
    if (!prevSeg || prevSeg.type !== 'work' || extendMin <= 0) return 0;
    if (prevSeg.label === ASSIST_WP) return 0;
    const currentLen = prevSeg.end - prevSeg.start;
    if (currentLen >= 60) return 0;

    const addable = Math.min(extendMin, 60 - currentLen);
    if (addable <= 0) return 0;

    // 확장 시에도 상한 검증 필수 (이전 버그 수정)
    if (!canAssignToWp(prevSeg.label, prevSeg.end, prevSeg.end + addable, coverage)) return 0;
    assignCoverage(worker, prevSeg.label, prevSeg.end, prevSeg.end + addable, coverage);
    prevSeg.end += addable;
    return addable;
  }

  function chooseForcedWorkplace(worker, start, end, coverage) {
    const isFirstAssignment = !worker.firstAssignedWp;
    const counts = getCounts(coverage, start);
    const prevWp = getPrevContiguousWorkInfo(worker, start).lastWp;
    let candidates = AUTO_ASSIGN_WPS.slice();
    const duration = end - start;
    if (duration !== 30) {
      candidates = candidates.filter(function(wp) { return wp !== ASSIST_WP; });
    }
    const cartFreeWindow = overlapsMealBreakWindow(start, end);

    if (isFirstAssignment) {
      candidates = candidates.filter(function(wp) { return wp !== EXTRA_WP; });
    }

    if (duration !== 60) {
      const flexOnly = candidates.filter(function(wp) { return FIXED_60_WPS.indexOf(wp) === -1; });
      if (flexOnly.length) candidates = flexOnly;
    }
    if (cartFreeWindow) {
      const nonCartOnly = candidates.filter(function(wp) { return CART_WPS.indexOf(wp) === -1; });
      if (nonCartOnly.length) candidates = nonCartOnly;
    }
    const noOverflowAssist = candidates.filter(function(wp) {
      if (wp !== ASSIST_WP) return true;
      return canAssignToWp(ASSIST_WP, start, end, coverage);
    });
    if (noOverflowAssist.length) candidates = noOverflowAssist;

    // '하루 동안 모든 근무지 1회 이상' 조건: 강제 배정에서도 가능하면 미수행 근무지를 우선
    candidates = applyAllWpRequirementFilterToWps(candidates, worker);
    candidates = applyOpenKickoffWpListFilter(candidates, worker, start);

    const feasible = candidates.filter(function(wp) { return canAssignToWp(wp, start, end, coverage); });
    if (feasible.length) {
      candidates = feasible;
      const feasibleNonAssist = candidates.filter(function(wp) { return wp !== ASSIST_WP; });
      if (feasibleNonAssist.length && !(worker.requiredWps && worker.requiredWps.has(ASSIST_WP))) candidates = feasibleNonAssist;
      if ((worker.placeCounts[ASSIST_WP] || 0) >= MAX_ASSIST_PER_WORKER) {
        const noAssistForced = candidates.filter(function(wp) { return wp !== ASSIST_WP; });
        if (noAssistForced.length) candidates = noAssistForced;
      }
    } else if (isFirstAssignment) {
      const firstSafe = candidates.filter(function(wp) { return wp !== '3F' && wp !== EXTRA_WP_3F; });
      if (firstSafe.length) candidates = firstSafe;
    }

    candidates.sort(function(a, b) {
      function forcedScore(wp) {
        let score = 0;
        // 강제 배정에서도 가능한 한 순차 로테이션(사이클 다음 자리)을 우선
        if (prevWp) {
          const dist = RotationPolicy.forwardDistance(prevWp, wp);
          if (Number.isFinite(dist)) score += dist * 2;
          else score += 10;
        }
        const cap = WP_CAPS[wp];
        const used = counts[wp] || 0;
        const overflow = Number.isFinite(cap) ? Math.max(0, (used + 1) - cap) : 0;
        score += overflow * 5000;
        if (isFirstAssignment && wp === EXTRA_WP) score += 1200;
        if (duration !== 60 && FIXED_60_WPS.indexOf(wp) !== -1) score += 8000;
        if (wp === '3F' && overflow > 0) score += 400;
        if (wp === EXTRA_WP_3F && overflow > 0) score += 400;
        if (wp === ASSIST_WP) score += 520; // 보조는 최후 예외 근무지
        if (wp === EXTRA_WP) score -= 25;
        if (wp === EXTRA_WP_3F) score -= 18;
        if (cartFreeWindow && CART_WPS.indexOf(wp) !== -1) score += 20000;
        if (wp === '3F') score -= 10;
        if (wp === '2F 엘베' || wp === '2F 출차') score += 10;
        if (worker.firstAssignedWp && wp === worker.firstAssignedWp) score += 20;
        return score;
      }
      return forcedScore(a) - forcedScore(b);
    });

    const picked = candidates[0] || EXTRA_WP;
    assignCoverage(worker, picked, start, end, coverage);
    return picked;
  }

  function fillWork(worker, coverage, rng) {
    worker.segments.sort((a, b) => a.start - b.start);
    const occupied = (worker.segments || []).filter(function(s) { return s && s.type !== 'work'; }).slice();
    let cursor = worker.startMin;

    if (!Number.isFinite(worker._workBlocksAssigned)) worker._workBlocksAssigned = 0;

    function computeFutureGapStats(fromTime, fromIdx) {
      let c = fromTime;
      let minSeg = 0;
      let maxSeg = 0;
      for (let j = fromIdx; j < occupied.length; j++) {
        const s = occupied[j];
        if (c < s.start) {
          const len = s.start - c;
          if (len >= 30) {
            minSeg += Math.ceil(len / 60);
            maxSeg += Math.floor(len / 30);
          }
        }
        c = Math.max(c, s.end);
      }
      if (c < worker.endMin) {
        const len = worker.endMin - c;
        if (len >= 30) {
          minSeg += Math.ceil(len / 60);
          maxSeg += Math.floor(len / 30);
        }
      }
      return { minSeg, maxSeg };
    }

    function findFeasibleDurationForTarget(remain, allocCtx) {
      if (!allocCtx) return null;
      const restMin = allocCtx.restMinSeg || 0;
      const restMax = allocCtx.restMaxSeg || 0;
      const blocksLeft = allocCtx.blocksLeft || 0;

      for (let d = Math.min(60, remain); d >= 30; d -= 5) {
        const leftover = remain - d;
        if (!(leftover === 0 || leftover >= 30)) continue;
        const afterLen = remain - d;
        const minAfterCur = afterLen <= 0 ? 0 : Math.ceil(afterLen / 60);
        const maxAfterCur = afterLen <= 0 ? 0 : Math.floor(afterLen / 30);
        const minAfter = restMin + minAfterCur;
        const maxAfter = restMax + maxAfterCur;
        const blocksLeftAfter = blocksLeft - 1;
        if (blocksLeftAfter < minAfter || blocksLeftAfter > maxAfter) continue;
        return d;
      }
      return null;
    }

    function placeGapWork(gapStart, gapEnd, restStats) {
      let t = gapStart;
      while (t < gapEnd) {
        const remain = gapEnd - t;

        if (remain < 30) {
          const prev = worker.segments
            .filter(s => s.type === 'work' && s.end === t)
            .sort((a, b) => a.start - b.start)
            .slice(-1)[0];
          const extended = tryExtendPrevWork(worker, prev, remain, coverage);
          if (extended > 0) {
            t += extended;
            continue;
          }
          worker.warnings.push(minToTime(t) + '~' + minToTime(gapEnd) + ' 30분 미만 근무는 생성하지 않도록 배치 단계에서 차단');
          break;
        }

        const rotationCtx = getPrevContiguousWorkInfo(worker, t);

        // 배치 횟수 동일(하드) 제약 컨텍스트
        let allocCtx = null;
        if (Number.isFinite(worker._targetWorkBlocks) && worker._targetWorkBlocks > 0) {
          const blocksLeft = worker._targetWorkBlocks - (worker._workBlocksAssigned || 0);
          if (blocksLeft > 0) {
            const curMin = Math.ceil(remain / 60);
            const curMax = Math.floor(remain / 30);
            const minTotal = (restStats?.minSeg || 0) + curMin;
            const maxTotal = (restStats?.maxSeg || 0) + curMax;
            if (blocksLeft >= minTotal && blocksLeft <= maxTotal) {
              allocCtx = { blocksLeft: blocksLeft, restMinSeg: restStats?.minSeg || 0, restMaxSeg: restStats?.maxSeg || 0 };
            }
          }
        }

        const picked = chooseWorkAssignment(worker, t, gapEnd, coverage, rotationCtx, rng, allocCtx);
        if (!picked) {
          let fallbackDur = chooseGapChunkDuration(remain);
          if (allocCtx) {
            const fd = findFeasibleDurationForTarget(remain, allocCtx);
            if (fd != null) fallbackDur = fd;
          }
          if (fallbackDur <= 0) {
            worker.warnings.push(minToTime(t) + '~' + minToTime(gapEnd) + ' 30분 미만 근무는 허용되지 않아 강제 배정을 생략');
            break;
          }
          const fallbackEnd = Math.min(gapEnd, t + fallbackDur);
          const forcedWp = chooseForcedWorkplace(worker, t, fallbackEnd, coverage);
          addSegment(worker, t, fallbackEnd, 'work', forcedWp);
          assignCoverage(worker, forcedWp, t, fallbackEnd, coverage);
          worker._workBlocksAssigned = (worker._workBlocksAssigned || 0) + 1;
          t = fallbackEnd;
          continue;
        }

        addSegment(worker, t, t + picked.duration, 'work', picked.wp);
        worker._workBlocksAssigned = (worker._workBlocksAssigned || 0) + 1;
        t += picked.duration;
      }
    }

    occupied.sort((a, b) => a.start - b.start);

    for (let i = 0; i < occupied.length; i++) {
      const seg = occupied[i];
      if (cursor < seg.start) {
        const rest = computeFutureGapStats(seg.end, i + 1);
        placeGapWork(cursor, seg.start, rest);
      }
      cursor = Math.max(cursor, seg.end);
    }
    if (cursor < worker.endMin) {
      placeGapWork(cursor, worker.endMin, { minSeg: 0, maxSeg: 0 });
    }

    worker.segments.sort((a, b) => a.start - b.start);
  }

  function buildTimeline(workers) {
    const minStart = Math.min.apply(null, workers.map(w => w.startMin));
    const maxEnd = Math.max.apply(null, workers.map(w => w.endMin));
    const rows = [];
    for (let t = minStart; t < maxEnd; t += 5) rows.push({ time: minToTime(t), t, cells: {} });

    // 성능 최적화: row마다 .find() 대신 워커별 포인터 사용
    for (const w of workers) {
      const segs = w.segments.slice().sort((a, b) => a.start - b.start);
      let idx = 0;
      for (const row of rows) {
        if (row.t < w.startMin || row.t >= w.endMin) {
          row.cells[w.id] = null;
          continue;
        }
        while (idx < segs.length && segs[idx].end <= row.t) idx += 1;
        const seg = segs[idx] && segs[idx].start <= row.t && row.t < segs[idx].end ? segs[idx] : null;
        row.cells[w.id] = seg || { type: 'idle', label: '빈시간' };
      }
    }
    return rows;
  }

  function buildCoverageSummary(coverage, mealCoverage) {
    const times = Object.keys(coverage).map(Number).sort((a, b) => a - b);
    const by15 = [];

    for (const t of times) {
      if (t % 15 !== 0) continue;
      const slots = [t, t + 5, t + 10].map(x => coverage[x] || { '2F 엘베': 0, '2F 출차': 0, '3F': 0, '3F 카트 내림': 0, '2F 보조': 0, '2F 카트 내림': 0 });
      const slotMeals = [t, t + 5, t + 10].map(x => mealCoverage[x] || 0);

      const minElv = Math.min.apply(null, slots.map(s => s['2F 엘베']));
      const minOut = Math.min.apply(null, slots.map(s => s['2F 출차']));
      const maxElv = Math.max.apply(null, slots.map(s => s['2F 엘베']));
      const maxOut = Math.max.apply(null, slots.map(s => s['2F 출차']));
      const min3 = Math.min.apply(null, slots.map(s => s['3F']));
      const max3 = Math.max.apply(null, slots.map(s => s['3F']));
      const f3CartMin = Math.min.apply(null, slots.map(s => s['3F 카트 내림'] || 0));
      const f3CartMax = Math.max.apply(null, slots.map(s => s['3F 카트 내림'] || 0));
      const assistMin = Math.min.apply(null, slots.map(s => s['2F 보조'] || 0));
      const assistMax = Math.max.apply(null, slots.map(s => s['2F 보조'] || 0));
      const cartMin = Math.min.apply(null, slots.map(s => s['2F 카트 내림'] || 0));
      const cartMax = Math.max.apply(null, slots.map(s => s['2F 카트 내림'] || 0));

      const row = {
        t,
        time: minToTime(t),
        elvMin: minElv,
        outMin: minOut,
        elvMax: maxElv,
        outMax: maxOut,
        f3Min: min3,
        f3Max: max3,
        f3CartMin,
        f3CartMax,
        assistMin,
        assistMax,
        cartMin,
        cartMax,
        mealMaxNonClose: Math.max.apply(null, slotMeals),
        ok2F: (minElv >= 1 && minOut >= 1 && maxElv <= 1 && maxOut <= 1),
        ok3F: (min3 >= 2 && max3 <= 3 && f3CartMax <= 3),
        okMeal: (Math.max.apply(null, slotMeals) <= 2)
      };
      row.ok = row.ok2F && row.ok3F && row.okMeal;
      by15.push(row);
    }

    const violations = by15.filter(r => !r.ok);
    return { by15, violations };
  }

  function validatePost11CoreCoverage(coverage, workers) {
    const issues = [];
    const start = timeToMin('11:00');
    const end = Math.max(start, Math.max.apply(null, (workers || []).map(function(w) { return w.endMin || start; }).concat([start])));
    let current = null;

    function signature(counts) {
      const elv = counts['2F 엘베'] || 0;
      const out = counts['2F 출차'] || 0;
      const f3 = counts['3F'] || 0;
      const parts = [];
      if (elv !== 1) parts.push('2F 엘베 ' + elv + '/1');
      if (out !== 1) parts.push('2F 출차 ' + out + '/1');
      if (f3 < 2 || f3 > 3) parts.push('3F ' + f3 + '/2~3');
      return parts.join(', ');
    }

    function pushCurrent() {
      if (!current) return;
      issues.push(minToTime(current.start) + '~' + minToTime(current.end) + ' ' + current.sig);
      current = null;
    }

    for (let t = start; t < end; t += 5) {
      const counts = coverage[t] || { '2F 엘베': 0, '2F 출차': 0, '3F': 0 };
      const sig = signature(counts);
      if (!sig) {
        pushCurrent();
        continue;
      }
      if (current && current.sig === sig && current.end === t) {
        current.end = t + 5;
      } else {
        pushCurrent();
        current = { start: t, end: t + 5, sig: sig };
      }
    }
    pushCurrent();
    return issues;
  }


  function scheduleFingerprint(result) {
    return (result.workers || []).map(function(w) {
      const segs = (w.segments || []).slice().sort(function(a, b) { return a.start - b.start; }).map(function(s) {
        return [s.start, s.end, s.type, s.label].join(':');
      }).join('|');
      return [w.startMin, w.name, segs].join('>');
    }).join('||');
  }

  function buildScheduleOnce(workerInputs, rng, generationIndex) {
    const workers = workerInputs.map(cloneWorker);
    const closingNormalization = normalizeClosingShiftWorkers(workers);
    const indexedWorkers = workers.map(function(w, idx) { return { worker: w, idx: idx }; });
    const ordered = randomizeEqualCandidates(indexedWorkers, function(entry) {
      return (entry.worker.startMin * 100000) - (entry.worker.hours * 100) + entry.idx;
    }, rng, 0.5);
    const sortedWorkers = ordered.map(function(entry) { return entry.worker; });

    const coverage = initCoverage();
    const mealCoverage = {};
    const meetingCounts = Object.fromEntries(FIXED_EVENTS.map(ev => [ev.label, 0]));
    const globalWarnings = [];
    const firstAssignmentState = { closeCounts: { '2F 엘베': 0, '2F 출차': 0, '3F': 0 } };
    sortedWorkers.forEach(function(w) { w._firstWpState = firstAssignmentState; });

    const openWorkers = randomizeEqualCandidates(
      sortedWorkers.filter(function(w) { return w.group === '오픈조'; }).slice(),
      function(w) { return Number(String(w.name).replace(/[^0-9]/g, '')) || 0; },
      rng,
      1000
    );
    const openMealPlan = new Map();
    const openMealBase = timeToMin('11:30');
    openWorkers.forEach(function(w, idx) { openMealPlan.set(w.id, openMealBase + (idx * 60)); });
    if (openWorkers.length !== 2) {
      globalWarnings.push('오픈조는 2명 기준입니다. 현재 ' + openWorkers.length + '명 등록됨');
    }
    if (closingNormalization.commonEnd != null) {
      if (closingNormalization.adjustments.length) {
        globalWarnings.unshift('마감조 공통 퇴근시간 ' + minToTime(closingNormalization.commonEnd) + ' 기준으로 출근시간을 자동 정렬했습니다: ' + closingNormalization.adjustments.slice(0, 5).join(', ') + (closingNormalization.adjustments.length > 5 ? ' ...' : ''));
      } else {
        globalWarnings.unshift('검토 완료: 마감조는 공통 퇴근시간 ' + minToTime(closingNormalization.commonEnd) + '으로 유지됩니다.');
      }
    }

    for (const w of sortedWorkers) {
  insertFixedMeeting(w, meetingCounts, rng);
}

// 오픈조: 09:30 1차 휴식 고정 + 10:30까지 근무지 배정 없음
for (const w of sortedWorkers) {
  insertOpenShiftFixedBlocks(w);
}

const presentCoverage = buildPresentCoverage(sortedWorkers);
    const absenceState = buildNonWorkCoverage(sortedWorkers);
    const nonWorkCoverage = absenceState.nonWork;
    const mealBreakCoverage = absenceState.mealBreak;

    for (const w of sortedWorkers) {
      let preferredMeal = openMealPlan.has(w.id) ? openMealPlan.get(w.id) : null;
      if (w.group === '마감조') {
        preferredMeal = Number(w.hours) === 6 ? (w.startMin + 180) : timeToMin('17:00');
      }
      chooseMeal(w, mealCoverage, preferredMeal, rng, presentCoverage, nonWorkCoverage, mealBreakCoverage);
      chooseBreaks(w, rng, presentCoverage, nonWorkCoverage, mealBreakCoverage);
      initWorkerRotationLimits(w);
      initWorkerAllWpRequirement(w);
      if (preferredMeal != null) {
        if (w.group === '오픈조') {
          w.warnings.push('오픈조 식사 기준 ' + minToTime(preferredMeal));
        } else if (w.group === '마감조' && Number(w.hours) === 6) {
          w.warnings.push('6시간 마감조 식사 기준 ' + minToTime(preferredMeal) + ' (출근 3시간 후)');
        } else if (w.group === '마감조') {
          w.warnings.push('마감조 식사 기준 ' + minToTime(preferredMeal));
        }
      }
      w.warnings.push('종료 ' + minToTime(w.endMin) + ' (식사 1시간 별도)');
      if (w._allWpImpossible) {
        w.warnings.unshift('주의: 근무시간(휴식 포함) 대비 모든 근무지 1회 이상 조건(최소 ' + w._allWpRequiredMin + '분)이 물리적으로 부족할 수 있습니다.');
      }
    }

    CURRENT_MEAL_BREAK_COVERAGE = mealBreakCoverage;

    initEqualWorkBlockTargets(sortedWorkers, globalWarnings);

    for (const w of sortedWorkers) {
      fillWork(w, coverage, rng);
    }

    const closeFirstCounts = firstAssignmentState.closeCounts;
    const closeFirstValues = [closeFirstCounts['2F 엘베'] || 0, closeFirstCounts['2F 출차'] || 0, closeFirstCounts['3F'] || 0];
    const closeFirstSpread = closeFirstValues.length ? (Math.max.apply(null, closeFirstValues) - Math.min.apply(null, closeFirstValues)) : 0;
    globalWarnings.unshift('첫 배정 규칙 적용: 모든 근무자 첫 근무지는 카트 내림 제외 · 마감조 첫 근무지는 엘베/출차/3F 균등 분배 우선');
    if (sortedWorkers.some(function(w) { return !w.firstAssignedWp; })) {
      globalWarnings.push('일부 근무자는 시간대 제약으로 첫 근무지 규칙이 일부 완화되었습니다.');
    }
    if (closeFirstSpread > 1) {
      globalWarnings.push('마감조 첫 근무지 분배가 일부 시간대 제약으로 완전 균등하지 않을 수 있습니다. (엘베 ' + closeFirstCounts['2F 엘베'] + ' / 출차 ' + closeFirstCounts['2F 출차'] + ' / 3F ' + closeFirstCounts['3F'] + ')');
    }

    const mainPlaces60 = ['2F 엘베', '2F 출차', '3F'];
    const normalizationFixes = normalizeProtectedPlaceChains(sortedWorkers, mainPlaces60);
    const fixed60BlockFixes = normalizeFixed60PlaceDurations(sortedWorkers, FIXED_60_WPS);
    const assignmentFixes = ensureFullWorkAssignment(sortedWorkers);
    const postAssignmentChainFixes = normalizeProtectedPlaceChains(sortedWorkers, mainPlaces60);
    const postAssignmentFixed60Fixes = normalizeFixed60PlaceDurations(sortedWorkers, FIXED_60_WPS);
    const placeCapFixes = normalizePlaceCapViolations(sortedWorkers, ['3F', '3F 카트 내림']);
    const cartDuringMealFixes = normalizeCartDuringMealBreak(sortedWorkers);
    const autoAssistDemotionFixes = demoteAutoAssistToNonAssist(sortedWorkers);
    const assistReductionFixes = normalizeAssistUsage(sortedWorkers);
    const assistSimultaneousFixes = normalizeSingleAssistPerTimeslot(sortedWorkers);
    const finalChainFixes = normalizeProtectedPlaceChains(sortedWorkers, mainPlaces60);
    const finalFixed60Fixes = normalizeFixed60PlaceDurations(sortedWorkers, FIXED_60_WPS);
    const finalAssistReductionFixes = normalizeAssistUsage(sortedWorkers);
    const finalAssistSimultaneousFixes = normalizeSingleAssistPerTimeslot(sortedWorkers);

    // 개인별 업무 과도 반복을 추가 완화(커버리지는 그대로 유지)
    rebalanceDailyJobRepetitionBySwaps(sortedWorkers, rng);
    // 하드 조건: 각 근무자는 하루 동안 모든 근무지를 최소 1회 이상 수행
    ensureAllWorkplacesAtLeastOnceBySwaps(sortedWorkers, rng);

    const rebuiltState = rebuildDerivedState(sortedWorkers);
    const timeline = buildTimeline(sortedWorkers);
    const globalCounts = Object.fromEntries(WORKPLACES.map(function(p) {
      return [p, sortedWorkers.reduce(function(n, w) { return n + (w.placeCounts[p] || 0); }, 0)];
    }));
    const coverageSummary = buildCoverageSummary(rebuiltState.coverage, rebuiltState.mealCoverage);
    const post11CoreCoverageIssues = validatePost11CoreCoverage(rebuiltState.coverage, sortedWorkers);
    const mainPlace60Issues = validateMaxWorkPerPlace(sortedWorkers, mainPlaces60);
    const fixed60BlockIssues = validateFixedDurationPlaces(sortedWorkers, FIXED_60_WPS);
    const maxWorkIssues = validateMaxWorkPerPlace(sortedWorkers);
    const minWorkBlockIssues = validateMinWorkBlockDuration(sortedWorkers);
    const placeCapIssues = validatePlaceCapViolations(rebuiltState.coverage, ['3F', '3F 카트 내림']);
    const breakRuleIssues = validateBreakRules(sortedWorkers);
    const cartDuringMealIssues = validateCartDuringMealBreak(sortedWorkers);
    const assistLimitIssues = validateAssistLimit(sortedWorkers);
    const assistSimultaneousIssues = validateSingleAssistPerTimeslot(sortedWorkers);
    const allWpOnceIssues = validateAllWorkplacesAtLeastOnce(sortedWorkers);
    const allChainFixes = normalizationFixes.concat(postAssignmentChainFixes, finalChainFixes);
    const allFixed60Fixes = fixed60BlockFixes.concat(postAssignmentFixed60Fixes, finalFixed60Fixes);
    const allAssistReductionFixes = autoAssistDemotionFixes.concat(assistReductionFixes, finalAssistReductionFixes);
    const allAssistSimultaneousFixes = assistSimultaneousFixes.concat(finalAssistSimultaneousFixes);

    if (allChainFixes.length) {
      globalWarnings.unshift('자동 수정: 2F 출차·2F 엘베·3F의 같은 근무지 연속 60분 초과 구간 ' + allChainFixes.length + '건을 다른 근무지로 재배정했습니다.');
      globalWarnings.push('연속 60분 초과 재배정 예시: ' + allChainFixes.slice(0, 5).join(', ') + (allChainFixes.length > 5 ? ' ...' : ''));
    }
    if (allFixed60Fixes.length) {
      globalWarnings.unshift('자동 수정: 2F 출차·2F 엘베·3F의 60분이 아닌 블록 ' + allFixed60Fixes.length + '건을 보조·카트 계열로 재배정했습니다.');
      globalWarnings.push('고정 60분 재배정 예시: ' + allFixed60Fixes.slice(0, 5).join(', ') + (allFixed60Fixes.length > 5 ? ' ...' : ''));
    }

    if (assignmentFixes.length) {
      globalWarnings.unshift('자동 보정: 미배정 구간 ' + assignmentFixes.length + '건에 근무지를 다시 채웠습니다. 식사·휴식·회의는 유지됩니다.');
    }

    if (placeCapFixes.length) {
      globalWarnings.unshift('자동 수정: 3F/3F 카트내림 상한 초과 구간 ' + placeCapFixes.length + '건을 재배정했습니다.');
      globalWarnings.push('3F 계열 재배정 예시: ' + placeCapFixes.slice(0, 5).join(', ') + (placeCapFixes.length > 5 ? ' ...' : ''));
    }

    if (cartDuringMealFixes.length) {
      globalWarnings.unshift('자동 수정: 식사·휴식 시간대의 카트내림 근무 ' + cartDuringMealFixes.length + '건을 일반 근무지로 재배정했습니다.');
      globalWarnings.push('식사/휴식 중 카트 제외 재배정 예시: ' + cartDuringMealFixes.slice(0, 5).join(', ') + (cartDuringMealFixes.length > 5 ? ' ...' : ''));
    }

    if (allAssistReductionFixes.length) {
      globalWarnings.unshift('자동 수정: 2F 보조 자동 배정/배치 ' + allAssistReductionFixes.length + '건을 다른 근무지로 축소 재배정했습니다.');
      globalWarnings.push('보조 축소 재배정 예시: ' + allAssistReductionFixes.slice(0, 5).join(', ') + (allAssistReductionFixes.length > 5 ? ' ...' : ''));
    }
    if (allAssistSimultaneousFixes.length) {
      globalWarnings.unshift('자동 수정: 같은 시간대 2F 보조 1명 초과 구간 ' + allAssistSimultaneousFixes.length + '건을 다른 근무지로 재배정했습니다.');
      globalWarnings.push('동시간 보조 재배정 예시: ' + allAssistSimultaneousFixes.slice(0, 5).join(', ') + (allAssistSimultaneousFixes.length > 5 ? ' ...' : ''));
    }

    if (placeCapIssues.length) {
      globalWarnings.push('3F/3F 카트내림 인원 상한 위반 ' + placeCapIssues.length + '건 (예: ' + placeCapIssues.slice(0, 5).join(', ') + (placeCapIssues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 3F는 최대 3명, 3F 카트내림은 최대 3명으로 유지됩니다.');
    }

    if (mainPlace60Issues.length) {
      globalWarnings.push('2F 출차·2F 엘베·3F 같은 근무지 연속 60분 초과 위반 ' + mainPlace60Issues.length + '건 (예: ' + mainPlace60Issues.slice(0, 5).join(', ') + (mainPlace60Issues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 2F 출차·2F 엘베·3F는 같은 근무지에 60분 초과 연속 배정되지 않도록 유지됩니다.');
    }
    if (fixed60BlockIssues.length) {
      globalWarnings.push('2F 출차·2F 엘베·3F 60분 고정 위반 ' + fixed60BlockIssues.length + '건 (예: ' + fixed60BlockIssues.slice(0, 5).join(', ') + (fixed60BlockIssues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 2F 출차·2F 엘베·3F는 60분 블록만 사용하고, 2F 보조는 자동생성보다 축소 우선 · 2F카트·3F카트가 잔여 시간을 흡수합니다.');
    }

    if (maxWorkIssues.length) {
      globalWarnings.push('전체 근무지 기준 최대 60분 규칙 위반 ' + maxWorkIssues.length + '건 (예: ' + maxWorkIssues.slice(0, 5).join(', ') + (maxWorkIssues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('한 근무지 최대 근무시간 60분 규칙을 적용했습니다.');
    }

    if (minWorkBlockIssues.length) {
      globalWarnings.push('30분 미만 근무 블록 위반 ' + minWorkBlockIssues.length + '건 (예: ' + minWorkBlockIssues.slice(0, 5).join(', ') + (minWorkBlockIssues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 근무 블록은 30분 미만으로 생성되지 않도록 유지됩니다.');
    }

    if (breakRuleIssues.length) {
      globalWarnings.push('휴식 규칙 위반 ' + breakRuleIssues.length + '건 (예: ' + breakRuleIssues.slice(0, 5).join(', ') + (breakRuleIssues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 6시간 근무자는 휴식 15분·10분으로 유지됩니다.');
    }

    if (cartDuringMealIssues.length) {
      globalWarnings.push('식사·휴식 시간대 카트내림 근무 위반 ' + cartDuringMealIssues.length + '건 (예: ' + cartDuringMealIssues.slice(0, 5).join(', ') + (cartDuringMealIssues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 식사·휴식 중 남은 근무자는 카트내림 제외 근무지에서 근무하도록 유지됩니다. 필요 시 로테이션을 허용했습니다.');
    }

    if (assistLimitIssues.length) {
      globalWarnings.push('보조 배치 제한 위반 ' + assistLimitIssues.length + '건 (예: ' + assistLimitIssues.slice(0, 5).join(', ') + (assistLimitIssues.length > 5 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 1인당 2F 보조 최대 ' + MAX_ASSIST_PER_WORKER + '회 규칙을 적용했습니다.');
    }
    if (assistSimultaneousIssues.length) {
      globalWarnings.push('같은 시간대 2F 보조 1명 초과 위반 ' + assistSimultaneousIssues.length + '건 (예: ' + assistSimultaneousIssues.slice(0, 5).join(', ') + (assistSimultaneousIssues.length > 5 ? ' ...' : '') + ')');
    }
    if (allWpOnceIssues.length) {
      globalWarnings.unshift('중요: "모든 근무지는 최소 1회 이상" 조건을 충족하지 못한 근무자가 있습니다.');
      // 개별 근무자 경고에 누락 근무지 표시
      allWpOnceIssues.slice(0, 50).forEach(function(msg) { globalWarnings.push('누락 근무지: ' + msg); });
    }
 else {
      globalWarnings.unshift('검토 완료: 같은 시간대 2F 보조는 최대 1명으로 유지됩니다.');
    }

    const unassignedMinutes = countUnassignedMinutes(sortedWorkers);
    if (unassignedMinutes > 0) {
      globalWarnings.push('미배정 근무시간 ' + unassignedMinutes + '분이 남아 있습니다.');
    } else {
      globalWarnings.unshift('검토 완료: 식사·휴식·회의를 유지하면서 근무시간 내 미배정 구간이 없도록 보정했습니다.');
    }

    if (coverageSummary.violations.length) {
      const sample = coverageSummary.violations.slice(0, 8)
        .map(function(v) { return v.time + ' [2F:' + v.elvMin + '/' + v.outMin + ', 3F:' + v.f3Min + '~' + v.f3Max + ', 3F카트:' + v.f3CartMin + '~' + v.f3CartMax + ', 보조:' + v.assistMin + '~' + v.assistMax + ', 2F카트:' + v.cartMin + '~' + v.cartMax + ', 식사:' + v.mealMaxNonClose + ']'; })
        .join(', ');
      globalWarnings.push('규칙 미충족 구간 ' + coverageSummary.violations.length + '개 (예: ' + sample + (coverageSummary.violations.length > 8 ? ' ...' : '') + ')');
    }

    if (post11CoreCoverageIssues.length) {
      globalWarnings.push('11:00 이후 2F 출차·2F 엘베·3F 배치 검토 위반 ' + post11CoreCoverageIssues.length + '건 (예: ' + post11CoreCoverageIssues.slice(0, 6).join(', ') + (post11CoreCoverageIssues.length > 6 ? ' ...' : '') + ')');
    } else {
      globalWarnings.unshift('검토 완료: 11:00 이후에도 2F 출차·2F 엘베·3F는 규칙(출차 1명 / 엘베 1명 / 3F 2~3명)대로 유지됩니다.');
    }

    const groupCounts = {
      '오픈조': sortedWorkers.filter(function(w) { return w.group === '오픈조'; }).length,
      '중간조': sortedWorkers.filter(function(w) { return w.group === '중간조'; }).length,
      '마감조': sortedWorkers.filter(function(w) { return w.group === '마감조'; }).length
    };

    const result = { workers: sortedWorkers, timeline: timeline, globalCounts: globalCounts, coverageSummary: coverageSummary, meetingCounts: meetingCounts, groupCounts: groupCounts, globalWarnings: globalWarnings, mainPlace60Issues: mainPlace60Issues, generationIndex: generationIndex, seed: rng.seed };
    result.fingerprint = scheduleFingerprint(result);
    return result;
  }

  function generateSchedule(workerInputs) {
    const maxAttempts = 12;
    let best = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const baseSeed = createSeed() ^ ((attempt + 1) * 2654435761);
      const generationIndex = Date.now().toString(36) + '_' + baseSeed.toString(36) + '_' + attempt;
      const rng = createRng(baseSeed);
      const candidate = buildScheduleOnce(workerInputs, rng, generationIndex);
      if (!best) best = candidate;
      if (!lastScheduleFingerprint || candidate.fingerprint !== lastScheduleFingerprint) {
        best = candidate;
        break;
      }
    }
    if (best.fingerprint === lastScheduleFingerprint) {
      best.globalWarnings.push('규칙 범위 안에서 직전 결과와 다른 배치를 찾지 못해 같은 결과가 유지될 수 있습니다.');
    } else {
      // UI에서 배치 탐색/시도 등 백그라운드 작업 메시지는 표시하지 않습니다.
    }
    lastScheduleFingerprint = best.fingerprint;
    return best;
  }



  function parseDateInput(dateStr) {
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function weekdayName(day) {
    return ['일', '월', '화', '수', '목', '금', '토'][day];
  }

  const DEFAULT_MIDDLE_SHIFT_CONFIG = {
    1: { times: ['10:30'] },
    2: { times: ['10:30'] },
    3: { times: ['10:30'] },
    4: { times: ['10:30'] },
    5: { times: ['12:30'] },
    6: { times: ['10:30'] },
    0: { times: ['10:30'] }
  };

  function cloneMiddleShiftConfig() {
    const out = {};
    Object.keys(DEFAULT_MIDDLE_SHIFT_CONFIG).forEach(function(key) {
      out[key] = { times: DEFAULT_MIDDLE_SHIFT_CONFIG[key].times.slice(), count: DEFAULT_MIDDLE_SHIFT_CONFIG[key].times.length };
    });
    return out;
  }

  function normalizeMiddleShiftConfig(config) {
    const out = cloneMiddleShiftConfig();
    if (!config || typeof config !== 'object') return out;
    Object.keys(out).forEach(function(key) {
      const item = config[key] || config[Number(key)] || {};
      let times = [];
      if (Array.isArray(item.times)) {
        times = item.times.map(function(v) { return String(v || '').trim(); }).filter(function(v) { return /^[0-2][0-9]:[0-5][0-9]$/.test(v); });
      } else {
        const count = Number(item.count);
        const startTime = String(item.startTime || '').trim();
        if (Number.isFinite(count) && count >= 1) {
          const safeStart = /^[0-2][0-9]:[0-5][0-9]$/.test(startTime) ? startTime : (out[key].times[0] || '10:30');
          times = Array.from({ length: Math.min(10, Math.round(count)) }, function() { return safeStart; });
        }
      }
      if (times.length) out[key].times = times.slice(0, 10);
      out[key].count = out[key].times.length;
    });
    return out;
  }

  function middleMealLabel(startTimes) {
    const times = Array.isArray(startTimes) ? startTimes : [startTimes];
    return times.map(function(startTime, idx) {
      if (!/^[0-2][0-9]:[0-5][0-9]$/.test(String(startTime || ''))) return '중간' + (idx + 1) + ' 출근 후 3:00~3:30';
      const startMin = timeToMin(startTime);
      return '중간' + (idx + 1) + ' ' + minToTime(startMin + 180) + '~' + minToTime(startMin + 210);
    }).join(' / ');
  }

  function middleConfigSummary(config) {
    const safe = normalizeMiddleShiftConfig(config);
    return [1, 2, 3, 4, 5, 6, 0].map(function(day) {
      const item = safe[day];
      return weekdayName(day) + ' ' + item.times.map(function(t, idx) { return '중간' + (idx + 1) + ' ' + t; }).join(', ');
    });
  }

  function closingRuleForDate(date, weekIndex, middleConfig) {
    const day = date.getDay();
    let closeBase;
    if (day === 6) closeBase = { count: 6, startTime: '13:50', mealTime: '17:00', endTime: '22:50', dayName: '토' };
    else if (day === 0) closeBase = { count: 5, startTime: '13:50', mealTime: '17:00', endTime: '22:50', dayName: '일' };
    else if (day === 5) closeBase = { count: 4, startTime: '13:50', mealTime: '17:00', endTime: '22:50', dayName: '금' };
    else closeBase = { count: 4, startTime: '13:30', mealTime: '17:00', endTime: '22:30', dayName: weekdayName(day) };

    const safeMiddle = normalizeMiddleShiftConfig(middleConfig);
    const middleBase = safeMiddle[day];
    const middleTimes = (middleBase.times || []).slice();
    const middleCount = middleTimes.length;
    const middleStart = middleTimes.join(' / ');
    const middleMeal = middleMealLabel(middleTimes);

    const groups = [
      {
        name: '오픈조',
        count: 2,
        startTime: '08:30',
        endTime: '17:30',
        mealTime: '11:30 / 12:30',
        slots: ['08:30 출근자 1', '08:30 출근자 2'],
        members: [
          { name: '오픈1', startTime: '08:30', hours: 8 },
          { name: '오픈2', startTime: '08:30', hours: 8 }
        ]
      },
      {
        name: '중간조',
        count: middleCount,
        startTime: middleStart,
        endTime: middleTimes.map(function(start) { return minToTime(timeToMin(start) + (8 * 60) + MEAL_DURATION_MIN); }).join(' / '),
        mealTime: middleMeal,
        slots: middleTimes.map(function(start, idx) { return start + ' 출근자 ' + (idx + 1); }),
        members: middleTimes.map(function(start, idx) { return { name: '중간' + (idx + 1), startTime: start, hours: 8 }; })
      },
      {
        name: '마감조',
        count: closeBase.count,
        startTime: closeBase.startTime,
        mealTime: closeBase.mealTime,
        endTime: closeBase.endTime,
        slots: Array.from({ length: closeBase.count }, function(_, idx) { return closeBase.startTime + ' 출근자 ' + (idx + 1); }),
        members: Array.from({ length: closeBase.count }, function(_, idx) { return { name: '마감' + (idx + 1), startTime: closeBase.startTime, hours: 8 }; })
      }
    ];

    return {
      dayName: closeBase.dayName,
      groups,
      count: groups.reduce(function(sum, g) { return sum + g.count; }, 0),
      openCount: 2,
      closeCount: closeBase.count,
      middleCount: middleCount,
      startTime: groups.map(function(g) { return g.name + ' ' + g.startTime; }).join(' · '),
      mealTime: groups.map(function(g) { return g.name + ' ' + g.mealTime; }).join(' · '),
      endTime: groups.map(function(g) { return g.name + ' ' + (g.endTime || '-'); }).join(' · '),
      slots: groups.reduce(function(arr, g) { return arr.concat(g.slots); }, []),
      displayStart: groups.map(function(g) { return g.name + ' ' + g.startTime; }).join(' · '),
      displayMeal: groups.map(function(g) { return g.name + ' ' + g.mealTime; }).join(' · '),
      displayEnd: groups.map(function(g) { return g.name + ' ' + (g.endTime || '-'); }).join(' · ')
    };
  }

  function buildDayWorkersFromGroups(groups, dateStr) {
    const workers = [];
    (groups || []).forEach(function(group) {
      (group.members || []).forEach(function(member, idx) {
        workers.push({
          id: dateStr + '_' + group.name + '_' + (idx + 1),
          name: member.name,
          group: group.name,
          startTime: member.startTime,
          hours: member.hours || 8
        });
      });
    });
    return workers;
  }

  function buildDayPatternKey(groups) {
    let totalCount = 0;
    (groups || []).forEach(function(group) {
      totalCount += (group.members || []).length;
    });
    return ['TOTAL', totalCount].join(':');
  }

  function cloneScheduleResult(schedule, dateStr, targetWorkers) {
    const cloned = JSON.parse(JSON.stringify(schedule || {}));
    const srcWorkers = Array.isArray(cloned.workers) ? cloned.workers.slice() : [];
    const normalizedTargets = Array.isArray(targetWorkers) ? targetWorkers.slice() : [];
    srcWorkers.sort(function(a, b) {
      return (Number(a.startMin || 0) - Number(b.startMin || 0)) || String(a.group || '').localeCompare(String(b.group || '')) || String(a.name || '').localeCompare(String(b.name || ''));
    });
    normalizedTargets.sort(function(a, b) {
      return (timeToMin(a.startTime || '00:00') - timeToMin(b.startTime || '00:00')) || String(a.group || '').localeCompare(String(b.group || '')) || String(a.name || '').localeCompare(String(b.name || ''));
    });
    cloned.workers = srcWorkers.map(function(worker, idx) {
      const target = normalizedTargets[idx] || {};
      const originalStart = Number(worker.startMin || 0);
      const nextStart = target.startTime ? timeToMin(target.startTime) : originalStart;
      const shift = nextStart - originalStart;
      const next = Object.assign({}, worker);
      next.id = dateStr + '_' + (target.group || worker.group || target.name || worker.name || '근무자') + '_' + (idx + 1);
      next.name = target.name || worker.name;
      next.group = target.group || worker.group;
      next.hours = target.hours || worker.hours;
      next.startTime = target.startTime || worker.startTime;
      next.startMin = originalStart + shift;
      next.endMin = Number(worker.endMin || 0) + shift;
      next.segments = (worker.segments || []).map(function(seg, segIdx) {
        const nextSeg = Object.assign({}, seg);
        nextSeg.id = dateStr + '_seg_' + idx + '_' + segIdx;
        nextSeg.start = Number(seg.start || 0) + shift;
        nextSeg.end = Number(seg.end || 0) + shift;
        return nextSeg;
      });
      return next;
    });
    if (Array.isArray(cloned.globalWarnings)) {
      const note = '같은 총 출근 인원 수를 가진 요일은 같은 근무지 스케줄 패턴을 재사용합니다.';
      if (cloned.globalWarnings.indexOf(note) === -1) cloned.globalWarnings.unshift(note);
    }
    return cloned;
  }


  function schedulePatternSignature(schedule) {
    const workers = Array.isArray(schedule && schedule.workers) ? schedule.workers.slice() : [];
    workers.sort(function(a, b) {
      return (Number(a.startMin || 0) - Number(b.startMin || 0)) || String(a.group || '').localeCompare(String(b.group || '')) || String(a.name || '').localeCompare(String(b.name || ''));
    });
    return workers.map(function(worker, idx) {
      const startMin = Number(worker.startMin || 0);
      const segs = (worker.segments || []).slice().sort(function(a, b) { return Number(a.start || 0) - Number(b.start || 0); }).map(function(seg) {
        const relStart = Number(seg.start || 0) - startMin;
        const relEnd = Number(seg.end || 0) - startMin;
        const label = seg.type === 'work' ? String(seg.label || '') : String(seg.type || '');
        return [relStart, relEnd, String(seg.type || ''), label].join(':');
      }).join('|');
      return 'W' + idx + '>' + segs;
    }).join('||');
  }

  function enforceSharedHeadcountPatterns(weeks, warnings) {
    const canonicalByCount = {};
    let normalizedCount = 0;
    (weeks || []).forEach(function(week) {
      (week.days || []).forEach(function(day) {
        const totalCount = Number(day.count || 0);
        const cacheKey = 'TOTAL:' + totalCount;
        if (!day.detailSchedule) return;
        if (!canonicalByCount[cacheKey]) {
          canonicalByCount[cacheKey] = {
            sourceDate: day.dateStr,
            signature: schedulePatternSignature(day.detailSchedule),
            schedule: JSON.parse(JSON.stringify(day.detailSchedule))
          };
          day.patternSourceDate = day.dateStr;
          day.patternSignature = canonicalByCount[cacheKey].signature;
          return;
        }
        const currentSignature = schedulePatternSignature(day.detailSchedule);
        day.patternSourceDate = canonicalByCount[cacheKey].sourceDate;
        if (currentSignature !== canonicalByCount[cacheKey].signature) {
          const targetWorkers = buildDayWorkersFromGroups(day.groups, day.dateStr);
          day.detailSchedule = cloneScheduleResult(canonicalByCount[cacheKey].schedule, day.dateStr, targetWorkers);
          normalizedCount += 1;
        }
        day.patternSignature = canonicalByCount[cacheKey].signature;
      });
    });
    if (normalizedCount > 0) {
      warnings.unshift('자동 보정: 같은 총 출근 인원 수를 가진 날짜 ' + normalizedCount + '건의 근무지 스케줄 패턴을 동일하게 맞췄습니다.');
    } else {
      warnings.unshift('검토 완료: 같은 총 출근 인원 수를 가진 날짜는 동일한 근무지 스케줄 패턴으로 유지됩니다.');
    }
    return weeks;
  }

  function startOfWeekMonday(baseDate) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return date;
  }


  return { generateSchedule};
})()
