// Small token exchange for the static workbench.
// GitHub's access-token endpoint does not allow browser CORS, and the
// client secret cannot live in the Pages site. Setup is in the README.
//
// Secrets (Worker environment, never the repo):
//   GITHUB_CLIENT_ID
//   GITHUB_CLIENT_SECRET

const ALLOWED_ORIGINS = new Set(["https://serinshen.github.io"]);
const REDIRECT_URI = "https://serinshen.github.io/bird-workbench/";

function corsHeaders(origin) {
  const headers = new Headers();
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  headers.set("Cache-Control", "no-store");
  return headers;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers });
    }
    if (!ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers });
    }
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ error: "server_not_configured" }), { status: 500, headers });
    }
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return new Response(JSON.stringify({ error: "bad_json" }), { status: 400, headers });
    }
    const path = new URL(request.url).pathname;
    let payload;
    if (path.endsWith("/refresh")) {
      payload = {
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: body.refresh_token,
      };
    } else {
      if (body.redirect_uri !== REDIRECT_URI) {
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify({ error: "bad_redirect" }), { status: 400, headers });
      }
      payload = {
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: body.code,
        redirect_uri: body.redirect_uri,
        code_verifier: body.code_verifier,
      };
    }
    const gh = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    headers.set("Content-Type", "application/json");
    return new Response(await gh.text(), { status: gh.status, headers });
  },
};
