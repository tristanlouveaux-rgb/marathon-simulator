import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

/**
 * Decide where to redirect the user after a successful OAuth handshake.
 * See identical implementation in `garmin-auth-callback/index.ts` for the
 * full rationale (multi-port dev support + open-redirect protection).
 */
function pickRedirectTarget(clientOrigin: string | null | undefined, envDefault: string): string {
  if (!clientOrigin) return envDefault;
  try {
    const u = new URL(clientOrigin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return clientOrigin;
    if (clientOrigin === envDefault) return clientOrigin;
    const envUrl = new URL(envDefault);
    if (u.hostname === envUrl.hostname) return clientOrigin;
  } catch { /* fall through */ }
  return envDefault;
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
      .select("user_id, code_verifier, app_origin")
      .eq("state", state)
      .maybeSingle();

    if (selErr || !row) {
      return new Response(JSON.stringify({ error: "invalid_state", details: selErr }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { user_id: userId, app_origin: clientOrigin } = row;
    const redirectTarget = pickRedirectTarget(clientOrigin, appRedirectUrl);

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
      console.error("[strava-auth-callback] token exchange failed:", tokenRes.status, text);
      return new Response(JSON.stringify({ error: "token_exchange_failed" }), {
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

    // Strava embeds a summary athlete in the token response. Capture the profile
    // fields we can use to pre-fill onboarding so the user doesn't re-enter them:
    //  - sex   ('M' | 'F')  → maps to biologicalSex
    //  - weight (kg, float) → maps to bodyWeightKg
    // Strava does NOT expose birthdate, so age is always asked in onboarding.
    const athleteId: number | null = tokenJson.athlete?.id ?? null;
    const athleteSex: string | null = tokenJson.athlete?.sex ?? null;
    const athleteWeightKg: number | null =
      typeof tokenJson.athlete?.weight === "number" ? tokenJson.athlete.weight : null;

    if (!accessToken) {
      // Do NOT echo tokenJson — on a partial/edge response it can still carry a
      // live refresh_token. Return the error code only (matches garmin-auth-callback).
      console.error("[strava-auth-callback] token response missing access_token");
      return new Response(
        JSON.stringify({ error: "no_access_token_in_response" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // 3. Persist tokens. deleted_at is explicitly cleared: a fresh OAuth on a
    //    previously retired account (claimed-from fork, or cancelled deletion)
    //    is a legitimate reconnect and must resurrect the row — otherwise the
    //    sync pipe (which skips soft-deleted tokens) would stay dead forever.
    const { error: upsertErr } = await supabase.from("strava_tokens").upsert(
      {
        user_id: userId,
        strava_athlete_id: athleteId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
        deleted_at: null,
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

    // 4b. Fork guard (ISSUE-270): the same Strava athlete may already have
    //     activity history under OTHER user accounts (anonymous-by-default auth
    //     forks on reinstall / device change). The completed OAuth handshake is
    //     proof this user controls the Strava account, so it is safe to tell
    //     them their own history exists. The client offers an import via the
    //     strava-claim-history function. Failures here must never break the
    //     OAuth flow — the guard degrades to "no hint".
    let existingCount = 0;
    if (athleteId != null) {
      try {
        const { data: priorTokens } = await supabase
          .from("strava_tokens")
          .select("user_id")
          .eq("strava_athlete_id", athleteId)
          .neq("user_id", userId)
          .is("deleted_at", null);
        const priorIds = (priorTokens ?? []).map((t: { user_id: string }) => t.user_id);
        if (priorIds.length > 0) {
          const { count } = await supabase
            .from("garmin_activities")
            .select("id", { count: "exact", head: true })
            .in("user_id", priorIds);
          existingCount = count ?? 0;
          if (existingCount > 0) {
            console.log(`[strava-auth-callback] fork guard: athlete ${athleteId} has ${existingCount} activities under ${priorIds.length} prior account(s)`);
          }
        }
      } catch (guardErr) {
        console.error("[strava-auth-callback] fork guard check failed (non-fatal)", guardErr);
      }
    }

    // 5. Redirect back to the app (origin-aware — see pickRedirectTarget).
    //    Pass the athlete's own sex/weight through the return URL so onboarding can
    //    pre-fill them. This is the user's own data on their own redirect, no DB
    //    column or extra fetch needed. about-you reads these off window.location.
    const redirectParams = new URLSearchParams({ strava: "connected" });
    if (athleteSex) redirectParams.set("sex", athleteSex);
    if (athleteWeightKg != null) redirectParams.set("weight", String(athleteWeightKg));
    if (existingCount > 0) redirectParams.set("existing", String(existingCount));
    return Response.redirect(`${redirectTarget}?${redirectParams.toString()}`, 302);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
