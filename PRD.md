# Product Requirements Document: Marathon Simulator

## Vision
To build the most intelligent, adaptive training platform in the world, outperforming market leaders like Runna by offering superior personalization, dynamic responsiveness to life/injuries, and deep integration with the athlete's full training ecosystem.

## 1. Executive Summary
The Marathon Simulator (internal name: Mosaic Training Simulator) is a cross-platform mobile application designed to generate personalized marathon training plans and track running workouts. It combines physiological principles (VDOT, Lactate Threshold) with practical training logic (phases, commute runs) to help runners achieve their race goals.

## 2. Target Audience
-   **Multi-Sport Athletes**: Primary audience. Runners who engage in other sports (cycling, swimming, team sports) and need a plan that dynamically adjusts to their total training load.
-   Runners training for marathons or other long-distance events (5k, 10k, Half Marathon).
-   Users who want a structured, adaptive training plan that "learns" from them.
-   Commuter runners who want to integrate run-commuting into their training.

## 3. Core Features

### 3.1. Onboarding & Personalization
Users are guided through a wizard to set up their profile:
-   **Event Selection**: Target race distance and date.
-   **Current Fitness**: Recent race results and current typical weekly mileage.
-   **Personal Bests (PBs)**: Input for 5k, 10k, Half Marathon, and Marathon to baseline performance.
-   **Runner Profile**: Classification as "Speed", "Balanced", or "Endurance" type to tailor workout mixes.
-   **Schedule Preferences**:
    -   Days per week available to run.
    -   **Cross-Training Integration**: Input other sports activities (activity type, duration, RPE) to balance total training load.
    -   **Commute Integration**: Option to designate specific days for run-commuting, with distance parameters.

### 3.2. Adaptive Training Engine
The core logic generates a weekly training schedule based on:
-   **Training Phases**:
    -   **Base**: Focus on aerobic foundation.
    -   **Build**: Increasing volume and intensity.
    -   **Peak**: Highest load, specific race-pace work.
    -   **Taper**: Reducing load before race day.
-   **Dynamic Workout Generation**:
    -   **Long Runs**: Scaled distance based on phase.
    -   **Quality Sessions**: Intervals, Threshold runs, and VO2max sessions adapted to runner type.
    -   **Easy Runs**: Fillers to meet volume targets.
    -   **Recovery**: Adjusts for missed workouts by re-integrating key skipped sessions.
    -   **Intelligent Injury System (Physio-Grade)**:
        -   **Clinical 5-Phase Recovery Model**: `Acute` -> `Rehab` -> `Test Capacity` -> `Return to Run` -> `Resolved`.
        -   **Trend Analysis**: Detects **Acute Spikes** (>2/10 increase in 24h) and **Chronic Plateaus** (stable pain >5 days).
        -   **Capacity Testing**: Users must pass functional tests (e.g., Single Leg Hop, Pain-Free Walk) to unlock the next phase.
        -   **Latency Checks**: Monitors "Morning Pain" to detect delayed responses to load.
        -   User can flag injury severity (niggle vs. injury).
        -   Auto-adjusts plan: reduces volume, swaps runs for cross-training, or inserts rehabilitation blocks.
        -   Dynamically recalculates race goals based on lost time.
    -   **Advanced Goal Setting**:
        -   Allow "Stretch Goals" (e.g., Sub-3 hour marathon) even if current fitness makes it a high risk.
        -   **"Honesty Over Hype" Durability Matrix**:
            -   Evaluates goals based on **Structural Durability** (Long Run capacity) vs. **Engine Fitness** (VDOT/Pace).
            -   **Case A (Realistic)**: Fitness + Durability aligned.
            -   **Case B (Conditional)**: Fast enough, but legs fragile. Prompt: "Fitness is there, but durability is the blocker."
            -   **Case C (Exploratory)**: Gap 3-5%. "Under Investigation."
        -   Provide specific warnings: "This goal requires aggressive ramp-up; injury risk increased by X%."
        -   adjusts intensity distribution to prioritize goal pact over safety (with user consent).
    -   **Machine Learning (Long-term Vision)**: 
        -   Iterative feedback loop: learns which workouts user finds hard/easy.
        -   Forecasts improvement rates (e.g., "improving faster than expected").
        -   Adjusts future training blocks based on actual vs. predicted performance.

### 3.3. GPS Tracking & Analysis
A built-in activity tracker leveraging device GPS:
-   **Real-time Metrics**: Distance, Elapsed Time, Current Pace.
-   **Split Management**:
    -   Automatic splits (e.g., every 1km/1mi).
    -   Custom segment support.
-   **Data Processing**: Jitter filtering and smoothing for accurate distance calculation.
-   **"Just Run" Mode**:
    -   Quick-start button to record unstructured activity.
    -   Allows logging runs without a pre-set plan or goal.
    -   Useful for off-plan runs, shakeouts, or mental resets.
    -   Feeds into the overall training load calculation but is flagged as "Unstructured".

