/**
 * Bike & Aero Setup overlay.
 *
 * Lets the user configure rider mass, bike mass, riding position, tires, and
 * course profile — the inputs to the cycling power-balance solver in
 * `bike-physics.ts`. Also surfaces the W/kg tier and a "What if?" comparison
 * across positions so the aerodynamic gap is concrete.
 *
 * Includes a "Calibrate from a known ride" panel that inverts the equation
 * to estimate the user's actual CdA from a measured ride at known power.
 *
 * Modal pattern follows `docs/UX_PATTERNS.md → Overlays and Modals`:
 * vertically centered, max-w-md (this is a denser sheet than the small
 * benchmark overlay), neutral palette, single accent for the save CTA.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { BikePosition, BikeTire, BikeCourseProfile, BikeAeroProfile } from '@/types/triathlon';
import type { GarminActual } from '@/types/state';
import {
  CDA_PRESET,
  CRR_PRESET,
  COURSE_GRADIENT,
  DEFAULT_DRIVETRAIN_EFF,
  RACE_INTENSITY_BY_DISTANCE,
  defaultAeroProfile,
  paramsFromProfile,
  solveSpeed,
  msToKph,
  solveCdA,
  wattsPerKgTier,
} from '@/calculations/bike-physics';
import { BIKE_SETUP_AUTO_FILL } from '@/constants/feature-flags';
import { getTriathlonById } from '@/data/triathlons';

const OVERLAY_ID = 'bike-setup-overlay';

const POSITION_LABEL: Record<BikePosition, string> = {
  hoods: 'Road bike — hoods',
  drops: 'Road bike — drops',
  'clip-ons': 'Road bike + clip-on aerobars',
  'tt-bike': 'TT / triathlon bike',
};

const TIRE_LABEL: Record<BikeTire, string> = {
  'race-tubeless': 'Race tubeless (e.g. GP5000 S TR)',
  'race-clincher': 'Race clincher with latex tubes',
  training: 'Training tires',
  gravel: 'Gravel / all-road',
};

const COURSE_LABEL: Record<BikeCourseProfile, string> = {
  flat:    'Flat (Kona, Roth, Texas)',
  rolling: 'Rolling (Wales 70.3, Mont-Tremblant)',
  hilly:   'Hilly (Lanzarote, Nice, Lake Placid)',
};

const COURSE_HEADWORD: Record<BikeCourseProfile, string> = {
  flat: 'Flat',
  rolling: 'Rolling',
  hilly: 'Hilly',
};

/** Build dropdown labels. When the user's selected race maps to a course
 *  bucket, replace the generic example list on that bucket with the race
 *  name — so the selected row reads e.g. "Flat — Emilia-Romagna" rather
 *  than "Flat (Kona, Roth, Texas)". */
function courseOptionLabel(
  bucket: BikeCourseProfile,
  raceMatch: { course: BikeCourseProfile; raceName: string } | null,
): string {
  if (raceMatch && raceMatch.course === bucket) {
    return `${COURSE_HEADWORD[bucket]} — ${raceMatch.raceName}`;
  }
  return COURSE_LABEL[bucket];
}

const ALL_POSITIONS: BikePosition[] = ['hoods', 'drops', 'clip-ons', 'tt-bike'];

/** Local working state of the overlay — mutates as the user changes inputs. */
interface FormState {
  riderKg: number;
  bikeKg: number;
  position: BikePosition;
  tire: BikeTire;
  cda: number;
  cdaSource: 'preset' | 'calibrated' | 'user';
  course: BikeCourseProfile;
  ftp: number;
  // Calibration input (transient; only persisted via the Apply button)
  calibDistKm: string;
  calibDurationMin: string;
  calibAvgPowerW: string;
  showCalib: boolean;
  /** Last auto-calibration attempt result, surfaced as a panel above the
   *  manual fields. Lives only in memory — applied CdA is what gets saved. */
  autoCalib: AutoCalibUI | null;
  /** When the course was auto-detected from the user's selected race, the
   *  section renders as a passive readout. Click "Change" to reveal the
   *  dropdown and override. Stays open for the rest of the session. */
  courseDropdownOpen: boolean;
  /** Toggles for the inline (i) explanations on CdA and Crr. */
  showCdaInfo: boolean;
  showCrrInfo: boolean;
}

interface AutoCalibUI {
  status: 'success' | 'no-rides';
  rideName?: string;
  rideDateISO?: string;
  rideDistanceKm?: number;
  rideAvgPowerW?: number;
  rideAvgGradientPct?: number;
  cda?: number;
  confidence?: 'low' | 'medium' | 'high';
  reason?: string;
}

/** Map a race's published bike profile to our 3-bucket BikeCourseProfile.
 *  "mountainous" rolls up into "hilly" — the gradient/wind multipliers in
 *  bike-physics top out there, and a 4th bucket would need new constants. */
function bikeProfileFromRaceId(raceId: string | null | undefined): {
  course: BikeCourseProfile;
  raceName: string;
} | null {
  if (!raceId) return null;
  const race = getTriathlonById(raceId);
  const bp = race?.profile?.bikeProfile;
  if (!race || !bp) return null;
  const course: BikeCourseProfile = bp === 'mountainous' ? 'hilly' : bp;
  return { course, raceName: race.name };
}

