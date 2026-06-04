/**
 * WMA/USATF road age-grade standards. Real published tables.
 *
 * Source: Alan Jones official age-grade tables, 2025 road standards
 * ("Version 2025-07-27", approved 2025-01-10 by the Masters Long Distance
 * Running council of USATF; maintained with WMA). Downloaded from
 * github.com/AlanLyttonJones/Age-Grade-Tables (2025 Files,
 * MaleRoadStd2025.xlsx / FemaleRoadStd2025.xlsx, 'AgeStdSec' sheet) and
 * ingested via `scripts/ingest-wma-age-grading.py` on 2026-06-03.
 * Tables are CC-BY-4.0.
 *
 * Age grade = ageStandardSec(age, sex, distance) / yourTimeSec, as a
 * percentage. 100% = the standard (world-best level) for that age and sex.
 * Interpretation bands are the published USATF/Alan Jones convention:
 * 90%+ world class, 80%+ national class, 70%+ regional class, 60%+ local class.
 *
 * Arrays are indexed by age starting at `minAge` (one entry per year).
 * Regenerate: download the two xlsx files, then
 *   python3 scripts/ingest-wma-age-grading.py Male.xlsx Female.xlsx
 */

export type WmaDistanceKey = 'k5' | 'k10' | 'half' | 'marathon';

export interface WmaSexTable {
  minAge: number;
  maxAge: number;
  /** Open-class (absolute) standard per distance, seconds. */
  openSec: Record<WmaDistanceKey, number>;
  k5: number[];
  k10: number[];
  half: number[];
  marathon: number[];
}

// Male Road Age Standards in Seconds 2025 -- Version 2025-07-27
const MALE: WmaSexTable = {
  minAge: 5, maxAge: 100,
  openSec: { k5: 769, k10: 1584, half: 3451, marathon: 7235 },
  k5: [1265, 1154, 1068, 1000, 946, 903, 868, 840, 817, 800, 788, 780, 773, 769, 769, 769, 769, 769, 769, 769, 769, 769, 769, 769, 769, 769, 770, 772, 774, 778, 783, 788, 794, 800, 806, 812, 818, 824, 830, 836, 843, 849, 856, 863, 869, 876, 883, 891, 898, 905, 913, 920, 928, 936, 944, 952, 961, 969, 978, 987, 995, 1005, 1014, 1023, 1034, 1046, 1059, 1073, 1088, 1105, 1123, 1143, 1165, 1188, 1214, 1242, 1273, 1306, 1343, 1384, 1428, 1477, 1532, 1592, 1660, 1736, 1822, 1920, 2032, 2163, 2314, 2494, 2709, 2971, 3300, 3720],
  k10: [3122, 2790, 2537, 2340, 2184, 2058, 1955, 1871, 1801, 1745, 1699, 1662, 1634, 1613, 1600, 1589, 1584, 1584, 1584, 1584, 1584, 1584, 1584, 1584, 1584, 1584, 1585, 1586, 1589, 1593, 1599, 1605, 1613, 1622, 1632, 1644, 1657, 1670, 1683, 1697, 1710, 1724, 1739, 1753, 1768, 1783, 1798, 1813, 1829, 1845, 1861, 1878, 1895, 1912, 1929, 1947, 1965, 1983, 2002, 2021, 2041, 2061, 2081, 2102, 2123, 2145, 2167, 2193, 2221, 2252, 2286, 2324, 2365, 2410, 2460, 2514, 2573, 2638, 2710, 2789, 2876, 2972, 3080, 3199, 3333, 3484, 3655, 3849, 4073, 4331, 4634, 4994, 5427, 5955, 6617, 7468],
  half: [5676, 6434, 5704, 5168, 4761, 4446, 4199, 4005, 3853, 3734, 3645, 3581, 3539, 3504, 3468, 3451, 3451, 3451, 3451, 3451, 3451, 3451, 3451, 3451, 3451, 3451, 3451, 3452, 3457, 3465, 3476, 3490, 3507, 3528, 3553, 3581, 3610, 3639, 3669, 3700, 3731, 3763, 3795, 3828, 3861, 3895, 3930, 3964, 4000, 4037, 4074, 4112, 4150, 4189, 4229, 4270, 4312, 4353, 4397, 4441, 4486, 4532, 4578, 4626, 4675, 4725, 4778, 4837, 4902, 4974, 5053, 5139, 5234, 5339, 5454, 5580, 5717, 5869, 6036, 6221, 6426, 6654, 6908, 7191, 7510, 7872, 8282, 8754, 9299, 9937, 10691, 11596, 12697, 14074, 15830, 18154],
  marathon: [11900, 14242, 12689, 11523, 10621, 9910, 9342, 8883, 8512, 8211, 7970, 7780, 7616, 7474, 7368, 7293, 7249, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7235, 7236, 7250, 7283, 7334, 7395, 7458, 7522, 7586, 7652, 7719, 7787, 7856, 7927, 7999, 8072, 8147, 8223, 8300, 8379, 8459, 8541, 8624, 8710, 8796, 8885, 8975, 9068, 9162, 9258, 9356, 9456, 9559, 9663, 9770, 9880, 9992, 10112, 10244, 10391, 10551, 10730, 10924, 11139, 11374, 11634, 11917, 12232, 12576, 12959, 13381, 13852, 14375, 14964, 15623, 16372, 17222, 18201, 19329, 20654, 22214, 24093, 26376, 29232, 32871, 37702],
};

