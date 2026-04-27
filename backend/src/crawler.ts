import { prisma } from './prisma.js';

const DEFAULT_MAX_PAGES = Number(process.env.CRAWLER_MAX_PAGES ?? 30);
const DEFAULT_MAX_DEPTH = Number(process.env.CRAWLER_MAX_DEPTH ?? 2);
const DEFAULT_TIMEOUT_MS = Number(process.env.CRAWLER_TIMEOUT_MS ?? 15000);
const DEFAULT_MAX_HTML_BYTES = Number(process.env.CRAWLER_MAX_HTML_BYTES ?? 5 * 1024 * 1024);

const PRIORITY_KEYWORDS = [
  'kontakt', 'kontakty', 'contact', 'team', 'tym', 'tým', 'vedeni', 'vedení', 'management',
  'o-nas', 'o-nás', 'about', 'people', 'lide', 'lidé', 'kariera', 'kariéra'
];

const BLOCKED_SUBSTRINGS = ['mailto:', 'tel:', 'javascript:'];
const BLOCKED_SUFFIXES = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.css', '.js', '.zip', '.rar',
  '.mp4', '.mp3', '.avi', '.mov'
];

type CrawlQueueItem = {
  url: string;
  normalizedUrl: string;
  depth: number;
  source: 'website_root' | 'internal_link' | 'sitemap' | 'manual';
  discoveredFromUrl?: string;
};

function normalizeText(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeUrl(input: string): { url: string; normalizedUrl: string; domain: string } | null {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    url.hash = '';
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    const normalizedUrl = url.toString();

    return {
      url: normalizedUrl,
      normalizedUrl: normalizedUrl.toLowerCase(),
      domain: url.hostname.toLowerCase().replace(/^www\./, '')
    };
  } catch {
    return null;
  }
}

function hasSuspiciousQuery(url: URL): boolean {
  const raw = url.search ?? '';
  if (raw.length > 200) {
    return true;
  }

  const counter = new Map<string, number>();
  for (const [key] of url.searchParams.entries()) {
    counter.set(key, (counter.get(key) ?? 0) + 1);
    if ((counter.get(key) ?? 0) > 2) {
      return true;
    }
  }

  return false;
}

function shouldSkipUrl(rawUrl: string): string | null {
  const lowered = rawUrl.trim().toLowerCase();

  if (!lowered || lowered.startsWith('#')) {
    return 'fragment-only';
  }

  if (BLOCKED_SUBSTRINGS.some((part) => lowered.startsWith(part))) {
    return 'unsupported-protocol';
  }

  if (BLOCKED_SUFFIXES.some((suffix) => lowered.endsWith(suffix))) {
    return 'blocked-extension';
  }

  try {
    const parsed = new URL(rawUrl);
    if (hasSuspiciousQuery(parsed)) {
      return 'suspicious-query';
    }

    const pathname = parsed.pathname.toLowerCase();
    if (BLOCKED_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
      return 'blocked-extension';
    }
  } catch {
    return 'invalid-url';
  }

  return null;
}

function isPriorityUrl(url: string): boolean {
  const haystack = normalizeText(url);
  return PRIORITY_KEYWORDS.some((keyword) => haystack.includes(normalizeText(keyword)));
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');

  const text = withoutNoise
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRegex = /<a[^>]+href\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(hrefRegex)) {
    const href = match[1]?.trim();
    if (!href) {
      continue;
    }

    if (href.startsWith('#')) {
      continue;
    }

    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {
      continue;
    }
  }

  return links;
}

function parseFetchError(error: unknown): string {
  const asError = error instanceof Error ? error.message : String(error);
  const lowered = asError.toLowerCase();

  if (lowered.includes('aborted') || lowered.includes('timeout')) {
    return 'timeout';
  }
  if (lowered.includes('enotfound') || lowered.includes('dns')) {
    return 'dns_error';
  }

  return asError;
}

