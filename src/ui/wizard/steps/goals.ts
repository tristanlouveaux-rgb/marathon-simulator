import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import runningImgUrl from '@/assets/onboarding/running.jpg';
import hyroxImgUrl from '@/assets/onboarding/hyrox.jpg';
import triathlonImgUrl from '@/assets/onboarding/triathlon.jpg';
import trackImgUrl from '@/assets/onboarding/track.jpg';

type TrainingMode = 'running' | 'hyrox' | 'triathlon' | 'track';

// Monochrome line marks — watermark inside each tile until the real photo lands.
const ICON_RUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="15" cy="4.5" r="1.6"/><path d="M7 11l3.5-3 3 1.5 2.5 3 2.5 0.5"/><path d="M10.5 8.5l-3 4 3 2 0.5 4.5"/><path d="M5 16l3.5 1 2-1.5"/><path d="M13.5 14l-1 4.5"/></svg>`;
const ICON_HYROX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 10.5v3"/><path d="M21.5 10.5v3"/><path d="M5.5 8v8"/><path d="M18.5 8v8"/><path d="M5.5 12h13"/></svg>`;
const ICON_TRI = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 17c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0"/><circle cx="17" cy="7" r="1.4"/><path d="M6 14l3-3 3 1 3-1"/></svg>`;
const ICON_TRACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l4 4 12-12"/><path d="M4 18h16"/></svg>`;

interface ModeTile {
  id: TrainingMode;
  label: string;
  sub: string;
  icon: string;
  placeholderBg: string;
  imageUrl?: string;
  disabled?: boolean;
  badge?: string;
}

const MODE_TILES: ModeTile[] = [
  {
    id: 'running',
    label: 'Running',
    sub: '5k to marathon',
    icon: ICON_RUN,
    placeholderBg: 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 55%, #1a1a1a 100%)',
    imageUrl: runningImgUrl,
  },
  {
    id: 'hyrox',
    label: 'Hyrox',
    sub: 'Hybrid racing: run + functional',
    icon: ICON_HYROX,
    placeholderBg: 'linear-gradient(135deg, #1f1f1f 0%, #2e2e2e 55%, #1a1a1a 100%)',
    imageUrl: hyroxImgUrl,
    disabled: true,
    badge: 'Coming soon',
  },
  {
    id: 'triathlon',
    label: 'Triathlon',
    sub: 'Swim, bike, run — 70.3 or Ironman',
    icon: ICON_TRI,
    placeholderBg: 'linear-gradient(135deg, #1d1d1d 0%, #2b2b2b 55%, #171717 100%)',
    imageUrl: triathlonImgUrl,
    badge: 'New',
  },
  {
    id: 'track',
    label: 'Just track',
    sub: 'Log activities only. No plan.',
    icon: ICON_TRACK,
    placeholderBg: 'linear-gradient(135deg, #1e1e1e 0%, #2c2c2c 55%, #1a1a1a 100%)',
    imageUrl: trackImgUrl,
  },
];

/**
 * Page 2 — Training Mode picker.
 *
 * Tap-to-advance. Four tiles (Running / Just track / Hyrox / Triathlon).
 * No Continue button — the selection IS the commit. No Change pill either — the
 * user goes back via the wizard back button.
 *
 * Event Y/N, distance, focus, and race selection live on the Race/Target page.
 */
