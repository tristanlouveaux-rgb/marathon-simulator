/**
 * VO2max headline card — shared between running and triathlon stats views.
 *
 * Top-line: cross-modal headline VO2max with the source sport that drove
 * it (running / cycling / cardiac ceiling). Up to four rows beneath:
 * running and cycling (measured), cardiac ceiling (aerobic upper bound from
 * HRmax/HRrest), and cross-training (sustained-HR aerobic capacity from
 * non-run/non-bike sport — hidden until 3 qualifying sessions). Tap →
 * drill-down with explainer + literature note.
 *
 * Visual style mirrors the existing Fitness summary card (compact rows,
 * coloured dot per source, tabular-nums values, "Detail →" link).
 *
 * The card is hidden when no estimate is available — fresh installs without
 * any activity history shouldn't see an empty placeholder.
 */

import type { SimulatorState, VO2Estimate, VO2Confidence } from '@/types';
import { getMutableState, getState, saveState } from '@/state';
import { isCyclingOnlyMode } from '@/calculations/cycling-mode';

/**
 * Compact area-chart for VO2max trend. UX_PATTERNS-compliant:
 * no dots, area fill at 0.12, stroke 1.5px, render nothing when < 2 points.
 * Trend colour from rising (green) vs declining (red) — same convention as
 * the existing fitness chart on the running stats view.
 */
