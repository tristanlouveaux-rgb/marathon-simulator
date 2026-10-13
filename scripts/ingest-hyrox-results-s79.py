#!/usr/bin/env python3
"""
Ingest HYROX race results, seasons 7 to 9, into src/data/hyrox-results-s79.ts.

Source: Kaggle dataset "HYROX Race Results, Seasons 7-9 (Anonymised)" by
Tanvi Jivani, built from public HYROX results via the pyrox-client project
(MIT). Kaggle licence "Other"; the results are not licensed by HYROX. Only
aggregate tables are written to the repo, never rows. Keep the data files
OUTSIDE the repo and pass their paths as arguments.

Usage (pyarrow is the only third-party dependency):
  <python> -I scripts/ingest-hyrox-results-s79.py \
      --results /path/to/hyrox_results_anonymised.parquet \
      --repeat  /path/to/repeat_athletes.csv \
      --out     src/data/hyrox-results-s79.ts \
      --refresh-date 2026-10-13

The script prints a human-readable ingest report to stdout and writes the
generated TypeScript module to --out. Output is deterministic for a given
input and refresh date.

Every threshold below is either derived from the data, from the timing
format, or from a named statistical rule. Each one is explained where it is
defined. No hand-picked numbers.

Side of the line: tracking. These are descriptive tables of what real
finishers did. Planning consumers (lane H3b) must state how they use them.
"""
import argparse
import collections
import csv
import math
import sys

import pyarrow.parquet as pq

# ─── Schema mapping ──────────────────────────────────────────────────────────

FORMAT_BY_DIVISION = {
    'open': 'open_singles',
    'pro': 'pro_singles',
    'doubles': 'open_doubles',
    'pro_doubles': 'pro_doubles',
}
FORMATS = ['open_singles', 'pro_singles', 'open_doubles', 'pro_doubles']
# Different events (relay = 4-person team, adaptive = adapted standards,
# elite/elite_doubles = invitation-only World Championship field). Excluded.
EXCLUDED_DIVISIONS = ['relay', 'adaptive', 'elite', 'elite_doubles']
SEXES = ['female', 'male', 'mixed']

# Race order: run1, station1, run2, station2, ... run8, station8.
RUN_COLS = [f'run{i}_time' for i in range(1, 9)]
STATION_COLS = [
    ('skiErg_time', 'ski_erg'),
    ('sledPush_time', 'sled_push'),
    ('sledPull_time', 'sled_pull'),
    ('burpeeBroadJump_time', 'burpee_broad_jumps'),
    ('rowErg_time', 'row_erg'),
    ('farmersCarry_time', 'farmer_carry'),
    ('sandbagLunges_time', 'sandbag_lunges'),
    ('wallBalls_time', 'wall_balls'),
]
SPLIT_COLS = []
for _i in range(8):
    SPLIT_COLS.append(RUN_COLS[_i])
    SPLIT_COLS.append(STATION_COLS[_i][0])
STATION_KEYS = [k for _, k in STATION_COLS]
METRICS = ['total', 'run_total', 'work_total', 'roxzone'] + STATION_KEYS

# ─── Statistical rules ───────────────────────────────────────────────────────

# Tukey (1977, Exploratory Data Analysis) "far out" fence: Q1 - 3*IQR and
# Q3 + 3*IQR. Applied on the log scale because finish and split times are
# positive and right-skewed (variation is multiplicative), so the log is the
# scale on which the distribution is close to symmetric.
TUKEY_FAR_OUT_K = 3.0

# Timing-consistency tolerance. Each recorded field (17 timed segments: 8
# runs + 8 stations + roxzone, plus the total) is a whole-second rounding of
# the true time, so each differs from the truth by less than 1 s whatever the
# rounding mode. The total minus the sum of the 17 segments can therefore
# differ from zero by less than 18 s from rounding alone. Residuals are
# integers, so |total - sum| <= 17 s is the largest gap rounding can explain;
# anything larger means a field is wrong and we cannot tell which.
SEGMENTS_WITH_ROXZONE = 17
CONSISTENCY_TOLERANCE_SEC = SEGMENTS_WITH_ROXZONE  # strict "< 18" on integers

# Cell-size rule: Dvoretzky-Kiefer-Wolfowitz inequality with Massart's (1990)
# tight constant. With probability 1 - alpha the empirical CDF lies within
# eps = sqrt(ln(2/alpha) / (2n)) of the true CDF everywhere. A table is only
# published on a breakpoint grid whose smallest gap between adjacent
# percentiles is at least 2*eps, so neighbouring breakpoints are resolved
# (their 95% simultaneous bands do not overlap). Each table gets the finest
# grid its n supports; below the coarsest grid the cell is suppressed.
DKW_ALPHA = 0.05


def dkw_eps(n):
    return math.sqrt(math.log(2.0 / DKW_ALPHA) / (2.0 * n))


def dkw_min_n(min_gap_pct):
    eps = (min_gap_pct / 100.0) / 2.0
    return math.ceil(math.log(2.0 / DKW_ALPHA) / (2.0 * eps * eps))


FINE_GRID = [1, 2] + list(range(5, 96, 5)) + [98, 99]
GRID_LADDER = [
    ('fine', FINE_GRID),
    ('five_point', [1] + list(range(5, 96, 5)) + [99]),
    ('deciles', list(range(10, 91, 10))),
    ('quartiles_10_90', [10, 25, 50, 75, 90]),
    ('quartiles', [25, 50, 75]),
]


def grid_min_gap(grid):
    return min(b - a for a, b in zip(grid, grid[1:]))


LADDER = [(name, grid, dkw_min_n(grid_min_gap(grid))) for name, grid in GRID_LADDER]
MIN_CELL_N = LADDER[-1][2]


def pick_grid(n):
    for name, grid, min_n in LADDER:
        if n >= min_n:
            return name, grid
    return None, None


# ─── Small helpers ───────────────────────────────────────────────────────────


def to_sec(v):
    """Minutes (float) -> whole seconds (int). Source times are whole seconds
    stored as minutes (402 of 20.9M timing values in the 2026-10 file carry a
    sub-second fraction), so rounding recovers them. None stays None."""
    if v is None or v != v:
        return None
    return int(math.floor(v * 60.0 + 0.5))


def quantile(sorted_vals, p):
    """Hyndman-Fan type 7 (linear interpolation between order statistics),
    the default in R and numpy. p in [0, 1]."""
    m = len(sorted_vals)
    if m == 0:
        return None
    h = (m - 1) * p
    lo = int(math.floor(h))
    hi = min(m - 1, lo + 1)
    return sorted_vals[lo] + (h - lo) * (sorted_vals[hi] - sorted_vals[lo])


def rnd(x):
    return int(math.floor(x + 0.5))


def log_fences(values):
    logs = sorted(math.log(v) for v in values if v and v > 0)
    q1 = quantile(logs, 0.25)
    q3 = quantile(logs, 0.75)
    iqr = q3 - q1
    return math.exp(q1 - TUKEY_FAR_OUT_K * iqr), math.exp(q3 + TUKEY_FAR_OUT_K * iqr)


