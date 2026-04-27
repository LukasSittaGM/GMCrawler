import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { buildImportSummary, parseFile } from './import.js';
import { AresError, AresService, waitAresDelay } from './ares.js';
import { findWebsiteForCompany, normalizeWebsiteUrl } from './website-search.js';
import { crawlCompanyWebsite } from './crawler.js';
import { extractCompanyContacts, extractContactsForBatch, updateContactReviewStatus, updatePersonReviewStatus } from './extractor.js';
import { scoreCompanyContacts, scoreContactsForBatch } from './contact-scoring.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = Number(process.env.PORT ?? 3001);
const aresService = new AresService();

app.use(cors());
app.use(express.json());

const createBatchSchema = z.object({
  name: z.string().trim().min(1, 'Název dávky je povinný'),
  note: z.string().optional().nullable(),
  targetRole: z.string().optional().nullable()
});

const manualWebsiteSchema = z.object({
  websiteUrl: z.string().trim().min(1, 'websiteUrl je povinné')
});
const reviewStatusSchema = z.object({
  reviewStatus: z.enum(['confirmed', 'rejected', 'manually_edited'])
});

async function createProcessingLog(input: {
  batchId: string;
  companyId?: string;
  step: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detailJson?: unknown;
}): Promise<void> {
  await prisma.processingLog.create({
    data: {
      batchId: input.batchId,
      companyId: input.companyId,
      step: input.step,
      status: input.status,
      message: input.message,
      detailJson: (input.detailJson ?? undefined) as Prisma.InputJsonValue | undefined
    }
  });
}

async function processCompanyAres(companyId: string): Promise<{ success: boolean }> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  if (!company) {
    throw new Error('Firma nebyla nalezena');
  }

  await prisma.company.update({
    where: { id: company.id },
    data: {
      status: 'loading_ares',
      errorMessage: null
    }
  });

  await createProcessingLog({
    batchId: company.batchId,
    companyId: company.id,
    step: 'ares',
    status: 'info',
    message: 'Starting ARES lookup'
  });

  try {
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
        statutoryPersonsJson: (aresData.statutoryPersons ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        aresRawJson: aresData.rawJson as Prisma.InputJsonValue,
        aresLoadedAt: new Date(),
        status: 'finding_web',
        errorMessage: null
      }
    });

    await createProcessingLog({
      batchId: company.batchId,
      companyId: company.id,
      step: 'ares',
      status: 'success',
      message: 'ARES data loaded'
    });

    return { success: true };
  } catch (error) {
    const message = error instanceof AresError ? error.message : 'Neočekávaná chyba při načtení ARES';
    const detailJson = error instanceof AresError ? { code: error.code, detail: error.detail } : { error: String(error) };

    await prisma.company.update({
      where: { id: company.id },
      data: {
        status: 'error',
        errorMessage: message
      }
    });

    await createProcessingLog({
      batchId: company.batchId,
      companyId: company.id,
      step: 'ares',
      status: 'error',
      message,
      detailJson
    });

    return { success: false };
  }
}

app.post('/api/search-batches', async (req, res) => {
  const parsed = createBatchSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  const batch = await prisma.searchBatch.create({ data: parsed.data });
  return res.status(201).json(batch);
});

app.post('/api/search-batches/:id/import', upload.single('file'), async (req, res) => {
  const batchId = req.params.id;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Soubor je povinný' });
  }

  try {
    const rows = parseFile(file.originalname, file.mimetype, file.buffer);
    const summary = buildImportSummary(rows);

    await prisma.$transaction(async (tx) => {
      for (const row of summary.rows) {
        await tx.importLog.create({
          data: {
            batchId,
            rowNumber: row.rowNumber,
            rawValue: row.rawValue,
            normalizedIco: row.normalizedIco,
            status: row.status,
            message: row.message
          }
        });
      }

      for (const ico of summary.uniqueIcos) {
        await tx.company.create({
          data: {
            batchId,
            ico,
            status: 'pending'
          }
        });
      }

      await tx.searchBatch.update({
        where: { id: batchId },
        data: {
          totalCount: { increment: summary.importedCount },
          status: summary.importedCount > 0 ? 'ready' : 'draft'
        }
      });
    });

    return res.json({
      importedCount: summary.importedCount,
      invalidCount: summary.invalidCount,
      duplicateCount: summary.duplicateCount,
      errors: summary.errors
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import selhal';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/search-batches/:id/start', async (req, res) => {
  const batchId = req.params.id;

  const batch = await prisma.searchBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  await prisma.searchBatch.update({
    where: { id: batchId },
    data: {
      status: 'processing',
      processedCount: 0
    }
  });

  const companies = await prisma.company.findMany({
    where: {
      batchId,
      status: 'pending'
    },
    orderBy: { createdAt: 'asc' }
  });

  let successCount = 0;
  let errorCount = 0;

  for (const company of companies) {
    const result = await processCompanyAres(company.id);

    if (result.success) {
      successCount += 1;
    } else {
      errorCount += 1;
    }

    await prisma.searchBatch.update({
      where: { id: batchId },
      data: {
        processedCount: {
          increment: 1
        }
      }
    });

    await waitAresDelay();
  }

  const finalStatus = companies.length > 0 && successCount === 0 && errorCount > 0 ? 'error' : 'done';

  await prisma.searchBatch.update({
    where: { id: batchId },
    data: {
      status: finalStatus
    }
  });

  return res.json({
    batchId,
    processed: companies.length,
    successCount,
    errorCount,
    status: finalStatus
  });
});

app.post('/api/companies/:id/reload-ares', async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });

  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  const result = await processCompanyAres(company.id);

  const refreshedCompany = await prisma.company.findUnique({ where: { id: company.id } });
  return res.json({ success: result.success, company: refreshedCompany });
});

