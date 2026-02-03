import { nextStep, goToStep, updateOnboarding, getOnboardingState } from '../controller';
import { initializeSimulatorFromOnboarding } from './initializing';

/**
 * Render the welcome page (Step 1)
 * Classy, corporate-but-beautiful landing with sporty aesthetic
 */
export function renderWelcome(container: HTMLElement): void {
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col">
      <!-- Hero Section -->
      <div class="flex-1 relative overflow-hidden">
        <!-- Gradient Background -->
        <div class="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-950 to-emerald-950/20"></div>

        <!-- Subtle Geometric Pattern (corporate, not AI-generated looking) -->
        <div class="absolute inset-0 opacity-[0.03]">
          <div class="h-full w-full" style="
            background-image:
              linear-gradient(30deg, transparent 40%, rgba(255,255,255,0.5) 40%, rgba(255,255,255,0.5) 60%, transparent 60%),
              linear-gradient(-30deg, transparent 40%, rgba(255,255,255,0.5) 40%, rgba(255,255,255,0.5) 60%, transparent 60%);
            background-size: 60px 105px;
          "></div>
        </div>

        <!-- Accent Line -->
        <div class="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-emerald-500 to-transparent opacity-50"></div>

        <!-- Content -->
        <div class="relative z-10 flex flex-col items-center justify-center h-full px-6 py-12">
          <!-- Logo/Brand -->
          <div class="mb-8 text-center">
            <h1 class="text-5xl md:text-7xl font-extralight tracking-tight text-white">
              <span class="font-semibold">MOSAIC</span>
            </h1>
            <p class="text-xs md:text-sm text-gray-500 tracking-[0.3em] uppercase mt-3">
              Intelligent Training
            </p>
          </div>

          <!-- Divider -->
          <div class="w-16 h-px bg-gradient-to-r from-transparent via-gray-600 to-transparent mb-8"></div>

          <!-- Tagline -->
          <div class="max-w-md text-center mb-12">
            <p class="text-lg md:text-xl text-gray-300 font-light leading-relaxed">
              Your personalized path to peak performance
            </p>
          </div>

          <!-- Name Input -->
          <div class="max-w-xs w-full mb-8">
            <input
              id="welcome-name"
              type="text"
              placeholder="Your first name"
              class="w-full px-5 py-3 bg-gray-900/80 border border-gray-700 rounded-full
                     text-white text-center text-lg placeholder-gray-500
                     focus:border-emerald-500 focus:outline-none transition-colors"
              maxlength="30"
            >
          </div>

          <!-- CTA Button -->
          <button
            id="welcome-cta"
            class="group relative px-10 py-4 bg-emerald-600 hover:bg-emerald-500
                   text-white font-medium rounded-full transition-all duration-300
                   shadow-lg shadow-emerald-950/50 hover:shadow-emerald-900/50
                   hover:scale-105 active:scale-100"
          >
            <span class="relative z-10 text-base tracking-wide">Are you ready?</span>
          </button>

          <!-- Trust Indicators -->
          <div class="mt-16 flex flex-wrap justify-center gap-6 md:gap-10 text-xs text-gray-500">
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
              </svg>
              <span>Science-backed</span>
            </div>
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
              </svg>
              <span>Adaptive</span>
            </div>
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
              </svg>
              <span>Personal</span>
            </div>
          </div>
        </div>

        <!-- Bottom Fade -->
        <div class="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-gray-950 to-transparent"></div>
      </div>

      <!-- Footer -->
      <div class="py-4 text-center flex items-center justify-center gap-4">
        <p class="text-xs text-gray-600">
          Powered by VDOT methodology
        </p>
        <button id="demo-fill" class="text-xs text-gray-700 hover:text-gray-400 transition-colors" title="Auto-fill test data">⚡</button>
      </div>
    </div>
  `;

  // Wire up event handler
  const ctaButton = document.getElementById('welcome-cta');
  if (ctaButton) {
    ctaButton.addEventListener('click', () => {
      const nameInput = document.getElementById('welcome-name') as HTMLInputElement;
      if (nameInput?.value.trim()) {
        updateOnboarding({ name: nameInput.value.trim() });
      }
      nextStep();
    });
  }

  // Demo auto-fill button — sets state AND initializes simulator
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

    // Initialize simulator state so workouts exist
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
