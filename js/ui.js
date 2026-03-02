window.UI = (() => {
  const { makeStartOptions, minToTime } = window.Utils;

  function initStartOptions(selectEl) {
    selectEl.innerHTML = makeStartOptions().map(t => '<option value="' + t + '">' + t + '</option>').join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // UI 표시용 경고 필터: 백그라운드 작업/검토/자동수정 내역은 기본적으로 숨깁니다.
  function isBackgroundUiMessage(msg) {
    const s = String(msg == null ? '' : msg).trim();
    if (!s) return true;
    if (/^검토 완료[:：]/.test(s)) return true;
    const starts = [
      '검토 완료', '자동 수정', '자동 보정', '순차 로테이션', '첫 배정 규칙 적용',
      '한 근무지 최대', '마감조 공통 퇴근시간', '출근시간을 자동 정렬',
      '연속 60분 초과 재배정 예시', '고정 60분 재배정 예시',
      '식사/휴식 중 카트 제외 재배정 예시', '보조 축소 재배정 예시', '동시간 보조 재배정 예시',
      '조회마다 '
    ];
    for (let i = 0; i < starts.length; i++) {
      if (s.startsWith(starts[i])) return true;
    }
    if (s.indexOf('재배정 예시') !== -1) return true;
    return false;
  }

  function filterUiWarnings(list) {
    const arr = Array.isArray(list) ? list : [];
    return arr.map(x => String(x == null ? '' : x).trim())
      .filter(x => x && !isBackgroundUiMessage(x));
  }

  // 근무자별 경고는 "편차/실패/예외"만 표시 (기준/종료/차단 등 내부 메시지는 숨김)
  function filterUiWorkerWarnings(list) {
    const arr = Array.isArray(list) ? list : [];
    return arr.map(x => String(x == null ? '' : x).trim()).filter(s => {
      if (!s) return false;
      if (s.indexOf('배치 단계에서 차단') !== -1) return false;
      if (s.indexOf('강제 배정을 생략') !== -1) return false;
      if (s.startsWith('오픈조 식사 기준')) return false;
      if (s.startsWith('마감조 식사 기준')) return false;
      if (s.startsWith('6시간 마감조 식사 기준')) return false;
      if (s.startsWith('종료 ')) return false;
      return /(대신|불가|실패|예외|위반|남아|미충족|완화)/.test(s);
    });
  }

  function renderWarningFold(title, warnings) {
    const t = title || '경고';
    const arr = Array.isArray(warnings) ? warnings : [];
    if (!arr.length) return '';
    return '<details class="fold-panel inline-fold"><summary>' + escapeHtml(t) + ' ' + arr.length + '건</summary>' +
      '<div class="slot-health"><div class="warn">' + arr.map(escapeHtml).join('<br>') + '</div></div></details>';
  }

  function renderWorkerList(container, workers, onRemove, onEdit) {
    container.innerHTML = '';
    if (!workers.length) {
      const empty = document.createElement('div');
      empty.className = 'muted small';
      empty.textContent = '등록된 근무자가 없습니다.';
      container.appendChild(empty);
      return;
    }

    workers.forEach(w => {
      const div = document.createElement('div');
      div.className = 'worker-item';
      div.innerHTML =
        '<div>' +
          '<div><strong>' + escapeHtml(w.name) + '</strong><span class="tag">' + escapeHtml(w.hours) + 'h</span></div>' +
          '<div class="meta">시작 ' + escapeHtml(w.startTime) + (w.group ? (' · ' + escapeHtml(w.group)) : '') + '</div>' +
        '</div>' +
        '<div class="btns">' +
          '<button type="button" class="secondary" data-act="edit" data-id="' + escapeHtml(w.id) + '">수정</button>' +
          '<button type="button" class="secondary" data-act="remove" data-id="' + escapeHtml(w.id) + '">삭제</button>' +
        '</div>';

      const editBtn = div.querySelector('button[data-act="edit"]');
      const removeBtn = div.querySelector('button[data-act="remove"]');

      if (editBtn) {
        editBtn.addEventListener('click', function(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (typeof onEdit === 'function') onEdit(w.id);
        });
      }

      if (removeBtn) {
        removeBtn.addEventListener('click', function(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          onRemove(w.id);
        });
      }

      // 카드 클릭으로도 편집 진입(모바일 편의)
      div.addEventListener('click', function() {
        if (typeof onEdit === 'function') onEdit(w.id);
      });

      container.appendChild(div);
    });
  }

  function cellClass(type) {
    return type === 'work' ? 'cell-work' :
      type === 'break' ? 'cell-break' :
      type === 'meal' ? 'cell-meal' :
      type === 'prep' ? 'cell-prep' :
      type === 'meeting' ? 'cell-meeting' :
      type === 'idle' ? 'cell-empty' : '';
  }

  function getTypeVisual(type) {
    if (type === 'work') return { icon: '🛠️', name: '근무', badgeClass: 'badge-work' };
    if (type === 'break') return { icon: '☕', name: '휴식', badgeClass: 'badge-break' };
    if (type === 'meal') return { icon: '🍽️', name: '식사', badgeClass: 'badge-meal' };
    if (type === 'prep') return { icon: '🧾', name: '오픈준비', badgeClass: 'badge-prep' };
    if (type === 'meeting') return { icon: '🦺', name: '안전회의', badgeClass: 'badge-meeting' };
    return { icon: '•', name: '기타', badgeClass: 'badge-default' };
  }

  function isCartWorkLabel(label) {
    return label === '2F 카트 내림';
  }

  function is3FCartWorkLabel(label) {
    return label === '3F 카트 내림';
  }

  function isAssistWorkLabel(label) {
    return label === '2F 보조';
  }

  function segmentClass(type, label) {
    let cls = cellClass(type);
    if (type === 'work' && is3FCartWorkLabel(label)) cls += ' cell-f3cart';
    else if (type === 'work' && isCartWorkLabel(label)) cls += ' cell-cart';
    if (type === 'work' && isAssistWorkLabel(label)) cls += ' cell-assist';
    return cls;
  }

  function renderTypeBadge(type, label) {
    const v = getTypeVisual(type);
    let extra = '';
    if (type === 'work' && is3FCartWorkLabel(label)) extra = ' badge-f3cart';
    else if (type === 'work' && isCartWorkLabel(label)) extra = ' badge-cart';
    else if (type === 'work' && isAssistWorkLabel(label)) extra = ' badge-assist';
    return '<span class="type-badge ' + v.badgeClass + extra + '">' + v.icon + ' ' + escapeHtml(v.name) + '</span>';
  }

  function renderDesktopCellLabel(seg) {
    const v = getTypeVisual(seg.type);
    const label = seg.label || v.name;
    return '<div class="cell-wrap">' +
      '<span class="cell-emoji">' + v.icon + '</span>' +
      '<span class="cell-label">' + escapeHtml(label) + '</span>' +
    '</div>';
  }

  function renderLegend() {
    return '<div class="legend-row">' +
      '<span class="legend-item">' + renderTypeBadge('work') + '</span>' +
      '<span class="legend-item"><span class="type-badge badge-assist">🧩 2F 보조</span></span>' +
      '<span class="legend-item"><span class="type-badge badge-cart">🛒 2F 카트 내림</span></span>' +
      '<span class="legend-item"><span class="type-badge badge-f3cart">🛗 3F 카트 내림</span></span>' +
      '<span class="legend-item">' + renderTypeBadge('meal') + '</span>' +
      '<span class="legend-item">' + renderTypeBadge('break') + '</span>' +
      '<span class="legend-item">' + renderTypeBadge('prep') + '</span>' +
      '<span class="legend-item">' + renderTypeBadge('meeting') + '</span>' +
    '</div>';
  }


  function shortPrintLabel(type, label) {
    if (type === 'meal') return '식사';
    if (type === 'break') return '휴식';
    if (type === 'prep') return '오픈준비';
    if (type === 'meeting') return '회의';
    return shortWorkLabel(label || '-');
  }

  function formatPrintSchedule(worker) {
    const blocks = buildMergedBlocks(worker);
    return blocks.map(function(b) {
      return '<span class="print-block">' +
        escapeHtml(fmtRange(b.start, b.end).replace(/\s*~\s*/g, '-')) + ' ' +
        escapeHtml(shortPrintLabel(b.type, b.label)) +
      '</span>';
    }).join('');
  }

  function renderA4PrintHtml(result) {
    if (!result || !result.workers || !result.workers.length) return '';
    const workers = (result.workers || []).slice().sort(function(a, b) {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ko');
    });
    const generated = new Date();
    const rows = workers.map(function(w, idx) {
      return '<tr>' +
        '<td class="print-col-no">' + (idx + 1) + '</td>' +
        '<td class="print-col-start">' + escapeHtml(w.startTime || '') + '</td>' +
        '<td class="print-col-name"><strong>' + escapeHtml(w.name || '') + '</strong></td>' +
        '<td class="print-col-group">' + escapeHtml(w.group || '') + '</td>' +
        '<td class="print-col-end">' + escapeHtml(w.endTime || '') + '</td>' +
        '<td class="print-schedule">' + formatPrintSchedule(w) + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="print-a4-head">' +
      '<div>' +
        '<div class="print-a4-title">현재 화면 기준 근무표</div>' +
        '<div class="print-a4-sub">출근시간 · 퇴근시간 · 조 · 시간순 근무 흐름만 남긴 인쇄 전용 보기</div>' +
      '</div>' +
      '<div class="print-a4-sub">총 ' + workers.length + '명</div>' +
    '</div>' +
    '<div class="print-table-wrap">' +
      '<table class="print-table">' +
        '<thead><tr>' +
          '<th class="print-col-no">번호</th>' +
          '<th class="print-col-start">출근</th>' +
          '<th class="print-col-name">근무자</th>' +
          '<th class="print-col-group">조</th>' +
          '<th class="print-col-end">퇴근</th>' +
          '<th>근무 흐름</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function reducedTimeline(timeline) {
    const rows = [];
    for (let i = 0; i < timeline.length; i += 3) rows.push(timeline[i]);
    return rows;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtRange(startMin, endMin) {
    return pad2(Math.floor(startMin / 60)) + ':' + pad2(startMin % 60) + ' ~ ' + pad2(Math.floor(endMin / 60)) + ':' + pad2(endMin % 60);
  }

  function buildMergedBlocks(worker) {
    const segs = (worker && worker.segments ? worker.segments : []).slice().sort((a, b) => a.start - b.start);
    if (!segs.length) return [];
    const blocks = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const prev = blocks.length ? blocks[blocks.length - 1] : null;
      const sameAsPrev = prev && prev.type === s.type && prev.label === s.label && prev.end === s.start;
      if (sameAsPrev) {
        prev.end = s.end;
        prev.minutes += (s.end - s.start);
      } else {
        blocks.push({ type: s.type, label: s.label, start: s.start, end: s.end, minutes: (s.end - s.start) });
      }
    }
    return blocks;
  }

  function shortWorkLabel(label) {
    if (!label) return '-';
    if (label === '2F 엘베') return '2F엘베';
    if (label === '2F 출차') return '2F출차';
    if (label === '2F 보조') return '보조';
    if (label === '2F 카트 내림') return '2F카트';
    if (label === '3F 카트 내림') return '3F카트';
    return label;
  }

  function workerQuickStats(blocks) {
    const stat = { work: 0, meal: 0, break: 0, meeting: 0 };
    for (const b of blocks) {
      if (b.type === 'work') stat.work += b.minutes;
      if (b.type === 'meal') stat.meal += b.minutes;
      if (b.type === 'break') stat.break += b.minutes;
      if (b.type === 'meeting') stat.meeting += b.minutes;
    }
    return stat;
  }

  function renderSimpleWorkerBoard(result) {
    const workers = result.workers || [];
    if (!workers.length) return '';

    const cards = workers.map(function(w) {
      const blocks = buildMergedBlocks(w);
      const chips = blocks.map(function(b) {
        const cls = 'chip ' + segmentClass(b.type, b.label);
        const label = b.type === 'work' ? shortWorkLabel(b.label) : (b.label || getTypeVisual(b.type).name);
        return '<div class="' + cls + '">' +
          '<div class="chip-top">' +
            '<span>' + renderTypeBadge(b.type, b.label) + '</span>' +
            '<span class="chip-time">' + escapeHtml(fmtRange(b.start, b.end)) + '</span>' +
          '</div>' +
          '<div class="chip-main">' + escapeHtml(label) + '</div>' +
          '<div class="chip-sub">' + escapeHtml(String(b.minutes) + '분') + '</div>' +
          '</div>';
      }).join('');

      return '<div class="simple-worker-card">' +
        '<div class="simple-head">' +
          '<div><div class="name">' + escapeHtml(workerHeaderName(w)) + '</div><div class="meta">' + escapeHtml(workerHeaderMeta(w)) + '</div></div>' +
        '</div>' +
        '<div class="chip-list">' + chips + '</div>' +
      '</div>';
    }).join('');

    return '<div class="simple-section">' +
      '<div class="simple-title">출근시간별 핵심 스케줄</div>' +
      '<div class="muted small" style="margin:0 0 8px 0">블록 크기를 일정하게 맞춘 보기입니다. 실제 시간은 블록 안에 표시됩니다.</div>' +
      '<div class="simple-worker-grid">' + cards + '</div>' +
    '</div>';
  }

  function renderOpsOverview(result) {
    const rows = (result.coverageSummary && result.coverageSummary.by15 ? result.coverageSummary.by15 : []);
    if (!rows.length) return '';

    const merged = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = [r.elvMin, r.outMin, r.f3Min, r.f3Max, r.f3CartMin, r.f3CartMax, r.assistMin, r.assistMax, r.cartMin, r.cartMax, r.mealMaxNonClose, r.ok].join('|');
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (prev && prev.key === key && prev.end === r.t) {
        prev.end = r.t + 15;
      } else {
        merged.push({
          key,
          start: r.t,
          end: r.t + 15,
          ok: r.ok,
          main2f: r.elvMin + r.outMin,
          f3: (r.f3Min === r.f3Max ? String(r.f3Min) : (r.f3Min + '~' + r.f3Max)),
          f3cart: (r.f3CartMin === r.f3CartMax ? String(r.f3CartMin) : (r.f3CartMin + '~' + r.f3CartMax)),
          assist: (r.assistMin === r.assistMax ? String(r.assistMin) : (r.assistMin + '~' + r.assistMax)),
          cart: (r.cartMin === r.cartMax ? String(r.cartMin) : (r.cartMin + '~' + r.cartMax)),
          meal: String(r.mealMaxNonClose)
        });
      }
    }

    const items = merged.slice(0, 28).map(m => {
      return '<div class="ops-block ' + (m.ok ? '' : 'bad') + '">' +
        '<div class="ops-time">' + escapeHtml(fmtRange(m.start, m.end)) + '</div>' +
        '<div class="ops-lines">' +
          '<span>2F ' + escapeHtml(String(m.main2f)) + '명</span>' +
          '<span>3F ' + escapeHtml(m.f3) + '명</span>' +
          '<span>3F카트 ' + escapeHtml(m.f3cart || 0) + '명</span>' +
          '<span>보조 ' + escapeHtml(m.assist) + '명</span>' +
          '<span>2F카트 ' + escapeHtml(m.cart) + '명</span>' +
          '<span>식사 ' + escapeHtml(m.meal) + '명</span>' +
        '</div>' +
      '</div>';
    }).join('');

    const more = merged.length > 28 ? '<div class="muted small">외 ' + (merged.length - 28) + '개 구간은 상세 보기에서 확인</div>' : '';
    return '<div class="simple-section">' +
      '<div class="simple-title">시간대별 운영 요약</div>' +
      '<div class="simple-sub muted">15분 단위를 연속 구간으로 병합한 간단표 · ' + BREAK_RULE_TEXT + '</div>' +
      '<div class="ops-grid">' + items + '</div>' +
      more +
    '</div>';
  }

  function workerHeaderName(w) {
    return (w && w.startTime ? (w.startTime + ' 출근자') : (w && w.name ? String(w.name) : '근무자'));
  }

  function workerHeaderMeta(w) {
    const parts = [];
    if (w && w.name) parts.push(String(w.name));
    if (w && w.group) parts.push(String(w.group));
    if (w && w.hours != null) parts.push(String(w.hours) + '시간');
    if (w && Number.isFinite(w.endMin)) parts.push('퇴근 ' + minToTime(w.endMin));
    return parts.join(' · ');
  }


  function buildCalendarMarkup(result, title, sub) {
    if (!result || !result.workers || !result.workers.length) return '';

    const workers = (result.workers || []).slice().sort(function(a, b) {
      return (a.startMin - b.startMin) || String(a.name || '').localeCompare(String(b.name || ''));
    });
    const orderByStart = {};
    workers.forEach(function(w) {
      orderByStart[w.startTime] = (orderByStart[w.startTime] || 0) + 1;
      w._sheetLabel = w.startTime + '-' + orderByStart[w.startTime];
    });

    const minStartRaw = Math.min.apply(null, workers.map(function(w) { return w.startMin; }));
    const maxEndRaw = Math.max.apply(null, workers.map(function(w) { return w.endMin; }));
    const SHEET_STEP = 5;
    const minStart = Math.floor(minStartRaw / SHEET_STEP) * SHEET_STEP;
    const maxEnd = Math.ceil(maxEndRaw / SHEET_STEP) * SHEET_STEP;
    const slots = [];
    for (let t = minStart; t < maxEnd; t += SHEET_STEP) slots.push({ start: t, end: t + SHEET_STEP });

    function segForSlot(worker, slot) {
      if (!worker || !worker.segments) return null;
      const mid = slot.start + Math.floor(SHEET_STEP / 2);
      let seg = worker.segments.find(function(s) { return s.start <= mid && mid < s.end; });
      if (seg) return seg;
      return worker.segments.find(function(s) { return s.start < slot.end && s.end > slot.start; }) || null;
    }

    function shortLabel(seg) {
      if (!seg) return '';
      if (seg.type === 'work') {
        if (seg.label === '2F 엘베') return '엘베';
        if (seg.label === '2F 출차') return '출차';
        if (seg.label === '2F 보조') return '보조';
        if (seg.label === '2F 카트 내림') return '2F카트';
        if (seg.label === '3F 카트 내림') return '3F카트';
        return seg.label || '근무';
      }
      if (seg.type === 'meal') return '식사';
      if (seg.type === 'break') return '휴식';
      if (seg.type === 'prep') return '준비';
      if (seg.type === 'meeting') return '회의';
      return '';
    }

    function cellKey(seg) {
      if (!seg) return 'empty';
      return [seg.type || '', seg.label || '', seg.id || ''].join('|');
    }

    const headTimes = (function() {
      const cells = [];
      for (let i = 0; i < slots.length; ) {
        const slot = slots[i];
        let span = 1;
        while (i + span < slots.length && span < 6) span += 1;
        cells.push('<th class="sheet-time-col" colspan="' + span + '" title="' + escapeHtml(fmtRange(slot.start, slots[i + span - 1].end)) + '">' + escapeHtml(minToTime(slot.start)) + '</th>');
        i += span;
      }
      return cells.join('');
    })();

    const bodyRows = workers.map(function(worker) {
      const cells = [];
      let idx = 0;
      while (idx < slots.length) {
        const seg = segForSlot(worker, slots[idx]);
        const key = cellKey(seg);
        let span = 1;
        while (idx + span < slots.length && cellKey(segForSlot(worker, slots[idx + span])) === key) span += 1;
        if (!seg) {
          cells.push('<td class="sheet-cell sheet-empty" colspan="' + span + '"><div class="cell-inner"><div class="main">-</div></div></td>');
        } else {
          const cls = 'sheet-cell ' + segmentClass(seg.type, seg.label);
          const label = shortLabel(seg);
          const minutes = seg.end - seg.start;
          const titleText = (seg.label || label || '') + ' · ' + fmtRange(seg.start, seg.end);
          cells.push('<td class="' + cls + '" colspan="' + span + '" title="' + escapeHtml(titleText) + '">' +
            '<div class="cell-inner">' +
              '<div class="main">' + escapeHtml(label) + '</div>' +
              '<div class="sub">' + escapeHtml(minutes + '분') + '</div>' +
            '</div>' +
          '</td>');
        }
        idx += span;
      }
      return '<tr>' +
        '<th class="sheet-sticky sheet-worker-col"><div class="sheet-worker-name">' + escapeHtml(worker._sheetLabel || workerHeaderName(worker)) + '</div><div class="sheet-worker-meta">' + escapeHtml((worker.group || '') + ' · ' + String(worker.hours || '') + 'h') + '</div></th>' +
        cells.join('') +
      '</tr>';
    }).join('');

    return '<div class="sheet-card">' +
      '<div class="sheet-head"><div class="sheet-title">' + escapeHtml(title || '엑셀형 시간표') + '</div><div class="sheet-note">행=출근자 · 상단 시간은 30분 단위로 크게 표시</div></div>' +
      '<div class="sheet-wrap">' +
        '<table class="sheet-table sheet-compact">' +
          '<thead><tr><th class="sheet-sticky sheet-worker-col">출근자</th>' + headTimes + '</tr></thead>' +
          '<tbody>' + bodyRows + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';
  }

  function renderCalendarView(result) {
    const mount = document.getElementById('calendarResult');
    if (!mount) return;
    if (!result || !result.workers || !result.workers.length) {
      mount.innerHTML = '';
      return;
    }

    mount.innerHTML = buildCalendarMarkup(result, '출근시간별 위치', '');
  }



  function renderSimpleResult(result) {
    const mount = document.getElementById('simpleResult');
    if (!mount) return;
    if (!result || !result.workers || !result.workers.length) {
      mount.innerHTML = '';
      return;
    }
    mount.innerHTML = renderSimpleWorkerBoard(result) +
      '<div class="sheet-chip-row">' +
        '<span class="sheet-chip">엘베=2F 엘베</span>' +
        '<span class="sheet-chip">출차=2F 출차</span>' +
        '<span class="sheet-chip">보조=2F 보조</span>' +
        '<span class="sheet-chip">2F카트=2F 카트 내림</span>' +
        '<span class="sheet-chip">3F카트=3F 카트 내림</span>' +
        '<span class="sheet-chip">식사=1시간</span>' +
        '<span class="sheet-chip">회의=안전회의</span>' +
      '</div>';
  }


  function renderMobileResult(result) {
    const mount = document.getElementById('mobileResult');
    if (!mount) return;
    if (!result || !result.workers || !result.workers.length) {
      mount.innerHTML = '';
      return;
    }

    mount.innerHTML = result.workers.map((w, idx) => {
      const blocks = buildMergedBlocks(w);
      const timelineRows = blocks.map(b => {
        const cls = segmentClass(b.type, b.label);
        const v = getTypeVisual(b.type);
        const shortLabel = b.type === 'work' ? shortWorkLabel(b.label || '-') : (b.label || v.name);
        return '<div class="mobile-row mobile-block">' +
          '<div class="t">' + escapeHtml(fmtRange(b.start, b.end)) + '</div>' +
          '<div class="v ' + cls + '">' +
            '<div class="line0">' + renderTypeBadge(b.type, b.label) + '</div>' +
            '<div class="line1">' + escapeHtml(shortLabel) + '</div>' +
            '<div class="line2">' + escapeHtml(b.minutes + '분') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      const uiWorkerWarnings = filterUiWorkerWarnings(w.warnings || []);
      const warningsHtml = uiWorkerWarnings.length ? renderWarningFold('근무자 경고', uiWorkerWarnings) : '';

      return '<details class="mobile-worker-card" ' + (idx < 2 ? 'open' : '') + '>' +
        '<summary class="top">' +
          '<div>' +
            '<div class="name">' + escapeHtml(w.name) + '</div>' +
            '<div class="meta">' + escapeHtml(w.startTime) + ' · ' + escapeHtml(w.hours) + '시간 · ' + escapeHtml(w.group || '') + '</div>' +
          '</div>' +
          '<div class="summary-tags"><span class="tag">상세</span><span class="chev">▾</span></div>' +
        '</summary>' +
        warningsHtml +
        '<div class="mobile-timeline">' + timelineRows + '</div>' +
      '</details>';
    }).join('');
  }

  function renderSlotHealth(result) {
    const rows = (result.coverageSummary && result.coverageSummary.by15 ? result.coverageSummary.by15 : []).slice(0, 9999);
    if (!rows.length) return '';
    const head = rows.slice(0, 12).map(r => {
      const bad = !r.ok;
      return '<div class="slot-item ' + (bad ? 'bad' : '') + '">' +
        '<div class="time">' + escapeHtml(r.time) + '</div>' +
        '<div>2F ' + (r.elvMin + r.outMin) + '명</div>' +
        '<div>3F ' + r.f3Min + '~' + r.f3Max + '</div>' +
        '<div>3F카트 ' + (r.f3CartMin || 0) + '~' + (r.f3CartMax || 0) + '</div>' +
        '<div>보조 ' + r.assistMin + '~' + r.assistMax + '</div>' +
        '<div>2F카트 ' + r.cartMin + '~' + r.cartMax + '</div>' +
      '</div>';
    }).join('');
    return '<details class="fold-panel inline-fold"><summary>시간대별 인원 체크 (일부)</summary><div class="slot-health"><div class="slot-grid">' + head + '</div></div></details>';
  }

  function renderResult(table, summaryEl, result) {
    const workers = result.workers || [];
    const timeline = result.timeline || [];
    const groupCounts = result.groupCounts || {};
    const globalWarnings = result.globalWarnings || [];
    const uiWarnings = filterUiWarnings(globalWarnings);

    if (table) {
      const thead = table.querySelector('thead');
      const tbody = table.querySelector('tbody');
      const rows = reducedTimeline(timeline);
      if (thead && tbody) {
        thead.innerHTML = '<tr><th class="time-col">시간</th>' + workers.map(function(w) {
          return '<th>' + escapeHtml(workerHeaderName(w)) + '</th>';
        }).join('') + '</tr>';

        tbody.innerHTML = rows.map(function(row, rowIdx) {
          const cells = workers.map(function(w) {
            const seg = row.cells[w.id];
            if (!seg) return '<td class="cell-empty"></td>';
            const prevRow = rowIdx > 0 ? rows[rowIdx - 1] : null;
            const prevSeg = prevRow ? prevRow.cells[w.id] : null;
            const isCont = prevSeg && seg && prevSeg.type === seg.type && prevSeg.label === seg.label;
            const html = isCont ? '' : renderDesktopCellLabel(seg);
            const contClass = isCont ? ' cell-cont' : '';
            return '<td class="' + segmentClass(seg.type, seg.label) + contClass + '">' + html + '</td>';
          }).join('');
          return '<tr><td class="time-col">' + escapeHtml(row.time) + '</td>' + cells + '</tr>';
        }).join('');
      }
    }

    summaryEl.innerHTML =
      '<div><strong>총 ' + workers.length + '명</strong> · 오픈조 ' + (groupCounts['오픈조'] || 0) + ' · 중간조 ' + (groupCounts['중간조'] || 0) + ' · 마감조 ' + (groupCounts['마감조'] || 0) + '</div>' +
      '<div class="counts">' +
        '<span class="pill">출근시간별 위치</span>' +
        '<span class="pill">모든 근무시간은 근무지 배정 보장 · 식사/휴식 중에는 카트내림 제외 근무지 우선 유지(로테이션 허용) · 한 근무지 최대 60분 · 2F 엘베·2F 출차·3F는 60분 고정 · 2F 보조는 자동생성보다 축소 우선 · 2F카트·3F카트가 잔여 시간을 흡수</span>' +
        '<span class="pill">식사 1시간</span>' +
      '</div>' +
      renderWarningFold('경고', uiWarnings);

    renderCalendarView(result);
    renderSimpleResult(result);
    renderMobileResult(result);
    var printMount = document.getElementById('printA4');
    if (printMount) printMount.innerHTML = renderA4PrintHtml(result);
    var previewMount = document.getElementById('printA4Preview');
    if (previewMount) previewMount.innerHTML = renderA4PrintHtml(result);
  }

  function csvEscape(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  }

  function isAndroidBrowser() {
    return /Android/i.test(navigator.userAgent || '');
  }

  function saveBlobCompat(filename, blob, mimeType, fallbackText) {
    const nav = navigator;
    if (isAndroidBrowser() && nav && typeof nav.share === 'function' && typeof File === 'function') {
      try {
        const file = new File([blob], filename, { type: mimeType || blob.type || 'application/octet-stream' });
        if (!nav.canShare || nav.canShare({ files: [file] })) {
          return nav.share({ files: [file], title: filename }).catch(function() {
            return false;
          });
        }
      } catch (e) {}
    }
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function() {
        URL.revokeObjectURL(url);
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 250);
      return Promise.resolve(true);
    } catch (e) {
      try {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(function() { URL.revokeObjectURL(url); }, 4000);
        return Promise.resolve(true);
      } catch (e2) {
        if (fallbackText && nav && nav.clipboard && nav.clipboard.writeText) {
          return nav.clipboard.writeText(fallbackText).then(function() {
            alert('다운로드 대신 텍스트를 복사했습니다. 붙여넣어 저장하세요.');
            return true;
          }).catch(function() {
            alert('저장에 실패했습니다. 다른 브라우저에서 다시 시도하세요.');
            return false;
          });
        }
        alert('저장에 실패했습니다. 다른 브라우저에서 다시 시도하세요.');
        return Promise.resolve(false);
      }
    }
  }

  function downloadCsv(result) {
    if (!result || !result.timeline) return;
    const workers = result.workers || [];
    const timeline = result.timeline || [];
    const rows = [];
    rows.push(['시간'].concat(workers.map(w => w.name + '(' + w.startTime + '/' + w.hours + 'h)')));
    for (const r of timeline) {
      rows.push([r.time].concat(workers.map(w => (r.cells[w.id] && r.cells[w.id].label) ? r.cells[w.id].label : '')));
    }
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    return saveBlobCompat('schedule.csv', blob, 'text/csv;charset=utf-8;', csv);
  }


  function renderDayWorkerDetail(day) {
    const schedule = day && day.detailSchedule ? day.detailSchedule : null;
    const workers = schedule && Array.isArray(schedule.workers) ? schedule.workers : [];
    if (!workers.length) {
      return '<div class="muted small">상세 스케줄이 없습니다.</div>';
    }
    const calendarHtml = buildCalendarMarkup(schedule, '출근시간별 위치', '');
    return '<div class="day-detail-body">' + calendarHtml + '</div>';
  }

  function renderWeekDayDetails(week) {
    const cards = week.days.map(function(day) {
      return '<details class="day-detail-card">' +
        '<summary><span>' + escapeHtml(day.dateStr + ' (' + day.dayName + ')') + '</span><span class="sum-right">' + escapeHtml(String(day.count)) + '명</span></summary>' +
        renderDayWorkerDetail(day) +
      '</details>';
    }).join('');
    return '<div class="day-detail-grid">' + cards + '</div>';
  }





  return { initStartOptions, renderWorkerList, renderResult, downloadCsv};
})();

