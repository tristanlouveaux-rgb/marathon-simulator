/**
 * Cross-device activity enrichment sync.
 *
 * Problem: a user can enrich a thin activity (upload its Strava "Export
 * Original" file) on one device — typically the web app on a laptop, where the
 * file is easy to download and pick — but the plan-settings backup is a single
 * full-state snapshot with last-writer-wins semantics, restored only when local
 * storage is empty. So a web enrich never reaches an already-running phone, and
 * a later phone save can clobber it.
 *
 * Fix: keep enrichment OUT of that fragile blob. Each enrichment is written as
 * its own row in `activity_enrichments`, keyed by the activity's `garminId`
 * (stable across devices — the activity is born on the phone and the id rides
 * the snapshot to web, and the enrich path preserves it). Every device merges
 * those rows into its own thin copies on launch and on foreground.
 *
 * This is safe without conflict resolution because enrichment is MONOTONIC: it
 * only ever adds detail to a thin row, never competes with other edits. So
 * per-activity last-writer-wins is correct, and merging never clobbers anything
 * else in state. Recording an enrichment writes only its own row, so it can
 * never overwrite newer data another device pushed to the snapshot.
 *
 * Resilient by design: if the table does not exist yet (migration not applied),
 * every call warns and no-ops, so the TS can ship ahead of the migration.
 */

import { supabase } from './supabaseClient';
import { getMutableState } from '@/state/store';
import { isThinActivity } from './activity-enrich-merge';
import type { GarminActual } from '@/types';

const TABLE = 'activity_enrichments';
const LAST_MERGE_KEY = 'mosaic_enrich_merge_at';
const MERGE_THROTTLE_MS = 5 * 60 * 1000;

/** The rich fields enrichment adds — exactly `enrichActualFromParsedRow`'s patch. */
export type EnrichPayload = Partial<GarminActual>;

/**
 * Back up the rich fields just merged into an activity so the user's other
 * devices can pick them up. Fire-and-forget; never throws, never blocks.
 */
export async function pushEnrichment(activityKey: string, payload: EnrichPayload): Promise<void> {
  try {
    if (!activityKey || !payload || Object.keys(payload).length === 0) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from(TABLE).upsert({
      user_id: user.id,
      activity_key: activityKey,
      payload,
      updated_at: new Date().toISOString(),
    });
    if (error) console.warn('[EnrichmentSync] push error:', error.message);
  } catch (e) {
    console.warn('[EnrichmentSync] push failed:', e);
  }
}

/**
 * Pure: apply server enrichment payloads onto local activities by `garminId`.
 * Rich-over-thin only — an activity that already carries its own detail
 * (`!isThinActivity`) is left untouched, so we never downgrade better data and
 * the merge is idempotent (the payload stamps `enrichedFromFile`, flipping the
 * row out of "thin" so it won't re-merge). Returns how many rows were filled.
 */
export function applyEnrichmentPayloads(
  wks: { garminActuals?: Record<string, GarminActual> }[] | undefined,
  payloads: Map<string, EnrichPayload>,
): number {
  let applied = 0;
  for (const wk of wks ?? []) {
    for (const a of Object.values(wk.garminActuals ?? {})) {
      if (!a || !a.garminId) continue;
      const payload = payloads.get(a.garminId);
      if (!payload || !isThinActivity(a)) continue;
      Object.assign(a, payload);
      applied++;
    }
  }
  return applied;
}

/**
 * Fetch this user's enrichments and merge any that target a still-thin local
 * activity. Runs on launch + foreground so an enrich done on another device
 * (e.g. the web app) shows up. Throttled to once per 5 min unless forced.
 */
export async function mergeEnrichmentsFromServer(opts: { force?: boolean } = {}): Promise<void> {
  try {
    const last = Number(localStorage.getItem(LAST_MERGE_KEY) ?? 0);
    if (!opts.force && Date.now() - last < MERGE_THROTTLE_MS) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from(TABLE)
      .select('activity_key, payload')
      .eq('user_id', user.id);
    if (error) { console.warn('[EnrichmentSync] fetch error:', error.message); return; }

    localStorage.setItem(LAST_MERGE_KEY, String(Date.now()));
    if (!data || data.length === 0) return;

    const map = new Map<string, EnrichPayload>();
    for (const row of data) map.set(row.activity_key as string, row.payload as EnrichPayload);

    const applied = applyEnrichmentPayloads(getMutableState().wks, map);
    if (applied > 0) {
      const { saveState } = await import('@/state');
      saveState();
      const { render } = await import('@/ui/renderer');
      render();
      console.log(`[EnrichmentSync] merged ${applied} enrichment(s) from another device`);
    }
  } catch (e) {
    console.warn('[EnrichmentSync] merge failed:', e);
  }
}
