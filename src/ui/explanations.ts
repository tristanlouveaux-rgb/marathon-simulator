/**
 * Help modals and tooltips for training concepts.
 */

/**
 * Show RPE (Rate of Perceived Exertion) help modal with 1-10 scale breakdown.
 */
export function showRPEHelp(): void {
  const overlay = document.createElement('div');
  overlay.id = 'rpe-help-modal';
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-5">
      <h3 class="text-white font-semibold text-lg mb-1">RPE Scale</h3>
      <p class="text-xs text-gray-400 mb-4">Rate of Perceived Exertion — how hard did it feel?</p>
      <div class="space-y-1 text-xs">
        <div class="flex items-center gap-2 p-1.5 rounded bg-emerald-950/30">
          <span class="font-bold text-emerald-400 w-6 text-right">1-2</span>
          <span class="text-gray-300">Very easy — could chat freely</span>
        </div>
        <div class="flex items-center gap-2 p-1.5 rounded bg-emerald-950/20">
          <span class="font-bold text-emerald-400 w-6 text-right">3</span>
          <span class="text-gray-300">Easy — comfortable conversation</span>
        </div>
        <div class="flex items-center gap-2 p-1.5 rounded bg-amber-950/20">
          <span class="font-bold text-amber-400 w-6 text-right">4-5</span>
          <span class="text-gray-300">Moderate — short sentences only</span>
        </div>
        <div class="flex items-center gap-2 p-1.5 rounded bg-amber-950/30">
          <span class="font-bold text-amber-400 w-6 text-right">6</span>
          <span class="text-gray-300">Hard — a few words at a time</span>
        </div>
        <div class="flex items-center gap-2 p-1.5 rounded bg-red-950/20">
          <span class="font-bold text-red-400 w-6 text-right">7-8</span>
          <span class="text-gray-300">Very hard — 1-2 words max</span>
        </div>
        <div class="flex items-center gap-2 p-1.5 rounded bg-red-950/30">
          <span class="font-bold text-red-400 w-6 text-right">9</span>
          <span class="text-gray-300">Near max — gasping</span>
        </div>
        <div class="flex items-center gap-2 p-1.5 rounded bg-red-950/40">
          <span class="font-bold text-red-400 w-6 text-right">10</span>
          <span class="text-gray-300">Maximum — cannot sustain</span>
        </div>
      </div>
      <button id="btn-close-rpe-help" class="w-full mt-4 py-2 text-gray-400 hover:text-gray-300 text-xs transition-colors">Close</button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#btn-close-rpe-help')?.addEventListener('click', () => overlay.remove());
}

/**
 * Show Marathon Pace help tooltip/modal.
 */
export function showMPHelp(): void {
  const overlay = document.createElement('div');
  overlay.id = 'mp-help-modal';
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-5">
      <h3 class="text-white font-semibold text-lg mb-1">Marathon Pace (MP)</h3>
      <p class="text-xs text-gray-400 mb-3">The pace you'd sustain for a full marathon on race day.</p>
      <div class="space-y-2 text-xs text-gray-300">
        <p>Marathon pace work teaches your body to burn fat efficiently at race speed. It should feel <strong class="text-white">comfortably hard</strong> — you can say a few words but not hold a conversation.</p>
        <p>Typical RPE: <strong class="text-amber-400">5-6</strong> out of 10.</p>
        <p class="text-gray-500">If you can't maintain the pace for the full session, it's too fast. Slow down 5-10 sec/km.</p>
      </div>
      <button id="btn-close-mp-help" class="w-full mt-4 py-2 text-gray-400 hover:text-gray-300 text-xs transition-colors">Close</button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#btn-close-mp-help')?.addEventListener('click', () => overlay.remove());
}
