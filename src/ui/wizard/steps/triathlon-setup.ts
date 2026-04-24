import type { OnboardingState } from '@/types/onboarding';
import type { TriathlonDistance, TriVolumeSplit, TriSkillRating, TriSkillSlider } from '@/types/triathlon';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { getState } from '@/state/store';
import {
  DEFAULT_VOLUME_SPLIT,
  DEFAULT_WEEKLY_PEAK_HOURS,
  PLAN_WEEKS_DEFAULT,
  RACE_LEG_DISTANCES,
  HOURS_RANGE,
} from '@/constants/triathlon-constants';

/**
 * Triathlon setup — the single consolidated step that replaces
 * race-target + schedule + runner-type for triathlon users.
 *
 * Collects everything the triathlon plan engine needs (§18.9):
 *   - distance (70.3 / IM)
 *   - race date (optional)
 *   - weekly time available
 *   - volume split across swim/bike/run
 *   - self-rating slider per discipline (1–5) — §18.7
 *   - bike FTP + has-power-meter flag
 *   - swim CSS (direct) OR 400m test time (derived)
 *
 * Form is one long scrollable card rather than five sub-steps so the user
 * can skim the entire setup at once and spot anything they're not sure
 * about before hitting continue.
 */
export function renderTriathlonSetup(container: HTMLElement, state: OnboardingState): void {
  const distance: TriathlonDistance = state.triDistance ?? '70.3';
  const defaultHours = DEFAULT_WEEKLY_PEAK_HOURS[distance][3];
  const hoursPerWeek = state.triTimeAvailableHoursPerWeek ?? defaultHours;
  const split: TriVolumeSplit = state.triVolumeSplit ?? { ...DEFAULT_VOLUME_SPLIT };
  const rating: TriSkillRating = state.triSkillRating ?? { swim: 3, bike: 3, run: 3 };
  const ftp = state.triBike?.ftp ?? '';
  const hasPower = state.triBike?.hasPowerMeter ?? false;
  const css = state.triSwim?.cssSecPer100m ?? '';
  const css400 = state.triSwim?.pbs?.m400 ?? '';
  const raceDate = state.customRaceDate ?? '';
  const gymSessions = state.gymSessionsPerWeek ?? 0;
  const hoursRange = HOURS_RANGE[distance];

  container.innerHTML = `
    <style>
      @keyframes tRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .t-rise { opacity:0; animation: tRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .tri-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:18px; margin-bottom:14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.3); }
      .tri-label { font-size:13px; color:var(--c-muted); letter-spacing:0.01em; margin:0 0 10px; text-transform:uppercase; font-weight:500; }
      .tri-pill-row { display:flex; gap:8px; flex-wrap:wrap; }
      .tri-pill { flex:1; min-width:120px; padding:12px 14px; border-radius:12px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); font-size:14px; color:var(--c-black); cursor:pointer; text-align:left; transition: all 0.15s ease; }
      .tri-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .tri-pill .tri-pill-sub { display:block; font-size:11px; opacity:0.65; margin-top:2px; }
      .tri-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px; background:rgba(0,0,0,0.12); border-radius:4px; outline:none; margin:10px 0 2px; }
      .tri-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
      .tri-slider::-moz-range-thumb { width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; border:none; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
      .tri-row { display:flex; justify-content:space-between; align-items:baseline; font-size:13px; color:var(--c-black); }
      .tri-row .tri-value { font-size:16px; font-weight:500; font-variant-numeric: tabular-nums; }
      .tri-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:10px; padding:9px 12px; font-size:14px; width:100%; box-sizing:border-box; outline:none; }
      .tri-input:focus { border-color:var(--c-black); }
      .tri-hint { font-size:12px; color:var(--c-faint); margin:6px 0 0; line-height:1.5; }
      .tri-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:8px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
      .tri-cta:disabled { opacity:0.45; cursor:not-allowed; }
      .tri-toggle { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--c-black); cursor:pointer; user-select:none; }
      .tri-toggle input { accent-color: var(--c-black); }
      .tri-split-grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      .tri-split-cell { text-align:center; padding:10px 6px; border-radius:10px; border:1px solid rgba(0,0,0,0.06); background:rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
      .tri-split-cell .tri-split-pct { font-size:18px; font-weight:500; }
      .tri-split-cell .tri-split-lbl { font-size:11px; color:var(--c-muted); margin-top:2px; text-transform:uppercase; letter-spacing:0.05em; }
      .tri-split-cell .tri-split-hrs { font-size:11px; color:var(--c-faint); margin-top:3px; }
      .tri-rating-label { font-size:14px; color:var(--c-black); font-weight:500; text-transform:capitalize; }
      .tri-rating-value { font-size:13px; color:var(--c-muted); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 20%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(3, 7)}

        <div class="t-rise" style="width:100%;max-width:480px;text-align:center;margin-bottom:20px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            Triathlon setup
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">Everything we need to build your plan.</p>
        </div>

        <div style="width:100%;max-width:480px">
          <!-- Distance -->
          <div class="tri-card t-rise" style="animation-delay:0.1s">
            <div class="tri-label">Race distance</div>
            <div class="tri-pill-row">
              <button class="tri-pill ${distance === '70.3' ? 'active' : ''}" data-distance="70.3">
                70.3 (Half)
                <span class="tri-pill-sub">1.9 km / 90 km / 21.1 km</span>
              </button>
              <button class="tri-pill ${distance === 'ironman' ? 'active' : ''}" data-distance="ironman">
                Ironman
                <span class="tri-pill-sub">3.8 km / 180 km / 42.2 km</span>
              </button>
            </div>
            <p class="tri-hint">Default plan length: ${PLAN_WEEKS_DEFAULT[distance]} weeks</p>
          </div>

          <!-- Race date -->
          <div class="tri-card t-rise" style="animation-delay:0.14s">
            <div class="tri-label">Race date <span style="text-transform:none;font-weight:400;color:var(--c-faint)">(optional)</span></div>
            <input type="date" id="tri-race-date" class="tri-input" value="${raceDate}">
            <p class="tri-hint">Leave blank to start the standard ${PLAN_WEEKS_DEFAULT[distance]}-week plan from this week.</p>
          </div>

          <!-- Time available -->
          <div class="tri-card t-rise" style="animation-delay:0.18s">
            <div class="tri-label">Time available per week</div>
            <div class="tri-row">
              <span>Peak weekly hours</span>
              <span class="tri-value" id="tri-hours-value">${hoursPerWeek}h</span>
            </div>
            <input type="range" min="${hoursRange.min}" max="${hoursRange.max}" step="1" value="${hoursPerWeek}" class="tri-slider" id="tri-hours">
            <p class="tri-hint">This is your peak-week target. Early and recovery weeks will be lighter. Range ${hoursRange.min}–${hoursRange.max}h is sized to your distance.</p>
          </div>

          <!-- Volume split -->
          <div class="tri-card t-rise" style="animation-delay:0.22s">
            <div class="tri-label">Volume split</div>
            <p class="tri-hint" style="margin:-4px 0 12px">Recommended default shown. Adjust if you want to emphasise a discipline.</p>
            <div class="tri-split-grid" id="tri-split-grid">
              ${renderSplitCells(split, hoursPerWeek)}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
              <input type="range" min="5" max="40" step="1" value="${Math.round(split.swim * 100)}" class="tri-slider" data-split-key="swim">
              <input type="range" min="20" max="70" step="1" value="${Math.round(split.bike * 100)}" class="tri-slider" data-split-key="bike">
              <input type="range" min="15" max="60" step="1" value="${Math.round(split.run * 100)}" class="tri-slider" data-split-key="run">
            </div>
          </div>

          <!-- Self-rating -->
          <div class="tri-card t-rise" style="animation-delay:0.26s">
            <div class="tri-label">How strong do you feel in each discipline?</div>
            <p class="tri-hint" style="margin:-4px 0 14px">1 = weakest, 5 = strongest. Lower scores get extra volume and technique work.</p>
            ${(['swim', 'bike', 'run'] as const).map((d) => renderRatingRow(d, rating[d])).join('')}
          </div>

          <!-- Bike benchmarks -->
          <div class="tri-card t-rise" style="animation-delay:0.30s">
            <div class="tri-label">Bike</div>
            <label class="tri-toggle" style="margin-bottom:12px">
              <input type="checkbox" id="tri-has-power" ${hasPower ? 'checked' : ''}>
              I have a power meter
            </label>
            <div id="tri-ftp-row" style="${hasPower ? '' : 'display:none'}">
              <div class="tri-row" style="margin-bottom:4px"><span>FTP (Functional Threshold Power)</span></div>
              <input type="number" id="tri-ftp" class="tri-input" min="80" max="450" step="1" placeholder="e.g. 220" value="${ftp}">
              <p class="tri-hint"><strong>FTP</strong> is the highest power (watts) you can sustain for an hour. To test: after a warm-up, ride 20 minutes all-out and multiply your average power by 0.95. Don't know it? Leave blank — we'll estimate from your slider above and refine once you ride with us.</p>
            </div>
            <p class="tri-hint" style="${hasPower ? 'display:none' : ''}" id="tri-hr-fallback-hint">No power meter? We'll use heart rate for bike load calculations. You can add a power meter later.</p>
          </div>

          <!-- Swim benchmarks -->
          <div class="tri-card t-rise" style="animation-delay:0.34s">
            <div class="tri-label">Swim</div>
            <label class="tri-toggle" style="margin-bottom:12px">
              <input type="checkbox" id="tri-defer-swim" ${!css && !css400 ? 'checked' : ''}>
              I'll do the swim test later
            </label>
            <div id="tri-swim-inputs" style="${!css && !css400 ? 'display:none' : ''}">
              <div class="tri-row" style="margin-bottom:4px"><span>CSS (Critical Swim Speed)</span></div>
              <input type="text" id="tri-css" class="tri-input" placeholder="e.g. 1:45" value="${formatCSS(css)}">
              <p class="tri-hint" style="margin:6px 0 14px"><strong>CSS</strong> is your threshold swim pace — the fastest pace you can hold for ~30 minutes. Enter as minutes:seconds per 100m.</p>
              <div class="tri-row" style="margin-bottom:4px"><span>400m test time <span style="color:var(--c-faint);font-weight:400">(optional)</span></span></div>
              <input type="text" id="tri-css-400" class="tri-input" placeholder="e.g. 7:00" value="${formatMMSS(css400)}">
              <p class="tri-hint">If provided, we'll derive CSS from this. To run the test: 400m all out, rest fully, then 200m all out. Your CSS ≈ (400m time − 200m time) ÷ 2 per 100m.</p>
            </div>
            <p class="tri-hint" id="tri-defer-swim-hint" style="${!css && !css400 ? '' : 'display:none'}">We'll estimate CSS from your slider rating above. You can run the test this week and update on the Stats page to refine your plan.</p>
          </div>

          <!-- Gym -->
          <div class="tri-card t-rise" style="animation-delay:0.38s">
            <div class="tri-label">Strength work</div>
            <div class="tri-row" style="margin-bottom:4px">
              <span>Strength sessions per week</span>
              <span class="tri-value" id="tri-gym-value">${gymSessions}</span>
            </div>
            <input type="range" min="0" max="3" step="1" value="${gymSessions}" class="tri-slider" id="tri-gym">
            <p class="tri-hint">Optional. 1–2 sessions/week of full-body strength helps running economy and injury resilience but isn't required. Set to 0 to skip.</p>
          </div>

          <!-- CTA -->
          <div style="margin-top:6px">
            <button id="tri-continue" class="tri-cta">Build my plan</button>
          </div>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers();
  void state;
}

function renderSplitCells(split: TriVolumeSplit, totalHours: number): string {
  const cells: Array<[keyof TriVolumeSplit, string]> = [
    ['swim', 'Swim'],
    ['bike', 'Bike'],
    ['run', 'Run'],
  ];
  return cells.map(([key, label]) => `
    <div class="tri-split-cell">
      <div class="tri-split-pct" data-pct="${key}">${Math.round(split[key] * 100)}%</div>
      <div class="tri-split-lbl">${label}</div>
      <div class="tri-split-hrs" data-hrs="${key}">${(split[key] * totalHours).toFixed(1)}h</div>
    </div>
  `).join('');
}

function renderRatingRow(discipline: 'swim' | 'bike' | 'run', value: TriSkillSlider): string {
  return `
    <div style="margin-bottom:14px">
      <div class="tri-row">
        <span class="tri-rating-label">${discipline}</span>
        <span class="tri-rating-value" data-rating-value="${discipline}">${value} / 5</span>
      </div>
      <input type="range" min="1" max="5" step="1" value="${value}" class="tri-slider" data-rating-key="${discipline}">
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────────────────
// Wiring
// ──────────────────────────────────────────────────────────────────────────

function wireEventHandlers(): void {
  // Distance pills
  document.querySelectorAll<HTMLButtonElement>('[data-distance]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-distance') as TriathlonDistance;
      updateOnboarding({ triDistance: value });
      document.querySelectorAll<HTMLButtonElement>('[data-distance]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-distance') === value);
      });
    });
  });

  // Race date
  const dateInput = document.getElementById('tri-race-date') as HTMLInputElement | null;
  dateInput?.addEventListener('change', () => {
    updateOnboarding({ customRaceDate: dateInput.value || null });
  });

  // Hours slider
  const hoursInput = document.getElementById('tri-hours') as HTMLInputElement | null;
  const hoursValue = document.getElementById('tri-hours-value');
  hoursInput?.addEventListener('input', () => {
    const h = Number(hoursInput.value);
    if (hoursValue) hoursValue.textContent = `${h}h`;
    updateOnboarding({ triTimeAvailableHoursPerWeek: h });
    refreshSplitCells();
  });

  // Split sliders (normalise so they always sum to ~1.0)
  document.querySelectorAll<HTMLInputElement>('[data-split-key]').forEach((slider) => {
    slider.addEventListener('input', () => onSplitSliderChange(slider));
  });

  // Rating sliders
  document.querySelectorAll<HTMLInputElement>('[data-rating-key]').forEach((slider) => {
    slider.addEventListener('input', () => {
      const key = slider.getAttribute('data-rating-key') as 'swim' | 'bike' | 'run';
      const val = Number(slider.value) as TriSkillSlider;
      const label = document.querySelector(`[data-rating-value="${key}"]`);
      if (label) label.textContent = `${val} / 5`;
      const current = getCurrentOnboarding();
      const rating: TriSkillRating = current.triSkillRating ?? { swim: 3, bike: 3, run: 3 };
      rating[key] = val;
      updateOnboarding({ triSkillRating: { ...rating } });
    });
  });

  // Power toggle
  const hasPowerInput = document.getElementById('tri-has-power') as HTMLInputElement | null;
  hasPowerInput?.addEventListener('change', () => {
    const hasPower = hasPowerInput.checked;
    const current = getCurrentOnboarding();
    updateOnboarding({
      triBike: { ...(current.triBike ?? {}), hasPowerMeter: hasPower, ftp: hasPower ? current.triBike?.ftp : undefined },
    });
    const ftpRow = document.getElementById('tri-ftp-row');
    const hrHint = document.getElementById('tri-hr-fallback-hint');
    if (ftpRow) ftpRow.style.display = hasPower ? '' : 'none';
    if (hrHint) hrHint.style.display = hasPower ? 'none' : '';
  });

  // FTP input
  const ftpInput = document.getElementById('tri-ftp') as HTMLInputElement | null;
  ftpInput?.addEventListener('input', () => {
    const val = Number(ftpInput.value);
    const current = getCurrentOnboarding();
    updateOnboarding({ triBike: { ...(current.triBike ?? {}), ftp: Number.isFinite(val) && val > 0 ? val : undefined } });
  });

  // Defer swim test toggle
  const deferSwimInput = document.getElementById('tri-defer-swim') as HTMLInputElement | null;
  deferSwimInput?.addEventListener('change', () => {
    const defer = deferSwimInput.checked;
    const swimInputs = document.getElementById('tri-swim-inputs');
    const deferHint = document.getElementById('tri-defer-swim-hint');
    if (swimInputs) swimInputs.style.display = defer ? 'none' : '';
    if (deferHint) deferHint.style.display = defer ? '' : 'none';
    if (defer) {
      // Clear any CSS values the user may have typed
      const current = getCurrentOnboarding();
      updateOnboarding({
        triSwim: { ...(current.triSwim ?? {}), cssSecPer100m: undefined, pbs: {} },
      });
      const cssEl = document.getElementById('tri-css') as HTMLInputElement | null;
      const css400El = document.getElementById('tri-css-400') as HTMLInputElement | null;
      if (cssEl) cssEl.value = '';
      if (css400El) css400El.value = '';
    }
  });

  // Gym sessions slider
  const gymInput = document.getElementById('tri-gym') as HTMLInputElement | null;
  const gymValue = document.getElementById('tri-gym-value');
  gymInput?.addEventListener('input', () => {
    const v = Number(gymInput.value);
    if (gymValue) gymValue.textContent = String(v);
    updateOnboarding({ gymSessionsPerWeek: v });
  });

  // CSS inputs
  const cssInput = document.getElementById('tri-css') as HTMLInputElement | null;
  cssInput?.addEventListener('input', () => {
    const parsed = parseMMSS(cssInput.value);
    const current = getCurrentOnboarding();
    updateOnboarding({ triSwim: { ...(current.triSwim ?? {}), cssSecPer100m: parsed ?? undefined } });
  });

  const css400Input = document.getElementById('tri-css-400') as HTMLInputElement | null;
  css400Input?.addEventListener('input', () => {
    const parsed = parseMMSS(css400Input.value);
    const current = getCurrentOnboarding();
    const nextPBs = { ...(current.triSwim?.pbs ?? {}), m400: parsed ?? undefined };
    // If user entered a 400m test time but no CSS, derive a rough CSS.
    // Dekerle 2002: CSS ≈ pace at 400m + 2-3 sec/100m (drop from max pace to threshold).
    const cssFromTest = parsed ? Math.round(parsed / 4) : undefined;
    const existingCSS = current.triSwim?.cssSecPer100m;
    updateOnboarding({
      triSwim: {
        ...(current.triSwim ?? {}),
        pbs: nextPBs,
        cssSecPer100m: existingCSS ?? cssFromTest,
      },
    });
    // Reflect derived CSS in the CSS input if it was blank
    if (!existingCSS && cssFromTest && cssInput) cssInput.value = formatCSS(cssFromTest);
  });

  // Continue CTA
  document.getElementById('tri-continue')?.addEventListener('click', () => {
    // Ensure all defaults are saved before leaving (volumeSplit is already saved
    // on slider change, but if the user never touched them, persist defaults).
    const current = getCurrentOnboarding();
    const finalPatch: Partial<OnboardingState> = {};
    if (!current.triVolumeSplit) finalPatch.triVolumeSplit = { ...DEFAULT_VOLUME_SPLIT };
    if (!current.triSkillRating) finalPatch.triSkillRating = { swim: 3, bike: 3, run: 3 };
    if (!current.triTimeAvailableHoursPerWeek) {
      const d = current.triDistance ?? '70.3';
      const avg = current.triSkillRating
        ? (Math.round((current.triSkillRating.swim + current.triSkillRating.bike + current.triSkillRating.run) / 3) as 1 | 2 | 3 | 4 | 5)
        : 3;
      finalPatch.triTimeAvailableHoursPerWeek = DEFAULT_WEEKLY_PEAK_HOURS[d][avg];
    }
    if (!current.triDistance) finalPatch.triDistance = '70.3';
    // Set the plan duration from the distance default so initializer receives it.
    finalPatch.planDurationWeeks = PLAN_WEEKS_DEFAULT[current.triDistance ?? finalPatch.triDistance ?? '70.3'];
    // Anchor trainingForEvent = true. Triathlon is always race-mode (§18.10).
    finalPatch.trainingForEvent = true;
    if (Object.keys(finalPatch).length > 0) updateOnboarding(finalPatch);
    nextStep();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function getCurrentOnboarding(): OnboardingState {
  return getState().onboarding as OnboardingState;
}

function onSplitSliderChange(changed: HTMLInputElement): void {
  const changedKey = changed.getAttribute('data-split-key') as keyof TriVolumeSplit;
  const rawChanged = Number(changed.value) / 100;

  // Read the other two sliders and normalise so all three sum to 1.0.
  const all = Array.from(document.querySelectorAll<HTMLInputElement>('[data-split-key]'));
  const others = all.filter((s) => s.getAttribute('data-split-key') !== changedKey);
  const othersTotal = others.reduce((acc, s) => acc + Number(s.value) / 100, 0);
  const remaining = Math.max(0, 1 - rawChanged);
  const scale = othersTotal > 0 ? remaining / othersTotal : 0.5;

  const split: TriVolumeSplit = { swim: 0, bike: 0, run: 0 };
  split[changedKey] = rawChanged;
  others.forEach((s) => {
    const k = s.getAttribute('data-split-key') as keyof TriVolumeSplit;
    const scaled = (Number(s.value) / 100) * scale;
    split[k] = scaled;
    // Update slider visual to reflect normalisation
    s.value = String(Math.round(scaled * 100));
  });

  updateOnboarding({ triVolumeSplit: split });
  refreshSplitCells();
}

function refreshSplitCells(): void {
  const current = getCurrentOnboarding();
  const split = current.triVolumeSplit ?? DEFAULT_VOLUME_SPLIT;
  const hours = current.triTimeAvailableHoursPerWeek ?? DEFAULT_WEEKLY_PEAK_HOURS[current.triDistance ?? '70.3'][3];
  (['swim', 'bike', 'run'] as const).forEach((k) => {
    const pct = document.querySelector(`[data-pct="${k}"]`);
    const hrs = document.querySelector(`[data-hrs="${k}"]`);
    if (pct) pct.textContent = `${Math.round(split[k] * 100)}%`;
    if (hrs) hrs.textContent = `${(split[k] * hours).toFixed(1)}h`;
  });
}

function parseMMSS(s: string): number | null {
  if (!s || !s.trim()) return null;
  const parts = s.trim().split(':');
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (parts.length === 2) {
    const [m, sec] = parts.map((p) => Number(p));
    if (!Number.isFinite(m) || !Number.isFinite(sec) || sec < 0 || sec >= 60) return null;
    return m * 60 + sec;
  }
  if (parts.length === 3) {
    const [h, m, sec] = parts.map((p) => Number(p));
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec) || m >= 60 || sec >= 60) return null;
    return h * 3600 + m * 60 + sec;
  }
  return null;
}

function formatMMSS(sec: number | string): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatCSS(secPer100m: number | string): string {
  return formatMMSS(secPer100m);
}

// Keep unused distance helper around for reference until scheduling uses it (§3).
void RACE_LEG_DISTANCES;
