# Coach d'anglais — app web minimale (Mistral API + TypeScript)

Petite app de chat avec un coach d'anglais (niveau B2) propulsé par l'API Mistral
via le SDK TypeScript officiel [`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai).
Le coach travaille le vocabulaire, les phrasal verbs et les expressions, corrige
doucement vos fautes, et fait de la **répétition espacée** : chaque nouvel élément
appris est mémorisé côté serveur et ressort automatiquement pour révision
(J+1, J+3, J+7, J+14, J+30, J+90).

## Prérequis

- Node.js >= 20

## Installation

```bash
npm install
cp .env.example .env
# puis édite .env et colle ta clé :
# MISTRAL_API_KEY=ta_cle_mistral
```

Tu trouves ta clé sur [console.mistral.ai](https://console.mistral.ai) (section « API keys »).

## Lancer en local

```bash
npm run dev
# → ouvre http://localhost:3000
```

Pour un lancement « production » (build TypeScript puis exécution) :

```bash
npm start
```

Le port se règle via `PORT=8080 npm run dev`.

## Architecture

```
navigateur (public/)  ──POST /api/chat──▶  src/server.ts  ──▶  SDK @mistralai/mistralai  ──▶  API Mistral (mistral-small-latest)
                                              │
                                              ├── src/coach.ts   prompt système du coach + modèle
                                              └── src/memory.ts  data/learned.json : acquis + planning de révision
```

- `MISTRAL_API_KEY` n'est lue **que côté serveur** (via `dotenv`) et n'est jamais
  envoyée au navigateur. `.env` et `data/` sont gitignorés.
- `POST /api/chat` attend `{ "messages": [{ "role": "user"|"assistant", "content": "..." }] }`
  et renvoie `{ "reply", "saved", "reviewed", "stats" }`.
- `GET /api/stats` renvoie `{ "total", "due" }` (éléments appris / à réviser aujourd'hui).

## Comment fonctionne la mémorisation

Quand le coach enseigne un nouvel élément, il termine son message par une ligne
`LEARN: <kind> | <terme> | <définition> | <exemple>`. Le serveur l'extrait, la stocke
dans `data/learned.json`, et la masque avant d'afficher la réponse. Au début de chaque
session, les éléments « dus » sont injectés dans le prompt système pour être révisés
avec vous.
