import { nextStep, goToStep, updateOnboarding, getOnboardingState } from '../controller';
import { initializeSimulatorFromOnboarding } from './initializing';
import { ONBOARDING_INTRO_SLIDES_ENABLED } from '@/constants/feature-flags';
import {
  buildRingBackground,
  ringAnimationCSS,
  buildSunGlint,
  buildAtmosphereBase,
  isFirstRingExperience,
  markRingExperienceSeen,
  triggerRingEntranceHaptic,
} from '@/ui/page-flair';

// ── Slide definitions. 4 USPs ────────────────────────────────────────────────

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
// All slides share the same blue palette. Only the review page (post-slides) gets teal.

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

    <button id="isl-next" class="m-btn-glass m-btn-glass--inset" style="width:100%;padding:14px;font-size:15px;background:rgba(255,255,255,0.92);backdrop-filter:none;-webkit-backdrop-filter:none">
      ${isLast ? 'Get started' : 'Next'}
    </button>
  `;
}

interface SlidesHandle {
  /** (Re)starts the ring bloom + pulse + drift and fires the first-ever haptic.
   *  Call this at REVEAL so the wow plays live on already-warm DOM. */
  playIntro: () => void;
}

/**
 * Builds the slides UI into `host`. Crucially this does NOT assume it owns the
 * whole wizard-step container, so the heavy background can be PRE-WARMED off-screen
 * while the user types their name (see renderWelcome). The cold DOM build + first
 * raster is the expensive part that made the intro jolt/freeze on iPhone; doing it
 * during name entry takes it off the tap's critical path. The bloom itself is
 * replayed at reveal via the returned playIntro() so the wow still happens live.
 */
function buildSlides(host: HTMLElement, startIdx: number, onDone: () => void): SlidesHandle {
  let idx = startIdx;
  // Slides ALWAYS get the large hero entrance. The slides are the wow moment of
  // every onboarding session, not just the first-ever device install. The haptic
  // is the only thing gated on first-ever (one tap per device, never repeated).
  const isFirstEver = isFirstRingExperience();

  // Build the page shell ONCE. Rings, atmosphere, glint, skip button, card container.
  // Subsequent slide changes only swap the card body and toggle the atmosphere palette.
  host.innerHTML = `
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

      <!-- Skip. Top right -->
      <div style="position:absolute;top:max(20px,env(safe-area-inset-top,20px));right:20px;z-index:10">
        <button id="isl-skip"
          style="font-size:13px;font-weight:600;color:rgba(0,0,0,0.62);
                 background:rgba(255,255,255,0.9);border:1px solid rgba(0,0,0,0.12);
                 border-radius:100px;padding:9px 20px;cursor:pointer;
                 box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.06);
                 transition:opacity 0.15s">
          Skip intro
        </button>
      </div>

      <!-- Centered content with persistent glass card shell.
           Card BOX stays visible across all slides; only the inner content fades on swap. -->
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;
                  justify-content:center;padding:64px 24px 40px;position:relative;z-index:1">
        <div class="isl-rise" style="width:100%;max-width:360px;
             background:rgba(255,255,255,0.9);
             border:1px solid rgba(0,0,0,0.06);border-radius:28px;
             padding:32px 28px 28px;
             box-shadow:0 16px 56px rgba(0,0,0,0.08),0 2px 8px rgba(0,0,0,0.05);
             animation-delay:0.04s">
          <div id="isl-card-content"></div>
        </div>
      </div>
    </div>
  `;

  // playIntro restarts the ring bloom/pulse/drift on demand. During pre-warm the
  // animations fire once (off-screen, invisible) and settle; replaying them at the
  // moment of reveal makes the wow play LIVE on warm DOM instead of cold-building
  // under the user's tap. Restart trick = remove the animating class, force a reflow,
  // re-add it (per-ring inline animation-delay on the <g> is preserved). Scoped to
  // `host` so it only touches this slides instance, never the welcome whisper rings.
  // Restart one or more CSS animations by toggling their class. ALL classes are
  // removed first, then a SINGLE forced reflow, then all re-added — so a multi-class
  // replay costs exactly one layout pass on the tap frame, never one-per-element (the
  // naive version forced ~5 reflows for the bloom = a real micro-hitch). Per-ring inline
  // animation-delay on each <g> is preserved (we toggle the class, not the style). Scoped
  // to `host` so it never touches the welcome whisper rings.
  const replay = (...selectors: string[]) => {
    const groups = selectors.map(sel => ({
      cls: sel.slice(1), // ".isl-pulse" → "isl-pulse"
      els: Array.from(host.querySelectorAll<Element>(sel)),
    }));
    groups.forEach(g => g.els.forEach(el => el.classList.remove(g.cls)));
    void host.getBoundingClientRect(); // one reflow for the whole batch
    groups.forEach(g => g.els.forEach(el => el.classList.add(g.cls)));
  };
  const playIntro = () => {
    replay(`.${BG_PREFIX}-entrance`, `.${BG_PREFIX}-pulse`, `.${BG_PREFIX}-drift`);
    // Fire haptic on the very first ring appearance ever, then mark seen.
    if (isFirstEver) {
      triggerRingEntranceHaptic();
      markRingExperienceSeen();
    }
  };

  // Replays ONLY the cheap ambient motion (opacity 'breath' + the single expanding
  // drift ring) — NOT the entrance bloom and NOT the 5-ring wave. Called on each Next
  // tap so every slide visibly moves while it is being read, instead of slides 2-5
  // sitting frozen. The pulse (~9s opacity) is free on WKWebView; the drift is one thin
  // circle (the same cost the intro already runs on arrival, not the 5-ring wave we
  // removed). One forced reflow total via the batched replay above. Both are one-shot
  // (no infinite loop / battery drain) and don't stack on rapid taps (same elements reset).
  const replayAmbient = () => {
    replay(`.${BG_PREFIX}-pulse`, `.${BG_PREFIX}-drift`);
  };

  const contentEl = host.querySelector<HTMLElement>('#isl-card-content');
  const pageEl = host.querySelector<HTMLElement>('#isl-page');
  if (!contentEl || !pageEl) return { playIntro };

  // Update card content + wire next button. Re-runs on every slide change.
  // The CARD BOX stays put. Only the inner content fades. No "white flash".
  const updateSlide = (animateCardSwap: boolean) => {
    contentEl.innerHTML = renderCardHTML(idx);
    if (animateCardSwap) {
      contentEl.classList.remove('isl-card-anim');
      void contentEl.getBoundingClientRect();
      contentEl.classList.add('isl-card-anim');
    }

    host.querySelector('#isl-next')?.addEventListener('click', () => {
      if (idx < SLIDES.length - 1) {
        idx++;
        // Refresh the CHEAP ambient motion so the new slide moves gently while read.
        // We deliberately do NOT re-fire the 5-ring wave here (scale 1.8x/2.4x on every
        // tap janks WKWebView). replayAmbient = opacity breath + one drift ring only.
        // (Tristan, 2026-06-15)
        replayAmbient();
        updateSlide(true);
      } else {
        onDone();
      }
    });
  };

  host.querySelector('#isl-skip')?.addEventListener('click', onDone);
  updateSlide(false); // Initial render. Entrance animation already covers it
  return { playIntro };
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
           Whisper variant is barely visible: MOSAIC wordmark stays the hero,
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

  // ── Pre-warm the slides while the user types their name ─────────────────────
  // The heavy part of the intro (5 gradient-stroked rings + atmosphere + the first
  // raster) is built NOW, off-screen, so it is fully warm by the time the user taps
  // "Build my plan". This is what kills the old jolt/freeze: the cold DOM build no
  // longer lands on the tap frame. The bloom is replayed live at reveal so the wow
  // still plays. Host sits behind the name screen at opacity 0 (painted → rasterized,
  // but invisible and non-interactive). Built next frame so it never blocks first paint.
  let slides: SlidesHandle | null = null;
  let prewarmHost: HTMLElement | null = null;
  // Wait for the welcome screen's own entrance (w-rise, ~0.8s) to settle before we
  // build + first-raster the heavy slides off-screen, so the two don't contend on the
  // name screen's first frames. Fast-tappers fall back to a cold build in revealSlides.
  // Skipped entirely while the intro deck is gated off (no need to warm DOM we won't show).
  if (ONBOARDING_INTRO_SLIDES_ENABLED) window.setTimeout(() => {
    // Bail if already built, or if the step changed under us (demo-fill / sign-in /
    // submit replace the container — the name input is gone once we've navigated away).
    if (slides || !container.isConnected || !document.getElementById('welcome-name')) return;
    prewarmHost = document.createElement('div');
    prewarmHost.style.cssText = 'position:fixed;inset:0;z-index:0;opacity:0;pointer-events:none';
    container.appendChild(prewarmHost);
    slides = buildSlides(prewarmHost, 0, () => nextStep());
  }, 600);

  const revealSlides = () => {
    // Fast-tap fallback: pre-warm hasn't run yet → build into the container directly.
    if (!slides || !prewarmHost) {
      slides = buildSlides(container, 0, () => nextStep());
      slides.playIntro();
      return;
    }
    const host = prewarmHost;
    host.style.pointerEvents = 'auto';
    host.style.zIndex = '2';
    host.style.transition = 'opacity 0.35s ease';
    slides.playIntro();                       // replay the bloom on warm DOM
    requestAnimationFrame(() => { host.style.opacity = '1'; });
    // Once revealed, drop the welcome layer underneath so it can't be seen or tabbed to.
    window.setTimeout(() => {
      Array.from(container.children).forEach(c => { if (c !== host) c.remove(); });
    }, 380);
  };

  const submitName = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.style.borderColor = '#EF4444';
      nameInput.placeholder = 'Please enter your name';
      nameInput.focus();
      return;
    }
    updateOnboarding({ name });
    // Slides come after the name. User has committed, now show what they're getting.
    // While the intro deck is gated off (ONBOARDING_INTRO_SLIDES_ENABLED), skip the
    // carousel and go straight to the goals step.
    if (ONBOARDING_INTRO_SLIDES_ENABLED) {
      revealSlides();
    } else {
      nextStep();
    }
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
