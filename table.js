/**
 * ui/controls.js — 설정 읽기·생성·내보내기·샘플·탭
 *
 * readSettings, fillTimeSelect, fillStartSelect,
 * doGenerate, doExportCsv, loadSample, initTabs
 *
 * 의존성: constants.js, scheduler/index.js, ui/*
 */

import { DEFAULTS, DEFAULT_START_OPTIONS, STATION_SHORT, GROUP_LABEL } from '../constants.js';
import { minToTime } from '../utils.js';
import { generateSchedule } from '../scheduler/index.js';
import { clearEmpRows, setLastResult, getLastResult, saveState, loadState } from './state.js';
import { addEmployee, batchAddEmployees, readEmployees, renderEmployeeList, syncEmpQuickAddUI } from './employees.js';
import { renderTable, renderViolations, renderStats, setStatus, renderLegend } from './table.js';

const $ = id => document.getElementById(id);

// ── 설정 읽기 ─────────────────────────────────────────────────────

export function readSettings() {
  return {
    dayStart      : $('dayStart')?.value           || DEFAULTS.DAY_START,
    dayEnd        : $('dayEnd')?.value             || DEFAULTS.DAY_END,
    coreMin       : Number($('coreMin')?.value)    || DEFAULTS.CORE_MIN_MIN,
    coreMax       : Number($('coreMax')?.value)    || DEFAULTS.CORE_MAX_MIN,
    anyMin        : DEFAULTS.ANY_MIN_MIN,
    mealDur       : Number($('mealDur')?.value)    || DEFAULTS.MEAL_DUR_MIN,
    meetingDur    : Number($('meetingDur')?.value) || DEFAULTS.MTG_DUR_MIN,
    mtg1          : $('mtg1')?.value               || DEFAULTS.MTG1_TIME,
    mtg2          : $('mtg2')?.value               || DEFAULTS.MTG2_TIME,
    openMeal1130  : Number($('openMeal1130')?.value) || 0,
    openMeal1230  : Number($('openMeal1230')?.value) || 0,
    closeMealMode : $('closeMealMode')?.value      || 'auto',
    seed          : Number($('seed')?.value)       || DEFAULTS.SEED,
  };
}

// ── 선택 옵션 채우기 ──────────────────────────────────────────────

export function fillTimeSelect(el, step = 30, min = 0, max = 24 * 60) {
  if (!el) return;
  el.innerHTML = '';
  for (let t = min; t < max; t += step) {
    const o = document.createElement('option');
    o.value       = minToTime(t);
    o.textContent = minToTime(t);
    el.appendChild(o);
  }
}

export function fillStartSelect(el, options = DEFAULT_START_OPTIONS) {
  if (!el) return;
  const cur = el.value;
  el.innerHTML = '';
  for (const t of options) {
    const o = document.createElement('option');
    o.value       = t;
    o.textContent = t;
    el.appendChild(o);
  }
  if (options.includes(cur)) el.value = cur;
}

// ── 스케줄 생성 ───────────────────────────────────────────────────

export function doGenerate() {
  const emps = readEmployees();
  if (!emps.length) { setStatus('직원을 먼저 추가하세요.', 'warn'); return; }

  // Bug Fix 6: 오픈조 식사 인원 합산이 오픈조 직원 수 초과 시 경고
  const openCount = emps.filter(e => e.group === 'OPEN').length;
  // Bug Fix 10: readSettings()를 두 번 호출하는 중복 제거 — 한 번 읽어서 검증·생성 모두 사용
  const settings = readSettings();
  const mealTotal = (settings.openMeal1130 || 0) + (settings.openMeal1230 || 0);
  if (openCount > 0 && mealTotal > openCount) {
    setStatus(`오픈조 식사 인원(${mealTotal}명)이 오픈조 직원 수(${openCount}명)를 초과합니다.`, 'warn');
    return;
  }

  setStatus('생성 중...', '');
  const overlay = $('loadingOverlay');
  if (overlay) overlay.classList.add('show');

  setTimeout(() => {
    try {
      const result   = generateSchedule({ ...settings, employees: emps });
      setLastResult(result);
      renderTable(result);
      renderViolations(result.violations);
      renderStats(result.stats);
      if ($('btnExportCsv')) $('btnExportCsv').disabled = false;
      if ($('btnPrint'))    $('btnPrint').disabled    = false;
      if ($('btnSave'))     $('btnSave').disabled     = false;
      // 스크롤·크기 컨트롤 표시
      const sc = $('scrollCtrl');
      const sz = $('sizeControl');
      if (sc) sc.style.display = 'flex';
      if (sz) sz.style.display = 'flex';
      // 현재 크기 설정 적용
      const tw = $('tableWrap');
      const activeSize = document.querySelector('.size-btn.active')?.dataset.size ?? 'md';
      if (tw) tw.dataset.size = activeSize;
      // 스크롤 thumb 초기화
      setTimeout(() => {
        const thumb = $('scrollThumb');
        if (thumb && tw) {
          const ratio  = tw.scrollWidth > tw.clientWidth ? tw.clientWidth / tw.scrollWidth : 1;
          thumb.style.width = Math.max(ratio * 100, 12) + '%';
          thumb.style.left  = '0%';
        }
      }, 50);
      const vCount  = result.violations.length;
      const defCount = result.stats.totalDeficits;
      setStatus(
        `생성 완료 · 위반 ${vCount}건 · 커버리지 부족 ${defCount}슬롯`,
        vCount === 0 && defCount === 0 ? 'ok' : 'warn',
      );
    } catch (err) {
      console.error(err);
      setStatus('오류: ' + err.message, 'err');
    } finally {
      if (overlay) overlay.classList.remove('show');
    }
  }, 20);
}

