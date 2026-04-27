import { Link, Route, Routes, useParams } from 'react-router-dom';
import { FormEvent, useEffect, useState } from 'react';

const API = 'http://localhost:3001/api';

type SearchBatch = {
  id: string;
  name: string;
  targetRole: string | null;
  note: string | null;
  status: string;
  totalCount: number;
  processedCount: number;
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
};
type CompanyContact = {
  id: string;
  contactType: string;
  value: string;
  confidenceScore: number;
  sourceUrl: string;
  contextText: string;
  reviewStatus: string;
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
  const response = await fetch(`${API}${url}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? 'Požadavek selhal');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function BatchListPage() {
  const [batches, setBatches] = useState<SearchBatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setBatches(await api<SearchBatch[]>('/search-batches'));
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

function CompanyDetail({ company, onSelect }: { company: Company; onSelect: (url: string) => Promise<void> }) {
  const statutoryPersons = Array.isArray(company.statutoryPersonsJson) ? company.statutoryPersonsJson : [];
  const [manualWebsiteUrl, setManualWebsiteUrl] = useState('');

  const updatePersonReview = async (personId: string, reviewStatus: string) => {
    await api(`/company-persons/${personId}/review-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus })
    });
    window.location.reload();
  };
  const updateContactReview = async (contactId: string, reviewStatus: string) => {
    await api(`/company-contacts/${contactId}/review-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus })
    });
    window.location.reload();
  };

  const reviewOptions = ['confirmed', 'rejected', 'manually_edited'];

  const bestContact = company.contactScores.find((item) => item.contactId === company.bestContactId) ?? company.contactScores[0];

  return (
    <details>
      <summary>Detail firmy: {company.companyName ?? company.ico}</summary>
      <ul>
        <li><strong>Právní forma:</strong> {company.legalForm ?? '—'}</li>
        <li><strong>Adresa:</strong> {company.addressText ?? '—'}</li>
        <li><strong>Město:</strong> {company.city ?? '—'}</li>
        <li><strong>PSČ:</strong> {company.postalCode ?? '—'}</li>
        <li><strong>Země:</strong> {company.country ?? '—'}</li>
        <li><strong>Datum vzniku:</strong> {company.createdDate ? new Date(company.createdDate).toLocaleDateString('cs-CZ') : '—'}</li>
        <li><strong>ARES načteno:</strong> {company.aresLoadedAt ? new Date(company.aresLoadedAt).toLocaleString('cs-CZ') : '—'}</li>
        <li><strong>Statutární osoby:</strong> {statutoryPersons.length > 0 ? JSON.stringify(statutoryPersons) : '—'}</li>
      </ul>

      <h3>Web firmy</h3>
      <p><strong>Vybraný web:</strong> {company.websiteUrl ? <a href={company.websiteUrl} target="_blank" rel="noreferrer">{company.websiteUrl}</a> : '—'}</p>
      <p><strong>Confidence:</strong> {company.websiteConfidenceScore ?? '—'}</p>
      <div className="manual-pick">
        <input
          placeholder="https://www.firma.cz"
          value={manualWebsiteUrl}
          onChange={(e) => setManualWebsiteUrl(e.target.value)}
        />
        <button
          className="button"
          onClick={() => {
            void onSelect(manualWebsiteUrl);
            setManualWebsiteUrl('');
          }}
        >Nastavit ručně</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Vybrat</th>
            <th>URL</th>
            <th>Název výsledku</th>
            <th>Snippet</th>
            <th>Zdroj</th>
            <th>Skóre</th>
            <th>Důvod skóre</th>
          </tr>
        </thead>
        <tbody>
          {company.websites.map((website) => (
            <tr key={website.id}>
              <td>
                <button className="button" onClick={() => void onSelect(website.url)}>
                  {website.isSelected ? 'Vybráno' : 'Vybrat jako web firmy'}
                </button>
              </td>
              <td><a href={website.url} target="_blank" rel="noreferrer">{website.url}</a></td>
              <td>{website.title ?? '—'}</td>
              <td>{website.snippet ?? '—'}</td>
              <td>{website.source}</td>
              <td>{website.confidenceScore}</td>
              <td>{website.reason ?? '—'}</td>
            </tr>
          ))}
          {company.websites.length === 0 && (
            <tr><td colSpan={7}>Žádní kandidáti</td></tr>
          )}
        </tbody>
      </table>

      <h3>Stažené stránky</h3>
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Titulek</th>
            <th>HTTP status</th>
            <th>Depth</th>
            <th>crawlStatus</th>
            <th>Délka textu</th>
            <th>Staženo</th>
            <th>Chyba</th>
          </tr>
        </thead>
        <tbody>
          {company.crawledPages.map((page) => (
            <tr key={page.id}>
              <td><a href={page.url} target="_blank" rel="noreferrer">{page.url}</a></td>
              <td>{page.title ?? '—'}</td>
              <td>{page.httpStatus ?? '—'}</td>
              <td>{page.depth}</td>
              <td>{page.crawlStatus}</td>
              <td>{page.textContent?.length ?? 0}</td>
              <td>{new Date(page.createdAt).toLocaleString('cs-CZ')}</td>
              <td>{page.errorMessage ?? '—'}</td>
            </tr>
          ))}
          {company.crawledPages.length === 0 && (
            <tr><td colSpan={8}>Žádné stažené stránky</td></tr>
          )}
        </tbody>
      </table>

      {company.crawledPages.map((page) => (
        <details key={`${page.id}-detail`}>
          <summary>Detail stránky: {page.title ?? page.url}</summary>
          <p><strong>URL:</strong> <a href={page.url} target="_blank" rel="noreferrer">{page.url}</a></p>
          <p><strong>Titulek:</strong> {page.title ?? '—'}</p>
          <h4>Čistý text</h4>
          <pre className="page-content">{page.textContent ?? '—'}</pre>
          <details>
            <summary>Zdrojové HTML</summary>
            <pre className="page-content">{page.htmlContent ?? '—'}</pre>
          </details>
        </details>
      ))}

      <h3>Nalezené osoby a kontakty</h3>
      <p><strong>Počet osob:</strong> {company.personsCount ?? 0} | <strong>Počet kontaktů:</strong> {company.contactsCount ?? 0}</p>
      <p><strong>Nejlepší kontakt:</strong> {bestContact?.contact ? `${bestContact.contact.contactType}: ${bestContact.contact.value}` : '—'}</p>
      <p><strong>Best score:</strong> {company.bestContactScore ?? '—'} {bestContact ? `(${bestContact.category})` : ''}</p>
      <p><strong>Scored at:</strong> {company.scoredAt ? new Date(company.scoredAt).toLocaleString('cs-CZ') : '—'}</p>

      <h4>Osoby</h4>
      <table>
        <thead>
          <tr>
            <th>Jméno</th>
            <th>Pozice</th>
            <th>Oddělení</th>
            <th>Confidence</th>
            <th>Zdroj URL</th>
            <th>Kontext</th>
            <th>Review status</th>
          </tr>
        </thead>
        <tbody>
          {company.persons.map((person) => (
            <tr key={person.id}>
              <td>{person.fullName}</td>
              <td>{person.position ?? '—'}</td>
              <td>{person.department ?? '—'}</td>
              <td>{person.confidenceScore}</td>
              <td><a href={person.sourceUrl} target="_blank" rel="noreferrer">{person.sourceUrl}</a></td>
              <td>{person.contextText}</td>
              <td>
                <select value={person.reviewStatus} onChange={(e) => void updatePersonReview(person.id, e.target.value)}>
                  <option value={person.reviewStatus}>{person.reviewStatus}</option>
                  {reviewOptions.filter((v) => v !== person.reviewStatus).map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </td>
            </tr>
          ))}
          {company.persons.length === 0 && <tr><td colSpan={7}>Žádné osoby</td></tr>}
        </tbody>
      </table>

      <h4>Kontakty</h4>
      <table>
        <thead>
          <tr>
            <th>Typ</th>
            <th>Hodnota</th>
            <th>Navázaná osoba</th>
            <th>Confidence</th>
            <th>Zdroj URL</th>
            <th>Kontext</th>
            <th>Review status</th>
          </tr>
        </thead>
        <tbody>
          {company.contacts.map((contact) => (
            <tr key={contact.id}>
              <td>{contact.contactType}</td>
              <td>{contact.value}</td>
              <td>{contact.person?.fullName ?? '—'}</td>
              <td>{contact.confidenceScore}</td>
              <td><a href={contact.sourceUrl} target="_blank" rel="noreferrer">{contact.sourceUrl}</a></td>
              <td>{contact.contextText}</td>
              <td>
                <select value={contact.reviewStatus} onChange={(e) => void updateContactReview(contact.id, e.target.value)}>
                  <option value={contact.reviewStatus}>{contact.reviewStatus}</option>
                  {reviewOptions.filter((v) => v !== contact.reviewStatus).map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </td>
            </tr>
          ))}
          {company.contacts.length === 0 && <tr><td colSpan={7}>Žádné kontakty</td></tr>}
        </tbody>
      </table>

      <h4>Scoring kontaktů</h4>
      <table>
        <thead>
          <tr>
            <th>Score</th>
            <th>Kategorie</th>
            <th>Cílová role</th>
            <th>Osoba</th>
            <th>Kontakt</th>
            <th>Důvody</th>
          </tr>
        </thead>
        <tbody>
          {company.contactScores.map((item) => (
            <tr key={item.id}>
              <td>{item.score}</td>
              <td>{item.category}</td>
              <td>{item.targetRole}</td>
              <td>{item.person ? `${item.person.fullName}${item.person.position ? ` (${item.person.position})` : ''}` : '—'}</td>
              <td>{item.contact ? `${item.contact.contactType}: ${item.contact.value}` : '—'}</td>
              <td>
                <ul>
                  {(item.reasonsJson ?? []).map((reason, idx) => (
                    <li key={`${item.id}-reason-${idx}`}>{reason.points > 0 ? '+' : ''}{reason.points} {reason.message}</li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
          {company.contactScores.length === 0 && <tr><td colSpan={6}>Scoring zatím nebyl proveden.</td></tr>}
        </tbody>
      </table>
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
      await api(`/search-batches/${id}/start`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Spuštění dávky selhalo');
    } finally {
      setLoading(false);
    }
  };

  const findWebsites = async () => {
    if (!id) {
      return;
    }

    setLoading(true);
    try {
      await api(`/search-batches/${id}/find-websites`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vyhledání webů selhalo');
    } finally {
      setLoading(false);
    }
  };

  const crawlWebsites = async () => {
    if (!id) {
      return;
    }

    setLoading(true);
    try {
      await api(`/search-batches/${id}/crawl`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Crawling webů selhal');
    } finally {
      setLoading(false);
    }
  };
  const extractContacts = async () => {
    if (!id) {
      return;
    }
    setLoading(true);
    try {
      await api(`/search-batches/${id}/extract-contacts`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extrakce kontaktů selhala');
    } finally {
      setLoading(false);
    }
  };
  const scoreContacts = async () => {
    if (!id) {
      return;
    }
    setLoading(true);
    try {
      await api(`/search-batches/${id}/score-contacts`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scoring kontaktů selhal');
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
          <button className="button" onClick={() => void findWebsites()} disabled={loading}>Dohledat weby firem</button>{' '}
          <button className="button" onClick={() => void crawlWebsites()} disabled={loading}>Prohledat weby</button>{' '}
          <button className="button" onClick={() => void extractContacts()} disabled={loading}>Extrahovat kontakty</button>{' '}
          <button className="button" onClick={() => void scoreContacts()} disabled={loading}>Score kontaktů</button>{' '}
          <button className="button" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
      </div>
      <p><strong>Role:</strong> {batch.targetRole ?? '—'}</p>
      <p><strong>Stav dávky:</strong> {batch.status}</p>
      <p><strong>Zpracováno:</strong> {batch.processedCount} / {batch.totalCount}</p>

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
              <td>{company.bestContactId ? `${company.bestContactScore ?? 0} bodů` : '—'}</td>
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
  return (
    <main className="container">
      <Routes>
        <Route path="/" element={<BatchListPage />} />
        <Route path="/batches/new" element={<NewBatchPage />} />
        <Route path="/batches/:id" element={<BatchDetailPage />} />
      </Routes>
    </main>
  );
}
