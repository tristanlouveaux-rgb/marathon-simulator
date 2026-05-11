/**
 * Route Safety Ratings — syncs user safety scores to Supabase.
 * Fire-and-forget: never throws to caller, warns on failure.
 */

import { supabase } from './supabaseClient';
import { getState } from '@/state/store';

export interface SafetyRatingInput {
  activityId: string;
  source: 'gps_recording' | 'strava' | 'garmin';
  polylineTrimmed: string;
  pointCount: number;
  distanceKm: number;
  safetyScore: number | null;
  centerLat: number;
  centerLng: number;
  boundsNorth: number;
  boundsSouth: number;
  boundsEast: number;
  boundsWest: number;
}

export async function submitRouteSafetyRating(input: SafetyRatingInput): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const raterGender = getState().biologicalSex ?? null;

    const { error } = await supabase
      .from('route_safety_ratings')
      .upsert({
        user_id: user.id,
        activity_id: input.activityId,
        source: input.source,
        polyline_trimmed: input.polylineTrimmed,
        point_count: input.pointCount,
        distance_km: input.distanceKm,
        safety_score: input.safetyScore,
        rater_gender: raterGender,
        center_lat: input.centerLat,
        center_lng: input.centerLng,
        bounds_north: input.boundsNorth,
        bounds_south: input.boundsSouth,
        bounds_east: input.boundsEast,
        bounds_west: input.boundsWest,
      }, { onConflict: 'user_id,activity_id' });

    if (error) console.warn('[SafetyRating] submit error:', error.message);
    else console.log(`[SafetyRating] saved score=${input.safetyScore ?? 'N/A'} for ${input.activityId}`);
  } catch (e) {
    console.warn('[SafetyRating] submit failed:', e);
  }
}

/**
 * Returns true if the user has already submitted a rating for this activity.
 * Used to show/hide the CTA on the activity-detail view.
 */
export async function hasRatedActivity(activityId: string): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { data, error } = await supabase
      .from('route_safety_ratings')
      .select('id')
      .eq('user_id', user.id)
      .eq('activity_id', activityId)
      .maybeSingle();

    return !error && data != null;
  } catch {
    return false;
  }
}
