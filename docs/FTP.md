# FTP Troubleshooting Runbook

A working knowledge of why Bike FTP estimation can break, how to diagnose it, and how to fix it. Read this before debugging any FTP issue. Keep it updated when a new regression class appears.

## TL;DR — When in Doubt

1. Open the app. Look for `[FTP health]` in the browser console.
2. If `ftp=null` or it dropped from a working number, tap "Show details →" on the Bike FTP card. The overlay shows the funnel.
3. If the overlay says "no power curves computed", click "Recompute power". Wait for it to finish.
4. If still broken, check Supabase logs for `[Power curve]` lines. If none, the edge function isn't running step 5e.
5. Last resort: redeploy `sync-strava-activities` and trigger a fresh backfill from a cold launch.

---

## Where the FTP Value Comes From

```
Strava activity                    Edge function step 5e                    Client estimator                  UI
───────────────                    ────────────────────                     ────────────────                  ──
watts stream  ─── fetch (15/sync)─► computeMeanMax (p600/p1200/p1800/p3600) ─► curve path                  ─► onboarding/review
                                                                                  p1200 × 0.95 → FTP
                                                                                                              + Bike FTP card
average_watts ─── activity row    ─── stored in garmin_activities         ─► fallback path
normalized_power                                                                NP × 1.0 → FTP
device_watts (unreliable)                                                                                     [Show details →]
                                                                                                              opens debug overlay
```

The two paths are very different:

- **Curve path (preferred)**: reads `power_curve` from the activity row. The curve is best-mean-max watts over fixed windows, computed by the edge function from the watts stream. The estimator picks the strongest window across the user's last 12 weeks of rides, applies a Coggan multiplier (0.92 for 10 min, 0.95 for 20 min, etc), and that's the FTP. A 110-min ride with two 20-min intervals at 310 W gives FTP = 295 W via this path.
- **Fallback path**: reads `normalized_power` or `average_watts` from the activity row directly. Picks the strongest qualifying recent ride and uses NP × 1.0 as a conservative floor. Same 110-min ride collapses to whole-ride NP around 240 W via this path because recovery sections between intervals drag NP down.

The curve path requires the edge function to have fetched the watts stream. If it hasn't, the fallback is all you get. **Most "FTP looks wrong" reports trace back to the curve path failing to run, not to the estimator math.**

## Where to Look First

### `[FTP health]` console log

Fires every launch from `src/ui/wizard/steps/review.ts` after `deriveTriBenchmarks` runs. Format:

```
[FTP health] ftp=295W src=curve(20-min) conf=high picked=2026-04-27(310W) | bikes=63 withCurve=2 withNP=62 withAvgW=62 dw(t/f)=2/60
```

Read this first. The breakdown:

- `ftp` — the value the estimator picked.
- `src` — `curve(<window>)` for the curve path, `fallback(NP×1.0)` for the fallback, `none` when no FTP could be derived.
- `conf` — high / medium / low / none. high requires curve path within 4 weeks AND `device_watts === true`.
- `picked` — date and watts of the source ride (mean-max watts at the chosen window for curve, NP for fallback).
- `bikes` — total cycling rides loaded post-dedup.
- `withCurve` — rides with a populated `power_curve`. **If this is 0, the curve path can never run.**
- `withNP`, `withAvgW` — rides with `normalized_power` or `average_watts` populated.
- `dw(t/f)` — count of `device_watts: true` and `device_watts: false`.

A loud `[FTP health] WARNING: N rides synced but no FTP derived` fires when null FTP coexists with bike rides. That is the regression class to act on.

### FTP debug overlay (in-app)

Tap "Show details →" on the Bike FTP card. The modal shows:

- Power data inventory (matches `[FTP health]` numbers).
- Funnel rejection counts: no usable power / too short / too old.
- Top 5 candidates after filtering, with the picked ride flagged.
- A "most likely cause" hint when no FTP landed.
- A "Recompute power" button that triggers the manual refresh path (Layer 3).

Code: `src/ui/ftp-debug-overlay.ts`.

### Supabase function logs

Dashboard, Edge Functions, `sync-strava-activities`, Logs tab. Search for `[Power curve]`.

- `[Power curve] strava-XXXX: p600=N p1200=N p1800=N p3600=N` per success.
- `[Power curve] fetched=N/M stored=N (truncated by 429)` summary at end of step 5e.
- `[Power curve refresh]` lines when the manual button was used.
- **Zero `[Power curve]` lines means step 5e never ran.** Check the function's `updated_at` timestamp via `supabase functions list` to verify it's the deployed version you expect.

