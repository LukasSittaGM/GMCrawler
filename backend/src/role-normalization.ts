export type NormalizedTargetRole =
  | 'management'
  | 'finance'
  | 'hr'
  | 'it'
  | 'sales'
  | 'marketing'
  | 'fleet'
  | 'custom';

const ROLE_ALIASES: Array<{ normalized: Exclude<NormalizedTargetRole, 'custom'>; terms: string[] }> = [
  {
    normalized: 'management',
    terms: ['ceo', 'jednatel', 'ředitel', 'director', 'coo', 'owner', 'majitel', 'vedeni', 'vedení']
  },
  {
    normalized: 'finance',
    terms: ['cfo', 'finance', 'finanční', 'financni', 'účetní', 'ucetni', 'fakturace', 'accounting']
  },
  {
    normalized: 'hr',
    terms: ['hr', 'personalista', 'recruiter', 'nábor', 'nabor', 'lidské zdroje', 'lidske zdroje']
  },
  {
    normalized: 'it',
    terms: ['cto', 'cio', 'it manager', 'it', 'správce it', 'spravce it', 'administrator']
  },
  {
    normalized: 'sales',
    terms: ['obchod', 'sales', 'account manager', 'key account']
  },
  {
    normalized: 'marketing',
    terms: ['marketing', 'pr', 'brand manager', 'social media']
  },
  {
    normalized: 'fleet',
    terms: ['fleet', 'vozový park', 'vozovy park', 'facility', 'správa majetku', 'sprava majetku']
  }
];

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function normalizeTargetRole(targetRole: string | null | undefined): NormalizedTargetRole | null {
  if (!targetRole?.trim()) {
    return null;
  }

  const normalizedInput = normalizeText(targetRole);
  for (const role of ROLE_ALIASES) {
    if (role.terms.some((term) => normalizedInput.includes(normalizeText(term)))) {
      return role.normalized;
    }
  }

  return 'custom';
}

