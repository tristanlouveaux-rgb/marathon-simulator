import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
        )

        const { garmin_ids } = await req.json()

        if (!garmin_ids || !Array.isArray(garmin_ids) || garmin_ids.length === 0) {
            return new Response(JSON.stringify([]), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            })
        }

        // Query activity_details table
        // Expected to have 'json_data' column with "laps": [...]
        const { data, error } = await supabaseClient
            .from('activity_details')
            .select('garmin_id, json_data')
            .in('garmin_id', garmin_ids)

        if (error) throw error

        // Transform to client shape: { garmin_id: string, raw: { laps: ... } }
        const rows = data.map((d: any) => ({
            garmin_id: d.garmin_id,
            raw: d.json_data // Assuming json_data contains the full object including 'laps'
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
