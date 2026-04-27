const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret === 'dev-secret') {
  throw new Error('SESSION_SECRET must be set and must not use the default "dev-secret" value.');
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL,
  aresApiUrl: process.env.ARES_API_URL ?? process.env.ARES_API_BASE_URL ?? 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest',
  searchProvider: (process.env.SEARCH_PROVIDER ?? 'mock').toLowerCase(),
  searchApiKey: process.env.SEARCH_API_KEY ?? process.env.SERPAPI_API_KEY ?? '',
  searchTimeoutMs: toInt(process.env.SEARCH_TIMEOUT_MS, 15000),
  maxCompaniesPerBatch: toInt(process.env.MAX_COMPANIES_PER_BATCH, 500),
  crawlMaxPagesPerCompany: toInt(process.env.CRAWL_MAX_PAGES_PER_COMPANY ?? process.env.CRAWLER_MAX_PAGES, 30),
  crawlMaxDepth: toInt(process.env.CRAWL_MAX_DEPTH ?? process.env.CRAWLER_MAX_DEPTH, 2),
  crawlTimeoutMs: toInt(process.env.CRAWL_TIMEOUT_MS ?? process.env.CRAWLER_TIMEOUT_MS, 15000),
  crawlMaxHtmlSizeMb: toInt(process.env.CRAWL_MAX_HTML_SIZE_MB, 5),
  maxPageTextLength: toInt(process.env.MAX_PAGE_TEXT_LENGTH, 100000),
  maxSearchQueriesPerCompany: toInt(process.env.MAX_SEARCH_QUERIES_PER_COMPANY ?? process.env.WEBSITE_SEARCH_MAX_QUERIES, 6),
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
  sessionSecret
} as const;

export type BatchStep =
  | 'import'
  | 'ares'
  | 'website_search'
  | 'crawling'
  | 'extraction'
  | 'scoring'
  | 'review'
  | 'done'
  | 'error';