def percentile_table(values):
    """[[seconds, cumulativePercentile], ...] on the finest grid n supports.
    cumulativePercentile = % of finishers whose time is <= seconds (the
    empirical CDF), matching the numbers in hyrox-population-distributions.ts."""
    vals = sorted(values)
    name, grid = pick_grid(len(vals))
    if grid is None:
        return None, None
    return name, [[rnd(quantile(vals, p / 100.0)), p] for p in grid]


def median(values):
    vals = sorted(values)
    return quantile(vals, 0.5) if vals else None


def fmt_mmss(sec):
    sec = rnd(sec)
    return f'{sec // 60}:{sec % 60:02d}'


# ─── Age-group normalisation ─────────────────────────────────────────────────

SINGLES_AGE_BANDS = ['16-24', '25-29', '30-34', '35-39', '40-44', '45-49',
                     '50-54', '55-59', '60-64', '65-69', '70-74', '75-79']
DOUBLES_AGE_BANDS = ['16-29', '30-39', '40-49', '50-59', '60-69', '70+']
# Season 7 doubles used 10-year bands (U29 coded MU29/WU29/XU29, 30-39 coded
# "30-34", 40-49 coded "40-44", ..., 70+ coded M70+/W70+/X70+); seasons 8-9
# use 5-year bands. Pooling seasons is only valid on the common 10-year grid,
# so every doubles label collapses onto it. Each mapping keeps the band that
# contains the label's range, so S7's lower-half labels land correctly.
DOUBLES_AGE_MAP = {
    '16-24': '16-29', '25-29': '16-29', '16-29': '16-29',
    'MU29': '16-29', 'WU29': '16-29', 'XU29': '16-29',
    '30-34': '30-39', '35-39': '30-39', '30-39': '30-39',
    '40-44': '40-49', '45-49': '40-49', '40-49': '40-49',
    '50-54': '50-59', '55-59': '50-59', '50-59': '50-59',
    '60-64': '60-69', '65-69': '60-69',
    '70-74': '70+', '75-79': '70+', 'M70+': '70+', 'W70+': '70+', 'X70+': '70+',
}
SEX_CODE = {'M': 'male', 'W': 'female', 'X': 'mixed'}


def map_age(fmt, sex, label):
    """-> (band, None) or (None, drop_reason)."""
    if label == '':
        return None, 'empty_age_group'
    if fmt in ('open_singles', 'pro_singles'):
        if label in SINGLES_AGE_BANDS:
            return label, None
        return None, 'unmapped_singles_label'
    band = DOUBLES_AGE_MAP.get(label)
    if band is None:
        return None, 'unmapped_doubles_label'
    # Coded labels carry their own sex letter. A letter that contradicts the
    # gender column means one of the two is wrong for that row.
    if label[0] in SEX_CODE and SEX_CODE[label[0]] != sex:
        return None, 'age_code_sex_conflict'
    return band, None


# ─── Main ingest ─────────────────────────────────────────────────────────────


def load_results(path):
    cols = ['season', 'location', 'year', 'gender', 'division', 'age_group',
            'total_time', 'roxzone_time', 'month'] + SPLIT_COLS
    t = pq.read_table(path, columns=cols)
    return t.num_rows, t.to_pydict()


def ingest(results_path):
    n_rows, d = load_results(results_path)
    report = collections.OrderedDict()
    report['inputRows'] = n_rows
    report['monthNonNull'] = sum(1 for v in d['month'] if v is not None)

    # R1 division filter
    excl = collections.Counter()
    unknown = collections.Counter()
    idx = []
    for i in range(n_rows):
        dv = d['division'][i]
        if dv in FORMAT_BY_DIVISION:
            idx.append(i)
        elif dv in EXCLUDED_DIVISIONS:
            excl[dv] += 1
        else:
            unknown[dv] += 1
    if unknown:
        raise SystemExit(f'unknown divisions in source: {dict(unknown)}')
    report['excludedDivisions'] = {k: excl.get(k, 0) for k in EXCLUDED_DIVISIONS}

    # Convert to seconds once.
    rows = []
    for i in idx:
        r = {
            'i': i,
            'format': FORMAT_BY_DIVISION[d['division'][i]],
            'sex': d['gender'][i],
            'season': d['season'][i],
            'year': d['year'][i],
            'location': d['location'][i],
            'age': d['age_group'][i],
            'total': to_sec(d['total_time'][i]),
            'rz': to_sec(d['roxzone_time'][i]),
            'splits': [to_sec(d[c][i]) for c in SPLIT_COLS],
        }
        if r['sex'] not in SEXES:
            raise SystemExit(f'unknown gender {r["sex"]!r}')
        rows.append(r)

    # R2 total null or <= 0 (DNS/DNF placeholders, incl. all-zero rows)
    kept = [r for r in rows if r['total'] is not None and r['total'] > 0]
    report['droppedTotalMissing'] = len(rows) - len(kept)

    # R3 exact duplicates: identical on every field, including all 18 timing
    # fields at 1 s resolution. Two different athletes or teams matching on
    # all of them is not a realistic coincidence; it is a scrape artefact.
    seen = set()
    deduped = []
    for r in kept:
        key = (r['format'], r['sex'], r['season'], r['year'], r['location'],
               r['age'], r['total'], r['rz'], tuple(r['splits']))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    report['droppedExactDuplicates'] = len(kept) - len(deduped)
    kept = deduped

    # R4 total sanity fences per format x sex (log-scale Tukey far-out)
    by_cell = collections.defaultdict(list)
    for r in kept:
        by_cell[(r['format'], r['sex'])].append(r)
    total_fences = {}
    for cell, rs in by_cell.items():
        total_fences[cell] = log_fences([r['total'] for r in rs])
    below = above = 0
    cell_n = collections.Counter()
    cell_below = collections.Counter()
    cell_above = collections.Counter()
    tmp = []
    for r in kept:
        cell = (r['format'], r['sex'])
        lo, hi = total_fences[cell]
        cell_n[cell] += 1
        if r['total'] < lo:
            below += 1
            cell_below[cell] += 1
        elif r['total'] > hi:
            above += 1
            cell_above[cell] += 1
        else:
            tmp.append(r)
    report['droppedTotalBelowFence'] = below
    report['droppedTotalAboveFence'] = above
    kept = tmp

    # Per-split fences (on rows that passed R4, values > 0).
    by_cell = collections.defaultdict(list)
    for r in kept:
        by_cell[(r['format'], r['sex'])].append(r)
    split_lo = {}
    rz_fences = {}
    for cell, rs in by_cell.items():
        for j in range(16):
            split_lo[(cell, j)] = log_fences([r['splits'][j] for r in rs])[0]
        rz_fences[cell] = log_fences([r['rz'] for r in rs])

    # R5 consistency + classification
    cls = collections.Counter()
    final = []
    for r in kept:
        cell = (r['format'], r['sex'])
        sp = r['splits']
        all16 = all(x is not None and x > 0 for x in sp)
        rz_timed = r['rz'] is not None and r['rz'] > 0
        r['split_ok'] = False
        r['rz_ok'] = False
        if not all16:
            # A missed timing mat. The data show the missing segment's time is
            # sometimes absent and sometimes folded into a neighbour, so the
            # row's other splits are untrustworthy; its total (start/finish
            # mats) is kept.
            cls['totalOnlyMissingSplit'] += 1
            final.append(r)
            continue
        s16 = sum(sp)
        if rz_timed:
            if abs(r['total'] - s16 - r['rz']) > CONSISTENCY_TOLERANCE_SEC:
                cls['droppedInconsistent'] += 1
                continue
        else:
            # Roxzone not timed at this event or for this row: the implied
            # roxzone (total - 16 segments) must itself be a plausible roxzone
            # by the same far-out fence, otherwise split time is missing.
            lo, hi = rz_fences[cell]
            implied = r['total'] - s16
            if implied < lo or implied > hi:
                cls['droppedInconsistentUntimedRoxzone'] += 1
                continue
        # Misattribution check: a split far below its far-out fence (e.g. a
        # 4 s sandbag lunge) means its time was credited to a neighbour.
        glitch = any(sp[j] < split_lo[(cell, j)] for j in range(16))
        if rz_timed and r['rz'] < rz_fences[cell][0]:
            glitch = True
        if glitch:
            cls['totalOnlySplitBelowFence'] += 1
            final.append(r)
            continue
        r['split_ok'] = True
        r['rz_ok'] = rz_timed
        cls['splitEligibleRoxzoneTimed' if rz_timed else 'splitEligibleRoxzoneUntimed'] += 1
        final.append(r)
    for k in ['droppedInconsistent', 'droppedInconsistentUntimedRoxzone',
              'totalOnlyMissingSplit', 'totalOnlySplitBelowFence',
              'splitEligibleRoxzoneTimed', 'splitEligibleRoxzoneUntimed']:
        report[k] = cls.get(k, 0)
    report['rowsKeptForTotal'] = len(final)
    report['rowsKeptForSplits'] = cls['splitEligibleRoxzoneTimed'] + cls['splitEligibleRoxzoneUntimed']
    report['rowsKeptForRoxzone'] = cls['splitEligibleRoxzoneTimed']

    fences_out = {}
    for cell, (lo, hi) in sorted(total_fences.items()):
        fences_out[cell] = {'totalLoSec': rnd(lo), 'totalHiSec': rnd(hi), 'rowsTested': cell_n[cell],
                            'droppedBelow': cell_below[cell], 'droppedAbove': cell_above[cell]}
    return final, report, fences_out, total_fences