---

## Recurring Problem Classes

### 1. Strava `device_watts` flag is unreliable

**Symptom**: User has a real power meter. Most rides arrive flagged `device_watts: false` anyway. Curve fetch and fallback both reject the rides. FTP shows `--`.

**Root cause**: Strava's flag is structurally broken on Garmin to Strava transfers. It routinely arrives `false` (or `null`) on rides captured by a real power meter. The flag cannot be trusted as ground truth.

**Standing fix (already in place)**:

- Edge function step 5e (`supabase/functions/sync-strava-activities/index.ts`, around line 1252): no `device_watts === true` filter. Uses NP threshold (>= 120 W) instead.
- Client estimator (`src/calculations/tri-benchmarks-from-history.ts`): no `device_watts` reject in either curve or fallback path. The flag is a confidence-only signal (one tier downgrade when not explicitly true).

If a future change adds either gate back, this class will reappear immediately. The `[FTP health]` `dw(t/f)` count and the `withCurve` count will both look wrong.

### 2. Curve never computed (edge function step 5e missed the ride)

**Symptom**: `[FTP health] withCurve=0` but rides exist with high NP. The fallback path runs and produces a number, but it's lower than the user expects because it can't see inside interval rides.

**Possible causes**:

1. Edge function not deployed with the latest code. Run `supabase functions list --project-ref elnuiudfndsvtbfisaje`. Compare `updated_at` of `sync-strava-activities` against your latest local change.
2. Step 5e only runs in `mode === "backfill"`. If only standalone syncs have fired since the ride landed, the curve was never computed. Trigger a cold launch (auto-fires backfill) or use the manual "Recompute power" button.
3. Per-sync budget exhausted. Step 5e fetches at most 15 streams ranked by NP DESC. If the user has many high-NP rides, the target ride may not be in the top 15.
4. Strava 429 rate limit. Look for `truncated by 429` in the `[Power curve]` summary line.

**Fix order**: deploy if needed, wait 15 minutes from the last 429, then either cold-launch (auto-backfill) or click "Recompute power" in the FTP debug overlay (uses the `powerCurveRefresh` mode with budget 30, no NP-rank gating).

### 3. Stale data in the activity row

**Symptom**: Strava UI shows avg power 223 W and weighted average 251 W for a ride. Our DB row has `average_watts: 193`, `normalized_power: null`. Estimator is forced to anchor on 193.

**Root cause**: Strava re-processes power streams asynchronously after upload. The list endpoint returns preliminary values for some time after a ride is uploaded. The detail endpoint reflects the current state, but our standalone path only refetches detail for the most recent 5 cycling activities per sync (`POWER_DETAIL_BUDGET = 5`).

**Fix**: trigger another sync after waiting for Strava to settle (typically minutes, sometimes hours). The detail refetch should pick up the corrected values. Or use the manual "Recompute power" button which always fetches the watts stream directly, sidestepping list-vs-detail drift entirely.

**Do not** assume "moving time vs elapsed time" arithmetic when DB values disagree with Strava UI. That guess was wrong on 2026-05-01. The cause is async re-processing.

### 4. Activity uploaded twice with different Strava IDs

**Symptom**: One Strava ID has full power data (`device_watts: true`, NP, max watts). A second Strava ID for the same physical ride has `average_watts` only and `device_watts: false`. Both land in the DB.

**Root cause**: Strava uploads can produce `Ride` and `Virtual Ride` duplicates, or a re-upload after a hardware/software fix.

**Standing fix**: client-side dedup in `src/data/tri-activity-loader.ts:dedupeActivities`. Score function gives `power_curve` +5000, `device_watts: true` +2000, plus `average_watts` +500. The good row wins on score, then `mergeKeepingFields` backfills any null fields from the loser onto the winner.

Verify with the `[tri-activity-loader] PRE-dedup ... power_curve:N` console log. If pre-dedup has curves but post-dedup `kept ... power_curve:0`, dedup is dropping them. Re-read the score function and the merge logic.

### 5. All real-meter rides aged out, no fresh ride to anchor

**Symptom**: FTP was working a week ago. Now it falls to the fallback path with a lower number, or `--` entirely.

**Root cause**: the curve path has a 12-week hard cutoff (`HARD_CUTOFF_WEEKS`). The previous anchor ride aged past it. The user hasn't had a new ride with watts data since.

