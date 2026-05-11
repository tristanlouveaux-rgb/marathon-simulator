# Mosaic — Cycling & Triathlon Mode QA Checklist

Use this before any release that touches triathlon or cycling mode. Five user profiles; test each in sequence.

---

## Profile A — Cycling-only, no benchmarks set

**Setup**: `trainingMode = 'cycling'`, `cyclingDistance = '160km'`, no FTP set, no aero profile.

### Plan view
- [ ] Only a bike discipline bar is shown (no swim / run bars). Label reads "Hours this week".
- [ ] Week navigation pills are tappable. Future weeks show "Draft. Final workouts depend on the preceding week's performance." banner. Past / current weeks do not.
- [ ] Tapping a future-week card does nothing (no detail modal opens).
- [ ] Benchmark tests card (FTP 20-min test) is visible on the current week.
- [ ] No "No CSS" chips appear on any card — swim is not a cycling-mode discipline.
- [ ] "No FTP" chip appears on bike cards **only after** the FTP test card has been dismissed.

### Forecast view
- [ ] Forecast card shows "Forecast not yet available" with instruction to set FTP. No crash, no blank screen.
- [ ] Bike & aero button in course-factors panel opens the bike setup overlay.

### Dead buttons
- [ ] Every button on Plan, Forecast, Stats, Home taps to something. Nothing is visually present but silent.

---

## Profile B — Cycling-only, FTP set (no aero profile)

**Setup**: same as A but `ftp = 220`, `cyclingDistance = '160km'`, course = flat.

### Forecast view
- [ ] Card headline shows a plausible finish time (160 km at ~0.74 IF × 220W should be roughly 4h 00m–4h 30m on flat).
- [ ] kph value visible and consistent with the headline time (distance / time).
- [ ] IF shown as 0.74.
- [ ] Watts shown as Math.round(220 × 0.74) = 163W.
- [ ] ± band shown in minutes. Tightens to ±6% label when <4 weeks to race.
- [ ] Card label includes the distance ("160 km event target").

### Number consistency check
- [ ] kph × totalSec / 3600 ≈ 160 km (within rounding). Verify manually: kph = km / (totalSec/3600).

---

## Profile C — Cycling-only, FTP + aero profile set

**Setup**: FTP = 250, aero profile filled in, body weight set, bike weight set, course = rolling.

### Forecast view
- [ ] Finish time is computed via full physics (should differ from Profile B's linear estimate).
- [ ] Course label shows "rolling" in the secondary row of the card.
- [ ] Watts and IF still displayed.

---

## Profile D — Triathlon 70.3, benchmarks partially set (CSS only)

**Setup**: `distance = '70.3'`, CSS set, FTP not set.

### Plan view
- [ ] All three discipline bars shown (swim / bike / run). Labels sum correctly.
- [ ] "No FTP" chip appears on bike cards only after FTP test card is dismissed.
- [ ] "No CSS" chip does NOT appear (CSS is set).

### Forecast view
- [ ] Shows "Forecast not yet available" (FTP is missing — full triathlon prediction requires both).
- [ ] Bike & aero button is present.

---

## Profile E — Triathlon Ironman, both benchmarks set

**Setup**: `distance = 'ironman'`, FTP = 280, CSS = 95, skill slider = 3.

### Plan view
- [ ] All three discipline bars visible, proportional.
- [ ] No "No FTP" or "No CSS" chips (both benchmarks are set).
- [ ] Week nav previews future weeks without changing the live week number in the header.
- [ ] Dragging a card to another day (mouse on desktop): card swaps, re-render shows new day assignment.

### Forecast view
- [ ] Full forecast card renders (swim + bike + run legs + transitions).
- [ ] Limiting factor banner visible if conditions trigger it (check with no long ride volume).
- [ ] Course factors panel visible with "Bike & aero →" button that opens overlay.
- [ ] "Projected fitness markers" section shows CSS / FTP / VDOT deltas when >1 unit improvement is projected.
- [ ] Discipline bar proportions match the per-leg times (swim is shortest, bike is longest for IM).

### iOS touch drag-and-drop
- [ ] Long-press + drag on a workout card shows a ghost clone following the finger.
- [ ] Dragging over another card highlights it with a dark outline.
- [ ] Releasing over another card swaps the two workouts to each other's days.
- [ ] Dragging to an empty rest row highlights it with "Drop here". Releasing moves the workout there.
- [ ] A short tap (no drag movement) still opens the workout detail modal. DnD does not steal taps.
- [ ] Vertical scroll in the plan view is not blocked when touching a card and scrolling vertically without crossing the 8 px drag threshold.

---

## Cross-mode isolation checks

Run these whenever both triathlon and cycling modes exist in the same build.

- [ ] Switching from cycling mode to triathlon mode (via onboarding reset) shows triathlon forecast card, not cycling card.
- [ ] Switching from triathlon mode to cycling mode hides the multi-leg forecast and shows the single-number cycling card.
- [ ] Swim benchmark test card does not appear in cycling mode.
- [ ] Discipline mini-bars in plan view never show swim or run bars in cycling mode.

---

## Doc version

Last updated: 2026-05-04. Update this date and the affected profiles whenever the cycling / triathlon UI changes.
