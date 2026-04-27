import { prisma } from './prisma.js';
import { config } from './config.js';

const DEFAULT_SEARCH_TIMEOUT_MS = config.searchTimeoutMs;
const DEFAULT_MAX_QUERIES = config.maxSearchQueriesPerCompany;
const DEFAULT_MAX_CANDIDATES = 20;

const DOMAIN_BLOCKLIST = new Set([
  'justice.cz',
  'ares.gov.cz',
  'firmy.cz',
  'google.com',
  'seznam.cz',
  'facebook.com',
  'linkedin.com',
  'instagram.com',
  'mapy.cz',
  'hlidacstatu.cz',
  'kurzy.cz',
  'penize.cz',
  'detail.cz',
  'rejstriky.finance.cz'
]);

export type SearchOptions = {
  timeoutMs?: number;
  limit?: number;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  rank: number;
};

export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

class MockSearchProvider implements SearchProvider {
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const company = query.split('"').filter(Boolean)[0]?.trim() ?? 'Firma';
    const slug = company
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/(^-|-$)/g, '') || 'firma';

    const results: SearchResult[] = [
      {
        title: `${company} | Oficiální web`,
        url: `https://www.${slug}.cz`,
        snippet: `${company} - kontakt, služby a informace o společnosti.`,
        rank: 1
      },
      {
        title: `${company} - firmy.cz`,
        url: `https://www.firmy.cz/detail/${slug}`,
        snippet: `${company} katalogový profil firmy.`,
        rank: 2
      },
      {
        title: `${company} na LinkedIn`,
        url: `https://www.linkedin.com/company/${slug}`,
        snippet: `${company} firemní profil`,
        rank: 3
      }
    ];

    return results.slice(0, options?.limit ?? 10);
  }
}

class SerpApiSearchProvider implements SearchProvider {
  constructor(private readonly apiKey: string, private readonly timeoutMs: number) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? this.timeoutMs);

    const params = new URLSearchParams({
      q: query,
      engine: 'google',
      google_domain: 'google.com',
      gl: 'cz',
      hl: 'cs',
      num: String(options?.limit ?? 10),
      api_key: this.apiKey
    });

    let response: Response;
    try {
      response = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`SerpAPI request failed (${response.status})`);
    }

    const payload = (await response.json()) as { organic_results?: Array<Record<string, unknown>> };
    const organic = Array.isArray(payload.organic_results) ? payload.organic_results : [];

    return organic.map((item, index) => ({
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.link === 'string' ? item.link : '',
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
      rank: Number(item.position) || index + 1
    })).filter((item) => item.url);
  }
}

function normalizeDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function companyNameTokens(companyName: string | null): string[] {
  if (!companyName) {
    return [];
  }

  return normalizeText(companyName)
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 3)
    .slice(0, 6);
}

