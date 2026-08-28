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


## fetch failed 대응 버전
이 버전은 Netlify Function에서 Gemini API를 호출할 때 브라우저용/global fetch 대신
Node 내장 `https.request()`를 사용합니다. 또한 IPv4 연결을 우선하여 일부 서버리스 런타임에서
발생하는 `fetch failed` 네트워크 오류를 더 구체적인 오류 코드로 확인할 수 있습니다.

문제가 계속되면 Netlify → Logs & Metrics → Functions → generate에서 오류 코드를 확인하세요.


## 응답 지연 개선
Netlify 동기 함수의 연결 제한에 근접하는 24~25초 응답을 줄이기 위해 다음을 적용했습니다.
- Gemini 3.6 Flash thinkingLevel: low
- maxOutputTokens: 6000
- Gemini 네트워크 타임아웃: 20초
- Function 로그에 gemini-api 실제 소요시간 기록


## 중요: Failed to fetch 수정
이 버전은 브라우저에서 `/api/generate` rewrite를 사용하지 않습니다.

이전 구조:
`/api/generate` → Netlify rewrite/proxy → `/.netlify/functions/generate`

수정 구조:
브라우저 → `/.netlify/functions/generate` 직접 호출

Netlify proxy rewrite는 장시간 요청에서 별도의 프록시 제한에 걸릴 수 있으므로,
Gemini처럼 20초 이상 걸릴 수 있는 요청은 Function URL을 같은 도메인에서 직접 호출합니다.
GEMINI_API_KEY는 여전히 브라우저에 노출되지 않고 Netlify Function에서만 읽습니다.
