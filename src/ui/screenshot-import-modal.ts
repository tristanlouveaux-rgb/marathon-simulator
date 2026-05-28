/**
 * Guided "import from screenshot" modal.
 *
 * The iOS-easy capture path: the user picks a screenshot of their run summary
 * (Strava, Garmin Connect, Nike Run Club, Apple Fitness, ...) and we read the
 * numbers off it via the hybrid OCR→AI pipeline (`runHybridParse`).
 *
 * Two engines feed the same parser contract:
 *   - On-device Apple Vision OCR — iOS only, free, private, runs first.
 *   - AI-vision edge function — cloud Claude vision, signed-in fallback for
 *     low-confidence OCR or web users without a native engine.
 *
 * The confirm step shows the values we read and lets the user correct them
 * before committing. The actual commit goes through
 * `commitScreenshotActivity` in `src/data/screenshotImport.ts`, which mirrors
 * the file-import pipeline tail (match + PBs + fitness refresh).
 *
 * Modelled on `openImportActivityModal` (`src/ui/import-activity-modal.ts`):
 * vertically centered glass overlay per docs/UX_PATTERNS.md → Overlays and
 * Modals, dark CTA, plain-language steps, neutral palette.
 */

import { showSimpleToast } from '@/ui/toast';
import { getState } from '@/state/store';
import { ft, formatKm, fp } from '@/utils/format';
import { recognizeScreenshotText, isScreenshotOcrAvailable } from '@/data/screenshotOcr';
import { runHybridParse } from '@/data/screenshotCapture';
import {
  commitScreenshotActivity,
  parseClockToSec,
  parsedHrSeriesFromAIJson,
  type ParsedScreenshotActivity,
  type ParsedScreenshotHrPoint,
} from '@/data/screenshotImport';
import { SUPABASE_URL, SUPABASE_ANON_KEY, getValidSession } from '@/data/supabaseClient';

const OVERLAY_ID = 'screenshot-import-modal';
const KM_TO_MI = 0.621371;

/** Caller-supplied callback fired once a screenshot has been confirmed and
 *  committed. Mirrors `openImportActivityModal`'s contract so the onboarding
 *  step can reveal Continue + the guest-sync nudge after either path. */
export interface OpenScreenshotImportOptions {
  onComplete?: () => void;
}

/** Tracks the active session's onComplete so the confirm-step handler can fire
 *  it without threading it through every render call. Reset on close(). */
let activeOnComplete: (() => void) | undefined;

/** Per-minute HR samples from the optional second-screenshot (HR chart) step.
 *  Folded into the parsed activity at commit time. Reset on close(). */
let activeHrSeries: ParsedScreenshotHrPoint[] | null = null;

/** Open the guided screenshot-import modal. No-op if already open. */
export function openScreenshotImportModal(opts: OpenScreenshotImportOptions = {}): void {
  if (document.getElementById(OVERLAY_ID)) return;

  activeOnComplete = opts.onComplete;
  activeHrSeries = null;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  renderChooseStep(overlay);
}

// ---------------------------------------------------------------------------
// Step 1 — choose a screenshot
// ---------------------------------------------------------------------------

