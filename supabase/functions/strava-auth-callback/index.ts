import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

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
    const stravaError = url.searchParams.get("error");

    if (stravaError) {
      return new Response(JSON.stringify({ error: "strava_auth_error", details: stravaError }), {
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, '');
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stravaClientId = Deno.env.get("STRAVA_CLIENT_ID")!;
    const stravaClientSecret = Deno.env.get("STRAVA_CLIENT_SECRET")!;
    const stravaCallbackUrl = Deno.env.get("STRAVA_CALLBACK_URL") ?? `${supabaseUrl}/functions/v1/strava-auth-callback`;
    const appRedirectUrl = Deno.env.get("APP_REDIRECT_URL") ?? "http://localhost:5173";

    const supabase = createClient(supabaseUrl, serviceKey);

    // 1. Look up the pending auth request
    const { data: row, error: selErr } = await supabase
      .from("strava_auth_requests")
      .select("user_id, code_verifier")
      .eq("state", state)
      .maybeSingle();

    if (selErr || !row) {
      return new Response(JSON.stringify({ error: "invalid_state", details: selErr }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { user_id: userId } = row;

    // 2. Exchange authorization code for tokens
    const tokenBody = new URLSearchParams({
      client_id: stravaClientId,
      client_secret: stravaClientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: stravaCallbackUrl,
    });

    const tokenRes = await fetch(STRAVA_TOKEN_URL, {
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
    const expiresAt: string | null = tokenJson.expires_at
      ? new Date(tokenJson.expires_at * 1000).toISOString()
      : null;

    // Strava embeds athlete in the token response
    const athleteId: number | null = tokenJson.athlete?.id ?? null;

    if (!accessToken) {
      return new Response(
        JSON.stringify({ error: "no_access_token_in_response", raw: tokenJson }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // 3. Persist tokens
    const { error: upsertErr } = await supabase.from("strava_tokens").upsert(
      {
        user_id: userId,
        strava_athlete_id: athleteId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
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

    // 4. Clean up ephemeral auth request
    await supabase.from("strava_auth_requests").delete().eq("state", state);

    console.log("[strava-auth-callback] Strava connected for user", userId, "athlete_id", athleteId);

    // 5. Redirect back to the app
    return Response.redirect(`${appRedirectUrl}?strava=connected`, 302);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
