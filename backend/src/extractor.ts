import { ContactType, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

type CandidatePerson = {
  key: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  department: string | null;
  sourcePageId: string;
  sourceUrl: string;
  contextText: string;
  confidenceScore: number;
};

type CandidateContact = {
  contactType: ContactType;
  value: string;
  normalizedValue: string;
  sourcePageId: string;
  sourceUrl: string;
  contextText: string;
  personKey: string | null;
  confidenceScore: number;
};

const GENERAL_EMAIL_PREFIXES = ['info', 'obchod', 'sales', 'kontakt', 'recepce', 'office', 'podatelna', 'sekretariat', 'sekretariát', 'fakturace', 'accounting', 'hr', 'jobs', 'kariera', 'kariéra'];
const CONTACT_PAGE_HINTS = ['kontakt', 'kontakty', 'contact', 'spojeni', 'spojení'];
const TEAM_PAGE_HINTS = ['team', 'tym', 'tým', 'vedeni', 'vedení', 'management', 'people'];
const POSITION_KEYWORDS = [
  'jednatel', 'ředitel', 'ředitelka', 'ceo', 'cfo', 'coo', 'obchodní ředitel', 'obchodní manažer',
  'hr manažer', 'personalista', 'marketingový manažer', 'vedoucí', 'vedoucí oddělení', 'office manager',
  'účetní', 'ekonom', 'finanční manažer', 'provozní manažer', 'fleet manager', 'správa vozového parku', 'it manažer'
];
const DEPARTMENT_KEYWORDS = ['obchod', 'sales', 'marketing', 'hr', 'finance', 'ekonom', 'it', 'provoz', 'vozový park', 'sekretariát', 'podatelna'];
const SYSTEM_EMAIL_LOCALS = ['noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'admin', 'webmaster', 'robot'];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+420\s*)?(?:\d[\s-]?){9,12}\d/g;
const NAME_REGEX = /\b([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)\b/g;

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function clipContext(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 280);
  const end = Math.min(text.length, index + length + 280);
  return normalizeWhitespace(text.slice(start, end)).slice(0, 700);
}

function normalizeEmail(raw: string): string | null {
  const cleaned = raw.toLowerCase().replace(/[\s,.;:!?]+$/g, '');
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function isGeneralEmail(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return GENERAL_EMAIL_PREFIXES.some((prefix) => local.startsWith(prefix));
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('420')) {
    return `+${digits}`;
  }
  if (digits.length === 9) {
    return `+420${digits}`;
  }
  return null;
}

function isLikelyPhone(value: string): boolean {
  const normalized = normalizePhone(value);
  if (!normalized) {
    return false;
  }
  const local = normalized.slice(4);
  if (/^(\d)\1{8}$/.test(local)) {
    return false;
  }
  return true;
}

function splitName(fullName: string): { firstName: string | null; lastName: string | null } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) {
    return { firstName: null, lastName: null };
  }
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(' ') || null };
}

function keywordScore(url: string, context: string): number {
  const haystack = `${url} ${context}`.toLowerCase();
  let bonus = 0;
  if (CONTACT_PAGE_HINTS.some((k) => haystack.includes(k))) {
    bonus += 12;
  }
  if (TEAM_PAGE_HINTS.some((k) => haystack.includes(k))) {
    bonus += 12;
  }
  return bonus;
}

function findPosition(context: string): string | null {
  const lowered = context.toLowerCase();
  return POSITION_KEYWORDS.find((keyword) => lowered.includes(keyword)) ?? null;
}

function findDepartment(context: string): string | null {
  const lowered = context.toLowerCase();
  return DEPARTMENT_KEYWORDS.find((keyword) => lowered.includes(keyword)) ?? null;
}

