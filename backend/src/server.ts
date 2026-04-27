import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ContactType, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { buildImportSummary, parseFile } from './import.js';
import { AresError, AresService, waitAresDelay } from './ares.js';
import { findWebsiteForCompany, normalizeWebsiteUrl } from './website-search.js';
import { crawlCompanyWebsite } from './crawler.js';
import { extractCompanyContacts, extractContactsForBatch, updateContactReviewStatus, updatePersonReviewStatus } from './extractor.js';
import { scoreCompanyContacts, scoreContactsForBatch } from './contact-scoring.js';
import { buildExportRows, buildSummaryRows, generateCsv, generateXlsx } from './export.js';

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
const contactTypeSchema = z.enum(['email', 'phone', 'general_email', 'general_phone', 'databox', 'other']);
const editPersonSchema = z.object({
  fullName: z.string().trim().min(1, 'Jméno je povinné').optional(),
  position: z.string().trim().nullable().optional(),
  reviewStatus: z.enum(['confirmed', 'rejected', 'manually_edited']).optional()
});
const editContactSchema = z.object({
  value: z.string().trim().min(1, 'Hodnota kontaktu je povinná').optional(),
  contactType: contactTypeSchema.optional(),
  personId: z.string().nullable().optional(),
  reviewStatus: z.enum(['confirmed', 'rejected', 'manually_edited']).optional()
});
const createPersonSchema = z.object({
  fullName: z.string().trim().optional(),
  position: z.string().trim().nullable().optional(),
  contactType: contactTypeSchema.optional(),
  contactValue: z.string().trim().optional()
}).refine(
  (value) => Boolean(value.fullName?.trim() || value.contactValue?.trim()),
  { message: 'Musí být vyplněno alespoň jméno nebo kontakt' }
);
const createContactSchema = z.object({
  personId: z.string().nullable().optional(),
  contactType: contactTypeSchema,
  value: z.string().trim().min(1, 'Hodnota kontaktu je povinná')
});
const selectFinalContactSchema = z.object({
  personId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  finalNote: z.string().trim().nullable().optional()
}).refine((value) => Boolean(value.personId || value.contactId), {
  message: 'Musíte zvolit osobu nebo kontakt'
});

function isValidEmail(value: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());
}

function normalizeContactValue(contactType: ContactType, value: string): string {
  if (contactType === 'email' || contactType === 'general_email') {
    return value.trim().toLowerCase();
  }
  if (contactType === 'phone' || contactType === 'general_phone') {
    return value.replace(/\D/g, '');
  }
  return value.trim().toLowerCase();
}

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


app.get('/api/companies/:id/contact-scores', async (req, res) => {
  const company = await prisma.company.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      batchId: true,
      bestPersonId: true,
      bestContactId: true,
      bestContactScore: true,
      scoredAt: true,
      contactScores: {
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        include: { person: true, contact: true }
      }
    }
  });

  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  return res.json(company);
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

app.patch('/api/persons/:id', async (req, res) => {
  const parsed = editPersonSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  const person = await prisma.companyPerson.findUnique({
    where: { id: req.params.id },
    include: { company: true }
  });
  if (!person) {
    return res.status(404).json({ error: 'Osoba nebyla nalezena' });
  }

  const updated = await prisma.companyPerson.update({
    where: { id: person.id },
    data: {
      fullName: parsed.data.fullName ?? undefined,
      position: parsed.data.position ?? undefined,
      reviewStatus: parsed.data.reviewStatus ?? 'manually_edited',
      manuallyEdited: true
    }
  });

  await createProcessingLog({
    batchId: person.company.batchId,
    companyId: person.companyId,
    step: 'manual_review',
    status: 'success',
    message: 'Contact edited',
    detailJson: { entity: 'person', personId: person.id }
  });

  return res.json(updated);
});

