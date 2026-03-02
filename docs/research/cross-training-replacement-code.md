Cross sport training replacement code  """
cross_training_suggester.py
===========================

Suggestion-based cross-training → running plan adjustments.

Key design choices (per your spec):
- Runs are adjusted; other sport sessions are NEVER modified/replaced.
- Outputs ONE popup payload containing:
  - severity (light/heavy/extreme)
  - global suggestion (optional)
  - per-workout suggestions with 3 options: Replace / Reduce / Keep
- Uses "beautiful split":
  1) RecoveryCostLoad: how much fatigue / recovery risk the sport adds
  2) RunReplacementCredit: how much *running* stimulus the sport can substitute
     = RecoveryCostLoad * run_specificity (runSpec)
- Matching uses "vibe similarity" (anaerobic ratio + weighted load proximity).
- Guardrails:
  - preserve >= ceil(planned_runs * 0.5) running sessions (Rule C)
  - long run: never REPLACE unless injury_mode=True; reduce last
  - minimum easy run distance when reducing: 4.0 km (otherwise recommend replace)
- Preference:
  - more reduction than deletion
  - replacement requires explicit user confirmation (still offered in options)

No HR research or HR zones. HR may be used only as an input to estimate load
if Garmin aerobic/anaerobic load is missing (Apple Watch case).
"""

from __future__ import annotations
from dataclasses import dataclass, replace
from typing import List, Optional, Dict, Tuple, Literal
import math


WorkoutType = Literal[
    "easy", "long", "threshold", "vo2", "race_pace", "marathon_pace",
    "intervals", "mixed", "progressive", "hill_repeats"
]
SportKey = str
Severity = Literal["light", "heavy", "extreme"]
Choice = Literal["keep", "reduce", "replace"]


# ----------------------------
# Input models
# ----------------------------

@dataclass(frozen=True)
class PlannedRun:
    workout_id: str
    day_index: int                 # 0..6
    workout_type: WorkoutType
    planned_distance_km: float
    planned_aerobic: float         # Garmin-like aerobic load expectation for this run
    planned_anaerobic: float       # Garmin-like anaerobic load expectation for this run
    status: str = "planned"        # planned|completed|skipped|replaced|reduced


@dataclass(frozen=True)
class CrossActivity:
    day_index: int
    sport_key: SportKey
    duration_min: float
    rpe: Optional[int] = None                 # 1..10
    # If Garmin/Firstbeat is available, these should be filled:
    aerobic_load: Optional[float] = None
    anaerobic_load: Optional[float] = None
    # If Apple Watch is available:
    distance_km: Optional[float] = None
    avg_hr: Optional[float] = None            # optional
    # Device label purely for transparency/logging
    device: Optional[Literal["garmin", "apple_watch", "none"]] = None


@dataclass(frozen=True)
class SportProfile:
    mult: float                    # scales RPE-based load estimate when no Garmin loads
    runSpec: float                 # 0..1: how well the sport substitutes running stimulus
    recovery_mult: float           # >=1 typically for team sports; <1 for low impact etc.
    cannot_replace: Tuple[str, ...] = tuple() # workout types that sport cannot replace (hard constraint)


@dataclass(frozen=True)
class AthleteContext:
    race_goal: Literal["5k", "10k", "half", "marathon"]
    planned_runs_per_week: int
    injury_mode: bool = False


# ----------------------------
# Output models
# ----------------------------

@dataclass(frozen=True)
class Option:
    choice: Choice
    new_type: WorkoutType
    new_distance_km: float
    rationale: str
    tradeoffs: str


@dataclass(frozen=True)
class RunSuggestion:
    workout_id: str
    day_index: int
    current_type: WorkoutType
    current_distance_km: float
    similarity: float
    recommended: Choice                 # default highlighted choice in UI
    options: List[Option]


@dataclass(frozen=True)
class GlobalSuggestion:
    title: str
    message: str
    # suggested % reduction of *non-long* runs (0.0–0.5 typical)
    reduce_non_long_by: float
    # suggested downgrade level for next quality sessions
    downgrade_next_quality: bool


@dataclass(frozen=True)
class SuggestionPopup:
    severity: Severity
    headline: str
    summary: str
    # loads exposed for transparency/debug
    recovery_cost_load: float
    run_replacement_credit: float
    anaerobic_ratio: float
    global_suggestion: Optional[GlobalSuggestion]
    run_suggestions: List[RunSuggestion]
    # Extra notes/warnings for UX
    warnings: List[str]


