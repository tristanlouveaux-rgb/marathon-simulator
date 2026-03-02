import { nextStep, goToStep, updateOnboarding, getOnboardingState } from '../controller';
import { initializeSimulatorFromOnboarding } from './initializing';

/**
 * Render the welcome page (Step 1)
 * Clean, premium landing in the new light/beige palette.
 */
export function renderWelcome(container: HTMLElement): void {
  container.innerHTML = `
    <div class="flex flex-col" style="min-height:100vh;background:var(--c-bg)">

      <!-- Hero -->
      <div class="flex-1 flex flex-col items-center justify-center px-6 py-16">

        <!-- Brand -->
        <div class="mb-10" style="text-align:center">
          <h1 class="font-semibold uppercase" style="font-size:clamp(2rem,8vw,4rem);color:var(--c-black);letter-spacing:0.22em;text-align:center">
            MOSAIC
          </h1>
          <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:10px">
            <div style="height:1px;width:28px;background:var(--c-black);opacity:0.2"></div>
            <p style="font-size:10px;font-weight:500;letter-spacing:0.28em;text-transform:uppercase;color:var(--c-faint)">Intelligent Training</p>
            <div style="height:1px;width:28px;background:var(--c-black);opacity:0.2"></div>
          </div>
        </div>

        <!-- Tagline -->
        <p style="font-size:15px;font-weight:300;text-align:center;max-width:280px;line-height:1.6;color:var(--c-muted);margin-bottom:48px">
          Your personalized path to peak performance
        </p>

        <!-- Name input -->
        <div style="width:100%;max-width:280px;margin-bottom:14px">
          <input
            id="welcome-name"
            type="text"
            placeholder="Your first name"
            style="width:100%;padding:14px 20px;text-align:center;font-size:15px;background:var(--c-surface);border:1.5px solid var(--c-border-strong);border-radius:50px;color:var(--c-black);outline:none;box-sizing:border-box"
            maxlength="30"
          >
        </div>

        <!-- CTA — black, no blue -->
        <button
          id="welcome-cta"
          style="width:100%;max-width:280px;padding:14px 20px;font-size:15px;font-weight:500;text-align:center;border-radius:50px;background:var(--c-black);color:#FDFCF7;border:none;cursor:pointer;letter-spacing:0.02em"
        >
          Are you ready?
        </button>

        <!-- Trust indicators — monochrome, no color -->
        <div style="margin-top:52px;display:flex;flex-wrap:wrap;justify-content:center;gap:20px">
          ${['Science-backed', 'Adaptive', 'Personal'].map(label => `
            <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--c-faint)">
              <span style="width:4px;height:4px;border-radius:50%;background:var(--c-black);opacity:0.35;flex-shrink:0;display:inline-block"></span>
              ${label}
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:16px;text-align:center;display:flex;align-items:center;justify-content:center;gap:16px">
        <p style="font-size:11px;color:var(--c-faint)">Powered by VDOT methodology</p>
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
      nameInput.style.borderColor = 'var(--c-border-strong)';
      nameInput.placeholder = 'Your first name';
    });

    nameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') ctaButton.click();
    });
  }

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
