import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { buildImportSummary, parseFile } from './import.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json());

const createBatchSchema = z.object({
  name: z.string().trim().min(1, 'Název dávky je povinný'),
  note: z.string().optional().nullable(),
  targetRole: z.string().optional().nullable()
});

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
    let importedCount = 0;
    let skippedCount = 0;

    await prisma.$transaction(async (tx) => {
      const existingCompanies = await tx.company.findMany({
        where: {
          batchId,
          ico: { in: summary.uniqueIcos }
        },
        select: { ico: true }
      });

      const existingIcos = new Set(existingCompanies.map((company) => company.ico));
      const newIcos = summary.uniqueIcos.filter((ico) => !existingIcos.has(ico));

      importedCount = newIcos.length;
      skippedCount = summary.uniqueIcos.length - newIcos.length;

      for (const row of summary.rows) {
        const isAlreadyImported =
          row.status === 'imported' && row.normalizedIco ? existingIcos.has(row.normalizedIco) : false;

        await tx.importLog.create({
          data: {
            batchId,
            rowNumber: row.rowNumber,
            rawValue: row.rawValue,
            normalizedIco: row.normalizedIco,
            status: isAlreadyImported ? 'skipped' : row.status,
            message: isAlreadyImported ? 'IČO už je v dávce' : row.message
          }
        });
      }

      for (const ico of newIcos) {
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
          totalCount: { increment: importedCount },
          ...(importedCount > 0 ? { status: 'ready' } : {})
        }
      });
    });

    return res.json({
      importedCount,
      invalidCount: summary.invalidCount,
      duplicateCount: summary.duplicateCount,
      skippedCount,
      errors: summary.errors
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import selhal';
    return res.status(400).json({ error: message });
  }
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
      importLogs: { orderBy: { rowNumber: 'asc' } }
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
