import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function randomUrlSafe(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes).slice(0, length);
}

function base64url(buf: Uint8Array): string {
  const binStr = Array.from(buf, (b) => String.fromCharCode(b)).join("");
  return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(plain: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(digest);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, '');
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stravaClientId = Deno.env.get("STRAVA_CLIENT_ID")!;
    const stravaCallbackUrl = Deno.env.get("STRAVA_CALLBACK_URL") ?? `${supabaseUrl}/functions/v1/strava-auth-callback`;

    // Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonError(401, { error: "missing_auth_header" });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return jsonError(401, { error: "invalid_auth", details: userErr });
    }

    // Generate PKCE code_verifier + code_challenge
    const codeVerifier = randomUrlSafe(64);
    const hash = await sha256(codeVerifier);
    const codeChallenge = base64url(hash);

    // Generate state for CSRF protection
    const state = randomUrlSafe(32);

    // Persist ephemeral PKCE state
    const supabase = createClient(supabaseUrl, serviceKey);
    const { error: insertErr } = await supabase.from("strava_auth_requests").insert({
      user_id: user.id,
      state,
      code_verifier: codeVerifier,
    });

    if (insertErr) {
      return jsonError(500, { error: "db_insert_failed", details: insertErr });
    }

    // Build Strava OAuth2 authorize URL
    // Note: Strava does not support PKCE code_challenge yet — state provides CSRF protection.
    const params = new URLSearchParams({
      client_id: stravaClientId,
      response_type: "code",
      redirect_uri: stravaCallbackUrl,
      approval_prompt: "auto",
      scope: "activity:read_all,profile:read_all",
      state,
    });

    const url = `https://www.strava.com/oauth/authorize?${params.toString()}`;

    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonError(500, { error: String(e) });
  }
});
