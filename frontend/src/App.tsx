import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
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

type Company = {
  id: string;
  ico: string;
  companyName: string | null;
  status: string;
  errorMessage: string | null;
};

type ImportLog = {
  id: string;
  rowNumber: number;
  rawValue: string;
  normalizedIco: string | null;
  status: string;
  message: string | null;
};

type SearchBatchDetail = SearchBatch & {
  companies: Company[];
  importLogs: ImportLog[];
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
  const navigate = useNavigate();
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

      navigate(`/batches/${batch.id}`);
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

function BatchDetailPage() {
  const { id } = useParams();
  const [batch, setBatch] = useState<SearchBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      return;
    }

    api<SearchBatchDetail>(`/search-batches/${id}`)
      .then(setBatch)
      .catch((e) => setError(e instanceof Error ? e.message : 'Nepodařilo se načíst detail dávky'));
  }, [id]);

  if (error) {
    return <p className="error">{error}</p>;
  }

  if (!batch) {
    return <p>Načítám…</p>;
  }

  return (
    <div>
      <Link to="/">← Zpět na dávky</Link>
      <h1>{batch.name}</h1>
      <p><strong>Role:</strong> {batch.targetRole ?? '—'}</p>
      <p><strong>Stav:</strong> {batch.status}</p>
      <p><strong>Počet IČO:</strong> {batch.totalCount}</p>

      <h2>Firmy</h2>
      <table>
        <thead>
          <tr>
            <th>IČO</th>
            <th>Název firmy</th>
            <th>Status</th>
            <th>Chyba</th>
          </tr>
        </thead>
        <tbody>
          {batch.companies.map((company) => (
            <tr key={company.id}>
              <td>{company.ico}</td>
              <td>{company.companyName ?? '—'}</td>
              <td>{company.status}</td>
              <td>{company.errorMessage ?? '—'}</td>
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
