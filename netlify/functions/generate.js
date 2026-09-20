const BASIC_MODEL = process.env.GEMINI_MODEL_BASIC || "gemini-3.5-flash-lite";
const HIGH_QUALITY_MODEL = process.env.GEMINI_MODEL_HIGH || "gemini-3.8-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_DESCRIPTION_LENGTH = 3000;
const https = require("https");

function postJsonHttps(urlString, headers, payload, timeoutMs = 50000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const req = https.request({
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
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        let data;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch { return reject(new Error(`Gemini 응답 JSON 해석 실패 (HTTP ${res.statusCode})`)); }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Gemini API 연결 시간이 초과되었습니다.")));
    req.on("error", error => reject(new Error(`Gemini API 네트워크 연결 실패${error.code ? ` [${error.code}]` : ""}: ${error.message}`)));
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
  easy: { label: "쉬움", bloom: "기억·이해를 바탕으로 한 간단한 적용", guidance: "짧고 명확한 자료와 충분한 비계를 활용한다." },
  normal: { label: "보통", bloom: "이해·적용 중심, 필요 시 기초 분석", guidance: "대표 수행을 확인하고 핵심 정보를 활용하여 설명하거나 적용하게 한다." },
  hard: { label: "어려움", bloom: "적용·분석·평가", guidance: "자료를 연결하고 근거를 활용하여 분석·판단하게 한다." },
  "very-hard": { label: "매우 어려움", bloom: "분석·평가·창안", guidance: "자료를 종합하고 새로운 상황에 전이하여 판단·제안하게 한다." }
};

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function cleanString(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\$\s*\\rightarrow\s*\$/g, "→")
    .replace(/\\rightarrow/g, "→")
    .replace(/&rarr;/gi, "→")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sanitizeDeep(value) {
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([k, v]) => out[k] = sanitizeDeep(v));
    return out;
  }
  return typeof value === "string" ? cleanString(value) : value;
}

function stripJsonFence(text) {
  return String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function extractGeminiText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .filter(p => typeof p?.text === "string")
    .map(p => p.text)
    .join("\n")
    .trim();
}

function systemPrompt() {
  return [
    "당신은 대한민국 2022 개정 교육과정 기반 초등 서·논술형 평가도구 개발 전문가입니다.",
    "교사가 실제로 사용할 수 있는 평가 개발 약안과 학생용 평가 과제를 설계합니다.",
    "성취기준 → 성취수준 → 평가요소 → 평가과제 → 문항 → 채점기준 → 피드백의 정합성을 최우선으로 합니다.",
    "평가요소는 정확히 3개이며 서로 중복되지 않고 단계적으로 연결되어야 합니다.",
    "문항도 정확히 3개이며 각 문항은 평가요소 1·2·3에 각각 대응합니다.",
    "출판사 항목은 만들지 마십시오.",
    "자료에 없는 단원명·영역·차시를 임의로 사실처럼 만들지 마십시오. 사용자가 제공하지 않으면 빈 문자열로 두십시오.",
    "제공된 성취기준과 공식 A·B·C 성취수준의 의미를 임의로 바꾸지 마십시오.",
    "발문은 개정 블룸 텍사노미의 인지과정과 실제 과업의 사고 수준이 일치하도록 설계하십시오.",
    "저학년은 문장과 자료량을 줄이고, 고학년은 자료 연결·근거 활용·분석과 판단을 강화하십시오.",
    "난이도는 글자 수나 선행학습이 아니라 사고 깊이와 자료 관계의 복잡성으로 조절하십시오.",
    "채점기준은 관찰 가능한 수행 특성으로 작성하고 상·중·하 점수는 정확한 단일 점수를 사용하십시오.",
    "문항 조건은 꼭 필요한 것만 제시하고 채점기준과 직접 대응시키십시오.",
    "예시답안은 해당 학년 학생이 실제 작성할 수 있는 수준으로 제시하십시오.",
    "피드백은 잘한 점과 다음 학습 행동이 드러나도록 작성하십시오.",
    "HTML 태그와 LaTeX 표기를 사용하지 마십시오.",
    "불필요하게 장황하게 쓰지 말고, 각 문장은 평가에 꼭 필요한 정보만 담아 간결하고 구체적으로 작성하십시오.",
    "반드시 JSON 객체 하나만 출력하고 JSON 밖에 설명을 붙이지 마십시오."
  ].join("\n");
}