// Female Road Age Standards in Seconds 2025
const FEMALE: WmaSexTable = {
  minAge: 5, maxAge: 100,
  openSec: { k5: 834, k10: 1726, half: 3772, marathon: 7796 },
  k5: [1208, 1155, 1108, 1067, 1031, 999, 970, 945, 922, 902, 884, 867, 850, 838, 834, 834, 834, 834, 834, 834, 834, 834, 834, 835, 836, 837, 839, 842, 845, 848, 852, 856, 861, 866, 872, 878, 885, 892, 900, 909, 919, 929, 939, 949, 960, 971, 982, 993, 1005, 1017, 1029, 1041, 1054, 1067, 1081, 1094, 1108, 1123, 1138, 1153, 1169, 1185, 1202, 1219, 1236, 1254, 1273, 1292, 1312, 1332, 1353, 1375, 1397, 1421, 1448, 1479, 1512, 1550, 1591, 1637, 1689, 1747, 1811, 1884, 1967, 2061, 2169, 2294, 2439, 2610, 2814, 3061, 3366, 3752, 4253, 4929],
  k10: [2520, 2403, 2302, 2215, 2138, 2071, 2013, 1962, 1917, 1878, 1844, 1813, 1783, 1758, 1740, 1729, 1726, 1726, 1726, 1726, 1726, 1726, 1726, 1726, 1728, 1729, 1732, 1736, 1740, 1745, 1751, 1758, 1765, 1774, 1783, 1794, 1805, 1817, 1831, 1845, 1860, 1877, 1895, 1914, 1935, 1956, 1979, 2002, 2025, 2049, 2073, 2098, 2124, 2150, 2177, 2205, 2233, 2262, 2292, 2323, 2354, 2387, 2420, 2454, 2489, 2526, 2563, 2601, 2641, 2681, 2724, 2769, 2819, 2874, 2936, 3004, 3080, 3164, 3257, 3361, 3478, 3608, 3755, 3920, 4109, 4325, 4573, 4863, 5203, 5609, 6101, 6706, 7469, 8457, 9790, 12172],
  half: [6204, 5826, 5509, 5239, 5007, 4808, 4636, 4486, 4356, 4243, 4145, 4056, 3971, 3897, 3841, 3802, 3780, 3772, 3772, 3772, 3772, 3772, 3772, 3773, 3775, 3780, 3786, 3794, 3804, 3816, 3830, 3845, 3863, 3883, 3905, 3929, 3955, 3984, 4015, 4049, 4085, 4124, 4166, 4211, 4259, 4309, 4361, 4414, 4468, 4523, 4580, 4638, 4699, 4760, 4823, 4887, 4954, 5022, 5092, 5164, 5239, 5315, 5394, 5475, 5559, 5644, 5733, 5825, 5920, 6017, 6118, 6225, 6345, 6479, 6627, 6792, 6976, 7181, 7409, 7665, 7954, 8279, 8647, 9069, 9552, 10110, 10765, 11535, 12457, 13578, 14974, 16742, 19060, 22241, 26828, 34043],
  marathon: [14424, 13272, 12353, 11605, 10991, 10481, 10058, 9704, 9410, 9165, 8966, 8790, 8621, 8458, 8302, 8161, 8046, 7954, 7884, 7835, 7805, 7796, 7796, 7798, 7802, 7809, 7819, 7833, 7849, 7869, 7891, 7917, 7946, 7979, 8015, 8054, 8096, 8143, 8193, 8247, 8306, 8368, 8435, 8506, 8583, 8664, 8751, 8843, 8940, 9045, 9156, 9273, 9396, 9524, 9653, 9788, 9926, 10067, 10214, 10363, 10518, 10678, 10841, 11011, 11185, 11366, 11553, 11745, 11944, 12157, 12394, 12658, 12948, 13272, 13629, 14029, 14475, 14969, 15527, 16151, 16860, 17666, 18584, 19647, 20878, 22332, 24062, 26144, 28715, 31938, 36126, 41757, 49688, 61775, 82236, 124736],
};

