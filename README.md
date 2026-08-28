# 초등 서논술형평가 문항 개발 도우미 - Netlify 배포형

## 구성
- public/index.html : 웹 화면
- public/assets/jeonnam-gwangju-logo.png : 전남광주통합특별시교육청 로고
- public/data/standards.json : 1~6학년 성취기준·성취수준 데이터
- netlify/functions/generate.js : Gemini 호출용 Netlify Function
- netlify.toml : Netlify 설정

## Netlify 설정
1. 이 폴더 전체를 Git 저장소에 올려 Netlify에 연결하거나, 로그인 상태에서 Netlify에 프로젝트 폴더를 배포합니다.
2. Netlify의 Project configuration → Environment variables에서 다음 변수를 추가합니다.
   - GEMINI_API_KEY = Google AI Studio API Key (필수)
   - GEMINI_MODEL = gemini-3.6-flash (선택)
3. 환경 변수를 추가·수정한 뒤에는 새로 배포해야 적용됩니다.

## 보안
GEMINI_API_KEY는 index.html에 넣지 않습니다.
API Key는 Netlify Function의 서버 환경 변수에서만 읽습니다.

## 데이터 상태
- 1~2학년군: 공식 성취기준별 A·B·C 진술 반영
- 3~4학년군: 공식 성취기준별 A·B·C 진술 반영
- 5~6학년군: 기존 복원·재구성 문구 유지(공식 성취수준 원문 대조 전)

## 배점
- 쉬움: 총 8점
- 보통: 총 10점
- 어려움: 총 12점
- 매우 어려움: 총 14점
난이도가 높아질수록 적용·분석·평가·창안 요소의 배점 비중이 커집니다.
