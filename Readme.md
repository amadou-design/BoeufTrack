# BoeufTrack API v2

Pipeline hybride (computer vision + LLM) pour estimer le poids vif des bovins africains à partir d'une ou plusieurs photos.

## Architecture

```
POST /analyze
      │
      ▼
┌──────────────────────────────────────────────────────────┐
│  lib/pipeline.js                                         │
│                                                          │
│  Niveau 1 — Preflight par image (parallèle)              │
│    • lib/imageQuality.js : dimensions, luminosité,       │
│      variance Laplacien → qualityScore 0..1              │
│    • lib/detector.js : HF DETR (facebook/detr-resnet-50) │
│      → bbox, score, angle probable (optionnel)           │
│                                                          │
│  Niveau 2 — Analyse morphologique (parallèle)            │
│    • lib/llmAnalyzer.js : Claude Vision ancrée race      │
│      (breedInfo.minKg / maxKg / meanKg)                  │
│      + signaux qualité + bbox → JSON strict              │
│                                                          │
│  Niveau 3 — Fusion                                       │
│    • lib/fusion.js : filtre non-bovin, MAD outliers,     │
│      moyenne pondérée (qualité × confiance),             │
│      range resserré par √n, narrative                    │
└──────────────────────────────────────────────────────────┘
```

Points clés :

- **Vrai pixel-work** : `sharp` calcule netteté et exposition sur les pixels, pas via le LLM.
- **Vraie détection** : DETR ResNet-50 (HuggingFace) fournit une bbox avec score. Dégradation gracieuse si `HF_API_KEY` absent — le pipeline continue sans.
- **Ancrage race** : le LLM reçoit la fourchette biologique de la race (Azawak, N'Dama, Gudali, Maure, Kouri, métis, default). Un clamp dur empêche toute dérive hors plage race ± 50 %.
- **Fusion robuste** : MAD (3.5σ) pour rejeter les outliers, moyenne pondérée par qualité × confiance LLM, `range` resserré par √n, bonus angles distincts.
- **Extensible** : pour brancher plus tard un modèle entraîné (YOLO + regressor ONNX), remplacer `lib/llmAnalyzer.js::analyzeImage()` — même signature, même shape retour.

## Variables d'environnement Railway

| Var | Requis | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Oui | Claude Vision |
| `HF_API_KEY` | Recommandé | Active la détection DETR (free tier HF suffit). Sans cette clé, le pipeline tourne quand même — juste sans détection externe. |
| `PORT` | Non | Railway l'injecte. Ne PAS la forcer. |

## Déploiement Railway

1. Push `server.js`, `package.json`, `nixpacks.toml`, et le dossier `lib/` (6 fichiers) sur GitHub.
2. Dans Settings → Variables :
   - `ANTHROPIC_API_KEY=sk-ant-...`
   - `HF_API_KEY=hf_...` (optionnel mais recommandé — https://huggingface.co/settings/tokens, rôle `read`)
3. Healthcheck Path : `/health` — Timeout : 100
4. Custom Start Command : laisser vide (`npm start`).
5. Redéployer. Les logs doivent afficher :

```
BoeufTrack API v2 running on port <port>
  detection: enabled (HF DETR)    # ou: disabled (no HF_API_KEY)
```

## Endpoints

| Méthode | Path | Description |
|---|---|---|
| GET | `/health` | Healthcheck |
| GET | `/` | Info API + état détection |
| POST | `/analyze` | Pipeline CV + LLM → poids estimé |
| GET | `/boeufs` | Liste |
| POST | `/boeufs` | Créer |
| GET | `/boeufs/:id` | Détail |
| PATCH | `/boeufs/:id` | Update |
| DELETE | `/boeufs/:id` | Delete + cascade pesées |
| GET | `/weighings?boeufId=...` | Pesées |
| POST | `/weighings` | Ajouter pesée |
| DELETE | `/weighings/:id` | Supprimer pesée |
| GET | `/boeufs/:id/gmq` | Gain Moyen Quotidien |

## Format `/analyze`

```json
POST /analyze
{
  "images": [
    { "data": "...", "mediaType": "image/jpeg", "angle": "Profil gauche" },
    { "data": "...", "mediaType": "image/jpeg", "angle": "Arrière" }
  ],
  "breed": "Zébu Azawak",
  "context": "Bœuf de 18 mois, embouche 45j"
}
```

- `images` : 1 à 6 photos. `data` = base64 pur OU data URL.
- `angle` (optionnel) : indication de l'éleveur.
- Legacy `{ "imageBase64": "...", "mediaType": "..." }` toujours accepté (1 photo).

### Réponse

```json
{
  "success": true,

  "weightKg": 385,
  "rangeMin": 370,
  "rangeMax": 405,
  "confidence": 82,
  "confidenceBand": "high",
  "bcs": 3.5,
  "breedGuess": "Zébu Azawak",

  "narrative": "Estimation basée sur 3 images / 2 angles distincts · confiance élevée (82%) · ancrage Zébu Azawak.",

  "breedResolved": {
    "key": "azawak",
    "label": "Zébu Azawak",
    "minKg": 250, "maxKg": 500, "meanKg": 380,
    "source": "user"
  },

  "imagesProvided": 4,
  "imagesUsed": 3,
  "imagesUnreadable": 0,
  "rejectedCount": 1,
  "perImage": [
    { "index": 0, "used": true,  "reason": "kept",     "weightKg": 388, "confidence": 80, "angle": "profil_droit", "qualityScore": 0.71 },
    { "index": 1, "used": true,  "reason": "kept",     "weightKg": 382, "confidence": 78, "angle": "arriere",      "qualityScore": 0.66 },
    { "index": 2, "used": false, "reason": "outlier",  "weightKg": 510, "confidence": 45, "angle": "face",         "qualityScore": 0.31 },
    { "index": 3, "used": true,  "reason": "kept",     "weightKg": 386, "confidence": 82, "angle": "profil_droit", "qualityScore": 0.74 }
  ],
  "outliers": [{ "index": 2, "weightKg": 510, "deltaFromMedian": 125, "reason": "outlier" }],

  "detectionAvailable": true,
  "llmFailures": [],
  "processingMs": 7420,

  "observations": "...narrative (compat historique)",
  "limitations": "...",
  "anglesUsed": 2,
  "imagesAnalyzed": 3
}
```

### confidenceBand

- `low` : < 55 %
- `medium` : 55–74 %
- `high` : ≥ 75 %

Le score est plafonné à 95 % tant qu'un modèle entraîné n'est pas branché — l'estimation LLM seule ne peut pas égaler une bascule vraie.

## ⚠️ Persistance

Le store actuel est en mémoire (`Map` + `Array`). Tout disparaît à chaque redeploy.

**Pour la prod** : Railway → Add Database → Postgres, puis remplacer les `Map`/`Array` par `pg` avec des tables `boeufs` et `weighings`.

## Test local

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export HF_API_KEY=hf_...   # optionnel
npm install
npm start
curl http://localhost:8080/health
```

## Évolution vers un modèle entraîné

Le pipeline est découpé pour permettre de remplacer le LLM par un vrai regressor :

1. Entraîner un YOLO v8 (segmentation bovin) + un CNN/MLP pour régresser le poids à partir de features morphologiques (surface segmentée, ratios corporels, BCS visuel).
2. Exporter en ONNX.
3. Remplacer `lib/llmAnalyzer.js::analyzeImage` par un module local qui renvoie le même shape : `{ hasBovine, weightKg, rangeMin, rangeMax, confidence, bcs, ... }`.
4. Le reste du pipeline (quality, fusion, route) reste inchangé.