### 3.4. Performance Prediction Engine
Advanced algorithms to estimate race potential:
-   **Multi-Source Data Integration**:
    -   **Wearable Sync**: Integration with Garmin/Apple Watch for accurate physiological data.
    -   **Manual Inputs**: Lactate Threshold (LT), VO2max, PBs, and recent hard efforts.
-   **Runner Typing**: 
    -   Classifies athletes as **Speed**, **Balanced**, or **Endurance** types.
    -   **Fatigue Exponent**: Calculates 'b' coefficient (from Riegel's formula) based on PBs to mathematically determine runner type.
    -   Tailors workout prescriptions (e.g., interval pacing, tempo duration) based on runner type.
-   **Multi-Model Approach**:
    -   **PB-based**: Extrapolates from all-time bests.
    -   **Recent Run**: Weighted projection from recent performance with decay.
    -   **Lactate Threshold (LT)**: Uses LT pace with runner-type specific coefficients.
    -   **VO2max/VDOT**: derived from Jack Daniels' formulas.
    -   **Non-Linear Training Horizon**:
        -   **Tau-Decay Model**: Models fitness gains using saturating exponential functions (diminishing returns).
        -   **Undertraining Penalty**: Mathematically penalizes missed sessions (not just lost volume).
        -   **Universal Guardrails**: Hard VDOT caps based on **Experience Level** (e.g., "Intermediate cannot jump to Sub-3 without previous history").
-   **Blended Prediction**: Weighted average of all models, dynamically adjusting weights based on race distance and data recency.

### 3.5. Admin & Debugging
Tools for development and testing:
-   **Simulate Week**: Fast-forward training time.
-   **Reset Onboarding**: Clear user state.
-   **View All Weeks**: Inspect the full generated plan.

### 3.6. AI Coach (Future Vision)
-   **Chat Interface**: Conversational agent to discuss training plans, race strategy, and adjustments.
-   **Plan Explanation**: Ability to ask "Why is this workout today?" or "Can I move my long run?".

## 4. Technical Architecture
-   **Frontend**: React with Vite.
-   **Styling**: Tailwind CSS.
-   **Mobile Runtime**: Capacitor (iOS/Android support).
-   **State Management**: Local persistence (likely `localStorage` or Capacitor Storage).
-   **Geolocation**: `@transistorsoft/capacitor-background-geolocation` or Capacitor Geolocation.

## 5. User Flow
1.  **Launch**: Check for existing state.
2.  **Onboarding (if new)**: Complete the wizard steps to generate initial plan.
3.  **Main Dashboard**:
    -   View current week's schedule.
    -   See workout details (Target Distance, Pace, RPE).
    -   Start a run (Tracker).
4.  **Tracking**:
    -   GPS lock -> Recording -> Pause/Resume -> Finish.
    -   Save activity (updates actuals vs. planned).
5.  **Progress**: View updated predictions and plan adjustments.

## 6. Premium & Future Expansion

### 6.1. Premium AI Chatbot
-   **Conversation**: "Analyze my last long run," or "Why did I fade in the last 5k?"
-   **Deep Analytics**: Correlate sleep, stress (from wearables), and training load to explain performance.

### 6.2. Multi-Sport Expansion (Long-term)
-   **Triathlon**: Swim/Bike/Run integration with brick workouts.
-   **Ultra-Running**: Vert-specific planning and back-to-back long runs.
-   **Hyrox**: Functional fitness integration.
*(Note: These will be built after deep domain research)*

### 6.3. Social & Cloud
-   Cloud sync/backup.
-   Community challenges and leaderboards.
-   Integration with 3rd party platforms (Strava, Garmin).

## Adaptive Plan Philosophy (Natural Language Summary)

We’re building an adaptive running plan that stays realistic when a runner logs other sports.

To do that, we need to predict how a runner’s underlying physiology should improve over a training block — mainly:
*   **VO2max** (max aerobic capacity)
*   **Lactate Threshold pace** (how fast they can run before lactate accumulates too quickly)

Different runners improve at different rates:
*   **Beginners / returners** often improve faster early.
*   **Advanced / elite** runners improve slowly and non-linearly.

So we forecast an expected improvement curve for VO2 and LT based on:
*   their current level (VDOT band),
*   their background (returning/hybrid/etc),
*   and how much training they’re doing.

When new values arrive from a watch/test, we compare actual vs expected:
*   If they’re **improving faster** than expected → we congratulate them and optionally tighten training paces slightly.
*   If **slower** than expected → we keep paces the same or slightly easier and may suggest adjusting training stress.

This lets the app be adaptive without “making stuff up” or double counting improvements.