function initialFormState(): FormState {
  const s = getState();
  const tri = s.triConfig;
  const existing = tri?.bike?.aeroProfiles?.[0];

  const riderKg = s.bodyWeightKg ?? 75;
  const bikeKg = tri?.bike?.bikeWeightKg ?? 9;
  const ftp = tri?.bike?.ftp ?? 0;

  // Pre-fill course profile from the user's selected race when neither the
  // user nor a previous save has set one. The flag keeps this experimental
  // until we're happy with the mapping.
  const racePrefill = BIKE_SETUP_AUTO_FILL
    ? bikeProfileFromRaceId(s.onboarding?.selectedTriathlonId)
    : null;

  // Show course as a passive readout iff the active value matches what we'd
  // pick from the race. If the user previously saved a different course, or
  // no race is selected, fall back to the dropdown.
  const courseCollapsed = (course: BikeCourseProfile): boolean =>
    !!racePrefill && course === racePrefill.course;

  if (existing) {
    const savedCourse = tri?.bike?.courseProfile;
    const course = savedCourse ?? racePrefill?.course ?? 'flat';
    let cda = existing.cda;
    let cdaSource = existing.cdaSource;
    let autoCalib: AutoCalibUI | null = null;

    // Restore the result panel from the persisted calibration ride so the
    // user can see what their current CdA is based on, instead of the panel
    // vanishing on reopen.
    if (cdaSource === 'calibrated' && existing.calibratedRide) {
      autoCalib = {
        status: 'success',
        rideName: existing.calibratedRide.name,
        rideDateISO: existing.calibratedRide.dateISO,
        rideDistanceKm: existing.calibratedRide.distanceKm,
        rideAvgPowerW: existing.calibratedRide.avgPowerW,
        rideAvgGradientPct: existing.calibratedRide.gradientPct,
        cda,
        confidence: existing.calibratedRide.confidence,
      };
    }

    // Auto-estimate CdA on open if the user is still on a generic preset.
    // We don't override 'calibrated' or 'user' — those are intentional.
    if (BIKE_SETUP_AUTO_FILL && cdaSource === 'preset') {
      const auto = computeAutoCalibration(existing.position, existing.tire, riderKg, bikeKg);
      if (auto) {
        cda = auto.cda;
        cdaSource = 'calibrated';
        autoCalib = auto.ui;
      }
    }

    return {
      riderKg,
      bikeKg,
      position: existing.position,
      tire: existing.tire,
      cda,
      cdaSource,
      course,
      ftp,
      calibDistKm: '',
      calibDurationMin: '',
      calibAvgPowerW: '',
      showCalib: false,
      autoCalib,
      courseDropdownOpen: !courseCollapsed(course),
      showCdaInfo: false,
      showCrrInfo: false,
    };
  }

  // First-time users: TT bike with race clinchers. Try to auto-estimate CdA
  // immediately so the prediction strip is realistic without manual input.
  const defaultPos: BikePosition = 'tt-bike';
  const defaultTire: BikeTire = 'race-clincher';
  const initialCourse: BikeCourseProfile = racePrefill?.course ?? 'flat';

  let cda = CDA_PRESET[defaultPos];
  let cdaSource: 'preset' | 'calibrated' | 'user' = 'preset';
  let autoCalib: AutoCalibUI | null = null;
  if (BIKE_SETUP_AUTO_FILL) {
    const auto = computeAutoCalibration(defaultPos, defaultTire, riderKg, bikeKg);
    if (auto) {
      cda = auto.cda;
      cdaSource = 'calibrated';
      autoCalib = auto.ui;
    }
  }

  return {
    riderKg,
    bikeKg,
    position: defaultPos,
    tire: defaultTire,
    cda,
    cdaSource,
    course: initialCourse,
    ftp,
    calibDistKm: '',
    calibDurationMin: '',
    calibAvgPowerW: '',
    showCalib: false,
    autoCalib,
    courseDropdownOpen: !courseCollapsed(initialCourse),
    showCdaInfo: false,
    showCrrInfo: false,
  };
}

/** Resolve the user's selected race → course bucket mapping for option
 *  labelling. Returns null if no race or its profile is missing. */
function selectedRaceCourseMatch(): { course: BikeCourseProfile; raceName: string } | null {
  const s = getState();
  return bikeProfileFromRaceId(s.onboarding?.selectedTriathlonId);
}

/** Activity types we treat as outdoor cycling for CdA inversion. Indoor and
 *  trainer rides are excluded — the drag/rolling assumptions don't apply. */
const OUTDOOR_RIDE_TYPES = new Set(['CYCLING', 'VIRTUAL_RIDE', 'GRAVEL_CYCLING', 'ROAD_BIKING']);

interface RideCandidate {
  garminId: string;
  startISO: string;
  durationSec: number;
  distanceKm: number;
  avgPowerW: number;
  gradientPct: number;     // mean gradient (m/km / 10), e.g. 0.3 means 0.3%
  deviceWatts: boolean;
  displayName: string;
}

/**
 * Scan stored activities for the best ride to invert CdA from. Filters target
 * "flat enough, long enough, has power" — but stay permissive so a typical
 * urban training ride (e.g. London with bridge crossings, ≤1% mean gradient)
 * still qualifies. Confidence is downgraded by the caller when conditions are
 * softer (estimated power, gradient > 0.5%, etc.).
 */
