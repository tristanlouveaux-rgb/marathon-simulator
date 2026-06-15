# Share to Mosaic — native iOS file intake

Goal: from a downloaded activity file on the phone (Strava website "Export
Original", or any `.fit/.gpx/.tcx/.gz` in Files), the user taps **Share →
Mosaic** (or "Open in Mosaic") and the file lands on the matching run
automatically. This removes every step after getting the file: no opening the
app, no finding the activity, no in-app file picker.

## What's already done (TypeScript / WebView side)

- `src/data/fitImport.ts` → `ingestActivityFile(file: File)` — parses the file,
  finds the matching **thin** activity by start + duration and enriches it in
  place, or imports it as a new activity if nothing matches. Tested.
- `src/data/shared-file-intake.ts` → registers a global the native layer calls:

  ```js
  window.__mosaicIngestSharedFile({ name: "morning_run.fit", base64: "<file bytes base64>" })
  ```

  It decodes the base64 to a `File`, routes it through `ingestActivityFile`, and
  toasts the outcome. Re-entrancy-guarded. Registered at launch in
  `main.ts` (`initSharedFileIntake()`).

So the native task is only: **register the file types, receive the opened file,
base64-encode it, and call that one global.**

## What's left (native iOS — needs Xcode + a device build)

1. **Declare the document types** so iOS offers Mosaic in the share sheet for
   activity files. In `ios/App/App/Info.plist`, add `CFBundleDocumentTypes`
   (and imported UTI declarations) for: `.fit` (no system UTI — declare a custom
   `com.mosaic.fit` conforming to `public.data`), `.gpx`
   (`com.topografix.gpx` / `public.xml`), `.tcx` (`public.xml`), and `.gz`
   (`org.gnu.gnu-zip-archive`). Set the role to `Editor`/`Viewer` and
   `LSHandlerRank` to `Alternate`.

2. **Receive the opened file.** iOS copies it into the app's Documents/Inbox and
   calls `application(_:open:options:)` with a `file://` URL. Two ways to bridge
   it to the WebView:
   - Install `@capacitor/app` and listen to `appUrlOpen` (gives the URL), then
     read the bytes via `@capacitor/filesystem`; **or**
   - In `AppDelegate.swift`, read the file in `application(_:open:options:)`,
     base64-encode, and call the WebView:
     `bridge?.eval(js: "window.__mosaicIngestSharedFile(\(payloadJSON))", ...)`.

   The `AppDelegate` route avoids a new JS plugin dependency. Either is fine.

3. **Encode + call.** Read the file `Data`, `name = url.lastPathComponent`,
   `base64 = data.base64EncodedString()`, then call the global with
   `{ name, base64 }`. Delete the Inbox copy afterward.

4. **Cold-start vs warm.** If the app was launched (not foregrounded) by the
   open, fire the call after the WebView/bootstrap is ready (the global is set
   in `bootstrap()`), e.g. queue the payload and flush once
   `window.__mosaicIngestSharedFile` exists.

## Test on device

- Strava website → an activity → Export Original → file saves to Files.
- Files → the file → Share → Mosaic. Expect a toast: "Added HR zones, splits,
  route to your <date> run." Confirm the thin run on that date now shows zones,
  splits and the map, with no duplicate created.
- Share a file with no matching run → expect an "Imported …" toast and a new
  activity.

## Cross-device sync (web enrich → phone) — REQUIRES a one-time migration

So a file uploaded on the **web app** shows up on the **phone** (and vice
versa), enrichment is synced per-activity, independent of the fragile
full-state snapshot. The TypeScript is built and tested; it no-ops until the
table below exists, so it is safe to ship first.

- `src/data/enrichmentSync.ts`:
  - `pushEnrichment(garminId, patch)` — called from `applyEnrichment` after a
    successful enrich; writes the rich fields to one row.
  - `mergeEnrichmentsFromServer()` — called on launch (`main.ts` after
    `reconcileCrossSourceDuplicates`, forced) and on foreground
    (`visibilitychange`, throttled 5 min); merges rows into local thin
    activities by `garminId`, rich-over-thin only.
  - `applyEnrichmentPayloads(...)` — the pure, tested merge rule.

**Run this once in the Supabase SQL editor** (the MCP is read-only; apply by
hand). Additive and reversible (`drop table public.activity_enrichments`):

```sql
create table if not exists public.activity_enrichments (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_key text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, activity_key)
);
alter table public.activity_enrichments enable row level security;
create policy "Users manage their own activity enrichments"
  on public.activity_enrichments
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

Why a separate table and not the snapshot: recording an enrichment must not
push a full state blob (a stale web session would clobber newer phone data).
One row per enrichment, keyed by the stable `garminId`, is monotonic, so
last-writer-wins per activity is safe and no merge conflict resolution is
needed.

## The irreducible friction (not solvable without Strava OAuth)

The Strava **website** Export Original step cannot be removed for non-beta
users: there is no API access, and we do not store the Strava activity id on a
thin Apple-Health row, so we cannot deep-link to its export. Share-to-Mosaic
removes everything *after* that step. The only way to remove the export step
entirely is direct Strava connect (auto-sync), which is gated on Extended Access
approval. See `docs/STRAVALESS_PLAN.md`.
