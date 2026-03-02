"""
milestone_nudging.py
--------------------
Controls milestone messaging ("You're close to Sub-X") in a physiologically
honest way, especially for marathon goals.

Key ideas:
- Separate *fitness proximity* from *durability readiness*
- Gate aggressive milestone language behind structural readiness
- Provide alternative, trust-preserving nudges when appropriate
"""

from dataclasses import dataclass
from typing import Optional, Literal, Dict

Race = Literal["5k", "10k", "half", "marathon"]

@dataclass
class AthleteSnapshot:
    target_race: Race
    predicted_time_sec: int          # current model prediction
    target_time_sec: int             # milestone (e.g. sub-3 = 10800)
    weeks_to_race: int
    runs_per_week: int

    # Endurance / durability signals
    endurance_score: float           # 0–1 composite (LT vs MP, slope, etc.)
    recent_long_run_km: Optional[float]
    recent_distance_effort_ratio: float  # recent hard effort distance / race distance

    # Recent performances
    recent_half_time_sec: Optional[int]
    recent_10k_time_sec: Optional[int]
    lt_pace_sec_per_km: Optional[int]
    marathon_pace_sec_per_km: Optional[int]

@dataclass
class MilestoneDecision:
    show: bool
    headline: Optional[str] = None
    body: Optional[str] = None
    cta: Optional[str] = None
    cta_action: Optional[str] = None   # e.g. "add_mp_segments"
    confidence: Optional[str] = None   # "high" | "medium" | "low"


# -------------------------
# Tunable thresholds
# -------------------------

AGGRESSIVE_GAP = 0.03        # ≤3% = genuinely close
SOFT_GAP = 0.06              # ≤6% = directionally close

MIN_ENDURANCE_FOR_MARATHON = 0.65
MIN_LONG_RUN_KM = 28.0
MIN_DISTANCE_COVERAGE = 0.70

MIN_RUNS_FOR_MARATHON_NUDGE = 4


# -------------------------
# Core logic
# -------------------------

def percent_gap(predicted: int, target: int) -> float:
    return (predicted - target) / target


def marathon_structural_ready(a: AthleteSnapshot) -> bool:
    """
    Check if marathon durability evidence exists.
    """
    if a.runs_per_week < MIN_RUNS_FOR_MARATHON_NUDGE:
        return False

    if a.endurance_score < MIN_ENDURANCE_FOR_MARATHON:
        return False

    if not a.recent_long_run_km or a.recent_long_run_km < MIN_LONG_RUN_KM:
        return False

    if a.recent_distance_effort_ratio < MIN_DISTANCE_COVERAGE:
        return False

    return True


def decide_milestone(a: AthleteSnapshot) -> MilestoneDecision:
    gap = percent_gap(a.predicted_time_sec, a.target_time_sec)

    # Default: do not show
    decision = MilestoneDecision(show=False)

    # -------------------------
    # MARATHON LOGIC (STRICT)
    # -------------------------
    if a.target_race == "marathon":

        structural_ready = marathon_structural_ready(a)

        # Case 1: Truly close AND durable → aggressive milestone allowed
        if gap <= AGGRESSIVE_GAP and structural_ready:
            return MilestoneDecision(
                show=True,
                headline="You're close to a major breakthrough!",
                body=(
                    f"Your current prediction is {format_time(a.predicted_time_sec)}, "
                    f"and your durability supports a push toward {format_time(a.target_time_sec)}."
                ),
                cta="Add marathon-pace long run segments",
                cta_action="add_mp_segments",
                confidence="high",
            )

        # Case 2: Fitness close but durability lacking → soft, honest nudge
        if gap <= SOFT_GAP:
            return MilestoneDecision(
                show=True,
                headline="You have the speed — endurance is the limiter",
                body=(
                    f"Your current prediction is {format_time(a.predicted_time_sec)}. "
                    "Closing the final gap typically requires sustained durability work "
                    "over multiple training cycles."
                ),
                cta="Focus on long-run consistency",
                cta_action="reinforce_long_runs",
                confidence="medium",
            )

        # Otherwise: no milestone shown
        return decision

    # -------------------------
    # SHORTER RACES (SIMPLER)
    # -------------------------
    if gap <= SOFT_GAP:
        return MilestoneDecision(
            show=True,
            headline="You're building toward a milestone",
            body=(
                f"Your current prediction is {format_time(a.predicted_time_sec)}. "
                "Small, consistent gains could unlock your next target."
            ),
            cta="Optimize weekly training",
            cta_action="optimize_plan",
            confidence="medium",
        )

    return decision


# -------------------------
# Helpers
# -------------------------

def format_time(seconds: int) -> str:
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


# -------------------------
# Example
# -------------------------
if __name__ == "__main__":
    athlete = AthleteSnapshot(
        target_race="marathon",
        predicted_time_sec=11228,          # 3:07:08
        target_time_sec=10800,             # 3:00:00
        weeks_to_race=16,
        runs_per_week=4,
        endurance_score=0.55,
        recent_long_run_km=24.0,
        recent_distance_effort_ratio=0.47,
        recent_half_time_sec=5580,          # 1:33
        recent_10k_time_sec=2520,           # 42:00
        lt_pace_sec_per_km=257,
        marathon_pace_sec_per_km=255,
    )

    decision = decide_milestone(athlete)
    print(decision)
