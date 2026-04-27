# Guided Runs — Build Plan

Post-launch feature. Phone-first: audio coaching, haptics, in-run UI, and a lock-screen live widget guide the user through structured workouts while recording GPS. No watch integration in v1 — see "Future (v2): Watch Push" at the bottom.

## Goal

Deliver the best phone-guided structured run experience for runners who don't want to carry a watch-authored workout. The user taps **Start guided run**, and the app walks them through every step: warmup, intervals, recoveries, cooldown. Voice + haptics + live widget. Rest periods announce what's coming next so the runner is never surprised.

## Decisions (locked)

- **Countdown before each interval starts**: 5 seconds (3-2-1 beeps on the last three).
- **Entry point**: explicit toggle on the record screen — "Guided run: on/off". Default on when a structured workout is scheduled for today; off for free runs.
- **Pace deviation cues**: default **on**, user-toggleable in settings.
- **Music behaviour**: **duck** (lower volume) during cues, never pause.
- **Auto-pause**: does not exist in the recorder today — build it as part of this work. Guide engine follows auto-pause (step timer pauses too).

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                     Record screen UI                       │
│  [Guided run: ON]  Step: Threshold rep 2/5   Rem: 02:47   │
│  Target pace: 4:10–4:20/km   Current: 4:14 ✓              │
└────────────────────────────────────────────────────────────┘
           │                                    │
           ▼                                    ▼
┌──────────────────────┐              ┌──────────────────────┐
│  GuideEngine          │◄────events──│   GpsTracker         │
│  - step cursor        │              │  (existing)          │
│  - timers             │              │  emits: onUpdate,    │
│  - deviation watcher  │              │  onSplitComplete,    │
│  - auto-pause         │              │  onPause/onResume    │
└──────────┬───────────┘              └──────────────────────┘
           │ cue events
           ▼
