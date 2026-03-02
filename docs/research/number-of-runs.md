Number of runs logic

"""
workout_allocation_rules.py
---------------------------
Formal rules engine for allocating weekly run workouts given:
- target race (5k/10k/half/marathon)
- runs_per_week (2..7)
- runner_type (Speed/Balanced/Endurance)
- fitness_level (beginner/novice/intermediate/advanced/elite)
- sport sessions (count + high-intensity count + optional load)

Outputs:
- flags (UX warnings)
- required_run_types (non-negotiables)
- ordered_run_slots (what to generate first, in priority order)
- per-run slot intent (workout type), so the plan generator can fill specifics.

This module does NOT create full workouts (splits, paces). It decides WHAT to schedule and in WHAT ORDER.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, List, Literal, Optional, Tuple

TargetRace = Literal["5k", "10k", "half", "marathon"]
RunnerType = Literal["Speed", "Balanced", "Endurance"]
FitnessLevel = Literal["beginner", "novice", "intermediate", "advanced", "elite"]

WorkoutType = Literal[
    "easy",
    "long",
    "threshold",
    "vo2",
    "race_pace",
    "marathon_pace",
    "intervals",
    "mixed",
    "progressive",
    "hill_repeats",
]

@dataclass(frozen=True)
class SportSummary:
    """Cross-training summary for the current planning week."""
    sport_sessions: int = 0
    high_intensity_sport_sessions: int = 0  # HIS count (RPE>=7 or anaerobic-heavy or similar)
    # Optional: if you have Garmin loads, you can extend with rolling totals later.


@dataclass(frozen=True)
class PlanContext:
    target_race: TargetRace
    runs_per_week: int
    runner_type: RunnerType
    fitness_level: FitnessLevel
    sports: SportSummary = SportSummary()


@dataclass
class PlanFlags:
    """UX flags and hard constraints surfaced to the user."""
    recommend_min_3_runs: bool = False
    marathon_durability_warning: bool = False
    low_run_frequency_cap: bool = False
    explanation: List[str] = None

    def __post_init__(self):
        if self.explanation is None:
            self.explanation = []


# -------------------------
# HARD CONSTRAINTS (RULES)
# -------------------------

def min_runs_required(target: TargetRace) -> int:
    """
    Minimum viable runs/week for performance-oriented plans.
    Note: these are for "running-only". Sport can support fitness but not fully replace durability.
    """
    if target == "5k":
        return 2
    if target == "10k":
        return 3
    if target == "half":
        return 3
    if target == "marathon":
        return 4  # performance-minimum; 3 may be 'viable but capped'
    raise ValueError(target)


def allows_two_run_plan(target: TargetRace) -> bool:
    return target == "5k"


def his_threshold_to_compensate(runs_per_week: int) -> int:
    """
    Rule: if runs < 3, we suggest at least 3 high-intensity sport sessions to partially compensate fitness.
    This does NOT remove durability constraints for HM/marathon.
    """
    if runs_per_week >= 3:
        return 0
    return 3


def compute_flags(ctx: PlanContext) -> PlanFlags:
    flags = PlanFlags()

    # Run frequency suggestion with HIS compensation
    his_needed = his_threshold_to_compensate(ctx.runs_per_week)
    if ctx.runs_per_week < 3:
        flags.recommend_min_3_runs = True
        if ctx.sports.high_intensity_sport_sessions < his_needed:
            flags.explanation.append(
                f"We strongly recommend ≥3 runs/week. If you run {ctx.runs_per_week}/week, "
                f"aim for ≥{his_needed} high-intensity sport sessions/week to maintain fitness."
            )
        else:
            flags.explanation.append(
                f"You run {ctx.runs_per_week}/week but have ≥{his_needed} high-intensity sport sessions/week, "
                f"so we can partially compensate fitness via sport (durability still limited for longer races)."
            )

    # Marathon durability warning (sport cannot replace long-run durability)
    if ctx.target_race == "marathon" and ctx.runs_per_week < 4:
        flags.marathon_durability_warning = True
        flags.low_run_frequency_cap = True
        flags.explanation.append(
            "Marathon performance is strongly limited by running-specific durability. "
            "With <4 runs/week we will cap performance forecasts and protect the long run."
        )

    # Half marathon caution with 2 runs even if sport is high
    if ctx.target_race == "half" and ctx.runs_per_week < 3:
        flags.low_run_frequency_cap = True
        flags.explanation.append(
            "Half-marathon performance is durability-limited. With <3 runs/week your plan is viable only with heavy sport support and will be capped."
        )

    # 10k caution with 2 runs
    if ctx.target_race == "10k" and ctx.runs_per_week < 3:
        flags.low_run_frequency_cap = True
        flags.explanation.append(
            "10k performance typically needs ≥3 runs/week. With <3 runs/week the plan will emphasize one quality + one longish run, but forecast confidence is reduced."
        )

    return flags


# -------------------------
# WORKOUT PRIORITY ORDERING
# -------------------------

def base_priority_order(target: TargetRace) -> List[WorkoutType]:
    """
    Global priority: what we generate first when run slots are limited.
    """
    if target == "marathon":
        return ["long", "marathon_pace", "threshold", "easy", "vo2", "hill_repeats", "progressive", "race_pace", "mixed", "intervals"]
    if target == "half":
        return ["long", "threshold", "race_pace", "easy", "vo2", "hill_repeats", "progressive", "mixed", "intervals", "marathon_pace"]
    if target == "10k":
        return ["threshold", "vo2", "long", "race_pace", "easy", "hill_repeats", "progressive", "mixed", "intervals", "marathon_pace"]
    if target == "5k":
        return ["vo2", "threshold", "race_pace", "long", "easy", "hill_repeats", "progressive", "mixed", "intervals", "marathon_pace"]
    raise ValueError(target)


def runner_type_bias(target: TargetRace, runner_type: RunnerType) -> Dict[WorkoutType, float]:
    """
    Multipliers for how strongly to prefer certain workouts.
    >1 means promote earlier and allocate more often.
    """
    # Default neutral
    bias = {k: 1.0 for k in base_priority_order(target)}

    if runner_type == "Speed":
        # Speed-type needs endurance/durability, especially for half/marathon
        bias["threshold"] *= 1.10
        bias["long"] *= 1.15
        bias["marathon_pace"] *= 1.10
        bias["vo2"] *= 0.90
        bias["intervals"] *= 0.90

    elif runner_type == "Endurance":
        # Endurance-type needs top-end speed, especially for 5k/10k
        bias["vo2"] *= 1.10
        bias["intervals"] *= 1.10
        bias["hill_repeats"] *= 1.05
        bias["threshold"] *= 0.95
        if target in ("half", "marathon"):
            bias["long"] *= 1.05  # still important, but not the weakness

    # Balanced stays neutral
    return bias


def fitness_level_limits(fitness_level: FitnessLevel) -> Dict[str, int]:
    """
    Limits how many 'hard' sessions per week are permitted.
    This is performance-oriented but conservative to avoid burn.
    """
    if fitness_level in ("beginner",):
        return {"max_quality": 1, "max_vo2": 0, "max_hills": 0}
    if fitness_level in ("novice",):
        return {"max_quality": 1, "max_vo2": 1, "max_hills": 1}
    if fitness_level in ("intermediate",):
        return {"max_quality": 2, "max_vo2": 1, "max_hills": 1}
    if fitness_level in ("advanced",):
        return {"max_quality": 2, "max_vo2": 2, "max_hills": 1}
    if fitness_level in ("elite",):
        return {"max_quality": 3, "max_vo2": 2, "max_hills": 2}
    raise ValueError(fitness_level)


def is_quality_session(wt: WorkoutType) -> bool:
    return wt in ("threshold", "vo2", "race_pace", "marathon_pace", "intervals", "mixed", "hill_repeats", "progressive")


def classify_quality(wt: WorkoutType) -> str:
    if wt in ("threshold", "marathon_pace", "race_pace"):
        return "tempo_like"
    if wt in ("vo2", "intervals", "hill_repeats"):
        return "high_intensity"
    if wt in ("mixed", "progressive"):
        return "mixed"
    return "easy_like"


# -------------------------
# SLOT GENERATION LOGIC
# -------------------------

def generate_ordered_run_slots(ctx: PlanContext) -> Tuple[List[WorkoutType], PlanFlags]:
    """
    Returns:
      - ordered list of workout types to schedule for the week (length = runs_per_week)
      - flags
    """

    flags = compute_flags(ctx)

    # Hard constraints: two-run plans only allowed for 5k (performance).
    if ctx.runs_per_week == 2 and not allows_two_run_plan(ctx.target_race):
        flags.low_run_frequency_cap = True
        flags.explanation.append(
            f"{ctx.target_race} plans generally require more than 2 runs/week for performance. "
            "We will allocate Long + one Quality, but forecast confidence will be reduced."
        )

    # Base ordering + runner type bias
    base = base_priority_order(ctx.target_race)
    bias = runner_type_bias(ctx.target_race, ctx.runner_type)

    # Create a scored list for ordering
    scored = [(wt, bias.get(wt, 1.0)) for wt in base]
    scored.sort(key=lambda x: x[1], reverse=True)  # higher bias first

    # Now allocate slots with constraints
    limits = fitness_level_limits(ctx.fitness_level)
    slots: List[WorkoutType] = []
    count_quality = 0
    count_vo2 = 0
    count_hills = 0

    def can_add(wt: WorkoutType) -> bool:
        nonlocal count_quality, count_vo2, count_hills
        if wt == "long":
            return True
        if wt == "easy":
            return True

        # enforce quality caps by fitness level
        if is_quality_session(wt):
            if count_quality >= limits["max_quality"]:
                return False

        # cap high intensity types
        if wt in ("vo2", "intervals") and count_vo2 >= limits["max_vo2"]:
            return False
        if wt == "hill_repeats" and count_hills >= limits["max_hills"]:
            return False

        return True

    def add(wt: WorkoutType):
        nonlocal count_quality, count_vo2, count_hills
        slots.append(wt)
        if is_quality_session(wt):
            count_quality += 1
        if wt in ("vo2", "intervals"):
            count_vo2 += 1
        if wt == "hill_repeats":
            count_hills += 1

    # --- Non-negotiables by target race ---
    # Always schedule a long run for half/marathon if runs >= 2.
    if ctx.target_race in ("half", "marathon") and ctx.runs_per_week >= 2:
        add("long")

    # For marathon, prioritize marathon pace or threshold next depending on runner type
    if ctx.target_race == "marathon" and len(slots) < ctx.runs_per_week:
        # Speed-type: threshold is key, but MP is also key; choose based on runner type and fitness
        preferred = "marathon_pace" if ctx.fitness_level in ("intermediate", "advanced", "elite") else "threshold"
        add(preferred) if can_add(preferred) else add("easy")

    # For 5k, prioritize vo2 first if possible
    if ctx.target_race == "5k" and len(slots) < ctx.runs_per_week:
        pref = "vo2" if can_add("vo2") else "threshold"
        add(pref)

    # Fill remaining slots by weighted priority order
    # We loop through scored candidates repeatedly until slots filled.
    while len(slots) < ctx.runs_per_week:
        placed = False
        for wt, _score in scored:
            # Skip if already over-represented long runs
            if wt == "long" and slots.count("long") >= 1:
                continue
            # Marathon: protect that we have at most 1 true long run
            if wt == "long" and ctx.target_race == "marathon":
                continue

            if can_add(wt):
                # Avoid too many "hard" sessions in low-run plans
                if ctx.runs_per_week <= 3 and wt in ("vo2", "intervals", "mixed") and slots.count("threshold") == 0 and ctx.target_race in ("half", "marathon"):
                    # prefer threshold before vo2 for long races when runs are scarce
                    continue

                add(wt)
                placed = True
                break

        if not placed:
            # Fallback: add easy
            add("easy")

    # --- Post-processing adjustments for run frequency + sport compensation ---
    # If runs < 3 and HIS < 3, make the plan more conservative: ensure at most 1 quality.
    if ctx.runs_per_week < 3 and ctx.sports.high_intensity_sport_sessions < 3:
        # downgrade extra quality sessions to easy if any exist beyond 1
        new_slots: List[WorkoutType] = []
        seen_quality = 0
        for wt in slots:
            if is_quality_session(wt) and wt != "long":
                seen_quality += 1
                if seen_quality > 1:
                    new_slots.append("easy")
                else:
                    new_slots.append(wt)
            else:
                new_slots.append(wt)
        slots = new_slots

    # Ensure at least one easy run if runs >= 4 (recovery infrastructure)
    if ctx.runs_per_week >= 4 and "easy" not in slots:
        # replace lowest priority non-long slot with easy
        for i in range(len(slots)-1, -1, -1):
            if slots[i] not in ("long",):
                slots[i] = "easy"
                break

    # Order output: schedule structure-friendly ordering (not just priority)
    # Default weekly pattern: easy -> quality -> easy -> quality -> easy -> long
    slots = order_weekly_pattern(slots, ctx.target_race)

    return slots, flags


def order_weekly_pattern(slots: List[WorkoutType], target: TargetRace) -> List[WorkoutType]:
    """
    Convert unordered chosen slots into a sensible weekly ordering:
    - separate quality sessions
    - place long run last
    - keep easy runs as buffers
    """
    long_runs = [s for s in slots if s == "long"]
    others = [s for s in slots if s != "long"]

    # split quality vs easy-like
    quality = [s for s in others if is_quality_session(s)]
    easy_like = [s for s in others if not is_quality_session(s)]

    ordered: List[WorkoutType] = []

    # Place first quality early, then buffer, then second quality, then buffer, etc.
    while quality or easy_like:
        if easy_like:
            ordered.append(easy_like.pop(0))
        if quality:
            ordered.append(quality.pop(0))
        if easy_like:
            ordered.append(easy_like.pop(0))

    # Long run last if present
    if long_runs:
        ordered.append("long")

    # If marathon and marathon_pace exists, place it mid-late but not right before long
    if target == "marathon" and "marathon_pace" in ordered and ordered[-1] == "long":
        mp_idx = ordered.index("marathon_pace")
        # move MP earlier if it's immediately before long
        if mp_idx == len(ordered) - 2:
            ordered.pop(mp_idx)
            ordered.insert(max(1, len(ordered) - 4), "marathon_pace")

    return ordered


# -------------------------
# Example usage
# -------------------------
if __name__ == "__main__":
    ctx = PlanContext(
        target_race="marathon",
        runs_per_week=3,
        runner_type="Speed",
        fitness_level="intermediate",
        sports=SportSummary(sport_sessions=3, high_intensity_sport_sessions=2),
    )
    slots, flags = generate_ordered_run_slots(ctx)
    print("Slots:", slots)
    print("Flags:", flags.recommend_min_3_runs, flags.marathon_durability_warning, flags.low_run_frequency_cap)
    for e in flags.explanation:
        print("-", e)
