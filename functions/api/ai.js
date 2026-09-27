/**
 * Proxies OpenAI-compatible chat completions to Gemini or OpenRouter.
 * Keys stay on the device — passed per request, never stored here.
 * Fixes browser CORS blocks on generativelanguage.googleapis.com.
 */

const UPSTREAM = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AI-Provider, HTTP-Referer, X-Title",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestPost(context) {
  const req = context.request;
  const headers = corsHeaders(req);
  try {
    const providerRaw = (req.headers.get("X-AI-Provider") || "gemini").toLowerCase().trim();
    const provider = providerRaw === "openrouter" ? "openrouter" : "gemini";
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ") || auth.length < 20) {
      return Response.json({ error: { message: "Missing API key" } }, { status: 401, headers });
    }
    const bodyText = await req.text();
    if (!bodyText) {
      return Response.json({ error: { message: "Empty body" } }, { status: 400, headers });
    }

    const upstreamHeaders = {
      Authorization: auth,
      "Content-Type": "application/json",
    };
    if (provider === "openrouter") {
      upstreamHeaders["HTTP-Referer"] = req.headers.get("HTTP-Referer") || "https://cut-tracker.pages.dev";
      upstreamHeaders["X-Title"] = req.headers.get("X-Title") || "KeJu Fit Tracker";
    }

    const upstream = await fetch(UPSTREAM[provider], {
      method: "POST",
      headers: upstreamHeaders,
      body: bodyText,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...headers,
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (err) {
    return Response.json(
      { error: { message: err?.message || "AI proxy failed" } },
      { status: 502, headers }
    );
  }
}
