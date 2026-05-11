/**
 * MusculoTendon Load (MTL) detail page — eccentric / mechanical strain across
 * all HYROX sessions: runs, station work, and bricks.
 *
 * Opens from the MTL factor card on Readiness and the MTL card on Hyrox Stats.
 * Mirrors leg-load-view's structure: hero ring, contributors list, explainer —
 * extended with a 12-week chronic / acute PMC chart (analogous to the running
 * CTL/ATL surface) and a discipline split.
 *
 * MTL is `durationMin × sRPE × modality × impact × (1 + externalLoad)` per
 * component, summed to a weekly value, then exponentially smoothed into chronic
 * (42d τ) and acute (7d τ) EMAs in `src/calculations/mtl.ts`. The discipline
 * split uses run/station/brick coefficients — running has lower per-minute MTL
 * than station work but accumulates over more weekly minutes, so it is often
 * the largest single chronic contributor.
 */

import { getState } from '@/state';
import { computeMTLFitnessFatigue, computeMTLFitnessFatigueByDiscipline, computeWeekActualMTL, computeWeekMTL } from '@/calculations/mtl';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';
import { atmosphereGradient } from './page-flair';

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const TEXT_L = '#94A3B8';
const RING_R = 46;
const RING_C = +(2 * Math.PI * RING_R).toFixed(2);

// Bronze hero (matches Hyrox-mode accents elsewhere); ACWR zone colours follow
// the readiness palette.
const ZONE_SAFE    = '#7a845c';
const ZONE_CAUTION = '#F59E0B';
const ZONE_HIGH    = '#DC2626';
const HERO_BRONZE  = '#b8742c';

function acwrZone(acwr: number | null, ctl: number, atl: number): { label: string; colour: string; note: string } {
  if (acwr == null) {
    // Chronic hasn't crossed the 15 daily-equivalent threshold for the ramp signal
    // to be reliable. Acknowledge the visible acute/chronic relationship rather
    // than saying "no signal" — Tristan's feedback 2026-05-08.
    if (ctl > 0 && atl > ctl * 1.5) {
      return {
        label: 'Building',
        colour: TEXT_M,
        note: `Chronic base is still building (${ctl.toFixed(1)}, ramp rate becomes meaningful at 15). Acute is ${(atl / ctl).toFixed(1)}× chronic but absolute load is still low.`,
      };
    }
    return { label: 'Building', colour: TEXT_M, note: 'Chronic base is still building. Ramp rate will become meaningful once chronic load crosses 15.' };
  }
  if (acwr > 1.5)  return { label: 'Ease Back', colour: ZONE_HIGH, note: 'Acute load spiked relative to your chronic base. Skip or downgrade density sessions.' };
  if (acwr > 1.3)  return { label: 'Manage Load', colour: ZONE_CAUTION, note: 'Mechanical load is elevated. Avoid adding extra eccentric work this week.' };
  return { label: 'Safe', colour: ZONE_SAFE, note: 'Mechanical load is progressing within a safe ramp.' };
}

function statusHeadline(weeklyActual: number, cap: number, acwr: number | null): string {
  if (cap <= 0) return 'No cap set yet.';
  const pct = Math.round((weeklyActual / cap) * 100);
  if (acwr != null && acwr > 1.5)
    return `Acute load is ${acwr.toFixed(2)}× your chronic base. Reduce volume this week before adding density work.`;
  if (acwr != null && acwr > 1.3)
    return `Load is climbing fast (${acwr.toFixed(2)}× base). Hold this week's volume.`;
  if (weeklyActual === 0)
    return 'No station work completed this week yet.';
  if (pct >= 90)
    return `Near your weekly cap (${pct}% of ${Math.round(cap)}). Treat further volume as discretionary.`;
  if (pct >= 60)
    return `On target for the week (${pct}% of cap). Eccentric load is in the productive zone.`;
  return `${pct}% of weekly cap. Room to add volume if recovery allows.`;
}

// ── PMC chart (12-week chronic + acute) ────────────────────────────────────

interface PMCPoint { weekIdx: number; ctl: number; atl: number }