function pickCalibrationRide(): RideCandidate | null {
  const s = getState();
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;             // 60-day window
  const candidates: RideCandidate[] = [];

  for (const wk of s.wks ?? []) {
    const actuals = wk.garminActuals;
    if (!actuals) continue;
    for (const a of Object.values(actuals) as GarminActual[]) {
      if (!a) continue;
      const type = (a.activityType ?? '').toUpperCase();
      if (!OUTDOOR_RIDE_TYPES.has(type)) continue;
      const startMs = a.startTime ? Date.parse(a.startTime) : NaN;
      if (!isFinite(startMs) || startMs < cutoff) continue;
      // Reject only when we KNOW the power was estimated (deviceWatts === false).
      // null/undefined commonly happens for power-meter rides where Strava
      // didn't surface the flag — accept and downgrade confidence later.
      if (a.deviceWatts === false) continue;
      const power = a.averageWatts;
      if (power == null || power < 80) continue;
      if (a.durationSec < 30 * 60) continue;
      if (!isFinite(a.distanceKm) || a.distanceKm < 15) continue;
      if (a.elevationGainM == null) continue;
      const mPerKm = a.elevationGainM / a.distanceKm;
      const gradientPct = mPerKm / 10;                              // m/km → %
      if (gradientPct > 1.0) continue;                              // hard ceiling
      candidates.push({
        garminId: a.garminId,
        startISO: a.startTime ?? '',
        durationSec: a.durationSec,
        distanceKm: a.distanceKm,
        avgPowerW: power,
        gradientPct,
        deviceWatts: a.deviceWatts === true,
        displayName: a.displayName ?? a.workoutName ?? 'Ride',
      });
    }
  }

  if (candidates.length === 0) return null;
  // Flattest first, longest as tiebreak.
  candidates.sort((x, y) => x.gradientPct - y.gradientPct || y.durationSec - x.durationSec);
  return candidates[0];
}

function fmtRideDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Pure: run pickCalibrationRide + solveCdA against flat-course params for
 * the given position/tire/weights. Returns the CdA + AutoCalibUI describing
 * the picked ride, or null when no qualifying ride exists or the solver
 * rejects it. Used both on overlay open (auto-estimate) and from the manual
 * "Auto-calibrate" button.
 */
function computeAutoCalibration(
  position: BikePosition,
  tire: BikeTire,
  riderKg: number,
  bikeKg: number,
): { cda: number; ui: AutoCalibUI } | null {
  const ride = pickCalibrationRide();
  if (!ride) return null;

  const profile: BikeAeroProfile = {
    id: 'auto',
    label: POSITION_LABEL[position],
    position,
    cda: CDA_PRESET[position],
    cdaSource: 'preset',
    crr: CRR_PRESET[tire],
    tire,
    drivetrainEff: DEFAULT_DRIVETRAIN_EFF,
    airDensityKgM3: 1.225,
  };
  const params = paramsFromProfile(profile, riderKg, bikeKg, 'flat');
  const result = solveCdA(
    { distanceKm: ride.distanceKm, durationSec: ride.durationSec, avgPowerW: ride.avgPowerW },
    params,
  );
  if (result.reason) return null;

  // Soft conditions degrade confidence (no power-meter flag, gradient slightly
  // above the 0.5% ideal). solveCdA assumes 'medium' for sane inputs.
  const softQuality = !ride.deviceWatts || ride.gradientPct > 0.5;
  const confidence: 'low' | 'medium' | 'high' =
    softQuality && result.confidence === 'medium' ? 'low' : result.confidence;

  return {
    cda: result.cda,
    ui: {
      status: 'success',
      rideName: ride.displayName,
      rideDateISO: ride.startISO,
      rideDistanceKm: ride.distanceKm,
      rideAvgPowerW: Math.round(ride.avgPowerW),
      rideAvgGradientPct: ride.gradientPct,
      cda: result.cda,
      confidence,
    },
  };
}

function buildProfile(form: FormState): BikeAeroProfile {
  return {
    id: 'active',
    label: POSITION_LABEL[form.position],
    position: form.position,
    cda: form.cda,
    cdaSource: form.cdaSource,
    crr: CRR_PRESET[form.tire],
    tire: form.tire,
    drivetrainEff: DEFAULT_DRIVETRAIN_EFF,
    airDensityKgM3: 1.225,
  };
}

function predictBikeSplit(form: FormState, distance: '70.3' | 'ironman'): { kph: number; splitSec: number } {
  const profile = buildProfile(form);
  const params = paramsFromProfile(profile, form.riderKg, form.bikeKg, form.course);
  const raceWatts = form.ftp * RACE_INTENSITY_BY_DISTANCE[distance];
  const v = solveSpeed(raceWatts, params);
  const kph = msToKph(v);
  const distKm = distance === 'ironman' ? 180.2 : 90;
  const splitSec = v > 0 ? Math.round((distKm * 1000) / v) : 0;
  return { kph, splitSec };
}

