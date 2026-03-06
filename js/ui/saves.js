/**
 * ui/saves.js — 파일시스템 기반 저장·불러오기
 *
 * File System Access API를 사용해 선택한 폴더 안의
 * save/ 하위 폴더에 JSON 파일 단위로 저장합니다.
 *
 * 흐름:
 *   1. 최초 저장·불러오기 시 showDirectoryPicker()로 루트 폴더 선택
 *   2. 루트 폴더 안에 save/ 하위 폴더를 자동 생성
 *   3. 각 저장 슬롯 = save/{id}_{name}.json 파일 1개
 *   4. 목록 = save/ 폴더 내 .json 파일을 모두 읽어 렌더링
 *
 * API 미지원(Firefox 등): localStorage 자동 폴백
 */

import { readEmployees, addEmployee, batchAddEmployees, renderEmployeeList, syncEmpQuickAddUI } from './employees.js';
import { clearEmpRows, saveState }                        from './state.js';
import { readSettings }                                   from './controls.js';
import { setStatus }                                      from './table.js';

const LS_KEY = 'blockpyo_named_saves';
const $ = id => document.getElementById(id);

// ── 디렉토리 핸들 캐시 ──────────────────────────────────────────
let _saveDir = null;   // FileSystemDirectoryHandle (save/ 폴더)

const fsSupported = () => typeof window.showDirectoryPicker === 'function';

// ── 루트 폴더 선택 → save/ 하위 자동 생성 ───────────────────────
async function pickDir() {
  try {
    const root = await window.showDirectoryPicker({
      mode: 'readwrite',
      id:   'blockpyo-root',
      startIn: 'documents',
    });
    _saveDir = await root.getDirectoryHandle('save', { create: true });
    return _saveDir;
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
    return null;
  }
}

async function ensureDir() {
  if (_saveDir) {
    try {
      const perm = await _saveDir.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return _saveDir;
      const req = await _saveDir.requestPermission({ mode: 'readwrite' });
      if (req === 'granted') return _saveDir;
    } catch {}
    _saveDir = null;
  }
  return await pickDir();
}

// ── 파일명 정규화 ────────────────────────────────────────────────
function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

// ── FS: 쓰기 ─────────────────────────────────────────────────────
async function fsWrite(slot) {
  const dir = await ensureDir();
  if (!dir) return false;
  try {
    const fname = `${slot.id}_${safeFilename(slot.name)}.json`;
    const fh = await dir.getFileHandle(fname, { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(slot, null, 2));
    await w.close();
    slot._filename = fname;
    return true;
  } catch (e) { console.error(e); return false; }
}

// ── FS: 목록 읽기 ────────────────────────────────────────────────
async function fsReadAll() {
  const dir = await ensureDir();
  if (!dir) return null;
  const out = [];
  for await (const [name, handle] of dir) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const file = await handle.getFile();
      const data = JSON.parse(await file.text());
      data._filename = name;
      out.push(data);
    } catch {}
  }
  return out.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

// ── FS: 삭제 ─────────────────────────────────────────────────────
async function fsRemove(filename) {
  const dir = await ensureDir();
  if (!dir) return;
  try { await dir.removeEntry(filename); } catch (e) { console.error(e); }
}

// ── LS 폴백 ──────────────────────────────────────────────────────
function lsAll()       { try { return JSON.parse(localStorage.getItem(LS_KEY)||'[]'); } catch { return []; } }
function lsSet(arr)    { try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch {} }

// ════════════════════════════════════════════════════════════════
//  PUBLIC
// ════════════════════════════════════════════════════════════════

export async function doSave() {
  const emps = readEmployees();
  if (!emps.length) { setStatus('저장할 직원 데이터가 없습니다.', 'warn'); return; }

  const name = prompt('저장 이름을 입력하세요:', `스케줄 ${new Date().toLocaleDateString('ko-KR')}`);
  if (name === null) return;
  if (!name.trim()) { alert('이름을 입력해 주세요.'); return; }

  const slot = {
    id      : Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name    : name.trim(),
    savedAt : new Date().toISOString(),
    employees: emps,
    settings : readSettings(),
    empCount : emps.length,
    version  : 1,
  };

  if (fsSupported()) {
    setStatus('저장 폴더를 선택하세요…', '');
    const ok = await fsWrite(slot);
    if (ok) {
      setStatus(`💾 "${slot.name}" → save/${slot._filename}`, 'ok');
      await updateSaveBadge();
    } else {
      setStatus('저장 취소됨', '');
    }
  } else {
    const arr = lsAll(); arr.unshift(slot); lsSet(arr);
    setStatus(`💾 "${slot.name}" 저장 완료 (${emps.length}명)`, 'ok');
    await updateSaveBadge();
  }
}

export async function openLoadModal() {
  $('saveModal')?.classList.add('open');
  await renderSaveList();
}
export function closeLoadModal() {
  $('saveModal')?.classList.remove('open');
}

