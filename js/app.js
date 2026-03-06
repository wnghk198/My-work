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
import { doSave, openLoadModal, closeLoadModal, updateSaveBadge } from './ui/saves.js';

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
  // Bug Fix 3: doSave()는 async → await 필요. updateSaveBadge는 doSave 내부에서 이미 호출
  $('btnSave')?.addEventListener('click', async () => { await doSave(); });
  $('btnLoad')?.addEventListener('click', openLoadModal);
  $('btnModalClose')?.addEventListener('click', closeLoadModal);
  $('btnModalCancel')?.addEventListener('click', closeLoadModal);
  $('saveModal')?.addEventListener('click', e => { if (e.target === $('saveModal')) closeLoadModal(); });
  $('qaGroup')?.addEventListener('change', syncEmpQuickAddUI);
  $('btnQaAdd')?.addEventListener('click', () => doQuickAdd(setStatus));
  $('qaName')?.addEventListener('keydown', e => { if (e.key === 'Enter') doQuickAdd(setStatus); });

  // ── 스크롤 버튼 ──────────────────────────────────────────────
  const tableWrap = $('tableWrap');
  const SCROLL_STEP = 200;

  function updateScrollThumb() {
    const thumb = $('scrollThumb');
    const track = $('scrollCtrl')?.querySelector('.scroll-track');
    if (!thumb || !track || !tableWrap) return;
    const ratio = tableWrap.scrollWidth > tableWrap.clientWidth
      ? tableWrap.clientWidth / tableWrap.scrollWidth
      : 1;
    const thumbW = Math.max(ratio * 100, 12);
    const thumbLeft = tableWrap.scrollWidth > tableWrap.clientWidth
      ? (tableWrap.scrollLeft / (tableWrap.scrollWidth - tableWrap.clientWidth)) * (100 - thumbW)
      : 0;
    thumb.style.width = thumbW + '%';
    thumb.style.left  = thumbLeft + '%';
  }

  $('btnScrollLeft')?.addEventListener('click', () => {
    tableWrap?.scrollBy({ left: -SCROLL_STEP, behavior: 'smooth' });
  });
  $('btnScrollRight')?.addEventListener('click', () => {
    tableWrap?.scrollBy({ left: SCROLL_STEP, behavior: 'smooth' });
  });
  tableWrap?.addEventListener('scroll', updateScrollThumb);

  // 스크롤 트랙 클릭으로 직접 이동
  $('scrollCtrl')?.querySelector('.scroll-track')?.addEventListener('click', e => {
    if (!tableWrap) return;
    const track = e.currentTarget;
    const rect  = track.getBoundingClientRect();
    const frac  = (e.clientX - rect.left) / rect.width;
    const maxScroll = tableWrap.scrollWidth - tableWrap.clientWidth;
    tableWrap.scrollLeft = frac * maxScroll;
  });

  // ── 셀 크기 조절 ─────────────────────────────────────────────
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (tableWrap) {
        tableWrap.dataset.size = btn.dataset.size;
        updateScrollThumb();
      }
    });
  });

  // ── 인쇄 버튼 ────────────────────────────────────────────────
  $('btnPrint')?.addEventListener('click', () => {
    window.print();
  });

  // beforeprint: size-variant 클래스가 있어도 인쇄 시 올바른 크기로
  window.addEventListener('beforeprint', () => {
    const tw = $('tableWrap');
    if (tw) tw.dataset.printReady = 'true';
  });
  window.addEventListener('afterprint', () => {
    const tw = $('tableWrap');
    if (tw) delete tw.dataset.printReady;
  });

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

  // 저장 배지 초기화
  updateSaveBadge();
}

document.addEventListener('DOMContentLoaded', init);