function fmtDuration(sec: number): string {
  if (sec <= 0 || !isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}`;
  return `${m}:${(sec % 60).toString().padStart(2, '0')}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────────────────

export function openBikeSetupOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const state = getState();
  const tri = state.triConfig;
  if (!tri) return;
  const distance = tri.distance;

  const form: FormState = initialFormState();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  function rerender() {
    // Preserve focus + cursor across innerHTML rebuild. Without this, typing
    // a second digit into a number field kicks the user out because the
    // <input> they were focused on has been destroyed and replaced.
    const active = document.activeElement as HTMLInputElement | HTMLSelectElement | null;
    const focusedId = active && overlay.contains(active) ? active.id : null;
    let selStart: number | null = null;
    let selEnd: number | null = null;
    if (focusedId && active instanceof HTMLInputElement && active.type !== 'number') {
      // Number inputs don't expose selectionStart/End — rely on browser default.
      selStart = active.selectionStart;
      selEnd = active.selectionEnd;
    }

    overlay.innerHTML = renderShell(form, distance);
    wireHandlers(overlay, form, distance, rerender);

    if (focusedId) {
      const restored = overlay.querySelector(`#${focusedId}`) as HTMLInputElement | HTMLSelectElement | null;
      if (restored) {
        restored.focus();
        if (restored instanceof HTMLInputElement && selStart != null && selEnd != null && restored.type !== 'number') {
          try { restored.setSelectionRange(selStart, selEnd); } catch { /* some input types don't support it */ }
        }
      }
    }
  }
  rerender();
}

function renderShell(form: FormState, distance: '70.3' | 'ironman'): string {
  const split = predictBikeSplit(form, distance);
  const tier = wattsPerKgTier(form.ftp, form.riderKg);
  const distLabel = distance === 'ironman' ? 'Ironman' : '70.3';

  return `
    <div class="w-full rounded-2xl" style="background:var(--c-surface);overflow:hidden;max-height:90vh;overflow-y:auto;max-width:480px">

      <!-- Header -->
      <div style="padding:22px 20px 14px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-muted)">Triathlon settings</div>
          <button id="bike-setup-close" style="background:transparent;border:none;font-size:18px;color:var(--c-muted);cursor:pointer;padding:0 4px">×</button>
        </div>
        <div style="font-size:18px;font-weight:600;color:var(--c-black);line-height:1.3;margin-bottom:4px">Bike & aero setup</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5">Tunes the ${distLabel} bike split prediction. Power balance physics with your weight, position, and course profile.</div>
      </div>

      <!-- Live prediction strip -->
      <div style="padding:14px 20px;background:rgba(0,0,0,0.02);border-bottom:1px solid var(--c-border);display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-faint)">Predicted split</div>
          <div style="font-size:20px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(split.splitSec)}</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-faint)">Avg speed</div>
          <div style="font-size:20px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${split.kph.toFixed(1)} <span style="font-size:11px;color:var(--c-muted)">kph</span></div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-faint)">FTP / kg</div>
          <div style="font-size:20px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${tier.wkg > 0 ? tier.wkg.toFixed(2) : '—'}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:1px">${tier.label}</div>
        </div>
      </div>

      <!-- Form sections -->
      <div style="padding:18px 20px 8px">

        ${section('Weight',
          row('Rider weight', numberInput('rider-kg', form.riderKg, 'kg', { step: 0.1, min: 30, max: 200 })) +
          row('Bike weight', numberInput('bike-kg', form.bikeKg, 'kg', { step: 0.1, min: 4, max: 30 }))
        )}

        ${section('Riding position',
          select('position', form.position, ALL_POSITIONS.map(p => ({ value: p, label: POSITION_LABEL[p] }))) +
          `<div style="font-size:11px;color:var(--c-muted);margin-top:6px;line-height:1.45">CdA preset: ${CDA_PRESET[form.position].toFixed(2)} m².${infoButton('bike-setup-cda-info')}${form.cdaSource === 'calibrated' ? ' Override active from your calibration.' : ''}</div>` +
          (form.showCdaInfo ? infoBox(`<strong>CdA</strong> = drag coefficient × frontal area (m²). One number capturing how aero you are: body position, helmet, clothing, bike, wheels. Lower is faster — wind drag scales with speed cubed, so at race speeds (35+ kph) it accounts for 70–80% of total resistive power. The presets here are mid-range published values: 0.36 hoods, 0.32 drops, 0.28 with clip-ons, 0.24 on a TT bike with aero helmet. The calibration panel below inverts the equation from a known ride to estimate yours specifically.`) : '')
        )}

        ${section('Tires',
          select('tire', form.tire, (Object.keys(TIRE_LABEL) as BikeTire[]).map(t => ({ value: t, label: TIRE_LABEL[t] }))) +
          `<div style="font-size:11px;color:var(--c-muted);margin-top:6px;line-height:1.45">Crr: ${CRR_PRESET[form.tire].toFixed(4)}${infoButton('bike-setup-crr-info')}</div>` +
          (form.showCrrInfo ? infoBox(`<strong>Crr</strong> = coefficient of rolling resistance, dimensionless. The friction your tires lose to the road. Lower is faster, but the gap is small at race speed — about 30 W between race tubeless (0.0035) and training tires (0.0050) at 40 kph for a 75 kg rider. Values come from drum-tested lab data (bicyclerollingresistance.com) adjusted ~10% down to match real-road conditions.`) : '')
        )}

        ${section('Course profile',
          renderCourseSection(form)
        )}

        <!-- Calibration -->
        ${section('Calibrate CdA from a recent ride',
          renderCalibration(form, distance)
        )}

        <!-- What if comparison -->
        ${section('What if?',
          renderWhatIf(form, distance)
        )}

      </div>

      <!-- Footer actions -->
      <div style="padding:14px 20px 20px;border-top:1px solid var(--c-border);display:flex;gap:10px">
        <button id="bike-setup-cancel" style="flex:1;height:44px;border-radius:12px;border:1px solid var(--c-border);background:transparent;font-size:14px;font-weight:500;color:var(--c-muted);cursor:pointer">Cancel</button>
        <button id="bike-setup-save" style="flex:1;height:44px;border-radius:12px;border:none;background:var(--c-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer">Save</button>
      </div>
    </div>
  `;
}