function renderChooseStep(overlay: HTMLElement): void {
  const ocrCaption = isScreenshotOcrAvailable()
    ? 'Read on your device. Falls back to Mosaic’s cloud reader if a number is unclear.'
    : 'Read by Mosaic’s cloud reader. You will need to be signed in.';

  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="ss-modal-title"
         style="width:min(440px,100%);max-height:90vh;overflow-y:auto;background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:20px;position:relative">
      <button id="ss-modal-close" aria-label="Close"
              style="position:absolute;top:12px;right:12px;width:28px;height:28px;border:none;background:transparent;color:var(--c-muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>

      <div id="ss-modal-title" style="font-size:16px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;margin-bottom:6px;padding-right:28px">Import from screenshot</div>
      <div style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">${ocrCaption}</div>

      ${howTo('Which apps work', 'Strava, Garmin Connect, Nike Run Club, Apple Fitness, Coros, and most run apps. Open the activity summary, screenshot it, then choose that image below. Distance, time, avg heart rate, and per-km splits are read automatically.')}
      ${howTo('What it cannot read', 'A screenshot has no GPS track and no second-by-second data, so the map and detailed heart-rate trace will not appear on this run. Distance, time, splits, and average heart rate drive the plan, so the run still counts.')}

      <label id="ss-choose-label" style="display:block;margin-top:16px;padding:12px 14px;border-radius:10px;background:var(--c-black, #0F172A);color:#FDFCF7;font-size:14px;font-weight:500;text-align:center;cursor:pointer">
        Choose screenshot
        <input id="ss-modal-input" type="file" accept="image/*" style="display:none" />
      </label>
      <div id="ss-modal-status" style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-top:10px;text-align:center;min-height:1px"></div>

      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button id="ss-modal-cancel" style="padding:10px 18px;background:transparent;border:1px solid var(--c-border);border-radius:10px;color:var(--c-black);font-size:14px;font-weight:500;cursor:pointer">Cancel</button>
      </div>
    </div>
  `;

  document.getElementById('ss-modal-close')?.addEventListener('click', close);
  document.getElementById('ss-modal-cancel')?.addEventListener('click', close);
  document.getElementById('ss-modal-input')?.addEventListener('change', onFile);
}

/** Plain-text "how to" collapsible. No third-party logos, no emoji. */
function howTo(title: string, body: string): string {
  return `
    <details style="border:1px solid var(--c-border);border-radius:10px;margin-bottom:8px;overflow:hidden">
      <summary style="padding:11px 14px;list-style:none;cursor:pointer;font-size:13.5px;color:var(--c-black);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span>${title}</span>
        <span style="color:var(--c-muted);font-size:12px;flex-shrink:0">Show</span>
      </summary>
      <div style="padding:0 14px 12px;font-size:12.5px;color:var(--c-muted);line-height:1.55">${body}</div>
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Step 2. Read the screenshot (OCR + AI fallback)
// ---------------------------------------------------------------------------

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  // A new summary image starts a fresh capture. Drop any HR series the user
  // might have collected for a previous (now-abandoned) run.
  activeHrSeries = null;

  const statusEl = document.getElementById('ss-modal-status');
  const label = document.getElementById('ss-choose-label') as HTMLLabelElement | null;
  if (statusEl) statusEl.textContent = 'Reading the screenshot…';
  if (label) label.style.pointerEvents = 'none';

  try {
    const fullBase64 = await fileToBase64(file);
    let aiImage: { base64: string; mediaType: string } | undefined;
    try {
      aiImage = await downscaleForVision(file);
    } catch {
      // If the downscale path fails, the AI fallback will reuse the full-res
      // base64. Payload may be larger but the call still works.
      aiImage = undefined;
    }

    const result = await runHybridParse(fullBase64, {
      ocr: recognizeScreenshotText,
      aiFallback: callSummaryVisionFallback,
      aiImage,
    });

    renderConfirmStep(result.parsed, { usedAI: result.usedAI, source: result.source });
  } catch (err) {
    const detail = err instanceof Error ? err.message : '';
    if (statusEl) statusEl.textContent = `Could not read that screenshot. ${detail}`.trim();
    if (label) label.style.pointerEvents = '';
    showSimpleToast('Could not read that screenshot', 'error');
    input.value = '';
  }
}

/** Read a file as base64 (the raw payload only, prefix stripped). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result ?? '');
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    r.onerror = () => reject(r.error ?? new Error('FileReader failed'));
    r.readAsDataURL(file);
  });
}

/**
 * Downscale and re-encode an image as a small JPEG for the AI vision call.
 * Screenshots are typically 2–4 MB raw; AI gets just enough resolution to read
 * the text (1280 px on the long edge at q=0.6 lands well under the edge
 * function's 2 MB payload cap). The on-device OCR uses the full-res image so
 * its accuracy is not affected.
 */
async function downscaleForVision(file: File): Promise<{ base64: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale = longEdge > 1280 ? 1280 / longEdge : 1;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
  const comma = dataUrl.indexOf(',');
  return {
    base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
    mediaType: 'image/jpeg',
  };
}

type VisionMode = 'summary' | 'hr_chart';

interface VisionResponse {
  parsed: unknown | null;
  /** A human-readable error message from the server (rate-limit etc.), if any. */
  errorMessage?: string;
}

/** Call the AI-vision edge function. Returns the raw `parsed` JSON the server
 *  produced (or null on auth, network, server error, or rate-limit). The summary
 *  mode is used by the hybrid orchestration; `hr_chart` is used by the modal's
 *  optional second-screenshot step. */
