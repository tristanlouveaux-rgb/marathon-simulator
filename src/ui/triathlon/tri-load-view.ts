/**
 * Triathlon Load page — replaces `load-taper-view` for tri users.
 *
 * Hosts:
 *   - Total combined load (CTL / ATL / Form, weekly-EMA daily-equivalent)
 *   - Per-discipline DIRECT load (own-discipline activity only — NO transfer
 *     matrix spillover, so a user with 0 swims sees 0/0/0 for swim).
 *   - Fitness history chart (per-discipline direct CTL over 12 weeks).
 *   - Workload-ratio chip per discipline (only when ≥3 active weeks).
 *
 * Cross-training transfer is real physiology and IS used by the race
 * predictor internally — but the user-facing display is "what did I actually
 * do in each sport?" because that matches the user's mental model.
 */

import { getState } from '@/state/store';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL } from './colours';
import { readTriFitness, perDisciplineACWR } from '@/calculations/fitness-model.triathlon';
import { computeTriDisciplineConfidence } from '@/calculations/tri-discipline-confidence';

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('../home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('../plan-view').then(({ renderPlanView }) => renderPlanView());
  else if (tab === 'record') import('../record-view').then(({ renderRecordView }) => renderRecordView());
  else if (tab === 'account') import('../account-view').then(({ renderAccountView }) => renderAccountView());
}

