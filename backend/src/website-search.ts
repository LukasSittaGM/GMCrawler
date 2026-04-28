import { Prisma, SearchResultType } from '@prisma/client';
import { prisma } from './prisma.js';
import { config } from './config.js';

export interface WebSearchProvider {
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  source: string;
  rank: number;
}

export interface WebSearchOptions {
  maxResults?: number;
  language?: string;
  country?: string;
  timeoutMs?: number;
}

const DEFAULT_MAX_RESULTS = config.searchMaxResults;
const DEFAULT_TIMEOUT_MS = config.searchTimeoutMs;
const MAX_QUERIES_PER_COMPANY = config.maxSearchQueriesPerCompany;
const RATE_LIMIT_MS = config.searchRateLimitMs;
const MAX_RETRIES = config.searchRetryCount;

const REGISTRY_DOMAINS = new Set([
  'justice.cz',
  'ares.gov.cz',
  'firmy.cz',
  'rejstrik-firem.kurzy.cz',
  'rejstriky.finance.cz',
  'hlidacstatu.cz'
]);

const SOCIAL_DOMAINS = new Set([
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'youtube.com'
]);

class MockSearchProvider implements WebSearchProvider {
  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const company = query.split('"').filter(Boolean)[0]?.trim() ?? 'Firma';
    const slug = company
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/(^-|-$)/g, '') || 'firma';

    const results: WebSearchResult[] = [
      {
        title: `${company} | Oficiální web`,
        url: `https://www.${slug}.cz`,
        snippet: `${company} - kontakt, služby a informace o společnosti. IČO 12345678`,
        source: 'mock',
        rank: 1
      },
      {
        title: `${company} | Kontakty`,
        url: `https://www.${slug}.cz/kontakt`,
        snippet: `Kontakty na společnost ${company}, vedení a tým.`,
        source: 'mock',
        rank: 2
      },
      {
        title: `${company} - firmy.cz`,
        url: `https://www.firmy.cz/detail/${slug}`,
        snippet: `${company} katalogový profil firmy.`,
        source: 'mock',
        rank: 3
      },
      {
        title: `${company} na LinkedIn`,
        url: `https://www.linkedin.com/company/${slug}`,
        snippet: `${company} firemní profil`,
        source: 'mock',
        rank: 4
      }
    ];

    return results.slice(0, options?.maxResults ?? DEFAULT_MAX_RESULTS);
  }
}

class SerpApiSearchProvider implements WebSearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const params = new URLSearchParams({
      q: query,
      engine: 'google',
      api_key: this.apiKey,
      gl: options?.country ?? config.searchCountry,
      hl: options?.language ?? config.searchLanguage,
      num: String(options?.maxResults ?? DEFAULT_MAX_RESULTS)
    });

    try {
      const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`SerpAPI request failed (${response.status})`);
      }

      const payload = (await response.json()) as { organic_results?: Array<Record<string, unknown>> };
      const organic = Array.isArray(payload.organic_results) ? payload.organic_results : [];

      return organic
        .map((item, index) => ({
          title: typeof item.title === 'string' ? item.title : '',
          url: typeof item.link === 'string' ? item.link : '',
          snippet: typeof item.snippet === 'string' ? item.snippet : '',
          source: 'serpapi',
          rank: Number(item.position) || index + 1
        }))
        .filter((item) => Boolean(item.url));
    } finally {
      clearTimeout(timeout);
    }
  }
}

