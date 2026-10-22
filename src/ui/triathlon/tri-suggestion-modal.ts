/**
 * Triathlon plan-modification suggestion modal (v2).
 *
 * Two layouts in one modal:
 *  - **Cross-training overload layout**. When a mod with `overloadOptions`
 *    is in the bundle. Renders: severity-tinted header, discipline chip
 *    switcher (swim/bike/run, default = recommended), proposed mod list
 *    (which re-renders when chips flip), and Reduce / Replace & Reduce /
 *    Keep / Push-to-next-week buttons (mirroring running's modal).
 *  - **Generic checkbox layout**. For volume_ramp, rpe_blown, readiness mods.
 *    Each mod is a checkable row; user accepts a subset.
 *
 * If both kinds of mods are present in one bundle, the overload section
 * renders on top and the checkbox section renders below. Each commits
 * independently. Accepting overload mods does NOT auto-apply checked
 * checkbox rows.
 *
 * Tone: direct, factual. No motivational padding (CLAUDE.md UI Copy rules).
 * Centred overlay (CLAUDE.md modal positioning).
 */

import type { TriSuggestionBundle, TriSuggestionMod } from '@/calculations/tri-suggestion-aggregator';
import type {
  CrossTrainingOverloadResult,
  DisciplineOption,
  OverloadAdjustment,
} from '@/calculations/tri-cross-training-overload';
import type { Discipline } from '@/types/triathlon';
import { answeredModIds } from '@/calculations/tri-suggestion-aggregator';
import { optionHasChange } from '@/calculations/tri-cross-training-overload';
import { applyTriSuggestions } from '@/calculations/tri-suggestion-apply';
import { markTriSuggestionsHandled } from '@/calculations/tri-suggestion-handled';
import { getMutableState, saveState } from '@/state';

const OVERLAY_ID = 'tri-suggestion-overlay';

/**
 * Show the modal and return a Promise resolving to the user's choice.
 * Resolves with `applied` count if user accepted any, `0` if dismissed.
 */
