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

        // Core columns — guaranteed to exist
        const { data, error } = await supabaseClient
            .from('garmin_activities')
            .select('garmin_id, activity_type, start_time, duration_sec, distance_m, avg_pace_sec_km, avg_hr, max_hr, calories, aerobic_effect, anaerobic_effect, garmin_rpe, itrimp, hr_zones, polyline')
            .gte('start_time', startDate.toISOString())
            .order('start_time', { ascending: false })

        if (error) throw error

        // Optional columns added via migrations — fetch separately so a missing column
        // doesn't kill the whole query.
        const garminIds = (data ?? []).map((r: any) => r.garmin_id)
        let extraData: Record<string, any> = {}
        if (garminIds.length > 0) {
            const { data: extra } = await supabaseClient
                .from('garmin_activities')
                .select('garmin_id, km_splits, elevation_gain_m, hr_drift, ambient_temp_c')
                .in('garmin_id', garminIds)
                .catch(() => ({ data: null }))
            for (const r of (extra ?? [])) {
                extraData[r.garmin_id] = r
            }
        }

        const allRows = (data ?? []).map((r: any) => {
            const ex = extraData[r.garmin_id] ?? {}
            return {
                ...r,
                iTrimp: r.itrimp ?? null,
                hrZones: r.hr_zones ?? null,
                kmSplits: ex.km_splits ?? null,
                elevationGainM: ex.elevation_gain_m ?? null,
                hrDrift: ex.hr_drift ?? null,
                ambientTempC: ex.ambient_temp_c ?? null,
            }
        })

        // Strava is canonical. Match Garmin rows against Strava rows by:
        // 1. Start time within ±4 hours (handles Garmin local-time vs Strava UTC offset)
        // 2. Duration within 15% (avoids false matches between different same-day sessions)
        // Suppress the Garmin row when a Strava match is found.
        const stravaRows = allRows.filter((r: any) => r.garmin_id.startsWith('strava-'))
        const rows = allRows.filter((r: any) => {
            if (r.garmin_id.startsWith('strava-')) return true
            const startMs = new Date(r.start_time).getTime()
            const dur = r.duration_sec ?? 0
            const hasStrava = stravaRows.some((sr: any) => {
                const timeDiff = Math.abs(startMs - new Date(sr.start_time).getTime())
                if (timeDiff > 4 * 60 * 60 * 1000) return false  // > 4 hours apart — different day
                if (dur > 0 && sr.duration_sec > 0) {
                    const durRatio = Math.abs(dur - sr.duration_sec) / Math.max(dur, sr.duration_sec)
                    return durRatio < 0.15  // durations within 15%
                }
                return timeDiff < 10 * 60 * 1000  // fallback: strict 10-min window
            })
            if (hasStrava) console.log(`[sync-activities] Suppressing Garmin ${r.garmin_id} — Strava counterpart exists`)
            return !hasStrava
        })

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