app.post('/api/companies/:id/find-website', async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });

  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  const result = await findWebsiteForCompany(company.id);
  const refreshed = await prisma.company.findUnique({
    where: { id: company.id },
    include: { websites: { orderBy: [{ isSelected: 'desc' }, { confidenceScore: 'desc' }] } }
  });

  return res.json({ result, company: refreshed });
});

app.post('/api/search-batches/:id/find-websites', async (req, res) => {
  const batchId = req.params.id;
  const batch = await prisma.searchBatch.findUnique({ where: { id: batchId } });

  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  const companies = await prisma.company.findMany({
    where: {
      batchId,
      status: 'finding_web'
    },
    orderBy: { createdAt: 'asc' }
  });

  let selectedCount = 0;
  let noResultCount = 0;
  let errorCount = 0;

  for (const company of companies) {
    const result = await findWebsiteForCompany(company.id);
    if (result.selected) {
      selectedCount += 1;
    } else {
      const refreshed = await prisma.company.findUnique({ where: { id: company.id } });
      if (refreshed?.status === 'error') {
        errorCount += 1;
      } else {
        noResultCount += 1;
      }
    }
  }

  return res.json({
    batchId,
    processed: companies.length,
    selectedCount,
    noResultCount,
    errorCount
  });
});

app.post('/api/companies/:id/crawl', async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });

  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  if (!company.websiteUrl) {
    return res.status(400).json({ error: 'Firma nemá vyplněný websiteUrl' });
  }

  await prisma.company.update({
    where: { id: company.id },
    data: {
      status: 'crawling',
      errorMessage: null,
      crawlErrorMessage: null
    }
  });

  try {
    const result = await crawlCompanyWebsite(company.id);
    await prisma.company.update({
      where: { id: company.id },
      data: {
        status: 'extracting',
        crawledAt: new Date(),
        crawledPagesCount: result.fetchedPages,
        crawlErrorMessage: null,
        errorMessage: null
      }
    });

    return res.json({ companyId: company.id, ...result, status: 'extracting' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Company crawl failed';
    await prisma.company.update({
      where: { id: company.id },
      data: {
        status: 'error',
        errorMessage: message,
        crawlErrorMessage: message
      }
    });

    await createProcessingLog({
      batchId: company.batchId,
      companyId: company.id,
      step: 'crawl',
      status: 'error',
      message: 'Company crawl failed',
      detailJson: { error: message }
    });

    return res.status(500).json({ error: message });
  }
});

app.post('/api/search-batches/:id/crawl', async (req, res) => {
  const batchId = req.params.id;
  const batch = await prisma.searchBatch.findUnique({ where: { id: batchId } });

  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  const companies = await prisma.company.findMany({
    where: {
      batchId,
      status: 'crawling'
    },
    orderBy: { createdAt: 'asc' }
  });

  let successCount = 0;
  let errorCount = 0;

  for (const company of companies) {
    try {
      await prisma.company.update({
        where: { id: company.id },
        data: {
          status: 'crawling',
          errorMessage: null,
          crawlErrorMessage: null
        }
      });

      const result = await crawlCompanyWebsite(company.id);
      await prisma.company.update({
        where: { id: company.id },
        data: {
          status: 'extracting',
          crawledAt: new Date(),
          crawledPagesCount: result.fetchedPages,
          crawlErrorMessage: null,
          errorMessage: null
        }
      });
      successCount += 1;
    } catch (error) {
      errorCount += 1;
      const message = error instanceof Error ? error.message : 'Company crawl failed';
      await prisma.company.update({
        where: { id: company.id },
        data: {
          status: 'error',
          errorMessage: message,
          crawlErrorMessage: message
        }
      });

      await createProcessingLog({
        batchId: company.batchId,
        companyId: company.id,
        step: 'crawl',
        status: 'error',
        message: 'Company crawl failed',
        detailJson: { error: message }
      });
    }
  }

  return res.json({
    batchId,
    processed: companies.length,
    successCount,
    errorCount
  });
});

