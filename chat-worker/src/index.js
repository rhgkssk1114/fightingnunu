const ALLOWED_ORIGIN = "https://rhgkssk1114.github.io";
const MODEL = "claude-haiku-4-5";
const MAX_JOBS_IN_CONTEXT = 80;
const JOBS_URL = "https://rhgkssk1114.github.io/fightingnunu/jobs.json";
const SITE_URL = "https://rhgkssk1114.github.io/fightingnunu/";
const KAKAO_REDIRECT_URI = "https://job-radar-chat.rhgkssk1114.workers.dev/kakao/callback";

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function buildSystemPrompt(jobs) {
  const compact = jobs.slice(0, MAX_JOBS_IN_CONTEXT).map((j) => ({
    site: j.site,
    title: j.title,
    company: j.company,
    location: j.location || j.condition || "",
    dday: j.dday,
    new: j.is_new,
    link: j.link,
  }));

  return [
    "당신은 '공고 레이더'라는 채용공고 대시보드에 내장된 도우미예요. 사용자 이름은 건우이고, 전기전자 제어 / 회로설계 2~3년 + 생산관리 1년 3개월 경력으로 서울·경기 지역 정규직 일자리를 찾고 있어요.",
    "아래 JOBS는 오늘 사이트에 올라온 공고 목록(JSON)이에요. 사용자가 공고를 추천해달라거나, 조건으로 찾아달라거나, 공고에 대해 물어보면 이 목록 안에서만 답하세요. 목록에 없는 내용은 지어내지 말고 모른다고 하세요.",
    "답변은 한국어로, 짧고 친근하게, 모바일 채팅 화면에 맞게 핵심만 말해주세요. 공고를 추천할 때는 회사명 · 직무 · 지원 링크(markdown 링크 형식 말고 그냥 URL 텍스트)를 같이 보여주세요.",
    "건우가 지치지 않게 가끔 짧은 응원 한마디를 섞어도 좋아요, 단 과하지 않게.",
    "",
    "JOBS:",
    JSON.stringify(compact),
  ].join("\n");
}

