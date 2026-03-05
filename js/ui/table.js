/**
 * ui/table.js — 스케줄 테이블·범례·위반·통계 렌더링
 *
 * renderTable, renderLegend, renderViolations,
 * renderStats, setStatus, applyLegendFilter
 *
 * 의존성: constants.js, utils.js, ui/state.js
 */

import { ST, STATION_SHORT, STATION_CSS, GROUP_LABEL } from '../constants.js';
import { parseTimeToMin } from '../utils.js';
import { getLegendFilter, toggleLegend } from './state.js';

const $ = id => document.getElementById(id);

// ── 범례 ──────────────────────────────────────────────────────────

const LEGEND_STATIONS = [
  { st: ST.EXIT,      label: '2F출차',   css: 's-exit',      bg: '#2563EB' },
  { st: ST.ELEV,      label: '2F엘베',   css: 's-elev',      bg: '#7C3AED' },
  { st: ST.F3,        label: '3F',        css: 's-3f',        bg: '#059669' },
  { st: ST.CART2F,    label: '2F카트',   css: 's-cart2f',    bg: '#0891B2' },
  { st: ST.CART3F,    label: '3F카트',   css: 's-cart3f',    bg: '#0D9488' },
  { st: ST.MEAL,      label: '식사',      css: 's-meal',      bg: '#D97706' },
  { st: ST.MTG,       label: '회의',      css: 's-mtg',       bg: '#DC2626' },
  { st: ST.REST,      label: '휴식',      css: 's-rest',      bg: '#4B5563' },
  { st: ST.OPEN_PREP, label: '오픈준비', css: 's-open-prep', bg: '#374151' },
];

export function renderLegend() {
  const bar = $('legendBar');
  if (!bar) return;
  bar.innerHTML = '';

  for (const { st, label, css, bg } of LEGEND_STATIONS) {
    const li  = document.createElement('div');
    li.className          = 'legend-item';
    li.dataset.st         = st;
    li.dataset.css        = css;
    li.style.background   = bg + '22';
    li.style.borderColor  = bg + '55';
    li.style.color        = bg;

    const dot = document.createElement('span');
    dot.className  = 'legend-dot';
    dot.style.background = bg;

    const lbl = document.createElement('span');
    lbl.textContent = label;

    li.append(dot, lbl);
    li.addEventListener('click', () => { toggleLegend(css); applyLegendFilter(); updateLegendUI(); });
    bar.appendChild(li);
  }
}

function updateLegendUI() {
  const filter = getLegendFilter();
  const active = filter.size > 0;
  const bar    = $('legendBar');
  if (!bar) return;
  for (const li of bar.querySelectorAll('.legend-item')) {
    li.classList.toggle('dimmed', active && !filter.has(li.dataset.css));
  }
}

export function applyLegendFilter() {
  const table  = $('scheduleTable');
  if (!table) return;
  const filter = getLegendFilter();
  const active = filter.size > 0;
  for (const c of table.querySelectorAll('.cell')) {
    c.classList.toggle('dim', active && !filter.has(c.dataset.css));
  }
  updateLegendUI();
}

// ── 스케줄 테이블 ─────────────────────────────────────────────────

export function renderTable(result) {
  const wrap = $('tableWrap');
  const ph   = $('tablePlaceholder');
  if (!result) {
    if (wrap) wrap.style.display = 'none';
    if (ph)   ph.style.display   = 'flex';
    return;
  }
  if (ph)   ph.style.display   = 'none';
  if (wrap) wrap.style.display = 'block';

  const { schedule, slots, employees } = result;
  const short  = st => STATION_SHORT[st] || st || '';
  const cssFor = st => STATION_CSS[st]   || 's-unassigned';

  const table = document.createElement('table');
  table.id = 'scheduleTable';

  // 헤더
  const thead = document.createElement('thead');
  const hr    = document.createElement('tr');
  const th0   = document.createElement('th');
  th0.textContent = '직원';
  hr.appendChild(th0);
  for (const slot of slots) {
    const th = document.createElement('th');
    const m  = parseTimeToMin(slot);
    th.textContent  = (m % 30 === 0) ? slot : '';
    if (m % 30 === 0) th.style.fontWeight = '700';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  // 바디
  const tbody  = document.createElement('tbody');
  const groups = [['OPEN','오픈조'], ['MID','중간조'], ['CLOSE','마감조']];

  for (const [g, glabel] of groups) {
    const emps = employees.filter(e => e.group === g);
    if (!emps.length) continue;

    // 그룹 구분 행
    const sepRow = document.createElement('tr');
    sepRow.className = 'group-sep';
    const sepTd  = document.createElement('td');
    sepTd.className   = 'sticky-name';
    sepTd.textContent = glabel;
    sepRow.appendChild(sepTd);
    for (let i = 0; i < slots.length; i++) sepRow.appendChild(document.createElement('td'));
    tbody.appendChild(sepRow);

    // 직원 행
    for (const e of emps) {
      const tr     = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.className   = 'sticky-name';
      nameTd.textContent = e.name || e.id;
      nameTd.title       = e.name || e.id;
      tr.appendChild(nameTd);

      const row = schedule[e.id];
      for (let i = 0; i < slots.length; i++) {
        const st  = row[i];
        const css = cssFor(st);
        const td  = document.createElement('td');
        td.className    = `cell ${css}`;
        td.dataset.css  = css;
        td.textContent  = short(st);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);

  const existing = $('scheduleTable');
  if (existing) existing.remove();
  wrap.appendChild(table);
  applyLegendFilter();
}

// ── 위반 패널 ─────────────────────────────────────────────────────

export function renderViolations(violations) {
  const panel = $('violationsPanel');
  if (!panel) return;
  panel.innerHTML = '';

  if (!violations?.length) {
    panel.innerHTML = '<span class="v-ok">✓ 위반 없음</span>';
    return;
  }
  for (const v of violations) {
    const div    = document.createElement('div');
    div.className = `v-item v-${v.type}`;
    const type   = document.createElement('span');
    type.className   = 'v-type';
    type.textContent = v.type;
    const detail = document.createElement('span');
    detail.style.fontSize = '10px';
    detail.textContent    = ' ' + v.detail;
    div.append(type, detail);
    panel.appendChild(div);
  }
}

// ── 통계 바 ───────────────────────────────────────────────────────

export function renderStats(stats) {
  const bar = $('statsBar');
  if (!bar || !stats) return;
  bar.innerHTML = '';

  const add = (label, val, cls = '') => {
    const c = document.createElement('span');
    c.className   = `stat-chip ${cls}`;
    c.textContent = `${label}: ${val}`;
    bar.appendChild(c);
  };

  add('커버리지 부족',
    `${stats.totalDeficits}슬롯`,
    stats.totalDeficits === 0 ? 'ok' : stats.totalDeficits < 5 ? 'warn' : 'err');
  add('코어편차(최대)',
    stats.maxVariance.toFixed(2),
    stats.maxVariance < 1 ? 'ok' : stats.maxVariance < 4 ? 'warn' : 'err');
  add('코어편차(평균)',
    stats.avgVariance.toFixed(2),
    stats.avgVariance < 1 ? 'ok' : stats.avgVariance < 3 ? 'warn' : 'err');
  add('직원',
    `${stats.coreCounts ? Object.keys(stats.coreCounts).length : 0}명`, '');
}

// ── 상태 메시지 ───────────────────────────────────────────────────

export function setStatus(msg, type = '') {
  const el = $('statusMsg');
  if (!el) return;
  el.textContent = msg;
  el.className   = `status-badge ${type}`;
}
