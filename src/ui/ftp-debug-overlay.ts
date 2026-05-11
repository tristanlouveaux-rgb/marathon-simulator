/**
 * FTP debug overlay — surfaced from the Bike FTP card when the estimator
 * couldn't land a number despite having bike rides synced, OR on demand.
 * Renders the funnel breakdown and top candidates from `FtpEstimate.diagnostics`
 * so the user can self-diagnose ("ah, my rides are too short / Strava hasn't
 * processed the watts streams yet / etc") instead of needing a debug round-trip.
 *
 * Built specifically for the recurring FTP regression class — see
 * `docs/CHANGELOG.md` 2026-05-01 entry. The visibility this overlay provides
 * is the "make sure it doesn't keep happening" defence.
 */

import type { FtpEstimate } from '@/calculations/tri-benchmarks-from-history';

const OVERLAY_ID = 'ftp-debug-overlay';

function fmtDate(iso?: string): string {
  if (!iso) return '?';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '?';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtFlag(dw: boolean | null): string {
  if (dw === true) return '<span style="color:#16A34A;font-weight:600">true</span>';
  if (dw === false) return '<span style="color:#DC2626;font-weight:600">false</span>';
  return '<span style="color:#64748B">null</span>';
}

export function openFtpDebugOverlay(estimate: FtpEstimate): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const d = estimate.diagnostics;
  const ftpVal = estimate.ftpWatts != null ? `${estimate.ftpWatts} W` : '—';
  const conf = estimate.confidence;
  const src = estimate.ftpWatts == null ? 'no source'
    : estimate.sourceWindow === 'whole-ride' ? 'fallback (whole-ride NP × 1.0)'
    : `curve, ${estimate.sourceWindow} window`;

  // Headline copy depends on whether we have an FTP at all.
  const headline = estimate.ftpWatts == null
    ? d && d.totalRides > 0
      ? `${d.totalRides} bike ride${d.totalRides === 1 ? '' : 's'} synced, no FTP derived`
      : 'No bike rides found'
    : conf === 'high'
      ? `FTP ${ftpVal} (high confidence)`
      : `FTP ${ftpVal}, confidence: ${conf}`;

  const subhead = estimate.ftpWatts == null
    ? 'Here\'s why no number landed and what would unblock it.'
    : 'Source ride and how the funnel ranked your candidates.';

  // Inventory block — coverage of power data on bike rides.
  const inventoryHtml = d ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-size:13px;color:#0F172A">
      <div><span style="color:#64748B">Total rides</span> ${d.totalRides}</div>
      <div><span style="color:#64748B">With power curve</span> ${d.withCurve}</div>
      <div><span style="color:#64748B">With NP</span> ${d.withNP}</div>
      <div><span style="color:#64748B">With avg watts</span> ${d.withAvgWatts}</div>
      <div><span style="color:#64748B">device_watts: true</span> ${d.withDeviceWattsTrue}</div>
      <div><span style="color:#64748B">device_watts: false</span> ${d.withDeviceWattsFalse}</div>
    </div>
  ` : '';

  // Funnel block — only meaningful when fallback path ran (curve path leaves
  // funnel zeroed). Show only when fallback was used or no FTP was derived.
  const funnelMatters = d && (d.funnel.noUsablePower > 0 || d.funnel.tooShort > 0 || d.funnel.tooOld > 0);
  const funnelHtml = funnelMatters ? `
    <div style="font-size:12px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.06em;margin-top:18px;margin-bottom:8px">Why rides were rejected</div>
    <div style="font-size:13px;color:#0F172A;line-height:1.6">
      ${d!.funnel.noUsablePower > 0 ? `<div><span style="color:#64748B">No usable power (NP &amp; avg ≤ 120 W)</span>: ${d!.funnel.noUsablePower}</div>` : ''}
      ${d!.funnel.tooShort > 0 ? `<div><span style="color:#64748B">Too short (&lt; 20 min)</span>: ${d!.funnel.tooShort}</div>` : ''}
      ${d!.funnel.tooOld > 0 ? `<div><span style="color:#64748B">Too old (&gt; 12 weeks)</span>: ${d!.funnel.tooOld}</div>` : ''}
    </div>
  ` : '';

  // Top candidates — empty when curve path was used.
  const candidatesHtml = d && d.topCandidates.length > 0 ? `
    <div style="font-size:12px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.06em;margin-top:18px;margin-bottom:8px">Top candidates (NP-ranked)</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${d.topCandidates.map((c, i) => `
        <div style="font-size:12px;color:#0F172A;padding:10px 12px;border-radius:10px;background:${i === 0 ? 'rgba(59,130,246,0.06)' : 'rgba(0,0,0,0.02)'};border:1px solid ${i === 0 ? 'rgba(59,130,246,0.2)' : 'var(--c-border)'}">
          <div style="font-weight:600;margin-bottom:2px">${fmtDate(c.startISO)} · ${c.durationMin} min ${i === 0 ? '<span style="font-size:10px;font-weight:500;color:#3B82F6;margin-left:6px">PICKED</span>' : ''}</div>
          <div style="color:#64748B">NP=${c.np ?? '—'} W · avg=${c.avgWatts ?? '—'} W · device_watts=${fmtFlag(c.deviceWatts)} · ${c.weeksOld}w old</div>
        </div>
      `).join('')}
    </div>
  ` : '';

  // What to do next — short, scannable. Different copy for the regression
  // case vs the success case.
  const guidanceHtml = estimate.ftpWatts == null && d && d.totalRides > 0 ? `
    <div style="font-size:12px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.06em;margin-top:18px;margin-bottom:8px">Most likely cause</div>
    <div style="font-size:13px;color:#0F172A;line-height:1.55">
      ${d.withCurve === 0 && d.withAvgWatts === 0
        ? 'Strava hasn\'t processed power data on these rides. The watts stream is missing entirely. Try the "Recompute power" button below.'
        : d.withCurve === 0
        ? 'No power curves computed yet. The fallback path is your only option until the edge function fetches the watts streams. Try the "Recompute power" button.'
        : d.funnel.tooOld > 0 && d.funnel.noUsablePower === 0 && d.funnel.tooShort === 0
        ? 'Your power-meter rides are all &gt; 12 weeks old. Do a fresh ride with power data to anchor a new estimate.'
        : 'Funnel breakdown above shows why every ride was rejected. Most common: an estimated-power-only history, or rides too short/old.'}
    </div>
  ` : '';

  overlay.innerHTML = `
    <div class="w-full max-w-md rounded-2xl" style="background:var(--c-surface);overflow:hidden;max-height:85vh;overflow-y:auto">
      <div style="padding:22px 22px 14px;background:linear-gradient(to bottom,rgba(59,130,246,0.06),transparent)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#64748B;margin-bottom:6px">Bike FTP · diagnostics</div>
        <div style="font-size:17px;font-weight:700;color:#0F172A;line-height:1.3;margin-bottom:6px">${headline}</div>
        <div style="font-size:13px;color:#64748B;line-height:1.5">${subhead}</div>
        <div style="font-size:12px;color:#94A3B8;margin-top:6px">Source: ${src}</div>
      </div>

      <div style="padding:14px 22px 0">
        <div style="font-size:12px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">Power data inventory</div>
        ${inventoryHtml}
        ${funnelHtml}
        ${candidatesHtml}
        ${guidanceHtml}
      </div>

      <div style="padding:18px 22px 22px;display:flex;gap:8px">
        <button id="ftp-debug-recompute"
          style="flex:1;padding:12px;border-radius:12px;border:1px solid var(--c-border);background:var(--c-surface);font-size:13px;font-weight:600;color:#0F172A;cursor:pointer;font-family:var(--f)">
          Recompute power
        </button>
        <button id="ftp-debug-close"
          style="flex:1;padding:12px;border-radius:12px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:500;color:#64748B;cursor:pointer;font-family:var(--f)">
          Close
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#ftp-debug-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ftp-debug-recompute')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#ftp-debug-recompute') as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Recomputing…';
    try {
      const { recomputePowerCurves } = await import('@/data/recompute-power-curves');
      const result = await recomputePowerCurves();
      if (result.ok) {
        btn.textContent = `Done · ${result.stored} curves stored`;
        setTimeout(() => { overlay.remove(); window.location.reload(); }, 1200);
      } else {
        btn.textContent = `Failed: ${result.message}`;
        btn.disabled = false;
      }
    } catch (err) {
      btn.textContent = 'Failed (see console)';
      console.error('[ftp-debug-overlay] recompute failed:', err);
      btn.disabled = false;
    }
  });
}
