import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// ─── CORS ───────────────────────────────────────────────────────────────────
// Exact-match production origins + any localhost port for local dev. Avoids the
// startsWith() over-match (e.g. http://localhost.evil.com) flagged in review.
const ALLOWED_ORIGINS = ['capacitor://localhost', 'https://mosaicrunning.run']
function isAllowedOrigin(origin: string): boolean {
    return ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}
function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('Origin') ?? ''
    return {
        'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin',
    }
}

serve(async (req) => {
    const cors = corsHeaders(req)
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: cors })
    }

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
        )

        // Explicit auth check — derive the user from the verified JWT and scope
        // the query to their rows, rather than relying on RLS alone.
        const { data: userData, error: authErr } = await supabaseClient.auth.getUser()
        if (authErr || !userData?.user?.id) {
            return new Response(JSON.stringify({ error: 'unauthorized' }), {
                headers: { ...cors, 'Content-Type': 'application/json' },
                status: 401,
            })
        }
        const userId = userData.user.id

        const { garmin_ids } = await req.json()

        if (!garmin_ids || !Array.isArray(garmin_ids) || garmin_ids.length === 0) {
            return new Response(JSON.stringify([]), {
                headers: { ...cors, 'Content-Type': 'application/json' },
                status: 200,
            })
        }

        // Query activity_details — RLS already scopes to auth.uid(); the explicit
        // user_id filter is belt-and-braces in case RLS is ever loosened.
        const { data, error } = await supabaseClient
            .from('activity_details')
            .select('garmin_id, json_data')
            .eq('user_id', userId)
            .in('garmin_id', garmin_ids)

        if (error) throw error

        // Transform to client shape: { garmin_id: string, raw: { laps: ... } }
        const rows = data.map((d: any) => ({
            garmin_id: d.garmin_id,
            raw: d.json_data // Assuming json_data contains the full object including 'laps'
        }))

        return new Response(JSON.stringify(rows), {
            headers: { ...cors, 'Content-Type': 'application/json' },
            status: 200,
        })
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