# ----------------------------
# Constants / knobs (tunable)
# ----------------------------

ANAEROBIC_WEIGHT = 1.50

# Saturation curve to prevent massive sessions from linearly replacing everything
TAU = 800.0
MAX_CREDIT = 1500.0

# Guardrails
MIN_EASY_KM = 4.0

# Similarity model
LOAD_SMOOTHING = 30.0
RATIO_WEIGHT = 0.60
LOAD_WEIGHT = 0.40
SAME_DAY_BONUS = 0.10
LONG_PENALTY = 0.25

# Thresholds (tunable; chosen to align with your saturation cap scale)
HEAVY_LOAD = 600.0
EXTREME_LOAD = 1000.0

# When to even propose replacing a run (still user-confirmed)
REPLACE_RATIO_THRESHOLD = 0.95
REDUCE_RATIO_THRESHOLD = 0.25

# Budgeting (prevents runaway replacement)
REPLACE_BUDGET_FRAC = 0.75
REDUCE_BUDGET_FRAC = 0.40

# Max number of targeted modifications suggested in one popup (keeps UI sane)
# Note: global suggestion covers the rest.
MAX_TARGETED_SUGGESTIONS = 3


# ----------------------------
# Helpers
# ----------------------------

def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))

def weighted_load(aerobic: float, anaerobic: float) -> float:
    return float(aerobic + ANAEROBIC_WEIGHT * anaerobic)

def anaerobic_ratio(aerobic: float, anaerobic: float) -> float:
    total = aerobic + anaerobic
    return 0.0 if total <= 1e-9 else float(anaerobic / total)

def saturate(raw_load: float) -> float:
    # EffectiveLoad = MaxCredit * (1 - exp(-RawLoad / tau))
    return float(MAX_CREDIT * (1.0 - math.exp(-raw_load / TAU)))

def default_rpe(rpe: Optional[int]) -> int:
    return 5 if rpe is None else int(clamp(rpe, 1, 10))

# RPE→load-per-minute table (from your system summary)
LOAD_PER_MIN = {
    1: 0.5,
    2: 0.8,
    3: 1.1,
    4: 1.6,
    5: 2.0,
    6: 2.7,
    7: 3.5,
    8: 4.5,
    9: 5.3,
    10: 6.0,
}

def estimate_raw_load_from_rpe(duration_min: float, rpe: Optional[int], sport_mult: float) -> float:
    r = default_rpe(rpe)
    lpm = LOAD_PER_MIN.get(r, 2.0)
    return float(duration_min * lpm * sport_mult)

def resolve_activity_load(
    act: CrossActivity,
    sport: SportProfile,
) -> Tuple[float, float, float]:
    """
    Returns (aerobic, anaerobic, raw_weighted)
    If Garmin loads exist -> use them.
    Else estimate total raw load from RPE*duration*sport mult and split into
    aerobic/anaerobic via a heuristic based on RPE.

    NOTE: We intentionally keep this simple. If Apple Watch HR is available,
    your upstream pipeline can compute aerobic/anaerobic loads more accurately
    and pass them in here.
    """
    if act.aerobic_load is not None and act.anaerobic_load is not None:
        a = float(act.aerobic_load)
        an = float(act.anaerobic_load)
        return a, an, weighted_load(a, an)

    # Estimate total raw training load
    raw = estimate_raw_load_from_rpe(act.duration_min, act.rpe, sport.mult)

    # Split heuristic: higher RPE -> more anaerobic proportion
    r = default_rpe(act.rpe)
    # 1..10 mapped to 5%..40% anaerobic share
    an_share = clamp(0.05 + (r - 1) * (0.35 / 9.0), 0.05, 0.40)
    an = raw * an_share / ANAEROBIC_WEIGHT   # invert weighting so that weighted_load ≈ raw
    a = max(0.0, raw - (ANAEROBIC_WEIGHT * an))
    return float(a), float(an), float(raw)

def vibe_similarity(a1: float, an1: float, a2: float, an2: float) -> float:
    r1 = anaerobic_ratio(a1, an1)
    r2 = anaerobic_ratio(a2, an2)
    w1 = weighted_load(a1, an1)
    w2 = weighted_load(a2, an2)

    ratio_score = 1.0 - abs(r1 - r2)
    load_score = 1.0 / (1.0 + abs(w1 - w2) / LOAD_SMOOTHING)
    return float(RATIO_WEIGHT * ratio_score + LOAD_WEIGHT * load_score)