// ── CSV 내보내기 ──────────────────────────────────────────────────

export function doExportCsv() {
  const result = getLastResult();
  if (!result) { setStatus('먼저 스케줄을 생성하세요.', 'warn'); return; }
  const { schedule, slots, employees } = result;
  const sh     = st => STATION_SHORT[st] || st || '';
  const header = ['이름', '조', ...slots].join(',');
  const rows   = employees.map(e =>
    [`"${e.name || e.id}"`, `"${GROUP_LABEL[e.group] || e.group}"`,
     ...schedule[e.id].map(st => `"${sh(st)}"`)].join(',')
  );
  const csv  = '\uFEFF' + [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'schedule.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus('CSV 내보내기 완료', 'ok');
}

// ── 샘플 데이터 ───────────────────────────────────────────────────

export function loadSample() {
  clearEmpRows();
  const sample = [
    // ── 오픈조 (8h) ──────────────────────────────────────
    { name: '한주희',  group: 'OPEN',  start: '08:30', hours: 8 },
    { name: '정재원',  group: 'OPEN',  start: '08:30', hours: 8 },
    // ── 중간조 ───────────────────────────────────────────
    { name: '김보람',  group: 'MID',   start: '10:00', hours: 8 },
    { name: '공경훈',  group: 'MID',   start: '10:30', hours: 8 },
    { name: '오기연',  group: 'MID',   start: '11:00', hours: 8 },
    { name: '이승균',  group: 'MID',   start: '11:45', hours: 6 },
    { name: '조희복',  group: 'MID',   start: '12:30', hours: 8 },  // Bug Fix 5: 누락됐던 mid8_3 추가
    // ── 마감조 ───────────────────────────────────────────
    { name: '안성철',  group: 'CLOSE', start: '13:30', hours: 8 },
    { name: '오봉혁',  group: 'CLOSE', start: '13:30', hours: 8 },
    { name: '김한신',  group: 'CLOSE', start: '13:30', hours: 8 },  // Bug Fix 5: 오상곤(15:30,6h) → 김한신(13:30,8h)
    { name: '김민준',  group: 'CLOSE', start: '13:30', hours: 8 },
  ];
  batchAddEmployees(sample);  // Bug Fix 8: 루프 addEmployee → batchAdd (renderEmployeeList 1회)
  if ($('openMeal1130')) $('openMeal1130').value = '1';
  if ($('openMeal1230')) $('openMeal1230').value = '1';
  saveState(readEmployees(), readSettings());
  setStatus('샘플 데이터 로드 중...', '');
  // 직원 목록 렌더 완료 후 스케줄 자동 생성
  setTimeout(doGenerate, 50);
}

// ── 탭 전환 ───────────────────────────────────────────────────────

export function initTabs() {
  const tabs = document.querySelectorAll('.stab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.querySelectorAll('.stab-panel').forEach(p => p.classList.remove('active'));
      const panelId = 'tab' + target.charAt(0).toUpperCase() + target.slice(1);
      $(panelId)?.classList.add('active');
    });
  });
}

// ── 저장 상태 복원 ────────────────────────────────────────────────

export function restoreState() {
  const saved = loadState();
  if (!saved?.employees?.length) return;
  batchAddEmployees(saved.employees);  // Bug Fix 8: 루프 addEmployee → batchAdd
  if (saved.settings) {
    const s = saved.settings;
    if ($('dayStart')      && s.dayStart)          $('dayStart').value      = s.dayStart;
    if ($('dayEnd')        && s.dayEnd)            $('dayEnd').value        = s.dayEnd;
    if ($('coreMin')       && s.coreMin)           $('coreMin').value       = s.coreMin;
    if ($('coreMax')       && s.coreMax)           $('coreMax').value       = s.coreMax;
    // Bug Fix 1: mealDur / meetingDur / mtg1 / mtg2 복원 누락 → 추가
    if ($('mealDur')       && s.mealDur)           $('mealDur').value       = s.mealDur;
    if ($('meetingDur')    && s.meetingDur)        $('meetingDur').value    = s.meetingDur;
    if ($('mtg1')          && s.mtg1)              $('mtg1').value          = s.mtg1;
    if ($('mtg2')          && s.mtg2)              $('mtg2').value          = s.mtg2;
    if ($('openMeal1130')  && s.openMeal1130 != null) $('openMeal1130').value = s.openMeal1130;
    if ($('openMeal1230')  && s.openMeal1230 != null) $('openMeal1230').value = s.openMeal1230;
    if ($('closeMealMode') && s.closeMealMode)     $('closeMealMode').value = s.closeMealMode;
    // Bug Fix 2: seed=0은 falsy → != null 체크로 변경
    if ($('seed')          && s.seed != null)      $('seed').value          = s.seed;
  }
  setStatus(`저장된 직원 ${saved.employees.length}명 복원됨`, 'ok');
}
