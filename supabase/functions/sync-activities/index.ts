import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
        )

        const { since } = await req.json()
        const startDate = since ? new Date(since) : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

        // Query garmin_activities with correct column names matching webhook schema
        const { data, error } = await supabaseClient
            .from('garmin_activities')
            .select('garmin_id, activity_type, start_time, duration_sec, distance_m, avg_pace_sec_km, avg_hr, max_hr, calories, aerobic_effect, anaerobic_effect, garmin_rpe, itrimp, hr_zones')
            .gte('start_time', startDate.toISOString())
            .order('start_time', { ascending: false })

        if (error) throw error

        // Map DB snake_case columns to the camelCase fields expected by GarminActivityRow
        const rows = (data ?? []).map((r: any) => ({
            ...r,
            iTrimp: r.itrimp ?? null,
            hrZones: r.hr_zones ?? null,
        }))

        return new Response(JSON.stringify(rows), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        })
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