async function callVisionFallback(
  imageBase64: string,
  mediaType: string,
  mode: VisionMode = 'summary',
): Promise<VisionResponse> {
  let session: Awaited<ReturnType<typeof getValidSession>>;
  try {
    session = await getValidSession();
  } catch {
    return { parsed: null, errorMessage: 'Sign in to use the cloud reader.' };
  }

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/screenshot-vision`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image_base64: imageBase64, media_type: mediaType, mode }),
    });
  } catch {
    return { parsed: null, errorMessage: 'Network error. Check your connection.' };
  }

  if (!response.ok) {
    let errorMessage: string | undefined;
    try {
      const j = await response.json();
      if (j?.message) errorMessage = String(j.message);
    } catch { /* ignore */ }
    return { parsed: null, errorMessage };
  }

  try {
    const j = await response.json();
    return { parsed: j?.parsed ?? null };
  } catch {
    return { parsed: null };
  }
}

/** Orchestration uses the summary-mode response shape. Returns the parsed
 *  payload only (errors are silent so the hybrid retains the OCR result). */
async function callSummaryVisionFallback(imageBase64: string, mediaType: string): Promise<unknown | null> {
  const res = await callVisionFallback(imageBase64, mediaType, 'summary');
  if (res.errorMessage) {
    const statusEl = document.getElementById('ss-modal-status');
    if (statusEl) statusEl.textContent = res.errorMessage;
  }
  return res.parsed;
}

// ---------------------------------------------------------------------------
// Step 3. Confirm + edit
// ---------------------------------------------------------------------------

function renderConfirmStep(
  parsed: ParsedScreenshotActivity,
  meta: { usedAI: boolean; source: 'ocr' | 'ai' },
): void {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;

  const unitPref = getState().unitPref ?? 'km';
  const distKm = parsed.distanceM != null ? parsed.distanceM / 1000 : null;
  const distInput = distKm != null
    ? (unitPref === 'mi' ? (distKm * KM_TO_MI).toFixed(2) : distKm.toFixed(2))
    : '';
  const durInput = parsed.durationSec != null ? ft(parsed.durationSec) : '';
  const hrInput = parsed.avgHR != null ? String(parsed.avgHR) : '';
  const nowLocal = toLocalDatetimeInput(new Date());

  const summaryBits: string[] = [];
  if (parsed.distanceM != null) summaryBits.push(formatKm(parsed.distanceM / 1000, unitPref));
  if (parsed.durationSec != null) summaryBits.push(ft(parsed.durationSec));
  if (parsed.avgPaceSecKm != null) summaryBits.push(fp(parsed.avgPaceSecKm, unitPref));
  if (parsed.avgHR != null) summaryBits.push(`avg HR ${parsed.avgHR}`);
  const summary = summaryBits.length ? summaryBits.join(' · ') : 'We could not read this screenshot clearly. Fill in the values below.';

  const confidenceNote = parsed.confidence === 'high'
    ? `Read clean${meta.usedAI ? ' (cloud reader)' : ''}. Confirm and add.`
    : parsed.confidence === 'medium'
      ? 'A few fields were not clear. Check the numbers below before adding.'
      : 'Reading was not confident. Fill in or correct any value, then add.';

  const splitsLine = parsed.splits.length > 0
    ? `${parsed.splits.length} split${parsed.splits.length === 1 ? '' : 's'} kept. Max HR ${parsed.maxHR ?? '—'}.`
    : 'No splits table detected. Distance and time still drive the plan.';

  const distLabel = unitPref === 'mi' ? 'Distance (mi)' : 'Distance (km)';

  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="ss-modal-title"
         style="width:min(440px,100%);max-height:90vh;overflow-y:auto;background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:20px;position:relative">
      <button id="ss-modal-close" aria-label="Close"
              style="position:absolute;top:12px;right:12px;width:28px;height:28px;border:none;background:transparent;color:var(--c-muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>

      <div id="ss-modal-title" style="font-size:16px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;margin-bottom:6px;padding-right:28px">Confirm the run</div>
      <div style="font-size:12.5px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">${confidenceNote}</div>

      <div style="padding:12px 14px;border:1px solid var(--c-border);border-radius:10px;margin-bottom:14px">
        <div style="font-size:13.5px;color:var(--c-black);line-height:1.45">${summary}</div>
        <div style="font-size:11.5px;color:var(--c-muted);margin-top:4px">${splitsLine}</div>
      </div>

      <div style="padding:12px 14px;border:1px solid var(--c-border);border-radius:10px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div style="font-size:13.5px;color:var(--c-black);line-height:1.3">Add HR chart for per-minute detail</div>
            <div id="ss-hr-chart-caption" style="font-size:11.5px;color:var(--c-muted);line-height:1.45;margin-top:3px">Optional. Screenshot the HR-over-time chart, we'll sample it to compute a real training load.</div>
          </div>
          <label id="ss-hr-chart-label" style="flex-shrink:0;padding:8px 12px;border-radius:8px;border:1px solid var(--c-border);color:var(--c-black);font-size:12.5px;font-weight:500;cursor:pointer;background:#FFFFFF">
            <span id="ss-hr-chart-label-text">Choose image</span>
            <input id="ss-hr-chart-input" type="file" accept="image/*" style="display:none" />
          </label>
        </div>
      </div>

      ${field('ss-date', 'When', `<input id="ss-date" type="datetime-local" value="${nowLocal}" ${inputStyle()} />`)}
      ${field('ss-dist', distLabel, `<input id="ss-dist" type="number" inputmode="decimal" step="0.01" min="0" value="${distInput}" ${inputStyle()} />`)}
      ${field('ss-dur', 'Time (mm:ss or h:mm:ss)', `<input id="ss-dur" type="text" inputmode="numeric" placeholder="42:34" value="${durInput}" ${inputStyle()} />`)}
      ${field('ss-hr', 'Avg heart rate (bpm)', `<input id="ss-hr" type="number" inputmode="numeric" min="60" max="240" value="${hrInput}" ${inputStyle()} />`)}

      <div id="ss-confirm-error" style="font-size:12px;color:#b91c1c;min-height:1px;margin-top:2px"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:16px">
        <button id="ss-back" style="padding:10px 14px;background:transparent;border:none;color:var(--c-muted);font-size:13.5px;cursor:pointer">Choose a different image</button>
        <button id="ss-add" style="padding:11px 22px;background:var(--c-black,#0F172A);border:none;border-radius:10px;color:#FDFCF7;font-size:14px;font-weight:500;cursor:pointer">Add run</button>
      </div>
    </div>
  `;

  document.getElementById('ss-modal-close')?.addEventListener('click', close);
  document.getElementById('ss-back')?.addEventListener('click', () => {
    const o = document.getElementById(OVERLAY_ID);
    if (o) renderChooseStep(o);
  });
  document.getElementById('ss-add')?.addEventListener('click', () => onConfirm(parsed));
  document.getElementById('ss-hr-chart-input')?.addEventListener('change', onHrChartFile);
}