def metric_values(r, metric):
    if metric == 'total':
        return r['total']
    if not r['split_ok']:
        return None
    sp = r['splits']
    if metric == 'run_total':
        return sum(sp[0::2])
    if metric == 'work_total':
        return sum(sp[1::2])
    if metric == 'roxzone':
        return r['rz'] if r['rz_ok'] else None
    j = STATION_KEYS.index(metric)
    return sp[2 * j + 1]


def build_tables(final):
    cells = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in final:
        c = cells[(r['format'], r['sex'])]
        for m in METRICS:
            v = metric_values(r, m)
            if v is not None:
                c[m].append(v)
    tables = {}
    counts = {}
    grids = {}
    suppressed = []
    for fmt in FORMATS:
        for sex in SEXES:
            c = cells.get((fmt, sex))
            if not c:
                continue
            # A format x sex cell is published only when every metric meets the
            # minimum, so consumers never see a cell with some metrics missing.
            if min(len(c[m]) for m in METRICS) < MIN_CELL_N:
                suppressed.append({'format': fmt, 'sex': sex, 'n': len(c['total']),
                                   'nSplits': len(c['run_total']), 'nRoxzone': len(c['roxzone'])})
                continue
            for m in METRICS:
                name, tbl = percentile_table(c[m])
                tables[(fmt, sex, m)] = tbl
                counts[(fmt, sex, m)] = len(c[m])
                grids[(fmt, sex, m)] = name
    return tables, counts, grids, suppressed, cells


def build_run_leg_medians(final):
    legs = collections.defaultdict(lambda: [[] for _ in range(8)])
    for r in final:
        if r['split_ok']:
            for j in range(8):
                legs[(r['format'], r['sex'])][j].append(r['splits'][2 * j])
    return {k: [rnd(median(v)) for v in arrs] for k, arrs in legs.items()}


def build_age_tables(final, published_cells):
    groups = collections.defaultdict(list)
    drops = collections.Counter()
    mapping_counts = collections.Counter()
    for r in final:
        if (r['format'], r['sex']) not in published_cells:
            continue
        band, why = map_age(r['format'], r['sex'], r['age'])
        if band is None:
            drops[(r['format'], why)] += 1
            continue
        mapping_counts[(r['format'], r['age'], band)] += 1
        groups[(r['format'], r['sex'], band)].append(r['total'])
    tables, counts, grids, suppressed = {}, {}, {}, []
    for fmt in FORMATS:
        bands = SINGLES_AGE_BANDS if fmt in ('open_singles', 'pro_singles') else DOUBLES_AGE_BANDS
        for sex in SEXES:
            if (fmt, sex) not in published_cells:
                continue
            for band in bands:
                vals = groups.get((fmt, sex, band), [])
                name, tbl = percentile_table(vals)
                if tbl is None:
                    if vals:  # bands with no rows at all are not cells
                        suppressed.append({'format': fmt, 'sex': sex, 'ageGroup': band, 'n': len(vals)})
                    continue
                tables[(fmt, sex, band)] = tbl
                counts[(fmt, sex, band)] = len(vals)
                grids[(fmt, sex, band)] = name
    return tables, counts, grids, suppressed, drops, mapping_counts


def season_windows(final):
    pairs = sorted({(r['season'], r['year']) for r in final})
    # Each (season, calendar year) pair is one half of a season (a season
    # runs late summer to early summer, so the calendar year splits it in
    # two). Index them chronologically; consecutive indices are adjacent
    # half-seasons.
    for (s0, y0), (s1, y1) in zip(pairs, pairs[1:]):
        if not ((s1 == s0 and y1 == y0 + 1) or (s1 == s0 + 1 and y1 == y0)):
            raise SystemExit(f'season/year windows are not contiguous: {pairs}')
    return {p: k for k, p in enumerate(pairs)}


def build_season_medians(final, published_cells):
    acc = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in final:
        if (r['format'], r['sex']) not in published_cells:
            continue
        a = acc[(r['format'], r['sex'], r['season'])]
        for m in METRICS:
            v = metric_values(r, m)
            if v is not None:
                a[m].append(v)
    out = {}
    for k, a in acc.items():
        out[k] = {
            'nTotal': len(a['total']),
            'nSplits': len(a['run_total']),
            'medians': {m: (rnd(median(a[m])) if a[m] else None) for m in METRICS},
        }
    return out