┌────────────┬─────────────┬─────────────────┐
│  VoiceCoach │ HapticCoach │ LiveActivity    │
│  (Web       │ (Capacitor  │  iOS: ActivityKit│
│  Speech)    │  Haptics)   │  Android: Fg     │
│             │             │  notification    │
└────────────┴─────────────┴─────────────────┘
```

## Modules to build

### 1. `src/guided/timeline.ts` — Workout → Steps
Pure TS, no side effects, fully testable.

```ts
type StepType = 'warmup' | 'work' | 'recovery' | 'cooldown' | 'easy';
interface Step {
  idx: number;
  type: StepType;
  label: string;              // "Threshold rep 2 of 5"
  durationSec?: number;       // time-based
  distanceM?: number;         // distance-based
  targetPaceSec?: { min: number; max: number };  // sec/km band
  targetHR?: { min: number; max: number };
  announceStart: string;      // exact voice line
  announceHalfway?: string;
  announceEndWarning?: string;
}
function buildTimeline(w: Workout, vdot: number, unit: 'km'|'mi'): Step[];
```

- Reads `Workout.desc` and computes pace bands from existing VDOT → pace table. No new constants.
- Supports the workout types already generated: easy, long, tempo, threshold, VO2, hills, race.
- Tests: fixture workouts → expected step array.

### 2. `src/guided/engine.ts` — GuideEngine
Listens to tracker events, advances the step cursor, emits cue events.

- Subscribes to `GpsTracker.onUpdate`, `onSplitComplete`, and new `onPause`/`onResume` events.
- Maintains `currentStepIdx`, `stepElapsedSec`, `stepElapsedM`.
- Emits: `stepStart`, `stepHalfway`, `stepEndWarning(remainingSec)`, `stepEnd`, `paceOut(direction)`, `paceOk`.
- Advances automatically on duration- or distance-based completion.
- When auto-pause triggers, step timer freezes; resumes on motion.

### 3. `src/guided/voice.ts` — VoiceCoach
Web Speech API wrapper.

- Queues cues (never overlap). Drops stale cues if the queue backs up >2s.
- Selects best available voice on init (iOS Enhanced voices preferred).
- Duck music: iOS AVAudioSession category option `DuckOthers`; Android audio focus `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`. Requires a small Capacitor plugin or existing audio-session plugin.
- Rate-limits pace deviation cues to 1 per 30s, and never during the final 15s of a step.

### 4. `src/guided/haptics.ts` — HapticCoach
Capacitor Haptics wrapper.

- `stepStart`: double medium impact.
- `stepEnd`: triple medium impact.
- `countdown`: single light impact on each of 5-4-3-2-1.
- `paceOut`: single light impact, rate-limited to 1 per 20s.

### 5. `src/guided/live-activity.ts` — Lock-screen widget
Platform-split.

**iOS (ActivityKit)**
- New Swift widget extension in `ios/App/`. Minimal UI: step label, remaining time, current/target pace, next step preview.
- Capacitor plugin exposes `start(config)`, `update(state)`, `end()`.
- Updates at most every 2s to respect ActivityKit budget.
- Requires `NSSupportsLiveActivities = YES` in Info.plist.

**Android**
- Ongoing foreground-service notification with custom layout (progress bar + text).
- Updated from JS on each tracker tick (≤1 Hz).
- Same notification channel used for the existing GPS recording service.

### 6. Auto-pause (tracker change)
Add to `src/gps/tracker.ts`:
- Detect stop: speed < 0.5 m/s for 5 consecutive seconds → auto-pause.
- Detect resume: speed > 1.5 m/s for 3 consecutive seconds → auto-resume.
- Emit new `onAutoPause` / `onAutoResume` events.
- User-toggleable (default on). Setting stored in state.

### 7. In-run UI (`src/ui/guided-run-view.ts` or additions to existing record view)

**Layout priority (top to bottom)**:
1. Current step label ("Threshold rep 2 of 5") — large.
2. Time or distance remaining in step — hero number.
3. Target pace band with current pace dot (green/amber/red).
4. Secondary strip: HR, total elapsed, total distance.
5. Action row: **Skip step**, **+30s rest** (rest steps only), **Pause**, **End run**.

**Rest-period UX** (the user's specific ask):
- Immediately on step end: voice "Rest. 90 seconds easy." + double haptic.
- Screen flips to Rest mode: big countdown, HR visible, **"Next: 4 min @ 4:15/km"** card always on screen.
- At rem = 30s: voice "Thirty seconds. Next up, threshold rep 2 of 5, four minutes at 4:15 per kilometre."
- At rem = 5s: silent 5-4-3-2-1 countdown (haptic tick per second, no voice).
- At 0: voice "Go." + triple haptic, UI flips to Work mode with target pace prominent.

### 8. Settings (`src/ui/settings/guided-run.ts`)
- Master toggle: "Default guided on for planned runs"
- Voice cues: all / step transitions only / off
- Pace deviation cues: on / off
- Countdown length: 3s / 5s / 10s (default 5s)
- Auto-pause: on / off
- Preferred voice: dropdown of available Enhanced voices

### 9. Post-run: step-level adherence
In `src/ui/activity-detail.ts`, add a "Workout breakdown" section when the activity has guided steps:
- Per step: target pace, actual pace, delta, status (on/over/under).
- Rolls up into the existing activity summary — no new data pipeline.

## Build order (estimated effort)

1. **Timeline builder** + tests — 1 day
2. **Auto-pause in tracker** + tests — 0.5 day
3. **GuideEngine** (pure logic, event-driven) + tests — 1 day
4. **VoiceCoach + HapticCoach** wired to engine — 1 day
5. **In-run UI** with rest countdown and next-step preview — 1–2 days
6. **Android foreground notification widget** — 1 day
7. **iOS Live Activity** (Swift extension + Capacitor plugin) — 3–5 days ← biggest cost
8. **Settings screen** — 0.5 day
9. **Step-level adherence in activity detail** — 1 day

Total: ~10–13 days of focused work. iOS Live Activity is the single biggest unknown.

## Risks & mitigations

- **iOS audio session**: TTS cutting out when the screen locks. Mitigation: background-audio entitlement + confirm AVAudioSession is configured at app init, not at first cue.
- **Voice quality varies**: fall back gracefully if no Enhanced voice is available. Expose the choice in settings.
- **GPS accuracy during intervals**: short reps may finish before the split fires. Timeline uses duration, not distance, for time-based reps — tracker distance is informational only during those steps.
- **Battery**: continuous GPS + screen + TTS is heavy. Mitigation: dim screen between cues, allow screen-off with Live Activity taking over.
- **Live Activity 8-hour limit**: ActivityKit caps at 8 hours. Document as known limit; fine for every normal run.

## Future (v2): Watch Push

Parked. Two paths when we pick it up:

- **Garmin Connect Training API**: server-side push of structured workouts. Requires partner approval (2–6 weeks). New edge function `push-garmin-workout`.
- **Apple Watch via WorkoutKit** (iOS 17+): author `CustomWorkout`, present via `WorkoutScheduler`. No approval, but requires a native Capacitor plugin in Swift.

Both serialize from the same `Step[]` that the guide engine already uses, so v1 is the data model foundation for v2.