function renderCourseSection(form: FormState): string {
  const gradient = `${(COURSE_GRADIENT[form.course] * 100).toFixed(1)}%`;
  const raceMatch = selectedRaceCourseMatch();

  if (!form.courseDropdownOpen && raceMatch && raceMatch.course === form.course) {
    // Passive readout: we picked this from the user's race. Small "Change"
    // affordance reveals the dropdown if they want to override.
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border-radius:10px;background:rgba(0,0,0,0.03)">
        <div style="min-width:0">
          <div style="font-size:13px;color:var(--c-black);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${COURSE_HEADWORD[form.course]} · ${raceMatch.raceName}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:2px">Detected from your race · Mean gradient ${gradient}</div>
        </div>
        <button id="bike-setup-course-change" style="background:transparent;border:none;font-size:12px;color:var(--c-muted);cursor:pointer;padding:0 4px;flex-shrink:0">Change</button>
      </div>
    `;
  }

  const opts = (Object.keys(COURSE_LABEL) as BikeCourseProfile[]).map(c => ({
    value: c,
    label: courseOptionLabel(c, raceMatch),
  }));
  return select('course', form.course, opts) +
    hint(`Mean gradient: ${gradient}`);
}

function renderCalibration(form: FormState, distance: '70.3' | 'ironman'): string {
  if (!form.showCalib) {
    const autoBtn = BIKE_SETUP_AUTO_FILL ? `
      <button id="bike-setup-auto-calib" style="width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;color:var(--c-black);cursor:pointer;text-align:left;margin-bottom:8px">
        Auto-calibrate from a recent flat ride →
      </button>
    ` : '';
    return `
      ${autoBtn}
      ${renderAutoCalibPanel(form)}
      <button id="bike-setup-show-calib" style="width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;color:var(--c-black);cursor:pointer;text-align:left">
        Enter ride details manually →
      </button>
      ${form.cdaSource === 'calibrated' && !form.autoCalib ? hint(`Active CdA: ${form.cda.toFixed(3)} m² (calibrated)`) : ''}
    `;
  }

  const distNum = parseFloat(form.calibDistKm) || 0;
  const durMin = parseFloat(form.calibDurationMin) || 0;
  const powerNum = parseFloat(form.calibAvgPowerW) || 0;
  const canCompute = distNum > 5 && durMin > 10 && powerNum > 80;

  let resultLine = '';
  if (canCompute) {
    const profile = buildProfile(form);
    const params = paramsFromProfile(profile, form.riderKg, form.bikeKg, form.course);
    const result = solveCdA(
      { distanceKm: distNum, durationSec: durMin * 60, avgPowerW: powerNum },
      params,
    );
    if (result.reason === 'unphysical-cda') {
      resultLine = `<div style="margin-top:8px;font-size:12px;color:#B45309">Inputs imply an unphysical CdA. Likely the ride wasn't flat, or you were drafting.</div>`;
    } else if (result.reason) {
      resultLine = `<div style="margin-top:8px;font-size:12px;color:var(--c-muted)">Need valid distance, duration, and power.</div>`;
    } else {
      resultLine = `
        <div style="margin-top:10px;padding:10px;border-radius:10px;background:rgba(0,0,0,0.03)">
          <div style="font-size:12px;color:var(--c-muted)">Estimated CdA</div>
          <div style="font-size:18px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${result.cda.toFixed(3)} m²</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:2px">Avg ${result.avgKph.toFixed(1)} kph at ${powerNum} W. Confidence: ${result.confidence}.</div>
          <button id="bike-setup-apply-cda" style="margin-top:10px;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--c-border);background:var(--c-surface);font-size:12px;font-weight:600;color:var(--c-black);cursor:pointer">Apply this CdA</button>
        </div>
      `;
    }
  }

  // In-panel auto-fill button (manual mode). Pressing it loads the picked
  // ride's distance/duration/power into the three fields so the user can edit
  // before applying. Distinct from the auto-calibrate flow above (which
  // applies CdA directly without showing the inputs).
  const autoFillBtn = BIKE_SETUP_AUTO_FILL ? `
    <button id="bike-setup-autofill-fields" style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:12px;color:var(--c-black);cursor:pointer;text-align:left;margin-bottom:10px">
      Auto-fill from a recent flat ride →
    </button>
  ` : '';

  // If the user clicked auto-fill and no ride qualified, show a small
  // inline note so the action isn't silently a no-op.
  const autoFillNote = form.autoCalib?.status === 'no-rides' ? `
    <div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,0.03);font-size:11px;color:var(--c-muted);line-height:1.45">
      No qualifying ride in the last 60 days. Need an outdoor ride with power data, ≥30 min, ≥15 km, and ≤1.0% mean gradient.
    </div>
  ` : '';

  void distance;
  return `
    ${autoFillBtn}
    ${autoFillNote}
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
      ${numberInput('calib-dist', form.calibDistKm, 'km', { step: 0.1, min: 0, max: 300, label: 'Distance' })}
      ${numberInput('calib-dur', form.calibDurationMin, 'min', { step: 1, min: 0, max: 600, label: 'Duration' })}
      ${numberInput('calib-power', form.calibAvgPowerW, 'W', { step: 1, min: 0, max: 600, label: 'Avg power' })}
    </div>
    ${hint('Use a steady, flat ride at race-like effort. The flatter and steadier, the better.')}
    ${resultLine}
  `;
}