def build_venue_spread(final, published_cells):
    ev = collections.defaultdict(list)
    for r in final:
        if r['split_ok'] and (r['format'], r['sex']) in published_cells:
            ev[(r['format'], r['sex'], r['season'], r['year'], r['location'])].append(sum(r['splits'][0::2]))
    per_cell = collections.defaultdict(list)
    for (fmt, sex, *_), vals in ev.items():
        if len(vals) >= MIN_CELL_N:
            per_cell[(fmt, sex)].append(median(vals))
    out = {}
    for k, meds in per_cell.items():
        meds.sort()
        out[k] = {
            'events': len(meds),
            'p10': rnd(quantile(meds, 0.10)),
            'p50': rnd(quantile(meds, 0.50)),
            'p90': rnd(quantile(meds, 0.90)),
        }
    return out


def build_same_venue_drift(final, published_cells, windows):
    """Season comparison that controls for venue and time of year: for each
    location raced in the same half of the season one year apart (window k and
    k + 2), the change in the median of each metric, then the median of those
    changes across venues. Only venue cells with n >= MIN_CELL_N count."""
    label = {k: f'S{p[0]}-{p[1]}' for p, k in windows.items()}
    acc = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in final:
        if (r['format'], r['sex']) not in published_cells:
            continue
        a = acc[(r['format'], r['sex'], windows[(r['season'], r['year'])], r['location'])]
        for m in METRICS:
            v = metric_values(r, m)
            if v is not None:
                a[m].append(v)
    out = []
    n_windows = len(windows)
    for fmt in FORMATS:
        for sex in SEXES:
            if (fmt, sex) not in published_cells:
                continue
            for wa in range(n_windows - 2):
                wb = wa + 2
                locs_a = {loc for (f, s, w, loc) in acc if f == fmt and s == sex and w == wa}
                locs_b = {loc for (f, s, w, loc) in acc if f == fmt and s == sex and w == wb}
                common = sorted(locs_a & locs_b)
                meds = {}
                venues = {}
                for m in METRICS:
                    diffs = []
                    for loc in common:
                        va = acc[(fmt, sex, wa, loc)][m]
                        vb = acc[(fmt, sex, wb, loc)][m]
                        if len(va) >= MIN_CELL_N and len(vb) >= MIN_CELL_N:
                            diffs.append(median(vb) - median(va))
                    meds[m] = rnd(median(diffs)) if diffs else None
                    venues[m] = len(diffs)
                out.append({
                    'format': fmt, 'sex': sex, 'from': label[wa], 'to': label[wb],
                    'venuesTotal': venues['total'], 'venuesSplits': venues['run_total'],
                    'medianShiftSec': meds,
                })
    return out


# ─── Improvement (repeat athletes) ───────────────────────────────────────────

# HYROX_TIME_TO_BAND_THRESHOLDS in src/constants/hyrox-constants.ts, applied
# exactly as bandFromTime() does (sec < maxSec, first match wins).
# total_beginner is never time-derived in the app, so it cannot appear here.
BAND_THRESHOLDS = [(60 * 60, 'competitive'), (80 * 60, 'advanced'),
                   (100 * 60, 'intermediate'), (120 * 60, 'novice'),
                   (float('inf'), 'beginner')]
BANDS = [b for _, b in BAND_THRESHOLDS]


def band_from_sec(sec):
    for mx, b in BAND_THRESHOLDS:
        if sec < mx:
            return b
    return 'beginner'


def build_improvement(repeat_path, final, total_fences, windows):
    # Event median per (season, location, year, format, sex) from the cleaned
    # total population. Normalising by it removes course and venue effects.
    ev = collections.defaultdict(list)
    for r in final:
        ev[(r['season'], r['location'], r['year'], r['format'], r['sex'])].append(r['total'])
    ev_med = {k: (median(v), len(v)) for k, v in ev.items()}

    rep = collections.OrderedDict()
    rows = list(csv.DictReader(open(repeat_path, newline='')))
    rep['inputRows'] = len(rows)
    rep['monthsBetweenNonEmpty'] = sum(1 for r in rows if r.get('months_between', '') != '')
    drops = collections.Counter()
    records = []
    auth_changes = []
    for r in rows:
        fmt = FORMAT_BY_DIVISION.get(r['division'])
        sex = r['gender']
        if fmt not in ('open_singles', 'pro_singles') or sex not in ('female', 'male'):
            drops['unsupportedDivisionOrSex'] += 1
            continue
        try:
            ta = to_sec(float(r['total_time_a']))
            tb = to_sec(float(r['total_time_b']))
        except ValueError:
            drops['totalMissing'] += 1
            continue
        if not ta or not tb or ta <= 0 or tb <= 0:
            drops['totalMissing'] += 1
            continue
        lo, hi = total_fences[(fmt, sex)]
        if not (lo <= ta <= hi and lo <= tb <= hi):
            drops['totalOutsideFence'] += 1
            continue
        ka = (int(r['season_a']), r['location_a'], int(r['year_a']), fmt, sex)
        kb = (int(r['season_b']), r['location_b'], int(r['year_b']), fmt, sex)
        if ka not in ev_med or kb not in ev_med or ev_med[ka][1] < MIN_CELL_N or ev_med[kb][1] < MIN_CELL_N:
            # Normaliser needs an event cell meeting the same minimum n as any
            # published cell.
            drops['eventCellBelowMinN'] += 1
            continue
        wa = windows.get((ka[0], ka[2]))
        wb = windows.get((kb[0], kb[2]))
        if wa is None or wb is None or wb <= wa:
            drops['raceOrderUnresolved'] += 1
            continue
        rel = (tb / ev_med[kb][0]) / (ta / ev_med[ka][0]) - 1.0
        ab = tb / ta - 1.0
        records.append({
            'format': fmt, 'sex': sex, 'gap': wb - wa,
            'band_first': band_from_sec(ta), 'band_mean': band_from_sec((ta + tb) / 2.0),
            'rel': rel, 'abs': ab, 'dsec': tb - ta,
        })
        try:
            auth_changes.append(float(r['total_time_rel_b']) / float(r['total_time_rel_a']) - 1.0)
        except (ValueError, ZeroDivisionError):
            pass
    rep['dropped'] = dict(sorted(drops.items()))
    rep['used'] = len(records)
    rep['authorRelMedianPct'] = round(100 * median(auth_changes), 1) if auth_changes else None

    combos = [('all_singles', 'all'), ('open_singles', 'female'), ('open_singles', 'male'),
              ('pro_singles', 'female'), ('pro_singles', 'male')]
    gaps = sorted({x['gap'] for x in records})
    out, suppressed = [], []
    for fmt, sex in combos:
        sub = [x for x in records if (fmt == 'all_singles' or x['format'] == fmt) and (sex == 'all' or x['sex'] == sex)]
        for group_by, key in (('first_race', 'band_first'), ('mean_of_races', 'band_mean')):
            for band in ['all'] + BANDS:
                for gap in ['all'] + gaps:
                    if band == 'all' and group_by == 'mean_of_races':
                        continue  # identical to first_race when not split by band
                    cell = [x for x in sub if (band == 'all' or x[key] == band) and (gap == 'all' or x['gap'] == gap)]
                    n = len(cell)
                    desc = {'format': fmt, 'sex': sex, 'groupBy': group_by, 'band': band, 'gapHalfSeasons': gap, 'n': n}
                    if n < MIN_CELL_N:
                        if n > 0:
                            suppressed.append(desc)
                        continue
                    rel = sorted(x['rel'] for x in cell)
                    ab = sorted(x['abs'] for x in cell)
                    ds = sorted(x['dsec'] for x in cell)
                    desc.update({
                        'relPct': [round(100 * quantile(rel, p), 1) for p in (0.25, 0.5, 0.75)],
                        'absPct': [round(100 * quantile(ab, p), 1) for p in (0.25, 0.5, 0.75)],
                        'absMedianSec': rnd(quantile(ds, 0.5)),
                    })
                    out.append(desc)
    gap_counts = collections.Counter(x['gap'] for x in records)
    rep['byGap'] = {str(k): gap_counts[k] for k in sorted(gap_counts)}
    return out, suppressed, rep