/**
 * Optional second-screenshot handler. Reads an HR-over-time chart from any run
 * app, sends it to the AI-vision edge function in `hr_chart` mode, and stores
 * the sampled `{ tSec, hr }` series in `activeHrSeries` for the commit step to
 * merge into the parsed activity. Skippable. The run still imports without it.
 */
async function onHrChartFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const captionEl = document.getElementById('ss-hr-chart-caption');
  const labelEl = document.getElementById('ss-hr-chart-label') as HTMLLabelElement | null;
  const labelTextEl = document.getElementById('ss-hr-chart-label-text');
  const setCaption = (msg: string) => { if (captionEl) captionEl.textContent = msg; };
  const setLabel = (msg: string) => { if (labelTextEl) labelTextEl.textContent = msg; };
  if (labelEl) labelEl.style.pointerEvents = 'none';
  setCaption('Reading the HR chart…');

  try {
    const downscaled = await downscaleForVision(file);
    const res = await callVisionFallback(downscaled.base64, downscaled.mediaType, 'hr_chart');
    if (res.errorMessage) {
      setCaption(res.errorMessage);
      input.value = '';
      return;
    }
    const series = parsedHrSeriesFromAIJson(res.parsed);
    if (series.length < 2) {
      setCaption('Could not read the curve. Try a clearer screenshot or skip this step.');
      input.value = '';
      return;
    }
    activeHrSeries = series;
    const spanMin = Math.round((series[series.length - 1].tSec - series[0].tSec) / 60);
    setCaption(`Read ${series.length} HR points across ${spanMin} min. Real iTRIMP will be computed on import.`);
    setLabel('Replace');
  } catch (err) {
    setCaption(err instanceof Error ? err.message : 'Could not read the HR chart.');
    input.value = '';
  } finally {
    if (labelEl) labelEl.style.pointerEvents = '';
  }
}

