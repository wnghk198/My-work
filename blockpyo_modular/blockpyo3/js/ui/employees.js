/**
 * ui/employees.js — 직원 CRUD & 목록 렌더링
 *
 * addEmployee, removeEmployee, renderEmployeeList,
 * readEmployees, doQuickAdd, syncEmpQuickAddUI
 *
 * 의존성: constants.js, ui/state.js
 */

import { DEFAULTS } from '../constants.js';
import { genId, addEmpRow, removeEmpRow, getEmployees, saveState } from './state.js';

// 설정 읽기는 controls.js에 있으나 순환 의존성 방지를 위해
// 저장 시 설정 부분은 null로 전달 (기존 설정값 유지)
const _saveEmp = () => saveState(readEmployees(), null);

const $ = id => document.getElementById(id);

// ── 직원 데이터 읽기 ──────────────────────────────────────────────

export function readEmployees() {
  return getEmployees().map(r => ({
    id:    r.id,
    name:  r.name,
    group: r.group,
    start: r.start,
    hours: r.hours,
    note:  r.note || '',
  }));
}

// ── 직원 추가/삭제 ────────────────────────────────────────────────

export function addEmployee(data = {}) {
  const id  = data.id || genId();
  const emp = {
    id,
    name  : data.name  || '',
    group : data.group || 'MID',
    start : data.start || DEFAULTS.OPEN_START,
    hours : Number(data.hours) || 8,
    note  : data.note  || '',
  };
  addEmpRow(emp);
  renderEmployeeList();
  return emp;
}

export function removeEmployee(id) {
  removeEmpRow(id);
  renderEmployeeList();
}

// ── 목록 렌더링 ───────────────────────────────────────────────────

export function renderEmployeeList() {
  const container = $('empList');
  if (!container) return;
  container.innerHTML = '';

  const groups = [['OPEN','오픈조'], ['MID','중간조'], ['CLOSE','마감조']];
  for (const [g, label] of groups) {
    const emps = getEmployees().filter(e => e.group === g);
    const hdr  = document.createElement('div');
    hdr.className   = 'emp-group-header';
    hdr.innerHTML   = `<span>${label}</span><span class="count">${emps.length}명</span>`;
    container.appendChild(hdr);

    for (const e of emps) {
      const card  = document.createElement('div');
      card.className  = 'emp-card';
      card.dataset.id = e.id;

      const badge = document.createElement('span');
      badge.className = `group-badge ${e.group}`;
      badge.textContent = g === 'OPEN' ? '오픈' : g === 'MID' ? '중간' : '마감';

      const name = document.createElement('span');
      name.className = 'emp-name';
      name.textContent = e.name || '(이름없음)';
      name.title = '더블클릭하여 이름 편집';
      name.addEventListener('dblclick', () => startEditName(card, e, name));

      const meta = document.createElement('span');
      meta.className   = 'emp-meta';
      meta.textContent = `${e.start} · ${e.hours}h`;

      const del = document.createElement('button');
      del.className   = 'emp-del';
      del.textContent = '✕';
      del.title       = '삭제';
      del.addEventListener('click', () => { removeEmployee(e.id); _saveEmp(); });

      card.append(badge, name, meta, del);
      container.appendChild(card);
    }
  }
}

function startEditName(card, emp, nameSpan) {
  const inp = document.createElement('input');
  inp.className = 'emp-name-input';
  inp.value     = emp.name;
  nameSpan.replaceWith(inp);
  inp.focus(); inp.select();

  const finish = () => {
    emp.name = inp.value.trim() || emp.name;
    const s  = document.createElement('span');
    s.className   = 'emp-name';
    s.textContent = emp.name;
    s.title       = '더블클릭하여 이름 편집';
    s.addEventListener('dblclick', () => startEditName(card, emp, s));
    inp.replaceWith(s);
    _saveEmp();
  };
  inp.addEventListener('blur', finish);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  inp.blur();
    if (e.key === 'Escape') { inp.value = emp.name; inp.blur(); }
  });
}

// ── 직원 빠른 추가 UI 동기화 ─────────────────────────────────────

export function syncEmpQuickAddUI() {
  const gEl = $('qaGroup');
  const sEl = $('qaStart');
  const hEl = $('qaHours');
  if (!gEl || !sEl || !hEl) return;
  const g = gEl.value;
  sEl.disabled = (g === 'OPEN' || g === 'CLOSE');
  if (g === 'OPEN')  sEl.value = DEFAULTS.OPEN_START;
  if (g === 'CLOSE') sEl.value = DEFAULTS.CLOSE_START;
  hEl.value = (g === 'MID') ? '6' : '8';
}

export function doQuickAdd(setStatus) {
  const nm    = ($('qaName')?.value || '').trim();
  const g     = $('qaGroup')?.value || 'MID';
  let   start = $('qaStart')?.value || DEFAULTS.OPEN_START;
  if (g === 'OPEN')  start = DEFAULTS.OPEN_START;
  if (g === 'CLOSE') start = DEFAULTS.CLOSE_START;
  const hours = Number($('qaHours')?.value) || (g === 'MID' ? 6 : 8);
  const cnt   = getEmployees().filter(e => e.group === g).length + 1;
  const name  = nm || (g === 'OPEN' ? `오픈${cnt}` : g === 'CLOSE' ? `마감${cnt}` : `중간${cnt}`);
  addEmployee({ name, group: g, start, hours });
  if ($('qaName')) $('qaName').value = '';
  $('qaName')?.focus();
  _saveEmp();
  setStatus(`"${name}" 추가됨`, 'ok');
}