export async function crawlCompanyWebsite(companyId: string): Promise<{ fetchedPages: number; skippedPages: number; errorPages: number }> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  if (!company) {
    throw new Error('Firma nebyla nalezena');
  }

  if (!company.websiteUrl) {
    throw new Error('Firma nemá vyplněný websiteUrl');
  }

  const root = normalizeUrl(company.websiteUrl);
  if (!root) {
    throw new Error('Nevalidní URL webu firmy');
  }

  const batchId = company.batchId;
  const rootDomain = root.domain;

  await prisma.processingLog.create({
    data: {
      batchId,
      companyId,
      step: 'crawl',
      status: 'info',
      message: 'Starting company website crawl',
      detailJson: { url: root.url, maxPages: DEFAULT_MAX_PAGES, maxDepth: DEFAULT_MAX_DEPTH }
    }
  });

  await prisma.crawledPage.deleteMany({ where: { companyId } });

  const priorityQueue: CrawlQueueItem[] = [{
    url: root.url,
    normalizedUrl: root.normalizedUrl,
    depth: 0,
    source: 'website_root'
  }];
  const normalQueue: CrawlQueueItem[] = [];
  const seen = new Set<string>([root.normalizedUrl]);

  let fetchedPages = 0;
  let skippedPages = 0;
  let errorPages = 0;
  let processedPages = 0;

  while ((priorityQueue.length > 0 || normalQueue.length > 0) && processedPages < DEFAULT_MAX_PAGES) {
    const item = priorityQueue.shift() ?? normalQueue.shift();
    if (!item) {
      break;
    }

    const skipReason = shouldSkipUrl(item.url);
    if (skipReason) {
      skippedPages += 1;
      await prisma.crawledPage.create({
        data: {
          companyId,
          url: item.url,
          normalizedUrl: item.normalizedUrl,
          domain: rootDomain,
          depth: item.depth,
          source: item.source,
          crawlStatus: 'skipped',
          errorMessage: skipReason,
          discoveredFromUrl: item.discoveredFromUrl
        }
      });

      await prisma.processingLog.create({
        data: {
          batchId,
          companyId,
          step: 'crawl',
          status: 'info',
          message: 'Skipped non-html URL',
          detailJson: { url: item.url, depth: item.depth, reason: skipReason }
        }
      });
      processedPages += 1;
      continue;
    }

    const parsed = normalizeUrl(item.url);
    if (!parsed || parsed.domain !== rootDomain) {
      skippedPages += 1;
      await prisma.crawledPage.create({
        data: {
          companyId,
          url: item.url,
          normalizedUrl: item.normalizedUrl,
          domain: parsed?.domain ?? rootDomain,
          depth: item.depth,
          source: item.source,
          crawlStatus: 'skipped',
          errorMessage: 'external-domain',
          discoveredFromUrl: item.discoveredFromUrl
        }
      });

      await prisma.processingLog.create({
        data: {
          batchId,
          companyId,
          step: 'crawl',
          status: 'info',
          message: 'Skipped external domain',
          detailJson: { url: item.url, depth: item.depth, reason: 'external-domain' }
        }
      });
      processedPages += 1;
      continue;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(parsed.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'GMCrawlerBot/0.1 (+https://localhost)'
        }
      });

      const finalUrl = normalizeUrl(response.url);
      if (!finalUrl || finalUrl.domain !== rootDomain) {
        skippedPages += 1;
        await prisma.crawledPage.create({
          data: {
            companyId,
            url: parsed.url,
            normalizedUrl: parsed.normalizedUrl,
            domain: finalUrl?.domain ?? rootDomain,
            httpStatus: response.status,
            contentType: response.headers.get('content-type') ?? null,
            depth: item.depth,
            source: item.source,
            crawlStatus: 'skipped',
            errorMessage: 'redirected-external-domain',
            discoveredFromUrl: item.discoveredFromUrl
          }
        });
        processedPages += 1;
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const contentLength = Number(response.headers.get('content-length') ?? '0');
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

      if (!isHtml) {
        skippedPages += 1;
        await prisma.crawledPage.create({
          data: {
            companyId,
            url: finalUrl.url,
            normalizedUrl: finalUrl.normalizedUrl,
            domain: rootDomain,
            httpStatus: response.status,
            contentType: contentType || null,
            depth: item.depth,
            source: item.source,
            crawlStatus: 'skipped',
            errorMessage: 'non-html-response',
            discoveredFromUrl: item.discoveredFromUrl
          }
        });
        processedPages += 1;
        continue;
      }

      if (contentLength > DEFAULT_MAX_HTML_BYTES) {
        skippedPages += 1;
        await prisma.crawledPage.create({
          data: {
            companyId,
            url: finalUrl.url,
            normalizedUrl: finalUrl.normalizedUrl,
            domain: rootDomain,
            httpStatus: response.status,
            contentType: contentType || null,
            depth: item.depth,
            source: item.source,
            crawlStatus: 'skipped',
            errorMessage: 'response-too-large',
            discoveredFromUrl: item.discoveredFromUrl
          }
        });
        processedPages += 1;
        continue;
      }

      const htmlContent = await response.text();
      if (Buffer.byteLength(htmlContent, 'utf8') > DEFAULT_MAX_HTML_BYTES) {
        skippedPages += 1;
        await prisma.crawledPage.create({
          data: {
            companyId,
            url: finalUrl.url,
            normalizedUrl: finalUrl.normalizedUrl,
            domain: rootDomain,
            httpStatus: response.status,
            contentType: contentType || null,
            depth: item.depth,
            source: item.source,
            crawlStatus: 'skipped',
            errorMessage: 'response-too-large',
            discoveredFromUrl: item.discoveredFromUrl
          }
        });
        processedPages += 1;
        continue;
      }

      const title = extractTitle(htmlContent);
      const textContent = htmlToText(htmlContent);
      const internalLinks = extractLinks(htmlContent, finalUrl.url);

      if (!textContent) {
        skippedPages += 1;
        await prisma.crawledPage.create({
          data: {
            companyId,
            url: finalUrl.url,
            normalizedUrl: finalUrl.normalizedUrl,
            domain: rootDomain,
            title,
            htmlContent,
            textContent,
            httpStatus: response.status,
            contentType: contentType || null,
            depth: item.depth,
            source: item.source,
            crawlStatus: 'skipped',
            errorMessage: 'empty-text-content',
            discoveredFromUrl: item.discoveredFromUrl
          }
        });
        processedPages += 1;
        continue;
      }

      await prisma.crawledPage.create({
        data: {
          companyId,
          url: finalUrl.url,
          normalizedUrl: finalUrl.normalizedUrl,
          domain: rootDomain,
          title,
          htmlContent,
          textContent,
          httpStatus: response.status,
          contentType: contentType || null,
          depth: item.depth,
          source: item.source,
          crawlStatus: 'fetched',
          discoveredFromUrl: item.discoveredFromUrl
        }
      });
      fetchedPages += 1;
      processedPages += 1;

      let discoveredInternalCount = 0;
      for (const link of internalLinks) {
        const normalized = normalizeUrl(link);
        if (!normalized || normalized.domain !== rootDomain) {
          continue;
        }

        if (shouldSkipUrl(normalized.url)) {
          continue;
        }

        if (seen.has(normalized.normalizedUrl)) {
          continue;
        }

        if (item.depth + 1 > DEFAULT_MAX_DEPTH) {
          continue;
        }

        discoveredInternalCount += 1;
        seen.add(normalized.normalizedUrl);

        const nextItem: CrawlQueueItem = {
          url: normalized.url,
          normalizedUrl: normalized.normalizedUrl,
          depth: item.depth + 1,
          source: 'internal_link',
          discoveredFromUrl: finalUrl.url
        };

        if (isPriorityUrl(normalized.url)) {
          priorityQueue.push(nextItem);
        } else {
          normalQueue.push(nextItem);
        }
      }

      await prisma.processingLog.create({
        data: {
          batchId,
          companyId,
          step: 'crawl',
          status: 'info',
          message: 'Fetched page',
          detailJson: {
            url: finalUrl.url,
            httpStatus: response.status,
            contentType,
            depth: item.depth,
            internalLinksDiscovered: discoveredInternalCount,
            savedPagesCount: fetchedPages
          }
        }
      });
    } catch (error) {
      const errorMessage = parseFetchError(error);
      errorPages += 1;

      await prisma.crawledPage.create({
        data: {
          companyId,
          url: parsed.url,
          normalizedUrl: parsed.normalizedUrl,
          domain: rootDomain,
          depth: item.depth,
          source: item.source,
          crawlStatus: 'error',
          errorMessage,
          discoveredFromUrl: item.discoveredFromUrl
        }
      });
      processedPages += 1;

      await prisma.processingLog.create({
        data: {
          batchId,
          companyId,
          step: 'crawl',
          status: 'warning',
          message: 'Company crawl page failed',
          detailJson: {
            url: parsed.url,
            depth: item.depth,
            reason: errorMessage
          }
        }
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (processedPages >= DEFAULT_MAX_PAGES) {
    await prisma.processingLog.create({
      data: {
        batchId,
        companyId,
        step: 'crawl',
        status: 'warning',
        message: 'Crawl limit reached',
        detailJson: {
          processedPagesCount: processedPages,
          savedPagesCount: fetchedPages,
          maxPages: DEFAULT_MAX_PAGES
        }
      }
    });
  }

  await prisma.processingLog.create({
    data: {
      batchId,
      companyId,
      step: 'crawl',
      status: 'success',
      message: 'Company crawl completed',
      detailJson: {
        savedPagesCount: fetchedPages,
        skippedPagesCount: skippedPages,
        errorPagesCount: errorPages
      }
    }
  });

  return { fetchedPages, skippedPages, errorPages };
}
