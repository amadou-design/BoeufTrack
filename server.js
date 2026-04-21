// BoeufTrack API - Backend Express
// v2 : pipeline hybride CV + LLM pour l'estimation poids (voir ./lib/pipeline.js)
// TODO PROD : remplacer le store en mémoire par Postgres (Railway -> Add Database -> Postgres)

'use strict';

const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const { analyzePhotos, MAX_IMAGES } = require('./lib/pipeline');

// --- Env check ---
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY env var missing');
  process.exit(1);
}
if (!process.env.HF_API_KEY) {
  console.warn('[warn] HF_API_KEY absent : détection externe désactivée (dégradation gracieuse).');
}

const app = express();

// CORS ouvert pour l'app web. En prod, restreindre à ton domaine dashboard.
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Log minimal
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============================================================
// IN-MEMORY STORE (MVP)
// ============================================================
const boeufs = new Map();
const weighings = [];

(function seed() {
  const id = 'demo-boeuf-001';
  boeufs.set(id, {
    id,
    name: 'Démo - Zébu 01',
    breed: 'Zébu Azawak',
    birthDate: '2024-06-15',
    tagId: 'AZ-001',
    notes: 'Bœuf de démonstration. Supprime-le une fois tes vrais animaux ajoutés.',
    photoDataUrl: null,
    createdAt: new Date().toISOString()
  });
  const base = new Date();
  base.setDate(base.getDate() - 60);
  for (let i = 0; i < 4; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i * 20);
    weighings.push({
      id: randomUUID(),
      boeufId: id,
      weight: 280 + i * 22 + Math.round(Math.random() * 4),
      date: d.toISOString(),
      confidence: 75,
      bcs: 3,
      observations: 'Pesée de démonstration',
      photoDataUrl: null
    });
  }
})();

// ============================================================
// ROUTES SYSTÈME
// ============================================================
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.status(200).json({
  name: 'BoeufTrack API',
  version: '2.0.0',
  pipeline: 'hybrid-cv',
  detection: Boolean(process.env.HF_API_KEY),
  endpoints: ['/health', '/analyze', '/boeufs', '/weighings', '/boeufs/:id/gmq']
}));