def severity_from_load(eff_load: float) -> Severity:
    if eff_load >= EXTREME_LOAD:
        return "extreme"
    if eff_load >= HEAVY_LOAD:
        return "heavy"
    return "light"

def can_replace_workout(act_sport: SportProfile, wt: WorkoutType, ctx: AthleteContext) -> bool:
    if wt == "long" and not ctx.injury_mode:
        return False
    if wt in act_sport.cannot_replace:
        return False
    return True

def preserve_run_count_min(planned_runs: int) -> int:
    # Rule C guardrail
    return max(1, int(math.ceil(planned_runs * 0.5)))

def workout_priority_for_race(ctx: AthleteContext, wt: WorkoutType) -> int:
    """
    Lower number = protect more (harder to replace).
    """
    if ctx.race_goal == "marathon":
        # Protect long + MP most; VO2 least important.
        order = {
            "long": 0,
            "marathon_pace": 1,
            "threshold": 2,
            "race_pace": 3,
            "vo2": 6,
            "intervals": 5,
            "hill_repeats": 4,
            "progressive": 3,
            "mixed": 4,
            "easy": 7,
        }
        return order.get(wt, 5)

    if ctx.race_goal == "half":
        order = {
            "long": 1,
            "threshold": 0,
            "race_pace": 2,
            "vo2": 3,
            "easy": 6,
            "progressive": 3,
            "mixed": 4,
            "hill_repeats": 4,
            "marathon_pace": 5,
            "intervals": 3,
        }
        return order.get(wt, 4)

    if ctx.race_goal == "10k":
        order = {
            "threshold": 0,
            "vo2": 1,
            "race_pace": 2,
            "long": 3,
            "easy": 6,
            "progressive": 4,
            "mixed": 4,
            "hill_repeats": 3,
            "marathon_pace": 7,
            "intervals": 2,
        }
        return order.get(wt, 4)

    # 5k
    order = {
        "vo2": 0,
        "intervals": 0,
        "race_pace": 1,
        "hill_repeats": 2,
        "threshold": 3,
        "long": 4,
        "easy": 6,
        "progressive": 4,
        "mixed": 4,
        "marathon_pace": 7,
    }
    return order.get(wt, 4)

def downgrade_type(wt: WorkoutType) -> WorkoutType:
    """
    Your "downgrade idea":
    - VO2/intervals -> threshold
    - threshold/race_pace -> progressive
    - marathon_pace -> threshold (or progressive if already overloaded)
    - progressive -> easy
    - easy stays easy
    """
    if wt in ("vo2", "intervals", "hill_repeats"):
        return "threshold"
    if wt in ("threshold", "race_pace"):
        return "progressive"
    if wt == "marathon_pace":
        return "threshold"
    if wt in ("mixed",):
        return "progressive"
    if wt in ("progressive",):
        return "easy"
    return wt

def compute_weekly_run_load(runs: List[PlannedRun]) -> float:
    return float(sum(weighted_load(r.planned_aerobic, r.planned_anaerobic) for r in runs if r.status == "planned"))


# ----------------------------
# Core API
# ----------------------------