function userPrompt(ctx) {
  const s = ctx.standard;
  const p = ctx.scorePlan;
  return `다음 정보를 바탕으로 평가도구를 설계하십시오.\n\n` +
`[기본 정보]\n` +
`- 학년: ${ctx.grade}학년\n` +
`- 학기: ${ctx.semester || ""}\n` +
`- 학년군: ${ctx.band}\n` +
`- 교과: ${s.subject}\n` +
`- 영역: ${ctx.area || ""}\n` +
`- 단원명(차시): ${ctx.unit || ""}\n` +
`- 유형: 서·논술형\n` +
`- 성취기준: [${s.code}] ${s.text}\n` +
`- 성취수준 A: ${s.levels?.A || ""}\n` +
`- 성취수준 B: ${s.levels?.B || ""}\n` +
`- 성취수준 C: ${s.levels?.C || ""}\n` +
`- 난이도: ${ctx.difficulty.label} (${ctx.difficulty.bloom})\n` +
`- 난이도 설계: ${ctx.difficulty.guidance}\n` +
`- 사용자 추가 요청: ${ctx.description || "없음"}\n\n` +
`[고정 배점]\n` +
`- 총점 ${p.total}점\n` +
`- 평가요소1: 최고 ${p.element1.max}점, 상 ${p.element1.high}점, 중 ${p.element1.mid}점, 하 ${p.element1.low}점\n` +
`- 평가요소2: 최고 ${p.element2.max}점, 상 ${p.element2.high}점, 중 ${p.element2.mid}점, 하 ${p.element2.low}점\n` +
`- 평가요소3: 최고 ${p.element3.max}점, 상 ${p.element3.high}점, 중 ${p.element3.mid}점, 하 ${p.element3.low}점\n\n` +
`[JSON 출력 구조]\n` +
`{\n` +
`  "meta": {"title":"", "grade":"${ctx.grade}", "semester":"${ctx.semester || ""}", "subject":"${s.subject}", "area":"${ctx.area || ""}", "type":"서·논술형", "unit":"${ctx.unit || ""}", "totalScore":${p.total}},\n` +
`  "standard": {"code":"${s.code}", "text":"${s.text}", "levels":{"A":"${escapeForPrompt(s.levels?.A)}", "B":"${escapeForPrompt(s.levels?.B)}", "C":"${escapeForPrompt(s.levels?.C)}"}},\n` +
`  "evaluationElements": [\n` +
`    {"index":1,"name":"","itemNumber":1,"maxScore":${p.element1.max}},\n` +
`    {"index":2,"name":"","itemNumber":2,"maxScore":${p.element2.max}},\n` +
`    {"index":3,"name":"","itemNumber":3,"maxScore":${p.element3.max}}\n` +
`  ],\n` +
`  "evaluationTasks": ["","",""],\n` +
`  "cautions": ["",""],\n` +
`  "items": [\n` +
`    {"number":1,"score":${p.element1.max},"elementIndex":1,"intro":"","materialTitle":"","materialText":"","prompt":"","conditions":[],"answerLines":3,"imageNeeded":false,"imagePrompt":""},\n` +
`    {"number":2,"score":${p.element2.max},"elementIndex":2,"intro":"","materialTitle":"","materialText":"","prompt":"","conditions":[],"answerLines":3,"imageNeeded":false,"imagePrompt":""},\n` +
`    {"number":3,"score":${p.element3.max},"elementIndex":3,"intro":"","materialTitle":"","materialText":"","prompt":"","conditions":[],"answerLines":5,"imageNeeded":false,"imagePrompt":""}\n` +
`  ],\n` +
`  "rubrics": [\n` +
`    {"elementIndex":1,"itemNumber":1,"label":"채점기준1","maxScore":${p.element1.max},"high":{"score":${p.element1.high},"description":""},"mid":{"score":${p.element1.mid},"description":""},"low":{"score":${p.element1.low},"description":""}},\n` +
`    {"elementIndex":2,"itemNumber":2,"label":"채점기준2","maxScore":${p.element2.max},"high":{"score":${p.element2.high},"description":""},"mid":{"score":${p.element2.mid},"description":""},"low":{"score":${p.element2.low},"description":""}},\n` +
`    {"elementIndex":3,"itemNumber":3,"label":"채점기준3","maxScore":${p.element3.max},"high":{"score":${p.element3.high},"description":""},"mid":{"score":${p.element3.mid},"description":""},"low":{"score":${p.element3.low},"description":""}}\n` +
`  ],\n` +
`  "sampleAnswers": [{"number":1,"answer":""},{"number":2,"answer":""},{"number":3,"answer":""}],\n` +
`  "feedback": {"high":"","mid":"","low":""}\n` +
`}\n\n` +
`[작성 지침]\n` +
`- meta.title은 학기 정보가 있으면 "${ctx.grade}학년 ${ctx.semester} ${s.subject}과 서·논술형 평가", 없으면 "${ctx.grade}학년 ${s.subject}과 서·논술형 평가"로 작성하십시오.\n` +
`- 평가요소는 짧은 명사형 구문으로 작성하십시오.\n` +
`- evaluationTasks는 "과제 1. ..." 형식의 문장으로 작성하십시오.\n` +
`- cautions에는 실제 채점에서 확인해야 할 핵심 사항을 2~3개 제시하십시오.\n` +
`- items의 intro는 자료 상황을 소개하는 문장, materialText는 학생에게 제시할 실제 자료, prompt는 학생이 답해야 할 발문입니다.\n` +
`- materialText가 필요 없으면 빈 문자열로 두십시오.\n` +
`- 그림 자료가 꼭 필요한 경우 imageNeeded=true로 하고 imagePrompt에 이미지 생성 프롬프트를 넣으십시오. 그림 없이 텍스트 자료로 충분하면 false로 두십시오.\n` +
`- answerLines는 필요한 답안 분량에 따라 2~6 사이 정수로 정하십시오.\n` +
`- 3번 문항은 가능하면 1·2번에서 확인한 정보를 종합하여 공통점·원리·판단·제안 등 한 단계 높은 사고가 드러나도록 구성하십시오.\n` +
`- rubrics는 각 문항의 실제 수행과 직접 연결되어야 하며 고정된 점수를 절대 변경하지 마십시오.\n` +
`- feedback.high/mid/low는 전체 수행 수준에 대한 피드백으로 작성하십시오.`;
}