app.patch('/api/contacts/:id', async (req, res) => {
  const parsed = editContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  const contact = await prisma.companyContact.findUnique({
    where: { id: req.params.id },
    include: { company: true }
  });
  if (!contact) {
    return res.status(404).json({ error: 'Kontakt nebyl nalezen' });
  }

  const contactType = parsed.data.contactType ?? contact.contactType;
  const value = parsed.data.value ?? contact.value;
  if ((contactType === 'email' || contactType === 'general_email') && !isValidEmail(value)) {
    return res.status(400).json({ error: 'Nevalidní e-mailová adresa' });
  }
  const normalizedValue = normalizeContactValue(contactType, value);

  const duplicate = await prisma.companyContact.findFirst({
    where: {
      companyId: contact.companyId,
      id: { not: contact.id },
      normalizedValue
    }
  });

  const updated = await prisma.companyContact.update({
    where: { id: contact.id },
    data: {
      value,
      contactType,
      personId: parsed.data.personId ?? undefined,
      normalizedValue,
      reviewStatus: parsed.data.reviewStatus ?? 'manually_edited',
      manuallyEdited: true
    }
  });

  await createProcessingLog({
    batchId: contact.company.batchId,
    companyId: contact.companyId,
    step: 'manual_review',
    status: 'success',
    message: 'Contact edited',
    detailJson: { entity: 'contact', contactId: contact.id, duplicateFound: Boolean(duplicate) }
  });

  return res.json({ contact: updated, warning: duplicate ? 'Podobný kontakt již ve firmě existuje.' : null });
});

app.post('/api/companies/:id/persons', async (req, res) => {
  const parsed = createPersonSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  const company = await prisma.company.findUnique({
    where: { id: req.params.id },
    include: { crawledPages: { orderBy: { createdAt: 'asc' }, take: 1 } }
  });
  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  const fallbackPage = company.crawledPages[0];
  if (!fallbackPage) {
    return res.status(400).json({ error: 'Firma nemá zdrojovou stránku pro ruční kontakt' });
  }

  let createdPersonId: string | null = null;
  let duplicateWarning: string | null = null;
  const created = await prisma.$transaction(async (tx) => {
    const person = parsed.data.fullName?.trim()
      ? await tx.companyPerson.create({
        data: {
          companyId: company.id,
          fullName: parsed.data.fullName.trim(),
          position: parsed.data.position ?? null,
          sourceUrl: fallbackPage.url,
          sourcePageId: fallbackPage.id,
          contextText: 'Manually created',
          extractionMethod: 'manual',
          confidenceScore: 95,
          reviewStatus: 'manually_edited',
          manuallyEdited: true
        }
      })
      : null;

    createdPersonId = person?.id ?? null;

    let contact = null;
    if (parsed.data.contactValue?.trim() && parsed.data.contactType) {
      const normalizedValue = normalizeContactValue(parsed.data.contactType, parsed.data.contactValue);
      if ((parsed.data.contactType === 'email' || parsed.data.contactType === 'general_email') && !isValidEmail(parsed.data.contactValue)) {
        throw new Error('Nevalidní e-mailová adresa');
      }

      const duplicate = await tx.companyContact.findFirst({
        where: { companyId: company.id, normalizedValue }
      });
      if (duplicate) {
        duplicateWarning = 'Podobný kontakt již ve firmě existuje.';
      }

      contact = await tx.companyContact.create({
        data: {
          companyId: company.id,
          personId: person?.id ?? null,
          contactType: parsed.data.contactType,
          value: parsed.data.contactValue,
          normalizedValue,
          sourceUrl: fallbackPage.url,
          sourcePageId: fallbackPage.id,
          contextText: 'Manually created',
          extractionMethod: 'manual',
          confidenceScore: 95,
          reviewStatus: 'manually_edited',
          manuallyEdited: true
        }
      });
    }

    await tx.company.update({
      where: { id: company.id },
      data: {
        personsCount: await tx.companyPerson.count({ where: { companyId: company.id } }),
        contactsCount: await tx.companyContact.count({ where: { companyId: company.id } })
      }
    });

    return { person, contact };
  });

  await createProcessingLog({
    batchId: company.batchId,
    companyId: company.id,
    step: 'manual_review',
    status: 'success',
    message: 'Manual contact created',
    detailJson: { personId: createdPersonId, hasContact: Boolean(created.contact) }
  });

  return res.status(201).json({ ...created, warning: duplicateWarning });
});

