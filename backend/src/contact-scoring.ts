import { ContactScoreCategory, ContactType, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

type ReasonItem = {
  type: string;
  points: number;
  message: string;
};

type RoleKey = 'finance' | 'HR' | 'obchod' | 'marketing' | 'IT' | 'management' | 'fleet';

const ROLE_KEYWORDS: Record<RoleKey, string[]> = {
  finance: [
    'cfo', 'finanční ředitel', 'finanční ředitelka', 'finance manager', 'finanční manažer', 'ekonom', 'ekonomka', 'účetní', 'hlavní účetní', 'fakturace'
  ],
  HR: [
    'hr', 'personalista', 'personalistka', 'hr manažer', 'hr manager', 'lidské zdroje', 'nábor', 'recruiter', 'people manager'
  ],
  obchod: [
    'obchod', 'obchodní ředitel', 'obchodní ředitelka', 'obchodní manažer', 'sales', 'sales manager', 'key account', 'account manager'
  ],
  marketing: [
    'marketing', 'marketingový manažer', 'marketing manager', 'komunikace', 'pr', 'brand manager', 'social media'
  ],
  IT: [
    'it', 'cio', 'cto', 'it manažer', 'správce it', 'admin', 'systémový administrátor', 'digitalizace'
  ],
  management: [
    'jednatel', 'jednatelka', 'ředitel', 'ředitelka', 'ceo', 'coo', 'provozní ředitel', 'výkonný ředitel', 'majitel', 'owner'
  ],
  fleet: [
    'fleet', 'vozový park', 'správa vozidel', 'car fleet', 'facility manager', 'provozní manažer', 'správa majetku'
  ]
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function normalizeRole(role: string | null | undefined): RoleKey | null {
  if (!role) {
    return null;
  }

  const lowered = role.trim().toLowerCase();
  const aliasMap: Record<string, RoleKey> = {
    finance: 'finance',
    finanční: 'finance',
    hr: 'HR',
    lidské_zdroje: 'HR',
    obchod: 'obchod',
    sales: 'obchod',
    marketing: 'marketing',
    it: 'IT',
    management: 'management',
    vedení: 'management',
    fleet: 'fleet',
    vozový_park: 'fleet'
  };

  if (aliasMap[lowered]) {
    return aliasMap[lowered];
  }

  return (Object.keys(ROLE_KEYWORDS) as RoleKey[]).find((key) => lowered.includes(key.toLowerCase())) ?? null;
}

function getDomain(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function resolveCategory(score: number, needsReview: boolean): ContactScoreCategory {
  if (needsReview || score <= 24) {
    return 'needs_review';
  }
  if (score >= 80) {
    return 'high';
  }
  if (score >= 55) {
    return 'medium';
  }
  return 'low';
}

function isRoleGeneralEmailMatch(value: string, roleKeywords: string[]): string | null {
  const local = value.split('@')[0] ?? '';
  const localLower = local.toLowerCase();
  const matched = roleKeywords.find((keyword) => {
    const token = keyword.toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    if (!token) {
      return false;
    }
    return localLower.includes(token) || localLower.includes(token.slice(0, Math.min(4, token.length)));
  });

  return matched ?? null;
}

function hasRoleKeyword(text: string | null | undefined, roleKeywords: string[]): string | null {
  const lowered = normalizeText(text);
  return roleKeywords.find((keyword) => lowered.includes(keyword.toLowerCase())) ?? null;
}

function isLikelyStatutoryPerson(fullName: string, statutoryPersonsJson: Prisma.JsonValue | null): boolean {
  if (!Array.isArray(statutoryPersonsJson)) {
    return false;
  }

  const needle = fullName.toLowerCase();
  return statutoryPersonsJson.some((item) => {
    if (typeof item === 'string') {
      return item.toLowerCase().includes(needle);
    }
    if (item && typeof item === 'object') {
      const serialized = JSON.stringify(item).toLowerCase();
      return serialized.includes(needle);
    }
    return false;
  });
}

export async function scoreCompanyContacts(companyId: string): Promise<{ scored: number; bestScore: number | null; bestContactId: string | null; bestPersonId: string | null; targetRole: string | null }> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      batch: { select: { targetRole: true } },
      persons: true,
      contacts: true
    }
  });

  if (!company) {
    throw new Error('Firma nebyla nalezena');
  }

  const targetRoleRaw = company.batch.targetRole;
  const normalizedRole = normalizeRole(targetRoleRaw);

  await prisma.contactScore.deleteMany({ where: { companyId: company.id } });

  if (!targetRoleRaw || !normalizedRole) {
    await prisma.company.update({
      where: { id: company.id },
      data: {
        bestPersonId: null,
        bestContactId: null,
        bestContactScore: 0,
        scoredAt: new Date()
      }
    });

    return {
      scored: 0,
      bestScore: 0,
      bestContactId: null,
      bestPersonId: null,
      targetRole: targetRoleRaw
    };
  }

  const roleKeywords = ROLE_KEYWORDS[normalizedRole];
  const companyDomain = normalizeText(company.websiteDomain);
  const personContactMap = new Map<string, { hasPhone: boolean; hasPersonalEmail: boolean }>();

  for (const contact of company.contacts) {
    if (!contact.personId) {
      continue;
    }

    const current = personContactMap.get(contact.personId) ?? { hasPhone: false, hasPersonalEmail: false };
    if (contact.contactType === 'phone') {
      current.hasPhone = true;
    }
    if (contact.contactType === 'email') {
      current.hasPersonalEmail = true;
    }
    personContactMap.set(contact.personId, current);
  }

  const scoresToCreate: Array<{
    companyId: string;
    personId: string | null;
    contactId: string | null;
    targetRole: string;
    score: number;
    category: ContactScoreCategory;
    reasonsJson: Prisma.InputJsonValue;
  }> = [];

  for (const contact of company.contacts) {
    const reasons: ReasonItem[] = [];
    let score = 0;
    const person = contact.personId ? company.persons.find((candidate) => candidate.id === contact.personId) ?? null : null;

    const positionMatch = person ? hasRoleKeyword(person.position, roleKeywords) : null;
    if (positionMatch) {
      reasons.push({ type: 'role_match', points: 35, message: `Pozice obsahuje klíčové slovo ${positionMatch}.` });
      score += 35;
    }

    const departmentMatch = person ? hasRoleKeyword(person.department, roleKeywords) : null;
    if (departmentMatch) {
      reasons.push({ type: 'department_match', points: 25, message: `Oddělení obsahuje klíčové slovo ${departmentMatch}.` });
      score += 25;
    }

    if (person?.position) {
      reasons.push({ type: 'specific_position', points: 10, message: 'Osoba má konkrétní pracovní pozici.' });
      score += 10;
    }

    if (contact.contactType === 'email' && person) {
      reasons.push({ type: 'personal_email', points: 20, message: 'Kontakt má osobní e-mail.' });
      score += 20;
    }

    const personContacts = person ? personContactMap.get(person.id) : null;
    const hasPhoneBonus = contact.contactType === 'phone' || personContacts?.hasPhone;
    if (hasPhoneBonus) {
      reasons.push({ type: 'phone_present', points: 10, message: 'Kontakt má telefon.' });
      score += 10;
    }

    if (contact.contactType === 'general_email') {
      const generalEmailRoleMatch = isRoleGeneralEmailMatch(contact.normalizedValue, roleKeywords);
      if (generalEmailRoleMatch) {
        reasons.push({ type: 'role_general_email', points: 15, message: `Obecný e-mail odpovídá cílové roli (${generalEmailRoleMatch}).` });
        score += 15;
      }
    }

    const sourceDomain = getDomain(contact.sourceUrl);
    const isOfficialSource = Boolean(companyDomain && sourceDomain && sourceDomain.includes(companyDomain));
    if (isOfficialSource) {
      reasons.push({ type: 'official_source', points: 15, message: 'Kontakt je z oficiálního webu firmy.' });
      score += 15;
    } else {
      reasons.push({ type: 'non_official_source', points: -15, message: 'Zdroj není oficiální web firmy.' });
      score -= 15;
    }

    if (contact.contactType === 'email' || contact.contactType === 'general_email') {
      const emailDomain = (contact.normalizedValue.split('@')[1] ?? '').toLowerCase();
      if (companyDomain && emailDomain.includes(companyDomain)) {
        reasons.push({ type: 'domain_match', points: 15, message: 'Doména e-mailu odpovídá webu firmy.' });
        score += 15;
      }
    }

    if (normalizedRole === 'management' && person && isLikelyStatutoryPerson(person.fullName, company.statutoryPersonsJson)) {
      reasons.push({ type: 'statutory_match', points: 25, message: 'Osoba je pravděpodobně statutární zástupce.' });
      score += 25;
    }

    if (!person) {
      reasons.push({ type: 'generic_contact', points: -20, message: 'Obecný kontakt bez přiřazené osoby.' });
      score -= 20;
    }

    const extractionConfidence = Math.max(contact.confidenceScore, person?.confidenceScore ?? 0);
    if (extractionConfidence > 80) {
      reasons.push({ type: 'high_confidence', points: 10, message: 'Extrakční confidence je vyšší než 80.' });
      score += 10;
    } else if (extractionConfidence >= 50) {
      reasons.push({ type: 'medium_confidence', points: 5, message: 'Extrakční confidence je mezi 50 a 80.' });
      score += 5;
    }

    const context = `${contact.contextText ?? ''} ${person?.contextText ?? ''}`.trim();
    if (context.length < 40) {
      reasons.push({ type: 'weak_context', points: -10, message: 'Kontext kontaktu je příliš slabý nebo nejasný.' });
      score -= 10;
    }

    const finalScore = clampScore(score);
    const hasRoleSignal = Boolean(positionMatch || departmentMatch);
    const needsReview = !hasRoleSignal && normalizedRole !== 'management';
    const category = resolveCategory(finalScore, needsReview);

    scoresToCreate.push({
      companyId: company.id,
      personId: person?.id ?? null,
      contactId: contact.id,
      targetRole: targetRoleRaw,
      score: finalScore,
      category,
      reasonsJson: reasons as unknown as Prisma.InputJsonValue
    });
  }

  for (const person of company.persons.filter((candidate) => !company.contacts.some((contact) => contact.personId === candidate.id))) {
    const reasons: ReasonItem[] = [];
    let score = 0;

    const positionMatch = hasRoleKeyword(person.position, roleKeywords);
    if (positionMatch) {
      reasons.push({ type: 'role_match', points: 35, message: `Pozice obsahuje klíčové slovo ${positionMatch}.` });
      score += 35;
    }

    const departmentMatch = hasRoleKeyword(person.department, roleKeywords);
    if (departmentMatch) {
      reasons.push({ type: 'department_match', points: 25, message: `Oddělení obsahuje klíčové slovo ${departmentMatch}.` });
      score += 25;
    }

    if (person.position) {
      reasons.push({ type: 'specific_position', points: 10, message: 'Osoba má konkrétní pracovní pozici.' });
      score += 10;
    }

    if (person.confidenceScore > 80) {
      reasons.push({ type: 'high_confidence', points: 10, message: 'Extrakční confidence je vyšší než 80.' });
      score += 10;
    } else if (person.confidenceScore >= 50) {
      reasons.push({ type: 'medium_confidence', points: 5, message: 'Extrakční confidence je mezi 50 a 80.' });
      score += 5;
    }

    reasons.push({ type: 'missing_contact', points: -20, message: 'Osoba nemá žádný kontakt.' });
    score -= 20;

    const finalScore = clampScore(score);
    scoresToCreate.push({
      companyId: company.id,
      personId: person.id,
      contactId: null,
      targetRole: targetRoleRaw,
      score: finalScore,
      category: resolveCategory(finalScore, true),
      reasonsJson: reasons as unknown as Prisma.InputJsonValue
    });
  }

  if (scoresToCreate.length > 0) {
    await prisma.contactScore.createMany({ data: scoresToCreate });
  }

  const bestContactScore = scoresToCreate
    .filter((item) => item.contactId)
    .sort((a, b) => b.score - a.score)[0] ?? null;

  await prisma.company.update({
    where: { id: company.id },
    data: {
      bestPersonId: bestContactScore?.personId ?? null,
      bestContactId: bestContactScore?.contactId ?? null,
      bestContactScore: bestContactScore?.score ?? 0,
      scoredAt: new Date()
    }
  });

  await prisma.processingLog.create({
    data: {
      batchId: company.batchId,
      companyId: company.id,
      step: 'contact_scoring',
      status: bestContactScore ? 'success' : 'warning',
      message: bestContactScore ? 'Contact scoring completed' : 'Contact scoring found no candidates',
      detailJson: {
        targetRole: targetRoleRaw,
        scoredCandidates: scoresToCreate.length,
        bestContactId: bestContactScore?.contactId ?? null,
        bestPersonId: bestContactScore?.personId ?? null,
        bestScore: bestContactScore?.score ?? null
      }
    }
  });

  return {
    scored: scoresToCreate.length,
    bestScore: bestContactScore?.score ?? null,
    bestContactId: bestContactScore?.contactId ?? null,
    bestPersonId: bestContactScore?.personId ?? null,
    targetRole: targetRoleRaw
  };
}

export async function scoreContactsForBatch(batchId: string): Promise<{ processed: number; scoredCompanies: number; errorCount: number }> {
  const companies = await prisma.company.findMany({
    where: { batchId },
    orderBy: { createdAt: 'asc' },
    select: { id: true }
  });

  let scoredCompanies = 0;
  let errorCount = 0;

  for (const company of companies) {
    try {
      await scoreCompanyContacts(company.id);
      scoredCompanies += 1;
    } catch {
      errorCount += 1;
    }
  }

  return {
    processed: companies.length,
    scoredCompanies,
    errorCount
  };
}