function renderAutoCalibPanel(form: FormState): string {
  const ac = form.autoCalib;
  if (!ac) return '';
  if (ac.status === 'no-rides') {
    return `
      <div style="margin-bottom:8px;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,0.03);font-size:12px;color:var(--c-muted);line-height:1.45">
        No qualifying ride in the last 60 days. Need an outdoor ride with power data, ≥30 min, ≥15 km, and ≤1.0% mean gradient.
      </div>
    `;
  }
  // success
  const dateLabel = ac.rideDateISO ? fmtRideDate(ac.rideDateISO) : '';

  // Plausibility flag: if the calibrated CdA is a long way from the active
  // position's preset (>25%), the ride was almost certainly done in a
  // different position than the one currently selected. Common case: training
  // on hoods, modal set to TT bike — applying that CdA would massively
  // under-state race-day aero gain. We don't block it, just flag it.
  const preset = CDA_PRESET[form.position];
  const cda = ac.cda ?? 0;
  const ratio = cda / preset;
  const plausibilityNote =
    ratio > 1.25 || ratio < 0.75
      ? `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(180,83,9,0.08);font-size:11px;color:#92400E;line-height:1.5">Looks high vs the ${POSITION_LABEL[form.position]} preset (${preset.toFixed(2)} m²). Was that ride in a different position?</div>`
      : '';

  return `
    <div style="margin-bottom:8px;padding:11px 12px;border-radius:10px;background:rgba(0,0,0,0.03)">
      <div style="font-size:12px;color:var(--c-muted)">Estimated CdA from a recent flat ride</div>
      <div style="font-size:18px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums;margin-top:2px">${cda.toFixed(3)} m²</div>
      <div style="font-size:11px;color:var(--c-muted);margin-top:4px;line-height:1.5">
        ${ac.rideName}${dateLabel ? ` · ${dateLabel}` : ''}<br>
        ${ac.rideDistanceKm?.toFixed(1)} km at ${ac.rideAvgPowerW} W, ${ac.rideAvgGradientPct?.toFixed(2)}% mean gradient. Confidence: ${ac.confidence}.
      </div>
      ${plausibilityNote}
    </div>
  `;
}

function renderWhatIf(form: FormState, distance: '70.3' | 'ironman'): string {
  const rows = ALL_POSITIONS.map(pos => {
    const trial: FormState = { ...form, position: pos, cda: CDA_PRESET[pos], cdaSource: 'preset' };
    const r = predictBikeSplit(trial, distance);
    const isActive = pos === form.position;
    return `
      <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;padding:9px 10px;border-radius:8px;background:${isActive ? 'rgba(0,0,0,0.04)' : 'transparent'}">
        <div style="font-size:13px;color:var(--c-black);${isActive ? 'font-weight:600' : ''}">${POSITION_LABEL[pos]}</div>
        <div style="font-size:13px;color:var(--c-muted);font-variant-numeric:tabular-nums">${r.kph.toFixed(1)} kph</div>
        <div style="font-size:13px;color:var(--c-black);font-variant-numeric:tabular-nums;text-align:right">${fmtDuration(r.splitSec)}</div>
      </div>
    `;
  }).join('');

  return `
    <div style="display:flex;flex-direction:column;gap:2px">${rows}</div>
    ${hint('Predicted bike split per position at your FTP and weight. Tires/course held constant.')}
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Small render helpers
// ───────────────────────────────────────────────────────────────────────────

function section(title: string, body: string): string {
  return `
    <div style="margin-bottom:18px">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--c-muted);margin-bottom:8px">${title}</div>
      ${body}
    </div>
  `;
}

function row(label: string, control: string): string {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0">
      <div style="font-size:13px;color:var(--c-black)">${label}</div>
      ${control}
    </div>
  `;
}

interface NumberInputOpts { step?: number; min?: number; max?: number; label?: string }