function buildPMCChart(points: PMCPoint[]): string {
  // Need at least 3 weeks for a meaningful curve. With one or two points the
  // line collapses (no L segments) and the chart renders as an empty area.
  if (points.length < 3) {
    return `<div style="font-size:13px;color:${TEXT_S};text-align:center;padding:32px 12px;line-height:1.45">Trend appears after 3 weeks of training data.<br><span style="color:${TEXT_L};font-size:12px">Currently ${points.length} week${points.length === 1 ? '' : 's'} of plan history.</span></div>`;
  }

  const W = 320, H = 130;
  const PAD_L = 4, PAD_R = 4, PAD_T = 8, PAD_B = 4;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const maxY = Math.max(1, ...points.map(p => Math.max(p.ctl, p.atl)));
  const x = (i: number) => PAD_L + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - (v / maxY) * plotH;
  const yBase = PAD_T + plotH;

  const lineD = (key: 'ctl' | 'atl') =>
    `M ${x(0).toFixed(1)} ${y(points[0][key]).toFixed(1)} ` +
    points.slice(1).map((p, i) => `L ${x(i + 1).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');

  const ctlAreaD =
    `M ${x(0).toFixed(1)} ${yBase.toFixed(1)} ` +
    points.map((p, i) => `L ${x(i).toFixed(1)} ${y(p.ctl).toFixed(1)}`).join(' ') +
    ` L ${x(points.length - 1).toFixed(1)} ${yBase.toFixed(1)} Z`;

  return `
    <svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:130px;display:block">
      <path d="${ctlAreaD}" fill="${TEXT_M}" opacity="0.10"/>
      <path d="${lineD('ctl')}" fill="none" stroke="${TEXT_M}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <path d="${lineD('atl')}" fill="none" stroke="${HERO_BRONZE}" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="4 3" opacity="0.85" vector-effect="non-scaling-stroke"/>
    </svg>
  `;
}

// ── Page HTML ──────────────────────────────────────────────────────────────

function getMtlLoadHTML(): string {
  const s = getState();
  const hx = s.hyroxConfig;
  const weeks = s.wks ?? [];
  const wIdx = Math.max(0, Math.min(s.w ?? 0, weeks.length - 1));

  // Derived at render time — `hyroxConfig.weeklyActualMTL` is a dead field
  // (typed but never written); deriving here keeps actual / planned /
  // chronic / acute on a single source. See ISSUE-184 history.
  const currentWk = weeks[wIdx];
  const weeklyActual = currentWk ? computeWeekActualMTL(currentWk) : 0;
  const weeklyPlanned = currentWk ? computeWeekMTL(currentWk) : (hx?.weeklyMTL ?? 0);
  const cap = hx?.mtlCap ?? 0;
  const ctl = hx?.mtlCTL ?? 0;
  const atl = hx?.mtlATL ?? 0;
  // Match the readiness gating: ACWR only meaningful once chronic load is established.
  const acwr = ctl >= 15 ? atl / ctl : null;
  const zone = acwrZone(acwr, ctl, atl);

  const capPct = cap > 0 ? Math.min(1, weeklyActual / cap) : 0;
  const plannedPct = cap > 0 ? Math.min(1, weeklyPlanned / cap) : 0;
  const ringPct = Math.round(capPct * 100);
  const ringCol = acwr != null && acwr > 1.5 ? ZONE_HIGH
    : acwr != null && acwr > 1.3 ? ZONE_CAUTION
    : HERO_BRONZE;
  const targetOffset = (RING_C * (1 - ringPct / 100)).toFixed(2);

  // ── 12-week PMC trail ──
  const trailStart = Math.max(0, wIdx - 11);
  const pmcPoints: PMCPoint[] = [];
  for (let i = trailStart; i <= wIdx; i++) {
    const r = computeMTLFitnessFatigue(weeks, i);
    pmcPoints.push({ weekIdx: i, ctl: r.mtlCTL, atl: r.mtlATL });
  }

  // ── Discipline split (current week index) ──
  const disc = weeks.length > 0 ? computeMTLFitnessFatigueByDiscipline(weeks, wIdx) : null;
  const discTotal = disc ? (disc.runMtlCTL + disc.stationMtlCTL + disc.brickMtlCTL) : 0;

  // ── This week's contributors ──
  const contributors = (currentWk?.triWorkouts ?? [])
    .map(w => ({
      name: (w as { discipline?: string }).discipline === 'station' ? 'Station session'
        : (w as { discipline?: string }).discipline === 'brick' ? 'Brick session'
        : (w.t || 'Run'),
      discipline: ((w as { discipline?: string }).discipline ?? 'run') as 'run' | 'station' | 'brick',
      mtl: w.musculoTendonLoad ?? 0,
      done: !!w.matchedActivityId,
      day: w.dayOfWeek ?? 0,
    }))
    .filter(c => c.mtl > 0)
    .sort((a, b) => a.day - b.day);

  const card = (content: string, id?: string) =>
    `<div ${id ? `id="${id}"` : ''} style="background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin-bottom:12px">${content}</div>`;

  // PMC card
  const hasTrend = pmcPoints.length >= 3;
  const pmcCard = card(`
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
      <div style="font-size:11px;color:${TEXT_S};font-weight:500">12-week trend</div>
      <div style="font-size:10px;color:${TEXT_L}">daily-equivalent</div>
    </div>
    <div style="display:flex;gap:24px;margin-bottom:10px">
      <div>
        <div style="font-size:10px;color:${TEXT_L};text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:2px">Chronic</div>
        <div style="font-size:22px;font-weight:600;color:${TEXT_M};line-height:1;font-variant-numeric:tabular-nums">${ctl.toFixed(1)}</div>
      </div>
      <div>
        <div style="font-size:10px;color:${TEXT_L};text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:2px">Acute</div>
        <div style="font-size:22px;font-weight:600;color:${HERO_BRONZE};line-height:1;font-variant-numeric:tabular-nums">${atl.toFixed(1)}</div>
      </div>
    </div>
    ${buildPMCChart(pmcPoints)}
    ${hasTrend ? `
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9px;color:${TEXT_L}">
        <span>${pmcPoints.length}w ago</span>
        <span>now</span>
      </div>
      <div style="display:flex;gap:14px;margin-top:10px;font-size:11px;color:${TEXT_S}">
        <span><span style="display:inline-block;width:10px;height:2px;background:${TEXT_M};vertical-align:middle;margin-right:4px"></span>Chronic (42d)</span>
        <span><span style="display:inline-block;width:10px;height:2px;background:${HERO_BRONZE};opacity:0.85;vertical-align:middle;margin-right:4px"></span>Acute (7d)</span>
      </div>
    ` : ''}
  `);

  // ACWR card
  const acwrCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Load Ratio</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div style="font-size:24px;font-weight:600;color:${zone.colour};line-height:1">${acwr != null ? acwr.toFixed(2) + '×' : '—'}</div>
      <div style="font-size:13px;color:${TEXT_L}">${zone.label}</div>
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${zone.note}</div>
  `);

  // Discipline split card
  const discCard = (disc && discTotal > 0.1) ? (() => {
    const pct = (v: number) => discTotal > 0 ? Math.round((v / discTotal) * 100) : 0;
    const runP = pct(disc.runMtlCTL);
    const stP = pct(disc.stationMtlCTL);
    const brP = pct(disc.brickMtlCTL);
    return card(`
      <div style="font-size:11px;color:${TEXT_S};margin-bottom:10px;font-weight:500">Where chronic load comes from</div>
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-bottom:10px;background:rgba(0,0,0,0.05)">
        <div style="width:${stP}%;background:${HERO_BRONZE}"></div>
        <div style="width:${brP}%;background:#a16207"></div>
        <div style="width:${runP}%;background:${TEXT_M};opacity:0.45"></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px">
        <div>
          <div style="display:flex;align-items:center;gap:6px;color:${TEXT_S}"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${HERO_BRONZE}"></span>Station</div>
          <div style="font-size:14px;font-weight:600;color:${TEXT_M};margin-top:2px">${disc.stationMtlCTL.toFixed(1)} <span style="font-size:11px;color:${TEXT_L};font-weight:400">(${stP}%)</span></div>
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:6px;color:${TEXT_S}"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#a16207"></span>Brick</div>
          <div style="font-size:14px;font-weight:600;color:${TEXT_M};margin-top:2px">${disc.brickMtlCTL.toFixed(1)} <span style="font-size:11px;color:${TEXT_L};font-weight:400">(${brP}%)</span></div>
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:6px;color:${TEXT_S}"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${TEXT_M};opacity:0.45"></span>Run</div>
          <div style="font-size:14px;font-weight:600;color:${TEXT_M};margin-top:2px">${disc.runMtlCTL.toFixed(1)} <span style="font-size:11px;color:${TEXT_L};font-weight:400">(${runP}%)</span></div>
        </div>
      </div>
    `);
  })() : '';

  // Contributors card
  const dayName = (d: number) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d] ?? `Day ${d + 1}`;
  const contributorsCard = contributors.length === 0
    ? card(`
        <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">This week</div>
        <div style="font-size:13px;color:${TEXT_S};line-height:1.45">No station or brick sessions planned this week.</div>
      `)
    : card(`
        <div style="font-size:11px;color:${TEXT_S};margin-bottom:4px;font-weight:500">This week</div>
        ${contributors.map(c => `
          <div style="padding:10px 0;border-top:1px solid #F1F5F9">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:2px">
              <div style="font-size:13px;font-weight:600;color:${TEXT_M}">${c.name}</div>
              <div style="font-size:11px;color:${TEXT_L}">${dayName(c.day)}</div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <div style="font-size:11px;color:${TEXT_S}">${c.discipline === 'station' ? 'Station' : c.discipline === 'brick' ? 'Brick' : 'Run'} · ${Math.round(c.mtl)} MTL</div>
              <div style="font-size:11px;color:${c.done ? ZONE_SAFE : TEXT_L}">${c.done ? 'completed' : 'planned'}</div>
            </div>
          </div>
        `).join('')}
      `);

  // Explainer card
  const explainerCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">How it works</div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.55">
      <p style="margin:0 0 10px">MusculoTendon Load (MTL) tracks eccentric and mechanical strain across every session in your Hyrox plan: runs, stations, and bricks. It is a separate currency to aerobic TSS — a sled push and a tempo run can have similar TSS but very different tissue cost.</p>
      <p style="margin:0 0 10px">Per session: <code style="font-family:var(--f-mono,monospace);font-size:12px">duration × RPE × modality × impact × (1 + external load)</code>. Stations carry heavier per-minute coefficients than runs, but runs accumulate more weekly minutes — so runs often dominate chronic load even though stations dominate acute spikes.</p>
      <p style="margin:0 0 10px">Chronic (42-day EMA) tracks your absorbed mechanical base from <strong>completed</strong> work — only sessions matched to a Strava or Garmin activity contribute. Acute (7-day EMA) tracks the last week of completed work. Until you match activities, both are zero. The ratio of acute to chronic is the ramp rate — above 1.3× caps readiness at Manage Load, above 1.5× at Ease Back.</p>
      <p style="margin:0;color:${TEXT_L}">Weekly cap (${cap > 0 ? Math.round(cap) : '—'}) is set from your ability band and refines as benchmark tests calibrate. Independent of TSB and HRV — eccentric tissue recovers slower than cardiovascular load.</p>
    </div>
  `);

  return `
    <style>
      #mtl-view { box-sizing:border-box; }
      #mtl-view *, #mtl-view *::before, #mtl-view *::after { box-sizing:inherit; }
      @keyframes mtlFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .mtl-fade { opacity:0; animation:mtlFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('mtl')}
    </style>

    <div id="mtl-view" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('blue')};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${buildSkyBackground('mtl', 'sage')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="mtl-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em">MusculoTendon Load</div>
          <div style="width:36px"></div>
        </div>

        <!-- Hero ring -->
        <div class="mtl-fade" style="animation-delay:0.05s;display:flex;flex-direction:column;align-items:center;margin:12px 0 28px">
          <div style="
            position:relative;width:220px;height:220px;
            display:flex;align-items:center;justify-content:center;
            background:rgba(255,255,255,0.55);backdrop-filter:blur(16px);
            border-radius:50%;border:1px solid rgba(255,255,255,0.6);
            box-shadow:0 6px 40px -8px rgba(0,0,0,0.15);
          ">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="8"/>
              ${weeklyPlanned > 0 ? `<circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="${HERO_BRONZE}" stroke-opacity="0.22" stroke-width="8" stroke-linecap="round" stroke-dasharray="${RING_C}" stroke-dashoffset="${(RING_C * (1 - plannedPct)).toFixed(2)}" />` : ''}
              <circle id="mtl-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="${ringCol}" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}"
                stroke-dashoffset="${RING_C}"
                data-target-offset="${targetOffset}"
                style="transition:stroke-dashoffset 1.2s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
              />
            </svg>
            <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div style="font-size:44px;font-weight:700;letter-spacing:-0.03em;line-height:1;color:${ringCol}">${Math.round(weeklyActual)}</div>
              <div style="font-size:11px;font-weight:500;color:${TEXT_S};margin-top:6px">of ${cap > 0 ? Math.round(cap) : '—'} cap</div>
              ${weeklyPlanned > 0 && weeklyPlanned !== weeklyActual ? `<div style="font-size:10px;color:${TEXT_L};margin-top:2px">${Math.round(weeklyPlanned)} planned</div>` : ''}
            </div>
          </div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:16px;text-align:center;padding:0 32px;line-height:1.45">${statusHeadline(weeklyActual, cap, acwr)}</div>
        </div>

        <!-- Cards -->
        <div class="mtl-fade" style="animation-delay:0.18s;padding:0 16px">
          ${pmcCard}
          ${acwrCard}
          ${discCard}
          ${contributorsCard}
          ${explainerCard}
        </div>

      </div>
    </div>
    ${renderTabBar('home')}
  `;
}

// ── Navigation ─────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'forecast') import('./triathlon/forecast-view').then(m => m.renderTriathlonForecastView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
}

function wireHandlers(onBack: () => void): void {
  setTimeout(() => {
    const circle = document.getElementById('mtl-ring-circle');
    const target = (circle as HTMLElement | null)?.dataset.targetOffset;
    if (circle && target) circle.style.strokeDashoffset = target;
  }, 50);

  wireTabBarHandlers(navigateTab);
  document.getElementById('mtl-back-btn')?.addEventListener('click', () => onBack());
}

// ── Public entry point ─────────────────────────────────────────────────────

export function renderMtlLoadView(onBack?: () => void): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = getMtlLoadHTML();
  const back = onBack ?? (() => import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView()));
  wireHandlers(back);
}
