/**
 * HYROX trademark disclaimer (ISSUE-232).
 *
 * Renders a single low-contrast line that satisfies nominative-fair-use
 * disclosure for the HYROX wordmark. Placed at the bottom of every HYROX-mode
 * view (above the tab bar) so it's discoverable without dominating any screen.
 *
 * Copy must match the App Store description disclaimer and the marketing
 * carousel disclaimer. Kept in lockstep so a reviewer sees a single
 * consistent statement across all surfaces.
 */
export function buildHyroxTrademarkFooter(): string {
  return `
    <div style="padding:0 20px 16px;text-align:center">
      <div style="font-size:10px;color:var(--c-faint);line-height:1.5;max-width:320px;margin:0 auto">
        HYROX is a registered trademark of HYROX GmbH. Mosaic is not affiliated with or endorsed by HYROX.
      </div>
    </div>
  `;
}
