/**
 * Route safety slider — reusable component for both the GPS completion modal
 * and the activity-detail "Rate route safety" CTA.
 *
 * Slider range: 0 (N/A, default) to 10.
 * getScore() returns null for 0 (skipped) and 1–10 for an explicit rating.
 */

export interface SafetySlider {
  el: HTMLElement;
  getScore(): number | null;
}

const LABELS: Record<number, string> = {
  0: 'Skip',
  1: 'Not safe',
  2: 'Not safe',
  3: 'Not safe',
  4: 'Not safe',
  5: 'Mostly safe with a few less safe stretches',
  6: 'Mostly safe in daytime',
  7: 'Safe but daytime only',
  8: 'Safe and well lit, good at night',
  9: 'Safe and well lit, good at night',
  10: 'Safe and well lit, good at night',
};

function labelColour(score: number): string {
  if (score === 0) return 'var(--c-faint)';
  if (score <= 4) return 'var(--c-warn)';
  if (score <= 7) return 'var(--c-caution)';
  return 'var(--c-ok)';
}

export function createSafetySlider(): SafetySlider {
  const el = document.createElement('div');
  el.className = 'safety-slider-block';
  el.innerHTML = `
    <div style="border-top:1px solid var(--c-border);margin:4px 0 16px 0"></div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:14px;color:var(--c-black)">Would you rate this route as safe?</div>
      <button id="safety-info-btn" style="
        width:22px;height:22px;border-radius:50%;border:1px solid var(--c-border);
        background:transparent;color:var(--c-muted);font-size:12px;line-height:1;
        cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center
      ">i</button>
    </div>

    <div id="safety-info-expand" style="
      display:none;font-size:12px;line-height:1.5;color:var(--c-muted);
      background:var(--c-bg);border:1px solid var(--c-border);
      border-radius:8px;padding:10px 12px;margin-bottom:12px
    ">
      Building a safe-routes map for women running at night. Data is collected anonymously.
      Route start and end are hidden before storage.
    </div>

    <div style="text-align:center;margin-bottom:6px">
      <span id="safety-score-value" style="font-size:26px;font-weight:700;color:var(--c-faint)">N/A</span>
    </div>

    <input id="safety-score-slider" type="range" min="0" max="10" value="0" step="1"
      style="width:100%;cursor:pointer;accent-color:var(--c-ok)">

    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--c-faint);margin-top:2px">
      <span>N/A</span>
      <span>1</span>
      <span>5</span>
      <span>10</span>
    </div>

    <div id="safety-anchor-label" style="
      text-align:center;margin-top:6px;font-size:12px;
      min-height:16px;color:var(--c-faint)
    ">Skip</div>
  `;

  let currentScore = 0;

  function update(v: number): void {
    currentScore = v;
    const valueEl = el.querySelector('#safety-score-value') as HTMLElement | null;
    const labelEl = el.querySelector('#safety-anchor-label') as HTMLElement | null;
    if (valueEl) {
      valueEl.textContent = v === 0 ? 'N/A' : String(v);
      valueEl.style.color = labelColour(v);
    }
    if (labelEl) {
      labelEl.textContent = LABELS[v] ?? '';
      labelEl.style.color = labelColour(v);
    }
  }

  const slider = el.querySelector('#safety-score-slider') as HTMLInputElement;
  slider.addEventListener('input', () => update(parseInt(slider.value, 10)));

  const infoBtn = el.querySelector('#safety-info-btn') as HTMLButtonElement;
  const infoExpand = el.querySelector('#safety-info-expand') as HTMLElement;
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const visible = infoExpand.style.display !== 'none';
    infoExpand.style.display = visible ? 'none' : 'block';
  });

  return {
    el,
    getScore(): number | null {
      return currentScore === 0 ? null : currentScore;
    },
  };
}

export type SafetyRatingResult =
  | { submitted: true; score: number | null }
  | { submitted: false };

/**
 * Open a standalone "rate route safety" modal for imported activities.
 * Resolves with { submitted: true, score } when the user taps Submit (score is null for N/A),
 * or { submitted: false } if the modal is dismissed via Cancel or backdrop tap.
 */
export function openSafetyRatingModal(): Promise<SafetyRatingResult> {
  return new Promise((resolve) => {
    const existing = document.getElementById('safety-rating-overlay');
    existing?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'safety-rating-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:60;background:rgba(0,0,0,0.45)';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--c-surface);border:1px solid var(--c-border-strong);border-radius:16px;padding:24px;width:calc(100% - 32px);max-width:400px;box-shadow:0 16px 48px rgba(0,0,0,0.18)';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:600;color:var(--c-black);margin-bottom:4px';
    title.textContent = 'Rate route safety';

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:var(--c-muted);margin-bottom:16px';
    sub.textContent = 'Optional. Helps build a safe-routes map for night running.';

    const slider = createSafetySlider();

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;margin-top:18px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'm-btn-secondary px-4 py-2 rounded-lg text-sm font-medium';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve({ submitted: false }); });

    const submitBtn = document.createElement('button');
    submitBtn.className = 'flex-1 m-btn-primary px-4 py-2 rounded-lg text-sm font-medium';
    submitBtn.textContent = 'Submit';
    submitBtn.addEventListener('click', () => {
      overlay.remove();
      resolve({ submitted: true, score: slider.getScore() });
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(submitBtn);

    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(slider.el);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve({ submitted: false }); }
    });
  });
}