function buildVO2TrendChart(data: Array<{ date: string; value: number }>): string {
  const n = data.length;
  if (n < 2) return '';

  const vals = data.map(d => d.value);
  const lo = Math.min(...vals) - 1;
  const hi = Math.max(...vals) + 1;
  const range = hi - lo || 1;
  const W = 320, H = 60;
  const xOf = (i: number) => (i / (n - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, ((v - lo) / range) * (H - 8));

  let topPath = `M ${xOf(0)} ${yOf(vals[0])}`;
  for (let i = 1; i < n; i++) topPath += ` L ${xOf(i)} ${yOf(vals[i])}`;
  const areaPath = `${topPath} L ${W} ${H} L 0 ${H} Z`;

  const rising = vals[n - 1] >= vals[n - 2] - 0.05;
  const stroke = rising ? 'rgba(52,199,89,0.85)' : 'rgba(255,69,58,0.80)';
  const gradId = `vo2Trend_${rising ? 'up' : 'dn'}`;

  const firstDate = data[0].date.slice(5);
  const lastDate = data[n - 1].date.slice(5);

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="100" preserveAspectRatio="none" style="display:block">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${stroke}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${stroke}" stop-opacity="0.04"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#${gradId})"/>
      <path d="${topPath}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>
    <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:9px;color:var(--c-faint)">
      <span>${firstDate}</span>
      <span>${lastDate}</span>
    </div>`;
}

/** Collect a single VO2max history series. Prefers device history when fresh
 *  (physiologyHistory[].vo2max), falls back to vdotHistory. Used on the
 *  detail page trend chart. */
function getHeadlineHistory(s: SimulatorState): Array<{ date: string; value: number }> {
  const deviceHist = (s.physiologyHistory ?? [])
    .filter(d => d.vo2max != null && d.vo2max > 0 && d.date)
    .map(d => ({ date: d.date, value: d.vo2max as number }));
  if (deviceHist.length >= 2) return deviceHist;
  return (s.vdotHistory ?? [])
    .filter(h => h.date != null && h.vdot > 0)
    .map(h => ({ date: h.date as string, value: h.vdot }));
}

const SOURCE_LABEL: Record<'running' | 'cycling' | 'cardiac', string> = {
  running: 'running',
  cycling: 'cycling',
  cardiac: 'cardiovascular fitness',
};

const SOURCE_DOT: Record<'running' | 'cycling' | 'cardiac' | 'crossTraining', string> = {
  running: '#7B9E89',  // sage green (run accent)
  cycling: '#C58D6A',  // warm clay (bike accent)
  cardiac: '#D97757',  // accent
  crossTraining: '#9C8FB5',  // muted lavender — distinct from run/bike/cardiac
};

function tierLabel(vo2: number, isFemale: boolean): string {
  const breaks = isFemale ? [28, 35, 45, 55, 65] : [35, 42, 52, 60, 70];
  const labels = ['Building', 'Foundation', 'Trained', 'Well-Trained', 'Performance', 'Elite'] as const;
  const idx = breaks.findIndex(b => vo2 < b);
  return labels[idx === -1 ? 5 : idx];
}

function fmtVO2(v: number | null): string {
  if (v == null || !isFinite(v)) return '—';
  return Math.round(v).toString();
}

function confLabel(c: VO2Confidence): string {
  if (c === 'high') return 'High confidence';
  if (c === 'medium') return 'Medium confidence';
  if (c === 'low') return 'Low confidence';
  return '—';
}

function row(
  key: 'running' | 'cycling' | 'cardiac' | 'crossTraining',
  label: string,
  est: VO2Estimate,
  isLast: boolean,
): string {
  const valueDisplay = fmtVO2(est.value);
  const conf = est.value != null ? confLabel(est.confidence) : 'No data yet';
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0${isLast ? '' : ';border-bottom:1px solid var(--c-border)'}">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="width:6px;height:6px;border-radius:50%;background:${SOURCE_DOT[key]};display:inline-block"></span>
        <span style="font-size:13px;color:var(--c-muted)">${label}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums">
        <span style="font-size:13px;font-weight:600;color:var(--c-black)">${valueDisplay}</span>
        <span style="font-size:12px;color:var(--c-faint)">·</span>
        <span style="font-size:12px;color:var(--c-muted)">${conf}</span>
      </div>
    </div>`;
}

/**
 * Resolve the headline that the card should display, honouring the source
 * toggle. When toggle = 'device' (or mosaic has no signal), pull `s.vo2`
 * from the watch. Otherwise use our orchestrator-computed headline. This is
 * what makes the toggle actually switch the displayed number.
 */
function resolveDisplayHeadline(s: SimulatorState): {
  value: number | null;
  sport: 'running' | 'cycling' | 'cardiac' | 'device' | null;
  caption: string;
  isFromDevice: boolean;
} {
  const est = s.vo2Estimates;
  const mosaicVal = est?.headline.value ?? null;
  const deviceVal = s.vo2 ?? null;
  const deviceFresh = deviceVal != null && deviceVal > 0;

  // Manual override wins over both Mosaic and Watch. Mirrors the LT
  // priority chain (override > Garmin > derived) for consistency.
  if (s.vo2Override) {
    return {
      value: s.vo2Override.value,
      sport: null,
      caption: 'Manually set',
      isFromDevice: false,
    };
  }

  const useDevice = deviceFresh
    && (s.vo2Source === 'device' || mosaicVal == null);

  if (useDevice) {
    return {
      value: deviceVal,
      sport: 'device',
      caption: 'From your watch',
      isFromDevice: true,
    };
  }

  if (mosaicVal != null && est) {
    const sportLabel = est.headline.sport ? SOURCE_LABEL[est.headline.sport] : '—';
    return {
      value: mosaicVal,
      sport: est.headline.sport,
      caption: `best demonstrated in ${sportLabel}`,
      isFromDevice: false,
    };
  }

  return { value: null, sport: null, caption: '', isFromDevice: false };
}

/**
 * Build the VO2max card HTML. Returns empty string when the orchestrator
 * has not produced any usable estimate (fresh install, no activity).
 *
 * @param s         SimulatorState
 * @param elementId DOM id for the outer card — drives drill-down click handler.
 */
export function buildVO2MaxCard(s: SimulatorState, elementId: string): string {
  const est = s.vo2Estimates;
  const display = resolveDisplayHeadline(s);
  if (display.value == null || !est) return '';

  const isFemale = s.biologicalSex === 'female';
  const headlineVal = display.value;
  const tier = tierLabel(headlineVal, isFemale);

  return `
    <div id="${elementId}" style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:16px 18px;cursor:pointer;margin-bottom:14px;-webkit-tap-highlight-color:transparent">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">VO2max</div>
        <span style="font-size:11px;color:var(--c-muted)">Detail →</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
        <div style="font-size:36px;font-weight:200;letter-spacing:-0.04em;line-height:1;color:var(--c-black);font-variant-numeric:tabular-nums">${Math.round(headlineVal)}</div>
        <div style="font-size:12px;color:var(--c-muted)">${tier} · ${display.caption}</div>
      </div>
      <div style="margin-top:10px">
        ${(() => {
          const showCT = est.crossTraining.value != null;
          const ctRow = showCT ? row('crossTraining', 'Cross-training', est.crossTraining, true) : '';
          if (isCyclingOnlyMode(s)) {
            return `
              ${row('cycling', 'Cycling', est.cycling, false)}
              ${row('cardiac', 'Cardiac ceiling', est.cardiac, !showCT)}
              ${ctRow}`;
          }
          return `
            ${row('running', 'Running', est.running, false)}
            ${row('cycling', 'Cycling', est.cycling, false)}
            ${row('cardiac', 'Cardiac ceiling', est.cardiac, !showCT)}
            ${ctRow}`;
        })()}
      </div>
    </div>`;
}

/**
 * Wire the inline source toggle on the detail page. Host calls this after
 * setting innerHTML. `onChange` is called when the user picks a source so
 * the host can re-render with the new value.
 */
export function wireVO2MaxDetailHandlers(onChange: () => void): void {
  document.getElementById('vo2-detail-source-mosaic')?.addEventListener('click', () => {
    getMutableState().vo2Source = 'mosaic';
    saveState();
    onChange();
  });
  document.getElementById('vo2-detail-source-device')?.addEventListener('click', () => {
    const s = getState();
    if (!(s.vo2 != null && s.vo2 > 0)) return;
    getMutableState().vo2Source = 'device';
    saveState();
    onChange();
  });
  document.getElementById('vo2-set-weight-btn')?.addEventListener('click', () => {
    import('@/ui/triathlon/bike-setup-view').then(({ openBikeSetupOverlay }) => openBikeSetupOverlay());
  });
}

/**
 * Drill-down detail view content for the VO2max card. Renders into the
 * existing detail view container of the host stats view.
 */
export function buildVO2MaxDetailHTML(s: SimulatorState): string {
  const est = s.vo2Estimates;
  if (!est) return '<div style="padding:20px;color:var(--c-muted)">No VO2max data yet.</div>';

  const isFemale = s.biologicalSex === 'female';
  const display = resolveDisplayHeadline(s);
  const headlineVal = display.value;
  const tier = headlineVal != null ? tierLabel(headlineVal, isFemale) : '—';

  const sourceCaption = (e: VO2Estimate): string => {
    if (e.value == null) return 'No data yet.';
    return e.detail ?? '';
  };

  const cyclingNeedsWeight = est.cycling.detail?.includes('default body weight') ?? false;

  return `
    <div style="padding:20px 18px">
      <div style="font-size:24px;font-weight:300;color:var(--c-black);margin-bottom:4px">VO2max</div>
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px">Oxygen your body can use at peak effort, per kg bodyweight.</div>

      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:8px">Headline</div>
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:12px">
          <div style="font-size:48px;font-weight:200;letter-spacing:-0.04em;line-height:1;color:var(--c-black);font-variant-numeric:tabular-nums">${headlineVal != null ? Math.round(headlineVal) : '—'}</div>
          <div style="font-size:13px;color:var(--c-muted)">${tier}<br><span style="font-size:11px;color:var(--c-faint)">${display.caption}</span></div>
        </div>
        ${(() => {
          const hist = getHeadlineHistory(s);
          return hist.length >= 2 ? buildVO2TrendChart(hist) : '';
        })()}
      </div>

      ${(() => {
        const hasDevice = s.vo2 != null && s.vo2 > 0;
        const useMosaic = (s.vo2Source ?? 'mosaic') === 'mosaic';
        const offStyle = `padding:6px 16px;font-size:13px;font-weight:500;cursor:${hasDevice ? 'pointer' : 'not-allowed'};border:none;${!useMosaic ? 'background:var(--c-black);color:#fff' : 'background:transparent;color:var(--c-muted)'}`;
        const onStyle = `padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;border:none;${useMosaic ? 'background:var(--c-black);color:#fff' : 'background:transparent;color:var(--c-muted)'}`;
        return `
          <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:14px 18px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:16px">
            <div>
              <div style="font-size:13px;color:var(--c-black)">Source</div>
              <div style="font-size:11px;color:var(--c-faint);margin-top:2px">${hasDevice ? 'Choose between our estimate and your watch reading.' : 'Watch reading not available yet.'}</div>
            </div>
            <div style="display:flex;border:1px solid var(--c-border-strong);border-radius:8px;overflow:hidden;flex-shrink:0">
              <button id="vo2-detail-source-device"${hasDevice ? '' : ' disabled'} style="${offStyle}">Device</button>
              <button id="vo2-detail-source-mosaic" style="${onStyle}">Mosaic</button>
            </div>
          </div>`;
      })()}

      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">By sport</div>
        <div style="font-size:11px;color:var(--c-muted);margin-bottom:14px;line-height:1.4">Running and cycling are <strong style="color:var(--c-black)">measured</strong> from your training data. Cardiac ceiling is your <strong style="color:var(--c-black)">aerobic upper bound</strong> from peak HR ÷ resting HR — a theoretical ceiling, not current fitness. Cross-training, when shown, is the sustained-aerobic capacity you've demonstrated in non-run, non-bike sport.</div>

        ${isCyclingOnlyMode(s) ? '' : `
        <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--c-border)">
          <div style="display:flex;align-items:baseline;justify-content:space-between">
            <div style="font-size:13px;font-weight:600;color:var(--c-black)">Running</div>
            <div style="font-size:14px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtVO2(est.running.value)}</div>
          </div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:3px">${sourceCaption(est.running)}</div>
        </div>
        `}

        <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--c-border)">
          <div style="display:flex;align-items:baseline;justify-content:space-between">
            <div style="font-size:13px;font-weight:600;color:var(--c-black)">Cycling</div>
            <div style="font-size:14px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtVO2(est.cycling.value)}</div>
          </div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:3px">${sourceCaption(est.cycling)}</div>
          ${cyclingNeedsWeight ? `<button id="vo2-set-weight-btn" style="margin-top:6px;font-size:11px;color:var(--c-muted);background:transparent;border:1px solid var(--c-border);border-radius:6px;padding:3px 10px;cursor:pointer">Set body weight →</button>` : ''}
        </div>

        ${(() => {
          const ceiling = est.cardiac.value;
          const bestSport = est.running.value ?? est.cycling.value;
          const pct = ceiling != null && bestSport != null ? Math.round((bestSport / ceiling) * 100) : null;
          const gap = ceiling != null && bestSport != null ? Math.round(ceiling - bestSport) : null;
          const implication = pct != null && gap != null
            ? `Your best measured sport sits at ${pct}% of this ceiling. The ${gap}-point gap is theoretical headroom — what your cardiac function could support if economy and sport-specific fitness improved. Not a target to chase.`
            : '';
          const showCT = est.crossTraining.value != null;
          return `
        <div${showCT ? ';margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--c-border)' : ''}>
          <div style="display:flex;align-items:baseline;justify-content:space-between">
            <div style="font-size:13px;font-weight:600;color:var(--c-black)">Cardiac ceiling</div>
            <div style="font-size:14px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtVO2(ceiling)}</div>
          </div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:3px">${sourceCaption(est.cardiac)}</div>
          ${implication ? `<div style="font-size:11px;color:var(--c-black);margin-top:5px;line-height:1.4">${implication}</div>` : ''}
        </div>
        ${showCT ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--c-border)">
          <div style="display:flex;align-items:baseline;justify-content:space-between">
            <div style="font-size:13px;font-weight:600;color:var(--c-black)">Cross-training</div>
            <div style="font-size:14px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtVO2(est.crossTraining.value)}</div>
          </div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:3px">${sourceCaption(est.crossTraining)}</div>
          <div style="font-size:11px;color:var(--c-black);margin-top:5px;line-height:1.4">Aerobic capacity demonstrated in non-run, non-bike sport. Independent of running and cycling — does not lift them.</div>
        </div>` : ''}`;
        })()}
      </div>

      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:10px">How we estimate</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.7">
          <strong style="color:var(--c-black)">Running</strong>: pace and HR from recent steady runs, regressed against %VO2 reserve (Swain-Daniels). Falls back to race-distance PBs when HR data is sparse.<br>
          <strong style="color:var(--c-black)">Cycling</strong>: FTP divided by bodyweight via the ACSM ergometry equation.<br>
          <strong style="color:var(--c-black)">Cardiac ceiling</strong>: peak HR ÷ resting HR (Uth-Sørensen 2004, r = 0.82 vs lab tests). An aerobic upper bound — the maximum VO2max your cardiac function could support if you trained perfectly. Not a measure of current fitness; not an empirical VO2max.<br>
          <strong style="color:var(--c-black)">Cross-training</strong>: sustained-HR fraction (%HRR ≈ %VO2R, Swain &amp; Leutholtz 1997) anchored to your cardiac ceiling, across sessions ≥ 20 min at ≥ 75% HRmax. Hidden until at least 3 qualifying sessions.
        </div>
      </div>

    </div>`;
}