async function callAnthropic(env, payload, mode) {
  const headers =
    mode === "bearer"
      ? {
          "content-type": "application/json",
          "authorization": `Bearer ${env.ANTHROPIC_API_KEY}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        }
      : {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        };

  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

// apikey 헤더가 막히면 bearer로 한 번 더 시도 (이 계정에서 관찰된 증상에 대한 방어 코드)
async function callAnthropicWithFallback(env, payload) {
  const attempts = [];
  let res = await callAnthropic(env, payload, "apikey");
  attempts.push(`apikey=${res.status}`);
  if (!res.ok) {
    const second = await callAnthropic(env, payload, "bearer");
    attempts.push(`bearer=${second.status}`);
    res = second;
  }
  return { res, attempts };
}

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  const message = (body.message || "").toString().slice(0, 1000);
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

  if (!message.trim()) {
    return new Response(JSON.stringify({ error: "empty_message" }), { status: 400 });
  }

  const messages = [
    ...history.map((h) => ({ role: h.role === "me" ? "user" : "assistant", content: String(h.content || "").slice(0, 2000) })),
    { role: "user", content: message },
  ];

  const payload = {
    model: MODEL,
    max_tokens: 600,
    system: buildSystemPrompt(jobs),
    messages,
  };

  const { res: anthropicRes, attempts } = await callAnthropicWithFallback(env, payload);

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: "upstream_error", attempts, detail: errText.slice(0, 500) }), {
      status: 502,
    });
  }

  const data = await anthropicRes.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return new Response(JSON.stringify({ reply: text || "음, 지금은 답을 못 찾았어요. 다시 물어봐줄래요?" }), {
    headers: { "content-type": "application/json" },
  });
}

// ---------------- 자소서 기반 이력서/포트폴리오/자기소개서/면접 준비 생성 ----------------

const DOC_TYPE_LABELS = {
  cover_letter: "자기소개서",
  resume: "이력서",
  portfolio: "포트폴리오",
  interview: "예상 면접 질문·답변",
};

const CORE_WRITING_RULES = [
  "모든 경험 서술은 STAR(Situation-Task-Action-Result) 구조로 재구성한다. 상황/과제를 한두 문장으로 압축하고, 행동과 결과에 가장 많은 분량을 쓴다.",
  "'열심히', '최선을 다해', '함께 성장', '열정적으로', '책임감을 가지고', '소통을 중요시' 같은 상투적 표현은 절대 쓰지 않는다. 그 자리에는 구체적인 행동과 수치를 쓴다.",
  "입력된 경험 데이터에 없는 수치나 성과를 지어내지 않는다. 사용자가 수치를 안 줬으면 '[구체적 수치 입력]'처럼 괄호로 빈칸을 남겨서 본인이 채우게 한다.",
  "문단은 두괄식으로 쓴다 — 핵심 역량이나 결론을 첫 문장에 제시하고, 그다음에 근거(STAR)를 댄다.",
  "AI가 쓴 것처럼 매끄럽고 평면적인 문장을 피한다. 문장 길이에 변화를 주고, 담백하게 끊어 쓰고, 과한 수식어나 비유를 쓰지 않는다. '또한', '그리고', '뿐만 아니라' 같은 접속사를 문단마다 반복하지 않는다.",
  "입력된 기술 스택과 자격증은 각 경험에 자연스럽게 녹여서 언급한다 (나열하지 말고, 그 기술을 '어떻게' 써서 '무엇을' 해냈는지로 풀어낸다).",
  "지원 직무가 지금까지의 경력과 다른 분야라면, 억지로 끼워 맞추지 말고 실제로 전이 가능한 기술적 역량(예: 회로설계 경험 → 전기 시스템 이해, 생산관리 경험 → 공정 데이터 기반 문제해결, 품질관리 경험 → 원인분석/트러블슈팅)을 구체적으로 짚어서 자연스럽게 연결한다.",
  "마지막 문단에는 입사 후 이 역량으로 구체적으로 어떻게 기여할지를 한 문단으로 명확히 제시한다.",
].join("\n- ");

function buildGenerateSystemPrompt(docType, targetInfo) {
  const label = DOC_TYPE_LABELS[docType] || "자기소개서";
  const header = [
    `당신은 건우의 ${label} 작성을 돕는 전문 커리어 라이터예요.`,
    "건우는 전기전자 제어 / 회로설계 2~3년 + 생산관리 1년 3개월 경력이고, 서울·경기 지역 정규직을 찾고 있어요.",
    targetInfo ? `지원 대상 공고/직무 정보:\n${targetInfo}` : "지원 대상 공고 정보는 따로 주어지지 않았어요 — 사용자가 준 경험 데이터 안의 기술/직무 키워드를 기준으로 일반적인 지원 직무를 유추해서 쓰세요.",
    "",
    "작성 기준 (전부 반드시 지킬 것):",
    "- " + CORE_WRITING_RULES,
  ];

  const typeSpecific = {
    cover_letter: [
      "",
      "출력 형식: 자기소개서 항목 초안.",
      "- 입력된 경험 데이터를 바탕으로 1~3개 항목(지원동기/직무역량/입사 후 포부 등)으로 나눠서 각 항목을 두괄식 문단으로 작성한다.",
      "- 항목당 400~700자 내외. 분량을 억지로 늘리지 않는다.",
      "- 마지막 항목은 반드시 '직무 기여 방안'으로 마무리한다.",
    ],
    resume: [
      "",
      "출력 형식: 이력서.",
      "- 기본정보 / 핵심 역량 요약(3줄) / 경력(STAR 기반, 회사·기간·역할·성과 bullet) / 기술 스택 / 자격증·어학 / 학력 순서의 마크다운 구조로 작성한다.",
      "- 경력 bullet은 '행동 동사로 시작 + 구체적 수치/기술'로 한 줄씩, 가독성 있게 짧게 끊어 쓴다.",
      "- 과장하지 않고 입력된 사실 기반으로만 작성한다.",
    ],
    portfolio: [
      "",
      "출력 형식: 포트폴리오.",
      "- 프로젝트 단위로 구성: [프로젝트명 / 기간 / 역할] → Situation·Task(1~2줄) → Action(사용 기술을 구체적으로 명시) → Result(정량 성과, 없으면 빈칸 표시).",
      "- 프로젝트마다 '사용 기술' 줄을 따로 빼서 스캔하기 쉽게 한다.",
      "- 프로젝트가 여러 개면 지원 직무와 관련성이 높은 순서로 배치한다.",
    ],
    interview: [
      "",
      "출력 형식: 예상 면접 질문 + 모범답변 초안.",
      "- 입력된 경험과 지원 직무를 바탕으로 예상 질문 8개를 뽑는다 (직무역량 3~4개, 경험 검증형 3~4개, 전환 커리어 관련 1~2개).",
      "- 각 질문마다 STAR 기반 모범답변 초안(3~5문장)과, 면접관이 할 법한 꼬리질문 1개를 같이 적는다.",
    ],
  };

  return header.concat(typeSpecific[docType] || typeSpecific.cover_letter).join("\n");
}

async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  const docType = DOC_TYPE_LABELS[body.docType] ? body.docType : "cover_letter";
  const experience = (body.experience || "").toString().slice(0, 6000);
  const targetInfo = (body.targetInfo || "").toString().slice(0, 1000);

  if (!experience.trim()) {
    return new Response(JSON.stringify({ error: "empty_experience" }), { status: 400 });
  }

  const payload = {
    model: "claude-opus-5",
    max_tokens: 3000,
    system: buildGenerateSystemPrompt(docType, targetInfo),
    messages: [{ role: "user", content: `경험 데이터:\n${experience}` }],
  };

  const { res: anthropicRes, attempts } = await callAnthropicWithFallback(env, payload);

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: "upstream_error", attempts, detail: errText.slice(0, 500) }), {
      status: 502,
    });
  }

  const data = await anthropicRes.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return new Response(JSON.stringify({ result: text, docType }), {
    headers: { "content-type": "application/json" },
  });
}

// ---------------- 카카오톡 "나에게 보내기" ----------------

async function kakaoTokenRequest(env, params) {
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function handleKakaoCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) {
    return new Response(`카카오 로그인 거부/오류: ${err}`, { status: 400 });
  }
  if (!code) {
    return new Response("code 파라미터가 없어요.", { status: 400 });
  }

  const { ok, data } = await kakaoTokenRequest(env, {
    grant_type: "authorization_code",
    client_id: env.KAKAO_REST_API_KEY,
    redirect_uri: KAKAO_REDIRECT_URI,
    code,
  });

  if (!ok || !data.refresh_token) {
    return new Response("토큰 교환 실패: " + JSON.stringify(data), { status: 502 });
  }

  const body = [
    "카카오 연동 성공! 아래 refresh_token을 복사해서",
    "터미널에서 이 명령으로 등록해주세요:",
    "",
    "  npx wrangler secret put KAKAO_REFRESH_TOKEN",
    "",
    "refresh_token (이 값을 복사):",
    data.refresh_token,
    "",
    "등록 후 이 페이지는 다시 안 쓰셔도 돼요.",
  ].join("\n");

  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function refreshKakaoAccessToken(env) {
  const { ok, data } = await kakaoTokenRequest(env, {
    grant_type: "refresh_token",
    client_id: env.KAKAO_REST_API_KEY,
    refresh_token: env.KAKAO_REFRESH_TOKEN,
  });
  if (!ok || !data.access_token) {
    throw new Error("카카오 액세스 토큰 갱신 실패: " + JSON.stringify(data));
  }
  return data.access_token;
}

async function buildDailySummaryText() {
  const res = await fetch(JOBS_URL, { cf: { cacheTtl: 0 } });
  const data = await res.json();
  const jobs = data.jobs || [];
  const urgent = jobs.filter((j) => j.urgent).slice(0, 3);

  let text = `[공고 레이더] ${data.updated_at_display || ""}\n`;
  text += `전체 ${data.total}건 · 신규 ${data.new_count}건 · 마감임박 ${data.urgent_count}건`;
  if (urgent.length) {
    text += "\n\n마감임박 공고:\n" + urgent.map((j) => `· ${j.title} (D-${j.dday})`).join("\n");
  }
  return text;
}

async function sendKakaoMemo(accessToken, text) {
  const templateObject = {
    object_type: "text",
    text,
    link: { web_url: SITE_URL, mobile_web_url: SITE_URL },
    button_title: "공고 보기",
  };
  return fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ template_object: JSON.stringify(templateObject) }).toString(),
  });
}

async function runKakaoNotification(env) {
  const accessToken = await refreshKakaoAccessToken(env);
  const text = await buildDailySummaryText();
  const res = await sendKakaoMemo(accessToken, text);
  const resultText = await res.text();
  return { ok: res.ok, status: res.status, body: resultText, sentText: text };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (url.pathname === "/kakao/callback" && request.method === "GET") {
      return handleKakaoCallback(request, env);
    }

    if (url.pathname === "/kakao/test" && request.method === "GET") {
      try {
        const result = await runKakaoNotification(env);
        return new Response(JSON.stringify(result, null, 2), {
          status: result.ok ? 200 : 502,
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
      }
    }

    const headers = corsHeaders(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const routes = { "/chat": handleChat, "/generate": handleGenerate };
    const handler = request.method === "POST" ? routes[url.pathname] : null;
    if (!handler) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });
    }

    try {
      const res = await handler(request, env);
      const merged = new Headers(res.headers);
      Object.entries(headers).forEach(([k, v]) => merged.set(k, v));
      return new Response(res.body, { status: res.status, headers: merged });
    } catch (err) {
      return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), {
        status: 500,
        headers,
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runKakaoNotification(env));
  },
};