**Fix**: not really a bug. The user needs to do a fresh ride with power. The `[FTP health]` log shows the picked ride's date so you can spot this case (`picked=2026-XX-XX` more than 8 weeks back, confidence dropping to `low`).

### 6. Derived FTP regresses to a lower value across launches

**Symptom**: FTP was at 295 W last session. This launch it shows 193 W. No user action between sessions.

**Root cause**: the auto-refresh logic in `main.ts` (around line 471) and `review.ts` (around line 465) used to overwrite a saved derived FTP with whatever the new estimator returned, in either direction. If the curve path landed 295 W last session and this session's curve disappeared (Strava re-processing, dedup change, deploy timing), the estimator drops to fallback NP × 1.0 around 193 W. The "refresh derived" branch silently saves the lower number on top of the working one.

**Standing fix (2026-05-02)**: ratchet-up rule. A saved derived FTP is only replaced by a new derivation when:
- the new value is `>= ` the saved value, OR
- the new derivation has *higher* confidence than the saved one (e.g. saved was 'low' fallback, new is 'high' curve — accept even if value is slightly lower).

Otherwise the saved value is held and a `[tri] FTP held: derived path returned NW (low) but saved is MW (high)` log line fires so the rejection is visible.

To explicitly drop FTP, the user must manually enter a lower value, which flips `ftpSource` to `'user'`.

### 7. Watts stream never available on Strava

**Symptom**: `[Power curve refresh]` runs but `stored=0` even when many candidates are eligible. Edge function logs show `wattsData.length < 600` for every fetch attempt.

**Root cause**: Strava doesn't have a watts stream for the ride. Could be an estimated-power-only ride (Strava synthesised power from speed and gradient, no underlying samples), or the ride was recorded without a power meter and the estimated-power feature is disabled.

**Fix**: there is no recovery. The fallback path is the only available signal. If you're sure the ride had a real power meter and the watts stream should exist, look at the Strava activity in the browser. If it shows a power chart, the stream exists and the fetch is failing for a different reason. If it doesn't, the stream truly is missing.

---

## Standard Diagnostic Procedure

Walk through this in order when an FTP issue is reported.

1. **Read `[FTP health]` from the browser console.** First launch only — repeated reloads can mask the issue and burn rate-limit budget.
2. **Open the FTP debug overlay** (Bike FTP card, "Show details →"). Note the picked ride, the funnel rejection counts, the inventory.
3. **Check `withCurve`**. If 0 with rides existing, jump to "Curve never computed".
4. **Check Supabase logs** for `[Power curve]` lines. None means step 5e didn't run.
5. **Verify deploy**: `supabase functions list --project-ref elnuiudfndsvtbfisaje`. Compare `sync-strava-activities` `updated_at` against your latest local commit.
6. **Try the manual recompute** ("Recompute power" button in the overlay). If it returns `stored=0`, look at why (429, no streams available, threshold rejection).

If after all six steps you still don't know what's wrong, paste the `[FTP health]` line, the overlay screenshot, and the relevant `[Power curve]` lines into the next agent session.

---

## Standard Fixes

### Deploy the edge function

```bash
supabase functions deploy sync-strava-activities --project-ref elnuiudfndsvtbfisaje
```

Verify with `supabase functions list ...`. Look for the `updated_at` timestamp on `sync-strava-activities` matching the deploy time, and the version number incrementing.

### Trigger a backfill

Cold-launch the app. Startup auto-backfill fires when conditions are met (see `main.ts` for the gating). If conditions don't fire, the manual "Refresh from Strava" button in bike setup does the same job.

### Use the manual recompute (Layer 3)

Two entry points, both call the same `sync-strava-activities` `powerCurveRefresh` mode (budget 30, NP threshold 120 W, 26-week lookback):

1. **Account / Profile → "Refresh FTP from rides"** button under the Benchmarks card. Inline status, applies ratchet-up rule, re-renders the page on success. The fastest path when the user is already on Account.
2. **Wizard → Bike FTP card → "Show details →" → "Recompute power"**. Same action, but the diagnostic overlay shows the funnel breakdown first. Use this when you also want to know *why* the curve was missing.

Returns `{ ok, eligibleCount, fetched, stored, truncatedBy429 }`. Both surfaces show inline status: success ("Stored 2 curves. FTP → 295 W (high)") or held ("New estimate didn't beat saved value"). The 30-stream budget and direct DB-row scan bypass the auto-backfill ranking, so a single click should always reach the user's most-recent qualifying ride.

