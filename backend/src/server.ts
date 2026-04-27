import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { buildImportSummary, parseFile } from './import.js';
import { AresError, AresService, waitAresDelay } from './ares.js';

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
      detailJson: input.detailJson
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
        statutoryPersonsJson: aresData.statutoryPersons,
        aresRawJson: aresData.rawJson,
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

app.get('/api/search-batches', async (_req, res) => {
  const batches = await prisma.searchBatch.findMany({ orderBy: { createdAt: 'desc' } });
  return res.json(batches);
});

app.get('/api/search-batches/:id', async (req, res) => {
  const batch = await prisma.searchBatch.findUnique({
    where: { id: req.params.id },
    include: {
      companies: { orderBy: { createdAt: 'asc' } },
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
