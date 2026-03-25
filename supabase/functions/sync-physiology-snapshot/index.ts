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

        const { days } = await req.json()
        const limit = days || 1

        // Resolve authenticated user for explicit user_id filtering
        const { data: { user }, error: authErr } = await supabaseClient.auth.getUser()
        if (authErr || !user) {
            return new Response(JSON.stringify({ error: 'unauthorized' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 401,
            })
        }
        const userId = user.id

        // Calculate start date
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - (limit + 1))
        const startDateStr = startDate.toISOString().split('T')[0]

        console.log(`[sync-physiology-snapshot] ${limit}d from ${startDateStr} for user ${userId.slice(0,8)}`)

        // Query daily_metrics with correct column names matching webhook schema
        // Webhook writes: garmin_user_id, day_date, resting_hr, hrv_rmssd, stress_avg, vo2max
        // Explicit user_id filter (defense in depth alongside RLS)
        const [metricsRes, sleepRes, physioRes, maxHRRes] = await Promise.all([
            supabaseClient
                .from('daily_metrics')
                .select('day_date, resting_hr, max_hr, hrv_rmssd, stress_avg, vo2max')
                .eq('user_id', userId)
                .gte('day_date', startDateStr)
                .order('day_date', { ascending: true }),

            supabaseClient
                .from('sleep_summaries')
                .select('calendar_date, overall_sleep_score, duration_sec, deep_sec, rem_sec, light_sec, awake_sec')
                .eq('user_id', userId)
                .gte('calendar_date', startDateStr),

            supabaseClient
                .from('physiology_snapshots')
                .select('calendar_date, vo2_max_running, lactate_threshold_pace, lt_heart_rate')
                .eq('user_id', userId)
                .gte('calendar_date', startDateStr),

            // All-time peak max HR across every stored activity (Garmin + Strava)
            supabaseClient
                .from('garmin_activities')
                .select('max_hr')
                .eq('user_id', userId)
                .not('max_hr', 'is', null)
                .order('max_hr', { ascending: false })
                .limit(1)
        ])

        // Individual table errors are non-fatal — log and continue with empty data
        if (metricsRes.error) console.warn('[sync-physiology-snapshot] daily_metrics error:', metricsRes.error.message)
        if (sleepRes.error) console.warn('[sync-physiology-snapshot] sleep_summaries error:', sleepRes.error.message)
        if (physioRes.error) console.warn('[sync-physiology-snapshot] physiology_snapshots error:', physioRes.error.message)
        // maxHRRes failure is non-fatal — just skip

        const metricsRows = metricsRes.error ? [] : (metricsRes.data || [])
        const sleepRows = sleepRes.error ? [] : (sleepRes.data || [])
        const physioRows = physioRes.error ? [] : (physioRes.data || [])

        console.log(`[sync-physiology-snapshot] Results: metrics=${metricsRows.length}, sleep=${sleepRows.length}, physio=${physioRows.length}`)

        // Merge by date — map DB column names to client-expected names
        const mergedData = new Map<string, any>()

        for (const m of metricsRows) {
            mergedData.set(m.day_date, {
                calendar_date: m.day_date,
                resting_hr: m.resting_hr,
                max_hr: m.max_hr,
                hrv_rmssd: m.hrv_rmssd,
                avg_stress_level: m.stress_avg,
                vo2max: m.vo2max,
            })
        }

        // Merge sleep
        for (const s of sleepRows) {
            const existing = mergedData.get(s.calendar_date) || { calendar_date: s.calendar_date }
            existing.sleep_score = s.overall_sleep_score
            existing.sleep_duration_sec = s.duration_sec ?? null
            existing.sleep_deep_sec = s.deep_sec ?? null
            existing.sleep_rem_sec = s.rem_sec ?? null
            existing.sleep_light_sec = s.light_sec ?? null
            existing.sleep_awake_sec = s.awake_sec ?? null
            mergedData.set(s.calendar_date, existing)
        }

        // Merge physio
        for (const p of physioRows) {
            const existing = mergedData.get(p.calendar_date) || { calendar_date: p.calendar_date }
            // Prefer vo2max from daily_metrics, fallback to physiology_snapshots
            if (!existing.vo2max && p.vo2_max_running) {
                existing.vo2max = p.vo2_max_running
            }
            existing.lt_pace_sec_km = p.lactate_threshold_pace
            existing.lt_heart_rate = p.lt_heart_rate ?? null
            mergedData.set(p.calendar_date, existing)
        }

        const mergedDays = Array.from(mergedData.values())
            .sort((a, b) => a.calendar_date.localeCompare(b.calendar_date))

        const allTimeMaxHR: number | null = maxHRRes.data?.[0]?.max_hr ?? null

        return new Response(JSON.stringify({ days: mergedDays, maxHR: allTimeMaxHR }), {
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