function isBlockedDomain(domain: string): boolean {
  for (const blocked of DOMAIN_BLOCKLIST) {
    if (domain === blocked || domain.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}

export function buildCompanySearchQueries(company: {
  companyName: string | null;
  ico: string;
  city: string | null;
},
maxQueries = DEFAULT_MAX_QUERIES): string[] {
  const name = company.companyName?.trim();
  if (!name) {
    return [];
  }

  const queries = [
    `"${name}" "${company.ico}"`,
    `"${name}" oficiální web`,
    `"${name}" kontakt`,
    `"${name}" IČO ${company.ico}`
  ];

  if (company.city?.trim()) {
    queries.push(`"${name}" "${company.city.trim()}"`);
    queries.push(`"${name}" "${company.city.trim()}" kontakt`);
  }

  return queries.slice(0, maxQueries);
}

export function createSearchProvider(): SearchProvider {
  const provider = config.searchProvider.trim().toLowerCase();
  const timeoutMs = config.searchTimeoutMs;

  if (provider === 'serpapi' && config.searchApiKey) {
    return new SerpApiSearchProvider(config.searchApiKey, timeoutMs);
  }

  return new MockSearchProvider();
}

type ScoredCandidate = {
  url: string;
  normalizedDomain: string;
  title: string;
  snippet: string;
  rank: number;
  confidenceScore: number;
  reason: string;
  isOfficialCandidate: boolean;
};

function scoreCandidate(input: {
  companyName: string | null;
  ico: string;
  city: string | null;
  result: SearchResult;
  normalizedDomain: string;
}): { score: number; reason: string; isOfficialCandidate: boolean } {
  let score = 20;
  const reasons: string[] = [];

  const mergedText = normalizeText(`${input.result.title} ${input.result.snippet}`);
  const domainText = normalizeText(input.normalizedDomain);
  const tokens = companyNameTokens(input.companyName);

  if (tokens.some((token) => mergedText.includes(token))) {
    score += 20;
    reasons.push('název firmy v titulku/snippetu');
  }

  if (tokens.some((token) => domainText.includes(token))) {
    score += 25;
    reasons.push('doména obsahuje název firmy');
  }

  if (mergedText.includes(input.ico)) {
    score += 20;
    reasons.push('obsahuje IČO');
  }

  if (input.city && mergedText.includes(normalizeText(input.city))) {
    score += 10;
    reasons.push('obsahuje město');
  }

  if (input.result.url.startsWith('https://')) {
    score += 5;
    reasons.push('HTTPS');
  }

  score += Math.max(0, 10 - Math.max(0, input.result.rank - 1) * 2);
  reasons.push(`pozice ${input.result.rank}`);

  if (isBlockedDomain(input.normalizedDomain)) {
    score -= 60;
    reasons.push('katalog/registr (penalizace)');
  }

  const clamped = Math.max(0, Math.min(100, score));
  return {
    score: clamped,
    reason: reasons.join(', '),
    isOfficialCandidate: clamped >= 40 && !isBlockedDomain(input.normalizedDomain)
  };
}

export async function findWebsiteForCompany(companyId: string): Promise<{ selected: boolean; score?: number }> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  if (!company) {
    throw new Error('Firma nebyla nalezena');
  }

  await prisma.company.update({
    where: { id: company.id },
    data: { status: 'finding_web', errorMessage: null }
  });

  const maxQueries = Number(process.env.WEBSITE_SEARCH_MAX_QUERIES ?? DEFAULT_MAX_QUERIES);
  const maxCandidates = Number(process.env.WEBSITE_SEARCH_MAX_CANDIDATES ?? DEFAULT_MAX_CANDIDATES);
  const timeoutMs = Number(process.env.SEARCH_TIMEOUT_MS ?? DEFAULT_SEARCH_TIMEOUT_MS);

  const provider = createSearchProvider();

  await prisma.processingLog.create({
    data: {
      batchId: company.batchId,
      companyId: company.id,
      step: 'website_search',
      status: 'info',
      message: 'Starting website search'
    }
  });

  try {
    const queries = buildCompanySearchQueries(company, maxQueries);
    if (queries.length === 0) {
      await prisma.company.update({
        where: { id: company.id },
        data: { status: 'no_results' }
      });
      return { selected: false };
    }

    const dedup = new Map<string, ScoredCandidate>();

    for (const query of queries) {
      const results = await provider.search(query, { timeoutMs, limit: 10 });

      await prisma.processingLog.create({
        data: {
          batchId: company.batchId,
          companyId: company.id,
          step: 'website_search',
          status: 'info',
          message: 'Search query executed',
          detailJson: { query, resultCount: results.length }
        }
      });

      for (const result of results) {
        const domain = normalizeDomain(result.url);
        if (!domain) {
          continue;
        }

        const key = `${domain}::${result.url.toLowerCase()}`;
        const scoring = scoreCandidate({
          companyName: company.companyName,
          ico: company.ico,
          city: company.city,
          result,
          normalizedDomain: domain
        });

        const candidate: ScoredCandidate = {
          url: result.url,
          normalizedDomain: domain,
          title: result.title,
          snippet: result.snippet,
          rank: result.rank,
          confidenceScore: scoring.score,
          reason: scoring.reason,
          isOfficialCandidate: scoring.isOfficialCandidate
        };

        const existing = dedup.get(key);
        if (!existing || existing.confidenceScore < candidate.confidenceScore) {
          dedup.set(key, candidate);
        }
      }
    }

    const topCandidates = [...dedup.values()]
      .sort((a, b) => b.confidenceScore - a.confidenceScore || a.rank - b.rank)
      .slice(0, maxCandidates);

    await prisma.companyWebsite.deleteMany({ where: { companyId: company.id } });

    if (topCandidates.length > 0) {
      await prisma.companyWebsite.createMany({
        data: topCandidates.map((candidate) => ({
          companyId: company.id,
          url: candidate.url,
          normalizedDomain: candidate.normalizedDomain,
          title: candidate.title || null,
          snippet: candidate.snippet || null,
          source: 'search',
          rank: candidate.rank,
          confidenceScore: candidate.confidenceScore,
          isOfficialCandidate: candidate.isOfficialCandidate,
          isSelected: false,
          reason: candidate.reason
        }))
      });

      for (const candidate of topCandidates) {
        await prisma.processingLog.create({
          data: {
            batchId: company.batchId,
            companyId: company.id,
            step: 'website_search',
            status: 'info',
            message: 'Website candidate saved',
            detailJson: {
              candidateUrl: candidate.url,
              score: candidate.confidenceScore,
              reason: candidate.reason
            }
          }
        });
      }
    }

    const best = topCandidates[0];
    if (!best || best.confidenceScore < 50) {
      await prisma.company.update({
        where: { id: company.id },
        data: {
          websiteUrl: null,
          websiteDomain: null,
          websiteConfidenceScore: null,
          websiteFoundAt: null,
          status: 'no_results'
        }
      });

      await prisma.processingLog.create({
        data: {
          batchId: company.batchId,
          companyId: company.id,
          step: 'website_search',
          status: 'warning',
          message: 'No reliable website found',
          detailJson: {
            candidateCount: topCandidates.length,
            topScore: best?.confidenceScore ?? null
          }
        }
      });

      return { selected: false, score: best?.confidenceScore };
    }

    await prisma.companyWebsite.updateMany({
      where: { companyId: company.id },
      data: { isSelected: false }
    });

    await prisma.companyWebsite.updateMany({
      where: { companyId: company.id, url: best.url },
      data: { isSelected: true }
    });

    await prisma.company.update({
      where: { id: company.id },
      data: {
        websiteUrl: best.url,
        websiteDomain: best.normalizedDomain,
        websiteConfidenceScore: best.confidenceScore,
        websiteFoundAt: new Date(),
        status: 'crawling',
        errorMessage: null
      }
    });

    await prisma.processingLog.create({
      data: {
        batchId: company.batchId,
        companyId: company.id,
        step: 'website_search',
        status: 'success',
        message: 'Selected official website',
        detailJson: {
          selectedUrl: best.url,
          score: best.confidenceScore,
          reason: best.reason
        }
      }
    });

    return { selected: true, score: best.confidenceScore };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Website search failed';
    await prisma.company.update({
      where: { id: company.id },
      data: {
        status: 'error',
        errorMessage: message
      }
    });

    await prisma.processingLog.create({
      data: {
        batchId: company.batchId,
        companyId: company.id,
        step: 'website_search',
        status: 'error',
        message: 'Website search failed',
        detailJson: {
          error: message
        }
      }
    });

    return { selected: false };
  }
}

export function normalizeWebsiteUrl(input: string): { url: string; domain: string } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    const normalized = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
    return {
      url: normalized,
      domain: url.hostname.toLowerCase().replace(/^www\./, '')
    };
  } catch {
    return null;
  }
}
