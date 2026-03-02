(function(){
  'use strict';
  // app.js는 DOM 이벤트 바인딩/상태관리/스크린 렌더링을 담당합니다.
  // 모듈화 과정에서 IIFE와 부트 가드가 누락되면 전체 기능이 중단되므로 반드시 유지합니다.
  let __booted = false;

  function boot() {
    if (__booted) return;
    __booted = true;
    document.body.classList.toggle('is-android', /Android/i.test(navigator.userAgent || ''));
    const { generateSchedule, generateClosing4WeekTable } = window.Scheduler;
    const { initStartOptions, renderWorkerList, renderResult, downloadCsv, renderClosing4Week, downloadClosingCsv } = window.UI;
    const { generateId } = window.Utils;

    const els = {
      workerName: document.getElementById('workerName'),
      workerStart: document.getElementById('workerStart'),
      workerHours: document.getElementById('workerHours'),
      addWorkerBtn: document.getElementById('addWorkerBtn'),
      cancelEditBtn: document.getElementById('cancelEditBtn'),
      workerList: document.getElementById('workerList'),
      demoBtn: document.getElementById('demoBtn'),
      clearBtn: document.getElementById('clearBtn'),
      exportStateBtn: document.getElementById('exportStateBtn'),
      importStateBtn: document.getElementById('importStateBtn'),
      importStateFile: document.getElementById('importStateFile'),
      generateBtn: document.getElementById('generateBtn'),
      resultTable: document.getElementById('resultTable'),
      summary: document.getElementById('summary'),
      downloadCsvBtn: document.getElementById('downloadCsvBtn'),
      printA4Btn: document.getElementById('printA4Btn'),
      mobileResult: document.getElementById('mobileResult'),
      errorBox: document.getElementById('errorBox'),
      fourWeekStartDate: document.getElementById('fourWeekStartDate'),
      generateClosing4WeekBtn: document.getElementById('generateClosing4WeekBtn'),
      useTodayWeekBtn: document.getElementById('useTodayWeekBtn'),
      closing4Summary: document.getElementById('closing4Summary'),
      closing4Week: document.getElementById('closing4Week'),
      downloadClosingCsvBtn: document.getElementById('downloadClosingCsvBtn'),
      middleCountInputs: Array.prototype.slice.call(document.querySelectorAll('[data-middle-count]')),
      middleTimeContainers: Array.prototype.slice.call(document.querySelectorAll('[data-middle-times-container]'))
    };

    function showError(msg, err) {
      console.error(err || msg);
      if (els.errorBox) {
        els.errorBox.textContent = msg;
        els.errorBox.style.display = 'block';
      }
      try { if (!/iP(ad|hone|od)/i.test(navigator.userAgent || '')) alert(msg); } catch (_) {}
    }
    function clearError() {
      if (els.errorBox) {
        els.errorBox.textContent = '';
        els.errorBox.style.display = 'none';
      }
    }

    function requireElement(key, label) {
      if (!els[key]) throw new Error(label + ' 버튼/영역을 찾지 못했습니다. 파일이 손상되었을 수 있습니다.');
      return els[key];
    }

    function safeBindButton(el, handler) {
      if (!el) return;
      el.addEventListener('click', function(e) {
        e.preventDefault();
        try {
          handler(e);
        } catch (err) {
          showError('버튼 실행 중 오류가 발생했습니다: ' + (err && err.message ? err.message : err), err);
        }
      }, { passive: false });
    }

    let workers = [];
    let currentResult = null;
    let editingId = null;

    requireElement('workerName', '이름 입력');
    requireElement('workerStart', '출근시간 선택');
    requireElement('workerHours', '근무시간 선택');
    requireElement('addWorkerBtn', '추가');
    requireElement('cancelEditBtn', '취소');
    requireElement('workerList', '근무자 목록');
    requireElement('demoBtn', '샘플 인원');
    requireElement('clearBtn', '전체 삭제');
    requireElement('generateBtn', '스케줄 생성');
    requireElement('downloadCsvBtn', 'CSV');
    requireElement('printA4Btn', 'A4 인쇄');

    initStartOptions(els.workerStart);
    els.workerStart.value = '08:30';

    function defaultMiddleConfig() {
      return {
        1: { times: ['10:30'] },
        2: { times: ['10:30'] },
        3: { times: ['10:30'] },
        4: { times: ['10:30'] },
        5: { times: ['12:30'] },
        6: { times: ['10:30'] },
        0: { times: ['10:30'] }
      };
    }

    function getMiddleCountInput(day) {
      return document.querySelector('[data-middle-count][data-middle-day="' + day + '"]');
    }

    function getMiddleTimeContainer(day) {
      return document.querySelector('[data-middle-times-container="' + day + '"]');
    }

    function readMiddleTimesFromDom(day) {
      const container = getMiddleTimeContainer(day);
      if (!container) return [];
      return Array.prototype.slice.call(container.querySelectorAll('select[data-middle-time]')).map(function(select) {
        return select.value || '10:30';
      });
    }

    function renderMiddleTimeControls(day, values) {
      const container = getMiddleTimeContainer(day);
      const countInput = getMiddleCountInput(day);
      if (!container || !countInput) return;
      const count = Math.max(1, Math.min(10, Math.round(Number(countInput.value) || 1)));
      countInput.value = String(count);
      const current = Array.isArray(values) && values.length ? values.slice() : readMiddleTimesFromDom(day);
      container.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const row = document.createElement('div');
        row.className = 'middle-time-item';
        const label = document.createElement('div');
        label.className = 'slot-label';
        label.textContent = '중간' + (i + 1);
        const select = document.createElement('select');
        select.setAttribute('data-middle-time', '1');
        select.setAttribute('data-middle-day', String(day));
        select.setAttribute('data-middle-index', String(i));
        initStartOptions(select);
        select.value = current[i] || current[current.length - 1] || '10:30';
        row.appendChild(label);
        row.appendChild(select);
        container.appendChild(row);
      }
    }

    function initMiddleConfigControls() {
      const defaults = defaultMiddleConfig();
      [1, 2, 3, 4, 5, 6, 0].forEach(function(day) {
        const countInput = getMiddleCountInput(day);
        if (countInput) countInput.value = String((defaults[day] && defaults[day].times ? defaults[day].times.length : 1));
        renderMiddleTimeControls(day, defaults[day] ? defaults[day].times : ['10:30']);
      });
      els.middleCountInputs.forEach(function(input) {
        input.addEventListener('change', function() {
          const day = input.getAttribute('data-middle-day');
          renderMiddleTimeControls(day, readMiddleTimesFromDom(day));
        });
        input.addEventListener('input', function() {
          const day = input.getAttribute('data-middle-day');
          renderMiddleTimeControls(day, readMiddleTimesFromDom(day));
        });
      });
    }

    function readMiddleConfig() {
      const cfg = defaultMiddleConfig();
      [1, 2, 3, 4, 5, 6, 0].forEach(function(day) {
        const times = readMiddleTimesFromDom(day).filter(function(v) { return !!v; });
        cfg[day] = { times: times.length ? times : (cfg[day] ? cfg[day].times.slice() : ['10:30']) };
      });
      return cfg;
    }

    initMiddleConfigControls();

    function fmtInputDate(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }

    function mondayOf(date) {
      const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      return d;
    }

    let currentClosing4Week = null;
    if (els.fourWeekStartDate) els.fourWeekStartDate.value = fmtInputDate(mondayOf(new Date()));

    function refreshWorkers() {
      renderWorkerList(els.workerList, workers,
        (id) => {
          // 삭제
          workers = workers.filter(w => w.id !== id);
          if (editingId === id) cancelEdit();
          refreshWorkers();
          clearResults();
          saveState();
        },
        (id) => {
          // 수정
          startEdit(id);
        }
      );
      els.generateBtn.disabled = workers.length === 0;
    }

    
    function startEdit(id) {
      const w = workers.find(function(x) { return x.id === id; });
      if (!w) return;
      editingId = id;
      if (els.workerName) els.workerName.value = w.name || '';
      if (els.workerStart) els.workerStart.value = w.startTime || '08:30';
      if (els.workerHours) els.workerHours.value = String(w.hours || 8);
      if (els.addWorkerBtn) els.addWorkerBtn.textContent = '변경 저장';
      if (els.cancelEditBtn) els.cancelEditBtn.style.display = '';
      try { if (els.workerName) els.workerName.focus(); } catch (_) {}
      try {
        const card = els.workerName && els.workerName.closest && els.workerName.closest('section');
        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {}
    }

    function cancelEdit() {
      editingId = null;
      if (els.workerName) els.workerName.value = '';
      if (els.addWorkerBtn) els.addWorkerBtn.textContent = '추가';
      if (els.cancelEditBtn) els.cancelEditBtn.style.display = 'none';
    }
function addWorker(name, startTime, hours) {
      if (!name) return;
      const h = Number(hours) === 6 ? 6 : 8;

      // 편집 모드: 기존 항목 수정
      if (editingId) {
        const idx = workers.findIndex(function(w) { return w.id === editingId; });
        if (idx >= 0) {
          workers[idx] = { id: workers[idx].id, name: name, startTime: startTime, hours: h };
          refreshWorkers();
          cancelEdit();
          saveState();
          return;
        } else {
          // 편집 대상이 사라졌으면 편집 모드 해제 후 추가로 처리
          cancelEdit();
        }
      }

      // 신규 추가
      if (workers.length >= 40) {
        showError('최대 40명까지 등록 가능합니다.');
        return;
      }
      workers.push({ id: generateId(), name: name, startTime: startTime, hours: h });
      refreshWorkers();
      saveState();
    }

    function clearResults() {
      currentResult = null;
      if (els.summary) els.summary.innerHTML = '';
      if (els.resultTable) {
        const thead = els.resultTable.querySelector('thead');
        const tbody = els.resultTable.querySelector('tbody');
        if (thead) thead.innerHTML = '';
        if (tbody) tbody.innerHTML = '';
      }
      const cal = document.getElementById('calendarResult');
      const simple = document.getElementById('simpleResult');
      if (cal) cal.innerHTML = '';
      if (simple) simple.innerHTML = '';
      if (els.mobileResult) els.mobileResult.innerHTML = '';
    }

    
    // ====== 상태 저장/복원 (localStorage) ======
    const STATE_KEY = 'work_scheduler_state_v1';

    function safeJsonParse(s) {
      try { return JSON.parse(s); } catch (_) { return null; }
    }

    function writeMiddleConfigToUI(config) {
      const cfg = (config && typeof config === 'object') ? config : {};
      [1, 2, 3, 4, 5, 6, 0].forEach(function(day) {
        const item = cfg[day] || cfg[String(day)] || {};
        const times = Array.isArray(item.times) ? item.times : [];
        const countInput = getMiddleCountInput(day);
        const count = Math.max(1, Math.min(10, (times.length || Math.round(Number(item.count) || 1))));
        if (countInput) countInput.value = String(count);
        renderMiddleTimeControls(day, times.length ? times : null);
      });
    }

    function buildStateSnapshot() {
      return {
        v: 1,
        savedAt: new Date().toISOString(),
        workers: (workers || []).map(function(w) {
          return { id: w.id, name: w.name, startTime: w.startTime, hours: Number(w.hours) };
        }),
        middleConfig: readMiddleConfig(),
        fourWeekStartDate: (els.fourWeekStartDate && els.fourWeekStartDate.value) ? els.fourWeekStartDate.value : ''
      };
    }

    function saveState() {
      try {
        const snap = buildStateSnapshot();
        localStorage.setItem(STATE_KEY, JSON.stringify(snap));
      } catch (e) {
        console.warn('saveState failed', e);
      }
    }

    function applyStateSnapshot(snap, opts) {
      opts = opts || {};
      if (!snap || snap.v !== 1) return false;

      // workers 복원
      const arr = Array.isArray(snap.workers) ? snap.workers : [];
      workers = arr
        .filter(function(w) { return w && w.name && w.startTime; })
        .slice(0, 40)
        .map(function(w) {
          return {
            id: w.id || generateId(),
            name: String(w.name),
            startTime: String(w.startTime),
            hours: (Number(w.hours) === 6 ? 6 : 8)
          };
        });

      cancelEdit();
      refreshWorkers();

      // 중간조 설정 복원
      if (snap.middleConfig) {
        try { writeMiddleConfigToUI(snap.middleConfig); } catch (_) {}
      }

      // 4주 시작일 복원
      if (els.fourWeekStartDate && typeof snap.fourWeekStartDate === 'string' && snap.fourWeekStartDate) {
        els.fourWeekStartDate.value = snap.fourWeekStartDate;
      }

      clearResults();

      // 가져오기/자동복원 시 4주 표도 즉시 갱신
      if (!opts.skipClosing4Week && (els.closing4Week || els.closing4Summary)) {
        try {
          currentClosing4Week = generateClosing4WeekTable(els.fourWeekStartDate ? els.fourWeekStartDate.value : '', readMiddleConfig());
          renderClosing4Week(els.closing4Week, els.closing4Summary, currentClosing4Week);
        } catch (_) {}
      }

      return true;
    }

    function loadState() {
      try {
        const raw = localStorage.getItem(STATE_KEY);
        const snap = safeJsonParse(raw);
        return applyStateSnapshot(snap, { skipClosing4Week: true });
      } catch (_) {
        return false;
      }
    }

    function downloadJson(filename, obj) {
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // 설정 변경 시 자동 저장 (DOM 갱신이 끝난 다음 저장)
    document.addEventListener('change', function(e) {
      const t = e && e.target;
      if (!t) return;
      const isMiddle = (t.hasAttribute && (t.hasAttribute('data-middle-count') || t.hasAttribute('data-middle-time')));
      const is4WeekDate = (t.id === 'fourWeekStartDate');
      if (isMiddle || is4WeekDate) {
        setTimeout(saveState, 0);
      }
    }, { passive: true });

    // 내보내기/가져오기
    safeBindButton(els.exportStateBtn, function() {
      clearError();
      const snap = buildStateSnapshot();
      downloadJson('work_scheduler_state.json', snap);
    });

    safeBindButton(els.importStateBtn, function() {
      clearError();
      if (els.importStateFile) els.importStateFile.click();
    });

    if (els.importStateFile) {
      els.importStateFile.addEventListener('change', function() {
        clearError();
        const file = els.importStateFile.files && els.importStateFile.files[0];
        if (!file) return;

        const done = function(text) {
          const snap = safeJsonParse(text);
          const ok = applyStateSnapshot(snap);
          if (!ok) showError('가져오기 실패: 파일 형식이 올바르지 않습니다.');
          else saveState();
          els.importStateFile.value = '';
        };

        if (file.text) {
          file.text().then(done).catch(function(e) {
            showError('가져오기 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), e);
          });
        } else {
          const reader = new FileReader();
          reader.onload = function() { done(String(reader.result || '')); };
          reader.onerror = function(e) { showError('가져오기 중 오류가 발생했습니다.', e); };
          reader.readAsText(file);
        }
      });
    }
safeBindButton(els.addWorkerBtn, function() {
      clearError();
      const name = (els.workerName.value || '').trim();
      if (!name) {
        showError('이름을 입력하세요.');
        return;
      }
      addWorker(name, els.workerStart.value, els.workerHours.value);
      els.workerName.value = '';
      els.workerName.focus();
    });

    safeBindButton(els.cancelEditBtn, function() {
      clearError();
      cancelEdit();
    });


    [els.workerName, els.workerStart, els.workerHours].forEach(function(inputEl) {
      if (!inputEl) return;
      inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (els.addWorkerBtn) els.addWorkerBtn.click();
        }
      });
    });

    safeBindButton(els.demoBtn, function() {
      clearError();
      workers = [];
      cancelEdit();
      const demo = [
        ['오픈1', '08:30', 8], ['오픈2', '08:30', 8],
        ['중간1', '09:15', 8], ['중간2', '10:00', 6], ['중간3', '10:45', 8],
        ['중간4', '11:30', 6], ['중간5', '12:15', 8],
        ['마감1', '13:30', 8], ['마감2', '13:30', 8], ['마감3', '13:50', 8], ['마감4', '13:50', 6]
      ];
      for (const d of demo) addWorker(d[0], d[1], d[2]);
      saveState();
    });

    safeBindButton(els.clearBtn, function() {
      clearError();
      workers = [];
      cancelEdit();
      refreshWorkers();
      clearResults();
      saveState();
    });

    safeBindButton(els.generateBtn, function() {
      clearError();
      try {
        if (!workers.length) {
          showError('근무자를 먼저 등록하세요.');
          return;
        }
        els.generateBtn.disabled = true;
        els.generateBtn.textContent = '생성중...';
        currentResult = generateSchedule(workers);
        renderResult(els.resultTable, els.summary, currentResult);
      } catch (e) {
        showError('스케줄 생성 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), e);
      } finally {
        els.generateBtn.disabled = workers.length === 0;
        els.generateBtn.textContent = '스케줄 생성';
      }
    });

    safeBindButton(els.downloadCsvBtn, function() {
      clearError();
      try {
        if (!currentResult) {
          showError('먼저 스케줄을 생성하세요.');
          return;
        }
        downloadCsv(currentResult);
      } catch (e) {
        showError('CSV 다운로드 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), e);
      }
    });


    safeBindButton(els.printA4Btn, function() {
      clearError();
      try {
        if (!currentResult) {
          showError('먼저 스케줄을 생성하세요.');
          return;
        }
        var previewMount = document.getElementById('printA4Preview');
        if (previewMount) previewMount.innerHTML = '출력 시 현재 화면의 결과 UI가 그대로 반영됩니다.';
        var printMount = document.getElementById('printA4');
        if (printMount) printMount.innerHTML = '';
        window.print();
      } catch (e) {
        showError('출력 준비 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), e);
      }
    });


    if (els.generateClosing4WeekBtn) {
      safeBindButton(els.generateClosing4WeekBtn, function() {
        clearError();
        try {
          currentClosing4Week = generateClosing4WeekTable(els.fourWeekStartDate ? els.fourWeekStartDate.value : '', readMiddleConfig());
          renderClosing4Week(els.closing4Week, els.closing4Summary, currentClosing4Week);
          saveState();
        } catch (e) {
          showError('4주 표 생성 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), e);
        }
      });
    }

    if (els.useTodayWeekBtn) {
      safeBindButton(els.useTodayWeekBtn, function() {
        clearError();
        try {
          if (els.fourWeekStartDate) els.fourWeekStartDate.value = fmtInputDate(mondayOf(new Date()));
          currentClosing4Week = generateClosing4WeekTable(els.fourWeekStartDate ? els.fourWeekStartDate.value : '', readMiddleConfig());
          renderClosing4Week(els.closing4Week, els.closing4Summary, currentClosing4Week);
          saveState();
        } catch (e) {
          showError('이번 주 기준 표 생성 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), e);
        }
      });
    }

    if (els.downloadClosingCsvBtn) {
      safeBindButton(els.downloadClosingCsvBtn, function() {
        clearError();
        try {
          if (!currentClosing4Week) {
            currentClosing4Week = generateClosing4WeekTable(els.fourWeekStartDate ? els.fourWeekStartDate.value : '', readMiddleConfig());
            renderClosing4Week(els.closing4Week, els.closing4Summary, currentClosing4Week);
          }
          downloadClosingCsv(currentClosing4Week);
        } catch (e) {
          showError('4주 CSV 다운로드 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), e);
        }
      });
    }
    // 저장된 상태가 있으면 자동 복원
    loadState();
    refreshWorkers();
    clearResults();
    try {
      currentClosing4Week = generateClosing4WeekTable(els.fourWeekStartDate ? els.fourWeekStartDate.value : "", readMiddleConfig());
      renderClosing4Week(els.closing4Week, els.closing4Summary, currentClosing4Week);
    } catch (bootErr) {
      if (els.errorBox) {
        els.errorBox.textContent = '초기 4주 표 생성은 건너뛰었습니다. 버튼으로 다시 생성하면 됩니다. ' + (bootErr && bootErr.message ? bootErr.message : bootErr);
        els.errorBox.style.display = 'block';
      }
      currentClosing4Week = null;
    }
  }

  window.addEventListener('error', (e) => {
    const box = document.getElementById('errorBox');
    if (box) {
      box.textContent = '오류: ' + (e.message || '알 수 없는 오류');
      box.style.display = 'block';
    }
  });

  window.addEventListener('unhandledrejection', function(e) {
    const box = document.getElementById('errorBox');
    if (box) {
      box.textContent = '오류: ' + ((e.reason && e.reason.message) || String(e.reason || '알 수 없는 오류'));
      box.style.display = 'block';
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
    window.addEventListener('load', boot);
  } else {
    boot();
  }
})();
