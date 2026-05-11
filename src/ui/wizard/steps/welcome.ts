import { nextStep, goToStep, updateOnboarding, getOnboardingState } from '../controller';
import { initializeSimulatorFromOnboarding } from './initializing';
import {
  buildRingBackground,
  ringAnimationCSS,
  buildSunGlint,
  buildAtmosphereBase,
  isFirstRingExperience,
  markRingExperienceSeen,
  triggerRingEntranceHaptic,
  triggerRingWave,
} from '@/ui/page-flair';

// ── Slide definitions — 4 USPs ────────────────────────────────────────────────

interface SlideConfig {
  chip: string;
  headline: string;
  body: string;
  tags: string[];
}

const SLIDES: SlideConfig[] = [
  {
    chip: 'Adaptive intelligence',
    headline: 'Adapts to everything you do.',
    body: 'Every completed session updates your fitness model. Training targets and weekly load shift based on real heart rate and effort data. Not a fixed week-by-week template.',
    tags: ['HR vs effort cross-check', 'Live targets', 'Auto-load balancing'],
  },
  {
    chip: 'Cross-training intelligence',
    headline: 'Every sport counts.',
    body: '45 minutes of padel is roughly 6 km of training load. Log any sport and we analyse the effort, then adjust your week around it.',
    tags: ['Any sport', 'Effort scored', 'Plan adjusts'],
  },
  {
    chip: 'Starts where you are',
    headline: 'Picks up where you left off.',
    body: 'We scan your last 16 weeks of training history. Your fitness level, weekly volume, and training zones are already in your plan before you answer a single question.',
    tags: ['Personal bests', 'Volume baseline', 'Fitness estimate'],
  },
  {
    chip: 'Flexible by design',
    headline: 'Real life, handled.',
    body: 'The plan rebuilds when injury, illness, or travel disrupts training. When you return, detraining science bridges you back to where you left off.',
    tags: ['Injury phases', 'Holiday rebuild', 'Detraining modelled'],
  },
  {
    chip: 'Personal recovery',
    headline: 'Learns how you recover.',
    body: 'Each session and check-in calibrates how quickly you clear fatigue. Recovery timing, load targets, and hard-session spacing adjust to your specific physiology over time.',
    tags: ['Personal recovery rate', 'RPE & check-ins', 'HRV & RHR'],
  },
];

// ── Slide renderer ────────────────────────────────────────────────────────────

const BG_PREFIX = 'isl';
// All slides share the same blue palette — only the review page (post-slides) gets teal.

/** Per-slide card content. Rings + atmosphere stay persistent — only the card swaps. */
function renderCardHTML(idx: number): string {
  const slide = SLIDES[idx];
  const isLast = idx === SLIDES.length - 1;
  return `
    <span style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;
                 color:rgba(0,0,0,0.35);background:rgba(255,255,255,0.7);
                 border:1px solid rgba(0,0,0,0.07);border-radius:100px;
                 padding:5px 13px;display:inline-block;margin-bottom:18px">
      ${slide.chip}
    </span>

    <h2 style="font-size:26px;font-weight:700;color:#1A1A1A;line-height:1.18;
               margin:0 0 12px;letter-spacing:-0.02em">
      ${slide.headline}
    </h2>

    <p style="font-size:14.5px;font-weight:300;color:#555555;line-height:1.62;margin:0 0 20px">
      ${slide.body}
    </p>

    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:26px">
      ${slide.tags.map(tag => `
        <span style="font-size:11px;font-weight:500;color:rgba(0,0,0,0.40);
                     background:rgba(255,255,255,0.68);border:1px solid rgba(0,0,0,0.07);
                     border-radius:100px;padding:5px 11px;white-space:nowrap">
          ${tag}
        </span>
      `).join('')}
    </div>

    <div style="display:flex;align-items:center;justify-content:center;gap:7px;margin-bottom:16px">
      ${SLIDES.map((_, i) => `
        <div style="height:6px;border-radius:3px;transition:all 0.3s ease;
          ${i === idx
            ? 'width:22px;background:rgba(0,0,0,0.45)'
            : 'width:6px;background:rgba(0,0,0,0.12)'}">
        </div>
      `).join('')}
    </div>

    <button id="isl-next" class="m-btn-glass m-btn-glass--inset" style="width:100%;padding:14px;font-size:15px">
      ${isLast ? 'Get started' : 'Next'}
    </button>
  `;
}

