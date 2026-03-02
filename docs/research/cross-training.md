Natural-language summary (for someone who hasn’t read anything)

We’re building a running training app that adapts your plan when you do other sports.

Most running apps assume you only run. But real people play padel, football, lift weights, cycle, etc. When that happens, the app shouldn’t blindly tell you to do the exact same running sessions on top — because you’ll end up overloaded, tired, or injured.

So our system does this:
	•	You log a sport session (automatically from a watch, or manually).
	•	The app estimates how hard that session was using the best data available:
	•	If you have Garmin load, we use that.
	•	If you have heart-rate data (Apple Watch etc.), we use that.
	•	If you have no watch, we use duration + RPE (how hard it felt).
	•	The app converts that sport session into a comparable “training load” and asks:
	•	“Does this session meaningfully substitute for some of your planned running?”
	•	“Does it create enough fatigue that we should make tomorrow’s run easier?”
	•	The app then generates one simple recommendation — not a complicated run-by-run mess.
It shows a popup like:
	•	“We detected a heavy session. This is roughly similar to an easy 8–10km run.”
	•	“We recommend adjusting your plan like this: make Thursday’s tempo run easier, and shorten Saturday’s easy run.”
	•	The user gets three options:
	•	Apply the recommendation (which may slightly reduce or replace one run, and sometimes reduce another if the session was massive).
	•	Reduce only (make runs easier/shorter but don’t fully replace anything).
	•	Keep plan (do nothing, but we warn you about overload risk).

Safety + realism rules we enforce
	•	We never wipe the whole week because you played one sport.
	•	We always keep you running: minimum 2 runs per week no matter what.
	•	We avoid silly outcomes like “run 1.2km” — easy runs are clamped to at least 4km.
	•	The long run is protected: it’s the last thing we touch, and it’s never fully removed under normal conditions.
	•	We prefer to downgrade intensity first (turn a hard session into an easy run) before we delete anything, because keeping some running volume is important.

The point

This system makes the plan feel “alive” and realistic:
	•	If you do a big soccer match, it should influence your week.
	•	If you do a light yoga session, it shouldn’t.
	•	And the adjustment should be understandable, reversible, and not overly aggressive.

If you want, I can also produce a short “executive summary” you can paste into your PRD or investor deck (5–7 bullets).

