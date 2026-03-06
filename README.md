# BLOCKPYO 스케줄러

> Pyodide 기반 순수 정적 웹앱 — GitHub Pages에서 즉시 실행

## 🚀 배포 방법

1. 이 저장소를 GitHub에 Push
2. **Settings → Pages → Source: `GitHub Actions`** 선택
3. 자동 배포 완료 후 `https://<user>.github.io/<repo>/` 접속

## ✨ 특징

| 항목 | 설명 |
|------|------|
| **런타임** | Pyodide 0.27 (CDN 로드, 설치 불필요) |
| **배포** | 단일 `index.html` — 서버 불필요 |
| **모듈** | 11개 Python 모듈 가상 파일시스템에 내장 |
| **저장** | IndexedDB (브라우저 로컬 영속 저장) |
| **내보내기** | CSV (BOM UTF-8) |

## 📁 구조

```
.
├── index.html          ← 모든 Python + CSS + HTML 포함
├── .nojekyll           ← Jekyll 비활성화
├── .github/
│   └── workflows/
│       └── deploy.yml  ← 자동 배포 워크플로
└── README.md
```

## 🐍 Python 모듈 목록 (내장)

- `constants.py` — 스테이션/제약/기본값
- `utils.py` — 시간 파싱, 슬롯 빌더, RNG
- `scheduler/index.py` — 스케줄 생성 진입점 (5-Phase)
- `scheduler/core.py` — 핵심 헬퍼, 커버리지 계산
- `scheduler/events.py` — 회의/식사/휴식 배치
- `scheduler/assign.py` — 사전 배정 & 그리디 블록
- `scheduler/balance.py` — 균형화 & 제약 강제
- `scheduler/repair.py` — 커버리지 수리
- `scheduler/force.py` — 강제 해소 패스
- `scheduler/validate.py` — 검증 & 통계
- `app.py` — UI 이벤트 & DOM 조작

## 🔒 오프라인 사용

최초 로드 시 Pyodide (~30MB) CDN에서 다운로드합니다.  
이후 브라우저 캐시 덕분에 재방문 시 빠르게 로드됩니다.