def build_cross_training_popup(
    ctx: AthleteContext,
    week_runs: List[PlannedRun],
    activity: CrossActivity,
    sports_db: Dict[SportKey, SportProfile],
    prev_week_run_load: Optional[float] = None,
) -> SuggestionPopup:
    """
    Main entrypoint:
    - computes activity load (garmin if available else estimate)
    - computes RecoveryCostLoad and RunReplacementCredit (runSpec)
    - creates global suggestion (for heavy/extreme)
    - creates up to MAX_TARGETED_SUGGESTIONS targeted per-run suggestions
      with Replace/Reduce/Keep options.
    """
    warnings: List[str] = []

    if activity.sport_key not in sports_db:
        # Default conservative sport profile if missing
        sport = SportProfile(mult=1.0, runSpec=0.35, recovery_mult=1.0, cannot_replace=tuple())
        warnings.append(f"Unknown sport '{activity.sport_key}'. Using default conservative multipliers.")
    else:
        sport = sports_db[activity.sport_key]

    # Compute "raw" activity load from either device loads or RPE estimate
    a, an, raw_weighted = resolve_activity_load(activity, sport)

    # Recovery cost uses full weighted load, scaled by recovery multiplier, then saturated
    raw_recovery_cost = weighted_load(a, an) * float(sport.recovery_mult)
    recovery_cost_load = saturate(raw_recovery_cost)

    # Run replacement credit is discounted by running specificity (runSpec)
    run_replacement_credit = recovery_cost_load * float(clamp(sport.runSpec, 0.0, 1.0))

    ar = anaerobic_ratio(a, an)
    sev = severity_from_load(recovery_cost_load)

    # Weekly budgets (prevents runaway)
    weekly_run_load = compute_weekly_run_load(week_runs)
    prev = 0.0 if prev_week_run_load is None else float(max(0.0, prev_week_run_load))
    total_budget = max(0.0, weekly_run_load - 0.5 * prev)
    replace_budget = REPLACE_BUDGET_FRAC * total_budget
    reduce_budget = REDUCE_BUDGET_FRAC * total_budget

    # Guardrail: preserve minimum number of runs
    planned_count = sum(1 for r in week_runs if r.status == "planned")
    preserve_min = preserve_run_count_min(planned_count)

    # Global suggestion for heavy/extreme loads:
    global_suggestion: Optional[GlobalSuggestion] = None
    if sev in ("heavy", "extreme"):
        # Suggest reducing all non-long runs by a small % based on overload,
        # and downgrading next quality run(s).
        overload = 0.0 if weekly_run_load <= 1e-9 else clamp(recovery_cost_load / weekly_run_load, 0.0, 1.0)
        # heavy -> ~10–20% reduction, extreme -> ~20–35%
        base_reduce = 0.10 + 0.15 * overload
        if sev == "extreme":
            base_reduce += 0.10
        reduce_pct = clamp(base_reduce, 0.10, 0.35)

        global_suggestion = GlobalSuggestion(
            title="Heavy load detected",
            message=(
                "Your logged sport session added a lot of training stress. "
                "We suggest downgrading intensity (keep easy kms) and trimming some volume this week. "
                "You can keep the plan as-is if you feel great — just be aware fatigue and niggles can creep in."
            ),
            reduce_non_long_by=reduce_pct,
            downgrade_next_quality=True,
        )

    # Targeted suggestions:
    # Rank candidate runs by similarity to activity + race-protection (don’t spam protected runs)
    candidates: List[Tuple[float, PlannedRun]] = []
    for r in week_runs:
        if r.status != "planned":
            continue
        sim = vibe_similarity(a, an, r.planned_aerobic, r.planned_anaerobic)

        # prefer same day a bit
        if r.day_index == activity.day_index:
            sim += SAME_DAY_BONUS

        # long penalty
        if r.workout_type == "long":
            sim -= LONG_PENALTY

        # also protect key sessions by race goal (lower priority number = more protected)
        protect = workout_priority_for_race(ctx, r.workout_type)
        sim_adjusted = sim - 0.03 * protect
        candidates.append((sim_adjusted, r))

    candidates.sort(key=lambda x: x[0], reverse=True)

    # Iteratively propose modifications until credit/budget is exhausted
    # But keep UI sane: we propose at most MAX_TARGETED_SUGGESTIONS individual run adjustments.
    suggestions: List[RunSuggestion] = []
    remaining_credit = run_replacement_credit
    remaining_replace_budget = replace_budget
    remaining_reduce_budget = reduce_budget

    # helper to compute ratio of activity credit to run load
    def credit_ratio_for_run(run: PlannedRun) -> float:
        run_load = weighted_load(run.planned_aerobic, run.planned_anaerobic)
        if run_load <= 1e-9:
            return 0.0
        return float(remaining_credit / run_load)

    # Track how many runs we'd still have if we replaced some
    planned_runs_left = planned_count

    for sim, run in candidates:
        if len(suggestions) >= MAX_TARGETED_SUGGESTIONS:
            break
        if remaining_credit <= 1e-6:
            break

        run_load = weighted_load(run.planned_aerobic, run.planned_anaerobic)
        if run_load <= 1e-9:
            continue

        ratio = remaining_credit / run_load

        # If not enough credit to matter, skip
        if ratio < REDUCE_RATIO_THRESHOLD and sev != "extreme":
            continue

        # Determine what we are *allowed* to suggest
        allow_replace = can_replace_workout(sport, run.workout_type, ctx)

        # If replacing would violate preserve_min, disallow replace suggestion
        if planned_runs_left - 1 < preserve_min:
            allow_replace = False

        # For marathon_pace: allow replace only as an OPTION in heavy/extreme, and only if user chooses
        mp_sensitive = (run.workout_type == "marathon_pace" and ctx.race_goal == "marathon")
        if mp_sensitive and sev == "light":
            allow_replace = False

        # Build three options:
        # KEEP: no change
        keep_opt = Option(
            choice="keep",
            new_type=run.workout_type,
            new_distance_km=run.planned_distance_km,
            rationale="Keep the planned run as written.",
            tradeoffs="If you're genuinely fresh, this preserves run-specific fitness. Risk: stacking big loads can accumulate fatigue."
        )

        # REDUCE (default): trim distance and/or downgrade intensity
        # Step 1: downgrade type if quality + heavy load or high anaerobic ratio
        new_type = run.workout_type
        downgrade = False
        if sev in ("heavy", "extreme"):
            # downgrade quality runs first; keep easy kms
            if run.workout_type not in ("easy", "long"):
                new_type = downgrade_type(run.workout_type)
                downgrade = (new_type != run.workout_type)

        # Step 2: compute reduction percentage based on ratio and severity
        # More conservative than old system: prefer partial reduction
        # ratio=1 -> suggest ~40% trim; ratio=2 -> up to ~60% trim (still not deleting)
        base_trim = clamp(0.15 + 0.25 * min(2.0, ratio), 0.15, 0.60)
        if run.workout_type == "long":
            # long run reduced less
            base_trim = clamp(base_trim * 0.45, 0.10, 0.35)

        reduced_km = max(0.0, run.planned_distance_km * (1.0 - base_trim))
        # Enforce minimum easy distance if we downgrade to easy
        if new_type == "easy" and reduced_km < MIN_EASY_KM:
            reduced_km = MIN_EASY_KM

        reduce_tradeoffs = "Lower injury/fatigue risk and keeps some running stimulus. Downsides: slightly less stimulus this week."
        if downgrade:
            reduce_tradeoffs = (
                "Reduces intensity while keeping kms in your legs. This helps recovery after a big sport session. "
                "Downside: less specific quality work this week."
            )

        reduce_opt = Option(
            choice="reduce",
            new_type=new_type,
            new_distance_km=float(round(reduced_km, 2)),
            rationale=(
                f"Suggested reduction based on today's sport load. "
                f"{'We also downgraded intensity to protect recovery.' if downgrade else ''}"
            ),
            tradeoffs=reduce_tradeoffs
        )

        # REPLACE (optional): only if allow_replace, and only if ratio is strong or severity extreme
        # Replacement meaning: run becomes "optional shakeout 4km easy" (keeps running stimulus)
        # unless the original run was already easy (then full replace = 0km).
        replace_opts: List[Option] = []
        if allow_replace and (ratio >= REPLACE_RATIO_THRESHOLD or sev == "extreme"):
            if run.workout_type == "easy":
                repl_km = 0.0
                repl_type: WorkoutType = "easy"
                repl_rationale = "Sport session likely covered the intended easy aerobic stimulus."
            else:
                repl_km = MIN_EASY_KM  # keep running touch
                repl_type = "easy"
                repl_rationale = "Sport session likely covered the main intensity; keep a short easy run for running-specific touch."

            mp_note = ""
            if mp_sensitive:
                mp_note = (
                    " Note: replacing marathon-pace work reduces specificity. "
                    "If your goal is a strong marathon, keeping some MP exposure is usually helpful."
                )

            replace_opts.append(Option(
                choice="replace",
                new_type=repl_type,
                new_distance_km=float(round(repl_km, 2)),
                rationale=repl_rationale,
                tradeoffs=(
                    "Big fatigue reduction and reduces stacking hard days. "
                    "Downside: less run-specific structure this week."
                    + mp_note
                )
            ))

        # Determine recommended choice
        recommended: Choice = "reduce"
        if sev == "light":
            recommended = "keep" if ratio < 0.6 else "reduce"
        if run.workout_type == "long" and not ctx.injury_mode:
            # prefer reduce, not replace
            recommended = "reduce"

        # If reduction still results in silly short run (<4km easy) AND we downgraded to easy,
        # we should bias toward replace (or keep).
        if reduce_opt.new_type == "easy" and reduce_opt.new_distance_km < MIN_EASY_KM:
            recommended = "replace" if replace_opts else "keep"

        # Assemble options (always Keep + Reduce; Replace if allowed)
        options = [keep_opt, reduce_opt] + replace_opts

        # Suggestion explanation (matching)
        suggestions.append(RunSuggestion(
            workout_id=run.workout_id,
            day_index=run.day_index,
            current_type=run.workout_type,
            current_distance_km=run.planned_distance_km,
            similarity=float(round(clamp(sim, 0.0, 1.25), 3)),
            recommended=recommended,
            options=options
        ))

        # Consume budgets/credit *as if* user takes recommended action
        # (purely for limiting how many suggestions we show)
        if recommended == "replace" and replace_opts:
            remaining_credit = max(0.0, remaining_credit - run_load)
            remaining_replace_budget = max(0.0, remaining_replace_budget - run_load)
            planned_runs_left -= 1
        elif recommended == "reduce":
            remaining_credit = max(0.0, remaining_credit - (run_load * 0.5))
            remaining_reduce_budget = max(0.0, remaining_reduce_budget - (run_load * 0.35))
        else:
            # keep consumes nothing
            pass

        # If budgets are exhausted, stop suggesting many more
        if remaining_replace_budget <= 1e-6 and remaining_reduce_budget <= 1e-6:
            break

    # Headline and summary
    headline = "Sport logged"
    if sev == "heavy":
        headline = "Heavy load detected"
    elif sev == "extreme":
        headline = "Very heavy load detected"

    summary = (
        "We’ve accounted for your sport session using training load. "
        "We suggest small adjustments to avoid stacking hard days. "
        "If you feel fresh, you can keep the plan — just be mindful of fatigue and niggles."
    )

    # Additional safety warning about preserving kms (your rule)
    if preserve_min >= planned_count:
        warnings.append("This week already has very few runs. We will prioritize keeping running stimulus even after big sport loads.")

    return SuggestionPopup(
        severity=sev,
        headline=headline,
        summary=summary,
        recovery_cost_load=float(round(recovery_cost_load, 1)),
        run_replacement_credit=float(round(run_replacement_credit, 1)),
        anaerobic_ratio=float(round(ar, 3)),
        global_suggestion=global_suggestion,
        run_suggestions=suggestions,
        warnings=warnings
    )