function numberInput(id: string, value: number | string, unit: string, opts: NumberInputOpts = {}): string {
  const stepAttr = opts.step != null ? `step="${opts.step}"` : '';
  const minAttr = opts.min != null ? `min="${opts.min}"` : '';
  const maxAttr = opts.max != null ? `max="${opts.max}"` : '';
  const inputHTML = `
    <div style="display:flex;align-items:center;gap:6px">
      <input id="${id}" type="number" ${stepAttr} ${minAttr} ${maxAttr} value="${value}" style="width:90px;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--c-border);background:var(--c-surface);font-size:13px;color:var(--c-black);text-align:right;font-variant-numeric:tabular-nums">
      <span style="font-size:12px;color:var(--c-muted);min-width:28px">${unit}</span>
    </div>
  `;
  if (opts.label) {
    return `
      <div>
        <div style="font-size:11px;color:var(--c-muted);margin-bottom:4px">${opts.label}</div>
        ${inputHTML}
      </div>
    `;
  }
  return inputHTML;
}

function select(id: string, value: string, options: Array<{ value: string; label: string }>): string {
  return `
    <select id="${id}" style="width:100%;height:38px;padding:0 12px;border-radius:8px;border:1px solid var(--c-border);background:var(--c-surface);font-size:13px;color:var(--c-black);font-family:var(--f)">
      ${options.map(o => `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select>
  `;
}

function hint(text: string): string {
  return `<div style="font-size:11px;color:var(--c-muted);margin-top:6px;line-height:1.45">${text}</div>`;
}

/** Small clickable (i) glyph that toggles an inline explanation. */
function infoButton(id: string): string {
  return `<button id="${id}" type="button" aria-label="What is this?" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--c-border);background:transparent;font-size:9px;font-weight:600;color:var(--c-muted);cursor:pointer;padding:0;margin-left:6px;line-height:1;vertical-align:middle">i</button>`;
}