function extractPeople(text: string, sourcePageId: string, sourceUrl: string): CandidatePerson[] {
  const results: CandidatePerson[] = [];

  for (const match of text.matchAll(NAME_REGEX)) {
    const fullName = match[1]?.trim();
    const idx = match.index ?? -1;
    if (!fullName || idx < 0) {
      continue;
    }

    const contextText = clipContext(text, idx, fullName.length);
    const position = findPosition(contextText);
    const department = findDepartment(contextText);
    const { firstName, lastName } = splitName(fullName);
    const hasTitle = Boolean(position);

    results.push({
      key: `${fullName.toLowerCase()}|${position ?? ''}`,
      fullName,
      firstName,
      lastName,
      position,
      department,
      sourcePageId,
      sourceUrl,
      contextText,
      confidenceScore: Math.min(100, 45 + keywordScore(sourceUrl, contextText) + (hasTitle ? 20 : 0))
    });
  }

  return results;
}

function contactTypeForEmail(email: string): ContactType {
  return isGeneralEmail(email) ? 'general_email' : 'email';
}

function detectSystemEmail(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return SYSTEM_EMAIL_LOCALS.includes(local);
}

function extractContacts(text: string, sourcePageId: string, sourceUrl: string, websiteDomain: string | null, persons: CandidatePerson[]): { contacts: CandidateContact[]; emailCount: number; phoneCount: number } {
  const contacts: CandidateContact[] = [];
  let emailCount = 0;
  let phoneCount = 0;

  for (const match of text.matchAll(EMAIL_REGEX)) {
    const value = match[0];
    const idx = match.index ?? -1;
    if (!value || idx < 0) {
      continue;
    }

    const email = normalizeEmail(value);
    if (!email) {
      continue;
    }
    emailCount += 1;

    const contextText = clipContext(text, idx, email.length);
    const linkedPerson = persons.find((p) => contextText.toLowerCase().includes(p.fullName.toLowerCase()));
    const domain = email.split('@')[1] ?? '';
    const domainBonus = websiteDomain && domain.includes(websiteDomain) ? 12 : 0;
    const general = isGeneralEmail(email);
    const base = general ? 45 : 58;

    contacts.push({
      contactType: contactTypeForEmail(email),
      value: email,
      normalizedValue: email,
      sourcePageId,
      sourceUrl,
      contextText,
      personKey: linkedPerson?.key ?? null,
      confidenceScore: Math.min(100, base + keywordScore(sourceUrl, contextText) + domainBonus + (linkedPerson ? 15 : 0))
    });
  }

  for (const match of text.matchAll(PHONE_REGEX)) {
    const value = match[0]?.trim();
    const idx = match.index ?? -1;
    if (!value || idx < 0 || !isLikelyPhone(value)) {
      continue;
    }

    const normalized = normalizePhone(value);
    if (!normalized) {
      continue;
    }
    phoneCount += 1;

    const contextText = clipContext(text, idx, value.length);
    const linkedPerson = persons.find((p) => contextText.toLowerCase().includes(p.fullName.toLowerCase()));
    const generalPhone = !linkedPerson && CONTACT_PAGE_HINTS.some((k) => `${sourceUrl} ${contextText}`.toLowerCase().includes(k));

    contacts.push({
      contactType: linkedPerson ? 'phone' : generalPhone ? 'general_phone' : 'phone',
      value: value,
      normalizedValue: normalized,
      sourcePageId,
      sourceUrl,
      contextText,
      personKey: linkedPerson?.key ?? null,
      confidenceScore: Math.min(100, 28 + keywordScore(sourceUrl, contextText) + (linkedPerson ? 20 : 0))
    });
  }

  return { contacts, emailCount, phoneCount };
}