# ----------------------------
# Example sports DB (replace with your real one)
# ----------------------------
DEFAULT_SPORTS_DB: Dict[SportKey, SportProfile] = {
    "soccer": SportProfile(mult=1.35, runSpec=0.40, recovery_mult=1.20, cannot_replace=("long",)),
    "rugby": SportProfile(mult=1.50, runSpec=0.35, recovery_mult=1.30, cannot_replace=("long",)),
    "basketball": SportProfile(mult=1.25, runSpec=0.45, recovery_mult=1.15, cannot_replace=("long",)),
    "tennis": SportProfile(mult=1.20, runSpec=0.50, recovery_mult=1.10, cannot_replace=tuple()),
    "padel": SportProfile(mult=1.10, runSpec=0.45, recovery_mult=1.05, cannot_replace=tuple()),
    "cycling": SportProfile(mult=0.75, runSpec=0.55, recovery_mult=0.95, cannot_replace=tuple()),
    "swimming": SportProfile(mult=0.65, runSpec=0.20, recovery_mult=0.90, cannot_replace=tuple()),
    "strength": SportProfile(mult=0.50, runSpec=0.10, recovery_mult=1.00, cannot_replace=tuple()),
    "crossfit": SportProfile(mult=1.10, runSpec=0.25, recovery_mult=1.20, cannot_replace=("long",)),
}


if __name__ == "__main__":
    ctx = AthleteContext(race_goal="marathon", planned_runs_per_week=5, injury_mode=False)
    week_runs = [
        PlannedRun("r1", 0, "easy", 8.0, 35, 2),
        PlannedRun("r2", 2, "threshold", 10.0, 55, 10),
        PlannedRun("r3", 4, "easy", 6.0, 28, 1),
        PlannedRun("r4", 5, "marathon_pace", 14.0, 60, 8),
        PlannedRun("r5", 6, "long", 24.0, 90, 6),
    ]
    act = CrossActivity(day_index=1, sport_key="soccer", duration_min=90, rpe=6, device="none")
    popup = build_cross_training_popup(ctx, week_runs, act, DEFAULT_SPORTS_DB)
    print(popup)
