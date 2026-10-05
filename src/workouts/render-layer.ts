/**
 * Render-time layers of a running week: illness, holiday and the post-holiday
 * bridge (ui/week-resolve.ts applies them after the plan's own mods and moves).
 *
 * They are re-applied on every render from live state (the illness schedule, the
 * holiday window, the bridge scale), so a value they produce must never be
 * persisted into a mod: it would be applied a second time on the next render and
 * stay baked in after the illness or holiday ends. Flows that write a mod read the
 * plan layers only (resolveWeekForPlanChanges), where each session carries the
 * layer that would adjust it as `renderLayer` and keeps its plan values.
 *
 * Leaf module (no imports) so workout-mods, timing-check and the UI flows can share it.
 */

export type RenderLayer = 'illness' | 'illness-rest' | 'holiday' | 'bridge';

/** modReason the bridge layer stamps on a session it scaled (holiday-modal.ts applyBridgeMods_renderTime). */
const BRIDGE_MOD_REASON = 'Post-holiday bridge';

interface LayerFlags {
  renderLayer?: RenderLayer;
  holidayMod?: boolean;
  illnessMod?: boolean;
  illnessSeverity?: string;
  modReason?: string;
}

/**
 * The render layer that adjusts this session, if any. Reads the `renderLayer` tag
 * of a plan-layers session, or the flags the layers leave on a fully resolved one.
 */
export function renderLayerOf(w: object | null | undefined): RenderLayer | undefined {
  const x = (w ?? {}) as LayerFlags;
  if (x.renderLayer) return x.renderLayer;
  if (x.holidayMod) return 'holiday';
  if (x.illnessMod) return x.illnessSeverity === 'resting' ? 'illness-rest' : 'illness';
  if (x.modReason === BRIDGE_MOD_REASON) return 'bridge';
  return undefined;
}

/**
 * True when a render layer stands the session down this week: a holiday day or an
 * illness rest day. Such a session is not run, so it is never offered for a cut
 * or a recovery change (cutting it would absorb load that was never going to be done).
 */
export function isStoodDownByLayer(w: object | null | undefined): boolean {
  const layer = renderLayerOf(w);
  return layer === 'holiday' || layer === 'illness-rest';
}