export function showTriSuggestionModal(bundle: TriSuggestionBundle): Promise<number> {
  return new Promise((resolve) => {
    if (bundle.mods.length === 0) {
      resolve(0);
      return;
    }
    if (document.getElementById(OVERLAY_ID)) {
      // Already open from a previous trigger. Don't stack.
      resolve(0);
      return;
    }

    const overload = bundle.mods.find(
      m => m.source === 'cross_training_overload' && m.overloadOptions,
    );
    const otherMods = bundle.mods.filter(m => m !== overload);

    // Per-modal state for the chip switcher.
    let selectedDiscipline: Discipline | undefined =
      overload?.overloadOptions?.recommendedDiscipline;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:1000;
      background:rgba(15,23,42,0.55);
      display:flex;align-items:center;justify-content:center;
      padding:20px;
      animation:tri-sm-fade 0.2s ease-out;
    `;
    overlay.innerHTML = renderModalHTML(overload, otherMods, selectedDiscipline);
    document.body.appendChild(overlay);

    const cleanup = (appliedCount: number) => {
      overlay.remove();
      resolve(appliedCount);
    };

    // Closing on the backdrop answers everything shown (overload as Keep, the
    // generic rows as dismissed), so the modal does not pop again on the next
    // launch (notify-once, tri-suggestion-handled.ts).
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      markTriSuggestionsHandled(getMutableState(), {
        modIds: answeredModIds(otherMods),
        crossTrainingTSS: overload?.overloadOptions?.crossTrainingTSS,
      });
      saveState();
      cleanup(0);
    });

    // ── Cross-training overload wiring ─────────────────────────────────────
    if (overload?.overloadOptions) {
      const opts = overload.overloadOptions;

      // Chip switcher
      const wireChips = () => {
        for (const d of ['swim', 'bike', 'run'] as Discipline[]) {
          document.getElementById(`tri-sm-chip-${d}`)?.addEventListener('click', () => {
            // A chip whose option holds no change is disabled: flipping to it
            // offered only "No upcoming workouts to adjust." with Keep and Push.
            if (!optionHasChange(opts.options[d])) return;
            selectedDiscipline = d;
            const target = document.getElementById('tri-sm-overload-body');
            if (target) target.innerHTML = renderOverloadBody(opts, d);
            syncOverloadButtons(opts.options[d]);
            // Re-render chip styles
            for (const dd of ['swim', 'bike', 'run'] as Discipline[]) {
              const el = document.getElementById(`tri-sm-chip-${dd}`);
              if (el) el.setAttribute('style', chipStyle(opts.options[dd], dd === selectedDiscipline));
            }
          });
        }
      };
      wireChips();

      // Every overload choice answers this load (notify-once): the detector
      // then counts only cross-training logged after it.
      const answerOverload = () => markTriSuggestionsHandled(getMutableState(), { crossTrainingTSS: opts.crossTrainingTSS });

      const commitMods = (which: 'reduce' | 'replace') => {
        const opt = selectedDiscipline ? opts.options[selectedDiscipline] : undefined;
        const adjustments = opt ? (which === 'reduce' ? opt.reduceMods : opt.replaceMods) : [];
        if (adjustments.length === 0) { answerOverload(); saveState(); cleanup(0); return; }
        const triMods: TriSuggestionMod[] = adjustments.map((a, idx) => ({
          id: `xt_${selectedDiscipline}_${idx}`,
          source: 'cross_training_overload',
          discipline: a.discipline,
          headline: a.workoutLabel,
          body: `${a.action} (-${a.tssReduction} TSS)`,
          severity: opts.severity === 'extreme' ? 'warning' : 'caution',
          targetWorkoutId: a.workoutId,
          action: a.action,
        }));
        const result = applyTriSuggestions(getMutableState(), triMods);
        answerOverload();
        saveState();
        cleanup(result.applied);
      };

      document.getElementById('tri-sm-reduce')?.addEventListener('click', () => commitMods('reduce'));
      document.getElementById('tri-sm-replace')?.addEventListener('click', () => commitMods('replace'));
      document.getElementById('tri-sm-keep')?.addEventListener('click', () => {
        answerOverload();
        saveState();
        cleanup(0);
      });
      document.getElementById('tri-sm-push')?.addEventListener('click', () => {
        const sM = getMutableState();
        const wk = sM.wks?.[sM.w - 1];
        if (wk) {
          wk.carriedCrossTrainingTSS = (wk.carriedCrossTrainingTSS ?? 0) + opts.crossTrainingTSS;
        }
        // Answered here, so it leaves this week's count; it counts once, next
        // week, through the decayed carry (computeDecayedTriCarry).
        answerOverload();
        saveState();
        cleanup(0);
      });
    }

    // ── Generic checkbox section wiring (other mods) ───────────────────────
    // Notify-once: every row the user saw is answered by Dismiss or Apply
    // (ticked rows accepted, unticked rows declined), so none is proposed again
    // this week (tri-suggestion-handled.ts). A row merged from two detectors on
    // one session answers both (answeredModIds).
    const otherModIds = answeredModIds(otherMods);
    document.getElementById('tri-sm-dismiss')?.addEventListener('click', () => {
      markTriSuggestionsHandled(getMutableState(), { modIds: otherModIds });
      saveState();
      cleanup(0);
    });
    document.getElementById('tri-sm-accept')?.addEventListener('click', () => {
      const checked: TriSuggestionMod[] = [];
      for (const mod of otherMods) {
        const cb = document.getElementById(`tri-sm-mod-${mod.id}`) as HTMLInputElement | null;
        if (cb?.checked) checked.push(mod);
      }
      const sM = getMutableState();
      const result = checked.length > 0 ? applyTriSuggestions(sM, checked) : { applied: 0 };
      markTriSuggestionsHandled(sM, { modIds: otherModIds });
      saveState();
      cleanup(result.applied);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level render
// ───────────────────────────────────────────────────────────────────────────

function renderModalHTML(
  overload: TriSuggestionMod | undefined,
  otherMods: TriSuggestionMod[],
  selectedDiscipline: Discipline | undefined,
): string {
  const overloadSection = overload?.overloadOptions
    ? renderOverloadSection(overload.overloadOptions, selectedDiscipline ?? overload.overloadOptions.recommendedDiscipline)
    : '';
  const genericSection = otherMods.length > 0
    ? renderGenericSection(otherMods, !!overload)
    : '';

  return `
    <style>
      @keyframes tri-sm-fade { from { opacity:0 } to { opacity:1 } }
      @keyframes tri-sm-rise { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
      .tri-sm-card { animation:tri-sm-rise 0.25s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .tri-sm-row { transition:background 0.15s ease; }
      .tri-sm-row:hover { background:#FAF9F6; }
      .tri-sm-chip { transition:all 0.12s ease; }
      .tri-sm-btn { transition:all 0.12s ease; cursor:pointer; }
      .tri-sm-btn:hover { transform:translateY(-1px); }
    </style>
    <div class="tri-sm-card" style="
      background:#fff;border-radius:18px;padding:22px;
      width:100%;max-width:520px;max-height:90vh;overflow-y:auto;
      box-shadow:0 4px 12px rgba(0,0,0,0.10),0 16px 40px rgba(0,0,0,0.14);
    ">
      ${overloadSection}
      ${genericSection}
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-training overload section
// ───────────────────────────────────────────────────────────────────────────

function renderOverloadSection(opts: CrossTrainingOverloadResult, selected: Discipline): string {
  const overshootPct = Math.round(opts.overshootPct * 100);
  const sevLabel = opts.severity === 'extreme' ? 'extreme' : 'heavy';
  const sevColour = opts.severity === 'extreme' ? '#c06a50' : '#a89060';
  const sevBg = opts.severity === 'extreme' ? '#FBEDDF' : '#FAF3E2';

  const chips = (['bike', 'run', 'swim'] as Discipline[])
    .map(d => `
      <button id="tri-sm-chip-${d}" class="tri-sm-chip" style="${chipStyle(opts.options[d], d === selected)}"${optionHasChange(opts.options[d]) ? '' : ' disabled aria-disabled="true"'}>
        ${d.charAt(0).toUpperCase() + d.slice(1)}
      </button>
    `)
    .join('');

  return `
    <div style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:17px;font-weight:600;color:#0F172A;letter-spacing:-0.01em">Cross-training overload</span>
        <span style="font-size:10px;background:${sevBg};color:${sevColour};padding:2px 8px;border-radius:6px;font-weight:500">${sevLabel}</span>
      </div>
      <div style="font-size:12px;color:#64748B;line-height:1.5">
        Cross-training added <strong>${opts.crossTrainingTSS} TSS</strong> on top of your <strong>${opts.plannedTriTSS} TSS</strong> tri plan (+${overshootPct}%). Pick a discipline to ease.
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:14px">
      ${chips}
    </div>

    <div id="tri-sm-overload-body">
      ${renderOverloadBody(opts, selected)}
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:18px">
      <div style="display:flex;gap:8px">
        <button id="tri-sm-reduce" class="tri-sm-btn" style="
          flex:1;padding:11px;border-radius:10px;
          border:none;background:var(--c-accent,#0F172A);
          font-size:13px;font-weight:500;color:#fff;
          ${opts.options[selected].reduceMods.length > 0 ? '' : 'display:none;'}
        ">Reduce</button>
        <button id="tri-sm-replace" class="tri-sm-btn" style="
          flex:1;padding:11px;border-radius:10px;
          border:1px solid var(--c-border);background:transparent;
          font-size:13px;font-weight:500;color:#0F172A;
          ${opts.options[selected].replaceMods.length > 0 ? '' : 'display:none;'}
        ">Replace &amp; Reduce</button>
        <button id="tri-sm-keep" class="tri-sm-btn" style="
          flex:1;padding:11px;border-radius:10px;
          border:1px solid var(--c-border);background:transparent;
          font-size:13px;color:var(--c-muted);
        ">Keep</button>
      </div>
      <button id="tri-sm-push" class="tri-sm-btn" style="
        padding:9px;border-radius:10px;
        border:1px dashed var(--c-border);background:transparent;
        font-size:12px;color:var(--c-muted);
      ">Push to next week</button>
    </div>
  `;
}

/**
 * Show only the choices the selected discipline can act on: Reduce when its
 * set holds a change, Replace & Reduce when its set holds a swap (the detector
 * leaves it empty otherwise, since it would repeat Reduce). Keep and Push
 * always show. Re-run when the chip changes.
 */
function syncOverloadButtons(opt: DisciplineOption): void {
  const reduce = document.getElementById('tri-sm-reduce');
  if (reduce) reduce.style.display = opt.reduceMods.length > 0 ? '' : 'none';
  const replace = document.getElementById('tri-sm-replace');
  if (replace) replace.style.display = opt.replaceMods.length > 0 ? '' : 'none';
}

function renderOverloadBody(opts: CrossTrainingOverloadResult, selected: Discipline): string {
  const opt = opts.options[selected];
  const reduceMods = opt.reduceMods;
  const replaceMods = opt.replaceMods;

  const remainingLine = opt.floorTSS > 0
    ? `<span style="color:var(--c-muted)">remaining ${opt.remainingTSS} TSS · floor ${opt.floorTSS} TSS</span>`
    : `<span style="color:var(--c-muted)">remaining ${opt.remainingTSS} TSS · no floor (taper or hot ramp)</span>`;

  const floorLine = floorWarningText(opt);
  const belowFloorWarning = floorLine
    ? `<div style="font-size:11px;color:#c06a50;margin-top:6px">${floorLine}</div>`
    : '';

  // The detector recommends only a discipline with a change, and a chip whose
  // option holds none is disabled (E7), so this line is a fallback the chips
  // cannot reach. A set with no change gets no section and no button.
  const noChange = reduceMods.length === 0 && replaceMods.length === 0
    ? `<div style="color:var(--c-muted);font-size:12px;font-style:italic;margin-top:6px">No upcoming workouts to adjust.</div>`
    : '';

  return `
    <div style="font-size:12px;line-height:1.5;margin-bottom:10px">${remainingLine}</div>
    ${belowFloorWarning}
    ${noChange}
    ${reduceMods.length > 0 ? `
      <details open style="border:1px solid var(--c-border);border-radius:10px;padding:10px 12px;margin-top:6px">
        <summary style="font-size:12px;color:#0F172A;font-weight:500;cursor:pointer;list-style:none">
          Reduce. ${reduceMods.length} change${reduceMods.length === 1 ? '' : 's'}
        </summary>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
          ${reduceMods.map(renderModLine).join('')}
        </div>
      </details>
    ` : ''}
    ${replaceMods.length > 0 ? `
      <details ${reduceMods.length > 0 ? '' : 'open '}style="border:1px solid var(--c-border);border-radius:10px;padding:10px 12px;margin-top:6px">
        <summary style="font-size:12px;color:#0F172A;font-weight:500;cursor:pointer;list-style:none">
          Replace &amp; Reduce. ${replaceMods.length} change${replaceMods.length === 1 ? '' : 's'}
        </summary>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
          ${replaceMods.map(renderModLine).join('')}
        </div>
      </details>
    ` : ''}
  `;
}

/** An offered set (one holding a change) would take the discipline below its
 *  floor: the floor warning shows and the chip dims (E7). */
export function optionBreachesFloor(opt: DisciplineOption): boolean {
  return (opt.reduceMods.length > 0 && opt.belowFloor)
    || (opt.replaceMods.length > 0 && opt.replaceBelowFloor);
}

/**
 * The floor warning names the set that breaches the floor (2026-10-22): the
 * Reduce set alone was checked, so a Replace & Reduce set offered without
 * Reduce, or with a larger cut, could take the discipline below its floor
 * with no warning. When the discipline already sits below its floor, every
 * offered set keeps it there, and the line says so (E7). Null when no offered
 * set breaches it.
 */
export function floorWarningText(opt: DisciplineOption): string | null {
  const reduceOffered = opt.reduceMods.length > 0;
  const replaceOffered = opt.replaceMods.length > 0;
  const reduceBreaches = reduceOffered && opt.belowFloor;
  const replaceBreaches = replaceOffered && opt.replaceBelowFloor;
  if (!reduceBreaches && !replaceBreaches) return null;
  const floor = `your weekly floor (${opt.floorTSS} TSS)`;
  if (opt.alreadyBelowFloor) {
    return reduceOffered && replaceOffered
      ? `Either set keeps this discipline below ${floor}.`
      : `These changes keep this discipline below ${floor}.`;
  }
  if (reduceBreaches && replaceOffered && !replaceBreaches) {
    return `Reduce would push this discipline below ${floor}. Replace &amp; Reduce keeps it above.`;
  }
  if (replaceBreaches && reduceOffered && !reduceBreaches) {
    return `Replace &amp; Reduce would push this discipline below ${floor}. Reduce keeps it above.`;
  }
  return reduceOffered && replaceOffered
    ? `Either set would push this discipline below ${floor}.`
    : `These changes would push this discipline below ${floor}.`;
}

function renderModLine(m: OverloadAdjustment): string {
  const actionLabel =
    m.action === 'swap_easy' ? 'Swap to easy'
    : m.action === 'downgrade_today' ? 'Downgrade'
    : 'Trim';
  return `
    <div style="display:flex;justify-content:space-between;font-size:12px;color:#0F172A">
      <span style="font-weight:500">${actionLabel}: ${m.workoutLabel}</span>
      <span style="color:var(--c-muted)">−${m.tssReduction} TSS</span>
    </div>
  `;
}

function chipStyle(opt: DisciplineOption, isSelected: boolean): string {
  const base = `
    flex:1;padding:10px 12px;border-radius:10px;
    font-size:12px;font-weight:500;cursor:pointer;text-align:center;
    border:1px solid ${isSelected ? 'var(--c-accent,#0F172A)' : 'var(--c-border)'};
  `;
  if (isSelected) {
    return `${base};background:var(--c-accent,#0F172A);color:#fff;`;
  }
  // No change to offer: disabled (the button carries `disabled`), dimmed.
  if (!optionHasChange(opt)) {
    return `${base};background:transparent;color:var(--c-muted);opacity:0.4;cursor:default;`;
  }
  // Any offered set breaches the floor (Reduce or Replace & Reduce): dimmed,
  // still selectable; the body names the set.
  if (optionBreachesFloor(opt)) {
    return `${base};background:transparent;color:var(--c-muted);opacity:0.6;`;
  }
  return `${base};background:transparent;color:#0F172A;`;
}

// ───────────────────────────────────────────────────────────────────────────
// Generic (non-overload) section
// ───────────────────────────────────────────────────────────────────────────

function renderGenericSection(mods: TriSuggestionMod[], hasOverloadAbove: boolean): string {
  const title = hasOverloadAbove
    ? `Other suggestions (${mods.length})`
    : (mods.length === 1 ? '1 plan adjustment suggested' : `${mods.length} plan adjustments suggested`);
  const sub = 'Tick the ones you accept. Anything you leave unchecked stays as planned.';
  const separator = hasOverloadAbove
    ? `<hr style="border:none;border-top:1px solid var(--c-border);margin:18px 0">`
    : '';

  return `
    ${separator}
    <div style="margin-bottom:18px">
      <div style="font-size:${hasOverloadAbove ? '14' : '17'}px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;line-height:1.3">${title}</div>
      <div style="font-size:12px;color:#64748B;line-height:1.5;margin-top:4px">${sub}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">
      ${mods.map(renderModRow).join('')}
    </div>
    <div style="display:flex;gap:10px">
      <button id="tri-sm-dismiss" class="tri-sm-btn" style="
        flex:1;padding:11px;border-radius:10px;
        border:1px solid var(--c-border);background:transparent;
        font-size:13px;color:var(--c-muted);
      ">Dismiss</button>
      <button id="tri-sm-accept" class="tri-sm-btn" style="
        flex:1;padding:11px;border-radius:10px;
        border:none;background:var(--c-accent,#0F172A);
        font-size:13px;font-weight:500;color:#fff;
      ">Apply selected</button>
    </div>
  `;
}

function renderModRow(mod: TriSuggestionMod): string {
  const sevColour = mod.severity === 'warning' ? '#c06a50' : '#a89060';
  const sevBg     = mod.severity === 'warning' ? '#FBEDDF' : '#FAF3E2';
  const discLabel = mod.discipline === 'all' ? 'all'
    : mod.discipline.charAt(0).toUpperCase() + mod.discipline.slice(1);
  return `
    <label class="tri-sm-row" for="tri-sm-mod-${mod.id}" style="
      display:flex;gap:12px;padding:12px;border-radius:10px;
      border:1px solid var(--c-border);cursor:pointer;
    ">
      <input type="checkbox" id="tri-sm-mod-${mod.id}" checked
        style="margin-top:3px;width:16px;height:16px;flex-shrink:0;cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:#0F172A;line-height:1.3">${mod.headline}</span>
          <span style="font-size:10px;background:${sevBg};color:${sevColour};padding:1px 6px;border-radius:6px">${discLabel}</span>
        </div>
        <div style="font-size:12px;color:#64748B;line-height:1.5">${mod.body}</div>
      </div>
    </label>
  `;
}
