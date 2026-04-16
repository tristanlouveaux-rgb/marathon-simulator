import type { Paces } from '@/types';
import type { SplitScheme, SplitSegment } from '@/types';
import { buildTimelineFromDesc, type Step } from '@/guided/timeline';

/**
 * Build a SplitScheme from a workout description and current paces.
 *
 * SplitScheme is a derived view over Timeline: we parse the workout description
 * once via `buildTimeline`, then map each Timeline step to one or more
 * SplitSegments for the tracker. Using a single parser means the voice coach
 * and the on-screen split cues never disagree about what the workout contains.
 *
 * Mapping rules:
 *   - Rep steps (`repIdx` set) become a single paced segment per rep.
 *   - Recovery steps become an untimed segment carrying `durationSeconds`; we
 *     also populate `distance` with the easy-pace jog equivalent so the
 *     tracker has a distance fallback and the UI can render a progress bar.
 *   - Warm-up / cool-down steps become a single paced segment at easy pace.
 *   - Unstructured or single-block distance steps (e.g. "8km", "20km @ MP")
 *     are expanded into per-km splits so the runner sees each km tick.
 *   - Progressive runs (Timeline's 2-step easy-then-fast pattern) are expanded
 *     into per-km easy splits + per-km "Fast km N of M" splits.
 */
export function buildSplitScheme(workoutDesc: string, paces: Paces): SplitScheme {
  const tl = buildTimelineFromDesc(workoutDesc, paces);

  if (tl.steps.length === 0) {
    return { segments: [], totalDistance: 0, description: workoutDesc };
  }

  const segments: SplitSegment[] = [];

  // Progressive runs: Timeline tags the two halves with role. The on-screen
  // splits expand the easy block into per-km ticks and the fast block into
  // "Fast km N of M" ticks.
  const easyStep = tl.steps.find((s) => s.role === 'progressive-easy');
  const fastStep = tl.steps.find((s) => s.role === 'progressive-fast');
  if (easyStep && fastStep) {
    if (easyStep.distanceM != null && easyStep.distanceM > 0) {
      pushKmSplits(segments, easyStep.distanceM, easyStep.targetPaceSec ?? paces.e, 'km');
    }
    if (fastStep.distanceM != null && fastStep.distanceM > 0) {
      pushFastKmSplits(segments, fastStep.distanceM, fastStep.targetPaceSec ?? paces.e);
    }
    const totalDistance = segments.reduce((s, seg) => s + seg.distance, 0);
    return {
      segments,
      totalDistance,
      description: workoutDesc,
    };
  }

  for (const step of tl.steps) {
    mapStep(step, segments, paces);
  }

  const totalDistance = segments.reduce((s, seg) => s + seg.distance, 0);
  return {
    segments,
    totalDistance,
    description: workoutDesc,
  };
}

/** Map a single Timeline step into one or more SplitSegments. */
function mapStep(step: Step, out: SplitSegment[], paces: Paces): void {
  switch (step.type) {
    case 'warmup': {
      const dist = step.distanceM ?? 0;
      const km = dist / 1000;
      const label = `${km % 1 === 0 ? km.toFixed(0) : km}km Warm Up`;
      out.push({
        label,
        distance: dist,
        targetPace: step.targetPaceSec ?? paces.e,
      });
      return;
    }

    case 'cooldown': {
      const dist = step.distanceM ?? 0;
      const km = dist / 1000;
      const label = `${km % 1 === 0 ? km.toFixed(0) : km}km Cool Down`;
      out.push({
        label,
        distance: dist,
        targetPace: step.targetPaceSec ?? paces.e,
      });
      return;
    }

    case 'recovery': {
      // Untimed segment: tracker advances by durationSeconds; we also set a
      // distance fallback equal to the easy-pace jog distance so the UI has a
      // metric to drive progress. targetPace is null because pace doesn't
      // matter during recovery.
      const durationSec = step.durationSec ?? 0;
      const distFallback = durationSec > 0 ? (durationSec / paces.e) * 1000 : 0;
      out.push({
        label: step.repIdx != null ? `Recovery ${step.repIdx}` : 'Recovery',
        distance: distFallback,
        durationSeconds: durationSec > 0 ? durationSec : undefined,
        targetPace: null,
      });
      return;
    }

    case 'work': {
      // Rep-style work step (interval): single paced segment per rep.
      if (step.repIdx != null && step.repTotal != null) {
        const hasDistance = step.distanceM != null && step.distanceM > 0;
        if (hasDistance) {
          out.push({
            label: `Rep ${step.repIdx} of ${step.repTotal}`,
            distance: step.distanceM!,
            targetPace: step.targetPaceSec ?? null,
          });
        } else {
          // Time-based rep: synthesise an equivalent distance so the tracker's
          // distance-based split detection still lines up; `durationSeconds`
          // is not set on work steps because work advances by distance once
          // the runner actually starts running.
          const durationSec = step.durationSec ?? 0;
          const pace = step.targetPaceSec ?? paces.e;
          const distance = pace > 0 ? (durationSec / pace) * 1000 : 0;
          out.push({
            label: `Rep ${step.repIdx} of ${step.repTotal}`,
            distance,
            targetPace: step.targetPaceSec ?? null,
          });
        }
        return;
      }

      // Single-block work (e.g. "20km @ MP", "20min @ threshold"): expand into
      // per-km splits at the target pace.
      const pace = step.targetPaceSec ?? paces.e;
      const dist = step.distanceM != null
        ? step.distanceM
        : step.durationSec != null && pace > 0
          ? (step.durationSec / pace) * 1000
          : 0;
      if (dist > 0) pushKmSplits(out, dist, pace, 'km');
      return;
    }

    case 'easy':
    case 'long': {
      const dist = step.distanceM ?? 0;
      if (dist > 0) pushKmSplits(out, dist, step.targetPaceSec ?? paces.e, 'km');
      return;
    }
  }
}

function pushKmSplits(
  out: SplitSegment[],
  totalDist: number,
  pace: number,
  prefix: string,
): void {
  const fullKm = Math.floor(totalDist / 1000);
  const remainder = totalDist - fullKm * 1000;
  for (let i = 0; i < fullKm; i++) {
    out.push({
      label: `${prefix} ${i + 1}`,
      distance: 1000,
      targetPace: pace,
    });
  }
  if (remainder > 50) {
    out.push({
      label: `${prefix} ${fullKm + 1} (${Math.round(remainder)}m)`,
      distance: remainder,
      targetPace: pace,
    });
  }
}

function pushFastKmSplits(out: SplitSegment[], totalDist: number, pace: number): void {
  const fullKm = Math.floor(totalDist / 1000);
  const remainder = totalDist - fullKm * 1000;
  for (let i = 0; i < fullKm; i++) {
    out.push({
      label: `Fast km ${i + 1} of ${fullKm}`,
      distance: 1000,
      targetPace: pace,
    });
  }
  if (remainder > 50) {
    out.push({
      label: `Fast km ${fullKm + 1} (partial)`,
      distance: remainder,
      targetPace: pace,
    });
  }
}