/** One-line attribution for UI captions. */
export const WMA_ATTRIBUTION = 'WMA/USATF 2025 road standards';

/**
 * The open-class standard for a distance and sex, seconds. This is the
 * world-best-level time the WMA open standard is calibrated to (e.g. male
 * 5K = 769s = 12:49, male marathon = 7235s = 2:00:35, both ~current road
 * WRs). Returns null when sex is unknown — no demographic guess. Used as
 * the "fastest possible" anchor on placement scale bars.
 */
export function openStandardSec(
  distance: WmaDistanceKey,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): number | null {
  if (sex !== 'male' && sex !== 'female') return null;
  return (sex === 'male' ? MALE : FEMALE).openSec[distance];
}

export interface AgeGradeResult {
  /** Age grade as a percentage, 1 decimal (e.g. 71.3). */
  gradePct: number;
  /** The age/sex standard time the performance was graded against, seconds. */
  ageStandardSec: number;
  /** Open-class standard for the distance and sex, seconds. */
  openStandardSec: number;
  /** Published interpretation band, or null below 60%. */
  bandLabel: 'World class' | 'National class' | 'Regional class' | 'Local class' | null;
}

function bandFor(gradePct: number): AgeGradeResult['bandLabel'] {
  if (gradePct >= 90) return 'World class';
  if (gradePct >= 80) return 'National class';
  if (gradePct >= 70) return 'Regional class';
  if (gradePct >= 60) return 'Local class';
  return null;
}

/**
 * Age-grade a road performance. Returns null when sex is unknown ('prefer
 * not to say' must not be graded against a guessed table), age is unknown,
 * or the time is unusable. Ages outside the published 5-100 range clamp.
 */
export function ageGrade(
  distance: WmaDistanceKey,
  timeSec: number | null | undefined,
  age: number | null | undefined,
  sex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): AgeGradeResult | null {
  if (timeSec == null || !isFinite(timeSec) || timeSec <= 0) return null;
  if (sex !== 'male' && sex !== 'female') return null;
  if (age == null || !isFinite(age) || age <= 0) return null;
  const t = sex === 'male' ? MALE : FEMALE;
  const a = Math.min(t.maxAge, Math.max(t.minAge, Math.round(age)));
  const ageStandardSec = t[distance][a - t.minAge];
  const gradePct = Math.round((ageStandardSec / timeSec) * 1000) / 10;
  return {
    gradePct,
    ageStandardSec,
    openStandardSec: t.openSec[distance],
    bandLabel: bandFor(gradePct),
  };
}
