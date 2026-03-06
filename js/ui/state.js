/**
 * ui/state.js — 공유 앱 상태 & LocalStorage 영속화
 *
 * 직원 목록·범례 필터·마지막 결과를 하나의 모듈에서 관리.
 * 다른 UI 모듈은 이 모듈을 import해 상태를 읽고 씁니다.
 *
 * 의존성: 없음
 */

const STORAGE_KEY = 'blockpyo_v400';

// ── 앱 상태 ─────────────────────────────────────────────────────

let _empIdCounter  = 1;
let _empRows       = [];
let _legendFilter  = new Set();
let _lastResult    = null;

// ── 접근자 ──────────────────────────────────────────────────────

export const getEmployees   = ()  => _empRows;
export const getLegendFilter = () => _legendFilter;
export const getLastResult   = () => _lastResult;

export function setLastResult(r) { _lastResult = r; }

export function genId() {
  // Bug Fix 7: clearEmpRows 후 _empIdCounter=1로 리셋되므로,
  // 기존 로드된 직원의 id(E1, E2...)와 충돌 가능 → 기존 id와 겹치지 않을 때까지 증가
  let id;
  do { id = `E${_empIdCounter++}`; } while (_empRows.some(e => e.id === id));
  return id;
}

export function addEmpRow(emp)     { _empRows.push(emp); }
export function removeEmpRow(id)   { _empRows = _empRows.filter(e => e.id !== id); }
export function clearEmpRows()     { _empRows = []; _empIdCounter = 1; }

export function toggleLegend(css) {
  if (_legendFilter.has(css)) _legendFilter.delete(css);
  else                        _legendFilter.add(css);
}

// ── LocalStorage ────────────────────────────────────────────────

export function saveState(employees, settings) {
  try {
    // settings가 null이면 기존 저장값 유지
    if (settings === null) {
      const prev = loadState();
      settings = prev?.settings ?? {};
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ employees, settings }));
  } catch (_) {}
}

export function loadState() {
  try {
    const d = localStorage.getItem(STORAGE_KEY);
    return d ? JSON.parse(d) : null;
  } catch (_) { return null; }
}
