# Testovací CSV data

Složka `test-data/` obsahuje pouze textové CSV soubory pro rychlé otestování importu IČO.

## Soubory

- `sample-icos.csv` – validní IČO pro běžný import.
- `sample-icos-invalid.csv` – nevalidní hodnoty pro ověření validačních chyb importu.
- `sample-icos-duplicates.csv` – kombinace duplicitních/normalizovaných hodnot IČO.

## Jak použít

1. Spusť backend a frontend.
2. Ve frontendu vytvoř novou dávku.
3. Nahraj jeden ze souborů ze složky `test-data/` přes import formulář.
4. Zkontroluj výsledek importu:
   - validní záznamy se založí jako firmy v dávce,
   - nevalidní záznamy se zobrazí v import logu,
   - duplicity se nezaloží znovu.

> Poznámka: Do repozitáře se nesmí přidávat binární testovací soubory (`.xlsx`, `.xls`, `.zip`, `.db`, `.sqlite`) ani generované runtime výstupy.
