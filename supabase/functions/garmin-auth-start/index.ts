import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** JSON error response helper */
function jsonError(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Generate a cryptographically random string of `length` URL-safe chars */
function randomUrlSafe(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes).slice(0, length);
}

/** Raw bytes → base64url (no padding) */
function base64url(buf: Uint8Array): string {
  const binStr = Array.from(buf, (b) => String.fromCharCode(b)).join("");
  return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hash, returned as Uint8Array */
async function sha256(plain: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(digest);
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --- Environment ---
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const garminClientId = Deno.env.get("GARMIN_CLIENT_ID")!;
    const functionsBase = `${supabaseUrl}/functions/v1`;

    // --- 1. Authenticate caller via Supabase JWT ---
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

    // --- 1a. Optional appOrigin from request body — lets the callback redirect
    //         back to the origin that started the flow (multi-port dev). The
    //         callback validates it against an allowlist before using.
    let appOrigin: string | null = null;
    try {
      const body = await req.json().catch(() => null);
      if (body && typeof body.appOrigin === "string" && body.appOrigin.length < 256) {
        appOrigin = body.appOrigin;
      }
    } catch { /* body optional */ }

    // --- 2. Generate PKCE code_verifier + code_challenge ---
    const codeVerifier = randomUrlSafe(64);
    const hash = await sha256(codeVerifier);
    const codeChallenge = base64url(hash);

    // --- 3. Generate state for CSRF protection ---
    const state = randomUrlSafe(32);

    // --- 4. Persist { user_id, state, code_verifier, app_origin } for the callback ---
    const supabase = createClient(supabaseUrl, serviceKey);
    const { error: insertErr } = await supabase.from("garmin_auth_requests").insert({
      user_id: user.id,
      state,
      code_verifier: codeVerifier,
      app_origin: appOrigin,
    });

    if (insertErr) {
      return jsonError(500, { error: "db_insert_failed", details: insertErr });
    }

    // --- 5. Build Garmin OAuth2 authorize URL ---
    const params = new URLSearchParams({
      client_id: garminClientId,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: `${functionsBase}/garmin-auth-callback`,
      state,
    });

    const url = `https://connect.garmin.com/oauth2Confirm?${params.toString()}`;

    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonError(500, { error: String(e) });
  }
});
