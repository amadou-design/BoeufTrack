// BoeufTrack API - Backend Express
// Fix SIGTERM Railway : healthcheck /health, PORT dynamique, graceful shutdown
// TODO PROD : remplacer le store en mémoire par Postgres (Railway -> Add Database -> Postgres)

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const { randomUUID } = require('crypto');

// --- Env check ---
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY env var missing');
  process.exit(1);
}

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// CORS ouvert pour l'app web. En prod, restreindre à ton domaine dashboard.
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Log minimal
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============================================================
// IN-MEMORY STORE (MVP)
// ============================================================
const boeufs = new Map();   // id -> boeuf
const weighings = [];        // { id, boeufId, weight, date, ... }

// Seed : un bœuf de démo pour que le dashboard ne soit pas vide au premier lancement
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
  version: '1.0.0',
  endpoints: ['/health', '/analyze', '/boeufs', '/weighings', '/boeufs/:id/gmq']
}));

// ============================================================
// /analyze : photos -> estimation poids via Claude Vision (multi-angles)
// Accepte :
//  - nouveau format : images: [{ data, mediaType, angle }]  (recommandé, 1 à 6 photos)
//  - legacy       : imageBase64 + mediaType (1 seule photo)
// ============================================================
const MAX_IMAGES = 6;
const stripPrefix = (b64) => (b64 && b64.includes(',')) ? b64.split(',')[1] : b64;

app.post('/analyze', async (req, res) => {
  try {
    const { images, imageBase64, mediaType = 'image/jpeg', breed, context } = req.body;

    // Normaliser en tableau
    let imgs = [];
    if (Array.isArray(images) && images.length > 0) {
      imgs = images.slice(0, MAX_IMAGES).map(it => ({
        data: stripPrefix(it.data || it.imageBase64 || ''),
        mediaType: it.mediaType || 'image/jpeg',
        angle: it.angle || null
      })).filter(it => it.data);
    } else if (imageBase64) {
      imgs = [{ data: stripPrefix(imageBase64), mediaType, angle: null }];
    }

    if (imgs.length === 0) return res.status(400).json({ error: 'images[] ou imageBase64 requis' });

    const multi = imgs.length > 1;
    const angleList = imgs.map((im, i) => `Photo ${i + 1}${im.angle ? ` (${im.angle})` : ''}`).join(', ');

    const prompt = `Tu es expert en élevage bovin, spécialisé dans l'estimation de poids vif par analyse visuelle de bovins africains (zébu Azawak, N'Dama, Gudali, Goudali, Maure, métis, etc.).

${multi
  ? `IMPORTANT : Tu reçois ${imgs.length} photos du MÊME animal prises sous différents angles (${angleList}). Tu dois les ANALYSER ENSEMBLE pour produire UNE SEULE estimation consolidée, pas une estimation par photo.

Méthode :
- Identifie les angles réellement disponibles (profil, face, dos, vue dorsale, etc.).
- Pour chaque angle, extrais les indices pertinents (longueur du corps, tour de poitrine apparent, largeur du bassin, profondeur de flanc, état des côtes, musculature de l'arrière-train).
- Croise les estimations issues de chaque angle pour réduire l'incertitude.
- Si les photos se contredisent, prends l'estimation la plus étayée et explique pourquoi dans "observations".
- La confiance doit refléter la QUALITÉ ET LA COMPLÉMENTARITÉ des angles : plusieurs angles exploitables => confiance plus élevée ; photos redondantes ou floues => confiance basse.
- La fourchette min-max doit se resserrer quand tu as plusieurs angles utiles.`
  : `Tu ne reçois qu'une seule photo. Signale dans "limitations" les angles manquants (profil, face, dos, bassin) qui permettraient une estimation plus précise.`}

Tu dois estimer :
1. Poids vif estimé en kg (valeur centrale, entier)
2. Fourchette min-max (kg, entiers)
3. Confiance (0-100) — cohérente avec le nombre et la qualité des angles disponibles
4. BCS / Note d'état corporel (échelle 1 à 5, incréments de 0.5)
5. Race probable (si non indiquée)
6. Observations : morphologie, conformation, points d'attention éleveur, synthèse multi-angles
7. Limitations : ce qui manque ou ce qui a entravé l'estimation

${breed ? `Race indiquée par l'éleveur : ${breed}` : 'Race : non précisée, à déduire de la morphologie'}
${context ? `Contexte : ${context}` : ''}

RÉPONDS UNIQUEMENT EN JSON VALIDE, sans texte avant ou après, sans balises markdown :
{
  "weightKg": <number>,
  "rangeMin": <number>,
  "rangeMax": <number>,
  "confidence": <number>,
  "bcs": <number>,
  "breedGuess": "<string or null>",
  "observations": "<string>",
  "limitations": "<string>",
  "anglesUsed": <number>
}`;

    // Construire le contenu multimodal : chaque image précédée d'un label d'angle
    const content = [];
    imgs.forEach((im, i) => {
      content.push({ type: 'text', text: `Photo ${i + 1}${im.angle ? ` — angle : ${im.angle}` : ''} :` });
      content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
    });
    content.push({ type: 'text', text: prompt });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      messages: [{ role: 'user', content }]
    });

    const text = msg.content.map(c => c.text || '').join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Pas de JSON dans la réponse Claude: ' + text.slice(0, 200));
    const result = JSON.parse(jsonMatch[0]);

    res.json({ success: true, imagesAnalyzed: imgs.length, ...result });
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
  // Supprime les pesées associées
  for (let i = weighings.length - 1; i >= 0; i--) {
    if (weighings[i].boeufId === req.params.id) weighings.splice(i, 1);
  }
  res.json({ ok: true });
});

// ============================================================
// /weighings : pesées
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
// GMQ : Gain Moyen Quotidien
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
  // GMQ intermédiaires (par intervalle)
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
  console.log(`BoeufTrack API running on port ${PORT}`);
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
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
