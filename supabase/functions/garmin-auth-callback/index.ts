import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Garmin OAuth 2.0 token endpoint (from OAuth2PKCE spec)
const GARMIN_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

/**
 * Decide where to redirect the user after a successful OAuth handshake.
 *
 * If the client passed an origin via the auth-start request body (used for
 * multi-port dev — e.g. running localhost:5173 alongside localhost:5175 for
 * onboarding tests) and that origin passes the allowlist, redirect there.
 * Otherwise fall back to the env-default `APP_REDIRECT_URL`.
 *
 * Allowlist policy (open-redirect protection):
 *   - Native app deep-link return schemes (exact match, NATIVE_RETURN_ALLOWLIST).
 *   - Any localhost / 127.0.0.1 origin (dev — any port allowed).
 *   - The configured production URL exactly.
 *   - Anything else → reject and use the env-default.
 */
const NATIVE_RETURN_ALLOWLIST = ["mosaic://oauth"];

function pickRedirectTarget(clientOrigin: string | null | undefined, envDefault: string): string {
  if (!clientOrigin) return envDefault;
  if (NATIVE_RETURN_ALLOWLIST.includes(clientOrigin)) return clientOrigin;
  try {
    const u = new URL(clientOrigin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return clientOrigin;
    if (clientOrigin === envDefault) return clientOrigin;
    // Allow same-host as env default (e.g. preview deploys on the prod domain).
    const envUrl = new URL(envDefault);
    if (u.hostname === envUrl.hostname) return clientOrigin;
  } catch { /* fall through */ }
  return envDefault;
}

/**
 * Issue the post-success redirect. Custom app schemes (mosaic://oauth) go via a
 * manual Location header — Deno's Response.redirect validates the URL and can
 * reject a non-http(s) scheme. http/https origins keep Response.redirect.
 */
function successRedirect(redirectTarget: string, params: URLSearchParams): Response {
  const location = `${redirectTarget}?${params.toString()}`;
  // Native iOS uses ASWebAuthenticationSession (the @mosaic/web-auth plugin),
  // which intercepts the FIRST mosaic:// URL — including this 302 redirect
  // target — and hands it back to JS. So a plain 302 to the custom scheme is
  // correct. (Response.redirect rejects non-http(s) schemes, hence the manual
  // Location header for mosaic://.)
  return redirectTarget.startsWith("mosaic://")
    ? new Response(null, { status: 302, headers: { Location: location } })
    : Response.redirect(location, 302);
}

/**
 * Human-facing fallback page. The callback can be re-hit by an in-app browser
 * (SFSafariViewController re-requesting after a `mosaic://` redirect it cannot
 * follow) or a manual reload; raw JSON in that sheet reads as a hard failure.
 */
function htmlNotice(title: string, body: string, status = 400): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mosaic</title>
<style>
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       color:#1a1a1a;background:#fafafa;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{max-width:340px;padding:28px 24px;text-align:center}
  h1{font-size:18px;font-weight:600;margin:0 0 10px}
  p{margin:0 0 20px;color:#555}
  a{display:inline-block;padding:11px 20px;border:1px solid #d0d0d0;border-radius:10px;
    color:#1a1a1a;text-decoration:none;font-weight:500}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p>
<a href="mosaic://oauth">Return to Mosaic</a></div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const garminError = url.searchParams.get("error");

    if (garminError) {
      return new Response(JSON.stringify({ error: "garmin_auth_error", details: garminError }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!code || !state) {
      return new Response(JSON.stringify({ error: "missing_code_or_state" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const garminClientId = Deno.env.get("GARMIN_CLIENT_ID")!;
    const garminClientSecret =
      Deno.env.get("GARMIN_CLIENT_SECRET") ??
      Deno.env.get("Garmin_client_secret");
    const functionsBase = `${supabaseUrl}/functions/v1`;
    const appRedirectUrl = Deno.env.get("APP_REDIRECT_URL") ?? "http://localhost:5173";

    const supabase = createClient(supabaseUrl, serviceKey);

    // --- 1. Look up the pending auth request ---
    const { data: row } = await supabase
      .from("garmin_auth_requests")
      .select("user_id, app_origin, consumed_at")
      .eq("state", state)
      .maybeSingle();

    // No row at all: expired (purged after an hour) or never ours. Show a human
    // page, not raw JSON, with a deep link back into the app.
    if (!row) {
      return htmlNotice(
        "Link expired",
        "This Garmin sign-in link is no longer valid. Return to Mosaic and tap Connect again. If it already worked, you'll see Garmin connected.",
      );
    }

    // Pick the redirect target. If the client passed its origin (multi-port
    // dev) and it's allowed, use that — otherwise fall back to the env-default.
    const redirectTarget = pickRedirectTarget(row.app_origin, appRedirectUrl);

    // Already consumed: a duplicate callback hit (in-app browser re-request or
    // reload). The first run stored the token; replay the success redirect. The
    // single-use Garmin `code` must NOT be re-exchanged — it would fail.
    if (row.consumed_at) {
      return successRedirect(redirectTarget, new URLSearchParams({ garmin: "connected" }));
    }

    // Atomically claim the row so two near-simultaneous hits can't both run the
    // token exchange. Only the request that flips consumed_at from null proceeds.
    const { data: claimed } = await supabase
      .from("garmin_auth_requests")
      .update({ consumed_at: new Date().toISOString() })
      .eq("state", state)
      .is("consumed_at", null)
      .select("user_id, code_verifier")
      .maybeSingle();

    if (!claimed) {
      return successRedirect(redirectTarget, new URLSearchParams({ garmin: "connected" }));
    }

    const userId = claimed.user_id;
    const codeVerifier = claimed.code_verifier;

    // --- 2. Exchange authorization code for tokens ---
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: garminClientId,
      redirect_uri: `${functionsBase}/garmin-auth-callback`,
      code,
      code_verifier: codeVerifier,
    });

    if (garminClientSecret) {
      tokenBody.set("client_secret", garminClientSecret);
    }

    const tokenRes = await fetch(GARMIN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("[garmin-auth-callback] token exchange failed:", tokenRes.status, text);
      return new Response(JSON.stringify({ error: "token_exchange_failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const tokenJson = await tokenRes.json();

    const accessToken: string = tokenJson.access_token;
    const refreshToken: string | null = tokenJson.refresh_token ?? null;
    const expiresIn: number | null = tokenJson.expires_in ?? null;
    const tokenType: string | null = tokenJson.token_type ?? null;

    if (!accessToken) {
      console.error("[garmin-auth-callback] no access_token in token response");
      return new Response(
        JSON.stringify({ error: "no_access_token_in_response" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // --- 3. Persist tokens ---
    const { error: upsertErr } = await supabase.from("garmin_tokens").upsert(
      {
        user_id: userId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_type: tokenType,
        // Store only non-credential metadata in `raw` (tokens already live in
        // their own columns; no need to duplicate them in a catch-all blob).
        raw: { token_type: tokenType, scope: tokenJson.scope ?? null, expires_in: expiresIn },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (upsertErr) {
      console.error("[garmin-auth-callback] token store failed:", upsertErr);
      return new Response(JSON.stringify({ error: "token_store_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- 4. The row stays (now marked consumed_at) so a duplicate callback hit
    //        replays into the success redirect instead of erroring. Purge old
    //        consumed rows opportunistically so the table doesn't grow. ---
    const purgeBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await supabase
      .from("garmin_auth_requests")
      .delete()
      .lt("consumed_at", purgeBefore)
      .then(() => {}, () => {});

    // --- 5. Fetch Garmin user ID + check permissions ---
    // OAuth2 PKCE: user registration for push is automatic after consent.
    // The only registration endpoint is DELETE (for disconnecting).
    // We just need to fetch the user ID and verify permissions.
    try {
      // Fetch and store the stable Garmin user ID
      const idRes = await fetch("https://apis.garmin.com/wellness-api/rest/user/id", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      if (idRes.ok) {
        const idJson = await idRes.json();
        const garminUserId = idJson.userId;
        if (garminUserId) {
          await supabase.from("garmin_tokens").update({ garmin_user_id: garminUserId }).eq("user_id", userId);
          console.log("[garmin-auth-callback] Garmin user ID stored:", garminUserId);
        }
      } else {
        console.error("[garmin-auth-callback] Failed to fetch user ID:", idRes.status, await idRes.text());
      }

      // Check what permissions Garmin granted — logs whether HEALTH_EXPORT is present
      const permRes = await fetch("https://apis.garmin.com/wellness-api/rest/user/permissions", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      if (permRes.ok) {
        const perms = await permRes.json();
        console.log("[garmin-auth-callback] User permissions:", JSON.stringify(perms));
      } else {
        console.error("[garmin-auth-callback] Permissions check failed:", permRes.status, await permRes.text());
      }
    } catch (regErr) {
      console.error("[garmin-auth-callback] Post-auth error:", regErr);
    }

    // --- 6. Redirect back to the app (origin-aware — see pickRedirectTarget) ---
    return successRedirect(redirectTarget, new URLSearchParams({ garmin: "connected" }));
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
