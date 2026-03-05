/**
 * app.js — BLOCKPYO 앱 진입점
 *
 * DOMContentLoaded 이후 실행:
 *   1. 시간 선택 옵션 구성
 *   2. 이벤트 바인딩 (버튼·입력·탭)
 *   3. 범례 초기 렌더링
 *   4. LocalStorage 상태 복원
 *
 * 모든 import는 이 파일에서 출발합니다.
 * (index.html은 이 파일 하나만 <script type="module">로 로드)
 */

import { DEFAULTS, DEFAULT_START_OPTIONS } from './constants.js';
import { fillTimeSelect, fillStartSelect, doGenerate, doExportCsv, loadSample, initTabs, restoreState, readSettings } from './ui/controls.js';
import { doQuickAdd, syncEmpQuickAddUI } from './ui/employees.js';
import { renderLegend, setStatus } from './ui/table.js';
import { saveState } from './ui/state.js';
import { readEmployees } from './ui/employees.js';

const $ = id => document.getElementById(id);

function init() {
  // ── 시간 선택 옵션 구성 ──────────────────────────────────────
  fillTimeSelect($('dayStart'), 30, 6 * 60, 14 * 60);
  fillTimeSelect($('dayEnd'),   30, 14 * 60, 25 * 60);
  if ($('dayStart')) $('dayStart').value = DEFAULTS.DAY_START;
  if ($('dayEnd'))   $('dayEnd').value   = DEFAULTS.DAY_END;

  // qaStart 출근시간 목록 채우기 (syncEmpQuickAddUI보다 먼저)
  fillStartSelect($('qaStart'), DEFAULT_START_OPTIONS);

  // ── 이벤트 바인딩 ────────────────────────────────────────────
  $('btnGenerate')?.addEventListener('click', doGenerate);
  $('btnSample')?.addEventListener('click', loadSample);
  $('btnExportCsv')?.addEventListener('click', doExportCsv);
  $('qaGroup')?.addEventListener('change', syncEmpQuickAddUI);
  $('btnQaAdd')?.addEventListener('click', () => doQuickAdd(setStatus));
  $('qaName')?.addEventListener('keydown', e => { if (e.key === 'Enter') doQuickAdd(setStatus); });

  // 설정 변경 시 자동 저장
  ['dayStart','dayEnd','coreMin','coreMax','mealDur','meetingDur',
   'mtg1','mtg2','openMeal1130','openMeal1230','closeMealMode','seed',
  ].forEach(id => $(id)?.addEventListener('change', () => saveState(readEmployees(), readSettings())));

  // ── 범례·탭 초기화 ───────────────────────────────────────────
  initTabs();
  renderLegend();

  // ── 저장 상태 복원 ───────────────────────────────────────────
  restoreState();

  // qaStart 옵션 재확인 후 UI 동기화 (복원 이후 그룹이 변경됐을 수 있음)
  fillStartSelect($('qaStart'), DEFAULT_START_OPTIONS);
  syncEmpQuickAddUI();
}

document.addEventListener('DOMContentLoaded', init);