### Wait for Strava 429 to clear

Strava's per-token rate limit is 100 requests per 15 min, 1000 per day. After hitting a 429, do not retry for 15 minutes from the last failure. Each retry within the window resets the clock in some implementations.

---

## History of FTP Regressions

| Date | Symptom | Cause | Fix | Commit / changelog |
|------|---------|-------|-----|--------------------|
| 2026-04-26 | FTP shows 90 W | Whole-ride NP × 0.95 underestimating long endurance rides | Duration-aware factor classification (high-signal vs floor) | `dd07dc9` |
| 2026-04-28 | Estimator anchored to wrong ride | Whole-ride NP couldn't see inside interval rides | Curve-based estimator with mean-max windows | `3e06036` |
| 2026-04-30 | FTP stuck at 135 W | Two estimator bugs: stale anchor, wrong window selection | Top-1 selection within 12 weeks, outlier guard | `041fae5` |
| 2026-05-01 | FTP shows `--` despite 63 rides | `device_watts !== true` gate in curve and fallback paths | Drop the gate, use NP threshold instead | 2026-05-01 changelog |
| 2026-05-01 | FTP at 193 W instead of 295 W | Same `device_watts` gate in edge function step 5e | Drop the gate server-side, deploy v78 | 2026-05-01 changelog (ISSUE-156) |
| 2026-05-02 | (no regression — defence layers added) | n/a | Health log + diagnostics overlay + manual recompute | 2026-05-02 changelog |
| 2026-05-02 | FTP regressed 295 W → 193 W across launches | Auto-refresh in `main.ts` overwrote saved derived value with any new derivation, including lower ones. Curve disappeared between sessions, fallback wrote 193 over the saved 295. | Ratchet-up rule: derived → derived only refreshes when value ≥ saved OR confidence is higher | 2026-05-02 changelog |

When you fix a new regression, add a row to this table with the date, symptom, cause, and fix. Future agents read this table to spot pattern recurrence.

---

## Code Surfaces

If you need to dig into the implementation, these are the load-bearing files:

| File | Role |
|------|------|
| `src/calculations/tri-benchmarks-from-history.ts` | Estimator. `estimateFTPFromBikeActivities`, curve path, fallback path, `FtpEstimate` interface, `diagnostics` field |
| `src/calculations/tri-benchmarks-from-history.test.ts` | 58 tests covering curve path, fallback, `device_watts` flag handling, edge cases |
| `src/data/tri-activity-loader.ts` | DB fetch, dedup, pre-dedup inventory log |
| `src/ui/wizard/steps/review.ts` | Bike FTP card, `[FTP health]` log, "Show details →" link |
| `src/ui/ftp-debug-overlay.ts` | Diagnostics modal |
| `src/data/recompute-power-curves.ts` | Manual recompute client helper |
| `supabase/functions/sync-strava-activities/index.ts` | Edge function. Step 5e (curve fetch), `extractPowerFields`, standalone detail refetch, `powerCurveRefresh` mode |
| `docs/SCIENCE_LOG.md` (FTP sections) | Scientific rationale, multipliers, references |
| `docs/OPEN_ISSUES.md` (ISSUE-156 area) | Issue tracking for FTP-related bugs |

## Constants Worth Knowing

| Constant | Value | Where | Why |
|----------|-------|-------|-----|
| `HARD_CUTOFF_WEEKS` | 12 | estimator | Detraining literature: ~10–15% FTP loss by 12 weeks off |
| `HIGH_TIER_WEEKS` | 4 | estimator | High confidence threshold |
| `MED_TIER_WEEKS` | 8 | estimator | Medium confidence threshold |
| `FALLBACK_MIN_W` | 120 | estimator | Filters out commuter rides where Strava estimated power from speed alone |
| `PC_MULTIPLIERS.p1200` | 0.95 | estimator | Coggan classic 20-min FTP test multiplier |
| `POWER_CURVE_BUDGET` | 15 | edge function step 5e | Streams per sync, biased to highest NP |
| `POWER_DETAIL_BUDGET` | 5 | edge function standalone | Detail-endpoint refetches per sync |
| `REFRESH_BUDGET` | 30 | edge function `powerCurveRefresh` | Higher budget for user-triggered recompute |
| `MARKER_BUMP_THRESHOLD_FTP_W` | 5 | (other module) | Auto-bump notification threshold |
