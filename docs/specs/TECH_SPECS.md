# Marathon Simulator - Technical Documentation
> **Version:** 1.0.0 (Living Document)
> **Status:** Draft / Planning
> **Last Updated:** 2026-02-02

---

## 1. Technology Stack

### 1.1. Current Stack (Frontend / Client-Side)
*   **Language:** TypeScript 5.3+
*   **Framework:** Vanilla JS logic with DOM manipulation (migrating to React-like structure via `src/ui` components).
*   **Build Tool:** Vite 5.x
*   **Mobile Runtime:** Capacitor 8.x (iOS focus currently).
*   **Styling:** Tailwind CSS 3.4
*   **Storage:** `localStorage` (JSON-based persistence).
*   **Geolocation:** `@transistorsoft/capacitor-background-geolocation` (Background tracking).
*   **Testing:** Vitest 4.x (Unit/Integration).

### 1.2. Target Stack (Backend / Cloud Services) [PLANNED]
*   **Backend Runtime:** Node.js (AWS Lambda / Serverless) or Edge Functions.
*   **Database:** PostgreSQL (Supabase or AWS RDS) - Selected for structured relational data (Training Plans).
*   **Authentication:** Supabase Auth or Firebase Auth (Social Login + Email/Pass).
*   **Payments:** Stripe (Subscription management).
*   **Integrations:** Garmin Health API, Strava API (Webhooks).
*   **Hosting:** Vercel (Web App) / App Store Connect (iOS).

---

## 2. High-Level Architecture

```mermaid
graph TD
    User[User Device (iOS/Web)]
    
    subgraph Shared Logic (Isomorphic)
        Logic[Training Engine (NPM Package)]
    end

    subgraph Client Application
        UI[UI Layer (Vite)]
        Store[Local Persistence (Cache)]
        Sync[Sync Manager (Queue)]
    end
    
    subgraph Cloud Infrastructure
        API[API Gateway / Edge Functions]
        Auth[Auth Service]
        DB[(PostgreSQL Database)]
        Worker[Background Workers]
    end
    
    subgraph External Integrations
        Garmin[Garmin Health API]
        Strava[Strava API]
        Stripe[Stripe Payments]
        Apple[Apple HealthKit]
    end

    User --> UI
    UI --> Logic
    Logic --> Store
    
    %% Isomorphic: Logic runs on both Client (immediate) and Server (batch/verify)
    API --> Logic 

    Sync -->|CRDT / Delta Vectors| API
    
    API --> DB
    
    Worker -->|Webhooks| Garmin
    Worker -->|Webhooks| Strava
    Worker -->|Events| Stripe
    
    Client Application -->|Native Bridge| Apple
```

---

## 3. Database Schema [PLANNED]

We will migrate from `localStorage` JSON blobs to a normalized Relational Schema (PostgreSQL).

### 3.1. Core Tables
*   **`users`**:
    *   `id` (UUID, PK)
    *   `email` (VARCHAR, Unique)
    *   `auth_provider_id` (VARCHAR)
    *   `subscription_status` (ENUM: 'trial', 'active', 'churned')
    *   `created_at` (TIMESTAMP)

*   **`profiles`**:
    *   `user_id` (UUID, FK)
    *   `runner_type` (ENUM: 'Speed', 'Endurance', 'Balanced')
    *   `vdot` (FLOAT)
    *   `lt_pace` (INT, seconds/km)
    *   `pbs` (JSONB: { "5k": 1200, "marathon": 10800 })

*   **`training_plans`**:
    *   `id` (UUID, PK)
    *   `user_id` (UUID, FK)
    *   `race_date` (DATE)
    *   `distance` (ENUM: 'marathon', 'half', ...)
    *   `status` (ENUM: 'active', 'completed', 'archived')
    *   `injury_status` (JSONB: Snapshot of injury state)

*   **`workouts`**:
    *   `id` (UUID, PK)
    *   `plan_id` (UUID, FK)
    *   `scheduled_date` (DATE)
    *   `type` (ENUM: 'long', 'interval', 'recovery')
    *   `planned_distance_meters` (INT)
    *   `planned_structure` (JSONB: Steps/Intervals)
    *   `is_synced_to_device` (BOOLEAN)

