# Prediction Matrix Key & Definitions

This document explains the variables and logic terms used in the generated prediction matrix.

## 1. Runner Type
This defines the athlete's **Fatigue Exponent (b)**, which dictates how much they slow down as distance increases.
- **Speed (b=1.05)**: Very efficient at short distances but fades quickly. Their 5k is disproportionately faster than their Marathon.
- **Balanced (b=1.09)**: Typical runner profile.
- **Endurance (b=1.13)**: Holds pace extremely well. Their Marathon VDOT is close to their 5k VDOT.

## 2. LT Profile (Lactate Threshold Proficiency)
This variable represents the runner's specific fitness at "Threshold" pace relative to their overall baseline fitness.
- **Aligned**: Their Threshold pace matches what standard VDOT tables predict for their baseline fitness.
- **Strong (+2 VDOT)**: Their Threshold pace is faster than expected (equivalent to someone with a VDOT +2 points higher). This pulls the prediction *faster* for distances that rely heavily on LT (like 10k/Half).
- **Weak (-2 VDOT)**: Their Threshold pace is slower than expected, pulling predictions *slower*.

## 3. Recent Run
A real-world "anchor" data point that influences the prediction.
- **Fresh (2w)**: A race or time trial done 2 weeks ago. Currently weighted highly (30%) in the prediction blend.
- **Stale (6w)**: A race done 6 weeks ago. Its influence decays significantly (weight drops to ~10-15%), meaning the prediction drifts back toward the LT/PB baseline.
- **None**: No recent data. The system relies entirely on implied fitness (LT + VO2 + PBs).

## 4. Recent Perf (Performance)
How the Recent Run compares to the athlete's Baseline VDOT.
- **Aligned**: They ran exactly the time expected for their Baseline VDOT.
- **Over (+2)**: They overperformed significantly (ran a time equivalent to VDOT +2). This pulls the predicted 5k time down (faster).
- **Under (-2)**: They underperformed. This pulls the predicted 5k time up (slower).

## 5. Base 5k (PB)
This is a theoretical "pure" value. It calculates what the runner *should* be able to run for 5k if we only looked at their Half Marathon personal best and applied their specific Runner Type curve (Riegel formula).
- *Example*: An Endurance runner has a faster Base 5k than a Speed runner for the same Half Marathon PB because the formula expects the Speed runner to be naturally faster at short distances, so "equivalent" fitness means a slower time for the Endurance runner? 
  - *Correction*: Actually, for the same HM time, a **Speed** runner would have a **faster** 5k (better at short). An **Endurance** runner would have a **slower** 5k (better at long).

## 6. Predicted 5k
The final output of the simulator engine. It is a weighted blend of:
1. **Recent Run** (if available and fresh)
2. **Lactate Threshold** (implied from LT Profile)
3. **VO2 Max** (implied from Baseline VDOT)
4. **All-time PBs** (long-term potential)

## 7. Diff
The difference between the simulator's **Predicted 5k** and the theoretical **Base 5k**.
- **(+) Positive**: The simulator predicts they will be *slower* than their pure PB curve suggests (e.g. due to weak LT or no recent data).
- **(-) Negative**: The simulator predicts they will be *faster* (e.g. due to Strong LT or a recent "Over" performance).
