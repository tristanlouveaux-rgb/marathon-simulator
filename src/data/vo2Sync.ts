/**
 * VO2 estimates refresh — recompute the cross-modal VO2max picture from
 * current state and persist to `s.vo2Estimates`. Cheap (≈2ms), pure local
 * computation; safe to call on every launch and after physiology sync.
 *
 * See `src/calculations/vo2-orchestrator.ts` for the model and citations.
 */

import { getMutableState, saveState } from '@/state';
import { computeVO2Estimates, type OrchestratorActivity } from '@/calculations/vo2-orchestrator';
import { gp } from '@/calculations/paces';

/**
 * "Clearly improves" gap (ml/kg/min) for auto-clearing a VO2max override.
 * Calibrated against typical Firstbeat measurement noise (~2 ml/kg/min); a
 * 3-point gap is meaningful adaptation rather than algorithm jitter.
 * Comparable in spirit to LT's ≥3 s/km and FTP's ≥3 W thresholds. Pair
 * with a medium+ confidence floor on the derived value (the gap alone
 * isn't enough — we need to trust the new estimate).
 */
const VO2_AUTO_IMPROVE_GAP = 3;

export function refreshVO2Estimates(extra: OrchestratorActivity[] = []): void {
  const s = getMutableState();
  try {
    const result = computeVO2Estimates(s, new Date(), extra);
    s.vo2Estimates = result;

    // Yield-to-improvements: if user has a manual override AND the freshly-
    // computed headline clearly beats it (≥ VO2_AUTO_IMPROVE_GAP, medium+
    // confidence), auto-clear the override. Mirrors the existing FTP/CSS/LT
    // patterns per CLAUDE.md "Manually-set Benchmarks Yield to Improvements".
    if (s.vo2Override) {
      const dVal = result.headline.value;
      const dConf = result.headline.confidence;
      const beats = dVal != null
        && dVal - s.vo2Override.value >= VO2_AUTO_IMPROVE_GAP
        && (dConf === 'high' || dConf === 'medium');
      if (beats) {
        console.log(`[vo2Sync] override auto-improved: user ${s.vo2Override.value} → derived ${Math.round(dVal!)} (${dConf} conf, sport=${result.headline.sport})`);
        delete s.vo2Override;
      }
    }

    // Keep s.pac in sync with the current LT and VDOT so pace zone displays
    // reflect any LT update without needing a plan regeneration.
    s.pac = gp(s.v ?? s.vo2 ?? 45, s.lt ?? null);
    saveState();
    // One-line diagnostic so we can verify the orchestrator ran and what it
    // produced. The `runSrc` field shows which estimator carried the running
    // value — when HR regression doesn't fire we want to see *why* (no RHR /
    // no maxHR / too-few-points / bad-fit) without round-tripping.
    const hr = s.hrCalibratedVdot;
    const hrDiag = hr?.vdot != null
      ? `hr=${Math.round(hr.vdot)} (${hr.confidence}, n=${hr.n})`
      : `hr=null (${hr?.reason ?? 'never-run'})`;
    console.log(
      `[vo2Sync] headline=${result.headline.value != null ? Math.round(result.headline.value) : '—'}`
      + ` (sport=${result.headline.sport ?? '—'}, conf=${result.headline.confidence})`
      + ` · run=${result.running.value != null ? Math.round(result.running.value) : '—'} src=${result.running.source}`
      + ` cyc=${result.cycling.value != null ? Math.round(result.cycling.value) : '—'}`
      + ` card=${result.cardiac.value != null ? Math.round(result.cardiac.value) : '—'}`
      + ` · RHR=${s.restingHR ?? '—'} maxHR=${s.maxHR ?? '—'} ftp=${s.triConfig?.bike?.ftp ?? '—'}`
      + ` lt=${s.lt ? `${Math.round(s.lt)}s/km(${s.ltSource ?? '—'})` : '—'}`
      + ` · ${hrDiag}`
    );
  } catch (err) {
    console.warn('[vo2Sync] computeVO2Estimates failed:', err);
  }
}