app.post('/api/companies/:id/contacts', async (req, res) => {
  const parsed = createContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  if ((parsed.data.contactType === 'email' || parsed.data.contactType === 'general_email') && !isValidEmail(parsed.data.value)) {
    return res.status(400).json({ error: 'Nevalidní e-mailová adresa' });
  }

  const company = await prisma.company.findUnique({
    where: { id: req.params.id },
    include: { crawledPages: { orderBy: { createdAt: 'asc' }, take: 1 } }
  });
  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }
  const fallbackPage = company.crawledPages[0];
  if (!fallbackPage) {
    return res.status(400).json({ error: 'Firma nemá zdrojovou stránku pro ruční kontakt' });
  }

  const normalizedValue = normalizeContactValue(parsed.data.contactType, parsed.data.value);
  const duplicate = await prisma.companyContact.findFirst({
    where: { companyId: company.id, normalizedValue }
  });

  const created = await prisma.companyContact.create({
    data: {
      companyId: company.id,
      personId: parsed.data.personId ?? null,
      contactType: parsed.data.contactType,
      value: parsed.data.value,
      normalizedValue,
      sourceUrl: fallbackPage.url,
      sourcePageId: fallbackPage.id,
      contextText: 'Manually created',
      extractionMethod: 'manual',
      confidenceScore: 95,
      reviewStatus: 'manually_edited',
      manuallyEdited: true
    }
  });

  await prisma.company.update({
    where: { id: company.id },
    data: { contactsCount: await prisma.companyContact.count({ where: { companyId: company.id } }) }
  });

  await createProcessingLog({
    batchId: company.batchId,
    companyId: company.id,
    step: 'manual_review',
    status: 'success',
    message: 'Manual contact created',
    detailJson: { contactId: created.id }
  });

  return res.status(201).json({ contact: created, warning: duplicate ? 'Podobný kontakt již ve firmě existuje.' : null });
});

app.post('/api/companies/:id/select-final-contact', async (req, res) => {
  const parsed = selectFinalContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) {
    return res.status(404).json({ error: 'Firma nebyla nalezena' });
  }

  const contact = parsed.data.contactId
    ? await prisma.companyContact.findFirst({ where: { id: parsed.data.contactId, companyId: company.id } })
    : null;
  const person = parsed.data.personId
    ? await prisma.companyPerson.findFirst({ where: { id: parsed.data.personId, companyId: company.id } })
    : null;

  if (parsed.data.contactId && !contact) {
    return res.status(400).json({ error: 'Kontakt pro finální výběr neexistuje' });
  }
  if (parsed.data.personId && !person) {
    return res.status(400).json({ error: 'Osoba pro finální výběr neexistuje' });
  }
  if (!contact && !person) {
    return res.status(400).json({ error: 'Nelze vybrat finální kontakt bez existence kontaktu/osoby' });
  }

  await prisma.$transaction(async (tx) => {
    await tx.companyPerson.updateMany({ where: { companyId: company.id }, data: { isSelected: false } });
    await tx.companyContact.updateMany({ where: { companyId: company.id }, data: { isSelected: false } });

    if (person) {
      await tx.companyPerson.update({ where: { id: person.id }, data: { isSelected: true } });
    }
    if (contact) {
      await tx.companyContact.update({ where: { id: contact.id }, data: { isSelected: true } });
    }

    await tx.company.update({
      where: { id: company.id },
      data: {
        finalPersonId: person?.id ?? contact?.personId ?? null,
        finalContactId: contact?.id ?? null,
        finalDecisionSource: 'manual',
        finalNote: parsed.data.finalNote ?? null
      }
    });
  });

  await createProcessingLog({
    batchId: company.batchId,
    companyId: company.id,
    step: 'manual_review',
    status: 'success',
    message: 'Final contact selected',
    detailJson: { finalPersonId: person?.id ?? contact?.personId ?? null, finalContactId: contact?.id ?? null }
  });

  return res.json({ success: true });
});

