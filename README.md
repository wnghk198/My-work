# 근무 스케줄러 (모듈화 v107)

## 업로드 방법 (GitHub Pages)
1) 이 ZIP을 압축 해제
2) 압축 해제된 폴더 안의 **index.html / css / js** 를 통째로 리포지토리 루트에 업로드(커밋)
   - 루트 구조 예:
     - index.html
     - css/style.css
     - js/app.js ... (나머지 js 파일들)
3) GitHub Pages 설정:
   - Settings → Pages → Source: (branch) / (root)
4) iOS 홈화면 앱 모드 사용 시:
   - 주소 뒤에 `?v=99` 붙여서 1회 접속 후 “홈 화면에 추가” 추천(캐시 방지)

## 포함 파일
- index.html
- css/style.css
- js/polyfills.js
- js/utils.js
- js/data.js
- js/scheduler.js
- js/ui.js
- js/app.js


- v107 변경: 4주 운영 관련 CSS(.fourweek-*) 및 사용되지 않는 선택자 정리(파일 경량화)
