/**
 * ui/saves.js — 이름 붙여 저장·불러오기
 *
 * 직원 목록 + 설정을 localStorage에 슬롯 단위로 저장합니다.
 * 스케줄 결과는 저장하지 않고, 불러온 뒤 자동 재생성합니다.
 */

import { readEmployees, renderEmployeeList, addEmployee, syncEmpQuickAddUI } from './employees.js';
import { clearEmpRows, saveState, getLastResult }                             from './state.js';
import { readSettings }                                                        from './controls.js';
import { setStatus }                                                           from './table.js';

const SAVES_KEY = 'blockpyo_named_saves';
const MAX_SAVES = 20;

const $ = id => document.getElementById(id);

// ── 저장 데이터 구조 ─────────────────────────────────────────────
// [ { id, name, savedAt, employees, settings }, ... ]

function loadAllSaves() {
  try { return JSON.parse(localStorage.getItem(SAVES_KEY) || '[]'); }
  catch { return []; }
}
function storeAllSaves(arr) {
  try { localStorage.setItem(SAVES_KEY, JSON.stringify(arr)); } catch {}
}

// ── 저장 ─────────────────────────────────────────────────────────
export function doSave() {
  const emps = readEmployees();
  if (!emps.length) { setStatus('저장할 직원 데이터가 없습니다.', 'warn'); return; }

  const name = prompt('저장 이름을 입력하세요:', `스케줄 ${new Date().toLocaleDateString('ko-KR')}`);
  if (name === null) return;          // 취소
  if (!name.trim()) { alert('이름을 입력해 주세요.'); return; }

  const saves = loadAllSaves();
  if (saves.length >= MAX_SAVES) {
    alert(`최대 ${MAX_SAVES}개까지 저장할 수 있습니다. 기존 항목을 삭제 후 저장하세요.`);
    return;
  }

  const slot = {
    id       : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name     : name.trim(),
    savedAt  : new Date().toISOString(),
    employees: emps,
    settings : readSettings(),
    empCount : emps.length,
  };
  saves.unshift(slot);          // 최신 순 정렬
  storeAllSaves(saves);
  setStatus(`"${slot.name}" 저장 완료 (${emps.length}명)`, 'ok');
}

// ── 모달 열기 ────────────────────────────────────────────────────
export function openLoadModal() {
  renderSaveList();
  $('saveModal')?.classList.add('open');
}
export function closeLoadModal() {
  $('saveModal')?.classList.remove('open');
}

// ── 목록 렌더링 ──────────────────────────────────────────────────
function renderSaveList() {
  const list = $('saveList');
  if (!list) return;
  const saves = loadAllSaves();

  if (!saves.length) {
    list.innerHTML = `
      <div class="save-empty">
        <span class="save-empty-icon">📭</span>
        <span>저장된 스케줄이 없습니다</span>
      </div>`;
    return;
  }

  list.innerHTML = saves.map(s => {
    const date = new Date(s.savedAt);
    const dateStr = `${date.getFullYear()}.${String(date.getMonth()+1).padStart(2,'0')}.${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
    const groups = countGroups(s.employees);
    return `
      <div class="save-item" data-id="${s.id}">
        <div class="save-item-info">
          <div class="save-item-name">${escHtml(s.name)}</div>
          <div class="save-item-meta">
            <span class="save-date">${dateStr}</span>
            <span class="save-pill pill-open">오픈 ${groups.OPEN}명</span>
            <span class="save-pill pill-mid">중간 ${groups.MID}명</span>
            <span class="save-pill pill-close">마감 ${groups.CLOSE}명</span>
          </div>
        </div>
        <div class="save-item-actions">
          <button class="save-load-btn" data-id="${s.id}">불러오기</button>
          <button class="save-del-btn"  data-id="${s.id}" title="삭제">✕</button>
        </div>
      </div>`;
  }).join('');

  // 이벤트 바인딩
  list.querySelectorAll('.save-load-btn').forEach(btn =>
    btn.addEventListener('click', e => loadSave(e.currentTarget.dataset.id)));
  list.querySelectorAll('.save-del-btn').forEach(btn =>
    btn.addEventListener('click', e => deleteSave(e.currentTarget.dataset.id)));
}

function countGroups(emps) {
  return emps.reduce((acc, e) => {
    acc[e.group] = (acc[e.group] || 0) + 1;
    return acc;
  }, { OPEN: 0, MID: 0, CLOSE: 0 });
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 불러오기 ────────────────────────────────────────────────────
function loadSave(id) {
  const saves = loadAllSaves();
  const slot  = saves.find(s => s.id === id);
  if (!slot) return;

  if (!confirm(`"${slot.name}"을(를) 불러오시겠습니까?\n현재 직원 목록이 교체됩니다.`)) return;

  // 직원 교체
  clearEmpRows();
  for (const e of slot.employees) addEmployee(e);

  // 설정 복원
  const s = slot.settings || {};
  if ($('dayStart')      && s.dayStart)         $('dayStart').value      = s.dayStart;
  if ($('dayEnd')        && s.dayEnd)           $('dayEnd').value        = s.dayEnd;
  if ($('coreMin')       && s.coreMin)          $('coreMin').value       = s.coreMin;
  if ($('coreMax')       && s.coreMax)          $('coreMax').value       = s.coreMax;
  if ($('mealDur')       && s.mealDur)          $('mealDur').value       = s.mealDur;
  if ($('meetingDur')    && s.meetingDur)       $('meetingDur').value    = s.meetingDur;
  if ($('mtg1')          && s.mtg1)             $('mtg1').value          = s.mtg1;
  if ($('mtg2')          && s.mtg2)             $('mtg2').value          = s.mtg2;
  if ($('openMeal1130')  && s.openMeal1130 != null) $('openMeal1130').value = s.openMeal1130;
  if ($('openMeal1230')  && s.openMeal1230 != null) $('openMeal1230').value = s.openMeal1230;
  if ($('closeMealMode') && s.closeMealMode)    $('closeMealMode').value = s.closeMealMode;
  if ($('seed')          && s.seed)             $('seed').value          = s.seed;

  syncEmpQuickAddUI();
  saveState(slot.employees, s);   // 자동저장 슬롯도 갱신
  closeLoadModal();
  setStatus(`"${slot.name}" 불러오기 완료 · 스케줄 생성 버튼을 눌러주세요`, 'ok');
}

// ── 삭제 ────────────────────────────────────────────────────────
function deleteSave(id) {
  const saves = loadAllSaves();
  const slot  = saves.find(s => s.id === id);
  if (!slot) return;
  if (!confirm(`"${slot.name}"을(를) 삭제하시겠습니까?`)) return;
  storeAllSaves(saves.filter(s => s.id !== id));
  renderSaveList();
}

// ── 저장 개수 배지 ───────────────────────────────────────────────
export function updateSaveBadge() {
  const badge = $('saveBadge');
  if (!badge) return;
  const count = loadAllSaves().length;
  badge.textContent = count || '';
  badge.style.display = count ? 'inline-flex' : 'none';
}
