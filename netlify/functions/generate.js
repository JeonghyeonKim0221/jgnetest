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
      protocol: url.protocol, hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: "POST", family: 4,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
      timeout: timeoutMs
    }, res => {
      let raw = ""; res.setEncoding("utf8");
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
    req.write(body); req.end();
  });
}

const DIFFICULTY = {
  easy: { label: "쉬움", bloom: "기억·이해를 바탕으로 한 간단한 적용", guidance: "짧고 명확한 자료와 충분한 비계를 활용한다." },
  normal: { label: "보통", bloom: "이해·적용 중심, 필요 시 기초 분석", guidance: "대표 수행을 확인하고 핵심 정보를 활용하여 설명하거나 적용하게 한다." },
  hard: { label: "어려움", bloom: "적용·분석·평가", guidance: "자료를 연결하고 근거를 활용하여 분석·판단하게 한다." },
  "very-hard": { label: "매우 어려움", bloom: "분석·평가·창안", guidance: "자료를 종합하고 새로운 상황에 전이하여 판단·제안하게 한다." }
};
const LEVEL_INDEX = { easy:0, normal:1, hard:2, "very-hard":3 };
const MAX_SCORES = {
  2: [[2,4],[3,5],[4,6],[5,7]],
  3: [[2,3,3],[3,3,4],[3,4,5],[3,5,6]],
  4: [[2,2,3,3],[2,3,3,4],[2,3,4,5],[3,4,4,5]]
};