function field(id: string, label: string, control: string): string {
  return `
    <label for="${id}" style="display:block;font-size:11.5px;color:var(--c-muted);margin-bottom:4px;margin-top:10px">${label}</label>
    ${control}
  `;
}

function inputStyle(): string {
  return `style="width:100%;padding:10px 12px;border:1px solid var(--c-border);border-radius:8px;font-size:14px;color:var(--c-black);background:#FFFFFF"`;
}

/** Format a Date as the local "YYYY-MM-DDTHH:MM" string that
 *  `<input type="datetime-local">` expects. */
function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Commit a confirmed screenshot run from the edited form values. */
function onConfirm(parsed: ParsedScreenshotActivity): void {
  const errEl = document.getElementById('ss-confirm-error');
  const setErr = (msg: string) => { if (errEl) errEl.textContent = msg; };

  const unitPref = getState().unitPref ?? 'km';
  const dateStr = (document.getElementById('ss-date') as HTMLInputElement | null)?.value ?? '';
  const distStr = (document.getElementById('ss-dist') as HTMLInputElement | null)?.value ?? '';
  const durStr = (document.getElementById('ss-dur') as HTMLInputElement | null)?.value ?? '';
  const hrStr = (document.getElementById('ss-hr') as HTMLInputElement | null)?.value ?? '';

  const distVal = parseFloat(distStr);
  if (!isFinite(distVal) || distVal <= 0 || distVal > 500) {
    setErr('Enter a distance between 0 and 500.');
    return;
  }
  const distanceM = Math.round(unitPref === 'mi' ? (distVal / KM_TO_MI) * 1000 : distVal * 1000);

  const durationSec = parseClockToSec(durStr);
  if (durationSec == null || durationSec < 60) {
    setErr('Enter a time like 42:34 or 1:23:45.');
    return;
  }

  let avgHR: number | null = null;
  if (hrStr.trim() !== '') {
    const n = parseInt(hrStr, 10);
    if (!isFinite(n) || n < 60 || n > 240) {
      setErr('Heart rate should be between 60 and 240.');
      return;
    }
    avgHR = n;
  } else {
    avgHR = parsed.avgHR;
  }

  const startTime = dateStr ? new Date(dateStr) : new Date();
  if (isNaN(startTime.getTime())) {
    setErr('Pick a valid date and time.');
    return;
  }
  const startTimeISO = startTime.toISOString();

  // Rebuild the parsed activity from the confirmed values. Splits, maxHR, and
  // any avgPace the parser derived ride along unchanged. The user only edits
  // the top-line fields. If the optional HR-chart step ran, the sampled series
  // is folded in here so `commitScreenshotActivity` builds an enrichment ctx
  // and the row arrives with a real iTRIMP + HR-zone breakdown.
  const finalParsed: ParsedScreenshotActivity = {
    ...parsed,
    distanceM,
    durationSec,
    avgHR,
    // avgPace recomputes from distance + duration so an edited distance flows
    // through to pace consistently. screenshotActivityToRow does the same
    // fallback derivation, but recomputing here keeps the in-memory object
    // honest if anything else reads it later.
    avgPaceSecKm: Math.round((durationSec / distanceM) * 1000),
    hrSeries: activeHrSeries && activeHrSeries.length >= 2 ? activeHrSeries : undefined,
    missing: [],
    confidence: 'high',
  };

  try {
    const ok = commitScreenshotActivity(finalParsed, startTimeISO);
    if (!ok) {
      showSimpleToast('Could not save this run', 'error');
      setErr('Saved nothing. Try a different date or check this run is not already imported.');
      return;
    }
    showSimpleToast('Run added from screenshot', 'info');
    const cb = activeOnComplete;
    close();
    try { cb?.(); } catch (e) { console.warn('[screenshot-import] onComplete failed', e); }
  } catch (err) {
    setErr(err instanceof Error ? err.message : 'Could not save.');
    showSimpleToast('Could not save this run', 'error');
  }
}

function close(): void {
  activeOnComplete = undefined;
  activeHrSeries = null;
  document.getElementById(OVERLAY_ID)?.remove();
}