app.post('/api/companies/:id/extract-contacts', async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  try {
    const result = await extractCompanyContacts(company.id);
    return res.json({ companyId: company.id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contact extraction failed';
    await prisma.company.update({
      where: { id: company.id },
      data: {
        status: 'error',
        extractionErrorMessage: message,
        errorMessage: message
      }
    });
    await createProcessingLog({
      batchId: company.batchId,
      companyId: company.id,
      step: 'extract_contacts',
      status: 'error',
      message: 'Contact extraction failed',
      detailJson: { error: message }
    });
    return res.status(500).json({ error: message });
  }
});

app.post('/api/search-batches/:id/extract-contacts', async (req, res) => {
  const batchId = req.params.id;
  const batch = await prisma.searchBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  const result = await extractContactsForBatch(batchId);
  return res.json({ batchId, ...result });
});

app.post('/api/companies/:id/score-contacts', async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  try {
    const result = await scoreCompanyContacts(company.id);
    return res.json({ companyId: company.id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scoring kontaktů selhal';
    return res.status(500).json({ error: message });
  }
});

app.post('/api/search-batches/:id/score-contacts', async (req, res) => {
  const batchId = req.params.id;
  const batch = await prisma.searchBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  const result = await scoreContactsForBatch(batchId);
  return res.json({ batchId, ...result });
});

app.patch('/api/company-contacts/:id/review-status', async (req, res) => {
  const parsed = reviewStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  try {
    const updated = await updateContactReviewStatus(req.params.id, parsed.data.reviewStatus);
    return res.json(updated);
  } catch {
    return res.status(404).json({ error: 'Kontakt nebyl nalezen' });
  }
});

app.patch('/api/company-persons/:id/review-status', async (req, res) => {
  const parsed = reviewStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  try {
    const updated = await updatePersonReviewStatus(req.params.id, parsed.data.reviewStatus);
    return res.json(updated);
  } catch {
    return res.status(404).json({ error: 'Osoba nebyla nalezena' });
  }
});

app.patch('/api/companies/:id/website', async (req, res) => {
  const parsed = manualWebsiteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  const normalized = normalizeWebsiteUrl(parsed.data.websiteUrl);
  if (!normalized) {
    return res.status(400).json({ error: 'Nevalidní URL webu' });
  }

  await prisma.$transaction(async (tx) => {
    await tx.companyWebsite.updateMany({
      where: { companyId: company.id },
      data: { isSelected: false }
    });

    await tx.companyWebsite.create({
      data: {
        companyId: company.id,
        url: normalized.url,
        normalizedDomain: normalized.domain,
        source: 'manual',
        confidenceScore: 95,
        isOfficialCandidate: true,
        isSelected: true,
        reason: 'Manuálně vybráno uživatelem'
      }
    });

    await tx.company.update({
      where: { id: company.id },
      data: {
        websiteUrl: normalized.url,
        websiteDomain: normalized.domain,
        websiteConfidenceScore: 95,
        websiteFoundAt: new Date(),
        status: 'crawling',
        errorMessage: null
      }
    });

    await tx.processingLog.create({
      data: {
        batchId: company.batchId,
        companyId: company.id,
        step: 'website_search',
        status: 'success',
        message: 'Selected official website',
        detailJson: {
          selectedUrl: normalized.url,
          score: 95,
          reason: 'manual'
        }
      }
    });
  });

  const refreshed = await prisma.company.findUnique({
    where: { id: company.id },
    include: { websites: { orderBy: [{ isSelected: 'desc' }, { confidenceScore: 'desc' }] } }
  });

  return res.json(refreshed);
});

app.get('/api/search-batches', async (_req, res) => {
  const batches = await prisma.searchBatch.findMany({ orderBy: { createdAt: 'desc' } });
  return res.json(batches);
});

app.get('/api/search-batches/:id', async (req, res) => {
  const batch = await prisma.searchBatch.findUnique({
    where: { id: req.params.id },
    include: {
      companies: {
        orderBy: { createdAt: 'asc' },
        include: {
          websites: { orderBy: [{ isSelected: 'desc' }, { confidenceScore: 'desc' }] },
          crawledPages: { orderBy: { createdAt: 'desc' } },
          persons: { orderBy: [{ confidenceScore: 'desc' }, { createdAt: 'desc' }] },
          contacts: { orderBy: [{ confidenceScore: 'desc' }, { createdAt: 'desc' }], include: { person: true } },
          contactScores: { orderBy: [{ score: 'desc' }, { createdAt: 'desc' }], include: { person: true, contact: true } }
        }
      },
      importLogs: { orderBy: { rowNumber: 'asc' } },
      processingLogs: { orderBy: { createdAt: 'desc' } }
    }
  });

  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  return res.json(batch);
});

app.delete('/api/search-batches/:id', async (req, res) => {
  try {
    await prisma.searchBatch.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }
});

app.listen(port, () => {
  console.log(`Backend běží na http://localhost:${port}`);
});
