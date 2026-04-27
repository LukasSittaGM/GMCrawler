import { prisma } from './prisma.js';
import { config, type BatchStep } from './config.js';
import { waitAresDelay } from './ares.js';
import { AresService } from './ares.js';
import { findWebsiteForCompany } from './website-search.js';
import { crawlCompanyWebsite } from './crawler.js';
import { extractCompanyContacts } from './extractor.js';
import { scoreCompanyContacts } from './contact-scoring.js';

export type JobType = 'full_pipeline' | 'retry_failed' | 'reset_and_run' | 'retry_company';

type Job = { id: string; type: JobType; batchId?: string; companyId?: string; requestedAt: string };

const jobs = new Map<string, Job>();
let running = false;
const aresService = new AresService();

async function createLog(batchId: string, companyId: string | undefined, step: string, status: 'info' | 'success' | 'warning' | 'error', message: string, detailJson?: unknown) {
  await prisma.processingLog.create({ data: { batchId, companyId, step, status, message, detailJson: detailJson as never } });
}

async function updateBatchProgress(batchId: string, currentStep: BatchStep) {
  const batch = await prisma.searchBatch.findUnique({ where: { id: batchId }, include: { companies: true } });
  if (!batch) return;
  const totalSteps = 5;
  const stepOrder: BatchStep[] = ['ares', 'website_search', 'crawling', 'extraction', 'scoring'];
  const doneStatuses = new Set(['done', 'review']);
  const companies = batch.companies;
  const totalUnits = Math.max(1, companies.length * totalSteps);
  let completedUnits = 0;
  for (const c of companies) {
    if (c.status !== 'pending') completedUnits += 1;
    if (c.websiteUrl) completedUnits += 1;
    if ((c.crawledPagesCount ?? 0) > 0 || c.status === 'extracting' || c.status === 'done') completedUnits += 1;
    if ((c.contactsCount ?? 0) > 0 || doneStatuses.has(c.status)) completedUnits += 1;
    if (c.scoredAt || doneStatuses.has(c.status)) completedUnits += 1;
  }
  const progressPercent = Math.min(100, Math.round((completedUnits / totalUnits) * 100));
  await prisma.searchBatch.update({ where: { id: batchId }, data: { currentStep, progressPercent, processedCount: companies.filter((c) => c.status === 'done' || c.status === 'error').length } });
}

async function processCompany(companyId: string, retry = false) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;
  if (retry) {
    await createLog(company.batchId, company.id, 'retry', 'warning', 'Retrying company pipeline');
  }

  try {
    await prisma.company.update({ where: { id: company.id }, data: { status: 'loading_ares', errorMessage: null } });
    await updateBatchProgress(company.batchId, 'ares');
    const aresData = await aresService.loadByIco(company.ico);
    await prisma.company.update({
      where: { id: company.id },
      data: {
        companyName: aresData.companyName,
        legalForm: aresData.legalForm,
        addressText: aresData.addressText,
        city: aresData.city,
        postalCode: aresData.postalCode,
        country: aresData.country,
        registrationStatus: aresData.registrationStatus,
        createdDate: aresData.createdDate,
        dataBoxId: aresData.dataBoxId,
        statutoryPersonsJson: (aresData.statutoryPersons ?? null) as never,
        aresRawJson: aresData.rawJson as never,
        aresLoadedAt: new Date(),
        status: 'finding_web'
      }
    });

    await updateBatchProgress(company.batchId, 'website_search');
    await findWebsiteForCompany(company.id);

    const refreshed = await prisma.company.findUnique({ where: { id: company.id } });
    if (!refreshed?.websiteUrl) {
      throw new Error('Website not found');
    }

    await prisma.company.update({ where: { id: company.id }, data: { status: 'crawling' } });
    await updateBatchProgress(company.batchId, 'crawling');
    const crawlResult = await crawlCompanyWebsite(company.id);
    await prisma.company.update({ where: { id: company.id }, data: { status: 'extracting', crawledPagesCount: crawlResult.fetchedPages, crawledAt: new Date() } });

    await updateBatchProgress(company.batchId, 'extraction');
    await extractCompanyContacts(company.id);

    await updateBatchProgress(company.batchId, 'scoring');
    await scoreCompanyContacts(company.id);
    await prisma.company.update({ where: { id: company.id }, data: { status: 'done', errorMessage: null } });
    await waitAresDelay();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.company.update({ where: { id: company.id }, data: { status: 'error', errorMessage: message } });
    await createLog(company.batchId, company.id, 'pipeline', 'error', 'Company pipeline failed', { message, retry });
  }
}

async function runBatch(batchId: string, opts: { onlyFailed?: boolean; reset?: boolean }) {
  const batch = await prisma.searchBatch.findUnique({ where: { id: batchId } });
  if (!batch) return;

  await prisma.searchBatch.update({ where: { id: batchId }, data: { status: 'processing', startedAt: batch.startedAt ?? new Date(), finishedAt: null, currentStep: 'ares', lastErrorMessage: null } });

  if (opts.reset) {
    await prisma.company.updateMany({ where: { batchId }, data: { status: 'pending', errorMessage: null } });
  }

  const where = opts.onlyFailed ? { batchId, status: 'error' as const } : { batchId };
  const companies = await prisma.company.findMany({ where, orderBy: { createdAt: 'asc' } });

  for (const company of companies) {
    if (!opts.onlyFailed && !opts.reset && company.status === 'done') {
      continue;
    }
    await processCompany(company.id, opts.onlyFailed || opts.reset);
  }

  const stats = await prisma.company.groupBy({ by: ['status'], where: { batchId }, _count: { _all: true } });
  const errorCount = stats.find((item) => item.status === 'error')?._count._all ?? 0;
  await prisma.searchBatch.update({
    where: { id: batchId },
    data: {
      status: errorCount > 0 ? 'done_with_errors' : 'done',
      currentStep: errorCount > 0 ? 'error' : 'done',
      progressPercent: 100,
      finishedAt: new Date(),
      lastErrorMessage: errorCount > 0 ? `${errorCount} companies failed` : null
    }
  });
}

async function runJob(job: Job) {
  if (job.type === 'retry_company' && job.companyId) {
    await processCompany(job.companyId, true);
    return;
  }
  if (!job.batchId) return;
  if (job.type === 'full_pipeline') await runBatch(job.batchId, {});
  if (job.type === 'retry_failed') await runBatch(job.batchId, { onlyFailed: true });
  if (job.type === 'reset_and_run') await runBatch(job.batchId, { reset: true });
}

async function runNext() {
  if (running) return;
  const next = jobs.values().next().value as Job | undefined;
  if (!next) return;
  running = true;
  jobs.delete(next.id);
  try {
    await runJob(next);
  } finally {
    running = false;
    queueMicrotask(() => void runNext());
  }
}

export function enqueueJob(type: JobType, payload: Omit<Job, 'id' | 'type' | 'requestedAt'>): { jobId: string } {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { id: jobId, type, requestedAt: new Date().toISOString(), ...payload });
  queueMicrotask(() => void runNext());
  return { jobId };
}

export function queueHealth(): { status: 'idle' | 'running'; queued: number } {
  return { status: running ? 'running' : 'idle', queued: jobs.size };
}