function levelScores(max) {
  const map={2:[2,1,0],3:[3,2,1],4:[4,3,1],5:[5,3,1],6:[6,4,2],7:[7,5,2],8:[8,5,2]};
  const v=map[max] || [max, Math.max(1,Math.round(max*.65)), Math.max(0,Math.round(max*.25))];
  return { max, high:v[0], mid:v[1], low:v[2] };
}
function buildScorePlan(difficultyKey,count){
  const c=Math.max(2,Math.min(4,Number(count)||3));
  const idx=LEVEL_INDEX[difficultyKey] ?? 1;
  const maxima=MAX_SCORES[c][idx];
  return { total:maxima.reduce((a,b)=>a+b,0), elements:maxima.map(levelScores) };
}
function jsonResponse(statusCode, body) { return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) }; }
function cleanString(value) { return String(value ?? "").replace(/<br\s*\/?>/gi," · ").replace(/<\/?[A-Za-z][^>]*>/g,"").replace(/\$\s*\\rightarrow\s*\$/g,"→").replace(/\\rightarrow/g,"→").replace(/&rarr;/gi,"→").replace(/&nbsp;/gi," ").replace(/[ \t]{2,}/g," ").trim(); }
function sanitizeDeep(value){ if(Array.isArray(value)) return value.map(sanitizeDeep); if(value&&typeof value==="object"){const out={};Object.entries(value).forEach(([k,v])=>out[k]=sanitizeDeep(v));return out;} return typeof value==="string"?cleanString(value):value; }
function stripJsonFence(text){return String(text||"").trim().replace(/^```(?:json)?\s*/i,"").replace(/```\s*$/,"").trim();}
function extractGeminiText(data){return (data?.candidates?.[0]?.content?.parts||[]).filter(p=>typeof p?.text==="string").map(p=>p.text).join("\n").trim();}
function escapeForPrompt(value){return cleanString(value).replace(/\\/g,"\\\\").replace(/"/g,'\\"');}
function arr(v,max=30){return Array.isArray(v)?v.slice(0,max).map(cleanString).filter(Boolean):[];}

function curriculumPrompt(c){
  const ce=c?.contentElements||{};
  return [
    `- 성취기준 주제: ${cleanString(c?.achievementTopic)||"자료 없음"}`,
    `- 선택한 내용 체계 영역: ${cleanString(c?.selectedArea)||"선택 안 함"}`,
    `- 핵심 아이디어: ${arr(c?.coreIdeas).join(" / ")||"자료 없음"}`,
    `- 내용 요소(지식·이해): ${arr(ce["지식·이해"]).join(" / ")||"자료 없음"}`,
    `- 내용 요소(과정·기능): ${arr(ce["과정·기능"]).join(" / ")||"자료 없음"}`,
    `- 내용 요소(가치·태도): ${arr(ce["가치·태도"]).join(" / ")||"자료 없음"}`,
    `- 성취기준 해설: ${arr(c?.explanation).join(" / ")||"별도 해설 없음"}`,
    `- 적용 시 고려 사항: ${arr(c?.considerations).join(" / ")||"별도 고려 사항 없음"}`
  ].join("\n");
}

function systemPrompt(){return [
  "당신은 대한민국 2022 개정 교육과정 기반 초등 서·논술형 평가도구 개발 전문가입니다.",
  "성취기준→성취수준→교육과정 맥락→평가요소→평가과제→문항→채점기준→피드백의 정합성을 최우선으로 합니다.",
  "평가요소는 요청된 2~4개이며 서로 중복되지 않고 기초 이해에서 적용·분석·판단 등으로 자연스럽게 연결되도록 배열합니다.",
  "사용자가 직접 작성한 평가요소는 문구를 임의로 바꾸지 말고 그대로 사용하십시오. 빈 평가요소만 보완하십시오.",
  "문항 수는 평가요소 수와 같고 각 문항은 평가요소에 1대1로 대응합니다.",
  "핵심 아이디어와 내용 요소는 내용 체계 영역 단위 정보이므로 제공된 범위만 활용하고 없는 연결을 임의 생성하지 마십시오.",
  "성취기준 해설과 적용 시 고려 사항을 문항 소재, 자료, 발문, 채점기준 설계에 반영하십시오.",
  "출판사 항목은 만들지 마십시오. 자료에 없는 단원명·차시를 사실처럼 만들지 마십시오.",
  "저학년은 읽기·쓰기 부담을 줄이고, 고학년은 자료 연결·근거 활용·분석과 판단을 강화하십시오.",
  "난이도는 글자 수나 선행학습이 아니라 사고 깊이와 자료 관계의 복잡성으로 조절하십시오.",
  "채점기준은 관찰 가능한 수행 특성으로 작성하고 상·중·하 점수는 정확한 단일 점수를 사용하십시오.",
  "HTML 태그와 LaTeX 표기를 사용하지 마십시오.",
  "반드시 JSON 객체 하나만 출력하십시오."
].join("\n");}

function suggestPrompt(ctx){
  const fixed=ctx.elements.map((x,i)=>`${i+1}. ${x||"(빈칸)"}`).join("\n");
  return `다음 성취기준을 평가하기 위한 평가요소를 정확히 ${ctx.count}개 제안하십시오.\n`+
    `평가요소는 학생이 무엇을 알고 무엇을 할 수 있는지를 관찰 가능한 짧은 명사형 구문으로 쓰십시오.\n`+
    `지식·이해만 반복하지 말고 성취기준의 동사, 과정·기능, 성취수준을 함께 고려하십시오.\n`+
    `사용자가 이미 작성한 위치의 평가요소는 그대로 유지하고 빈칸만 보완하십시오.\n\n`+
    `[성취기준]\n[${ctx.standard.code}] ${ctx.standard.text}\n`+
    `[성취수준]\nA ${ctx.standard.levels?.A||""}\nB ${ctx.standard.levels?.B||""}\nC ${ctx.standard.levels?.C||""}\n`+
    `[교육과정 맥락]\n${curriculumPrompt(ctx.curriculum)}\n`+
    `[현재 평가요소]\n${fixed}\n\n`+
    `{"elements":["평가요소1","평가요소2"]}와 같은 JSON 형식으로 elements 배열만 출력하십시오. 배열 길이는 반드시 ${ctx.count}개여야 합니다.`;
}

function userPrompt(ctx){
  const s=ctx.standard,p=ctx.scorePlan,count=ctx.count;
  const fixed=ctx.elements.map((x,i)=>`${i+1}. ${x||"(AI가 추출)"}`).join("\n");
  const elementJson=p.elements.map((sc,i)=>`    {"index":${i+1},"name":"","itemNumber":${i+1},"maxScore":${sc.max}}`).join(",\n");
  const itemsJson=p.elements.map((sc,i)=>`    {"number":${i+1},"score":${sc.max},"elementIndex":${i+1},"intro":"","materialTitle":"","materialText":"","prompt":"","conditions":[],"answerLines":${i===count-1?5:3},"imageNeeded":false,"imagePrompt":""}`).join(",\n");
  const rubricJson=p.elements.map((sc,i)=>`    {"elementIndex":${i+1},"itemNumber":${i+1},"label":"채점기준${i+1}","maxScore":${sc.max},"high":{"score":${sc.high},"description":""},"mid":{"score":${sc.mid},"description":""},"low":{"score":${sc.low},"description":""}}`).join(",\n");
  const answerJson=p.elements.map((_,i)=>`{"number":${i+1},"answer":""}`).join(",");
  return `다음 정보를 바탕으로 평가도구를 설계하십시오.\n\n`+
`[기본 정보]\n- 학년: ${ctx.grade}학년\n- 학기: ${ctx.semester||""}\n- 학년군: ${ctx.band}\n- 교과: ${s.subject}\n- 영역 표시명: ${ctx.area||""}\n- 단원명(차시): ${ctx.unit||""}\n- 성취기준: [${s.code}] ${s.text}\n- 성취수준 A: ${s.levels?.A||""}\n- 성취수준 B: ${s.levels?.B||""}\n- 성취수준 C: ${s.levels?.C||""}\n- 난이도: ${ctx.difficulty.label} (${ctx.difficulty.bloom})\n- 사용자 추가 요청: ${ctx.description||"없음"}\n\n`+
`[교육과정 맥락]\n${curriculumPrompt(ctx.curriculum)}\n\n`+
`[평가요소 ${count}개]\n${fixed}\n- 위에서 문구가 있는 평가요소는 그대로 사용하고, 빈칸만 성취기준에 근거하여 보완하십시오.\n`+
`- 평가요소 순서에 맞춰 문항도 ${count}개 작성하십시오.\n\n`+
`[배점]\n- 총점 ${p.total}점\n${p.elements.map((sc,i)=>`- 평가요소${i+1}: 최고 ${sc.max}점, 상 ${sc.high}점, 중 ${sc.mid}점, 하 ${sc.low}점`).join("\n")}\n\n`+
`[JSON 출력 구조]\n{\n`+
`  "meta":{"title":"","grade":"${ctx.grade}","semester":"${ctx.semester||""}","subject":"${s.subject}","area":"${ctx.area||""}","type":"서·논술형","unit":"${ctx.unit||""}","totalScore":${p.total}},\n`+
`  "standard":{"code":"${s.code}","text":"${escapeForPrompt(s.text)}","levels":{"A":"${escapeForPrompt(s.levels?.A)}","B":"${escapeForPrompt(s.levels?.B)}","C":"${escapeForPrompt(s.levels?.C)}"}},\n`+
`  "evaluationElements":[\n${elementJson}\n  ],\n`+
`  "evaluationTasks":[${Array.from({length:count},()=>`""`).join(",")}],\n`+
`  "cautions":["",""],\n`+
`  "items":[\n${itemsJson}\n  ],\n`+
`  "rubrics":[\n${rubricJson}\n  ],\n`+
`  "sampleAnswers":[${answerJson}],\n`+
`  "feedback":{"high":"","mid":"","low":""}\n}\n\n`+
`[작성 지침]\n- meta.title은 학기 정보가 있으면 '${ctx.grade}학년 ${ctx.semester||""} ${s.subject}과 서·논술형 평가' 형식으로 작성하십시오.\n`+
`- 평가요소는 짧고 관찰 가능한 명사형 구문으로 작성하십시오.\n`+
`- evaluationTasks는 '과제 1. ...' 형식으로 작성하십시오.\n`+
`- items의 intro는 자료 상황 소개, materialText는 학생에게 제시할 실제 자료, prompt는 학생이 답해야 할 발문입니다.\n`+
`- 마지막 문항은 가능하면 앞 문항의 정보를 종합하여 한 단계 높은 사고가 드러나게 구성하십시오.\n`+
`- rubrics는 실제 수행과 직접 연결하고 고정 점수를 변경하지 마십시오.\n`+
`- feedback은 전체 수행 수준에 대한 성장 피드백으로 작성하십시오.`;
}

function validateAssessment(result,scorePlan,count,fixedElements){
  if(!result||typeof result!=="object") throw new Error("생성 결과가 올바른 JSON 객체가 아닙니다.");
  for(const key of ["evaluationElements","items","rubrics","sampleAnswers"]) if(!Array.isArray(result[key])||result[key].length!==count) throw new Error(`${key}의 개수가 ${count}개가 아닙니다.`);
  result.meta=result.meta||{};result.meta.totalScore=scorePlan.total;
  result.evaluationTasks=Array.isArray(result.evaluationTasks)?result.evaluationTasks.slice(0,count):[];
  while(result.evaluationTasks.length<count) result.evaluationTasks.push("");
  for(let i=0;i<count;i++){
    const sc=scorePlan.elements[i];
    result.evaluationElements[i].index=i+1;result.evaluationElements[i].itemNumber=i+1;result.evaluationElements[i].maxScore=sc.max;
    if(fixedElements[i]) result.evaluationElements[i].name=fixedElements[i];
    result.items[i].number=i+1;result.items[i].elementIndex=i+1;result.items[i].score=sc.max;result.items[i].answerLines=Math.max(2,Math.min(7,Number(result.items[i].answerLines)||3));
    result.rubrics[i].elementIndex=i+1;result.rubrics[i].itemNumber=i+1;result.rubrics[i].maxScore=sc.max;
    result.rubrics[i].high={...(result.rubrics[i].high||{}),score:sc.high};result.rubrics[i].mid={...(result.rubrics[i].mid||{}),score:sc.mid};result.rubrics[i].low={...(result.rubrics[i].low||{}),score:sc.low};
    result.sampleAnswers[i].number=i+1;
  }
  return result;
}

async function callGemini(apiKey,model,prompt,{thinkingLevel="minimal",maxOutputTokens=5200}={}){
  const payload={system_instruction:{parts:[{text:systemPrompt()}]},contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{maxOutputTokens,responseMimeType:"application/json",thinkingConfig:{thinkingLevel}}};
  const response=await postJsonHttps(`${GEMINI_ENDPOINT}${encodeURIComponent(model)}:generateContent`,{"x-goog-api-key":apiKey},payload);
  if(!response.ok) throw new Error(response.data?.error?.message||`Gemini API 호출에 실패했습니다. HTTP ${response.status}`);
  const raw=extractGeminiText(response.data); if(!raw) throw new Error("Gemini 응답에서 생성 결과를 찾지 못했습니다.");
  try{return JSON.parse(stripJsonFence(raw));}catch{throw new Error("AI가 생성한 JSON 구조를 해석하지 못했습니다. 다시 시도해 주세요.");}
}

exports.handler=async function(event){
  if(event.httpMethod==="GET") return jsonResponse(200,{ok:true,hasApiKey:Boolean(process.env.GEMINI_API_KEY),basicModel:BASIC_MODEL,highQualityModel:HIGH_QUALITY_MODEL,version:"curriculum-context-v1"});
  if(event.httpMethod!=="POST") return jsonResponse(405,{error:"허용되지 않은 요청입니다."});
  const apiKey=process.env.GEMINI_API_KEY;if(!apiKey)return jsonResponse(500,{error:"Netlify 환경 변수 GEMINI_API_KEY가 설정되어 있지 않습니다."});
  let req;try{req=JSON.parse(event.body||"{}");}catch{return jsonResponse(400,{error:"요청 형식이 올바르지 않습니다."});}
  const grade=String(req.grade||""),band=String(req.band||""),standard=req.standard;
  if(!/^[1-6]$/.test(grade)||!band||!standard?.code||!standard?.text||!standard?.subject)return jsonResponse(400,{error:"학년·교과·성취기준 정보를 다시 선택해 주세요."});
  const count=Math.max(2,Math.min(4,Number(req.elementCount)||3));
  const fixedElements=Array.from({length:count},(_,i)=>cleanString(req.evaluationElements?.[i]||"").slice(0,160));
  const curriculum=sanitizeDeep(req.curriculum||{});
  try{
    if(req.action==="suggest-elements"){
      const result=await callGemini(apiKey,BASIC_MODEL,suggestPrompt({count,elements:fixedElements,standard,curriculum}),{thinkingLevel:"minimal",maxOutputTokens:1200});
      let elements=Array.isArray(result.elements)?result.elements.slice(0,count).map(cleanString):[];
      while(elements.length<count)elements.push("");
      for(let i=0;i<count;i++)if(fixedElements[i])elements[i]=fixedElements[i];
      return jsonResponse(200,{elements,model:BASIC_MODEL});
    }
    const difficultyKey=String(req.difficulty||"normal");const difficulty=DIFFICULTY[difficultyKey]||DIFFICULTY.normal;
    const qualityKey=req.quality==="high"?"high":"basic";const model=qualityKey==="high"?HIGH_QUALITY_MODEL:BASIC_MODEL;const qualityLabel=qualityKey==="high"?"고품질 생성":"기본 생성";const thinkingLevel=qualityKey==="high"?"medium":"minimal";
    const scorePlan=buildScorePlan(difficultyKey,count);
    const ctx={grade,band,standard,curriculum,count,elements:fixedElements,difficulty,scorePlan,semester:cleanString(req.semester),area:cleanString(req.area).slice(0,120),unit:cleanString(req.unit).slice(0,200),description:cleanString(req.description).slice(0,MAX_DESCRIPTION_LENGTH)};
    let assessment=await callGemini(apiKey,model,userPrompt(ctx),{thinkingLevel,maxOutputTokens:qualityKey==="high"?8500:6500});
    assessment=validateAssessment(sanitizeDeep(assessment),scorePlan,count,fixedElements);
    assessment.meta={...(assessment.meta||{}),grade,semester:ctx.semester,subject:standard.subject,area:ctx.area,type:"서·논술형",unit:ctx.unit,totalScore:scorePlan.total,difficulty:difficulty.label,generationQuality:qualityLabel,band,elementCount:count};
    assessment.standard={code:standard.code,text:standard.text,levels:{A:standard.levels?.A||"",B:standard.levels?.B||"",C:standard.levels?.C||""}};
    return jsonResponse(200,{assessment,model,quality:qualityKey,qualityLabel,thinkingLevel,scorePlan,grade,band,subject:standard.subject,code:standard.code});
  }catch(error){console.error("generate function error:",{message:error?.message,code:error?.code,stack:error?.stack});return jsonResponse(500,{error:error?.message||"AI 생성 중 오류가 발생했습니다."});}
};
