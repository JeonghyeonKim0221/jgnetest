const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_DESCRIPTION_LENGTH = 3000;

const https = require("https");

/**
 * Netlify 런타임의 global fetch/undici 연결 문제를 피하기 위해
 * Gemini 호출은 Node 내장 https 모듈로 직접 전송합니다.
 * family: 4로 IPv4 연결을 우선해 일부 런타임의 fetch failed 문제를 줄입니다.
 */
function postJsonHttps(urlString, headers, payload, timeoutMs = 50000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "POST",
        family: 4,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          let data;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (error) {
            return reject(
              new Error(
                `Gemini 응답 JSON 해석 실패 (HTTP ${res.statusCode}): ${raw.slice(0, 500)}`
              )
            );
          }

          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Gemini API 연결 시간이 초과되었습니다."));
    });

    req.on("error", (error) => {
      const code = error && error.code ? ` [${error.code}]` : "";
      reject(new Error(`Gemini API 네트워크 연결 실패${code}: ${error.message}`));
    });

    req.write(body);
    req.end();
  });
}


const SCORE_PLANS = {
  easy: {
    total: 8,
    element1: { max: 3, high: 3, mid: 2, low: 1 },
    element2: { max: 3, high: 3, mid: 2, low: 1 },
    element3: { max: 2, high: 2, mid: 1, low: 0 }
  },
  normal: {
    total: 10,
    element1: { max: 3, high: 3, mid: 2, low: 1 },
    element2: { max: 3, high: 3, mid: 2, low: 1 },
    element3: { max: 4, high: 4, mid: 3, low: 1 }
  },
  hard: {
    total: 12,
    element1: { max: 3, high: 3, mid: 2, low: 1 },
    element2: { max: 4, high: 4, mid: 3, low: 1 },
    element3: { max: 5, high: 5, mid: 3, low: 1 }
  },
  "very-hard": {
    total: 14,
    element1: { max: 3, high: 3, mid: 2, low: 1 },
    element2: { max: 5, high: 5, mid: 3, low: 1 },
    element3: { max: 6, high: 6, mid: 4, low: 2 }
  }
};

