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

  const attempts = [];
  let anthropicRes = await callAnthropic(env, payload, "apikey");
  attempts.push(`apikey=${anthropicRes.status}`);
  if (!anthropicRes.ok) {
    const second = await callAnthropic(env, payload, "bearer");
    attempts.push(`bearer=${second.status}`);
    anthropicRes = second;
  }

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
    if (request.method !== "POST" || url.pathname !== "/chat") {
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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runKakaoNotification(env));
  },
};