export function renderGoals(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <style>
      @keyframes gRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .g-rise { opacity:0; animation: gRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .mode-tile { position:relative; width:100%; border:1px solid rgba(255,255,255,0.12); padding:0; cursor:pointer; border-radius:20px; overflow:hidden; height:150px; color:#FDFCF7; text-align:left; transition: transform 0.12s ease, box-shadow 0.2s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.12); }
      .mode-tile:not(.disabled):active { transform: translateY(0.5px) scale(0.985); }
      .mode-tile.disabled { cursor: not-allowed; opacity: 0.55; }

      .mode-img { position:absolute; inset:0; background-size:cover; background-position:center; image-rendering: -webkit-optimize-contrast; }
      .mode-grain { position:absolute; inset:0; background-image: radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px); background-size: 3px 3px; mix-blend-mode: overlay; pointer-events:none; }
      .mode-vignette { position:absolute; inset:0; background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.1) 50%, rgba(0,0,0,0.55) 100%); pointer-events:none; }

      .mode-watermark { position:absolute; right:-10px; top:-10px; width:170px; height:170px; opacity:0.12; color:#FDFCF7; pointer-events:none; }
      .mode-watermark svg { width:100%; height:100%; }

      .mode-inner { position:absolute; left:0; right:0; bottom:0; padding:16px 18px; }

      .mode-badge { position:absolute; top:14px; right:14px; background:rgba(255,255,255,0.14); color:rgba(255,255,255,0.95); font-size:10px; letter-spacing:0.14em; text-transform:uppercase; padding:4px 9px; border-radius:100px; backdrop-filter: blur(6px); z-index:2; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 38%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(2, 7)}

        <div class="g-rise" style="width:100%;max-width:460px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            What are you training for?
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            Pick a mode. You can refine it next.
          </p>
        </div>

        <div style="width:100%;max-width:460px;display:flex;flex-direction:column;gap:10px;margin-top:24px">
          ${MODE_TILES.map((t, i) => renderModeTile(t, i)).join('')}
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers();

  // Keep linter happy — state is intentionally unused now that there's no selection UI.
  void state;
}

function renderModeTile(t: ModeTile, idx: number): string {
  const classes = ['mode-tile', 'g-rise', t.disabled ? 'disabled' : ''].filter(Boolean).join(' ');
  const delay = 0.12 + idx * 0.06;
  const imgStyle = t.imageUrl
    ? `background-image:url('${t.imageUrl}');background-position:70% 20%;filter:grayscale(1)`
    : `background:${t.placeholderBg}`;
  return `
    <button data-mode="${t.id}" class="${classes}" style="animation-delay:${delay}s" ${t.disabled ? 'aria-disabled="true"' : ''}>
      <div class="mode-img" style="${imgStyle}"></div>
      ${t.imageUrl ? '' : `<div class="mode-watermark">${t.icon}</div>`}
      <div class="mode-vignette"></div>
      ${t.badge ? `<div class="mode-badge">${t.badge}</div>` : ''}
      <div class="mode-inner">
        <div style="font-size:19px;font-weight:500;letter-spacing:-0.01em;line-height:1.1">${t.label}</div>
        <div style="font-size:12px;opacity:0.78;margin-top:3px;line-height:1.3">${t.sub}</div>
      </div>
    </button>
  `;
}

function wireEventHandlers(): void {
  document.querySelectorAll<HTMLElement>('.mode-tile').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('disabled')) return;
      const mode = btn.getAttribute('data-mode') as TrainingMode;

      if (mode === 'track') {
        // Just-Track mode: log activities only. No plan, no event, no focus branching.
        // trainingMode='fitness' matches resolveMode() on race-target which auto-skips
        // when trackOnly=true (via the early return we add there).
        updateOnboarding({
          trainingMode: 'fitness',
          trainingFocus: 'track',
          trackOnly: true,
          continuousMode: true,
          trainingForEvent: null,
          raceDistance: null,
          selectedRace: null,
          customRaceDate: null,
        });
      } else if (mode === 'running') {
        // Running: race-target page will ask Yes/No event and handle the branch.
        updateOnboarding({
          trainingMode: 'running',
          trackOnly: false,
          trainingForEvent: null,
          trainingFocus: null,
          raceDistance: null,
          selectedRace: null,
          customRaceDate: null,
        });
      } else if (mode === 'triathlon') {
        // Triathlon: always race-mode (§18.10). Subsequent triathlon-setup step
        // collects distance, date, hours, split, self-rating, and benchmarks.
        updateOnboarding({
          trainingMode: 'triathlon',
          trackOnly: false,
          continuousMode: false,
          trainingForEvent: true,
          raceDistance: null,           // Tri has its own distance on triConfig
          trainingFocus: null,
          selectedRace: null,
          customRaceDate: null,
        });
      } else {
        // hyrox — disabled tile, shouldn't fire. Guard anyway.
        return;
      }

      nextStep();
    });
  });
}
