/**
 * Benchmark test cards — pinned to the top of the triathlon plan view.
 *
 * Surfaces "Run the swim CSS test" and "Run the FTP 20-min test" as
 * actionable workouts when the user hasn't entered (or auto-derived) a
 * confident benchmark for that discipline. Marking the test "Done" opens a
 * compact result form that writes the value into `triConfig.{swim,bike}`
 * with `cssSource / ftpSource: 'user'` so the launch-time refresh never
 * overwrites it.
 *
 * Dismissing the card adds the test ID to `triConfig.dismissedTests` so it
 * stops re-appearing on each render. Reset by clearing that field.
 */

import type { SimulatorState } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { computeCSSFromPair } from '@/calculations/tri-benchmarks-from-history';

type TestId = 'css-pair' | 'ftp-20min';

interface PendingTest {
  id: TestId;
  label: string;
  why: string;
  protocol: string;
  inputs: Array<{ id: string; label: string; placeholder: string; mmss?: boolean }>;
  apply: (s: SimulatorState, values: Record<string, string>) => string | null;  // returns error or null
}

/**
 * Decide which tests to show. A test is pending when:
 *   - The benchmark it produces is missing OR was auto-derived (not user)
 *   - AND the test isn't in the dismissed set
 */
export function pendingBenchmarkTests(s: SimulatorState): PendingTest[] {
  const tri = s.triConfig;
  if (!tri) return [];
  const dismissed = new Set((tri as any).dismissedTests as string[] ?? []);
  const out: PendingTest[] = [];

  // Swim CSS test — pending if no paired-TT pair on file (regardless of
  // whether we've estimated CSS another way; the pair is the gold standard).
  const has400 = !!tri.swim?.pbs?.m400;
  const has200 = !!tri.swim?.pbs?.m200;
  if (!(has400 && has200) && !dismissed.has('css-pair')) {
    out.push({
      id: 'css-pair',
      label: 'Swim CSS test',
      why: 'Locks in your threshold swim pace. Anchors all swim workout targets and 70.3 / Ironman swim-leg time predictions.',
      protocol: 'Warm-up 200m easy. Swim 400m all-out, time it, rest 5 min. Swim 200m all-out, time it. Cool-down 100m easy.',
      inputs: [
        { id: 't400', label: '400m time', placeholder: 'e.g. 7:00', mmss: true },
        { id: 't200', label: '200m time', placeholder: 'e.g. 3:10', mmss: true },
      ],
      apply: (st, v) => {
        const t400 = parseMMSS(v.t400);
        const t200 = parseMMSS(v.t200);
        if (!t400 || !t200) return 'Both times are required.';
        const css = computeCSSFromPair(t400, t200);
        if (css == null) return 'Times look off — 400m must be slower than 200m and within reasonable range.';
        const triCfg = st.triConfig;
        if (!triCfg) return 'Triathlon config missing.';
        triCfg.swim = {
          ...(triCfg.swim ?? {}),
          cssSecPer100m: css,
          cssSource: 'user',
          pbs: { ...(triCfg.swim?.pbs ?? {}), m400: t400, m200: t200 },
        };
        return null;
      },
    });
  }

  // FTP 20-min test — pending unless the user has a user-sourced FTP.
  const ftpSrc = tri.bike?.ftpSource;
  const hasUserFtp = !!tri.bike?.ftp && ftpSrc === 'user';
  if (!hasUserFtp && !dismissed.has('ftp-20min')) {
    out.push({
      id: 'ftp-20min',
      label: 'FTP 20-min test',
      why: 'Sets the anchor for every bike target — endurance, sweet-spot, threshold, VO2. Race-day pacing depends on this number being right.',
      protocol: '20-min warm-up with 3×1-min openers. 5 min easy. 20 min all-out at the highest sustainable power. Cool-down 10 min easy. Your FTP ≈ avg power over the 20 min × 0.95.',
      inputs: [
        { id: 'avg20', label: '20-min average power (W)', placeholder: 'e.g. 245' },
      ],
      apply: (st, v) => {
        const avg20 = Number(v.avg20);
        if (!Number.isFinite(avg20) || avg20 < 80 || avg20 > 600) return 'Power must be between 80 and 600 W.';
        const ftp = Math.round(avg20 * 0.95);
        const triCfg = st.triConfig;
        if (!triCfg) return 'Triathlon config missing.';
        triCfg.bike = {
          ...(triCfg.bike ?? {}),
          ftp,
          ftpSource: 'user',
          hasPowerMeter: true,
        };
        return null;
      },
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Card render
// ─────────────────────────────────────────────────────────────────────────────

export function renderBenchmarkTestsCard(s: SimulatorState): string {
  const tests = pendingBenchmarkTests(s);
  if (tests.length === 0) return '';
  return `
    <div class="hf" style="padding:12px 20px 4px;animation-delay:0.08s">
      <div style="background:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">Refine your benchmarks</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:10px">Two short tests that lock in your real threshold values. Sticks at the top until done or dismissed.</div>
        ${tests.map((t) => renderTestRow(t)).join('')}
      </div>
    </div>
  `;
}

function renderTestRow(t: PendingTest): string {
  return `
    <div data-bench-test="${t.id}" style="border-top:1px solid rgba(0,0,0,0.06);padding-top:10px;margin-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <div style="font-size:14px;font-weight:600;color:#0F172A">${t.label}</div>
        <button class="bench-dismiss" data-id="${t.id}" style="background:none;border:none;color:var(--c-faint);font-size:11px;cursor:pointer">Dismiss</button>
      </div>
      <div style="font-size:12px;color:var(--c-muted);margin:4px 0 8px;line-height:1.5">${t.why}</div>
      <details>
        <summary style="font-size:12px;color:#0F172A;cursor:pointer;font-weight:500">How to do this test</summary>
        <div style="font-size:12px;color:var(--c-muted);margin:6px 0 0;line-height:1.55;padding-left:8px;border-left:2px solid rgba(0,0,0,0.06)">${t.protocol}</div>
      </details>
      <button class="bench-open" data-id="${t.id}" style="margin-top:10px;width:100%;padding:9px;background:#0F172A;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:500;cursor:pointer">I've done this test — enter my time</button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring (called once per render of the plan view)
// ─────────────────────────────────────────────────────────────────────────────

export function wireBenchmarkTestsCard(onChange: () => void): void {
  document.querySelectorAll<HTMLButtonElement>('.bench-dismiss').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') as TestId | null;
      if (!id) return;
      const ms = getMutableState();
      if (!ms.triConfig) return;
      const dismissed = new Set((ms.triConfig as any).dismissedTests as string[] ?? []);
      dismissed.add(id);
      (ms.triConfig as any).dismissedTests = Array.from(dismissed);
      saveState();
      onChange();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.bench-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') as TestId | null;
      if (!id) return;
      openResultModal(id, onChange);
    });
  });
}

function openResultModal(id: TestId, onChange: () => void): void {
  const ms = getMutableState();
  const test = pendingBenchmarkTests(ms).find((t) => t.id === id);
  if (!test) return;

  const overlay = document.createElement('div');
  overlay.id = 'bench-test-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.innerHTML = `
    <div style="background:#FAF9F6;width:100%;max-width:420px;border-radius:18px;box-shadow:0 10px 40px rgba(0,0,0,0.3);padding:22px 24px">
      <div style="font-size:16px;font-weight:600;color:#0F172A;margin-bottom:4px">${test.label}</div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;line-height:1.55">${test.protocol}</div>
      ${test.inputs.map((inp) => `
        <label style="display:block;margin-bottom:12px">
          <span style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-faint);margin-bottom:4px">${inp.label}</span>
          <input id="bench-inp-${inp.id}" type="text" placeholder="${inp.placeholder}" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;font-size:14px;color:#0F172A;background:#fff" />
        </label>
      `).join('')}
      <div id="bench-error" style="font-size:12px;color:#c06a50;display:none;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="bench-cancel" style="flex:1;padding:11px;background:rgba(0,0,0,0.05);border:none;border-radius:10px;font-size:13px;font-weight:500;cursor:pointer;color:var(--c-muted)">Cancel</button>
        <button id="bench-save" style="flex:1;padding:11px;background:#0F172A;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:500;cursor:pointer">Save result</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#bench-cancel')?.addEventListener('click', close);
  overlay.querySelector('#bench-save')?.addEventListener('click', () => {
    const values: Record<string, string> = {};
    for (const inp of test.inputs) {
      const el = document.getElementById(`bench-inp-${inp.id}`) as HTMLInputElement | null;
      values[inp.id] = el?.value ?? '';
    }
    const errEl = document.getElementById('bench-error');
    const err = test.apply(getMutableState(), values);
    if (err) {
      if (errEl) { errEl.textContent = err; errEl.style.display = 'block'; }
      return;
    }
    saveState();
    close();
    onChange();
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseMMSS(s: string): number | null {
  if (!s || !s.trim()) return null;
  const parts = s.trim().split(':');
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (parts.length === 2) {
    const [m, sec] = parts.map((p) => Number(p));
    if (!Number.isFinite(m) || !Number.isFinite(sec) || sec < 0 || sec >= 60) return null;
    return m * 60 + sec;
  }
  return null;
}
