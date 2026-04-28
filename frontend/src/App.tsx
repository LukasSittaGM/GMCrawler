import { Link, Route, Routes, useParams } from 'react-router-dom';
import { FormEvent, useEffect, useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

type SearchBatch = {
  id: string;
  name: string;
  targetRole: string | null;
  note: string | null;
  status: string;
  totalCount: number;
  processedCount: number;
  currentStep?: string;
  progressPercent?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastErrorMessage?: string | null;
  createdAt: string;
};

type CompanyWebsite = {
  id: string;
  url: string;
  normalizedDomain: string;
  title: string | null;
  snippet: string | null;
  source: string;
  rank: number | null;
  confidenceScore: number;
  isOfficialCandidate: boolean;
  isSelected: boolean;
  reason: string | null;
};

type Company = {
  id: string;
  ico: string;
  companyName: string | null;
  legalForm: string | null;
  addressText: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  registrationStatus: string | null;
  createdDate: string | null;
  dataBoxId: string | null;
  aresLoadedAt: string | null;
  statutoryPersonsJson: unknown;
  websiteUrl: string | null;
  websiteDomain: string | null;
  websiteConfidenceScore: number | null;
  websiteFoundAt: string | null;
  crawledAt: string | null;
  crawledPagesCount: number | null;
  crawlErrorMessage: string | null;
  extractedAt: string | null;
  personsCount: number | null;
  contactsCount: number | null;
  extractionErrorMessage: string | null;
  bestPersonId: string | null;
  bestContactId: string | null;
  bestContactScore: number | null;
  finalPersonId: string | null;
  finalContactId: string | null;
  finalDecisionSource: 'auto' | 'manual' | null;
  finalNote: string | null;
  scoredAt: string | null;
  status: string;
  errorMessage: string | null;
  websites: CompanyWebsite[];
  crawledPages: CrawledPage[];
  persons: CompanyPerson[];
  contacts: CompanyContact[];
  contactScores: ContactScore[];
};
type CompanyPerson = {
  id: string;
  fullName: string;
  position: string | null;
  department: string | null;
  confidenceScore: number;
  sourceUrl: string;
  contextText: string;
  reviewStatus: string;
  isSelected: boolean;
  manuallyEdited: boolean;
};
type CompanyContact = {
  id: string;
  contactType: string;
  value: string;
  confidenceScore: number;
  sourceUrl: string;
  contextText: string;
  reviewStatus: string;
  isSelected: boolean;
  manuallyEdited: boolean;
  person: Pick<CompanyPerson, 'id' | 'fullName'> | null;
};
type ContactScore = {
  id: string;
  contactId: string | null;
  score: number;
  category: 'high' | 'medium' | 'low' | 'needs_review';
  targetRole: string;
  reasonsJson: Array<{ type: string; points: number; message: string }>;
  person: Pick<CompanyPerson, 'id' | 'fullName' | 'position'> | null;
  contact: Pick<CompanyContact, 'id' | 'contactType' | 'value'> | null;
};

type CrawledPage = {
  id: string;
  url: string;
  title: string | null;
  textContent: string | null;
  htmlContent: string | null;
  httpStatus: number | null;
  depth: number;
  crawlStatus: string;
  errorMessage: string | null;
  createdAt: string;
};

type ImportLog = {
  id: string;
  rowNumber: number;
  rawValue: string;
  normalizedIco: string | null;
  status: string;
  message: string | null;
};

type ProcessingLog = {
  id: string;
  companyId: string | null;
  step: string;
  status: string;
  message: string;
  createdAt: string;
};

type SearchBatchDetail = SearchBatch & {
  companies: Company[];
  importLogs: ImportLog[];
  processingLogs: ProcessingLog[];
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const targetUrl = `${API_BASE_URL}${url}`;
  let response: Response;

  try {
    response = await fetch(targetUrl, { credentials: 'include', ...init });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown network error';
    throw new Error(`Network request failed: ${targetUrl} (${message})`);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body.error?.message ?? body.error ?? `HTTP ${response.status}`;
    throw new Error(`Request failed: ${targetUrl} (${response.status} ${response.statusText}) - ${detail}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  return <div><h1>Přihlášení</h1><form onSubmit={submit} className="form"><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" /><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Heslo" />{error && <p className="error">{error}</p>}<button className="button" type="submit">Přihlásit</button></form></div>;
}

function scoreCategoryLabel(category: ContactScore['category'] | null | undefined): string {
  if (!category) {
    return '—';
  }

  const labels: Record<ContactScore['category'], string> = {
    high: 'Vysoké',
    medium: 'Střední',
    low: 'Nízké',
    needs_review: 'Nutná kontrola'
  };

  return labels[category];
}

function BatchListPage() {
  const [batches, setBatches] = useState<SearchBatch[]>([]);
  const [dashboard, setDashboard] = useState<{ batchCount: number; companyCount: number; doneCount: number; errorCount: number; pendingReview: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setBatches(await api<SearchBatch[]>('/search-batches'));
      setDashboard(await api('/dashboard'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nepodařilo se načíst dávky');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <div className="row-between">
        <h1>Dávky IČO</h1>
        <Link to="/batches/new" className="button">Nová dávka</Link>
      </div>
      {error && <p className="error">{error}</p>}
      {dashboard && <div className="card"><p>Dávek: {dashboard.batchCount} | Firem: {dashboard.companyCount} | Hotovo: {dashboard.doneCount} | Chyby: {dashboard.errorCount} | Čeká na validaci: {dashboard.pendingReview}</p></div>}
      <table>
        <thead>
          <tr>
            <th>Název</th>
            <th>Hledaná role</th>
            <th>Stav</th>
            <th>Počet IČO</th>
            <th>Vytvořeno</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td><Link to={`/batches/${batch.id}`}>{batch.name}</Link></td>
              <td>{batch.targetRole ?? '—'}</td>
              <td>{batch.status}</td>
              <td>{batch.totalCount}</td>
              <td>{new Date(batch.createdAt).toLocaleString('cs-CZ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewBatchPage() {
  const [name, setName] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Název dávky je povinný');
      return;
    }

    if (!file) {
      setError('Soubor je povinný');
      return;
    }

    if (!(file.name.endsWith('.csv') || file.name.endsWith('.xlsx'))) {
      setError('Soubor musí být CSV nebo XLSX');
      return;
    }

    try {
      const batch = await api<SearchBatch>('/search-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, targetRole: targetRole || null, note: note || null })
      });

      const form = new FormData();
      form.append('file', file);

      await api(`/search-batches/${batch.id}/import`, {
        method: 'POST',
        body: form
      });

      window.location.href = `/batches/${batch.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operace selhala');
    }
  };

  return (
    <div>
      <h1>Nová dávka</h1>
      <form onSubmit={submit} className="form">
        <label>Název dávky
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>Hledaná role
          <input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} />
        </label>
        <label>Poznámka
          <textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label>CSV/XLSX soubor
          <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="button">Vytvořit/importovat</button>
      </form>
      <Link to="/">Zpět na seznam</Link>
    </div>
  );
}

function CompanyDetail({ company, onSelect, onChanged }: { company: Company; onSelect: (url: string) => Promise<void>; onChanged: () => Promise<void> }) {
  const [manualWebsiteUrl, setManualWebsiteUrl] = useState('');
  const [newPersonName, setNewPersonName] = useState('');
  const [newPersonPosition, setNewPersonPosition] = useState('');
  const [newPersonContactType, setNewPersonContactType] = useState<'email' | 'phone'>('email');
  const [newPersonContactValue, setNewPersonContactValue] = useState('');
  const [newContactType, setNewContactType] = useState<'email' | 'phone' | 'general_email' | 'general_phone'>('email');
  const [newContactValue, setNewContactValue] = useState('');
  const [newContactPersonId, setNewContactPersonId] = useState<string>('');
  const [editPersonId, setEditPersonId] = useState<string | null>(null);
  const [editPersonName, setEditPersonName] = useState('');
  const [editPersonPosition, setEditPersonPosition] = useState('');
  const [editContactId, setEditContactId] = useState<string | null>(null);
  const [editContactValue, setEditContactValue] = useState('');
  const [editContactType, setEditContactType] = useState<'email' | 'phone' | 'general_email' | 'general_phone' | 'other'>('email');
  const [localError, setLocalError] = useState<string | null>(null);

  const reviewContact = async (contactId: string, reviewStatus: 'confirmed' | 'rejected' | 'manually_edited') => {
    setLocalError(null);
    try {
      await api(`/contacts/${contactId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewStatus })
      });
      await onChanged();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Uložení review statusu selhalo');
    }
  };

  const reviewPerson = async (personId: string, reviewStatus: 'confirmed' | 'rejected' | 'manually_edited') => {
    setLocalError(null);
    try {
      await api(`/company-persons/${personId}/review-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewStatus })
      });
      await onChanged();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Uložení review statusu osoby selhalo');
    }
  };

  const savePersonEdit = async () => {
    if (!editPersonId) return;
    setLocalError(null);
    try {
      await api(`/persons/${editPersonId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: editPersonName, position: editPersonPosition || null })
      });
      setEditPersonId(null);
      await onChanged();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Editace osoby selhala');
    }
  };

  const saveContactEdit = async () => {
    if (!editContactId) return;
    setLocalError(null);
    try {
      const result = await api<{ warning?: string }>(`/contacts/${editContactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editContactValue, contactType: editContactType })
      });
      if (result.warning) {
        setLocalError(result.warning);
      }
      setEditContactId(null);
      await onChanged();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Editace kontaktu selhala');
    }
  };

  const addManualPerson = async () => {
    setLocalError(null);
    try {
      const result = await api<{ warning?: string }>(`/companies/${company.id}/persons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: newPersonName || undefined,
          position: newPersonPosition || null,
          contactType: newPersonContactValue ? newPersonContactType : undefined,
          contactValue: newPersonContactValue || undefined
        })
      });
      if (result.warning) {
        setLocalError(result.warning);
      }
      setNewPersonName('');
      setNewPersonPosition('');
      setNewPersonContactValue('');
      await onChanged();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Vytvoření osoby selhalo');
    }
  };

  const addManualContact = async () => {
    setLocalError(null);
    try {
      const result = await api<{ warning?: string }>(`/companies/${company.id}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personId: newContactPersonId || null,
          contactType: newContactType,
          value: newContactValue
        })
      });
      if (result.warning) {
        setLocalError(result.warning);
      }
      setNewContactValue('');
      await onChanged();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Vytvoření kontaktu selhalo');
    }
  };

  const setFinalContact = async (payload: { personId?: string | null; contactId?: string | null }) => {
    setLocalError(null);
    try {
      await api(`/companies/${company.id}/select-final-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await onChanged();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Nastavení finálního kontaktu selhalo');
    }
  };

  const bestContact = company.contactScores.find((item) => item.contactId === company.bestContactId) ?? company.contactScores[0];
  const bestPerson = company.contactScores.find((item) => item.person?.id === company.bestPersonId)?.person
    ?? bestContact?.person
    ?? null;
  const finalContact = company.contacts.find((item) => item.id === company.finalContactId) ?? null;
  const finalPerson = company.persons.find((item) => item.id === company.finalPersonId)
    ?? (finalContact?.person ? company.persons.find((item) => item.id === finalContact.person?.id) ?? null : null);

  return (
    <details>
      <summary>Detail firmy: {company.companyName ?? company.ico}</summary>
      {localError && <p className="error">{localError}</p>}
      <ul>
        <li><strong>Právní forma:</strong> {company.legalForm ?? '—'}</li>
        <li><strong>Adresa:</strong> {company.addressText ?? '—'}</li>
      </ul>

      <h3>Finální kontakt</h3>
      <div className="final-contact-block">
        <p><strong>Osoba:</strong> {finalPerson?.fullName ?? bestPerson?.fullName ?? '—'}</p>
        <p><strong>Kontakt:</strong> {finalContact ? `${finalContact.contactType}: ${finalContact.value}` : (bestContact?.contact ? `${bestContact.contact.contactType}: ${bestContact.contact.value}` : '—')}</p>
        <p><strong>Zdroj rozhodnutí:</strong> <span className={company.finalDecisionSource === 'manual' ? 'badge-manual' : 'badge-auto'}>{company.finalDecisionSource ?? 'auto'}</span></p>
        <p><strong>Poznámka:</strong> {company.finalNote ?? '—'}</p>
      </div>

      <h3>Web firmy</h3>
      <p><strong>Vybraný web:</strong> {company.websiteUrl ? <a href={company.websiteUrl} target="_blank" rel="noreferrer">{company.websiteUrl}</a> : '—'}</p>
      <div className="manual-pick">
        <input placeholder="https://www.firma.cz" value={manualWebsiteUrl} onChange={(e) => setManualWebsiteUrl(e.target.value)} />
        <button className="button" onClick={() => { void onSelect(manualWebsiteUrl); setManualWebsiteUrl(''); }}>Nastavit ručně</button>
      </div>

      <h4>Osoby</h4>
      <table><thead><tr><th>Jméno</th><th>Pozice</th><th>Confidence</th><th>Status</th><th>Akce</th></tr></thead><tbody>
        {company.persons.map((person) => (
          <tr key={person.id} className={person.isSelected ? 'selected-row' : undefined}>
            <td>{person.fullName} {person.manuallyEdited ? <span className="badge-manual">manual</span> : <span className="badge-auto">auto</span>}</td>
            <td>{person.position ?? '—'}</td>
            <td>{person.confidenceScore}</td>
            <td>{person.reviewStatus}</td>
            <td>
              <button className="button" onClick={() => void reviewPerson(person.id, 'confirmed')}>Potvrdit</button>{' '}
              <button className="button" onClick={() => void reviewPerson(person.id, 'rejected')}>Zamítnout</button>{' '}
              <button className="button" onClick={() => { setEditPersonId(person.id); setEditPersonName(person.fullName); setEditPersonPosition(person.position ?? ''); }}>Upravit</button>{' '}
              <button className="button" onClick={() => void setFinalContact({ personId: person.id })}>Nastavit jako finální</button>
            </td>
          </tr>
        ))}
      </tbody></table>
      {editPersonId && (
        <div className="manual-pick">
          <input value={editPersonName} onChange={(e) => setEditPersonName(e.target.value)} placeholder="Jméno" />
          <input value={editPersonPosition} onChange={(e) => setEditPersonPosition(e.target.value)} placeholder="Pozice" />
          <button className="button" onClick={() => void savePersonEdit()}>Uložit osobu</button>
        </div>
      )}

      <h4>Kontakty</h4>
      <table><thead><tr><th>Typ</th><th>Hodnota</th><th>Osoba</th><th>Confidence</th><th>Status</th><th>Akce</th></tr></thead><tbody>
        {company.contacts.map((contact) => (
          <tr key={contact.id} className={contact.isSelected ? 'selected-row' : undefined}>
            <td>{contact.contactType}</td>
            <td>{contact.value} {contact.manuallyEdited ? <span className="badge-manual">manual</span> : <span className="badge-auto">auto</span>}</td>
            <td>{contact.person?.fullName ?? '—'}</td>
            <td className={contact.confidenceScore >= 80 ? 'confidence-high' : 'confidence-low'}>{contact.confidenceScore}</td>
            <td>{contact.reviewStatus}</td>
            <td>
              <button className="button" onClick={() => void reviewContact(contact.id, 'confirmed')}>Potvrdit</button>{' '}
              <button className="button" onClick={() => void reviewContact(contact.id, 'rejected')}>Zamítnout</button>{' '}
              <button className="button" onClick={() => { setEditContactId(contact.id); setEditContactValue(contact.value); setEditContactType(contact.contactType as 'email' | 'phone' | 'general_email' | 'general_phone' | 'other'); }}>Upravit</button>{' '}
              <button className="button" onClick={() => void setFinalContact({ personId: contact.person?.id ?? null, contactId: contact.id })}>Nastavit jako finální</button>
            </td>
          </tr>
        ))}
      </tbody></table>

      {editContactId && (
        <div className="manual-pick">
          <select value={editContactType} onChange={(e) => setEditContactType(e.target.value as 'email' | 'phone' | 'general_email' | 'general_phone' | 'other')}>
            <option value="email">email</option><option value="phone">phone</option><option value="general_email">general_email</option><option value="general_phone">general_phone</option><option value="other">other</option>
          </select>
          <input value={editContactValue} onChange={(e) => setEditContactValue(e.target.value)} placeholder="Hodnota" />
          <button className="button" onClick={() => void saveContactEdit()}>Uložit kontakt</button>
        </div>
      )}

      <h4>+ Přidat kontakt / osobu</h4>
      <div className="manual-grid">
        <div>
          <h5>Nová osoba</h5>
          <input value={newPersonName} onChange={(e) => setNewPersonName(e.target.value)} placeholder="Jméno osoby" />
          <input value={newPersonPosition} onChange={(e) => setNewPersonPosition(e.target.value)} placeholder="Pozice" />
          <select value={newPersonContactType} onChange={(e) => setNewPersonContactType(e.target.value as 'email' | 'phone')}><option value="email">email</option><option value="phone">phone</option></select>
          <input value={newPersonContactValue} onChange={(e) => setNewPersonContactValue(e.target.value)} placeholder="Volitelný kontakt" />
          <button className="button" onClick={() => void addManualPerson()}>Vytvořit osobu</button>
        </div>
        <div>
          <h5>Nový kontakt</h5>
          <select value={newContactType} onChange={(e) => setNewContactType(e.target.value as 'email' | 'phone' | 'general_email' | 'general_phone')}>
            <option value="email">email</option><option value="phone">phone</option><option value="general_email">general_email</option><option value="general_phone">general_phone</option>
          </select>
          <input value={newContactValue} onChange={(e) => setNewContactValue(e.target.value)} placeholder="Hodnota kontaktu" />
          <select value={newContactPersonId} onChange={(e) => setNewContactPersonId(e.target.value)}>
            <option value="">Bez osoby</option>
            {company.persons.map((person) => <option key={person.id} value={person.id}>{person.fullName}</option>)}
          </select>
          <button className="button" onClick={() => void addManualContact()}>Vytvořit kontakt</button>
        </div>
      </div>
    </details>
  );
}

function BatchDetailPage() {
  const { id } = useParams();
  const [batch, setBatch] = useState<SearchBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!id) {
      return;
    }

    try {
      setError(null);
      setBatch(await api<SearchBatchDetail>(`/search-batches/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nepodařilo se načíst detail dávky');
    }
  };

  useEffect(() => {
    void load();
  }, [id]);

  const startProcessing = async () => {
    if (!id) {
      return;
    }

    setLoading(true);
    try {
      await api(`/search-batches/${id}/run-full-pipeline`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Spuštění dávky selhalo');
    } finally {
      setLoading(false);
    }
  };

  const retryFailed = async () => { if (!id) return; setLoading(true); try { await api(`/search-batches/${id}/retry-failed`, { method: 'POST' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Retry failed'); } finally { setLoading(false); } };


  const downloadExport = async (format: 'csv' | 'xlsx') => {
    if (!id) {
      return;
    }

    setLoading(true);
    try {
      const targetUrl = `${API_BASE_URL}/search-batches/${id}/export.${format}`;
      const response = await fetch(targetUrl, { credentials: 'include' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? 'Export selhal');
      }

      const blob = await response.blob();
      const now = new Date();
      const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const fileName = `contacts-export-${id}-${datePart}.${format}`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stažení exportu selhalo');
    } finally {
      setLoading(false);
    }
  };

  const reloadCompanyAres = async (companyId: string) => {
    setLoading(true);
    try {
      await api(`/companies/${companyId}/reload-ares`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reload ARES selhal');
    } finally {
      setLoading(false);
    }
  };

  const findCompanyWebsite = async (companyId: string) => {
    setLoading(true);
    try {
      await api(`/companies/${companyId}/find-website`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vyhledání webu firmy selhalo');
    } finally {
      setLoading(false);
    }
  };

  const setManualWebsite = async (companyId: string, websiteUrl: string) => {
    if (!websiteUrl.trim()) {
      return;
    }

    setLoading(true);
    try {
      await api(`/companies/${companyId}/website`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl })
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ruční nastavení webu selhalo');
    } finally {
      setLoading(false);
    }
  };

  if (error) {
    return <p className="error">{error}</p>;
  }

  if (!batch) {
    return <p>Načítám…</p>;
  }

  return (
    <div>
      <Link to="/">← Zpět na dávky</Link>
      <div className="row-between">
        <h1>{batch.name}</h1>
        <div>
          <button className="button" onClick={() => void startProcessing()} disabled={loading}>Spustit zpracování</button>{' '}
          <button className="button" onClick={() => void retryFailed()} disabled={loading}>Retry failed</button>{' '}
          <button className="button" onClick={() => void downloadExport('csv')} disabled={loading}>Export CSV</button>{' '}
          <button className="button" onClick={() => void downloadExport('xlsx')} disabled={loading}>Export XLSX</button>{' '}
          <button className="button" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
      </div>
      <p><strong>Role:</strong> {batch.targetRole ?? '—'}</p>
      <p><strong>Stav dávky:</strong> {batch.status}</p>
      <p><strong>Aktuální krok:</strong> {batch.currentStep ?? '—'}</p>
      <p><strong>Zpracováno:</strong> {batch.processedCount} / {batch.totalCount} ({(batch as SearchBatch & { progressPercent?: number }).progressPercent ?? 0}%)</p>

      <h2>Firmy</h2>
      <table>
        <thead>
          <tr>
            <th>IČO</th>
            <th>Název firmy</th>
            <th>Adresa</th>
            <th>Web firmy</th>
            <th>Website confidence</th>
            <th>Počet stažených stránek</th>
            <th>Počet osob</th>
            <th>Počet kontaktů</th>
            <th>Nejlepší kontakt</th>
            <th>Nejlepší osoba</th>
            <th>Score</th>
            <th>Kategorie</th>
            <th>targetRole</th>
            <th>Stav extrakce</th>
            <th>Chyba extrakce</th>
            <th>Akce</th>
          </tr>
        </thead>
        <tbody>
          {batch.companies.map((company) => (
            <tr key={company.id}>
              <td>{company.ico}</td>
              <td>{company.companyName ?? '—'}</td>
              <td>{company.addressText ?? '—'}</td>
              <td>{company.websiteUrl ? <a href={company.websiteUrl} target="_blank" rel="noreferrer">{company.websiteDomain ?? company.websiteUrl}</a> : '—'}</td>
              <td>{company.websiteConfidenceScore ?? '—'}</td>
              <td>{company.crawledPagesCount ?? 0}</td>
              <td>{company.personsCount ?? 0}</td>
              <td>{company.contactsCount ?? 0}</td>
              <td>{company.contactScores.find((item) => item.contactId === company.bestContactId)?.contact?.value ?? '—'}</td>
              <td>{company.contactScores.find((item) => item.person?.id === company.bestPersonId)?.person?.fullName ?? '—'}</td>
              <td>{company.bestContactScore ?? '—'}</td>
              <td>{scoreCategoryLabel(company.contactScores.find((item) => item.contactId === company.bestContactId)?.category)}</td>
              <td>{company.contactScores.find((item) => item.contactId === company.bestContactId)?.targetRole ?? batch.targetRole ?? '—'}</td>
              <td>{company.status}</td>
              <td>{company.extractionErrorMessage ?? company.crawlErrorMessage ?? company.errorMessage ?? '—'}</td>
              <td>
                <button className="button" onClick={() => void reloadCompanyAres(company.id)} disabled={loading}>Reload ARES</button>{' '}
                <button className="button" onClick={() => void findCompanyWebsite(company.id)} disabled={loading}>Najít web</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {batch.companies.map((company) => (
        <CompanyDetail
          key={`${company.id}-detail`}
          company={company}
          onSelect={async (url) => setManualWebsite(company.id, url)}
          onChanged={load}
        />
      ))}

      <h2>Processing log</h2>
      <table>
        <thead>
          <tr>
            <th>Čas</th>
            <th>Krok</th>
            <th>Status</th>
            <th>Firma</th>
            <th>Zpráva</th>
          </tr>
        </thead>
        <tbody>
          {batch.processingLogs.map((log) => (
            <tr key={log.id}>
              <td>{new Date(log.createdAt).toLocaleString('cs-CZ')}</td>
              <td>{log.step}</td>
              <td>{log.status}</td>
              <td>{log.companyId ?? '—'}</td>
              <td>{log.message}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Import log</h2>
      <table>
        <thead>
          <tr>
            <th>Řádek</th>
            <th>Raw hodnota</th>
            <th>Normalizované IČO</th>
            <th>Status</th>
            <th>Zpráva</th>
          </tr>
        </thead>
        <tbody>
          {batch.importLogs.map((log) => (
            <tr key={log.id}>
              <td>{log.rowNumber}</td>
              <td>{log.rawValue}</td>
              <td>{log.normalizedIco ?? '—'}</td>
              <td>{log.status}</td>
              <td>{log.message ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api('/search-batches').then(() => setAuthenticated(true)).catch(() => setAuthenticated(false)).finally(() => setChecked(true));
  }, []);

  if (!checked) return <main className="container"><p>Načítám…</p></main>;
  if (!authenticated) return <main className="container"><LoginPage onLogin={() => setAuthenticated(true)} /></main>;

  return (
    <main className="container">
      <div className="row-between"><span /></div>
      <button className="button" onClick={() => { void api('/logout', { method: 'POST' }).finally(() => setAuthenticated(false)); }}>Odhlásit</button>
      <Routes>
        <Route path="/" element={<BatchListPage />} />
        <Route path="/batches/new" element={<NewBatchPage />} />
        <Route path="/batches/:id" element={<BatchDetailPage />} />
      </Routes>
    </main>
  );
}
