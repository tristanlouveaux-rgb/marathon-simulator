import { nextStep, goToStep, updateOnboarding, getOnboardingState } from '../controller';
import { initializeSimulatorFromOnboarding } from './initializing';

/**
 * Render the welcome page (Step 1)
 * Clean, premium landing in the new light/beige palette.
 */
export function renderWelcome(container: HTMLElement): void {
  container.innerHTML = `
    <style>
      @keyframes wRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .w-rise { opacity:0; animation: wRise 0.8s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      #welcome-name:focus { border-color: rgba(0,0,0,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(0,0,0,0.04), 0 10px 24px -4px rgba(0,0,0,0.08); }
    </style>
    <div class="flex flex-col" style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden">

      <!-- z1: subtle radial light behind center stack -->
      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 42%, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <!-- Hero — open layout, no enclosing plane -->
      <div class="flex-1 flex flex-col items-center justify-center px-6 py-16" style="position:relative;z-index:1">

        <!-- Brand -->
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

        <!-- Subheadline -->
        <p class="w-rise" style="font-size:15px;font-weight:300;text-align:center;line-height:1.55;color:var(--c-muted);margin:32px auto 44px;max-width:320px;animation-delay:0.2s">
          Running, strength, sport, and recovery. One plan that accounts for it all.
        </p>

        <!-- Name input -->
        <div class="w-rise" style="width:100%;max-width:300px;margin-bottom:12px;animation-delay:0.35s">
          <input
            id="welcome-name"
            type="text"
            placeholder="Your first name"
            style="width:100%;padding:14px 20px;text-align:center;font-size:15px;background:rgba(255,255,255,0.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(0,0,0,0.08);border-radius:50px;color:var(--c-black);outline:none;box-sizing:border-box;box-shadow:inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px rgba(0,0,0,0.03), 0 8px 20px -4px rgba(0,0,0,0.05);transition:border-color 0.2s ease, box-shadow 0.2s ease"
            maxlength="30"
          >
        </div>

        <!-- CTA -->
        <button
          id="welcome-cta"
          class="w-rise m-btn-glass"
          style="width:100%;max-width:300px;padding:15px 20px;font-size:15px;animation-delay:0.5s"
        >
          Build my plan
        </button>

        <!-- Sign in -->
        <p class="w-rise" style="margin:18px 0 0;font-size:12px;color:var(--c-faint);text-align:center;animation-delay:0.65s">
          Already have an account?
          <button id="welcome-sign-in" style="color:var(--c-black);background:none;border:none;cursor:pointer;font-size:12px;text-decoration:underline;padding:0;margin-left:4px">Sign in</button>
        </p>

        <!-- Single compact trust row — one line -->
        <div class="w-rise" style="margin-top:44px;display:flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap;animation-delay:0.8s">
          ${['Proven principles', 'Recovery-informed', 'Built from your existing training'].map((label, i, arr) => `
            <span style="font-size:10px;color:var(--c-faint)">${label}</span>
            ${i < arr.length - 1 ? '<span style="width:3px;height:3px;border-radius:50%;background:var(--c-black);opacity:0.28;flex-shrink:0"></span>' : ''}
          `).join('')}
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:16px;text-align:center;position:relative;z-index:1">
        <button id="demo-fill" style="font-size:11px;color:var(--c-faint);background:none;border:none;cursor:pointer" title="Auto-fill test data">⚡</button>
      </div>
    </div>
  `;

  const ctaButton = document.getElementById('welcome-cta');
  const nameInput = document.getElementById('welcome-name') as HTMLInputElement;

  const existingName = getOnboardingState()?.name;
  if (nameInput && existingName) nameInput.value = existingName;

  if (ctaButton && nameInput) {
    ctaButton.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.style.borderColor = '#EF4444';
        nameInput.placeholder = 'Please enter your name';
        nameInput.focus();
        return;
      }
      updateOnboarding({ name });
      nextStep();
    });

    nameInput.addEventListener('input', () => {
      nameInput.style.borderColor = 'rgba(0,0,0,0.08)';
      nameInput.placeholder = 'Your first name';
    });

    nameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') ctaButton.click();
    });
  }

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
