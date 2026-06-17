import { renderTabBar, wireTabBarHandlers, navigateToForecastTab, type TabId } from './tab-bar';

// ─── Navigation ─────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
  else if (tab === 'forecast') navigateToForecastTab();  // mode-aware
  else if (tab === 'account') import('./account-view').then(m => m.renderAccountView());
}

// ─── Section components ─────────────────────────────────────────────────────

const card = (title: string, body: string): string => `
  <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
    <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:8px">${title}</div>
    ${body}
  </div>`;

const para = (text: string): string =>
  `<p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0 0 10px">${text}</p>`;

const paraLast = (text: string): string =>
  `<p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">${text}</p>`;

const bullets = (items: string[]): string =>
  `<ul style="margin:0;padding-left:18px">${items
    .map(t => `<li style="font-size:13px;color:var(--c-muted);line-height:1.6;margin-bottom:4px">${t}</li>`)
    .join('')}</ul>`;

const disclaimerCard = (): string => `
  <div style="background:#FBF7EE;border-left:3px solid #B08E3A;border-radius:8px;padding:12px 14px">
    <div style="font-size:12px;color:#4A4032;line-height:1.55">
      <strong style="color:#3A2F22">Mosaic is not a medical device.</strong> Predictions, readiness scores and load metrics are informational, based on published exercise-physiology models applied to your training data. Consult a physician before starting or modifying a training programme.
    </div>
  </div>`;

const loadSection = (): string => card('Training load', `
  ${para('Per-session load uses Coggan\'s TSS for cycling: <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:11px;color:var(--c-black)">TSS = (duration × NP × IF) / (FTP × 3600) × 100</span>. For running, iTRIMP (heart-rate-weighted intensity, Manzi 2009) is normalised to a TSS-equivalent scale calibrated against your own training history.')}
  ${paraLast('Cross-training converts to a run-equivalent stimulus via per-sport discount factors. Running counts in full; cycling, walking, swimming and gym sessions count at reduced rates.')}
`);

const banisterSection = (): string => card('Fitness, fatigue and form', `
  ${para('Fitness, fatigue and form are exponentially-weighted moving averages of daily TSS, following the Banister impulse-response framework (Banister 1991) operationalised by TrainingPeaks.')}
  ${bullets([
    '<strong>CTL</strong> (Chronic Training Load): 42-day EMA, approximates aerobic fitness.',
    '<strong>ATL</strong> (Acute Training Load): 7-day EMA, approximates fatigue.',
    '<strong>TSB</strong> (Training Stress Balance, "form"): CTL minus ATL.',
  ])}
`);

const acwrSection = (): string => card('Injury risk (ACWR)', `
  ${paraLast('Acute:Chronic Workload Ratio is the 7-day rolling load divided by the 28-day rolling load. Values outside roughly 0.8 to 1.5 carry elevated injury risk (Gabbett 2016, Hulin 2014). One signal among several in the readiness model. Not deterministic.')}
`);

const vdotSection = (): string => card('Race time prediction, running (VDOT)', `
  ${paraLast('Jack Daniels\' VDOT model converts race performances into a VO2max-proxy fitness number, then back into predicted times at other distances. Mosaic derives VDOT from your fastest recent race-effort runs across distances, weights by recency, and projects to the target race using fatigue-resistance and course-specific factors.')}
`);

const ftpSection = (): string => card('Race time prediction, cycling (FTP / Critical Power)', `
  ${paraLast('FTP is estimated from your strongest 20-minute power efforts (Coggan\'s 0.95 factor) or from the critical-power asymptote of multiple maximal-effort durations (Monod and Scherrer 1965). Bike race time uses the Coggan model with a duration-dependent power decay.')}
`);

const cssSection = (): string => card('Race time prediction, swimming (CSS)', `
  ${paraLast('Critical Swim Speed is computed from 200m and 400m time-trial pairs (Wakayoshi 1992). Open-water swims apply a deficit relative to pool times where the data warrants it.')}
`);

const triExtrasSection = (): string => card('Triathlon adjustments', `
  ${bullets([
    '<strong>Brick adaptation</strong>: the run leg includes a pace deficit relative to a standalone marathon, calibrated from your bike-to-run sessions.',
    '<strong>Open-water swim deficit</strong>: pool times scaled to expected open-water performance where pool data is the primary input.',
    '<strong>Heat acclimatisation</strong>: pace and heart rate adjusted for expected race-day temperature, blended with your recent heat exposure history.',
    '<strong>Durability cap</strong>: late-race pace decay modelled from how much your pace falls in the final third of long sessions.',
  ])}
`);

const courseFactorsSection = (): string => card('Course factors', `
  ${paraLast('Elevation, surface and expected temperature adjust the baseline race-day prediction. Durability, your ability to hold pace late in a race, is modelled from how much your pace decays in the final third of long efforts in your training history.')}
`);