# ─── TypeScript emit ─────────────────────────────────────────────────────────


def ts_table(tbl):
    return '[' + ', '.join(f'[{s}, {p}]' for s, p in tbl) + ']'


def ts_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def ts_key(k):
    return k if k.replace('_', '').isalnum() and not k[0].isdigit() else ts_str(k)


def ts_obj_inline(d):
    parts = []
    for k, v in d.items():
        parts.append(f'{ts_key(k)}: {ts_val(v)}')
    return '{ ' + ', '.join(parts) + ' }'


def ts_val(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return ts_str(v)
    if isinstance(v, (list, tuple)):
        return '[' + ', '.join(ts_val(x) for x in v) + ']'
    if isinstance(v, dict):
        return ts_obj_inline(v)
    raise TypeError(type(v))


def emit(out_path, refresh_date, report, fences, tables, counts, grids, main_suppressed,
         age_tables, age_counts, age_grids, age_suppressed, age_drops, age_mapping,
         season_meds, venue_spread, run_legs, improvement, imp_suppressed, imp_report, drift):
    # Header claims computed from the data so they stay true on regeneration.
    shares = []
    for (fmt, sex), f in fences.items():
        if (fmt, sex, 'total') in tables and f['rowsTested']:
            shares.append((100.0 * f['droppedAbove'] / f['rowsTested'], f'{fmt} {sex}'))
    max_above_pct, max_above_cell = max(shares)
    max_above_pct = f'{max_above_pct:.2f}'
    shift_lines = []
    for fmt in FORMATS:
        best = None
        for c in drift:
            if c['format'] != fmt or c['medianShiftSec']['total'] is None:
                continue
            if best is None or abs(c['medianShiftSec']['total']) > abs(best['medianShiftSec']['total']):
                best = c
        iqrs = [tables[(fmt, sex, 'total')] for sex in SEXES if (fmt, sex, 'total') in tables]
        iqr_min = min(dict((p, v) for v, p in t)[75] - dict((p, v) for v, p in t)[25] for t in iqrs)
        if best:
            shift_lines.append(
                f"{fmt}: {best['medianShiftSec']['total']:+d} s ({best['sex']}, {best['from']} to {best['to']}, "
                f"{best['venuesTotal']} venues); smallest total IQR in the format {iqr_min} s")
    L = []
    w = L.append
    w('/**')
    w(' * HYROX results, seasons 7 to 9. Real outcome data. GENERATED FILE: do not edit by hand.')
    w(' *')
    w(' * Source: Kaggle "HYROX Race Results, Seasons 7-9 (Anonymised)" (Tanvi Jivani),')
    w(' * built from public HYROX results via the open pyrox project (pyrox-client, MIT).')
    w(' * Kaggle licence "Other"; results are not licensed by HYROX. Only aggregate')
    w(' * tables are shipped, never rows.')
    w(' *')
    w(' * Regenerate (data files live outside the repo):')
    w(' *   <python with pyarrow> -I scripts/ingest-hyrox-results-s79.py \\')
    w(' *     --results <hyrox_results_anonymised.parquet> --repeat <repeat_athletes.csv> \\')
    w(f' *     --out src/data/hyrox-results-s79.ts --refresh-date {refresh_date}')
    w(' *')
    w(' * Side of the line: tracking (descriptive population tables). Not yet wired to')
    w(' * any consumer; src/data/hyrox-population-distributions.ts (S4 to S6) is still')
    w(' * the live source until lane H3b switches over.')
    w(' *')
    w(' * Conventions')
    w(' * - All times are whole seconds.')
    w(' * - Percentile tables are `[seconds, cumulativePercentile]`, ascending in both.')
    w(' *   cumulativePercentile = % of finishers whose time is <= seconds (the')
    w(' *   empirical CDF): `[3600, 10]` means 10% of finishers were at or under 1:00:00.')
    w(' *   This matches the numbers in hyrox-population-distributions.ts, whose doc')
    w(' *   comment words it as "slower than or equal"; the numbers there are the CDF')
    w(' *   too (p1 is the fastest time), and consumers compute "faster than X%" as')
    w(' *   `100 - cumulativePercentile`.')
    w(' * - Quantiles use linear interpolation between order statistics (Hyndman-Fan')
    w(' *   type 7), rounded to the nearest second.')
    w(' * - Breakpoint grids vary by cell size (see HYROX_S79_GRID_LADDER): each table')
    w(' *   uses the finest grid whose smallest percentile gap is at least twice the')
    w(' *   DKW 95% simultaneous band half-width for its n. Cells below the coarsest')
    w(' *   grid (n < HYROX_S79_MIN_CELL_N) are suppressed and listed.')
    w(' *')
    w(' * Row hygiene (counts in HYROX_S79_INGEST_REPORT)')
    w(' * 1. Divisions relay, adaptive, elite, elite_doubles excluded (different events).')
    w(' * 2. Total missing or <= 0 dropped (DNS/DNF placeholders).')
    w(' * 3. Exact duplicate rows dropped (identical on all 18 timing fields).')
    w(' * 4. Total outside the log-scale Tukey far-out fence (Q1 - 3 IQR, Q3 + 3 IQR)')
    w(' *    per format x sex dropped. Fences in HYROX_S79_TOTAL_FENCES_SEC. Below the')
    w(' *    lower fence are impossible times; above the upper fence the tail is')
    w(f' *    continuous, so some genuine very slow finishers go too (at most {max_above_pct}% of a')
    w(f' *    cell, {max_above_cell}), shifting the published p99 by at most that many points.')
    w(' * 5. Rows with all 17 segments timed: |total - sum| <= 17 s required (17')
    w(' *    segments + total, each rounded to the second, can only drift < 18 s).')
    w(' *    Rows with untimed roxzone: implied roxzone (total - 16 segments) must sit')
    w(' *    inside the roxzone far-out fences. Failing rows are dropped entirely.')
    w(' * 6. Rows with a missed split mat, or any split/roxzone below its far-out lower')
    w(' *    fence (time credited to a neighbour), feed the total table only.')
    w(' * Split metrics (run_total, work_total, stations) share one row set; roxzone')
    w(' * additionally needs a timed roxzone.')
    w(' *')
    w(' * Seasons are pooled (S7 to S9). At the same venue and the same half of the')
    w(' * season one year apart, the largest shift in the median total is:')
    for line in shift_lines:
        w(f' *   {line}')
    w(' * Open formats have many shared venues; pro shifts rest on few venues. S9 is a')
    w(' * partial season whose larger raw shift is mostly venue mix. Wall balls and')
    w(' * sled push step up at the S7 to S8 boundary at the same venues (attributed to')
    w(' * the S8 judging change), so pooled tables for those two stations read faster')
    w(' * than the S8 and S9 field: compare the pooled p50 with the S8 and S9 rows of')
    w(' * HYROX_S79_SEASON_MEDIANS, and see HYROX_S79_SAME_VENUE_SEASON_SHIFT.')
    w(' *')
    w(' * Limitation: run legs are not exactly 1 km at every venue (course layouts')
    w(' * differ), so run splits carry venue variation. HYROX_S79_VENUE_RUN_TOTAL_SPREAD')
    w(' * shows the spread of event medians, which mixes course length with field')
    w(' * strength.')
    w(' */')
    w('')
    w("import type { AbilityBand, HyroxStation } from '@/types/triathlon';")
    w('')
    w("export type HyroxResultsFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';")
    w("export type HyroxResultsSex = 'female' | 'male' | 'mixed';")
    w("export type HyroxResultsMetric = 'total' | 'run_total' | 'work_total' | 'roxzone' | HyroxStation;")
    w('/** `[seconds, cumulativePercentile]`; see the file header for the convention. */')
    w('export type HyroxPercentilePoint = readonly [number, number];')
    w('export type HyroxPercentileTable = readonly HyroxPercentilePoint[];')
    w("export type HyroxGridName = " + ' | '.join(ts_str(n) for n, _, _ in LADDER) + ';')
    w('')
    w(f'export const HYROX_S79_LAST_REFRESH_DATE = {ts_str(refresh_date)};')
    w('export const HYROX_S79_SEASONS = [7, 8, 9] as const;')
    w("export const HYROX_S79_SOURCE = 'Kaggle: HYROX Race Results, Seasons 7-9 (Anonymised), Tanvi Jivani; built with pyrox-client (MIT) from public HYROX results';")
    w("export const HYROX_S79_ATTRIBUTION = 'HYROX results, seasons 7 to 9 (2024 to 2026), via the open pyrox project';")
    w('')
    w('/** DKW cell-size rule. A grid is used only when n >= minN, where minN makes the')
    w(' *  95% simultaneous band half-width eps = sqrt(ln(2/0.05) / (2n)) at most half the')
    w(' *  grid\'s smallest percentile gap. Finest grid first. */')
    w('export const HYROX_S79_GRID_LADDER: ReadonlyArray<{ name: HyroxGridName; percentiles: readonly number[]; minN: number }> = [')
    for name, grid, min_n in LADDER:
        w(f'  {{ name: {ts_str(name)}, percentiles: {ts_val(grid)}, minN: {min_n} }},')
    w('];')
    w(f'export const HYROX_S79_DKW_ALPHA = {DKW_ALPHA};')
    w(f'/** Smallest publishable cell (coarsest grid\'s minN). */')
    w(f'export const HYROX_S79_MIN_CELL_N = {MIN_CELL_N};')
    w(f'/** Timing-consistency tolerance (seconds); see header rule 5. */')
    w(f'export const HYROX_S79_CONSISTENCY_TOLERANCE_SEC = {CONSISTENCY_TOLERANCE_SEC};')
    w('')
    w('/** Ingest report: rows dropped or routed by each hygiene rule, in order. */')
    w('export const HYROX_S79_INGEST_REPORT = {')
    for k, v in report.items():
        w(f'  {k}: {ts_val(v)},')
    w('} as const;')
    w('')
    w('/** Total-time sanity fences (seconds) per format x sex, from rule 4, with the rows')
    w(' *  each fence tested and dropped. */')
    w('export const HYROX_S79_TOTAL_FENCES_SEC: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, { lo: number; hi: number; rowsTested: number; droppedBelow: number; droppedAbove: number }>>> = {')
    for fmt in FORMATS:
        parts = []
        for sex in SEXES:
            f = fences.get((fmt, sex))
            if f:
                parts.append(f'{sex}: {{ lo: {f["totalLoSec"]}, hi: {f["totalHiSec"]}, rowsTested: {f["rowsTested"]}, '
                             f'droppedBelow: {f["droppedBelow"]}, droppedAbove: {f["droppedAbove"]} }}')
        w(f'  {fmt}: {{ ' + ', '.join(parts) + ' },')
    w('};')
    w('')

    published_cells = sorted({(f, s) for (f, s, _) in tables}, key=lambda x: (FORMATS.index(x[0]), SEXES.index(x[1])))

    w('/** Finishers behind each published table (format x sex x metric). */')
    w('export const HYROX_S79_FINISHER_COUNTS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, number>>>> = {')
    for fmt in FORMATS:
        w(f'  {fmt}: {{')
        for sex in SEXES:
            if (fmt, sex) not in published_cells:
                continue
            parts = ', '.join(f'{m}: {counts[(fmt, sex, m)]}' for m in METRICS)
            w(f'    {sex}: {{ {parts} }},')
        w('  },')
    w('};')
    w('')
    w('/** Format x sex cells withheld because a metric falls below HYROX_S79_MIN_CELL_N.')
    w(' *  pro_doubles mixed is also not a rulebook category (no Pro Mixed doubles). */')
    w('export const HYROX_S79_SUPPRESSED_CELLS: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; n: number; nSplits: number; nRoxzone: number }> = [')
    for s in main_suppressed:
        w(f'  {ts_obj_inline(s)},')
    w('];')
    w('')
    w('/** Percentile tables per format x sex x metric. */')
    w('export const HYROX_S79_PERCENTILES: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, HyroxPercentileTable>>>> = {')
    for fmt in FORMATS:
        w(f'  {fmt}: {{')
        for sex in SEXES:
            if (fmt, sex) not in published_cells:
                continue
            w(f'    {sex}: {{')
            for m in METRICS:
                w(f'      {m}: {ts_table(tables[(fmt, sex, m)])},')
            w('    },')
        w('  },')
    w('};')
    w('')
    w('/** Grid used by each published table (see HYROX_S79_GRID_LADDER). */')
    w('export const HYROX_S79_GRIDS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, HyroxGridName>>>> = {')
    for fmt in FORMATS:
        w(f'  {fmt}: {{')
        for sex in SEXES:
            if (fmt, sex) not in published_cells:
                continue
            parts = ', '.join(f'{m}: {ts_str(grids[(fmt, sex, m)])}' for m in METRICS)
            w(f'    {sex}: {{ {parts} }},')
        w('  },')
    w('};')
    w('')
    w('/** Median split per run leg (run 1 to run 8), seconds. Same rows as run_total. */')
    w('export const HYROX_S79_RUN_LEG_MEDIANS_SEC: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, readonly number[]>>> = {')
    for fmt in FORMATS:
        parts = []
        for sex in SEXES:
            if (fmt, sex) in published_cells:
                parts.append(f'{sex}: {ts_val(run_legs[(fmt, sex)])}')
        w(f'  {fmt}: {{ ' + ', '.join(parts) + ' },')
    w('};')
    w('')

    # Age tables
    w('/**')
    w(' * Age-group bands per format. Singles keep the 5-year bands in the data.')
    w(' * Doubles pool onto 10-year bands: season 7 doubles used 10-year bands')
    w(' * (U29 coded MU29/WU29/XU29, 30-39 coded "30-34", 70+ coded M70+/W70+/X70+),')
    w(' * seasons 8 and 9 use 5-year bands, and only the 10-year grid is common to all.')
    w(' * The dataset carries one age label per team; how HYROX assigns it (the brief')
    w(' * says pair average) cannot be checked from the data.')
    w(' */')
    w('export const HYROX_S79_AGE_GROUPS: Record<HyroxResultsFormat, readonly string[]> = {')
    for fmt in FORMATS:
        bands = SINGLES_AGE_BANDS if fmt in ('open_singles', 'pro_singles') else DOUBLES_AGE_BANDS
        w(f'  {fmt}: {ts_val(bands)},')
    w('};')
    w('')
    w('/** Source label -> published band, with rows mapped (total-table rows only). */')
    w('export const HYROX_S79_AGE_LABEL_MAPPING: ReadonlyArray<{ format: HyroxResultsFormat; label: string; band: string; rows: number }> = [')
    for (fmt, label, band), n in sorted(age_mapping.items(), key=lambda kv: (FORMATS.index(kv[0][0]), kv[0][2], kv[0][1])):
        w(f'  {{ format: {ts_str(fmt)}, label: {ts_str(label)}, band: {ts_str(band)}, rows: {n} }},')
    w('];')
    w('')
    w('/** Total-table rows left out of the age tables, by format and reason. */')
    w('export const HYROX_S79_AGE_DROPS: ReadonlyArray<{ format: HyroxResultsFormat; reason: string; rows: number }> = [')
    for (fmt, why), n in sorted(age_drops.items(), key=lambda kv: (FORMATS.index(kv[0][0]), kv[0][1])):
        w(f'  {{ format: {ts_str(fmt)}, reason: {ts_str(why)}, rows: {n} }},')
    w('];')
    w('')
    w('/** Total-time percentile tables per format x sex x age band. */')
    w('export const HYROX_S79_AGE_TOTAL_PERCENTILES: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<string, HyroxPercentileTable>>>> = {')
    for fmt in FORMATS:
        w(f'  {fmt}: {{')
        for sex in SEXES:
            keys = [b for (f, s, b) in age_tables if f == fmt and s == sex]
            if not keys:
                continue
            bands = SINGLES_AGE_BANDS if fmt in ('open_singles', 'pro_singles') else DOUBLES_AGE_BANDS
            w(f'    {sex}: {{')
            for b in bands:
                if (fmt, sex, b) in age_tables:
                    w(f'      {ts_str(b)}: {ts_table(age_tables[(fmt, sex, b)])},')
            w('    },')
        w('  },')
    w('};')
    w('')
    w('/** Finishers behind each published age table. */')
    w('export const HYROX_S79_AGE_TOTAL_COUNTS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<string, number>>>> = {')
    for fmt in FORMATS:
        w(f'  {fmt}: {{')
        for sex in SEXES:
            bands = SINGLES_AGE_BANDS if fmt in ('open_singles', 'pro_singles') else DOUBLES_AGE_BANDS
            parts = [f'{ts_str(b)}: {age_counts[(fmt, sex, b)]}' for b in bands if (fmt, sex, b) in age_counts]
            if parts:
                w(f'    {sex}: {{ ' + ', '.join(parts) + ' },')
        w('  },')
    w('};')
    w('')
    w('/** Age cells withheld for n < HYROX_S79_MIN_CELL_N. */')
    w('export const HYROX_S79_AGE_SUPPRESSED_CELLS: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; ageGroup: string; n: number }> = [')
    for s in age_suppressed:
        w(f'  {ts_obj_inline(s)},')
    w('];')
    w('')

    # Season medians
    w('/** Per-season medians (seconds) to show whether S7, S8 and S9 are comparable. */')
    w('export const HYROX_S79_SEASON_MEDIANS: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; season: number; nTotal: number; nSplits: number; medians: Record<HyroxResultsMetric, number> }> = [')
    for (fmt, sex, season) in sorted(season_meds, key=lambda k: (FORMATS.index(k[0]), SEXES.index(k[1]), k[2])):
        s = season_meds[(fmt, sex, season)]
        med_s = ', '.join(f'{m}: {s["medians"][m]}' for m in METRICS)
        w(f'  {{ format: {ts_str(fmt)}, sex: {ts_str(sex)}, season: {season}, nTotal: {s["nTotal"]}, nSplits: {s["nSplits"]}, medians: {{ {med_s} }} }},')
    w('];')
    w('')
    w('/** Same-venue season comparison: median across venues of the change in each')
    w(' *  metric\'s median (seconds, positive = slower) between the same half of')
    w(' *  consecutive seasons (autumn to autumn, spring to spring). Controls for venue')
    w(' *  mix and time of year, which the raw per-season medians do not. */')
    w('export const HYROX_S79_SAME_VENUE_SEASON_SHIFT: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; from: string; to: string; venuesTotal: number; venuesSplits: number; medianShiftSec: Record<HyroxResultsMetric, number | null> }> = [')
    for c in drift:
        w(f'  {ts_obj_inline(c)},')
    w('];')
    w('')
    w('/** Spread of event-median run_total across events (n >= HYROX_S79_MIN_CELL_N),')
    w(' *  seconds. Quantifies course-length variation between venues. */')
    w('export const HYROX_S79_VENUE_RUN_TOTAL_SPREAD: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, { events: number; p10: number; p50: number; p90: number }>>> = {')
    for fmt in FORMATS:
        parts = []
        for sex in SEXES:
            v = venue_spread.get((fmt, sex))
            if v and (fmt, sex) in published_cells:
                parts.append(f'{sex}: {ts_obj_inline(v)}')
        w(f'  {fmt}: {{ ' + ', '.join(parts) + ' },')
    w('};')
    w('')

    # Improvement
    w('/**')
    w(' * Improvement between a repeat athlete\'s first and latest race (singles only;')
    w(' * the repeat file has no doubles). Negative = faster.')
    w(' * - relPct: change in time relative to the event median (event x format x sex),')
    w(' *   which removes course and venue effects. Also includes field drift: the')
    w(' *   field has slowed slightly season on season, which flatters relPct.')
    w(' * - absPct / absMedianSec: raw change in finish time (venue noise included).')
    w(' * - Quartiles are [p25, median, p75].')
    w(' * - band: HYROX_TIME_TO_BAND_THRESHOLDS on the first race\'s total (groupBy')
    w(' *   first_race) or on the mean of both races (groupBy mean_of_races, Oldham\'s')
    w(' *   method). Grouping on the first race builds in regression to the mean (a')
    w(' *   slow first race tends to be followed by a faster one); compare the two.')
    w(' * - gapHalfSeasons: half-season windows between the races, from season and')
    w(' *   calendar year (the only populated date fields; month is empty). Gap g means')
    w(' *   roughly 6g months apart, anywhere from 6(g-1) to 6(g+1) months. The')
    w(' *   repeat file holds no pair inside a single window, so gaps start at 1.')
    w(' * - Selection: only athletes who raced again appear (survivorship).')
    w(' */')
    w("export interface HyroxImprovementCell {")
    w("  format: 'all_singles' | 'open_singles' | 'pro_singles';")
    w("  sex: 'all' | 'female' | 'male';")
    w("  groupBy: 'first_race' | 'mean_of_races';")
    w("  band: 'all' | Exclude<AbilityBand, 'total_beginner'>;")
    w("  gapHalfSeasons: 'all' | number;")
    w('  n: number;')
    w('  relPct: readonly [number, number, number];')
    w('  absPct: readonly [number, number, number];')
    w('  absMedianSec: number;')
    w('}')
    w('export const HYROX_S79_IMPROVEMENT: readonly HyroxImprovementCell[] = [')
    for c in improvement:
        w(f'  {ts_obj_inline(c)},')
    w('];')
    w('')
    w('/** Improvement cells withheld for n < HYROX_S79_MIN_CELL_N (empty cells omitted). */')
    w("export const HYROX_S79_IMPROVEMENT_SUPPRESSED: ReadonlyArray<Pick<HyroxImprovementCell, 'format' | 'sex' | 'groupBy' | 'band' | 'gapHalfSeasons' | 'n'>> = [")
    for c in imp_suppressed:
        w(f'  {ts_obj_inline(c)},')
    w('];')
    w('')
    w('/** Repeat-athlete ingest report. authorRelMedianPct is the median change using the')
    w(' *  dataset\'s own *_rel columns, for comparison only: their venue-typical time is')
    w(' *  constant per event but drifts against the recomputed event median from season')
    w(' *  to season, so it is not used. */')
    w('export const HYROX_S79_IMPROVEMENT_REPORT = {')
    for k, v in imp_report.items():
        w(f'  {k}: {ts_val(v)},')
    w('} as const;')
    w('')
    with open(out_path, 'w', newline='\n') as fh:
        fh.write('\n'.join(L))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--results', required=True)
    ap.add_argument('--repeat', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--refresh-date', required=True)
    a = ap.parse_args()

    final, report, fences, total_fences = ingest(a.results)
    tables, counts, grids, main_suppressed, _cells = build_tables(final)
    published_cells = {(f, s) for (f, s, _) in tables}
    age_tables, age_counts, age_grids, age_suppressed, age_drops, age_mapping = build_age_tables(final, published_cells)
    season_meds = build_season_medians(final, published_cells)
    venue_spread = build_venue_spread(final, published_cells)
    run_legs = build_run_leg_medians(final)
    windows = season_windows(final)
    improvement, imp_suppressed, imp_report = build_improvement(a.repeat, final, total_fences, windows)
    drift = build_same_venue_drift(final, published_cells, windows)

    emit(a.out, a.refresh_date, report, fences, tables, counts, grids, main_suppressed,
         age_tables, age_counts, age_grids, age_suppressed, age_drops, age_mapping,
         season_meds, venue_spread, run_legs, improvement, imp_suppressed, imp_report, drift)

    # Human-readable report
    p = print
    p('== Ingest report ==')
    for k, v in report.items():
        p(f'  {k}: {v}')
    p('== Grid ladder ==')
    for name, grid, min_n in LADDER:
        p(f'  {name}: minN {min_n}, {len(grid)} breakpoints')
    p('== Headline medians (p50) ==')
    for fmt in FORMATS:
        for sex in SEXES:
            if (fmt, sex) not in published_cells:
                continue
            med = {m: dict((pp, s) for s, pp in tables[(fmt, sex, m)]).get(50) for m in METRICS}
            p(f'  {fmt} {sex} n={counts[(fmt, sex, "total")]}/{counts[(fmt, sex, "run_total")]}/{counts[(fmt, sex, "roxzone")]}: '
              + ' '.join(f'{m}={fmt_mmss(med[m])}' for m in METRICS))
    p('== Suppressed main cells ==')
    for s in main_suppressed:
        p(f'  {s}')
    p('== Age drops ==')
    for k, v in sorted(age_drops.items()):
        p(f'  {k}: {v}')
    p('== Suppressed age cells ==')
    for s in age_suppressed:
        p(f'  {s}')
    p('== Season medians (total) ==')
    for k in sorted(season_meds, key=lambda k: (FORMATS.index(k[0]), SEXES.index(k[1]), k[2])):
        s = season_meds[k]
        p(f'  {k}: n={s["nTotal"]} total={fmt_mmss(s["medians"]["total"])} runs={fmt_mmss(s["medians"]["run_total"])} '
          f'work={fmt_mmss(s["medians"]["work_total"])} rz={fmt_mmss(s["medians"]["roxzone"])} wb={fmt_mmss(s["medians"]["wall_balls"])} sp={fmt_mmss(s["medians"]["sled_push"])}')
    p('== Same-venue season shift (median across venues, seconds) ==')
    for c in drift:
        ms = c['medianShiftSec']
        p(f"  {c['format']} {c['sex']} {c['from']}->{c['to']} venues={c['venuesTotal']}/{c['venuesSplits']}: "
          + ' '.join(f'{m}={ms[m]}' for m in METRICS))
    p('== Venue run_total spread ==')
    for k, v in sorted(venue_spread.items()):
        p(f'  {k}: {v}')
    p('== Improvement report ==')
    for k, v in imp_report.items():
        p(f'  {k}: {v}')
    for c in improvement:
        if c['format'] == 'all_singles' and c['sex'] == 'all':
            p(f'  {c}')
    p(f'  suppressed improvement cells: {len(imp_suppressed)}')


if __name__ == '__main__':
    sys.exit(main())
