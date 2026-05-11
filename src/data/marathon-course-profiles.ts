import type { CourseProfile } from '@/types/onboarding';

/**
 * Per-race published course-profile facts for marathons and halfs.
 *
 * Sources: official race websites, Strava segment elevation aggregates, course
 * elevation maps from FindMyMarathon, historical race-day weather averages
 * (Weather Underground, MetOffice climate normals).
 *
 * No derived multipliers live here — only sourced facts. The course-factor
 * pipeline in `src/calculations/course-factors-running.ts` consumes these.
 *
 * Categorisation rules (consistent with triathlon-course-profiles.ts):
 *   runProfile (full marathon cutoffs; halve for half marathon):
 *     flat <100m, rolling 100–300m, hilly >300m
 *   climate is anchored to typical race-week wet-bulb temperature:
 *     cool 10–14°C, temperate 15–19°C, warm 20–25°C, hot 26–30°C,
 *     hot-humid 30°C+ with RH >70%
 *
 * Refresh annually if race dates or routes change.
 */
export const MARATHON_COURSE_PROFILES: Record<string, CourseProfile> = {
  // ── World Marathon Majors ────────────────────────────────────────────
  'london':                  { runElevationM: 125, runProfile: 'rolling', climate: 'cool',      altitudeM: 11,  notes: 'Net flat; gentle rises around Tower Bridge and Embankment. Cool April mornings.' },
  'berlin':                  { runElevationM: 60,  runProfile: 'flat',    climate: 'cool',      altitudeM: 34,  notes: 'Pancake-flat. World-record course. Cool September weather.' },
  'chicago':                 { runElevationM: 60,  runProfile: 'flat',    climate: 'temperate', altitudeM: 180, notes: 'Pancake-flat loop. October weather variable; can swing from cool to warm.' },
  'nyc':                     { runElevationM: 250, runProfile: 'rolling', climate: 'cool',      altitudeM: 10,  notes: 'Five bridges including Verrazzano (uphill mile 1) and Queensboro at mile 16. Cool November.' },
  'tokyo':                   { runElevationM: 100, runProfile: 'rolling', climate: 'cool',      altitudeM: 17,  notes: 'Mostly flat with gentle rolls. Cool early-March race day.' },
  'boston':                  { runElevationM: 250, runProfile: 'rolling', climate: 'cool',      altitudeM: 50,  notes: 'Net downhill but Newton hills (16-21mi) including Heartbreak Hill. April weather highly variable.' },

  // ── Other major marathons ────────────────────────────────────────────
  'paris':                   { runElevationM: 150, runProfile: 'rolling', climate: 'cool',      altitudeM: 35,  notes: 'Mostly flat with one notable rise into Bois de Vincennes. Cool April.' },
  'amsterdam':               { runElevationM: 30,  runProfile: 'flat',    climate: 'cool',      altitudeM: 0,   notes: 'Pancake-flat through canals and Amstel. Cool October.' },
  'sydney':                  { runElevationM: 250, runProfile: 'rolling', climate: 'temperate', altitudeM: 5,   notes: 'Sydney Harbour Bridge climb plus city undulations. Warm-mild September.' },
  'melbourne':               { runElevationM: 100, runProfile: 'flat',    climate: 'temperate', altitudeM: 30,  notes: 'Mostly flat through city and St Kilda. Mild October.' },
  'dubai':                   { runElevationM: 30,  runProfile: 'flat',    climate: 'warm',      altitudeM: 5,   notes: 'Pancake-flat coastal. Warm even at January dawn — heat is the limiter.' },
  'seoul':                   { runElevationM: 80,  runProfile: 'flat',    climate: 'cool',      altitudeM: 35,  notes: 'Mostly flat through central Seoul. Cool March.' },
  'valencia':                { runElevationM: 60,  runProfile: 'flat',    climate: 'cool',      altitudeM: 15,  notes: 'Pancake-flat — one of the fastest courses in Europe. Cool early December.' },
  'barcelona':               { runElevationM: 150, runProfile: 'rolling', climate: 'cool',      altitudeM: 12,  notes: 'Rolling city course with one notable rise to Montjuïc area. Cool-mild March.' },
  'rome':                    { runElevationM: 200, runProfile: 'rolling', climate: 'cool',      altitudeM: 30,  notes: 'Roman hills and cobbles in the historic centre. Cool-mild March.' },
  'toronto':                 { runElevationM: 100, runProfile: 'flat',    climate: 'temperate', altitudeM: 76,  notes: 'Net downhill point-to-point. Mild May.' },
  'manchester':              { runElevationM: 80,  runProfile: 'flat',    climate: 'cool',      altitudeM: 38,  notes: 'Mostly flat city loop. Cool April.' },
  'edinburgh':               { runElevationM: 150, runProfile: 'rolling', climate: 'cool',      altitudeM: 30,  notes: 'Net downhill point-to-point with a few rolling sections. Cool May.' },
  'copenhagen-marathon':     { runElevationM: 50,  runProfile: 'flat',    climate: 'cool',      altitudeM: 5,   notes: 'Pancake-flat city loop. Cool May.' },
  'stockholm-marathon':      { runElevationM: 200, runProfile: 'rolling', climate: 'temperate', altitudeM: 10,  notes: 'Rolling Stockholm city course with a few notable rises. Mild late-May.' },
  'helsinki-marathon':       { runElevationM: 150, runProfile: 'rolling', climate: 'temperate', altitudeM: 10,  notes: 'Rolling course around Helsinki bays. Mild August.' },
  'reykjavik-marathon':      { runElevationM: 120, runProfile: 'rolling', climate: 'cool',      altitudeM: 30,  notes: 'Rolling Icelandic coastal course. Cool August.' },
  'frankfurt-marathon':      { runElevationM: 80,  runProfile: 'flat',    climate: 'cool',      altitudeM: 110, notes: 'Mostly flat city course. Cool October.' },
  'dublin-marathon':         { runElevationM: 100, runProfile: 'flat',    climate: 'cool',      altitudeM: 20,  notes: 'Mostly flat with one rise into Phoenix Park area. Cool October.' },

  // ── Major half marathons ─────────────────────────────────────────────
  'great-north':             { runElevationM: 80,  runProfile: 'rolling', climate: 'cool',      altitudeM: 30,  notes: 'Net downhill from Newcastle to South Shields with one notable climb. Cool September.' },
  'nyc-half':                { runElevationM: 100, runProfile: 'rolling', climate: 'cool',      altitudeM: 10,  notes: 'Central Park rollers then flat downtown finish. Cool March.' },
  'big-half':                { runElevationM: 50,  runProfile: 'flat',    climate: 'cool',      altitudeM: 5,   notes: 'Mostly flat through east London. Cool September.' },
  'lisbon-half':             { runElevationM: 80,  runProfile: 'rolling', climate: 'cool',      altitudeM: 5,   notes: 'Famous net-downhill course over the 25 de Abril Bridge. Cool March.' },
  'copenhagen-half':         { runElevationM: 30,  runProfile: 'flat',    climate: 'cool',      altitudeM: 5,   notes: 'Pancake-flat city course. Cool September.' },
  'delhi-half':              { runElevationM: 60,  runProfile: 'flat',    climate: 'warm',      altitudeM: 220, notes: 'Mostly flat. Warm and humid even in late October; air-quality also a factor.' },
  'cardiff-half':            { runElevationM: 80,  runProfile: 'rolling', climate: 'cool',      altitudeM: 15,  notes: 'Rolling Cardiff city course. Cool October.' },
  'berlin-half':             { runElevationM: 40,  runProfile: 'flat',    climate: 'cool',      altitudeM: 34,  notes: 'Pancake-flat. Cool early-April.' },
  'leeds-half':              { runElevationM: 100, runProfile: 'rolling', climate: 'cool',      altitudeM: 50,  notes: 'Rolling Yorkshire course. Cool May.' },
  'hackney-half':            { runElevationM: 50,  runProfile: 'flat',    climate: 'cool',      altitudeM: 15,  notes: 'Mostly flat east London. Cool-mild May.' },
  'edinburgh-half':          { runElevationM: 100, runProfile: 'rolling', climate: 'cool',      altitudeM: 30,  notes: 'Rolling coastal course. Cool May.' },
  'liverpool-half':          { runElevationM: 80,  runProfile: 'flat',    climate: 'cool',      altitudeM: 30,  notes: 'Mostly flat city course. Cool late-May.' },
  'oslo-half':               { runElevationM: 150, runProfile: 'rolling', climate: 'temperate', altitudeM: 20,  notes: 'Rolling Oslo course. Mild June.' },
  'helsinki-half':           { runElevationM: 80,  runProfile: 'flat',    climate: 'temperate', altitudeM: 10,  notes: 'Mostly flat city course. Mild June.' },
  'brighton-marathon-half-relay': { runElevationM: 80, runProfile: 'flat', climate: 'temperate', altitudeM: 30, notes: 'Mostly flat. Mild July.' },
  'reykjavik-half':          { runElevationM: 80,  runProfile: 'rolling', climate: 'cool',      altitudeM: 30,  notes: 'Rolling Icelandic coastal course. Cool August.' },
  'bristol-half':            { runElevationM: 100, runProfile: 'rolling', climate: 'cool',      altitudeM: 30,  notes: 'Rolling Bristol city course. Cool September.' },
  'nottingham-half':         { runElevationM: 80,  runProfile: 'flat',    climate: 'cool',      altitudeM: 50,  notes: 'Mostly flat through city and Wollaton Park. Cool late-September.' },
};
