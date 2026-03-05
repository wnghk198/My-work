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
    const match = filter.has(c.dataset.css);
    c.classList.toggle('dim', active && !match);
    c.classList.toggle('highlight', active && match);
  }
  updateLegendUI();
}

// ── 스케줄 테이블 ─────────────────────────────────────────────────

/** 연속 동일 스테이션 블록 압축 (OFF 포함 전체 병합) */
function compressRow(row) {
  const out = [];
  let i = 0;
  while (i < row.length) {
    const st = row[i];
    let span = 1;
    while (i + span < row.length && row[i + span] === st) span++;
    out.push({ st, span, slotIdx: i });
    i += span;
  }
  return out;
}

/** 블록 폭(슬롯 수)에 따른 표시 레이블 */
function blockLabel(st, span, short) {
  const full = short(st);
  if (!full || st === 'OFF' || st === '') return '';
  if (span === 1) {
    // 15분: 한 글자 약어
    const abbr = { '출차':'차','엘베':'엘','3F':'3','2F카트':'카','3F카트':'F','식사':'밥','회의':'회','휴식':'쉬','오픈준비':'준' };
    return abbr[full] ?? full.slice(0, 1);
  }
  return full;
}

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
  const short  = st => STATION_SHORT[st] ?? st ?? '';
  const cssFor = st => STATION_CSS[st]   ?? 's-unassigned';

  const table = document.createElement('table');
  table.id        = 'scheduleTable';
  table.className = 'schedule-table';

  // ── 헤더 2행 ─────────────────────────────────────────────────
  const thead = document.createElement('thead');

  // 행1: 이름 th(rowspan=2) + 정각 시간 colspan 묶음
  const hrH = document.createElement('tr');
  hrH.className = 'thead-hours';
  const thName = document.createElement('th');
  thName.rowSpan     = 2;
  thName.className   = 'th-name';
  thName.textContent = '직원';
  hrH.appendChild(thName);

  let si = 0;
  while (si < slots.length) {
    const m = parseTimeToMin(slots[si]);
    let hspan = 0;
    while (si + hspan < slots.length) {
      if (hspan > 0 && parseTimeToMin(slots[si + hspan]) % 60 === 0) break;
      hspan++;
    }
    const th = document.createElement('th');
    th.colSpan   = hspan;
    th.className = 'th-hour' + (m % 60 === 0 ? ' th-hour-tick' : '');
    if (m % 60 === 0) th.textContent = slots[si];
    hrH.appendChild(th);
    si += hspan;
  }

  // 행2: 15분 눈금
  const hrM = document.createElement('tr');
  hrM.className = 'thead-mins';
  for (const slot of slots) {
    const m  = parseTimeToMin(slot);
    const th = document.createElement('th');
    if      (m % 60 === 0) { th.className = 'th-min th-min-h';  th.textContent = ':00'; }
    else if (m % 30 === 0) { th.className = 'th-min th-min-hh'; th.textContent = ':30'; }
    else                   { th.className = 'th-min'; }
    hrM.appendChild(th);
  }

  thead.append(hrH, hrM);
  table.appendChild(thead);

  // ── tbody ───────────────────────────────────────────────────
  const tbody = document.createElement('tbody');
  const GROUPS = [
    ['OPEN',  '오픈조', '#3B82F6'],
    ['MID',   '중간조', '#10B981'],
    ['CLOSE', '마감조', '#A855F7'],
  ];

  for (const [g, glabel, gColor] of GROUPS) {
    const emps = employees.filter(e => e.group === g);
    if (!emps.length) continue;

    // 그룹 구분 행
    const sepTr = document.createElement('tr');
    sepTr.className = 'group-sep';
    const sepTd = document.createElement('td');
    sepTd.className        = 'group-sep-name';
    sepTd.style.borderLeft = `4px solid ${gColor}`;
    sepTd.innerHTML =
      `<span class="g-dot" style="background:${gColor}"></span>` +
      `<span class="g-label">${glabel}</span>` +
      `<span class="g-count">${emps.length}명</span>`;
    sepTr.appendChild(sepTd);
    const sepFill = document.createElement('td');
    sepFill.colSpan   = slots.length;
    sepFill.className = 'group-sep-fill';
    sepTr.appendChild(sepFill);
    tbody.appendChild(sepTr);

    // 직원 행
    for (let ri = 0; ri < emps.length; ri++) {
      const e  = emps[ri];
      const tr = document.createElement('tr');
      tr.className = `emp-row ${ri % 2 === 0 ? 'row-even' : 'row-odd'}`;

      // 이름 셀
      const nameTd = document.createElement('td');
      nameTd.className        = 'td-name';
      nameTd.style.borderLeft = `4px solid ${gColor}55`;
      nameTd.textContent      = e.name || e.id;
      nameTd.title            = `${e.name || e.id} · ${glabel} · ${e.hours}h · ${e.start ?? ''}`;
      tr.appendChild(nameTd);

      // 블록 셀 (연속 동일 스테이션 병합)
      for (const blk of compressRow(schedule[e.id])) {
        const css = cssFor(blk.st);
        const td  = document.createElement('td');
        td.colSpan     = blk.span;
        td.className   = `cell ${css}`;
        td.dataset.css = css;

        if (blk.st && blk.st !== 'OFF' && blk.st !== '') {
          td.textContent = blockLabel(blk.st, blk.span, short);
          td.title       = `${short(blk.st)} · ${blk.span * 15}분 (${slots[blk.slotIdx]})`;
          if (blk.span === 1) td.classList.add('cell-xs');
        }

        // 시간 경계 마커
        const bm = parseTimeToMin(slots[blk.slotIdx]);
        if      (bm % 60 === 0) td.classList.add('cell-at-h');
        else if (bm % 30 === 0) td.classList.add('cell-at-hh');

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
