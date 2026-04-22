// BoeufTrack - Analytics précision IA vs carcasse
//
// Méthode : on n'a pas de poids vif bascule, on a le poids carcasse après ressuyage.
// On reconstruit un "poids vif de référence" = carcasse / rendement(race, override),
// puis on compare à l'estimation IA faite avant l'abattage.
//
// Métriques :
//   - biais (mean signed error %) : + = IA surestime, - = IA sous-estime
//   - MAE (mean absolute error %) : magnitude moyenne de l'écart
//   - RMSE (root mean square error %) : pénalise les grands écarts
//   - rendement implicite moyen : carcasse / IA (fenêtre de ce que "pense" ton IA)
//   - distribution : histogramme des erreurs en buckets de 5 %
//   - anomalies : abattages dont |error| > 20 % ou dont rendement implicite hors [0.40, 0.65]

'use strict';

const { yieldFor, PLAUSIBLE_YIELD_MIN, PLAUSIBLE_YIELD_MAX, breedKeyFrom } = require('./yields');

function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function round(n, d = 2) { return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }

// Cherche la pesée IA la plus récente AVANT ou le jour même de l'abattage.
// Tolérance max : 90 jours (au-delà, la comparaison n'a plus de sens physiologique).
const MATCH_WINDOW_DAYS = 90;

function findClosestAiWeighing(weighings, boeufId, slaughterDate) {
  const sd = new Date(slaughterDate).getTime();
  if (!Number.isFinite(sd)) return null;
  const candidates = weighings
    .filter(w => w.boeufId === boeufId && w.weight != null)
    .map(w => ({ w, ts: new Date(w.date).getTime() }))
    .filter(x => Number.isFinite(x.ts) && x.ts <= sd)
    .filter(x => (sd - x.ts) / 86400000 <= MATCH_WINDOW_DAYS)
    .sort((a, b) => b.ts - a.ts);
  return candidates.length ? candidates[0].w : null;
}

// Enrichit un slaughter avec les calculs dérivés.
function enrich(slaughter, { boeufs, weighings }) {
  const boeuf = boeufs.get ? boeufs.get(slaughter.boeufId) : null;
  const breedString = boeuf?.breed || null;
  const { value: yAppl, source: ySource } = yieldFor(breedString, slaughter.yieldOverride);

  const reconstructed = slaughter.carcassWeight / yAppl;

  const aiW = findClosestAiWeighing(weighings, slaughter.boeufId, slaughter.date);
  const aiWeight = aiW ? aiW.weight : null;

  let errorPct = null;
  let implicitYield = null;
  let daysBetween = null;
  if (aiWeight != null && aiWeight > 0) {
    errorPct = ((aiWeight - reconstructed) / reconstructed) * 100;
    implicitYield = slaughter.carcassWeight / aiWeight;
    daysBetween = (new Date(slaughter.date) - new Date(aiW.date)) / 86400000;
  }

  return {
    ...slaughter,
    boeufName: boeuf?.name || null,
    boeufBreed: breedString,
    breedKey: breedKeyFrom(breedString),
    yieldApplied: round(yAppl, 3),
    yieldSource: ySource,
    reconstructedLiveWeight: round(reconstructed, 1),
    aiWeight: aiWeight != null ? round(aiWeight, 1) : null,
    aiWeighingId: aiW?.id || null,
    aiWeighingDate: aiW?.date || null,
    daysBetween: daysBetween != null ? round(daysBetween, 1) : null,
    errorPct: errorPct != null ? round(errorPct, 2) : null,
    implicitYield: implicitYield != null ? round(implicitYield, 3) : null,
    isAnomaly: errorPct != null && Math.abs(errorPct) > 20,
    isYieldSuspect: implicitYield != null && (implicitYield < PLAUSIBLE_YIELD_MIN || implicitYield > PLAUSIBLE_YIELD_MAX),
    isMatchable: aiWeight != null
  };
}

