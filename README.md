# GMCrawler – základ projektu (Task 1)

Tento repozitář obsahuje první verzi aplikace pro import IČO do dávky (`SearchBatch`) a zobrazení výsledků.

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
- `GET /api/search-batches` – seznam dávek
- `GET /api/search-batches/:id` – detail dávky (včetně firem a import logu)
- `DELETE /api/search-batches/:id` – smazání dávky

## Poznámky k importu

- podporované formáty: CSV a XLSX,
- hledané názvy sloupce: `ico`, `ičo`, `ic`, `ič`, `company_ico`,
- IČO je normalizováno na 8 číslic (mezery odstraněny, kratší hodnoty doplněny nulami zleva),
- nevalidní/duplicitní řádky se zaznamenají do `ImportLog`,
- validní a unikátní IČO se uloží jako `Company`.