export async function extractCompanyContacts(companyId: string): Promise<{ personsCount: number; contactsCount: number; status: 'done' | 'no_results' }> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { crawledPages: true }
  });

  if (!company) {
    throw new Error('Firma nebyla nalezena');
  }

  if (company.crawledPages.length === 0) {
    throw new Error('Firma nemá stažené stránky');
  }

  await prisma.processingLog.create({
    data: {
      batchId: company.batchId,
      companyId: company.id,
      step: 'extract_contacts',
      status: 'info',
      message: 'Starting contact extraction'
    }
  });

  const personMap = new Map<string, CandidatePerson>();
  const contactMap = new Map<string, CandidateContact & { hits: number }>();
  let pagesWithErrors = 0;

  for (const page of company.crawledPages) {
    try {
      const text = normalizeWhitespace(`${page.textContent ?? ''} ${page.htmlContent ?? ''}`);
      if (!text) {
        await prisma.processingLog.create({
          data: {
            batchId: company.batchId,
            companyId: company.id,
            step: 'extract_contacts',
            status: 'warning',
            message: 'No text content on page',
            detailJson: { sourcePageId: page.id, sourceUrl: page.url }
          }
        });
        continue;
      }

      const persons = extractPeople(text, page.id, page.url);
      for (const person of persons) {
        const existing = personMap.get(person.key);
        if (!existing || person.confidenceScore > existing.confidenceScore) {
          personMap.set(person.key, person);
        }
      }

      const { contacts, emailCount, phoneCount } = extractContacts(text, page.id, page.url, company.websiteDomain, persons);

      await prisma.processingLog.create({
        data: {
          batchId: company.batchId,
          companyId: company.id,
          step: 'extract_contacts',
          status: 'info',
          message: 'Page extraction finished',
          detailJson: { sourcePageId: page.id, sourceUrl: page.url, emailCount, phoneCount, personCount: persons.length }
        }
      });

      for (const person of persons) {
        await prisma.processingLog.create({
          data: {
            batchId: company.batchId,
            companyId: company.id,
            step: 'extract_contacts',
            status: 'info',
            message: 'Person candidate found',
            detailJson: { sourcePageId: person.sourcePageId, sourceUrl: person.sourceUrl, fullName: person.fullName, position: person.position }
          }
        });
      }

      for (const contact of contacts) {
        const key = `${contact.contactType}|${contact.normalizedValue}`;
        const existing = contactMap.get(key);

        if (!existing) {
          contactMap.set(key, { ...contact, hits: 1 });
        } else {
          existing.hits += 1;
          existing.confidenceScore = Math.min(100, existing.confidenceScore + 4);
          contactMap.set(key, existing);
          await prisma.processingLog.create({
            data: {
              batchId: company.batchId,
              companyId: company.id,
              step: 'extract_contacts',
              status: 'info',
              message: 'Duplicate contact skipped',
              detailJson: { sourcePageId: contact.sourcePageId, sourceUrl: contact.sourceUrl, normalizedValue: contact.normalizedValue, reason: 'existing_normalized_value' }
            }
          });
        }

        await prisma.processingLog.create({
          data: {
            batchId: company.batchId,
            companyId: company.id,
            step: 'extract_contacts',
            status: 'info',
            message: contact.contactType.includes('email') ? 'Email found' : 'Phone found',
            detailJson: { sourcePageId: contact.sourcePageId, sourceUrl: contact.sourceUrl, contactType: contact.contactType, value: contact.value }
          }
        });
      }
    } catch (error) {
      pagesWithErrors += 1;
      await prisma.processingLog.create({
        data: {
          batchId: company.batchId,
          companyId: company.id,
          step: 'extract_contacts',
          status: 'warning',
          message: 'Page extraction failed',
          detailJson: { sourcePageId: page.id, sourceUrl: page.url, error: String(error) }
        }
      });
    }
  }

  const contactCandidates = [...contactMap.values()];
  const nonSystemEmails = contactCandidates.filter((c) => !detectSystemEmail(c.normalizedValue));
  const filteredContacts = nonSystemEmails.length > 0 ? contactCandidates.filter((c) => c.contactType !== 'email' && c.contactType !== 'general_email' ? true : !detectSystemEmail(c.normalizedValue)) : contactCandidates;

  await prisma.$transaction(async (tx) => {
    await tx.companyPerson.deleteMany({ where: { companyId: company.id } });
    await tx.companyContact.deleteMany({ where: { companyId: company.id } });

    const personIdByKey = new Map<string, string>();
    for (const person of personMap.values()) {
      const created = await tx.companyPerson.create({
        data: {
          companyId: company.id,
          fullName: person.fullName,
          firstName: person.firstName,
          lastName: person.lastName,
          position: person.position,
          department: person.department,
          sourceUrl: person.sourceUrl,
          sourcePageId: person.sourcePageId,
          contextText: person.contextText,
          extractionMethod: 'regex',
          confidenceScore: person.confidenceScore,
          reviewStatus: 'unreviewed'
        }
      });
      personIdByKey.set(person.key, created.id);
    }

    for (const contact of filteredContacts) {
      const personId = contact.personKey ? personIdByKey.get(contact.personKey) ?? null : null;
      await tx.companyContact.create({
        data: {
          companyId: company.id,
          personId,
          contactType: contact.contactType,
          value: contact.value,
          normalizedValue: contact.normalizedValue,
          sourceUrl: contact.sourceUrl,
          sourcePageId: contact.sourcePageId,
          contextText: contact.contextText,
          extractionMethod: 'regex',
          confidenceScore: contact.confidenceScore,
          reviewStatus: 'unreviewed'
        }
      });

      if (personId) {
        await tx.processingLog.create({
          data: {
            batchId: company.batchId,
            companyId: company.id,
            step: 'extract_contacts',
            status: 'info',
            message: 'Contact linked to person',
            detailJson: { sourcePageId: contact.sourcePageId, sourceUrl: contact.sourceUrl, normalizedValue: contact.normalizedValue }
          }
        });
      }
    }

    const personsCount = personMap.size;
    const contactsCount = filteredContacts.length;

    await tx.company.update({
      where: { id: company.id },
      data: {
        personsCount,
        contactsCount,
        extractedAt: new Date(),
        extractionErrorMessage: pagesWithErrors > 0 ? `Failed pages: ${pagesWithErrors}` : null,
        errorMessage: null,
        status: contactsCount > 0 || personsCount > 0 ? 'done' : 'no_results'
      }
    });
  });

  const personsCount = personMap.size;
  const contactsCount = filteredContacts.length;

  await prisma.processingLog.create({
    data: {
      batchId: company.batchId,
      companyId: company.id,
      step: 'extract_contacts',
      status: contactsCount > 0 || personsCount > 0 ? 'success' : 'warning',
      message: contactsCount > 0 || personsCount > 0 ? 'Contact extraction completed' : 'No contacts found',
      detailJson: {
        personsCount,
        contactsCount,
        failedPages: pagesWithErrors
      }
    }
  });

  return {
    personsCount,
    contactsCount,
    status: contactsCount > 0 || personsCount > 0 ? 'done' : 'no_results'
  };
}

