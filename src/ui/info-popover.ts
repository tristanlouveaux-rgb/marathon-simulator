// Shared info popover for jargon labels in drill-down views.
//
// Usage:
//   import { buildInfoIcon, mountInfoPopovers } from '@/ui/info-popover';
//
//   // In render path:
//   const html = `... ${buildInfoIcon('pahr', 'Pa:Hr decoupling', '<p>...</p>')} ...`;
//
//   // After mounting the view:
//   mountInfoPopovers(rootEl);
//
// Click handlers are delegated from `rootEl`, so re-renders don't need re-wiring
// as long as the same root element persists for the view's lifetime.

const REGISTRY: Map<string, { title: string; body: string }> = new Map();

const OVERLAY_ID = 'info-popover-overlay';

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Returns the HTML for a `(?)` icon button. The popover body is stored in a
 *  module-level registry keyed by `id` and rendered on click via the delegated
 *  handler attached by `mountInfoPopovers`. */
export function buildInfoIcon(id: string, title: string, body: string): string {
  REGISTRY.set(id, { title, body });
  return `<button
    type="button"
    class="info-icon"
    data-info-id="${escapeAttr(id)}"
    aria-label="${escapeAttr(`Explain ${title}`)}"
    style="
      display:inline-flex;align-items:center;justify-content:center;
      width:16px;height:16px;border-radius:50%;
      background:rgba(15,23,42,0.06);border:none;
      color:rgba(15,23,42,0.55);font-size:10px;font-weight:600;
      cursor:pointer;margin-left:4px;padding:0;
      font-family:inherit;line-height:1;vertical-align:middle;
    "
  >?</button>`;
}

function openPopover(id: string): void {
  const entry = REGISTRY.get(id);
  if (!entry) return;
  // Don't stack. Close any existing popover first.
  document.getElementById(OVERLAY_ID)?.remove();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `
    <div style="
      max-width:380px;width:100%;
      background:rgba(255,255,255,0.96);
      backdrop-filter:blur(12px);
      -webkit-backdrop-filter:blur(12px);
      border:1px solid rgba(15,23,42,0.08);
      border-radius:14px;
      box-shadow:0 20px 50px -20px rgba(0,0,0,0.30);
      padding:18px 18px 14px 18px;
    ">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <div style="font-size:15px;font-weight:600;color:rgba(15,23,42,0.92);letter-spacing:-0.005em">${escapeText(entry.title)}</div>
        <button
          type="button"
          id="info-popover-close"
          aria-label="Close"
          style="
            background:none;border:none;cursor:pointer;
            color:rgba(15,23,42,0.45);font-size:18px;line-height:1;
            padding:2px 4px;margin:-2px -4px;
          "
        >×</button>
      </div>
      <div style="font-size:13px;color:rgba(15,23,42,0.72);line-height:1.55">${entry.body}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('info-popover-close')?.addEventListener('click', () => overlay.remove());
}

/** Attach a delegated click handler to `root` so any `.info-icon` button
 *  inside it opens the right popover. Idempotent. Safe to call after every
 *  re-render; uses a marker attribute so duplicate handlers aren't attached. */
export function mountInfoPopovers(root: HTMLElement): void {
  if (root.getAttribute('data-info-popovers-mounted') === '1') return;
  root.setAttribute('data-info-popovers-mounted', '1');
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('.info-icon') as HTMLElement | null;
    if (!btn) return;
    const id = btn.getAttribute('data-info-id');
    if (!id) return;
    e.stopPropagation();
    openPopover(id);
  });
}
