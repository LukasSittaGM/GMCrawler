# GMCrawler – Task 2 (ARES integrace)

Tento repozitář obsahuje aplikaci pro import IČO do dávky (`SearchBatch`) a první krok zpracování: načtení základních údajů firem z ARES.

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

Nastavuje se v `backend/.env`:

- `ARES_API_BASE_URL` – base URL veřejného ARES API (default: `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest`)
- `ARES_TIMEOUT_MS` – timeout pro 1 request v ms (default: `10000`)
- `ARES_REQUEST_DELAY_MS` – zpoždění mezi requesty při dávkovém zpracování v ms (default: `200`)

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
- `GET /api/search-batches` – seznam dávek
- `GET /api/search-batches/:id` – detail dávky (firmy + import log + processing log)
- `DELETE /api/search-batches/:id` – smazání dávky

## Stavová logika

### Company.status

- `pending` → `loading_ares` → `finding_web` (úspěch)
- `pending` / `loading_ares` → `error` (chyba)

### SearchBatch.status

- při startu `processing`
- po dokončení:
  - `done` (alespoň jedna firma úspěšná, nebo nebylo co zpracovat),
  - `error` (pokud všechny zpracovávané firmy skončí chybou).

## Poznámky k importu

- podporované formáty: CSV a XLSX,
- hledané názvy sloupce: `ico`, `ičo`, `ic`, `ič`, `company_ico`,
- IČO je normalizováno na 8 číslic (mezery odstraněny, kratší hodnoty doplněny nulami zleva),
- nevalidní/duplicitní řádky se zaznamenají do `ImportLog`,
- validní a unikátní IČO se uloží jako `Company`.