// ============================================================
// /analyze : pipeline hybride
// Accepte :
//  - nouveau format : images: [{ data, mediaType, angle }]  (recommandé, 1 à 6 photos)
//  - legacy       : imageBase64 + mediaType (1 seule photo)
// ============================================================
app.post('/analyze', async (req, res) => {
  try {
    const { images, imageBase64, mediaType = 'image/jpeg', breed, context } = req.body || {};

    let imgs = [];
    if (Array.isArray(images) && images.length > 0) {
      imgs = images.slice(0, MAX_IMAGES).map(it => ({
        data: it.data || it.imageBase64 || '',
        mediaType: it.mediaType || 'image/jpeg',
        angle: it.angle || null
      })).filter(it => it.data);
    } else if (imageBase64) {
      imgs = [{ data: imageBase64, mediaType, angle: null }];
    }

    if (imgs.length === 0) return res.status(400).json({ success: false, error: 'images[] ou imageBase64 requis' });

    const result = await analyzePhotos({ images: imgs, breed, context });

    // Réponse : on garde les champs historiques pour compat dashboard,
    // et on ajoute les nouveaux champs exposés par la fusion.
    res.json({
      success: true,
      // compat
      imagesAnalyzed: result.imagesUsed,
      observations: result.narrative,
      limitations: result.limitations,
      anglesUsed: result.anglesDistinct,
      // estimation
      weightKg: result.weightKg,
      rangeMin: result.rangeMin,
      rangeMax: result.rangeMax,
      confidence: result.confidence,
      confidenceBand: result.confidenceBand,
      bcs: result.bcs,
      breedGuess: result.breedGuess,
      // diagnostics pipeline
      narrative: result.narrative,
      breedResolved: result.breedResolved,
      imagesProvided: result.imagesProvided,
      imagesUsed: result.imagesUsed,
      imagesUnreadable: result.imagesUnreadable,
      rejectedCount: result.rejectedCount,
      perImage: result.perImage,
      outliers: result.outliers,
      detectionAvailable: result.detectionAvailable,
      llmFailures: result.llmFailures,
      processingMs: result.processingMs
    });
  } catch (err) {
    console.error('[/analyze]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// /boeufs : CRUD
// ============================================================
app.post('/boeufs', (req, res) => {
  const { name, breed, birthDate, tagId, notes, photoDataUrl } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = randomUUID();
  const boeuf = {
    id, name,
    breed: breed || null,
    birthDate: birthDate || null,
    tagId: tagId || null,
    notes: notes || '',
    photoDataUrl: photoDataUrl || null,
    createdAt: new Date().toISOString()
  };
  boeufs.set(id, boeuf);
  res.status(201).json(boeuf);
});

app.get('/boeufs', (_req, res) => {
  res.json(Array.from(boeufs.values()).sort((a, b) => a.name.localeCompare(b.name)));
});

app.get('/boeufs/:id', (req, res) => {
  const b = boeufs.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  res.json(b);
});

app.patch('/boeufs/:id', (req, res) => {
  const b = boeufs.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  Object.assign(b, req.body, { id: b.id, createdAt: b.createdAt });
  boeufs.set(b.id, b);
  res.json(b);
});

app.delete('/boeufs/:id', (req, res) => {
  if (!boeufs.has(req.params.id)) return res.status(404).json({ error: 'not found' });
  boeufs.delete(req.params.id);
  for (let i = weighings.length - 1; i >= 0; i--) {
    if (weighings[i].boeufId === req.params.id) weighings.splice(i, 1);
  }
  res.json({ ok: true });
});

// ============================================================
// /weighings
// ============================================================
app.post('/weighings', (req, res) => {
  const { boeufId, weight, date, confidence, bcs, observations, photoDataUrl } = req.body;
  if (!boeufId || weight == null) return res.status(400).json({ error: 'boeufId + weight required' });
  if (!boeufs.has(boeufId)) return res.status(404).json({ error: 'boeuf not found' });
  const w = {
    id: randomUUID(),
    boeufId,
    weight: Number(weight),
    date: date || new Date().toISOString(),
    confidence: confidence ?? null,
    bcs: bcs ?? null,
    observations: observations || '',
    photoDataUrl: photoDataUrl || null
  };
  weighings.push(w);
  res.status(201).json(w);
});

app.get('/weighings', (req, res) => {
  const { boeufId } = req.query;
  let list = weighings.slice();
  if (boeufId) list = list.filter(w => w.boeufId === boeufId);
  list.sort((a, b) => new Date(a.date) - new Date(b.date));
  res.json(list);
});

app.delete('/weighings/:id', (req, res) => {
  const i = weighings.findIndex(w => w.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  weighings.splice(i, 1);
  res.json({ ok: true });
});

// ============================================================
// GMQ
// ============================================================
app.get('/boeufs/:id/gmq', (req, res) => {
  const list = weighings
    .filter(w => w.boeufId === req.params.id)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (list.length < 2) return res.json({ gmq: null, reason: 'need at least 2 weighings' });
  const first = list[0];
  const last = list[list.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  if (days <= 0) return res.json({ gmq: null, reason: 'invalid dates' });
  const gmq = (last.weight - first.weight) / days;
  const intervals = [];
  for (let i = 1; i < list.length; i++) {
    const d = (new Date(list[i].date) - new Date(list[i - 1].date)) / 86400000;
    intervals.push({
      from: list[i - 1].date,
      to: list[i].date,
      days: Number(d.toFixed(1)),
      gain: list[i].weight - list[i - 1].weight,
      gmq: d > 0 ? Number(((list[i].weight - list[i - 1].weight) / d).toFixed(3)) : null
    });
  }
  res.json({
    gmq: Number(gmq.toFixed(3)),
    days: Number(days.toFixed(1)),
    firstWeight: first.weight,
    lastWeight: last.weight,
    totalGain: last.weight - first.weight,
    weighings: list.length,
    intervals
  });
});

// ============================================================
// START + GRACEFUL SHUTDOWN
// ============================================================
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`BoeufTrack API v2 running on port ${PORT}`);
  console.log(`  detection: ${process.env.HF_API_KEY ? 'enabled (HF DETR)' : 'disabled (no HF_API_KEY)'}`);
});

const shutdown = (sig) => {
  console.log(`${sig} received - shutting down gracefully`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced exit after 10s');
    process.exit(1);
  }, 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { console.error('uncaughtException', err); });
process.on('unhandledRejection', (err) => { console.error('unhandledRejection', err); });