export async function extractContactsForBatch(batchId: string): Promise<{ processed: number; successCount: number; errorCount: number }> {
  const companies = await prisma.company.findMany({
    where: {
      batchId,
      status: 'extracting'
    },
    orderBy: { createdAt: 'asc' }
  });

  let successCount = 0;
  let errorCount = 0;

  for (const company of companies) {
    try {
      await extractCompanyContacts(company.id);
      successCount += 1;
    } catch (error) {
      errorCount += 1;
      const message = error instanceof Error ? error.message : 'Contact extraction failed';
      await prisma.company.update({
        where: { id: company.id },
        data: {
          status: 'error',
          extractionErrorMessage: message,
          errorMessage: message
        }
      });
      await prisma.processingLog.create({
        data: {
          batchId,
          companyId: company.id,
          step: 'extract_contacts',
          status: 'error',
          message: 'Contact extraction failed',
          detailJson: { error: message }
        }
      });
    }
  }

  return { processed: companies.length, successCount, errorCount };
}

export async function updateContactReviewStatus(contactId: string, reviewStatus: 'confirmed' | 'rejected' | 'manually_edited') {
  return prisma.companyContact.update({
    where: { id: contactId },
    data: { reviewStatus }
  });
}

export async function updatePersonReviewStatus(personId: string, reviewStatus: 'confirmed' | 'rejected' | 'manually_edited') {
  return prisma.companyPerson.update({
    where: { id: personId },
    data: { reviewStatus }
  });
}