app.post('/api/contacts/:id/review', async (req, res) => {
  const parsed = reviewStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Nevalidní vstup' });
  }

  const contact = await prisma.companyContact.findUnique({
    where: { id: req.params.id },
    include: { company: true }
  });
  if (!contact) {
    return res.status(404).json({ error: 'Kontakt nebyl nalezen' });
  }

  const updated = await prisma.companyContact.update({
    where: { id: contact.id },
    data: { reviewStatus: parsed.data.reviewStatus }
  });

  await createProcessingLog({
    batchId: contact.company.batchId,
    companyId: contact.companyId,
    step: 'manual_review',
    status: 'success',
    message: parsed.data.reviewStatus === 'confirmed' ? 'Contact manually confirmed' : parsed.data.reviewStatus === 'rejected' ? 'Contact rejected' : 'Contact edited',
    detailJson: { contactId: contact.id, reviewStatus: parsed.data.reviewStatus }
  });

  return res.json(updated);
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


app.get('/api/search-batches/:id/export.csv', async (req, res) => {
  const batchId = req.params.id;

  const batch = await prisma.searchBatch.findUnique({
    where: { id: batchId },
    include: {
      companies: {
        include: {
          contacts: { include: { person: true } },
          contactScores: true
        }
      }
    }
  });

  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  if (batch.companies.length === 0) {
    return res.status(400).json({ error: 'Dávka neobsahuje žádné firmy' });
  }

  const today = new Date();
  const exportDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const fileName = `contacts-export-${batchId}-${exportDate}.csv`;

  try {
    const rows = buildExportRows(batch);
    const csv = generateCsv(rows);

    await createProcessingLog({
      batchId,
      step: 'export',
      status: 'success',
      message: 'CSV export generated',
      detailJson: {
        batchId,
        format: 'csv',
        exportedRows: rows.length,
        exportedAt: new Date().toISOString()
      }
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(Buffer.from(csv, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chyba generování CSV exportu';

    await createProcessingLog({
      batchId,
      step: 'export',
      status: 'error',
      message: 'Export failed',
      detailJson: {
        batchId,
        format: 'csv',
        error: message,
        exportedAt: new Date().toISOString()
      }
    });

    return res.status(500).json({ error: message });
  }
});

app.get('/api/search-batches/:id/export.xlsx', async (req, res) => {
  const batchId = req.params.id;

  const batch = await prisma.searchBatch.findUnique({
    where: { id: batchId },
    include: {
      companies: {
        include: {
          contacts: { include: { person: true } },
          contactScores: true
        }
      }
    }
  });

  if (!batch) {
    return res.status(404).json({ error: 'Dávka nebyla nalezena' });
  }

  if (batch.companies.length === 0) {
    return res.status(400).json({ error: 'Dávka neobsahuje žádné firmy' });
  }

  const today = new Date();
  const exportDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const fileName = `contacts-export-${batchId}-${exportDate}.xlsx`;

  try {
    const rows = buildExportRows(batch);
    const summaryRows = buildSummaryRows(batch);
    const workbookBuffer = generateXlsx(rows, summaryRows);

    await createProcessingLog({
      batchId,
      step: 'export',
      status: 'success',
      message: 'XLSX export generated',
      detailJson: {
        batchId,
        format: 'xlsx',
        exportedRows: rows.length,
        exportedAt: new Date().toISOString()
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(workbookBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chyba generování XLSX exportu';

    await createProcessingLog({
      batchId,
      step: 'export',
      status: 'error',
      message: 'Export failed',
      detailJson: {
        batchId,
        format: 'xlsx',
        error: message,
        exportedAt: new Date().toISOString()
      }
    });

    return res.status(500).json({ error: message });
  }
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
