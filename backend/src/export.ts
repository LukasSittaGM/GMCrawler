import { ContactScoreCategory, Prisma } from '@prisma/client';
import { utils, write } from 'xlsx';

export const EXPORT_COLUMNS = [
  'batchName',
  'targetRole',
  'ico',
  'companyName',
  'legalForm',
  'addressText',
  'websiteUrl',
  'websiteConfidenceScore',
  'personName',
  'position',
  'department',
  'contactType',
  'contactValue',
  'contactConfidenceScore',
  'relevanceScore',
  'relevanceCategory',
  'sourceUrl',
  'contextText',
  'reviewStatus',
  'companyStatus',
  'errorMessage',
  'foundAt'
] as const;

export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string | number | null>;

const CONTEXT_MAX_LENGTH = 1000;

function formatDateTime(value: Date | null | undefined): string {
  if (!value) {
    return '';
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  const second = String(value.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function truncateContext(text: string | null): string {
  if (!text) {
    return '';
  }

  if (text.length <= CONTEXT_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, CONTEXT_MAX_LENGTH)}…`;
}

export function buildExportRows(batch: Prisma.SearchBatchGetPayload<{
  include: {
    companies: {
      include: {
        contacts: { include: { person: true } };
        contactScores: true;
      };
    };
  };
}>): ExportRow[] {
  const rows: ExportRow[] = [];

  const sortedCompanies = [...batch.companies].sort((a, b) => {
    const scoreA = a.bestContactScore ?? -1;
    const scoreB = b.bestContactScore ?? -1;

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    return (a.companyName ?? '').localeCompare(b.companyName ?? '', 'cs');
  });

  for (const company of sortedCompanies) {
    const sortedContacts = [...company.contacts].sort((a, b) => {
      const scoreA = company.contactScores.find((item) => item.contactId === a.id)?.score ?? -1;
      const scoreB = company.contactScores.find((item) => item.contactId === b.id)?.score ?? -1;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return b.confidenceScore - a.confidenceScore;
    });

    if (sortedContacts.length === 0) {
      rows.push({
        batchName: batch.name,
        targetRole: batch.targetRole,
        ico: company.ico,
        companyName: company.companyName,
        legalForm: company.legalForm,
        addressText: company.addressText,
        websiteUrl: company.websiteUrl,
        websiteConfidenceScore: company.websiteConfidenceScore,
        personName: null,
        position: null,
        department: null,
        contactType: null,
        contactValue: null,
        contactConfidenceScore: null,
        relevanceScore: null,
        relevanceCategory: null,
        sourceUrl: null,
        contextText: null,
        reviewStatus: null,
        companyStatus: company.status,
        errorMessage: company.errorMessage ?? company.extractionErrorMessage ?? company.crawlErrorMessage,
        foundAt: ''
      });
      continue;
    }

    for (const contact of sortedContacts) {
      const score = company.contactScores
        .filter((item) => item.contactId === contact.id)
        .sort((a, b) => b.score - a.score)[0];

      rows.push({
        batchName: batch.name,
        targetRole: score?.targetRole ?? batch.targetRole,
        ico: company.ico,
        companyName: company.companyName,
        legalForm: company.legalForm,
        addressText: company.addressText,
        websiteUrl: company.websiteUrl,
        websiteConfidenceScore: company.websiteConfidenceScore,
        personName: contact.person?.fullName ?? null,
        position: contact.person?.position ?? null,
        department: contact.person?.department ?? null,
        contactType: contact.contactType,
        contactValue: contact.value,
        contactConfidenceScore: contact.confidenceScore,
        relevanceScore: score?.score ?? null,
        relevanceCategory: score?.category ?? null,
        sourceUrl: contact.sourceUrl,
        contextText: truncateContext(contact.contextText),
        reviewStatus: contact.reviewStatus,
        companyStatus: company.status,
        errorMessage: company.errorMessage ?? company.extractionErrorMessage ?? company.crawlErrorMessage,
        foundAt: formatDateTime(contact.createdAt)
      });
    }
  }

  return rows;
}

function csvEscape(value: string): string {
  if (value.includes(';') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}

export function generateCsv(rows: ExportRow[]): string {
  const header = EXPORT_COLUMNS.join(';');
  const body = rows
    .map((row) => EXPORT_COLUMNS.map((column) => csvEscape(String(row[column] ?? ''))).join(';'))
    .join('\n');

  return `${header}\n${body}`;
}

export function buildSummaryRows(batch: Prisma.SearchBatchGetPayload<{
  include: {
    companies: {
      include: {
        contacts: true;
        contactScores: true;
      };
    };
  };
}>): Array<{ metric: string; value: string | number }> {
  const contacts = batch.companies.flatMap((company) => company.contacts);
  const scores = batch.companies.flatMap((company) => company.contactScores);

  const categoryCount = (category: ContactScoreCategory): number => scores.filter((item) => item.category === category).length;

  return [
    { metric: 'Název dávky', value: batch.name },
    { metric: 'Target role', value: batch.targetRole ?? '' },
    { metric: 'Datum vytvoření dávky', value: formatDateTime(batch.createdAt) },
    { metric: 'Datum exportu', value: formatDateTime(new Date()) },
    { metric: 'Počet firem', value: batch.companies.length },
    { metric: 'Počet firem se zvoleným webem', value: batch.companies.filter((company) => !!company.websiteUrl).length },
    { metric: 'Počet firem s kontaktem', value: batch.companies.filter((company) => company.contacts.length > 0).length },
    { metric: 'Počet kontaktů celkem', value: contacts.length },
    { metric: 'Počet high score kontaktů', value: categoryCount('high') },
    { metric: 'Počet medium score kontaktů', value: categoryCount('medium') },
    { metric: 'Počet low score kontaktů', value: categoryCount('low') },
    { metric: 'Počet needs_review kontaktů', value: categoryCount('needs_review') }
  ];
}

export function generateXlsx(rows: ExportRow[], summaryRows: Array<{ metric: string; value: string | number }>): Buffer {
  const workbook = utils.book_new();

  const dataRows = [[...EXPORT_COLUMNS], ...rows.map((row) => EXPORT_COLUMNS.map((column) => row[column] ?? ''))];
  const resultsSheet = utils.aoa_to_sheet(dataRows);

  resultsSheet['!autofilter'] = { ref: `A1:V1` };
  resultsSheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2' };
  resultsSheet['!cols'] = EXPORT_COLUMNS.map((col) => ({ wch: Math.max(14, col.length + 2) }));

  for (let i = 0; i < EXPORT_COLUMNS.length; i += 1) {
    const cellRef = utils.encode_cell({ c: i, r: 0 });
    if (!resultsSheet[cellRef]) {
      continue;
    }
    resultsSheet[cellRef].s = { font: { bold: true } };
  }

  const summaryData = [['Metrika', 'Hodnota'], ...summaryRows.map((row) => [row.metric, row.value])];
  const summarySheet = utils.aoa_to_sheet(summaryData);
  summarySheet['!cols'] = [{ wch: 36 }, { wch: 28 }];
  summarySheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2' };
  summarySheet['!autofilter'] = { ref: 'A1:B1' };

  summarySheet.A1.s = { font: { bold: true } };
  summarySheet.B1.s = { font: { bold: true } };

  utils.book_append_sheet(workbook, resultsSheet, 'Výsledky');
  utils.book_append_sheet(workbook, summarySheet, 'Souhrn');

  return Buffer.from(write(workbook, { bookType: 'xlsx', type: 'buffer' }));
}
