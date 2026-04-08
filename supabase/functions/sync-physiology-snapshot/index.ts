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
        const [metricsRes, sleepRes, physioRes, latestPhysioRes, maxHRRes] = await Promise.all([
            supabaseClient
                .from('daily_metrics')
                .select('day_date, resting_hr, max_hr, hrv_rmssd, stress_avg, vo2max, steps, active_calories, active_minutes, highly_active_minutes')
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

            // Latest physiology snapshot regardless of date — LT and VO2max from Garmin
            // are pushed infrequently (only when values change), so the most recent row
            // may be older than the daily metrics date window.
            supabaseClient
                .from('physiology_snapshots')
                .select('calendar_date, vo2_max_running, lactate_threshold_pace, lt_heart_rate')
                .eq('user_id', userId)
                .order('calendar_date', { ascending: false })
                .limit(1),

            // Robust max HR: 95th percentile of all activity max HRs.
            // Wrist sensors produce spikes; percentile filters them automatically.
            supabaseClient
                .from('garmin_activities')
                .select('max_hr')
                .eq('user_id', userId)
                .not('max_hr', 'is', null)
        ])

        // Individual table errors are non-fatal — log and continue with empty data
        if (metricsRes.error) console.warn('[sync-physiology-snapshot] daily_metrics error:', metricsRes.error.message)
        if (sleepRes.error) console.warn('[sync-physiology-snapshot] sleep_summaries error:', sleepRes.error.message)
        if (physioRes.error) console.warn('[sync-physiology-snapshot] physiology_snapshots error:', physioRes.error.message)
        if (latestPhysioRes.error) console.warn('[sync-physiology-snapshot] latestPhysio error:', latestPhysioRes.error.message)
        // maxHRRes failure is non-fatal — just skip

        const metricsRows = metricsRes.error ? [] : (metricsRes.data || [])
        const sleepRows = sleepRes.error ? [] : (sleepRes.data || [])
        const physioRows = physioRes.error ? [] : (physioRes.data || [])
        const latestPhysioRow = (!latestPhysioRes.error && latestPhysioRes.data?.[0]) ? latestPhysioRes.data[0] : null

        console.log(`[sync-physiology-snapshot] Results: metrics=${metricsRows.length}, sleep=${sleepRows.length}, physio=${physioRows.length}, latestPhysio=${latestPhysioRow ? latestPhysioRow.calendar_date : 'none'}`)

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
                steps: m.steps ?? null,
                active_calories: m.active_calories ?? null,
                active_minutes: m.active_minutes ?? null,
                highly_active_minutes: m.highly_active_minutes ?? null,
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

        // Robust max HR: 95th percentile of all activity max HRs (filters wrist-sensor spikes)
        const allMaxHRs = (maxHRRes.data ?? []).map((r: any) => r.max_hr as number).filter(v => v > 0)
        let allTimeMaxHR: number | null = null
        if (allMaxHRs.length >= 5) {
            allMaxHRs.sort((a: number, b: number) => a - b)
            const p95Idx = Math.floor(allMaxHRs.length * 0.95)
            allTimeMaxHR = allMaxHRs[Math.min(p95Idx, allMaxHRs.length - 1)]
        } else if (allMaxHRs.length > 0) {
            allMaxHRs.sort((a: number, b: number) => a - b)
            allTimeMaxHR = allMaxHRs[Math.floor(allMaxHRs.length / 2)]
        }

        // Include the latest physiology row (potentially older than the date window)
        // so the client can use it for LT/VO2 even if Garmin hasn't pushed recently
        const latestPhysio = latestPhysioRow ? {
            calendar_date: latestPhysioRow.calendar_date,
            vo2_max_running: latestPhysioRow.vo2_max_running,
            lactate_threshold_pace: latestPhysioRow.lactate_threshold_pace,
            lt_heart_rate: latestPhysioRow.lt_heart_rate,
        } : null

        return new Response(JSON.stringify({ days: mergedDays, maxHR: allTimeMaxHR, latestPhysio }), {
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
