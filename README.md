# GMCrawler – Task 3 (ARES + dohledání webu firmy)

Tento repozitář obsahuje aplikaci pro import IČO do dávky (`SearchBatch`), načtení základních údajů firem z ARES a krok automatického dohledání pravděpodobného oficiálního webu.

## Stack

- Backend: Node.js + TypeScript + Express + Prisma
- Frontend: React + TypeScript + Vite
- DB: PostgreSQL

## 1) Backend setup

```bash
cd backend
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

Backend poběží na `http://localhost:3001`.

### Konfigurace ARES

- `ARES_API_BASE_URL` – base URL veřejného ARES API (default: `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest`)
- `ARES_TIMEOUT_MS` – timeout pro 1 request v ms (default: `10000`)
- `ARES_REQUEST_DELAY_MS` – zpoždění mezi requesty při dávkovém zpracování v ms (default: `200`)

### Konfigurace dohledávání webu

- `SEARCH_PROVIDER` – `mock` (default) nebo `serpapi`
- `SERPAPI_API_KEY` – API klíč pro SerpAPI (pokud chybí, použije se mock provider)
- `SEARCH_TIMEOUT_MS` – timeout pro 1 search request v ms (default: `15000`)
- `WEBSITE_SEARCH_MAX_QUERIES` – max počet dotazů na firmu (default: `6`)
- `WEBSITE_SEARCH_MAX_CANDIDATES` – max počet uložených kandidátů na firmu (default: `20`)

## 2) Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Frontend poběží na `http://localhost:5173`.

## API endpointy

- `POST /api/search-batches` – vytvoření dávky
- `POST /api/search-batches/:id/import` – import CSV/XLSX do dávky (multipart, pole `file`)
- `POST /api/search-batches/:id/start` – spuštění zpracování dávky (ARES lookup pro firmy ve stavu `pending`)
- `POST /api/companies/:id/reload-ares` – ruční opětovné načtení ARES dat jedné firmy
- `POST /api/companies/:id/find-website` – dohledání webu jedné firmy
- `POST /api/search-batches/:id/find-websites` – dohledání webů pro firmy ve stavu `finding_web`
- `PATCH /api/companies/:id/website` – ruční nastavení webu firmy
- `POST /api/companies/:id/score-contacts` – vyhodnocení relevance kontaktů pro jednu firmu
- `POST /api/search-batches/:id/score-contacts` – vyhodnocení relevance kontaktů pro všechny firmy v dávce
- `GET /api/companies/:id/contact-scores` – vrácení scoring výsledků kontaktů firmy
- `GET /api/search-batches` – seznam dávek
- `GET /api/search-batches/:id` – detail dávky (firmy + kandidátní weby + logy)
- `DELETE /api/search-batches/:id` – smazání dávky


## Contact scoring

- Scoring používá `SearchBatch.targetRole` jako cílovou roli.
- Při opakovaném spuštění se vždy nejdříve smažou předchozí záznamy v `ContactScore` pro firmu a následně se vytvoří nové (bez nekontrolovaných duplicit).
- Nejlepší kontakt se vybírá podle priority: nejvyšší score, osobní kontakt před obecným, kontakt s e-mailem před samotným telefonem, osoba s pozicí před osobou bez pozice, zdroj z oficiálního webu před jiným zdrojem.
- Každý krok scoringu se zapisuje do `ProcessingLog` včetně detailů (`targetRole`, `personId`, `contactId`, `score`, `category`, `reasons`).
