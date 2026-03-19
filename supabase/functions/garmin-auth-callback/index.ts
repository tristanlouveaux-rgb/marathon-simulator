import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Garmin OAuth 2.0 token endpoint (from OAuth2PKCE spec)
const GARMIN_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

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
    const { data: row, error: selErr } = await supabase
      .from("garmin_auth_requests")
      .select("user_id, code_verifier")
      .eq("state", state)
      .maybeSingle();

    if (selErr || !row) {
      return new Response(JSON.stringify({ error: "invalid_state", details: selErr }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { user_id: userId, code_verifier: codeVerifier } = row;

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
      return new Response(JSON.stringify({ error: "token_exchange_failed", details: text }), {
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
      return new Response(
        JSON.stringify({ error: "no_access_token_in_response", raw: tokenJson }),
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
        raw: tokenJson,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (upsertErr) {
      return new Response(JSON.stringify({ error: "token_store_failed", details: upsertErr }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- 4. Clean up the pending auth request ---
    await supabase.from("garmin_auth_requests").delete().eq("state", state);

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

    // --- 6. Redirect back to the app ---
    return Response.redirect(`${appRedirectUrl}?garmin=connected`, 302);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