const readinessSection = (): string => card('Readiness', `
  ${para('Daily readiness blends signals from heart rate variability, resting heart rate, last night\'s sleep duration, training stress balance and recent acute load.')}
  ${paraLast('Each component is z-scored against your own rolling baseline (typically 28 days), so the score reflects your personal trend, not a population norm. HRV and resting heart rate are read from Apple Health or Garmin where available. If neither is connected, the score uses TSB and ACWR alone.')}
`);

const hyroxSection = (): string => card('HYROX specifics', `
  ${para('HYROX time is the sum of eight 1 km run legs and eight stations. Run legs predict from your running VDOT, with a load-carry penalty applied if commute-run mode is active.')}
  ${paraLast('Station times are calibrated against a 89,868-finisher results dataset (HYROX Seasons 4 to 6), scaled by your fitness tier and adjusted by recent strength-station session history.')}
`);

const limitationsSection = (): string => card('Limitations', `
  ${bullets([
    'Predictions improve as your training history grows. Less than four weeks of data widens the confidence band.',
    'TSS and iTRIMP reduce different physiological stresses to a single number. Useful for tracking trends, not for ranking individual sessions.',
    'VDOT, FTP and CSS are population-fit models. Individuals can vary meaningfully from population means; Mosaic surfaces a confidence band, not a point.',
    'Course factors and durability are calibrated where data exists, otherwise default to neutral.',
    'HRV and resting heart rate are sensitive to non-training factors: illness, sleep debt, stress, caffeine, alcohol. Use the trend, not any single day.',
  ])}
`);

const referencesSection = (): string => card('References', `
  ${bullets([
    'Banister EW. (1991) <em>Modeling Elite Athletic Performance.</em>',
    'Coggan A, Allen H. (2019) <em>Training and Racing with a Power Meter</em>, 3rd ed.',
    'Daniels J. (2013) <em>Daniels\' Running Formula</em>, 3rd ed.',
    'Gabbett TJ. (2016) The training-injury prevention paradox. <em>Br J Sports Med.</em>',
    'Hulin BT et al. (2014) Spikes in acute workload are associated with increased injury risk. <em>Br J Sports Med.</em>',
    'Manzi V et al. (2009) Dose-response relationship of autonomic responses to individualised training impulse. <em>Am J Physiol Heart Circ Physiol.</em>',
    'Monod H, Scherrer J. (1965) The work capacity of a synergic muscular group. <em>Ergonomics.</em>',
    'Wakayoshi K et al. (1992) A simple method for determining critical speed as swimming fatigue threshold. <em>Int J Sports Med.</em>',
  ])}
`);

// ─── Page builder ───────────────────────────────────────────────────────────

interface MethodologyOpts {
  title: string;
  sections: string;
  tab: TabId;
  back: () => void;
}

function buildPage(opts: MethodologyOpts): string {
  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header -->
      <div style="padding:14px 18px 12px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;gap:10px">
        <button id="mthd-back" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div style="font-size:16px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">${opts.title}</div>
      </div>

      <!-- Content -->
      <div style="overflow-y:auto;padding:16px 16px 32px;display:flex;flex-direction:column;gap:12px;max-width:600px;margin:0 auto">
        ${disclaimerCard()}
        ${opts.sections}
      </div>
    </div>
    ${renderTabBar(opts.tab)}`;
}

function mount(html: string, back: () => void): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = html;
  wireTabBarHandlers(navigateTab);
  const btn = document.getElementById('mthd-back');
  if (!btn) return;
  btn.addEventListener('click', back);
}

// ─── Public entry points (one per surface) ──────────────────────────────────

export function renderMethodologyRunning(back: () => void): void {
  mount(buildPage({
    title: 'How this is calculated',
    sections: [
      loadSection(),
      banisterSection(),
      acwrSection(),
      vdotSection(),
      courseFactorsSection(),
      limitationsSection(),
      referencesSection(),
    ].join(''),
    tab: 'forecast',
    back,
  }), back);
}

export function renderMethodologyTriathlon(back: () => void): void {
  mount(buildPage({
    title: 'How this is calculated',
    sections: [
      loadSection(),
      banisterSection(),
      vdotSection(),
      ftpSection(),
      cssSection(),
      triExtrasSection(),
      courseFactorsSection(),
      limitationsSection(),
      referencesSection(),
    ].join(''),
    tab: 'forecast',
    back,
  }), back);
}

export function renderMethodologyHyrox(back: () => void): void {
  mount(buildPage({
    title: 'How this is calculated',
    sections: [
      loadSection(),
      banisterSection(),
      vdotSection(),
      hyroxSection(),
      limitationsSection(),
      referencesSection(),
    ].join(''),
    tab: 'forecast',
    back,
  }), back);
}

export function renderMethodologyReadiness(back: () => void): void {
  mount(buildPage({
    title: 'How this is calculated',
    sections: [
      readinessSection(),
      loadSection(),
      banisterSection(),
      acwrSection(),
      limitationsSection(),
      referencesSection(),
    ].join(''),
    tab: 'home',
    back,
  }), back);
}
