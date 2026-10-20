/**
 * "Log a previous HYROX time" modal.
 *
 * Opens from the forecast chip-detail "You" page when no previous time is
 * on file, and from "Where you lost time" (its paste invitations and "Update
 * result ›"), where the splits are what the athlete came for: that entry
 * opens with the splits section first and expanded (`focusSplits`). Mirrors
 * the four fields from the onboarding wizard step (time + format + race
 * event/date + optional race splits) so users get the same anchoring
 * experience post-onboarding as they did at setup time. A paste carries the
 * run legs and the Roxzone as well as the stations, so the section is "Race
 * splits".
 *
 * On save: applies via `applyHyroxPrevTimeUpdate` (re-derives band, refreshes
 * personal run-pace offset, regenerates plan if the band shifts).
 */

import { getState } from '@/state/store';
import { applyHyroxPrevTimeUpdate } from '@/state/hyrox-prev-time-update';
import { getPastHyroxEvents, getHyroxEventById } from '@/data/hyrox-events';
import { STATION_DISPLAY, STATION_MIN_SEC, HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { HyroxDivision, HyroxStation } from '@/types/triathlon';
import { parseHyroxResultsText } from '@/ui/wizard/steps/hyrox-results-parse';
import { hyroxPastRaceSplits } from '@/calculations/hyrox-lose-time';
import { hyroxDivisionOptions, isHyroxDoublesFormat, resolveHyroxDivision } from '@/calculations/hyrox-division';

type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

function fmtMmSs(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseTime(raw: string): number {
  const parts = raw.trim().split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

/**
 * Open the modal. `onSaved` is called after a successful save so the caller
 * can re-render the surface that triggered the flow. `opts.focusSplits`
 * opens the race splits section expanded and above the finish time (the
 * "where you lost time" entry: a paste fills the finish too).
 */
export function openHyroxLogPrevTimeModal(onSaved?: () => void, opts: { focusSplits?: boolean } = {}): void {
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return;

  const today = new Date().toISOString().slice(0, 10);
  const pastEvents = getPastHyroxEvents(today);

  // Local form state. Only persisted on Save.
  let timeSec: number | undefined = hx.previousHyroxTimeSec;
  let format: HyroxFormat | undefined = hx.hyroxPreviousTimeFormat;
  let raceEventId: string | undefined = hx.hyroxPreviousTimeRaceId;
  let raceDateISO: string | undefined = hx.hyroxPreviousRaceDate;
  // A doubles result's division (the pair's category), so "where you lost
  // time" compares it with the field it was raced in.
  let division: HyroxDivision | undefined = hx.hyroxPreviousTimeDivision
    ?? (isHyroxDoublesFormat(hx.format) ? hx.division : undefined);
  // The result on file opens filled in, so re-saving it keeps its splits
  // (applyHyroxPrevTimeUpdate replaces them with what this save carries).
  // Every value remembers where it came from: 'stored' (the result on file)
  // or 'session' (typed or pasted here). Stored values belong to the stored
  // race only: when the finish or the race (event or date) moves away from it
  // they are cleared on screen (and come back if it moves back), so one save
  // never carries splits from two races. A format correction alone (same
  // finish, event and date) is the same race: its splits stay and are saved
  // with the result, so where you lost time re-reads them in the corrected
  // field. Stored station values are never written into the station
  // benchmarks again (a later station test stays current).
  const stored = hyroxPastRaceSplits(hx);
  let splits: Partial<Record<HyroxStation, number>> = { ...stored.stations };
  const stationOrigin: Partial<Record<HyroxStation, 'stored' | 'session'>> = {};
  for (const st of Object.keys(stored.stations) as HyroxStation[]) stationOrigin[st] = 'stored';
  let runSplitsSec: Array<number | null> | undefined = stored.runLegsSec;
  let runTotalSec: number | undefined = stored.runTotalSec;
  let roxzoneSec: number | undefined = stored.roxzoneSec;
  let runOrigin: 'stored' | 'session' = 'stored';
  let splitsTouched = false;
  const initialResult = { timeSec, format, raceEventId, raceDateISO };
  // The same race: finish, event and date. The format is not part of it (a
  // corrected format is the same race filed in the right field).
  const isSameResult = (): boolean => timeSec === initialResult.timeSec
    && raceEventId === initialResult.raceEventId && raceDateISO === initialResult.raceDateISO;
  let storedShown = true;
  const focusSplits = opts.focusSplits === true;
  let splitsExpanded = focusSplits;

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.32);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';

  const formatOptions: Array<{ id: HyroxFormat; label: string }> = [
    { id: 'open_singles', label: 'Open Singles' },
    { id: 'open_doubles', label: 'Open Doubles' },
    { id: 'pro_singles', label: 'Pro Singles' },
    { id: 'pro_doubles', label: 'Pro Doubles' },
  ];

  const fmtCell = (o: { id: HyroxFormat; label: string }, active: boolean): string => `
    <button data-fmt="${o.id}" class="lpt-fmt-pill" style="padding:10px 8px;border-radius:12px;border:1px solid ${active ? 'var(--c-black)' : 'rgba(0,0,0,0.10)'};background:${active ? 'var(--c-black)' : 'rgba(255,255,255,0.95)'};color:${active ? '#FDFCF7' : 'var(--c-black)'};font-size:13px;cursor:pointer;transition:all 0.15s ease">${o.label}</button>
  `;

  // Race splits (collapsible): last and collapsed by default; first and
  // expanded when focused.
  const splitsSection = `
      <div style="${focusSplits ? 'margin-bottom:14px;border-bottom:1px solid rgba(0,0,0,0.06);padding-bottom:14px' : 'margin-bottom:16px;border-top:1px solid rgba(0,0,0,0.06);padding-top:14px'}">
        <div id="lpt-splits-toggle" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer">
          <div style="font-size:12px;color:var(--c-muted)">Race splits${focusSplits ? '' : ' <span style="color:var(--c-faint)">(optional)</span>'}</div>
          <span id="lpt-splits-chev" style="font-size:12px;color:var(--c-faint);transition:transform 0.2s;${splitsExpanded ? 'transform:rotate(180deg)' : ''}">▼</span>
        </div>
        <div id="lpt-splits-note" style="display:none;font-size:11px;color:var(--c-faint);margin-top:6px;line-height:1.5">Splits from your previous result were cleared. Paste or enter this race's splits.</div>
        <div id="lpt-splits-body" style="display:${splitsExpanded ? 'block' : 'none'};margin-top:12px">
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:8px;line-height:1.5">Open hyresult.com, search your name, open your result, and go to the Timings tab. Copy as much of the splits as you can. A rough selection is fine. Tap "Paste from clipboard", or paste manually below.</div>
          <a id="lpt-results-open" href="https://hyresult.com/" target="_blank" rel="noopener" style="display:block;margin:0 0 8px;padding:10px 12px;border-radius:10px;background:transparent;border:1px solid var(--c-border);color:var(--c-black);font-size:13px;font-weight:500;text-align:center;text-decoration:none">Search hyresult.com →</a>
          <button id="lpt-paste-clip-btn" class="m-btn-secondary" style="width:100%;padding:10px 12px;font-size:13px;margin-bottom:8px">Paste from clipboard</button>
          <textarea id="lpt-paste" rows="3" placeholder="…or paste results here manually" style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:10px;border:1px solid rgba(0,0,0,0.10);background:rgba(255,255,255,0.95);font-size:12px;line-height:1.4;font-family:inherit;outline:none;resize:vertical;margin-bottom:8px"></textarea>
          <button id="lpt-parse-btn" class="m-btn-secondary" style="width:100%;padding:9px;font-size:13px;margin-bottom:12px">Parse splits from text</button>
          <div id="lpt-parse-status" style="font-size:11px;color:var(--c-faint);margin-bottom:10px;display:none"></div>

          ${HYROX_STATION_ORDER.map(st => {
            const display = STATION_DISPLAY[st];
            return `
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <div style="flex:1;font-size:13px;color:var(--c-black)">${display.name}<span style="display:block;font-size:11px;color:var(--c-faint)">${display.distance}</span></div>
                <input type="text" class="lpt-split-input" data-station="${st}" placeholder="mm:ss" value="${splits[st] != null ? fmtMmSs(splits[st]!) : ''}" style="width:80px;text-align:center;flex-shrink:0;padding:8px 10px;border-radius:8px;border:1px solid rgba(0,0,0,0.10);background:rgba(255,255,255,0.95);font-size:13px;font-family:inherit;outline:none" autocomplete="off">
              </div>
            `;
          }).join('')}
        </div>
      </div>
  `;

  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" style="width:100%;max-width:420px;max-height:90vh;overflow-y:auto;background:#FDFCF7;border-radius:18px;padding:22px 20px 18px;box-shadow:0 12px 40px rgba(0,0,0,0.18)">
      <div style="font-size:16px;font-weight:500;color:var(--c-black);margin-bottom:6px">Log a previous HYROX</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:16px">${focusSplits ? 'A pasted result fills in the finish and the splits.' : 'Anchors the prediction against a real race.'} Time and format are required.</div>
      ${focusSplits ? splitsSection : ''}

      <!-- Time -->
      <div style="margin-bottom:14px">
        <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">Finish time</div>
        <input type="text" id="lpt-time" placeholder="e.g. 1:12:30" value="${timeSec != null ? fmtMmSs(timeSec) : ''}" autocomplete="off" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,0.10);background:rgba(255,255,255,0.95);color:var(--c-black);font-size:14px;font-family:inherit;outline:none">
        <div style="font-size:11px;color:var(--c-faint);margin-top:6px;line-height:1.5">h:mm:ss or mm:ss.</div>
      </div>

      <!-- Format -->
      <div style="margin-bottom:14px">
        <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">Format</div>
        <div id="lpt-fmt-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          ${formatOptions.map(o => fmtCell(o, format === o.id)).join('')}
        </div>
        <div style="font-size:11px;color:var(--c-faint);margin-top:6px;line-height:1.5">Doubles times scale differently to singles. Getting this right matters.</div>
        <div id="lpt-division-row" style="display:${isHyroxDoublesFormat(format) ? 'block' : 'none'};margin-top:10px">
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">Division</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
            ${(['women', 'men', 'mixed'] as HyroxDivision[]).map(d => `
              <button data-division="${d}" type="button" style="padding:9px 8px;border-radius:12px;border:1px solid ${division === d ? 'var(--c-black)' : 'rgba(0,0,0,0.10)'};background:${division === d ? 'var(--c-black)' : 'rgba(255,255,255,0.95)'};color:${division === d ? '#FDFCF7' : 'var(--c-black)'};font-size:13px;cursor:pointer;display:${d === 'mixed' && format === 'pro_doubles' ? 'none' : 'block'}">${d === 'women' ? 'Women' : d === 'men' ? 'Men' : 'Mixed'}</button>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Race event -->
      <div style="margin-bottom:14px">
        <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">Which race?</div>
        <select id="lpt-race" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,0.10);background:rgba(255,255,255,0.95);color:var(--c-black);font-size:14px;font-family:inherit;outline:none">
          <option value="" ${!raceEventId && !raceDateISO ? 'selected' : ''}>Select your race…</option>
          ${pastEvents
            .map(ev => {
              const d = new Date(ev.date);
              const label = `${d.toLocaleString('en-US', { month: 'short', year: 'numeric' })}, ${ev.city}`;
              return `<option value="${ev.id}" ${raceEventId === ev.id ? 'selected' : ''}>${label}</option>`;
            })
            .join('')}
          <option value="other" ${!raceEventId && raceDateISO ? 'selected' : ''}>Other / not listed</option>
        </select>
        <div id="lpt-race-date-row" style="display:${!raceEventId && raceDateISO ? 'block' : 'none'};margin-top:10px">
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">When did you race? <span style="color:var(--c-faint)">(month + year)</span></div>
          <input type="month" id="lpt-race-date" value="${raceDateISO ? raceDateISO.slice(0, 7) : ''}" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,0.10);background:rgba(255,255,255,0.95);color:var(--c-black);font-size:14px;font-family:inherit;outline:none">
        </div>
      </div>

      ${focusSplits ? '' : splitsSection}

      <div style="display:flex;gap:10px">
        <button id="lpt-cancel" class="m-btn-secondary" style="flex:1;padding:11px;font-size:13px">Cancel</button>
        <button id="lpt-save" class="m-btn-primary" style="flex:1;padding:11px;font-size:13px;opacity:0.5" disabled>Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const saveBtn = overlay.querySelector('#lpt-save') as HTMLButtonElement;
  const refreshSave = (): void => {
    // A doubles result needs its division (preselected from biological sex
    // when known, paintDivision), so the comparison field is never guessed.
    const ok = timeSec != null && timeSec > 0 && format != null
      && (!isHyroxDoublesFormat(format) || division != null);
    saveBtn.disabled = !ok;
    saveBtn.style.opacity = ok ? '1' : '0.5';
  };
  refreshSave();

  const splitInputs = (): HTMLInputElement[] => [...overlay.querySelectorAll<HTMLInputElement>('.lpt-split-input')];
  const statusEl = (): HTMLDivElement => overlay.querySelector('#lpt-parse-status') as HTMLDivElement;
  /**
   * The finish or race changed: stored splits leave the screen when the race
   * is no longer the stored one, and return when it is again.
   * `quiet` leaves the status line to the caller (a paste writes its own).
   */
  const onResultChange = (quiet = false): void => {
    const same = isSameResult();
    if (same === storedShown) return;
    storedShown = same;
    let moved = 0;
    for (const input of splitInputs()) {
      const st = input.getAttribute('data-station') as HyroxStation;
      if (stationOrigin[st] !== 'stored') continue;
      const v = stored.stations[st];
      if (v == null) continue;
      if (same) { splits[st] = v; input.value = fmtMmSs(v); } else { delete splits[st]; input.value = ''; }
      moved++;
    }
    if (runOrigin === 'stored') {
      const hadRuns = stored.runLegsSec != null || stored.runTotalSec != null || stored.roxzoneSec != null;
      runSplitsSec = same ? stored.runLegsSec : undefined;
      runTotalSec = same ? stored.runTotalSec : undefined;
      roxzoneSec = same ? stored.roxzoneSec : undefined;
      if (hadRuns) moved++;
    }
    if (moved > 0) {
      const note = overlay.querySelector('#lpt-splits-note') as HTMLDivElement;
      note.style.display = same ? 'none' : 'block';
      if (!quiet && same) statusEl().style.display = 'none';
    }
  };

  // Time input
  const timeInput = overlay.querySelector('#lpt-time') as HTMLInputElement;
  timeInput.addEventListener('input', () => {
    const sec = parseTime(timeInput.value);
    timeSec = !isNaN(sec) && sec > 0 ? sec : undefined;
    onResultChange();
    refreshSave();
  });
  timeInput.addEventListener('change', () => {
    if (timeSec != null) timeInput.value = fmtMmSs(timeSec);
  });

  // Division pills (doubles formats only)
  const divisionRow = overlay.querySelector('#lpt-division-row') as HTMLDivElement;
  const paintDivision = (): void => {
    const doubles = isHyroxDoublesFormat(format);
    divisionRow.style.display = doubles ? 'block' : 'none';
    const options = format ? hyroxDivisionOptions(format, s.biologicalSex) ?? [] : [];
    if (division && doubles && !options.includes(division)) division = undefined;
    // Nothing picked yet: the division biological sex implies (a same-sex
    // pair), still one tap to change; unknown sex leaves it to the athlete.
    if (doubles && !division && format) division = resolveHyroxDivision(format, s.biologicalSex) ?? undefined;
    overlay.querySelectorAll<HTMLButtonElement>('[data-division]').forEach(b => {
      const d = b.getAttribute('data-division') as HyroxDivision;
      const active = d === division;
      b.style.display = options.includes(d) ? 'block' : 'none';
      b.style.borderColor = active ? 'var(--c-black)' : 'rgba(0,0,0,0.10)';
      b.style.background = active ? 'var(--c-black)' : 'rgba(255,255,255,0.95)';
      b.style.color = active ? '#FDFCF7' : 'var(--c-black)';
    });
  };
  overlay.querySelectorAll<HTMLButtonElement>('[data-division]').forEach(btn => {
    btn.addEventListener('click', () => {
      division = btn.getAttribute('data-division') as HyroxDivision;
      paintDivision();
      refreshSave();
    });
  });
  // A stored doubles result logged before its division was recorded opens
  // with the division biological sex implies, shown and changeable.
  paintDivision();
  refreshSave();

  // Format pills
  overlay.querySelectorAll<HTMLButtonElement>('[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      format = btn.getAttribute('data-fmt') as HyroxFormat;
      overlay.querySelectorAll<HTMLButtonElement>('[data-fmt]').forEach(b => {
        const active = b.getAttribute('data-fmt') === format;
        b.style.borderColor = active ? 'var(--c-black)' : 'rgba(0,0,0,0.10)';
        b.style.background = active ? 'var(--c-black)' : 'rgba(255,255,255,0.95)';
        b.style.color = active ? '#FDFCF7' : 'var(--c-black)';
      });
      paintDivision();
      onResultChange();
      refreshSave();
    });
  });

  // Race picker
  const raceSelect = overlay.querySelector('#lpt-race') as HTMLSelectElement;
  const raceDateRow = overlay.querySelector('#lpt-race-date-row') as HTMLDivElement;
  const raceDateInput = overlay.querySelector('#lpt-race-date') as HTMLInputElement;
  raceSelect.addEventListener('change', () => {
    const v = raceSelect.value;
    if (v === 'other') {
      raceEventId = undefined;
      raceDateRow.style.display = 'block';
    } else if (v) {
      raceEventId = v;
      const ev = getHyroxEventById(v);
      if (ev) raceDateISO = ev.date;
      raceDateRow.style.display = 'none';
    } else {
      raceEventId = undefined;
      raceDateISO = undefined;
      raceDateRow.style.display = 'none';
    }
    onResultChange();
  });
  raceDateInput.addEventListener('change', () => {
    const v = raceDateInput.value;
    if (v && /^\d{4}-\d{2}$/.test(v)) raceDateISO = `${v}-15`;
    else if (!v) raceDateISO = undefined;
    onResultChange();
  });

  // Splits accordion
  const splitsToggle = overlay.querySelector('#lpt-splits-toggle') as HTMLDivElement;
  const splitsBody = overlay.querySelector('#lpt-splits-body') as HTMLDivElement;
  const splitsChev = overlay.querySelector('#lpt-splits-chev') as HTMLSpanElement;
  splitsToggle.addEventListener('click', () => {
    splitsExpanded = !splitsExpanded;
    splitsBody.style.display = splitsExpanded ? 'block' : 'none';
    splitsChev.style.transform = splitsExpanded ? 'rotate(180deg)' : '';
  });

  // Manual split inputs
  overlay.querySelectorAll<HTMLInputElement>('.lpt-split-input').forEach(input => {
    // Focusing a flagged field counts as reviewing it: drop the amber border.
    input.addEventListener('focus', () => {
      if (input.dataset.lowConfidence) {
        input.style.borderColor = 'rgba(0,0,0,0.10)';
        delete input.dataset.lowConfidence;
      }
    });
    input.addEventListener('change', () => {
      const station = input.getAttribute('data-station') as HyroxStation;
      const raw = input.value.trim();
      splitsTouched = true;
      stationOrigin[station] = 'session';
      if (raw === '') {
        delete splits[station];
        return;
      }
      const sec = parseTime(raw);
      const minSec = STATION_MIN_SEC[station] ?? 0;
      if (!isNaN(sec) && sec >= minSec) {
        splits[station] = sec;
        input.value = fmtMmSs(sec);
        input.style.borderColor = 'rgba(0,0,0,0.10)';
      } else {
        input.value = '';
        input.style.borderColor = '#ef4444';
        setTimeout(() => {
          input.style.borderColor = 'rgba(0,0,0,0.10)';
        }, 2500);
      }
    });
  });

  // Paste parser
  // Shared forgiving parse — a rough or partial copy is enough; unmatched
  // stations just stay blank for manual entry.
  const applyParsed = (rawText: string): void => {
    const status = overlay.querySelector('#lpt-parse-status') as HTMLDivElement;
    const result = parseHyroxResultsText(rawText);
    const stationCount = Object.keys(result.stations).length;
    if (stationCount === 0 && result.totalRaceSec == null) {
      status.style.display = 'block';
      status.textContent = rawText.trim()
        ? "Couldn't find any times in that text. A rough selection of the splits is enough, or enter them by hand below."
        : 'Nothing to read yet. Copy your result page, then paste or tap "Paste from clipboard".';
      return;
    }
    // A paste is the result: its run legs, run total and Roxzone replace the
    // stored ones (absent when the text had none).
    splitsTouched = true;
    runSplitsSec = result.runLegsSec;
    runTotalSec = result.runTotalSec;
    roxzoneSec = result.roxzoneSec;
    runOrigin = 'session';
    // Fields from the looser fallback scan get an amber "check this" border;
    // it clears when the user focuses the field (see focus handler below).
    let lowConfidenceCount = 0;
    overlay.querySelectorAll<HTMLInputElement>('.lpt-split-input').forEach(input => {
      const station = input.getAttribute('data-station') as HyroxStation;
      const sec = (result.stations as Record<string, number>)[station];
      if (sec == null) return;
      input.value = fmtMmSs(sec);
      splits[station] = sec;
      stationOrigin[station] = 'session';
      if (result.stationSource[station] === 'fallback') {
        input.style.borderColor = 'var(--c-caution)';
        input.dataset.lowConfidence = '1';
        lowConfidenceCount++;
      } else {
        input.style.borderColor = 'rgba(0,0,0,0.10)';
        delete input.dataset.lowConfidence;
      }
    });
    if (result.totalRaceSec != null) {
      timeSec = result.totalRaceSec;
      timeInput.value = fmtMmSs(result.totalRaceSec);
      refreshSave();
    }
    // A pasted finish from another race clears the stored stations the
    // paste did not replace.
    onResultChange(true);
    status.style.display = 'block';
    const parts: string[] = [];
    if (stationCount > 0) parts.push(`${stationCount} of 8 station times`);
    const runCount = (result.runLegsSec ?? []).filter(v => v != null).length;
    if (runCount > 0) parts.push(`${runCount} of 8 runs`);
    else if (result.runTotalSec != null) parts.push('the run total');
    if (result.roxzoneSec != null) parts.push('the Roxzone time');
    if (result.totalRaceSec != null) parts.push(`finish ${fmtMmSs(result.totalRaceSec)}`);
    const missing = stationCount > 0 && stationCount < 8 ? ` Add the other ${8 - stationCount} below.` : '';
    const review = lowConfidenceCount > 0
      ? ` ${lowConfidenceCount} ${lowConfidenceCount === 1 ? 'time is' : 'times are'} highlighted as a looser match. Check ${lowConfidenceCount === 1 ? 'it' : 'those'} and tap to edit.`
      : ' Tap any time below to edit.';
    status.textContent = `Found ${parts.join(', ')}.${missing}${review}`;
  };

  const lptPaste = overlay.querySelector('#lpt-paste') as HTMLTextAreaElement;
  overlay.querySelector('#lpt-parse-btn')?.addEventListener('click', () => applyParsed(lptPaste.value));
  lptPaste?.addEventListener('paste', () => { setTimeout(() => applyParsed(lptPaste.value), 0); });
  overlay.querySelector('#lpt-paste-clip-btn')?.addEventListener('click', async () => {
    const status = overlay.querySelector('#lpt-parse-status') as HTMLDivElement;
    try {
      const text = await navigator.clipboard?.readText();
      if (!text || !text.trim()) {
        status.style.display = 'block'; status.textContent = 'Clipboard is empty. Copy your result page first, then tap this again.';
        return;
      }
      lptPaste.value = text;
      applyParsed(text);
    } catch {
      status.style.display = 'block'; status.textContent = "Couldn't read the clipboard. Paste into the box below instead.";
    }
  });

  // Cancel / overlay click
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#lpt-cancel')?.addEventListener('click', () => overlay.remove());

  // Save
  saveBtn.addEventListener('click', () => {
    if (timeSec == null || format == null) return;
    const sameResult = isSameResult();
    // A format correction re-files the same race: its splits are saved with
    // the result under the corrected format (stored values, so never as
    // benchmarks), not left behind in the old format's history.
    const formatChanged = format !== initialResult.format;
    // What is on screen belongs to this result (stored values left the
    // screen when the result changed); only typed or pasted stations become
    // station benchmarks.
    const sessionSplits = Object.fromEntries(
      (Object.keys(splits) as HyroxStation[]).filter(st => stationOrigin[st] === 'session').map(st => [st, splits[st]]),
    ) as Partial<Record<HyroxStation, number>>;
    // A different result keeps only this session's values, whatever the
    // screen shows; the same result keeps its stored ones beside them.
    const resultSplits = sameResult ? splits : sessionSplits;
    const keepRuns = sameResult || runOrigin === 'session';
    applyHyroxPrevTimeUpdate({
      timeSec,
      format,
      raceEventId,
      raceDateISO,
      division: isHyroxDoublesFormat(format) ? division : undefined,
      ...(sameResult && !splitsTouched && !formatChanged
        ? { keepPreviousSplits: true }
        : {
            stationSplits: Object.keys(resultSplits).length > 0 ? resultSplits : undefined,
            benchmarkSplits: sessionSplits,
            runSplitsSec: keepRuns ? runSplitsSec : undefined,
            runTotalSec: keepRuns ? runTotalSec : undefined,
            roxzoneSec: keepRuns ? roxzoneSec : undefined,
          }),
    });
    overlay.remove();
    onSaved?.();
  });
}
