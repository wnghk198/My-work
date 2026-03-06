/**
 * constants.js — 스테이션·제약·기본값 상수
 *
 * 의존성: 없음
 * 공개 API: ST, PRIORITY, CORE_STATIONS, STATION_COLOR,
 *           STATION_SHORT, STATION_CSS, CONSTRAINTS,
 *           GROUP_LABEL, GROUP_ORDER, DEFAULT_START_OPTIONS, DEFAULTS
 */

export const ST = Object.freeze({
  EXIT      : '2F출차',
  ELEV      : '2F엘베',
  F3        : '3F',
  CART2F    : '2F카트',
  CART3F    : '3F카트',
  MEAL      : '식사',
  MTG       : '안전회의',
  REST      : '휴식',
  OPEN_PREP : '오픈준비',
  OFF       : 'OFF',
});

export const PRIORITY = Object.freeze({
  [ST.REST]: 1, [ST.MEAL]: 1, [ST.MTG]: 1,
  [ST.EXIT]: 2, [ST.ELEV]: 2, [ST.F3]:  2,
  [ST.CART3F]: 3, [ST.CART2F]: 4, [ST.OPEN_PREP]: 4,
});

export const CORE_STATIONS = Object.freeze([ST.EXIT, ST.ELEV, ST.F3]);

export const STATION_COLOR = Object.freeze({
  [ST.EXIT]      : { bg: '#2563EB', text: '#fff'     },
  [ST.ELEV]      : { bg: '#7C3AED', text: '#fff'     },
  [ST.F3]        : { bg: '#059669', text: '#fff'     },
  [ST.CART2F]    : { bg: '#0891B2', text: '#fff'     },
  [ST.CART3F]    : { bg: '#0D9488', text: '#fff'     },
  [ST.MEAL]      : { bg: '#D97706', text: '#fff'     },
  [ST.MTG]       : { bg: '#DC2626', text: '#fff'     },
  [ST.REST]      : { bg: '#4B5563', text: '#CBD5E1'  },
  [ST.OPEN_PREP] : { bg: '#374151', text: '#9CA3AF'  },
  [ST.OFF]       : { bg: 'transparent', text: '#2A2F45' },
  ''             : { bg: 'rgba(241,245,249,0.04)', text: '#475569' },
});

export const STATION_SHORT = Object.freeze({
  [ST.EXIT]      : '출차',
  [ST.ELEV]      : '엘베',
  [ST.F3]        : '3F',
  [ST.CART2F]    : '2F카트',
  [ST.CART3F]    : '3F카트',
  [ST.MEAL]      : '식사',
  [ST.MTG]       : '회의',
  [ST.REST]      : '휴식',
  [ST.OPEN_PREP] : '오픈준비',
  [ST.OFF]       : 'OFF',
  ''             : '미정',
});

export const STATION_CSS = Object.freeze({
  [ST.EXIT]      : 's-exit',
  [ST.ELEV]      : 's-elev',
  [ST.F3]        : 's-3f',
  [ST.CART2F]    : 's-cart2f',
  [ST.CART3F]    : 's-cart3f',
  [ST.MEAL]      : 's-meal',
  [ST.MTG]       : 's-mtg',
  [ST.REST]      : 's-rest',
  [ST.OPEN_PREP] : 's-open-prep',
  [ST.OFF]       : 's-off',
  ''             : 's-unassigned',
});

export const CONSTRAINTS = Object.freeze({
  MAX_EXIT          : 1,
  MAX_ELEV          : 1,
  MAX_F3            : 3,
  MAX_CART3F        : 3,
  MAX_CART2F_SLOTS  : 2,
  CLOSE_LATE_MIN    : 21 * 60 + 30,
  COVERAGE_START_MIN: 10 * 60 + 30,
  STEP_MIN          : 15,
  ALLOW_HELPER      : false,
});

export const GROUP_LABEL = Object.freeze({
  OPEN : '오픈조',
  MID  : '중간조',
  CLOSE: '마감조',
});

export const GROUP_ORDER = Object.freeze({ OPEN: 0, MID: 1, CLOSE: 2 });

export const DEFAULT_START_OPTIONS = Object.freeze([
  '08:30','10:00','10:30','11:00','11:45',
  '12:00','12:30','13:00','13:30','13:50','15:30','15:50',
]);

export const DEFAULTS = Object.freeze({
  DAY_START      : '08:00',
  DAY_END        : '22:30',
  CORE_MIN_MIN   : 30,
  CORE_MAX_MIN   : 60,
  ANY_MIN_MIN    : 30,
  MEAL_DUR_MIN   : 60,
  MTG_DUR_MIN    : 15,
  MTG1_TIME      : '15:00',
  MTG2_TIME      : '15:15',
  SEED           : 112,
  OPEN_START     : '08:30',
  CLOSE_START    : '13:30',
  OPEN_MEAL_1130 : 0,
  OPEN_MEAL_1230 : 0,
  CLOSE_MEAL_MODE: 'auto',
});
