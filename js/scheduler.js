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
  const AUTO_ASSIGN_WPS = WORKPLACES.filter(function(wp) { return wp !== ASSIST_WP; });
  const MAIN_2F_CAPS = { '2F 엘베': 1, '2F 출차': 1 };
  const WP_CAPS = { '2F 엘베': 1, '2F 출차': 1, '3F': 3, '3F 카트 내림': 3, '2F 보조': 1, '2F 카트 내림': Number.POSITIVE_INFINITY };
  const DEFAULT_WORK_BLOCK_BY_WP = { '2F 엘베': 60, '2F 출차': 60, '3F': 60, '3F 카트 내림': 30, '2F 보조': 60, '2F 카트 내림': 30 };

  // ===== 순차 로테이션(60분 초과 방지 + 순환) =====
  // 목표: 같은 근무지에 연속으로 60분을 초과하지 않도록, 가능한 범위에서 '다음 근무지'로 순차 순환합니다.
  // 핵심: 2F 엘베 ↔ 2F 출차를 우선 교대하고, 3F는 2F 메인/카트와 섞어 순환합니다.
  const ROTATION_NEXT = {
    '2F 엘베': ['2F 출차', '3F', EXTRA_WP_3F, EXTRA_WP, ASSIST_WP],
    '2F 출차': ['2F 엘베', '3F', EXTRA_WP_3F, EXTRA_WP, ASSIST_WP],
    '3F': ['2F 엘베', '2F 출차', EXTRA_WP_3F, EXTRA_WP, ASSIST_WP],
    [EXTRA_WP_3F]: ['3F', '2F 엘베', '2F 출차', EXTRA_WP, ASSIST_WP],
    [EXTRA_WP]: ['3F', '2F 엘베', '2F 출차', EXTRA_WP_3F, ASSIST_WP],
    [ASSIST_WP]: ['2F 엘베', '2F 출차', '3F', EXTRA_WP_3F, EXTRA_WP]
  };
  const DEFAULT_ROTATION_FALLBACK = ['2F 엘베', '2F 출차', '3F', EXTRA_WP_3F, EXTRA_WP, ASSIST_WP];

  function rotationRank(prevWp, wp) {
    const list = ROTATION_NEXT[prevWp] || DEFAULT_ROTATION_FALLBACK;
    const idx = list.indexOf(wp);
    return idx === -1 ? 999 : idx;
  }

  function applySequentialRotationFilter(candidates, rotationCtx) {
    const prevWp = rotationCtx && rotationCtx.lastWp ? rotationCtx.lastWp : null;
    if (!prevWp || !candidates || candidates.length <= 1) return candidates;

    // 가능하면 '이전과 다른 근무지'로 순환
    const diff = candidates.filter(function(x) { return x.wp !== prevWp; });
    const pool = diff.length ? diff : candidates;

    const ranks = pool.map(function(x) { return rotationRank(prevWp, x.wp); });
    const minRank = Math.min.apply(null, ranks);
    const filtered = pool.filter(function(x) { return rotationRank(prevWp, x.wp) === minRank; });

    return filtered.length ? filtered : candidates;
  }

  const NON_CART_CAP_TOTAL = NON_CART_WPS.reduce(function(sum, wp) { return sum + (Number.isFinite(WP_CAPS[wp]) ? WP_CAPS[wp] : 0); }, 0);
  let CURRENT_MEAL_BREAK_COVERAGE = null;
  const CLOSE_GROUP_START = timeToMin('13:30');
  const OPEN_GROUP_START = timeToMin('08:30');
  const CLOSING_LAST_BREAK_START = timeToMin('21:30');

  function getGroup(startMin) {
    if (startMin === OPEN_GROUP_START) return '오픈조';
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
      warnings: [],
      firstAssignedWp: null,
      _firstWpState: null,
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
        if (seg.type === 'meal' || seg.type === 'break' || seg.type === 'meeting') addSimpleCoverage(nonWork, seg.start, seg.end, 1);
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
      (worker.segments || []).forEach(function(seg) {
        if (seg.type === 'work' && seg.label && coverage) {
          for (const t of slotRange(seg.start, seg.end)) {
            getCounts(coverage, t)[seg.label] += 1;
          }
          worker.placeCounts[seg.label] = (worker.placeCounts[seg.label] || 0) + 1;
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

    for (let i = 0; i < breaks.length; i++) {
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
    // atTime 직전까지 연속된 같은 근무지 누적 시간을 계산
    let cursor = atTime;
    let lastWp = null;
    let total = 0;

    while (true) {
      const prev = worker.segments
        .filter(s => s.type === 'work' && s.end === cursor)
        .sort((a, b) => a.start - b.start)
        .slice(-1)[0];
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

    return { lastWp, contiguousMin: total };
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

  function workplaceScore(worker, wp, start, end, coverage, rotationCtx) {
    if (!canAssignToWp(wp, start, end, coverage)) return Number.POSITIVE_INFINITY;

    // 순환 규칙: 동일 근무지 연속 배치는 최대 60분까지만 허용 (일반 근무 기본 60분, 2F 카트 내림 기본 30분)
    if (rotationCtx && rotationCtx.lastWp === wp) {
      // 추가 규칙: 3F / 2F 카트 내림은 블록이 끝나면 반드시 다른 근무지로 순환
      if (wp === '3F' || wp === EXTRA_WP || wp === EXTRA_WP_3F) return Number.POSITIVE_INFINITY;
      const nextContiguous = (rotationCtx.contiguousMin || 0) + (end - start);
      if ((rotationCtx.contiguousMin || 0) >= 60) return Number.POSITIVE_INFINITY;
      if (nextContiguous > 60) return Number.POSITIVE_INFINITY;
    }

    let score = (worker.placeCounts[wp] || 0) * 3;

    // 순환 선호 규칙: 2F 메인 근무 후에는 3F / 3F 카트 내림 / 2F 카트 내림을 우선 고려
    const prevWp = rotationCtx && rotationCtx.lastWp ? rotationCtx.lastWp : null;
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
    for (const t of slotRange(start, end)) getCounts(coverage, t)[wp] += 1;
    if (worker && worker.placeCounts) worker.placeCounts[wp] = (worker.placeCounts[wp] || 0) + 1;
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
      // 카트 내림은 메인+3F 자리가 가능한 경우 후순위
      const nonCart = candidates.filter(function(x) { return x.wp !== EXTRA_WP; });
      if (nonCart.length) candidates = nonCart;
    }
    // 보조는 다른 일반 근무지가 가능하면 후순위
    const nonAssistCandidates = candidates.filter(function(x) { return x.wp !== ASSIST_WP; });
    if (nonAssistCandidates.length) candidates = nonAssistCandidates;

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

  function chooseWorkAssignment(worker, start, gapEnd, coverage, rotationCtx, rng) {
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

    const nonCart = candidates.filter(function(x) { return x.wp !== EXTRA_WP; });
    let filtered = isFirstAssignment ? nonCart : (nonCart.length ? nonCart : candidates);

    if (!filtered.length) return null;

    const nonAssistFiltered = filtered.filter(function(x) { return x.wp !== ASSIST_WP; });
    if (nonAssistFiltered.length) filtered = nonAssistFiltered;

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
    const fixed60Candidates = filtered.filter(function(x) { return FIXED_60_WPS.indexOf(x.wp) !== -1 && x.duration === 60; });
    if (fixed60Candidates.length) {
      filtered = fixed60Candidates;
    } else {
      const shortestGap = filtered.reduce(function(minGap, x) {
        return Math.min(minGap, Math.abs((DEFAULT_WORK_BLOCK_BY_WP[x.wp] || 60) - x.duration));
      }, Number.POSITIVE_INFINITY);
      filtered = filtered.filter(function(x) {
        return Math.abs((DEFAULT_WORK_BLOCK_BY_WP[x.wp] || 60) - x.duration) === shortestGap;
      });
    }

    // 순차 로테이션 필터: 이전 근무지 기준으로 다음 근무지로 가능한 범위에서 순환
    filtered = applySequentialRotationFilter(filtered, rotationCtx);

    const ordered = randomizeEqualCandidates(filtered, function(c) {
      return c.score;
    }, rng, 0.75);

    const picked = ordered[0];
    assignCoverage(worker, picked.wp, start, start + picked.duration, coverage);
    return picked;
  }

  function tryExtendPrevWork(worker, prevSeg, extendMin, coverage) {
    if (!prevSeg || prevSeg.type !== 'work' || extendMin <= 0) return 0;
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
    let candidates = AUTO_ASSIGN_WPS.slice();
    const duration = end - start;
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

    const feasible = candidates.filter(function(wp) { return canAssignToWp(wp, start, end, coverage); });
    if (feasible.length) {
      candidates = feasible;
      const feasibleNonAssist = candidates.filter(function(wp) { return wp !== ASSIST_WP; });
      if (feasibleNonAssist.length) candidates = feasibleNonAssist;
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
    const occupied = worker.segments.slice();
    let cursor = worker.startMin;

    function placeGapWork(gapStart, gapEnd) {
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
        const picked = chooseWorkAssignment(worker, t, gapEnd, coverage, rotationCtx, rng);
        if (!picked) {
          const fallbackDur = chooseGapChunkDuration(remain);
          if (fallbackDur <= 0) {
            worker.warnings.push(minToTime(t) + '~' + minToTime(gapEnd) + ' 30분 미만 근무는 허용되지 않아 강제 배정을 생략');
            break;
          }
          const fallbackEnd = Math.min(gapEnd, t + fallbackDur);
          const forcedWp = chooseForcedWorkplace(worker, t, fallbackEnd, coverage);
          addSegment(worker, t, fallbackEnd, 'work', forcedWp);
          worker.warnings.push(minToTime(t) + '~' + minToTime(fallbackEnd) + ' 강제 배정(' + forcedWp + ')');
          t = fallbackEnd;
          continue;
        }

        addSegment(worker, t, t + picked.duration, 'work', picked.wp);
        t += picked.duration;
      }
    }

    for (const seg of occupied) {
      if (cursor < seg.start) placeGapWork(cursor, seg.start);
      cursor = Math.max(cursor, seg.end);
    }
    if (cursor < worker.endMin) placeGapWork(cursor, worker.endMin);

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
    }

    CURRENT_MEAL_BREAK_COVERAGE = mealBreakCoverage;

    globalWarnings.unshift('순차 로테이션 규칙 적용: 같은 근무지 연속 60분 초과를 방지하기 위해, 가능한 범위에서 근무지를 순차적으로 순환합니다. (엘베↔출차 우선 교대, 3F는 2F/카트와 섞어 순환)');

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
    } else {
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

  function generateClosing4WeekTable(startDateStr, middleConfig) {
    const parsed = parseDateInput(startDateStr);
    const startDate = parsed ? startOfWeekMonday(parsed) : startOfWeekMonday(new Date());
    const weeks = [];
    let totalSlots = 0;
    let totalOpenSlots = 0;
    let totalCloseSlots = 0;
    let totalMiddleSlots = 0;
    const safeMiddleConfig = normalizeMiddleShiftConfig(middleConfig);
    const sharedScheduleCache = {};
    let warnings = [];
    if (parsed && parsed.getDay() !== 1) warnings.push('입력한 날짜를 포함한 주의 월요일(' + formatDate(startDate) + ')부터 4주 표를 생성했습니다.');
    warnings.push('오픈조는 매일 2명(08:30)으로 고정하고 식사는 11:30 / 12:30로 순차 반영했습니다.');
    warnings.push('중간조는 요일별/인원별 출근시간 설정을 반영합니다: ' + middleConfigSummary(safeMiddleConfig).join(' · '));
    warnings.push('마감조는 같은 운영일 기준 공통 퇴근시간(월~목 22:30 / 금~일 22:50)으로 표시합니다.');
    warnings.push('8시간 휴식 15·15·10, 6시간 휴식 15·10, 마지막 휴식은 퇴근 1시간30분~2시간 전 규칙을 사용합니다.');
    warnings.push('8시간 마감조 식사 17:00, 6시간 마감조 식사는 출근 3시간 후 규칙을 사용합니다.');
    warnings.push('같은 총 출근 인원 수를 가진 요일은 동일한 근무지 스케줄 패턴을 공유합니다.');

    for (let w = 0; w < 4; w++) {
      const weekIndex = w + 1;
      const days = [];
      for (let i = 0; i < 7; i++) {
        const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + (w * 7) + i);
        const rule = closingRuleForDate(date, weekIndex, safeMiddleConfig);
        const dateStr = formatDate(date);
        const dayWorkers = buildDayWorkersFromGroups(rule.groups, dateStr);
        const dayPatternKey = buildDayPatternKey(rule.groups);
        if (!sharedScheduleCache[dayPatternKey]) {
          sharedScheduleCache[dayPatternKey] = generateSchedule(dayWorkers);
        }
        const detailSchedule = cloneScheduleResult(sharedScheduleCache[dayPatternKey], dateStr, dayWorkers);
        totalSlots += rule.count;
        totalOpenSlots += rule.openCount;
        totalCloseSlots += rule.closeCount;
        totalMiddleSlots += rule.middleCount;
        days.push({
          weekIndex,
          date,
          dateStr: dateStr,
          dayName: rule.dayName,
          startTime: rule.startTime,
          mealTime: rule.mealTime,
          count: rule.count,
          openCount: rule.openCount,
          closeCount: rule.closeCount,
          middleCount: rule.middleCount,
          groups: rule.groups,
          slots: rule.slots,
          detailSchedule: detailSchedule,
          displayStart: rule.displayStart,
          displayMeal: rule.displayMeal,
          displayEnd: rule.displayEnd
        });
      }
      weeks.push({ weekIndex, days });
    }

    enforceSharedHeadcountPatterns(weeks, warnings);
    return { startDate: formatDate(startDate), weeks, totalSlots, totalOpenSlots, totalCloseSlots, totalMiddleSlots, warnings, middleConfigSummary: middleConfigSummary(safeMiddleConfig), middleConfig: safeMiddleConfig };
  }

  return { generateSchedule, generateClosing4WeekTable };
})();
