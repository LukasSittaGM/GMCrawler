# GMCrawler MVP (Task 9)

## Požadavky
- Docker + Docker Compose (doporučeno)
- nebo Node.js 22+, npm, PostgreSQL 16+

## Instalace (lokálně bez Dockeru)
```bash
cp .env.example .env
cd backend && npm install
cd ../frontend && npm install
```

## Nastavení `.env`
Vyplň minimálně:
- `DATABASE_URL`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD_HASH` (SHA-256 hash hesla)
- `SESSION_SECRET`

Příklad hashování hesla:
```bash
node -e "console.log(require('crypto').createHash('sha256').update('mojeheslo').digest('hex'))"
```

## Migrace DB
```bash
cd backend
npx prisma generate
npx prisma migrate dev
```

## Spuštění backendu
```bash
cd backend
npm run dev
```

## Spuštění frontendu
```bash
cd frontend
npm run dev
```

## Spuštění workeru
Aktuální MVP používá interní queue worker v backend procesu.
Samostatná `worker` služba je připravena v `docker-compose.yml` pro budoucí oddělení.

## Spuštění přes Docker Compose
```bash
docker compose up --build
```

Po spuštění otevři:
- Frontend UI: `http://localhost:5173`
- Backend API healthcheck: `http://localhost:3001/api/health`

## Produkční běh (základ)
- Nastav `NODE_ENV=production`
- Nastav silný `SESSION_SECRET`
- Použij produkční `DATABASE_URL`
- Spusť `docker compose up -d --build`

## Základní workflow
1. Přihlas se admin účtem (`/api/login`, UI login stránka).
2. Založ dávku a importuj IČO.
3. V detailu dávky klikni **Spustit zpracování** (`run-full-pipeline`).
4. Sleduj progress (`currentStep`, `progressPercent`) a logy.
5. Použij **Retry failed** / retry endpointy.
6. Validuj finální kontakt a exportuj CSV/XLSX.

## API novinky (MVP provoz)
- `POST /api/search-batches/:id/run-full-pipeline`
- `POST /api/companies/:id/retry`
- `POST /api/search-batches/:id/retry-failed`
- `POST /api/search-batches/:id/reset-and-run`
- `GET /api/dashboard`
- `GET /api/search-batches/:id/logs`
- `GET /api/companies/:id/logs`
- `GET /api/health`
- `POST /api/login`, `POST /api/logout`

## Testovací data
Složka `test-data/` obsahuje:
- `sample-icos.csv`
- `sample-icos-invalid.csv`
- `sample-icos-duplicates.xlsx`

Použití je popsané v `test-data/README.md`.