function escapeForPrompt(value) {
  return cleanString(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function validateAssessment(result, scorePlan) {
  if (!result || typeof result !== "object") throw new Error("생성 결과가 올바른 JSON 객체가 아닙니다.");
  if (!Array.isArray(result.evaluationElements) || result.evaluationElements.length !== 3) throw new Error("평가요소가 3개로 생성되지 않았습니다.");
  if (!Array.isArray(result.items) || result.items.length !== 3) throw new Error("평가 문항이 3개로 생성되지 않았습니다.");
  if (!Array.isArray(result.rubrics) || result.rubrics.length !== 3) throw new Error("채점기준이 3개로 생성되지 않았습니다.");

  const expected = [scorePlan.element1, scorePlan.element2, scorePlan.element3];
  result.meta = result.meta || {};
  result.meta.totalScore = scorePlan.total;

  for (let i = 0; i < 3; i++) {
    const sc = expected[i];
    result.evaluationElements[i].index = i + 1;
    result.evaluationElements[i].itemNumber = i + 1;
    result.evaluationElements[i].maxScore = sc.max;
    result.items[i].number = i + 1;
    result.items[i].elementIndex = i + 1;
    result.items[i].score = sc.max;
    result.items[i].answerLines = Math.max(2, Math.min(6, Number(result.items[i].answerLines) || 3));
    result.rubrics[i].elementIndex = i + 1;
    result.rubrics[i].itemNumber = i + 1;
    result.rubrics[i].maxScore = sc.max;
    result.rubrics[i].high = { ...(result.rubrics[i].high || {}), score: sc.high };
    result.rubrics[i].mid = { ...(result.rubrics[i].mid || {}), score: sc.mid };
    result.rubrics[i].low = { ...(result.rubrics[i].low || {}), score: sc.low };
  }
  return result;
}

exports.handler = async function(event) {
  if (event.httpMethod === "GET") {
    return jsonResponse(200, { ok: true, hasApiKey: Boolean(process.env.GEMINI_API_KEY), basicModel: BASIC_MODEL, highQualityModel: HIGH_QUALITY_MODEL, version: "pdf-layout-v3-quality-option" });
  }
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "허용되지 않은 요청입니다." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return jsonResponse(500, { error: "Netlify 환경 변수 GEMINI_API_KEY가 설정되어 있지 않습니다." });

  let req;
  try { req = JSON.parse(event.body || "{}"); }
  catch { return jsonResponse(400, { error: "요청 형식이 올바르지 않습니다." }); }

  const grade = String(req.grade || "");
  const band = String(req.band || "");
  const difficultyKey = String(req.difficulty || "normal");
  const qualityKey = req.quality === "high" ? "high" : "basic";
  const model = qualityKey === "high" ? HIGH_QUALITY_MODEL : BASIC_MODEL;
  const qualityLabel = qualityKey === "high" ? "고품질 생성" : "기본 생성";
  const thinkingLevel = qualityKey === "high" ? "medium" : "minimal";
  const standard = req.standard;
  if (!/^[1-6]$/.test(grade) || !band || !standard?.code || !standard?.text || !standard?.subject) {
    return jsonResponse(400, { error: "학년·교과·성취기준 정보를 다시 선택해 주세요." });
  }

  const scorePlan = SCORE_PLANS[difficultyKey] || SCORE_PLANS.normal;
  const difficulty = DIFFICULTY[difficultyKey] || DIFFICULTY.normal;
  const description = cleanString(req.description).slice(0, MAX_DESCRIPTION_LENGTH);
  const semester = cleanString(req.semester);
  const area = cleanString(req.area).slice(0, 100);
  const unit = cleanString(req.unit).slice(0, 200);

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt() }] },
    contents: [{ role: "user", parts: [{ text: userPrompt({ grade, band, standard, description, difficulty, scorePlan, semester, area, unit }) }] }],
    generationConfig: {
      maxOutputTokens: qualityKey === "high" ? 7000 : 5200,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel }
    }
  };

  try {
    console.log("Gemini request start", { model, quality: qualityKey, thinkingLevel, difficulty: difficultyKey, grade, subject: standard.subject });
    console.time("gemini-api");
    const response = await postJsonHttps(`${GEMINI_ENDPOINT}${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": apiKey }, payload);
    console.timeEnd("gemini-api");

    const data = response.data;
    if (!response.ok) {
      console.error("Gemini API HTTP error", response.status, data?.error?.message || "");
      return jsonResponse(response.status, { error: data?.error?.message || `Gemini API 호출에 실패했습니다. HTTP ${response.status}` });
    }

    const raw = extractGeminiText(data);
    if (!raw) return jsonResponse(502, { error: "Gemini 응답에서 생성 결과를 찾지 못했습니다." });

    let assessment;
    try { assessment = JSON.parse(stripJsonFence(raw)); }
    catch (error) {
      console.error("Assessment JSON parse error", raw.slice(0, 1000));
      return jsonResponse(502, { error: "AI가 생성한 평가도구의 구조를 해석하지 못했습니다. 다시 생성해 주세요." });
    }

    assessment = validateAssessment(sanitizeDeep(assessment), scorePlan);
    assessment.meta = {
      ...(assessment.meta || {}),
      grade,
      semester,
      subject: standard.subject,
      area,
      type: "서·논술형",
      unit,
      totalScore: scorePlan.total,
      difficulty: difficulty.label,
      generationQuality: qualityLabel,
      band
    };
    assessment.standard = {
      code: standard.code,
      text: standard.text,
      levels: { A: standard.levels?.A || "", B: standard.levels?.B || "", C: standard.levels?.C || "" }
    };

    return jsonResponse(200, { assessment, model, quality: qualityKey, qualityLabel, thinkingLevel, scorePlan, grade, band, subject: standard.subject, code: standard.code });
  } catch (error) {
    console.error("generate function error:", { message: error?.message, code: error?.code, stack: error?.stack });
    return jsonResponse(500, { error: error?.message || "AI 생성 중 오류가 발생했습니다." });
  }
};