*   **`activities`** (Actuals):
    *   `id` (UUID, PK)
    *   `user_id` (UUID, FK)
    *   `matched_workout_id` (UUID, FK, Nullable)
    *   `source` (ENUM: 'app_gps', 'garmin', 'strava', 'manual')
    *   `distance_meters` (FLOAT)
    *   `duration_seconds` (INT)
    *   `avg_hr` (INT)
    *   `raw_gps_data` (JSONB / S3 Link - compressed)

*   **`wearable_integrations`**:
    *   `user_id` (UUID, FK)
    *   `provider` (ENUM: 'garmin', 'oura', 'apple')
    *   `access_token` (Encrypted VARCHAR)
    *   `refresh_token` (Encrypted VARCHAR)

---

## 4. API Specification [PLANNED]

Base URL: `https://api.marathonsimulator.com/v1`

### 4.1. Authentication
*   `POST /auth/login` -> Returns JWT
*   `POST /auth/refresh`

### 4.2. Onboarding & User Mgmt
*   `POST /onboarding/profile` -> Creates `users` + `profiles` + `training_plans`
*   `GET /user/me` -> Returns profile + subscription status
*   `PATCH /user/settings` -> Update commuter days, availability

### 4.3. Training Engine
*   `GET /plan/current` -> Returns full week structure (Workouts + Plan Metadata)
*   `POST /plan/regenerate` -> Triggers re-calculation (e.g., after injury or race change)
*   `POST /workout/:id/feedback` -> Submit RPE/Feel (Updates VDOT logic)

### 4.4. Tracking & Data
*   `POST /activity/upload` -> Manual or App GPS upload
*   `GET /activities/sync` -> Fetch activities from Garmin/Strava (if webhook missed)

---

## 5. Integration Requirements

### 5.1. Apple HealthKit (via Capacitor)
*   **Read**: Steps, Resting Heart Rate, HRV (Morning), Workouts (if tracked by Apple Watch).
*   **Write**: "Marathon Sim" workouts to HealthKit ring closure.
*   **Permission**: Must request explicit read/write permission on Onboarding Step 2.

### 5.2. Garmin Health API (Cloud-to-Cloud)
*   **Mechanism**: OAuth 1.0a / 2.0.
*   **Webhooks**: `activities`, `dailies` (Sleep, RHR, HRV), `epochs`.
*   **Hardening**:
    *   **Signature Verification**: Must verify `HMAC-SHA1` signature to prevent spoofed data.
    *   **De-duplication**: Garmin and Strava may push the *same* run. We must hash the `start_time` + `duration` to prevent double-counting load.
    *   **Rate-Limited Backfill**: Fetch history in small batches (7 days) via a background job queue, not synchronously.

### 5.3. Stripe (Payments)
*   **Products**: Monthly ($X), Annual ($Y).
*   **Webhooks**: `invoice.payment_succeeded`, `customer.subscription.deleted`.
*   **Entitlement**: Backend checks `users.subscription_status`.
*   **Grace Period**: Allow 3 days of "past due" access before locking the UI to prevent churn from failed cards.

### 5.4. Notifications
*   **Push**: Firebase Cloud Messaging (FCM).
    *   Triggers: "Workout Reminder" (7 AM), "Sync Complete", "Injury Check-in".
*   **Email**: SendGrid / Amazon SES.
    *   Triggers: "Welcome", "Weekly Summary", "Race Luck".

---

## 6. Data Synchronization (Offline Support)

### 6.1. Strategy: "Local-First, Isomorphic Logic"
1.  **Logic Shared**: The `Training Engine` (VDOT, Injury, Phases) must be an **isomorphic NPM package**. It runs in the Browser (for offline generation) AND on the Server (for validation/notifications).
2.  **Conflict Resolution**:
    *   **Activities**: *Union/Append-Only*. If phone has Run A and server has Run B, keep BOTH.
    *   **Injury Status**: *Latest Write Wins*.
    *   **Plan Generation**: *Client Determinism*. The device generates the plan. The server accepts it as the "Truth" for that week unless corrupted.

### 6.2. Edge Case: Sync Conflict
*   *Scenario*: User edits RPE on Phone (Offline) AND edits RPE on Web (Online).
*   *Resolution*: **CRDT (Conflict-free Replicated Data Type)** approach for `workouts` JSON, or strict timestamp-based *Last Write Wins* for simple fields. "Server Wins" is unacceptable for user-generated data.

---

## 7. Security & Compliance