/** Inline explainer card shown when an (i) toggle is open. */
function infoBox(text: string): string {
  return `<div style="margin-top:8px;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.03);font-size:11px;color:var(--c-black);line-height:1.55">${text}</div>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Wiring
// ───────────────────────────────────────────────────────────────────────────

function wireHandlers(overlay: HTMLElement, form: FormState, distance: '70.3' | 'ironman', rerender: () => void): void {
  void distance;

  overlay.querySelector('#bike-setup-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#bike-setup-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#bike-setup-save')?.addEventListener('click', () => {
    // Number inputs commit on blur ('change'), but clicking Save without
    // tabbing out of the field doesn't fire 'change' in time. Sweep the
    // weight inputs ourselves before persisting so a freshly-typed weight
    // isn't lost.
    const riderEl = overlay.querySelector('#rider-kg') as HTMLInputElement | null;
    const bikeEl = overlay.querySelector('#bike-kg') as HTMLInputElement | null;
    const riderV = riderEl ? parseFloat(riderEl.value) : NaN;
    const bikeV = bikeEl ? parseFloat(bikeEl.value) : NaN;
    if (isFinite(riderV)) form.riderKg = riderV;
    if (isFinite(bikeV)) form.bikeKg = bikeV;

    persistForm(form);
    overlay.remove();
    // Refresh the stats / forecast view that hosted the entry point.
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  });

  // Number inputs — fire on blur, not on every keystroke. `<input type="number">`
  // doesn't expose selectionStart/End, so a mid-typing rerender drops the
  // cursor at position 0 in Chrome and the next digit gets prepended (user
  // typing "57" sees "75"). 'change' avoids the rerender-during-typing loop
  // entirely; the prediction strip catches up when the user blurs the field.
  const onNumberChange = (id: string, key: keyof FormState) => {
    const el = overlay.querySelector(`#${id}`) as HTMLInputElement | null;
    if (!el) return;
    el.addEventListener('change', () => {
      const v = parseFloat(el.value);
      if (!isFinite(v)) return;
      (form as unknown as Record<string, unknown>)[key as string] = v;
      rerender();
    });
  };
  onNumberChange('rider-kg', 'riderKg');
  onNumberChange('bike-kg', 'bikeKg');

  // Selects
  const posSelect = overlay.querySelector('#position') as HTMLSelectElement | null;
  if (posSelect) posSelect.addEventListener('change', () => {
    form.position = posSelect.value as BikePosition;
    // Calibrated CdA is position-specific — switching position invalidates it.
    // Try to re-auto-calibrate for the new position so the prediction stays
    // realistic; fall back to the preset if no qualifying ride exists.
    const auto = BIKE_SETUP_AUTO_FILL
      ? computeAutoCalibration(form.position, form.tire, form.riderKg, form.bikeKg)
      : null;
    if (auto) {
      form.cda = auto.cda;
      form.cdaSource = 'calibrated';
      form.autoCalib = auto.ui;
    } else {
      form.cda = CDA_PRESET[form.position];
      form.cdaSource = 'preset';
      form.autoCalib = null;
    }
    rerender();
  });
  const tireSelect = overlay.querySelector('#tire') as HTMLSelectElement | null;
  if (tireSelect) tireSelect.addEventListener('change', () => {
    form.tire = tireSelect.value as BikeTire;
    rerender();
  });
  const courseSelect = overlay.querySelector('#course') as HTMLSelectElement | null;
  if (courseSelect) courseSelect.addEventListener('change', () => {
    form.course = courseSelect.value as BikeCourseProfile;
    rerender();
  });
  // Reveal the dropdown when the user wants to override the auto-detected
  // course. Stays open for the rest of the session.
  overlay.querySelector('#bike-setup-course-change')?.addEventListener('click', () => {
    form.courseDropdownOpen = true;
    rerender();
  });

  // (i) info toggles for CdA and Crr captions.
  overlay.querySelector('#bike-setup-cda-info')?.addEventListener('click', () => {
    form.showCdaInfo = !form.showCdaInfo;
    rerender();
  });
  overlay.querySelector('#bike-setup-crr-info')?.addEventListener('click', () => {
    form.showCrrInfo = !form.showCrrInfo;
    rerender();
  });

  // Calibration toggle
  overlay.querySelector('#bike-setup-show-calib')?.addEventListener('click', () => {
    form.showCalib = true;
    rerender();
  });

  // Auto-fill the manual-entry trio from a recent ride. Doesn't apply CdA
  // directly — the user reviews the loaded values and clicks "Apply this CdA"
  // from the existing result panel.
  overlay.querySelector('#bike-setup-autofill-fields')?.addEventListener('click', () => {
    const ride = pickCalibrationRide();
    if (!ride) {
      form.autoCalib = { status: 'no-rides' };
      rerender();
      return;
    }
    form.calibDistKm = ride.distanceKm.toFixed(1);
    form.calibDurationMin = Math.round(ride.durationSec / 60).toString();
    form.calibAvgPowerW = Math.round(ride.avgPowerW).toString();
    form.autoCalib = null;  // clear any prior status; live result panel takes over
    rerender();
  });

  // Auto-calibrate from a recent ride. Re-runs the same path as the on-open
  // auto-estimate so the user can refresh after picking a different position
  // or after a new ride landed.
  overlay.querySelector('#bike-setup-auto-calib')?.addEventListener('click', () => {
    const auto = computeAutoCalibration(form.position, form.tire, form.riderKg, form.bikeKg);
    if (!auto) {
      form.autoCalib = { status: 'no-rides' };
      rerender();
      return;
    }
    form.cda = auto.cda;
    form.cdaSource = 'calibrated';
    form.autoCalib = auto.ui;
    rerender();
  });

  // Calibration trio — also 'change' (blur) for the same reason as the weight
  // fields. The result panel reads form.calib* and recomputes on rerender.
  const onCalibInput = (id: string, key: keyof FormState) => {
    const el = overlay.querySelector(`#${id}`) as HTMLInputElement | null;
    if (!el) return;
    el.addEventListener('change', () => {
      (form as unknown as Record<string, unknown>)[key as string] = el.value;
      rerender();
    });
  };
  onCalibInput('calib-dist', 'calibDistKm');
  onCalibInput('calib-dur', 'calibDurationMin');
  onCalibInput('calib-power', 'calibAvgPowerW');

  // Apply calibrated CdA
  overlay.querySelector('#bike-setup-apply-cda')?.addEventListener('click', () => {
    const distNum = parseFloat(form.calibDistKm) || 0;
    const durMin = parseFloat(form.calibDurationMin) || 0;
    const powerNum = parseFloat(form.calibAvgPowerW) || 0;
    if (distNum <= 5 || durMin <= 10 || powerNum <= 80) return;

    const profile = buildProfile(form);
    const params = paramsFromProfile(profile, form.riderKg, form.bikeKg, form.course);
    const result = solveCdA({ distanceKm: distNum, durationSec: durMin * 60, avgPowerW: powerNum }, params);
    if (result.reason) return;

    form.cda = result.cda;
    form.cdaSource = 'calibrated';
    form.showCalib = false;
    rerender();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Persistence
// ───────────────────────────────────────────────────────────────────────────

function persistForm(form: FormState): void {
  const ms = getMutableState();
  if (!ms.triConfig) return;

  const ac = form.autoCalib;
  const calibratedRide =
    form.cdaSource === 'calibrated' &&
    ac?.status === 'success' &&
    ac.rideName != null &&
    ac.rideDateISO != null &&
    ac.rideDistanceKm != null &&
    ac.rideAvgPowerW != null &&
    ac.rideAvgGradientPct != null &&
    ac.confidence != null
      ? {
          name: ac.rideName,
          dateISO: ac.rideDateISO,
          distanceKm: ac.rideDistanceKm,
          avgPowerW: ac.rideAvgPowerW,
          gradientPct: ac.rideAvgGradientPct,
          confidence: ac.confidence,
        }
      : undefined;

  const profile: BikeAeroProfile = {
    ...defaultAeroProfile('active', POSITION_LABEL[form.position], form.position, form.tire),
    cda: form.cda,
    cdaSource: form.cdaSource,
    calibratedAtISO: form.cdaSource === 'calibrated' ? new Date().toISOString() : undefined,
    calibratedRide,
  };

  ms.bodyWeightKg = form.riderKg;
  if (!ms.triConfig.bike) ms.triConfig.bike = {};
  ms.triConfig.bike.bikeWeightKg = form.bikeKg;
  ms.triConfig.bike.aeroProfiles = [profile];
  ms.triConfig.bike.courseProfile = form.course;

  // Invalidate cached prediction so the forecast card recomputes with the new physics.
  if (ms.triConfig.prediction) ms.triConfig.prediction = undefined;

  saveState();
}