const DIFFICULTY = {
  easy: {
    label: "쉬움",
    bloom: "기억·이해를 바탕으로 한 간단한 적용",
    guidance: "짧고 명확한 자료와 충분한 비계를 사용하여 기초 이해를 안정적으로 확인합니다."
  },
  normal: {
    label: "보통",
    bloom: "이해·적용 중심, 필요 시 기초 분석",
    guidance: "성취기준의 대표 수행을 확인하고 핵심 정보를 활용하여 설명하거나 적용하게 합니다."
  },
  hard: {
    label: "어려움",
    bloom: "적용·분석·평가",
    guidance: "관련 자료를 연결하고 근거를 활용해 분석하거나 판단하게 하되 교육과정 범위는 넘지 않습니다."
  },
  "very-hard": {
    label: "매우 어려움",
    bloom: "분석·평가·창안",
    guidance: "관련 자료를 종합하고 새로운 상황에 전이하여 판단·제안하게 하되 선행학습은 요구하지 않습니다."
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function sanitizeGeneratedMarkdown(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\$\s*\\rightarrow\s*\$/g, "→")
    .replace(/\\rightarrow/g, "→")
    .replace(/&rarr;/gi, "→")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripFence(text) {
  let value = String(text || "").trim();
  if (/^```(?:markdown|md)\s*/i.test(value) && /```\s*$/.test(value)) {
    value = value
      .replace(/^```(?:markdown|md)\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return value;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function scoreLine(n, s) {
  return `- 평가요소 ${n}: 최고 ${s.max}점 / 상 ${s.high}점 / 중 ${s.mid}점 / 하 ${s.low}점`;
}

function systemPrompt() {
  return [
    "당신은 대한민국 2022 개정 교육과정에 기반한 초등학교 서·논술형 평가도구 개발 전문가입니다.",
    "",
    "[핵심 원칙]",
    "1. 성취기준 → 성취수준 → 평가요소 → 평가과제 → 문항 → 채점기준 → 피드백의 정합성을 유지하십시오.",
    "2. 출판사 항목은 만들지 마십시오.",
    "3. 제공된 성취기준 원문과 A·B·C 성취수준을 임의로 수정하지 마십시오.",
    "4. 평가요소는 반드시 정확히 3개를 도출하십시오.",
    "5. 평가요소 1은 기초 이해·핵심 개념, 평가요소 2는 적용·설명·자료 해석, 평가요소 3은 성취기준 범위 안의 분석·평가·창안·근거 활용을 중심으로 설계하십시오.",
    "6. 세 평가요소는 서로 중복되지 않고 하나의 성취기준 도달을 단계적으로 보여 주어야 합니다.",
    "7. 성취기준 자체가 낮은 인지 수준을 요구하는 경우 억지로 고차 사고를 요구하지 마십시오.",
    "8. 발문의 반응지시어는 개정 블룸 텍사노미의 인지과정(기억, 이해, 적용, 분석, 평가, 창안)에 근거하십시오.",
    "9. 저학년은 읽기·쓰기 부담을 줄이고 그림·구체적 상황·짧은 문장을 활용하십시오.",
    "10. 고학년으로 갈수록 자료 연결, 근거 활용, 분석·평가·창안의 깊이를 높이되 교육과정 범위를 넘지 마십시오.",
    "11. 난이도는 선행학습이나 글자 수로 높이지 말고 사고의 깊이와 자료 간 관계의 복잡성으로 조정하십시오.",
    "12. 문항 조건은 꼭 필요한 것만 제시하고 채점기준과 정확히 대응시키십시오.",
    "13. 예시답안은 해당 학년 학생이 실제로 작성할 수 있는 수준으로 작성하십시오.",
    "14. 채점기준은 과업 특수적·분석적으로 작성하고 관찰 가능한 수행 특성을 수준별로 기술하십시오.",
    "15. 상·중·하 점수는 구간이 아니라 반드시 하나의 명확한 점수로 제시하십시오.",
    "16. 제공된 평가요소별 배점 숫자를 임의로 변경하지 마십시오.",
    "17. 자료에 없는 단원명, 차시, 영역 등을 사실처럼 임의 생성하지 마십시오.",
    "18. HTML 태그를 사용하지 마십시오. <br>, <div>, <span>, <b> 등을 출력하지 마십시오.",
    "19. LaTeX 수식 표기를 사용하지 마십시오. \\rightarrow, $...$ 대신 →, ×, ÷, ≥, ≤ 등 일반 문자를 사용하십시오.",
    "20. 표 안에서 줄을 나누고 싶을 때에도 <br>을 쓰지 말고 가운뎃점(·), 쉼표 또는 짧은 문장을 사용하십시오.",
    "21. 불필요한 반복 설명을 줄이고 각 항목을 간결하게 작성하여 전체 응답 길이를 과도하게 늘리지 마십시오.",
    "",
    "[개정 블룸 반응지시어 예]",
    "- 기억: 쓰시오, 찾으시오, 나열하시오",
    "- 이해: 설명하시오, 요약하시오, 비교하시오, 구분하시오",
    "- 적용: 적용하시오, 해결하시오, 활용하여 설명하시오",
    "- 분석: 분석하시오, 관계를 설명하시오, 원인을 추론하시오, 비교·대조하시오",
    "- 평가: 판단하시오, 선택하고 근거를 쓰시오, 타당성을 설명하시오",
    "- 창안: 제안하시오, 설계하시오, 구성하시오, 해결 방안을 제시하시오"
  ].join("\n");
}

function userPrompt(ctx) {
  const s = ctx.standard;
  const d = ctx.difficulty;
  const p = ctx.scorePlan;

  return [
    "다음 정보를 바탕으로 초등학교 서·논술형 평가도구를 Markdown으로 작성하십시오.",
    "",
    "[선택 정보]",
    `- 선택 학년: ${ctx.grade}학년`,
    `- 교육과정 학년군: ${ctx.band}`,
    `- 교과: ${s.subject}`,
    `- 성취기준: [${s.code}] ${s.text}`,
    `- 성취수준 상태: ${s.sourceStatus || ""}`,
    "",
    "[성취기준별 성취수준]",
    `- A: ${s.levels?.A || ""}`,
    `- B: ${s.levels?.B || ""}`,
    `- C: ${s.levels?.C || ""}`,
    "",
    "[난이도]",
    `- 단계: ${d.label}`,
    `- 권장 사고 수준: ${d.bloom}`,
    `- 설계 방식: ${d.guidance}`,
    "",
    "[평가요소별 배점]",
    `- 총점: ${p.total}점`,
    scoreLine(1, p.element1),
    scoreLine(2, p.element2),
    scoreLine(3, p.element3),
    "",
    "[배점 원칙]",
    "- 위 배점은 절대 변경하지 마십시오.",
    "- 상·중·하는 각각 하나의 정확한 점수입니다.",
    "- 2~3점 같은 점수 구간을 사용하지 마십시오.",
    "- 난이도가 높아질수록 더 깊은 사고와 수행을 요구하므로 총점과 고차 사고 평가요소의 비중이 커집니다.",
    "",
    "[사용자 추가 요청]",
    ctx.description || "추가 요청 없음",
    "",
    "[학년군 주의]",
    "성취기준 자료는 학년군 단위입니다. 선택 학년에 맞게 문장 길이, 자료량, 표현 난도를 조절하되 해당 성취기준이 그 개별 학년에 공식 배정되었다고 단정하지 마십시오.",
    String(s.sourceStatus || "").includes("복원·재구성")
      ? "5~6학년군 성취수준은 공식 원문 대조 전의 복원·재구성 문구이므로 공식 성취수준이라고 단정하지 마십시오."
      : "제공된 A·B·C 성취수준을 평가요소·채점기준·피드백 설계의 근거로 활용하십시오.",
    "",
    "[출력 구조]",
    `# ${ctx.grade}학년 ${s.subject} 서·논술형 평가도구`,
    "",
    "## 1. 평가도구 설계",
    "- 교과",
    "- 유형: 서술형 / 논술형 / 서·논술형 중 적절한 유형",
    "- 성취기준",
    "- 성취수준 A·B·C",
    "- 평가요소 1: 반드시 한 줄",
    "- 평가요소 2: 반드시 한 줄",
    "- 평가요소 3: 반드시 한 줄",
    `- 총점: ${p.total}점`,
    "- 평가과제",
    "- 평가 시 유의사항",
    "",
    '평가요소 이름은 반드시 "평가요소 1:", "평가요소 2:", "평가요소 3:" 형식을 사용하십시오.',
    "",
    "## 2. 문항별 설계",
    "각 문항별로 평가요소, 문항 유형, 개정 블룸 인지과정, 핵심 반응지시어, 자료·조건 설계 의도를 제시하십시오.",
    "",
    "## 3. 학생용 서·논술형 평가 과제",
    "- 학생에게 바로 제시할 수 있는 형태로 작성",
    "- 자료가 필요한 경우 실제 사용할 수 있는 표·짧은 글·관찰 기록·수치 자료 등을 텍스트로 함께 제공",
    "- 별도 그림이 필요한 경우 [그림 자료 필요]라고 표시",
    "",
    "## 4. 예시답안",
    "",
    "## 5. 채점기준",
    `- 평가요소 1: 최고 ${p.element1.max}점, 상 ${p.element1.high}점, 중 ${p.element1.mid}점, 하 ${p.element1.low}점`,
    `- 평가요소 2: 최고 ${p.element2.max}점, 상 ${p.element2.high}점, 중 ${p.element2.mid}점, 하 ${p.element2.low}점`,
    `- 평가요소 3: 최고 ${p.element3.max}점, 상 ${p.element3.high}점, 중 ${p.element3.mid}점, 하 ${p.element3.low}점`,
    "각 상·중·하에는 해당 점수를 받는 학생 답안의 관찰 가능한 수행 특성을 구체적으로 제시하십시오.",
    "",
    "## 6. 수준별 피드백",
    "### 상",
    "### 중",
    "### 하",
    "",
    "이미지가 실제로 필요한 경우에만 마지막에 다음 항목을 추가하십시오.",
    "## 그림 자료 생성 프롬프트",
    "### 그림 1",
    "```text",
    "ChatGPT 또는 Gemini 이미지 생성에 그대로 붙여 넣을 수 있는 한국어 프롬프트",
    "```"
  ].join("\n");
}

exports.handler = async function(event) {
  if (event.httpMethod === "GET") {
    return jsonResponse(200, {
      ok: true,
      hasApiKey: Boolean(process.env.GEMINI_API_KEY),
      model: DEFAULT_MODEL
    });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "허용되지 않은 요청입니다." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, {
      error: "Netlify 환경 변수 GEMINI_API_KEY가 설정되어 있지 않습니다."
    });
  }

  let req;
  try {
    req = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "요청 형식이 올바르지 않습니다." });
  }

  const grade = String(req.grade || "");
  const band = String(req.band || "");
  const difficultyKey = String(req.difficulty || "normal");
  const standard = req.standard;

  if (!/^[1-6]$/.test(grade) || !band || !standard?.code || !standard?.text || !standard?.subject) {
    return jsonResponse(400, { error: "학년·교과·성취기준 정보를 다시 선택해 주세요." });
  }

  const description = String(req.description || "")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);

  const difficulty = DIFFICULTY[difficultyKey] || DIFFICULTY.normal;
  const scorePlan = SCORE_PLANS[difficultyKey] || SCORE_PLANS.normal;

  const payload = {
    system_instruction: {
      parts: [{ text: systemPrompt() }]
    },
    contents: [{
      role: "user",
      parts: [{
        text: userPrompt({
          grade,
          band,
          standard,
          description,
          difficulty,
          scorePlan
        })
      }]
    }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 6000,
      thinkingConfig: {
        thinkingLevel: "low"
      }
    }
  };

  try {
    console.log("Gemini request start", {
      model: DEFAULT_MODEL,
      difficulty: difficultyKey,
      grade,
      subject: standard.subject
    });
    console.time("gemini-api");

    const response = await postJsonHttps(
      `${GEMINI_ENDPOINT}${encodeURIComponent(DEFAULT_MODEL)}:generateContent`,
      { "x-goog-api-key": apiKey },
      payload
    );

    console.timeEnd("gemini-api");
    console.log("Gemini response received", {
      status: response.status,
      ok: response.ok
    });

    const data = response.data;

    if (!response.ok) {
      console.error("Gemini API HTTP error", response.status, data?.error?.message || "");
      return jsonResponse(response.status, {
        error: data?.error?.message || `Gemini API 호출에 실패했습니다. HTTP ${response.status}`
      });
    }

    const raw = extractGeminiText(data);
    if (!raw) {
      return jsonResponse(502, { error: "Gemini 응답에서 생성된 텍스트를 찾지 못했습니다." });
    }

    const markdown = sanitizeGeneratedMarkdown(stripFence(raw));

    return jsonResponse(200, {
      markdown,
      model: DEFAULT_MODEL,
      scorePlan,
      grade,
      band,
      subject: standard.subject,
      code: standard.code
    });
  } catch (error) {
    console.error("generate function error:", {
      message: error?.message,
      code: error?.code,
      stack: error?.stack
    });

    return jsonResponse(500, {
      error: error?.message || "AI 생성 중 오류가 발생했습니다."
    });
  }
};
