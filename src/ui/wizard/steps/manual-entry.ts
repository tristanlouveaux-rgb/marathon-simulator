import type { OnboardingState, RunnerExperience } from '@/types/onboarding';
import type { PBs } from '@/types/training';
import { updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';

/**
 * Page 3b — Manual fallback.
 *
 * Shown only when the user taps "Enter manually" on the Connect Strava step
 * (i.e. `state.skippedStrava === true`). Collapses three legacy steps
 * (background / volume / PBs) into a single screen. All fields are optional;
 * we save whatever the user enters and move on.
 *
 * Aesthetic mirrors `goals.ts`: cream background, Apple 3-layer shadow pills,
 * rounded cards, monochrome black CTA.
 */

type ExperienceOption = { id: RunnerExperience; label: string; sub: string };

// Matches the existing RunnerExperience union in types/onboarding.ts. We pick
// the six that are meaningful for a manual-entry cold-start flow (leaving the
// "total_beginner" and "hybrid" edges to the more detailed legacy background
// step, which isn't shown in this 7-step overhaul).
const EXPERIENCE_OPTIONS: ExperienceOption[] = [
  { id: 'beginner', label: 'Beginner', sub: 'Running under 6 months' },
  { id: 'novice', label: 'Novice', sub: 'Occasional 5k or 10k' },
  { id: 'intermediate', label: 'Intermediate', sub: 'Consistent, raced before' },
  { id: 'advanced', label: 'Advanced', sub: 'Dedicated, year-round' },
  { id: 'competitive', label: 'Competitive', sub: 'Club or high performance' },
  { id: 'returning', label: 'Returning', sub: 'Strong history, rebuilding' },
  { id: 'hybrid', label: 'Hybrid athlete', sub: 'Fit from other sports, low miles' },
];

const INPUT_STYLE = 'background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.08);color:var(--c-black);border-radius:12px;padding:10px 12px;font-size:14px;width:100%;box-sizing:border-box;outline:none;transition:border-color 0.15s ease, box-shadow 0.2s ease;box-shadow:0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04)';

// --- Time parsing / formatting (same logic as pbs.ts, kept local so we don't
// force a refactor of the legacy file per the task brief). ---

function formatTime(seconds: number, isLong: boolean = false): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    if (isLong && secs === 0) return `${hours}:${minutes.toString().padStart(2, '0')}`;
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function parseTime(timeStr: string, forLongDistance: boolean = false): number | null {
  if (!timeStr || !timeStr.trim()) return null;
  const parts = timeStr.trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) {
    const [first, second] = parts;
    if (first < 0 || second < 0 || second >= 60) return null;
    if (forLongDistance && first >= 1 && first <= 6 && second < 60) return first * 3600 + second * 60;
    return first * 60 + second;
  } else if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

function isLongKey(key: 'k5' | 'k10' | 'h' | 'm'): boolean {
  return key === 'h' || key === 'm';
}

export function renderManualEntry(container: HTMLElement, state: OnboardingState): void {
  const unitPref = getState().unitPref ?? 'km';
  const volumeUnitLabel = unitPref === 'mi' ? 'mi / week' : 'km / week';

  // Read any previously-saved volume (state.detectedWeeklyKm is the canonical
  // "recent weekly km" slot — also populated by Strava sync).
  const existingVolume = getState().detectedWeeklyKm;
  const volumeDisplay = existingVolume != null
    ? (unitPref === 'mi' ? (existingVolume / 1.609).toFixed(1) : String(Math.round(existingVolume)))
    : '';

  container.innerHTML = `
    <style>
      @keyframes mRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .m-rise { opacity:0; animation: mRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }
      .shadow-ap-selected { box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.10); }

      .d-pill { background:rgba(255,255,255,0.95); backdrop-filter: blur(10px); border:1px solid rgba(0,0,0,0.06); border-radius:14px; padding:12px 14px; cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.15s ease; width:100%; text-align:left; color:var(--c-black); }
      .d-pill:active { transform: translateY(1px); }
      .d-pill.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); }
      .d-pill.selected .pill-sub { color: rgba(253,252,247,0.68); }

      .section-label { display:block; font-size:11px; color:var(--c-faint); margin-bottom:10px; letter-spacing:0.08em; text-transform:uppercase; }

      .pb-row { display:grid; grid-template-columns: 96px 1fr; align-items:center; gap:12px; }
      .pb-row + .pb-row { margin-top:10px; }
      .pb-label { font-size:13px; color:var(--c-muted); }

      .volume-wrap { position:relative; }
      .volume-wrap input { padding-right:72px; }
      .volume-unit { position:absolute; right:14px; top:50%; transform:translateY(-50%); font-size:12px; color:var(--c-faint); pointer-events:none; }

      .m-input:focus { border-color: rgba(0,0,0,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(0,0,0,0.04), 0 10px 24px -4px rgba(0,0,0,0.08); }
      .m-input.invalid { border-color: rgba(239,68,68,0.55); }
      .pb-error { font-size:11px; color:#C53030; margin:6px 0 0; line-height:1.3; }

    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 30%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(3, 7)}

        <div class="m-rise" style="width:100%;max-width:480px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            Tell us about your training
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            A few quick details. You can refine them later.
          </p>
        </div>

        <div class="m-rise" style="width:100%;max-width:480px;margin-top:28px;animation-delay:0.12s">
          <label class="section-label">Experience</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${EXPERIENCE_OPTIONS.map(o => {
              const selected = state.experienceLevel === o.id;
              return `
                <button data-exp="${o.id}" class="exp-btn d-pill ${selected ? 'selected shadow-ap-selected' : 'shadow-ap'}">
                  <div style="font-size:14px;font-weight:500;line-height:1.15">${o.label}</div>
                  <div class="pill-sub" style="font-size:11px;color:var(--c-faint);margin-top:2px;line-height:1.3">${o.sub}</div>
                </button>
              `;
            }).join('')}
          </div>
        </div>

        <div class="m-rise" style="width:100%;max-width:480px;margin-top:22px;animation-delay:0.18s">
          <label class="section-label">Recent personal bests</label>
          <div class="shadow-ap" style="background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);border-radius:16px;padding:16px">
            ${renderPBRow('5K', 'pb-5k', state.pbs.k5, 'mm:ss', false)}
            ${renderPBRow('10K', 'pb-10k', state.pbs.k10, 'mm:ss', false)}
            ${renderPBRow('Half', 'pb-half', state.pbs.h, 'h:mm or h:mm:ss', true)}
            ${renderPBRow('Marathon', 'pb-marathon', state.pbs.m, 'h:mm or h:mm:ss', true)}
            <p style="font-size:11px;color:var(--c-faint);margin:10px 0 0">
              Leave blank for any distance you haven't raced.
            </p>
          </div>
        </div>

        <div class="m-rise" style="width:100%;max-width:480px;margin-top:22px;animation-delay:0.24s">
          <label class="section-label">Typical weekly volume</label>
          <div class="shadow-ap" style="background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);border-radius:16px;padding:16px">
            <div class="volume-wrap">
              <input
                id="weekly-volume"
                type="number"
                inputmode="decimal"
                min="0"
                step="1"
                placeholder=""
                value="${volumeDisplay}"
                class="m-input"
                style="${INPUT_STYLE}"
              >
              <span class="volume-unit">${volumeUnitLabel}</span>
            </div>
            <p style="font-size:11px;color:var(--c-faint);margin:8px 0 0">
              Average over the last 4 weeks. Running only.
            </p>
          </div>
        </div>

      </div>

      <div class="m-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.32s">
        <div style="max-width:480px;margin:0 auto">
          <button id="manual-continue" class="m-btn-glass" style="width:100%;padding:15px 20px;font-size:15px">Continue</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state, unitPref);
}

function renderPBRow(label: string, id: string, value: number | undefined, placeholder: string, isLong: boolean): string {
  return `
    <div class="pb-row">
      <label for="${id}" class="pb-label">${label}</label>
      <div>
        <input
          type="text"
          id="${id}"
          placeholder="${placeholder}"
          value="${value ? formatTime(value, isLong) : ''}"
          class="m-input"
          style="${INPUT_STYLE}"
        >
        <p class="pb-error" id="${id}-err" style="display:none">Use format ${placeholder}</p>
      </div>
    </div>
  `;
}

function wireHandlers(state: OnboardingState, unitPref: 'km' | 'mi'): void {
  // Experience pills — single-select, commit live.
  document.querySelectorAll<HTMLElement>('.exp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const exp = btn.getAttribute('data-exp') as RunnerExperience | null;
      if (!exp) return;
      updateOnboarding({ experienceLevel: exp });
      rerender();
    });
  });

  const pbFields: Array<{ id: string; key: keyof PBs; long: boolean }> = [
    { id: 'pb-5k', key: 'k5', long: false },
    { id: 'pb-10k', key: 'k10', long: false },
    { id: 'pb-half', key: 'h', long: true },
    { id: 'pb-marathon', key: 'm', long: true },
  ];

  const commitPbs = () => {
    const current = { ...state.pbs };
    pbFields.forEach(({ id, key, long }) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return;
      const parsed = parseTime(input.value, long);
      if (parsed !== null) {
        (current as any)[key] = parsed;
      } else {
        delete (current as any)[key];
      }
    });
    updateOnboarding({ pbs: current });
  };

  pbFields.forEach(({ id, long }) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const err = document.getElementById(`${id}-err`);
    if (!input) return;
    const validate = () => {
      const raw = input.value.trim();
      if (!raw) {
        input.classList.remove('invalid');
        if (err) err.style.display = 'none';
        return true;
      }
      const ok = parseTime(raw, long) !== null;
      input.classList.toggle('invalid', !ok);
      if (err) err.style.display = ok ? 'none' : 'block';
      return ok;
    };
    input.addEventListener('blur', () => { validate(); commitPbs(); });
    input.addEventListener('input', () => {
      if (input.classList.contains('invalid')) validate();
    });
  });

  // Weekly volume — write to global state.detectedWeeklyKm (always stored as km).
  const volumeInput = document.getElementById('weekly-volume') as HTMLInputElement | null;
  const commitVolume = () => {
    if (!volumeInput) return;
    const raw = volumeInput.value.trim();
    const s = getMutableState();
    if (!raw) {
      s.detectedWeeklyKm = undefined;
    } else {
      const num = parseFloat(raw);
      if (isFinite(num) && num >= 0) {
        s.detectedWeeklyKm = unitPref === 'mi' ? num * 1.609 : num;
      }
    }
    saveState();
  };
  volumeInput?.addEventListener('blur', commitVolume);

  // Continue — commit everything, then advance.
  document.getElementById('manual-continue')?.addEventListener('click', () => {
    commitPbs();
    commitVolume();
    if (typeof window.wizardNext === 'function') window.wizardNext();
  });
}

function rerender(): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (!currentState) return;
    const container = document.getElementById('app-root');
    if (container) renderManualEntry(container, currentState);
  });
}