function renderSlides(container: HTMLElement, startIdx: number, onDone: () => void): void {
  let idx = startIdx;
  // Slides ALWAYS get the large hero entrance — the slides are the wow moment of
  // every onboarding session, not just the first-ever device install. The haptic
  // is the only thing gated on first-ever (one tap per device, never repeated).
  const isFirstEver = isFirstRingExperience();

  // Build the page shell ONCE — rings, atmosphere, glint, skip button, card container.
  // Subsequent slide changes only swap the card body and toggle the atmosphere palette.
  container.innerHTML = `
    <style>
      @keyframes islRise { from { opacity:0; transform:translateY(14px) } to { opacity:1; transform:translateY(0) } }
      .isl-rise { opacity:0; animation: islRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      @keyframes islCardSwap { 0% { opacity:0; transform:translateY(8px) } 100% { opacity:1; transform:translateY(0) } }
      .isl-card-anim { animation: islCardSwap 0.45s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      #isl-skip:hover { opacity:0.8; }
      ${ringAnimationCSS(BG_PREFIX)}
    </style>

    <div id="isl-page" style="min-height:100vh;position:relative;overflow:hidden;display:flex;flex-direction:column;background:#FAF9F6">

      <!-- Background layers (persistent across all slide transitions) -->
      <div style="position:absolute;inset:0;overflow:hidden;pointer-events:none">
        ${buildAtmosphereBase()}
        ${buildRingBackground(BG_PREFIX, {
          variant: 'centered',
          pulse: true,
          entrance: 'large',
        })}
        ${buildSunGlint('mid')}
      </div>

      <!-- Skip — top right -->
      <div style="position:absolute;top:max(20px,env(safe-area-inset-top,20px));right:20px;z-index:10">
        <button id="isl-skip"
          style="font-size:12px;font-weight:500;color:rgba(0,0,0,0.32);
                 background:rgba(255,255,255,0.55);border:1px solid rgba(0,0,0,0.08);
                 border-radius:100px;padding:7px 16px;cursor:pointer;
                 backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
                 transition:opacity 0.15s">
          Skip
        </button>
      </div>

      <!-- Centered content with persistent glass card shell.
           Card BOX stays visible across all slides; only the inner content fades on swap. -->
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;
                  justify-content:center;padding:64px 24px 40px;position:relative;z-index:1">
        <div class="isl-rise" style="width:100%;max-width:360px;
             background:rgba(255,255,255,0.58);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
             border:1px solid rgba(255,255,255,0.82);border-radius:28px;
             padding:32px 28px 28px;
             box-shadow:0 16px 56px rgba(0,0,0,0.08),0 2px 8px rgba(0,0,0,0.05);
             animation-delay:0.04s">
          <div id="isl-card-content"></div>
        </div>
      </div>
    </div>
  `;

  // Fire haptic on the very first ring appearance ever, then mark seen.
  if (isFirstEver) {
    triggerRingEntranceHaptic();
    markRingExperienceSeen();
  }

  const contentEl = document.getElementById('isl-card-content');
  const pageEl = document.getElementById('isl-page');
  if (!contentEl || !pageEl) return;

  // Update card content + wire next button. Re-runs on every slide change.
  // The CARD BOX stays put — only the inner content fades. No "white flash".
  const updateSlide = (animateCardSwap: boolean) => {
    contentEl.innerHTML = renderCardHTML(idx);
    if (animateCardSwap) {
      contentEl.classList.remove('isl-card-anim');
      void contentEl.getBoundingClientRect();
      contentEl.classList.add('isl-card-anim');
    }

    document.getElementById('isl-next')?.addEventListener('click', () => {
      if (idx < SLIDES.length - 1) {
        idx++;
        triggerRingWave(BG_PREFIX);
        updateSlide(true);
      } else {
        onDone();
      }
    });
  };

  document.getElementById('isl-skip')?.addEventListener('click', onDone);
  updateSlide(false); // Initial render — entrance animation already covers it
}

// ── Name input ────────────────────────────────────────────────────────────────

