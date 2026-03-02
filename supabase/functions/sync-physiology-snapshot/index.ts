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

        // Calculate start date
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - (limit + 1))
        const startDateStr = startDate.toISOString().split('T')[0]

        // Query daily_metrics with correct column names matching webhook schema
        // Webhook writes: garmin_user_id, day_date, resting_hr, hrv_rmssd, stress_avg, vo2max
        const [metricsRes, sleepRes, physioRes] = await Promise.all([
            supabaseClient
                .from('daily_metrics')
                .select('day_date, resting_hr, max_hr, hrv_rmssd, stress_avg, vo2max')
                .gte('day_date', startDateStr)
                .order('day_date', { ascending: true }),

            supabaseClient
                .from('sleep_summaries')
                .select('calendar_date, overall_sleep_score')
                .gte('calendar_date', startDateStr),

            supabaseClient
                .from('physiology_snapshots')
                .select('calendar_date, vo2_max_running, lactate_threshold_pace')
                .gte('calendar_date', startDateStr)
        ])

        if (metricsRes.error) throw metricsRes.error
        if (sleepRes.error) throw sleepRes.error
        if (physioRes.error) throw physioRes.error

        // Merge by date — map DB column names to client-expected names
        const mergedData = new Map<string, any>()

        for (const m of metricsRes.data || []) {
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
        for (const s of sleepRes.data || []) {
            const existing = mergedData.get(s.calendar_date) || { calendar_date: s.calendar_date }
            existing.sleep_score = s.overall_sleep_score
            mergedData.set(s.calendar_date, existing)
        }

        // Merge physio
        for (const p of physioRes.data || []) {
            const existing = mergedData.get(p.calendar_date) || { calendar_date: p.calendar_date }
            // Prefer vo2max from daily_metrics, fallback to physiology_snapshots
            if (!existing.vo2max && p.vo2_max_running) {
                existing.vo2max = p.vo2_max_running
            }
            existing.lt_pace_sec_km = p.lactate_threshold_pace
            mergedData.set(p.calendar_date, existing)
        }

        const result = Array.from(mergedData.values())
            .sort((a, b) => a.calendar_date.localeCompare(b.calendar_date))

        return new Response(JSON.stringify(result), {
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
