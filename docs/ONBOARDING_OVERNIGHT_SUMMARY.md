# Onboarding Overnight Summary — 2026-04-18

Drafted Pages 5, 6, 7 of the wizard flow. Aesthetic clone of `goals.ts` / `connect-strava.ts` / `review.ts`. Not wired into the controller — morning review then integration.

---

## What was built

| File | Page | Purpose |
|------|------|---------|
| `src/ui/wizard/steps/race-target.ts` | 5 | Running: race picker + date. Fitness: focus picker + optional target date. Hyrox/Triathlon auto-skip. |
| `src/ui/wizard/steps/schedule.ts` | 6 | Runs/week + gym sessions + recurring activities (merge of legacy `frequency.ts` + `activities.ts`). |
| `src/ui/wizard/steps/plan-preview-v2.ts` | 7 | Visual-consistency rewrite of legacy `plan-preview.ts`. State contract preserved. |

All three typecheck clean (`npx tsc --noEmit`).

---

## Preview instructions

The new steps are standalone exports — none are in `OnboardingStep` union or the renderer switch yet. To preview, apply this minimal patch:

**`src/types/onboarding.ts`** — add to the `OnboardingStep` union:

```ts
| 'race-target'
| 'schedule'
| 'plan-preview-v2'
```

**`src/ui/wizard/renderer.ts`** — add imports and cases:

```ts
import { renderRaceTarget } from './steps/race-target';
import { renderSchedule } from './steps/schedule';
import { renderPlanPreviewV2 } from './steps/plan-preview-v2';

// inside switch (step):
case 'race-target':      renderRaceTarget(container, state); break;
case 'schedule':         renderSchedule(container, state); break;
case 'plan-preview-v2':  renderPlanPreviewV2(container, state); break;
```

Then in the browser console:

```js
window.wizardGoTo('race-target')
window.wizardGoTo('schedule')
window.wizardGoTo('plan-preview-v2')
```

Page 7 preview needs running state (`s.rd`, `s.v`, `s.tw`, `s.rw`, `s.wkm`, `s.typ`) populated — easiest path is to let onboarding reach the current plan-preview once, then jump to `plan-preview-v2` from there.

Page 5 on the Hyrox/Triathlon branch will silently call `wizardNext()` — to exercise it, set `state.onboarding.trainingMode` to `'running'` or `'fitness'` first.

---

## Decisions that need your input

### `TODO(tristan)` items flagged in code

1. **`schedule.ts` → `DEFAULT_ACTIVITY_DURATION_MIN = 45`** — when the user taps a sport to add it, we default to 45 min per session. The legacy flow made them type a number. 45 was picked because it's the midpoint of the 30-60 band most sports land in. No codebase source for this number. Confirm or override.
2. **`schedule.ts` → `RUNS_PER_WEEK_OPTIONS = [1..7]`** — kept the full legacy range. Below 3 runs/week the plan generator arguably doesn't have enough signal to produce a coherent running plan. Confirm whether to tighten to `[3..7]`.

### Judgment calls made without a TODO tag

3. **`race-target.ts` → `RACE_LIST_SHOWN = 8`** — matches the `goals.ts` inline event list (which uses `slice(0, 8)`). Inheriting the precedent.
4. **`race-target.ts` → `MIN_PLAN_WEEKS = 4`, `MAX_PLAN_WEEKS = 52`** — mirrors the existing bounds in `goals.ts` stepper and the 4-week minimum in legacy `event-selection.ts` (which uses 8 weeks for half/marathon custom dates but 4 weeks in `goals.ts`). Running with 4/52 to match goals.
5. **Fitness focus list (`'speed' | 'both' | 'endurance'`)** — mirrors `TrainingFocus` type and legacy `goals.ts` options. Same order.
6. **`plan-preview-v2.ts` hero card** — replaced the legacy tinted-green "Predicted Finish Time" card with a white monochrome card. CLAUDE.md prohibits tinted card backgrounds. Down-arrow + time delta kept (e.g. `↓ 14m 30s`) as the only glyph. No emoji.
7. **`plan-preview-v2.ts` milestone nudge copy** — "Adding one quality session per week could close the gap." is new copy, consultant-tone. Confirm or rewrite.
8. **`schedule.ts` "add another" picker flow** — module-local flag `showSportPicker` drives the open/close state of the sport picker (to avoid touching `OnboardingState`). Works, but is a hidden side channel. Not ideal. Cleaner solution would be a proper boolean on `OnboardingState` — needs your call on whether to extend the type.
9. **`race-target.ts` Fitness path** — `continuousMode` is written to `true` when no target date is set, `false` when one is. This matches the `OnboardingState` field's intent (from the comment) but was not explicitly spec'd.

---

## Risk flags

- **Legacy `plan-preview.ts` is still the wired step.** The v2 file is parallel, not a replacement. Until controller rewire, nothing user-facing changes. No regression risk on the live flow.
- **Legacy `event-selection.ts`, `frequency.ts`, `activities.ts` all still wired.** Removing them is a controller-rewire job, not this pass.
- **`OnboardingState._showSportPicker` pseudo-field** in `schedule.ts` uses a cast to `unknown` to stash UI-only open/close state on the state object. Does not mutate the type, does not persist. If you dislike, either lift to a dedicated module-local `Map` or extend `OnboardingState` with a proper boolean.
- **`race-target.ts` Hyrox/Triathlon auto-skip** calls `window.wizardNext()` during render. If the controller's `nextStep` order doesn't include a next step after race-target, this loops. Safe today because the screen isn't wired yet — but wire carefully.
- **`plan-preview-v2.ts`** depends on `s.v`, `s.rd`, `s.tw` being populated. Legacy `plan-preview.ts` tolerates `s.v` being undefined with `|| 50` (kept that fallback). If `s.rd` is `null` (fitness mode, no race), `distanceLabel('null')` returns the string `'null'`. Controller-level branch should route fitness users past this screen or to a fitness-mode preview variant.

---

## What's still left

- **Controller rewire** — `STEP_ORDER`, mode-branching for hyrox/triathlon skip on race-target, retirement of legacy `event-selection` / `frequency` / `activities` / `plan-preview` from the flow.
- **Hyrox + Triathlon Page 5 screens** — deferred per task brief (tiles are coming-soon).
- **Account-settings moves** — `physiology.ts` and `commute.ts` screens still belong to the onboarding flow; per the plan they should move to Account. Not attempted this pass.
- **Page 5 fitness-mode handoff to Page 7** — `plan-preview-v2.ts` is race-centric. If a fitness-mode user reaches Page 7 with `s.rd = null`, we need either a separate fitness preview variant or a conditional in v2. Not wired yet — resolve when the controller is rewired.
- **Imagery** — race-target, schedule, plan-preview-v2 have no imagery. `goals.ts` has the running photo; the new pages default to the ambient-wash background only. Likely fine since these are data-entry screens, but flagging.
- **Test coverage** — none added. Onboarding steps historically have no tests.

---

## Git state

```
?? src/ui/wizard/steps/race-target.ts
?? src/ui/wizard/steps/schedule.ts
?? src/ui/wizard/steps/plan-preview-v2.ts
M  docs/CHANGELOG.md
M  docs/ONBOARDING_PLAN.md
?? docs/ONBOARDING_OVERNIGHT_SUMMARY.md
```

Controller (`src/ui/wizard/controller.ts`), renderer (`src/ui/wizard/renderer.ts`), `src/types/onboarding.ts`, and every existing step file were deliberately left untouched per the task brief.