export function renderWelcome(container: HTMLElement): void {
  container.innerHTML = `
    <style>
      @keyframes wRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .w-rise { opacity:0; animation: wRise 0.8s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      #welcome-name:focus { border-color: rgba(0,0,0,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(0,0,0,0.04), 0 10px 24px -4px rgba(0,0,0,0.08); }
    </style>
    <div class="flex flex-col" style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden">

      <!-- First-page family treatment: atmosphere → whisper rings → low glint.
           Whisper variant is barely visible — MOSAIC wordmark stays the hero,
           but the same world shows through so the slides feel like a continuation. -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('wlc', { variant: 'whisper' })}
        ${buildSunGlint('low')}
      </div>

      <div class="flex-1 flex flex-col items-center justify-center px-6 py-16" style="position:relative;z-index:1">

        <div class="w-rise" style="text-align:center;animation-delay:0.05s">
          <h1 class="font-semibold uppercase" style="font-size:clamp(2rem,8vw,3.6rem);color:var(--c-black);letter-spacing:0.22em;text-align:center;margin:0;line-height:1">
            MOSAIC
          </h1>
          <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:12px">
            <div style="height:1px;width:24px;background:var(--c-black);opacity:0.2"></div>
            <p style="font-size:12px;font-weight:500;letter-spacing:0.26em;text-transform:uppercase;color:var(--c-faint);margin:0">Training that adapts</p>
            <div style="height:1px;width:24px;background:var(--c-black);opacity:0.2"></div>
          </div>
        </div>

        <p class="w-rise" style="font-size:15px;font-weight:300;text-align:center;line-height:1.55;color:var(--c-muted);margin:32px auto 44px;max-width:320px;animation-delay:0.2s">
          Running, strength, sport, and recovery. One plan that accounts for it all.
        </p>

        <div class="w-rise" style="width:100%;max-width:300px;margin-bottom:12px;animation-delay:0.35s">
          <input
            id="welcome-name"
            type="text"
            placeholder="Your first name"
            style="width:100%;padding:14px 20px;text-align:center;font-size:15px;background:rgba(255,255,255,0.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(0,0,0,0.08);border-radius:50px;color:var(--c-black);outline:none;box-sizing:border-box;box-shadow:inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(0,0,0,0.03), 0 8px 20px -4px rgba(0,0,0,0.05);transition:border-color 0.2s ease, box-shadow 0.2s ease"
            maxlength="30"
          >
        </div>

        <button
          id="welcome-cta"
          class="w-rise m-btn-glass"
          style="width:100%;max-width:300px;padding:15px 20px;font-size:15px;animation-delay:0.5s"
        >
          Build my plan
        </button>

        <p class="w-rise" style="margin:18px 0 0;font-size:12px;color:var(--c-faint);text-align:center;animation-delay:0.65s">
          Already have an account?
          <button id="welcome-sign-in" style="color:var(--c-black);background:none;border:none;cursor:pointer;font-size:12px;text-decoration:underline;padding:0;margin-left:4px">Sign in</button>
        </p>

        <div class="w-rise" style="margin-top:44px;display:flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap;animation-delay:0.8s">
          ${['Proven principles', 'Recovery-informed', 'Built from your existing training'].map((label, i, arr) => `
            <span style="font-size:10px;color:var(--c-faint)">${label}</span>
            ${i < arr.length - 1 ? '<span style="width:3px;height:3px;border-radius:50%;background:var(--c-black);opacity:0.28;flex-shrink:0"></span>' : ''}
          `).join('')}
        </div>
      </div>

      <div style="padding:16px;text-align:center;position:relative;z-index:1">
        <button id="demo-fill" style="font-size:11px;color:var(--c-faint);background:none;border:none;cursor:pointer" title="Auto-fill test data">⚡</button>
      </div>
    </div>
  `;

  const ctaButton = document.getElementById('welcome-cta');
  const nameInput = document.getElementById('welcome-name') as HTMLInputElement;

  const existingName = getOnboardingState()?.name;
  if (nameInput && existingName) nameInput.value = existingName;

  const submitName = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.style.borderColor = '#EF4444';
      nameInput.placeholder = 'Please enter your name';
      nameInput.focus();
      return;
    }
    updateOnboarding({ name });
    // Slides come after the name — user has committed, now show what they're getting
    renderSlides(container, 0, () => nextStep());
  };

  ctaButton?.addEventListener('click', submitName);

  nameInput?.addEventListener('input', () => {
    nameInput.style.borderColor = 'rgba(0,0,0,0.08)';
    nameInput.placeholder = 'Your first name';
  });

  nameInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitName();
  });

  document.getElementById('welcome-sign-in')?.addEventListener('click', async () => {
    const { supabase } = await import('@/data/supabaseClient');
    const { renderAuthView } = await import('@/ui/auth-view');
    localStorage.removeItem('mosaic_simulator_mode');
    await supabase.auth.signOut();
    renderAuthView();
  });

  document.getElementById('demo-fill')?.addEventListener('click', () => {
    updateOnboarding({
      name: 'Tristan',
      trainingForEvent: true,
      raceDistance: 'marathon',
      selectedRace: {
        id: 'london-2026',
        name: 'London Marathon',
        city: 'London',
        country: 'UK',
        date: '2026-04-26',
        distance: 'marathon',
      },
      planDurationWeeks: 16,
      runsPerWeek: 5,
      sportsPerWeek: 2,
      experienceLevel: 'returning',
      activeLifestyle: true,
      recurringActivities: [
        { sport: 'Cycling', durationMin: 60, frequency: 1, intensity: 'moderate' },
        { sport: 'Swimming', durationMin: 45, frequency: 1, intensity: 'easy' },
      ],
      pbs: { k5: 1155, k10: 2400, h: 5250 },
      recentRace: { d: 10, t: 2400, weeksAgo: 3 },
      hasSmartwatch: true,
      ltPace: 245,
      vo2max: 53,
    });

    const onboardingState = getOnboardingState();
    if (onboardingState) {
      const result = initializeSimulatorFromOnboarding(onboardingState);
      if (result.success && result.runnerType) {
        updateOnboarding({ calculatedRunnerType: result.runnerType, confirmedRunnerType: result.runnerType });
      }
    }

    goToStep('goals');
  });
}
