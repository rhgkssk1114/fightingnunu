const ALLOWED_ORIGIN = "https://rhgkssk1114.github.io";
const MODEL = "claude-haiku-4-5";
const MAX_JOBS_IN_CONTEXT = 80;

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

  // sk-ant-api03-... 키는 x-api-key, 다른 발급 형태는 Authorization: Bearer 를 요구하는 경우가 있어
  // 첫 시도가 거부되면 다른 인증 방식으로 한 번 더 시도한다.
  let anthropicRes = await callAnthropic(env, payload, "apikey");
  if (anthropicRes.status === 403) {
    anthropicRes = await callAnthropic(env, payload, "bearer");
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: "upstream_error", detail: errText.slice(0, 500) }), {
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (request.method !== "POST" || new URL(request.url).pathname !== "/chat") {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });
    }

    try {
      const res = await handleChat(request, env);
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
};
