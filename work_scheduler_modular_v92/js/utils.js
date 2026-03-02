window.Utils = (() => {
  const TICK_MIN = 5;
  const DAY_START = '08:30';
  const DAY_END = '22:30';

  function timeToMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function minToTime(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function makeStartOptions() {
    const out = [];
    const s = timeToMin(DAY_START);
    const e = timeToMin('19:00');
    for (let t = s; t <= e; t += 15) out.push(minToTime(t));
    return out;
  }

  function overlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function generateId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) {}
    return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  return { TICK_MIN, DAY_START, DAY_END, timeToMin, minToTime, makeStartOptions, overlap, generateId };
})();
