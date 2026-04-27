const DEFAULT_ARES_API_BASE_URL = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest';
const DEFAULT_ARES_TIMEOUT_MS = 10000;

export type NormalizedAresData = {
  companyName: string | null;
  legalForm: string | null;
  addressText: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  registrationStatus: string | null;
  createdDate: Date | null;
  dataBoxId: string | null;
  statutoryPersons: unknown[] | null;
  rawJson: unknown;
};

export class AresError extends Error {
  public readonly code: string;
  public readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = clean(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function normalizeAresData(payload: unknown): NormalizedAresData {
  if (!payload || typeof payload !== 'object') {
    throw new AresError('unexpected_format', 'Neočekávaný formát odpovědi z ARES', payload);
  }

  const data = payload as Record<string, unknown>;
  const sidlo = (data.sidlo as Record<string, unknown> | undefined) ?? {};
  const pravniForma = (data.pravniForma as Record<string, unknown> | undefined) ?? {};

  const addressText = firstNonEmpty(
    sidlo.textovaAdresa,
    sidlo.adresaText,
    sidlo.radekAdresy,
    sidlo.nazevObce
  );

  const statutoryPersonsRaw = Array.isArray(data.statutarniOrgan) ? data.statutarniOrgan : null;

  return {
    companyName: firstNonEmpty(data.obchodniJmeno, data.nazev),
    legalForm: firstNonEmpty(pravniForma.nazev, data.pravniFormaText),
    addressText,
    city: firstNonEmpty(sidlo.nazevObce, sidlo.obec),
    postalCode: firstNonEmpty(sidlo.psc),
    country: firstNonEmpty(sidlo.nazevStatu, sidlo.stat),
    registrationStatus: firstNonEmpty(data.stavSubjektu, data.stav),
    createdDate: parseDate(firstNonEmpty(data.datumVzniku, data.datumZapisu)),
    dataBoxId: firstNonEmpty(data.datovaSchranka, data.idDatoveSchranky),
    statutoryPersons: statutoryPersonsRaw,
    rawJson: payload
  };
}

export class AresService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = process.env.ARES_API_BASE_URL ?? DEFAULT_ARES_API_BASE_URL;
    this.timeoutMs = Number(process.env.ARES_TIMEOUT_MS ?? DEFAULT_ARES_TIMEOUT_MS);
  }

  async loadByIco(ico: string): Promise<NormalizedAresData> {
    if (!/^\d{8}$/.test(ico)) {
      throw new AresError('invalid_ico', 'Neplatné IČO', { ico });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/ekonomicke-subjekty/${ico}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AresError('timeout', 'ARES timeout', { timeoutMs: this.timeoutMs });
      }

      throw new AresError('ares_unavailable', 'ARES API je nedostupné', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    clearTimeout(timeout);

    if (response.status === 404) {
      throw new AresError('not_found', 'ARES nevrátil záznam pro IČO', { ico });
    }

    if (!response.ok) {
      throw new AresError('ares_unavailable', 'ARES API je nedostupné', {
        status: response.status,
        statusText: response.statusText
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AresError('unexpected_format', 'Neočekávaný formát odpovědi z ARES');
    }

    return normalizeAresData(payload);
  }
}

export async function waitAresDelay(): Promise<void> {
  const delayMs = Number(process.env.ARES_REQUEST_DELAY_MS ?? 200);

  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