### 7.1. Authentication & AuthZ
*   **Standard**: JWT (JSON Web Tokens) with short expiry (1h) + Refresh Tokens (30d).
*   **RLS (Row Level Security)**: Database ensures User A cannot query User B's plan.

### 7.2. Data Encryption
*   **At Rest**: Database volumes encrypted (AES-256). Sensitive tokens (Garmin/Stripe) encrypted at column level.
*   **In Transit**: TLS 1.3 enforced for all API calls.

### 7.3. Compliance (GDPR / CCPA)
*   **Right to Export**: Button in Settings -> Generates JSON dump of all `activities` + `profile`.
*   **Right to Forgotten**: "Delete Account" -> Hard deletes `users` row (cascades to all data).

---

## 8. Performance Requirements

### 8.1. Targets
*   **App Launch**: <1.5s to "Ready to Run".
*   **API Response**: <200ms (P95).
*   **GPS Tracking**: <5% battery drain per hour.

### 8.2. Optimizations
*   **Database**: Index `user_id` and `date` columns.
*   **Caching**: Redis for `GET /plan/current` (invalidated on update).
*   **Asset Delivery**: CloudFront CDN for React assets.

---

## 9. Monitoring & Logging

### 9.1. Application Monitoring (APM)
*   **Tool**: Sentry (Frontend + Backend).
*   **Metrics**: App Crash Rate, Slow Frames (iOS), API Latency.

### 9.2. Logging Standards
*   **Frontend**: `console.log` wrapped in `Logger` service. Disabled in Prod. Uploads "Breadcrumbs" to Sentry on error.
*   **Backend**: JSON-structured logs (`{ level: 'info', user_id: '...', event: 'workout_generated' }`).

---

## 10. Testing Strategy

### 10.1. Unit Testing
*   **Scope**: `src/calculations`, `src/utils`.
*   **Tool**: Vitest.
*   **Goal**: 90% coverage on math engines (VDOT, Injury Logic).

### 10.2. Integration Testing
*   **Scope**: `src/workout/generator.ts`.
*   **Tool**: Vitest.
*   **Goal**: Verify plan generation rules (e.g., "Long run is on Sunday").

### 10.3. E2E Testing [PLANNED]
*   **Mobile**: Maestro (YAML-based flows).
    *   *Critical Flows*: "Onboarding passes", "Start Run -> Stop Run -> Save", "Offline Mode -> Sync".
*   **Web**: Playwright.
    *   *Critical Flows*: "Subscription Checkout", "Plan Regeneration".

---

## 11. Deployment & CI/CD

### 11.1. Strategy: Phased Rollout
1.  **Alpha**: Internal team (TestFlight / Vercel Preview).
2.  **Beta**: 5% of users (Feature Flag `new_algo_v2`).
3.  **GA**: 100% rollout.
*   **Safety**: Automatic rollback if Sentry error rate spikes > 1%.

### 11.2. Feature Flags
*   **Tool**: LaunchDarkly or simple Postgres `flags` table.
*   **Key Flags**:
    *   `enable_garmin_sync`: Toggle off if API rate limits hit.
    *   `use_new_injury_engine`: Allow A/B testing old vs new logic.

---

## 12. Edge Cases & Error Handling

### 12.1. Task/Plan Related
*   **Race Cancellation**: User changes date -> Plan must re-calculate entirely (Regenerate).
*   **Injury during Taper**: Special logic to aggressive rest (override standard taper).

### 12.2. Household / Shared Devices
*   **Scenario**: 2 users sharing an iPad.
*   **Handled By**: No "Global State" in `localStorage`. Must namespace data by `UserId` or force Logout/Login.

### 12.3. Data Sync Edge Cases
*   **Garmin Delay**: Garmin sometimes sends data 4 hours late.
*   **Handling**: Engine re-runs "Check Compliance" job hourly. If a missing run appears, adherence score is back-filled.

---

## 13. Future Considerations

### 13.1. Scalability Roadmap
*   **10k Users**: Standard Postgres is fine.
*   **100k Users**: Read Replicas, Partition `activities` table by Year.
*   **1M Users**: Sharding by Region.

### 13.2. Planned Features (Non-MVP)
*   **AI Coach Chat**: RAG (Retrieval Augmented Generation) looking up user's past training.
*   **Social Groups**: "Teams" feature.
*   **Live Tracking**: Share location with partner for safety.