// ── 목록 렌더링 ──────────────────────────────────────────────────
async function renderSaveList() {
  const list = $('saveList');
  if (!list) return;

  list.innerHTML = `<div class="save-loading"><span class="save-spinner"></span>파일 읽는 중…</div>`;

  let saves;

  if (fsSupported()) {
    saves = await fsReadAll();
    if (saves === null) {
      list.innerHTML = `
        <div class="save-empty">
          <span class="save-empty-icon">📁</span>
          <p>blockpyo3 폴더(또는 원하는 위치)를 선택하면<br>그 안에 <code>save/</code> 폴더가 자동으로 만들어집니다.</p>
          <button class="save-pick-btn" id="btnPickDir">📂 폴더 선택하기</button>
        </div>`;
      $('btnPickDir')?.addEventListener('click', async () => {
        _saveDir = null;
        await renderSaveList();
      });
      return;
    }
  } else {
    saves = lsAll();
  }

  if (!saves.length) {
    const hint = fsSupported()
      ? `<span class="save-path-hint">save/ 폴더가 비어 있습니다</span>`
      : `<span class="save-path-hint">브라우저 저장소에 저장 없음</span>`;
    list.innerHTML = `
      <div class="save-empty">
        <span class="save-empty-icon">📭</span>
        <span>저장된 스케줄이 없습니다</span>
        ${hint}
      </div>`;
    return;
  }

  // 상단 배너
  const banner = fsSupported()
    ? `<div class="save-dir-banner">
        <span class="save-dir-icon">📁</span>
        <span class="save-dir-label">save/ 폴더 · <strong>${saves.length}</strong>개 파일</span>
        <button class="save-change-dir-btn" id="btnChangeDir">폴더 변경</button>
       </div>`
    : `<div class="save-dir-banner ls-mode">
        <span class="save-dir-icon">🗄️</span>
        <span class="save-dir-label">브라우저 저장소 · ${saves.length}개 (파일시스템 미지원)</span>
       </div>`;

  list.innerHTML = banner + saves.map(s => {
    const d = new Date(s.savedAt);
    const ds = `${d.getFullYear()}.${p2(d.getMonth()+1)}.${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const g = countGroups(s.employees || []);
    const ftag = s._filename
      ? `<span class="save-file-tag" title="${escHtml(s._filename)}">${escHtml(s._filename)}</span>`
      : '';
    return `
      <div class="save-item">
        <div class="save-item-info">
          <div class="save-item-name">${escHtml(s.name)}</div>
          <div class="save-item-meta">
            <span class="save-date">${ds}</span>
            <span class="save-pill pill-open">오픈 ${g.OPEN}</span>
            <span class="save-pill pill-mid">중간 ${g.MID}</span>
            <span class="save-pill pill-close">마감 ${g.CLOSE}</span>
          </div>
          ${ftag ? `<div class="save-file-row">${ftag}</div>` : ''}
        </div>
        <div class="save-item-actions">
          <button class="save-load-btn"
            data-id="${escHtml(s.id)}"
            data-file="${escHtml(s._filename||'')}">불러오기</button>
          <button class="save-del-btn"
            data-id="${escHtml(s.id)}"
            data-file="${escHtml(s._filename||'')}"
            title="삭제">✕</button>
        </div>
      </div>`;
  }).join('');

  $('btnChangeDir')?.addEventListener('click', async () => { _saveDir = null; await renderSaveList(); });

  // 버튼 이벤트 — saves 클로저
  list.querySelectorAll('.save-load-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      const b = e.currentTarget;
      doLoad(b.dataset.id, b.dataset.file, saves);
    }));
  list.querySelectorAll('.save-del-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      const b = e.currentTarget;
      doDelete(b.dataset.id, b.dataset.file, saves);
    }));
}

// ── 불러오기 ─────────────────────────────────────────────────────
function doLoad(id, filename, saves) {
  const slot = saves.find(s => s.id === id);
  if (!slot) return;
  if (!confirm(`"${slot.name}"을(를) 불러오시겠습니까?\n현재 직원 목록이 교체됩니다.`)) return;

  clearEmpRows();
  batchAddEmployees(slot.employees);  // Bug Fix 8: clearEmpRows 후 1회 render로 통합 (Bug Fix 4 포함)
  const s = slot.settings || {};
  const set = (elId, val) => { if ($(elId) && val != null) $(elId).value = val; };
  set('dayStart', s.dayStart); set('dayEnd', s.dayEnd);
  set('coreMin',  s.coreMin);  set('coreMax', s.coreMax);
  set('mealDur',  s.mealDur);  set('meetingDur', s.meetingDur);
  set('mtg1', s.mtg1);         set('mtg2', s.mtg2);
  set('openMeal1130', s.openMeal1130); set('openMeal1230', s.openMeal1230);
  set('closeMealMode', s.closeMealMode); set('seed', s.seed);

  syncEmpQuickAddUI();
  saveState(slot.employees, s);
  closeLoadModal();
  setStatus(`"${slot.name}" 불러오기 완료 · 스케줄 생성 버튼을 눌러주세요`, 'ok');
}

// ── 삭제 ─────────────────────────────────────────────────────────
async function doDelete(id, filename, saves) {
  const slot = saves.find(s => s.id === id);
  if (!slot) return;
  if (!confirm(`"${slot.name}"을(를) 삭제하시겠습니까?\n파일도 함께 삭제됩니다.`)) return;

  if (fsSupported() && filename) {
    await fsRemove(filename);
  } else {
    lsSet(lsAll().filter(s => s.id !== id));
  }
  await updateSaveBadge();
  await renderSaveList();
}

// ── 헬퍼 ─────────────────────────────────────────────────────────
const p2  = n => String(n).padStart(2,'0');
function countGroups(emps) {
  return emps.reduce((a,e) => { a[e.group]=(a[e.group]||0)+1; return a; }, {OPEN:0,MID:0,CLOSE:0});
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 배지 ─────────────────────────────────────────────────────────
export async function updateSaveBadge() {
  const badge = $('saveBadge');
  if (!badge) return;
  let count = 0;
  if (fsSupported() && _saveDir) {
    try { for await (const [n] of _saveDir) { if (n.endsWith('.json')) count++; } }
    catch { count = lsAll().length; }
  } else {
    count = lsAll().length;
  }
  badge.textContent   = count || '';
  badge.style.display = count ? 'inline-flex' : 'none';
}