// Histogramme bucket 5 % centré sur 0 : ..., [-10,-5), [-5,0), [0,5), [5,10), ...
// Les valeurs > 30 % ou < -30 % vont dans les buckets extrêmes.
function histogram(errors) {
  const BUCKETS = [
    { key: '<-30', min: -Infinity, max: -30 },
    { key: '-30/-25', min: -30, max: -25 },
    { key: '-25/-20', min: -25, max: -20 },
    { key: '-20/-15', min: -20, max: -15 },
    { key: '-15/-10', min: -15, max: -10 },
    { key: '-10/-5',  min: -10, max: -5 },
    { key: '-5/0',    min: -5,  max: 0 },
    { key: '0/5',     min: 0,   max: 5 },
    { key: '5/10',    min: 5,   max: 10 },
    { key: '10/15',   min: 10,  max: 15 },
    { key: '15/20',   min: 15,  max: 20 },
    { key: '20/25',   min: 20,  max: 25 },
    { key: '25/30',   min: 25,  max: 30 },
    { key: '>30',     min: 30,  max: Infinity }
  ];
  const counts = BUCKETS.map(b => ({ ...b, count: 0 }));
  for (const e of errors) {
    for (const b of counts) {
      if (e >= b.min && e < b.max) { b.count++; break; }
    }
  }
  return counts.map(b => ({ bucket: b.key, count: b.count }));
}

function precision(enrichedSlaughters) {
  const matched = enrichedSlaughters.filter(s => s.isMatchable);
  const errors = matched.map(s => s.errorPct);
  const absErrors = errors.map(Math.abs);
  const sqErrors = errors.map(e => e * e);
  const implicits = matched.map(s => s.implicitYield).filter(x => x != null);

  return {
    n: matched.length,
    nTotal: enrichedSlaughters.length,
    nUnmatched: enrichedSlaughters.length - matched.length,
    bias: errors.length ? round(mean(errors), 2) : null,
    mae:  absErrors.length ? round(mean(absErrors), 2) : null,
    rmse: sqErrors.length ? round(Math.sqrt(mean(sqErrors)), 2) : null,
    meanImplicitYield: implicits.length ? round(mean(implicits), 3) : null,
    medianImplicitYield: implicits.length ? round([...implicits].sort((a,b)=>a-b)[Math.floor(implicits.length/2)], 3) : null,
    histogram: histogram(errors),
    anomalies: matched.filter(s => s.isAnomaly || s.isYieldSuspect).map(s => ({
      id: s.id,
      boeufId: s.boeufId,
      boeufName: s.boeufName,
      date: s.date,
      carcassWeight: s.carcassWeight,
      aiWeight: s.aiWeight,
      reconstructedLiveWeight: s.reconstructedLiveWeight,
      errorPct: s.errorPct,
      implicitYield: s.implicitYield,
      reason: s.isAnomaly && s.isYieldSuspect ? 'error_and_yield'
            : s.isAnomaly ? 'error_gt_20pct'
            : 'yield_out_of_range'
    }))
  };
}

// Évolution dans le temps : on regroupe les erreurs par mois pour voir si l'IA s'améliore/dégrade.
function timeline(enrichedSlaughters) {
  const matched = enrichedSlaughters.filter(s => s.isMatchable);
  const byMonth = new Map();
  for (const s of matched) {
    const d = new Date(s.date);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(s.errorPct);
  }
  const points = [];
  for (const [k, errs] of [...byMonth.entries()].sort()) {
    points.push({
      month: k,
      n: errs.length,
      bias: round(mean(errs), 2),
      mae: round(mean(errs.map(Math.abs)), 2)
    });
  }
  return points;
}

function yieldDistribution(enrichedSlaughters) {
  const matched = enrichedSlaughters.filter(s => s.isMatchable && s.implicitYield != null);
  // buckets de 0.02 entre 0.40 et 0.65
  const BUCKETS = [];
  for (let lo = 0.40; lo < 0.65; lo += 0.02) {
    BUCKETS.push({ key: `${lo.toFixed(2)}-${(lo + 0.02).toFixed(2)}`, min: lo, max: lo + 0.02, count: 0 });
  }
  BUCKETS.unshift({ key: '<0.40', min: -Infinity, max: 0.40, count: 0 });
  BUCKETS.push({ key: '>0.65', min: 0.65, max: Infinity, count: 0 });

  const byBreed = new Map();
  for (const s of matched) {
    for (const b of BUCKETS) {
      if (s.implicitYield >= b.min && s.implicitYield < b.max) { b.count++; break; }
    }
    const bk = s.breedKey || 'default';
    if (!byBreed.has(bk)) byBreed.set(bk, []);
    byBreed.get(bk).push(s.implicitYield);
  }

  const perBreed = {};
  for (const [k, vals] of byBreed) {
    perBreed[k] = {
      n: vals.length,
      mean: round(mean(vals), 3),
      min: round(Math.min(...vals), 3),
      max: round(Math.max(...vals), 3)
    };
  }

  return {
    n: matched.length,
    histogram: BUCKETS.map(b => ({ bucket: b.key, count: b.count })),
    perBreed
  };
}

module.exports = {
  enrich,
  precision,
  timeline,
  yieldDistribution,
  findClosestAiWeighing
};