export function renderTriLoadView(_returnTo: 'plan' | 'home' = 'home'): void {
  const container = document.getElementById('app-root');
  if (!container) return;

  const s = getState();
  const tri = s.triConfig;
  if (!tri) return;

  const fitness = readTriFitness(s);
  const history = tri.fitnessHistory ?? [];
  const confidence = computeTriDisciplineConfidence(s, 12);

  // Total combined load — sum of direct per-discipline (everything you did),
  // displayed as TrainingPeaks-style daily-equivalent (÷7).
  const totalCtl = (fitness.swim.ctl + fitness.bike.ctl + fitness.run.ctl) / 7;
  const totalAtl = (fitness.swim.atl + fitness.bike.atl + fitness.run.atl) / 7;
  const totalForm = totalCtl - totalAtl;

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hf { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .tri-load-card { background:#fff;border-radius:14px;padding:16px;box-shadow:0 2px 4px rgba(0,0,0,0.04),0 8px 24px rgba(0,0,0,0.05);margin-bottom:14px }
      .tri-load-label { font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#0F172A;margin-bottom:10px }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative;min-height:100vh">
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Header -->
        <div style="padding:48px 20px 20px;display:flex;align-items:center;justify-content:space-between" class="hf" data-delay="0.02">
          <button id="tri-load-back-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">←</button>
          <div style="text-align:center;flex:1">
            <div style="font-size:24px;font-weight:700;color:#0F172A;letter-spacing:-0.02em">Load</div>
            <div style="font-size:13px;color:#64748B;margin-top:2px">${tri.distance === 'ironman' ? 'Ironman' : '70.3'} — Week ${s.w} of ${s.tw}</div>
          </div>
          <div style="width:36px"></div>
        </div>

        <div style="padding:0 20px">

          <!-- Total combined load -->
          <div class="tri-load-card hf" data-delay="0.06">
            <div class="tri-load-label">Total load</div>
            <div style="font-size:11px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">
              Combined fitness, fatigue, and form across all three disciplines. This is your overall training picture — captures the cardiovascular fitness that transfers between sports.
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
              ${cell('Fitness', totalCtl.toFixed(1), '#0F172A')}
              ${cell('Fatigue', totalAtl.toFixed(1), '#0F172A')}
              ${cell('Form', `${totalForm >= 0 ? '+' : ''}${totalForm.toFixed(1)}`, totalForm < -10 ? '#c06a50' : '#0F172A')}
            </div>
          </div>

          <!-- Per-discipline DIRECT (no matrix) -->
          <div class="tri-load-card hf" data-delay="0.10">
            <div class="tri-load-label">By discipline</div>
            <div style="font-size:11px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">
              Direct activity in each sport — what you actually swam / cycled / ran. Cross-training transfer is captured in the total above; here we show the work itself.
            </div>
            ${(['swim', 'bike', 'run'] as const).map((d) => {
              const f = fitness[d];
              const c = DISCIPLINE_COLOURS[d];
              const fitnessVal = f.ctl / 7;
              const fatigueVal = f.atl / 7;
              const formVal    = f.tsb / 7;
              const conf = confidence[d];
              const acwr = perDisciplineACWR(f);
              const hasDirect = conf.sessions > 0;
              const showAcwr = hasDirect && (conf.confidence === 'medium' || conf.confidence === 'high');
              const acwrLabel = showAcwr && acwr !== undefined ? `Workload ratio ${acwr.toFixed(2)}` : '';
              const acwrColour = acwr === undefined ? 'var(--c-faint)'
                : acwr > 1.3 ? '#c06a50'
                : acwr < 0.8 ? '#a89060'
                : '#7a845c';
              return `
                <div style="margin-bottom:14px;padding:12px;border-radius:10px;background:${c.bg};border:1px solid ${c.border}">
                  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
                    <span style="font-size:13px;font-weight:600;color:#0F172A">${DISCIPLINE_LABEL[d]}</span>
                    ${acwrLabel ? `<span style="font-size:11px;color:${acwrColour};font-variant-numeric:tabular-nums">${acwrLabel}</span>` : ''}
                  </div>
                  <div style="display:grid;grid-template-columns:${hasDirect ? '1fr 1fr 1fr' : '1fr 1fr'};gap:8px">
                    ${cell('Fitness', fitnessVal.toFixed(1))}
                    ${cell('Fatigue', fatigueVal.toFixed(1))}
                    ${hasDirect ? cell('Form', `${formVal >= 0 ? '+' : ''}${formVal.toFixed(1)}`, formVal < -10 ? '#c06a50' : '#0F172A') : ''}
                  </div>
                  ${captionFor(d, conf)}
                </div>
              `;
            }).join('')}
          </div>

          <!-- Fitness history chart -->
          <div class="tri-load-card hf" data-delay="0.14">
            <div class="tri-load-label">Fitness history</div>
            <div style="font-size:11px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">
              Per-discipline direct chronic load over the last 12 weeks. Sports you haven't trained in stay flat at 0.
            </div>
            ${renderChart(history)}
            <div style="margin-top:10px;display:flex;justify-content:center;gap:18px;font-size:11px">
              ${(['swim', 'bike', 'run'] as const).map((d) => {
                const c = DISCIPLINE_COLOURS[d];
                const f = fitness[d];
                const value = (f.ctl / 7).toFixed(1);
                return `<span style="display:inline-flex;align-items:center;gap:5px"><span style="display:inline-block;width:10px;height:2px;background:${c.accent}"></span>${DISCIPLINE_LABEL[d]} <span style="color:var(--c-muted);font-variant-numeric:tabular-nums">${value}</span></span>`;
              }).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
    ${renderTabBar('home')}
  `;

  wireTabBarHandlers(navigateTab);
  document.getElementById('tri-load-back-btn')?.addEventListener('click', () => {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function cell(label: string, value: string, colour: string = '#0F172A'): string {
  return `
    <div>
      <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${label}</div>
      <div style="font-size:18px;font-weight:500;color:${colour};font-variant-numeric:tabular-nums">${value}</div>
    </div>
  `;
}

function captionFor(d: 'swim' | 'bike' | 'run', conf: { weeksActive: number; sessions: number; confidence: string }): string {
  const sport = d === 'swim' ? 'swim' : d === 'bike' ? 'bike' : 'run';
  const sessionsWord = conf.sessions === 1 ? 'session' : 'sessions';
  let caption: string;
  let colour = 'var(--c-faint)';
  if (conf.confidence === 'high') {
    caption = `Based on ${conf.weeksActive} weeks of ${sport} training (${conf.sessions} ${sessionsWord}).`;
  } else if (conf.confidence === 'medium') {
    caption = `Based on ${conf.weeksActive} weeks of ${sport} training (${conf.sessions} ${sessionsWord}). Stabilises with more weeks.`;
  } else if (conf.confidence === 'low') {
    caption = `Limited ${sport} history — ${conf.sessions} ${sessionsWord} in ${conf.weeksActive} week${conf.weeksActive === 1 ? '' : 's'}.`;
    colour = '#a89060';
  } else {
    caption = `No ${sport} activity logged in the last 12 weeks.`;
    colour = '#a89060';
  }
  return `<div style="font-size:11px;color:${colour};margin-top:8px;line-height:1.4">${caption}</div>`;
}

function renderChart(history: Array<{ weekISO: string; swimCtl: number; bikeCtl: number; runCtl: number }>): string {
  if (history.length < 2) {
    return `<div style="height:140px;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--c-muted);font-size:12px;background:rgba(0,0,0,0.02);border-radius:8px;padding:0 20px">
      Fills in once you have 2+ weeks of activity data.
    </div>`;
  }
  const W = 560, H = 140;
  const pad = { top: 10, right: 8, bottom: 20, left: 32 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const n = history.length;
  const norm = (v: number) => v / 7;
  const maxY = Math.max(10, ...history.map(h => Math.max(norm(h.swimCtl), norm(h.bikeCtl), norm(h.runCtl))));
  const x = (i: number) => pad.left + (plotW * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.top + plotH - (v / maxY) * plotH;
  const lineFor = (key: 'swimCtl' | 'bikeCtl' | 'runCtl') =>
    history.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(norm(h[key])).toFixed(1)}`).join(' ');
  const gridLines = [0.25, 0.5, 0.75].map(f => {
    const gy = pad.top + plotH * (1 - f);
    return `<line x1="${pad.left}" y1="${gy}" x2="${W - pad.right}" y2="${gy}" stroke="rgba(0,0,0,0.06)" stroke-width="1"/>`;
  }).join('');
  const yLabels = [0, 0.5, 1].map(f => {
    const v = Math.round(maxY * f);
    const gy = pad.top + plotH * (1 - f);
    return `<text x="${pad.left - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--c-faint)" font-variant-numeric="tabular-nums">${v}</text>`;
  }).join('');
  const xLabels = history.map((h, i) => {
    if (i !== 0 && i !== n - 1 && i !== Math.floor(n / 2)) return '';
    const d = new Date(h.weekISO);
    return `<text x="${x(i)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--c-faint)">${d.getDate()}/${d.getMonth() + 1}</text>`;
  }).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" style="display:block">
      ${gridLines}${yLabels}${xLabels}
      <path d="${lineFor('swimCtl')}" fill="none" stroke="${DISCIPLINE_COLOURS.swim.accent}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <path d="${lineFor('bikeCtl')}" fill="none" stroke="${DISCIPLINE_COLOURS.bike.accent}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <path d="${lineFor('runCtl')}" fill="none" stroke="${DISCIPLINE_COLOURS.run.accent}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
  `;
}