class BingWebSearchProvider implements WebSearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const params = new URLSearchParams({
      q: query,
      count: String(options?.maxResults ?? DEFAULT_MAX_RESULTS),
      mkt: `${(options?.language ?? config.searchLanguage)}-${(options?.country ?? config.searchCountry).toUpperCase()}`
    });

    try {
      const response = await fetch(`https://api.bing.microsoft.com/v7.0/search?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          'Ocp-Apim-Subscription-Key': this.apiKey
        }
      });
      if (!response.ok) {
        throw new Error(`Bing request failed (${response.status})`);
      }
      const payload = (await response.json()) as { webPages?: { value?: Array<Record<string, unknown>> } };
      const values = payload.webPages?.value ?? [];

      return values
        .map((item, index) => ({
          title: typeof item.name === 'string' ? item.name : '',
          url: typeof item.url === 'string' ? item.url : '',
          snippet: typeof item.snippet === 'string' ? item.snippet : '',
          source: 'bing',
          rank: index + 1
        }))
        .filter((item) => Boolean(item.url));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWebSearchProvider(): WebSearchProvider {
  const provider = config.searchProvider.toLowerCase();
  if (provider === 'serpapi' && config.searchApiKey) {
    return new SerpApiSearchProvider(config.searchApiKey);
  }
  if (provider === 'bing' && config.searchApiKey) {
    return new BingWebSearchProvider(config.searchApiKey);
  }
  return new MockSearchProvider();
}

function normalizeText(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    const pathname = parsed.pathname.replace(/\/$/, '') || '/';
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function isDomainInSet(domain: string, set: Set<string>): boolean {
  for (const item of set) {
    if (domain === item || domain.endsWith(`.${item}`)) {
      return true;
    }
  }
  return false;
}

function classifyResultType(url: string, domain: string, snippet: string, title: string): SearchResultType {
  const merged = normalizeText(`${url} ${snippet} ${title}`);

  if (/\.pdf($|\?)/i.test(url)) {
    return 'pdf_candidate';
  }
  if (isDomainInSet(domain, REGISTRY_DOMAINS)) {
    return 'registry';
  }
  if (isDomainInSet(domain, SOCIAL_DOMAINS)) {
    return 'social';
  }
  if (/kontakt|kontakty|contact/.test(merged)) {
    return 'contact_page_candidate';
  }
  if (/jednatel|reditel|ceo|vedeni|team|tym|management/.test(merged)) {
    return 'person_candidate';
  }
  return 'official_website_candidate';
}

function companyTokens(companyName: string | null): string[] {
  if (!companyName) return [];
  return normalizeText(companyName)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
    .slice(0, 8);
}

function scoreSearchResult(input: {
  companyName: string | null;
  ico: string;
  targetRole?: string | null;
  normalizedTargetRole?: string | null;
  result: WebSearchResult;
  normalizedDomain: string;
  resultType: SearchResultType;
}): number {
  const merged = normalizeText(`${input.result.title} ${input.result.snippet ?? ''}`);
  const url = normalizeText(input.result.url);
  let score = 25;

  if (companyTokens(input.companyName).some((token) => merged.includes(token))) {
    score += 20;
  }
  if (merged.includes(input.ico)) {
    score += 20;
  }

  for (const role of [input.targetRole, input.normalizedTargetRole]) {
    if (role && normalizeText(role).length > 1 && merged.includes(normalizeText(role))) {
      score += 12;
      break;
    }
  }

  if (/\/kontakt|\/kontakty|\/team|\/vedeni/.test(url)) {
    score += 12;
  }

  if (input.resultType === 'official_website_candidate') {
    score += 10;
  }
  if (input.resultType === 'registry') {
    score -= 35;
  }
  if (input.resultType === 'social') {
    score -= 20;
  }

  if (input.result.rank <= 3) {
    score += 10;
  } else {
    score += Math.max(0, 10 - input.result.rank);
  }

  if (input.normalizedDomain.endsWith('.cz')) {
    score += 4;
  }

  return Math.max(0, Math.min(100, score));
}

export function buildCompanySearchQueries(input: {
  companyName: string | null;
  ico: string;
  targetRole?: string | null;
  normalizedTargetRole?: string | null;
  statutoryPersonsJson?: Prisma.JsonValue | null;
}): string[] {
  const name = input.companyName?.trim();
  if (!name) return [];

  const queries = [
    `"${name}" "${input.ico}"`,
    `"${name}" oficiální web`,
    `"${name}" kontakt`,
    `"${name}" IČO ${input.ico}`,
    `"${name}" kontakt email telefon`,
    `"${name}" vedení kontakt`,
    `"${name}" management kontakt`,
    `"${name}" tým kontakt`
  ];

  const roleQueries = new Set<string>();
  for (const role of [input.targetRole, input.normalizedTargetRole]) {
    if (!role?.trim()) continue;
    roleQueries.add(`"${name}" "${role}" kontakt`);
    roleQueries.add(`"${name}" "${role}" email`);
    roleQueries.add(`"${name}" "${role}" LinkedIn`);
  }

  for (const query of roleQueries) {
    queries.push(query);
  }

  const statutory = Array.isArray(input.statutoryPersonsJson) ? input.statutoryPersonsJson : [];
  for (const person of statutory.slice(0, 3)) {
    const personName = typeof person === 'object' && person && 'name' in person
      ? String((person as Record<string, unknown>).name ?? '').trim()
      : '';
    if (!personName) continue;
    queries.push(`"${personName}" "${name}"`);
    queries.push(`"${personName}" "${name}" email`);
    queries.push(`"${personName}" "${name}" kontakt`);
  }

  return [...new Set(queries)].slice(0, MAX_QUERIES_PER_COMPANY);
}

async function runProviderWithRetry(provider: WebSearchProvider, query: string): Promise<WebSearchResult[]> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= MAX_RETRIES) {
    try {
      return await provider.search(query, {
        maxResults: config.searchMaxResults,
        country: config.searchCountry,
        language: config.searchLanguage,
        timeoutMs: config.searchTimeoutMs
      });
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        throw error;
      }
      await sleep(Math.min(3000, RATE_LIMIT_MS * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Search provider error');
}

async function createProcessingLog(input: {
  batchId: string;
  companyId: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detailJson?: unknown;
}): Promise<void> {
  await prisma.processingLog.create({
    data: {
      batchId: input.batchId,
      companyId: input.companyId,
      step: 'web_search',
      status: input.status,
      message: input.message,
      detailJson: (input.detailJson ?? undefined) as Prisma.InputJsonValue | undefined
    }
  });
}

export async function runWebSearchForCompany(companyId: string): Promise<{ savedCount: number; totalResults: number }> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { batch: { select: { targetRole: true, normalizedTargetRole: true } } }
  });
  if (!company) {
    throw new Error('Firma nebyla nalezena');
  }

  const provider = createWebSearchProvider();
  const providerName = config.searchProvider;
  const queries = buildCompanySearchQueries({
    companyName: company.companyName,
    ico: company.ico,
    targetRole: company.batch.targetRole,
    normalizedTargetRole: company.batch.normalizedTargetRole,
    statutoryPersonsJson: company.statutoryPersonsJson
  });

  await createProcessingLog({
    batchId: company.batchId,
    companyId: company.id,
    status: 'info',
    message: 'Starting web search',
    detailJson: { provider: providerName, queryCount: queries.length }
  });

  if (queries.length === 0) {
    return { savedCount: 0, totalResults: 0 };
  }

  let savedCount = 0;
  let totalResults = 0;
  const dedupWithinRun = new Set<string>();

  for (const query of queries) {
    let results: WebSearchResult[] = [];
    try {
      results = await runProviderWithRetry(provider, query);
    } catch (error) {
      await createProcessingLog({
        batchId: company.batchId,
        companyId: company.id,
        status: 'error',
        message: 'Web search failed',
        detailJson: {
          query,
          provider: providerName,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      continue;
    }

    totalResults += results.length;
    await createProcessingLog({
      batchId: company.batchId,
      companyId: company.id,
      status: 'info',
      message: 'Search query executed',
      detailJson: { query, provider: providerName, resultCount: results.length }
    });

    for (const result of results.slice(0, config.searchMaxResults)) {
      const normalizedDomain = normalizeDomain(result.url);
      const normalizedUrl = normalizeUrl(result.url);
      if (!normalizedDomain || !normalizedUrl) {
        continue;
      }

      const dedupKey = `${query}::${normalizedUrl}`;
      if (dedupWithinRun.has(dedupKey) || dedupWithinRun.has(`domain::${normalizedDomain}`)) {
        await createProcessingLog({
          batchId: company.batchId,
          companyId: company.id,
          status: 'info',
          message: 'Search result skipped as duplicate',
          detailJson: { query, url: result.url }
        });
        continue;
      }

      const resultType = classifyResultType(result.url, normalizedDomain, result.snippet ?? '', result.title);
      const confidenceScore = scoreSearchResult({
        companyName: company.companyName,
        ico: company.ico,
        targetRole: company.batch.targetRole,
        normalizedTargetRole: company.batch.normalizedTargetRole,
        result,
        normalizedDomain,
        resultType
      });

      const upserted = await prisma.searchResult.upsert({
        where: {
          companyId_query_normalizedUrl: {
            companyId: company.id,
            query,
            normalizedUrl
          }
        },
        create: {
          companyId: company.id,
          batchId: company.batchId,
          query,
          title: result.title,
          url: result.url,
          normalizedUrl,
          normalizedDomain,
          snippet: result.snippet ?? null,
          provider: result.source,
          rank: result.rank,
          resultType,
          confidenceScore,
          isProcessed: false
        },
        update: {
          title: result.title,
          url: result.url,
          snippet: result.snippet ?? null,
          provider: result.source,
          rank: result.rank,
          resultType,
          confidenceScore,
          normalizedDomain
        }
      });

      savedCount += upserted ? 1 : 0;
      dedupWithinRun.add(dedupKey);
      dedupWithinRun.add(`domain::${normalizedDomain}`);

      await createProcessingLog({
        batchId: company.batchId,
        companyId: company.id,
        status: 'success',
        message: 'Search result saved',
        detailJson: {
          query,
          url: result.url,
          provider: result.source,
          confidenceScore,
          resultType
        }
      });
    }

    if (RATE_LIMIT_MS > 0) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  await createProcessingLog({
    batchId: company.batchId,
    companyId: company.id,
    status: 'success',
    message: 'Web search completed',
    detailJson: { provider: providerName, totalResults, savedCount }
  });

  return { savedCount, totalResults };
}

export async function selectOfficialWebsiteFromSearch(companyId: string): Promise<{ selected: boolean; score?: number }> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new Error('Firma nebyla nalezena');
  }

  const topResults = await prisma.searchResult.findMany({
    where: { companyId },
    orderBy: [{ confidenceScore: 'desc' }, { rank: 'asc' }],
    take: 20
  });

  await prisma.companyWebsite.deleteMany({ where: { companyId } });

  if (topResults.length > 0) {
    await prisma.companyWebsite.createMany({
      data: topResults.map((item) => ({
        companyId,
        url: item.url,
        normalizedDomain: item.normalizedDomain,
        title: item.title,
        snippet: item.snippet,
        source: 'search',
        rank: item.rank,
        confidenceScore: item.confidenceScore,
        isOfficialCandidate: item.resultType === 'official_website_candidate' || item.resultType === 'contact_page_candidate',
        isSelected: false,
        reason: `type:${item.resultType}`
      }))
    });
  }

  const best = topResults.find((item) => item.resultType !== 'registry' && item.resultType !== 'social');
  if (!best || best.confidenceScore < 45) {
    await prisma.company.update({
      where: { id: companyId },
      data: { websiteUrl: null, websiteDomain: null, websiteConfidenceScore: null, websiteFoundAt: null, status: 'no_results' }
    });
    return { selected: false, score: best?.confidenceScore };
  }

  await prisma.companyWebsite.updateMany({ where: { companyId, url: best.url }, data: { isSelected: true } });
  await prisma.company.update({
    where: { id: companyId },
    data: {
      websiteUrl: best.url,
      websiteDomain: best.normalizedDomain,
      websiteConfidenceScore: best.confidenceScore,
      websiteFoundAt: new Date(),
      status: 'crawling',
      errorMessage: null
    }
  });

  return { selected: true, score: best.confidenceScore };
}

export async function findWebsiteForCompany(companyId: string): Promise<{ selected: boolean; score?: number }> {
  await runWebSearchForCompany(companyId);
  return selectOfficialWebsiteFromSearch(companyId);
}

export async function runWebSearchForBatch(batchId: string): Promise<{ processed: number; savedCount: number }> {
  const companies = await prisma.company.findMany({ where: { batchId }, orderBy: { createdAt: 'asc' } });
  let savedCount = 0;
  for (const company of companies) {
    try {
      const result = await runWebSearchForCompany(company.id);
      savedCount += result.savedCount;
    } catch {
      // company-level error is logged by runWebSearchForCompany
    }
  }
  return { processed: companies.length, savedCount };
}

export function normalizeWebsiteUrl(input: string): { url: string; domain: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    const normalized = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
    return { url: normalized, domain: url.hostname.toLowerCase().replace(/^www\./, '') };
  } catch {
    return null;
  }
}
