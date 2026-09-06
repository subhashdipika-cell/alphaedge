import React, { useEffect, useState } from 'react';
import { bridgeBaseUrl } from '../data/bridge.js';

const cell = { padding: 10, textAlign: 'left', borderBottom: '1px solid #1e3a5a' };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'Unavailable';

export default function StoredStrategyLab() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const timeout = setTimeout(() => controller.abort(), 10000);
    setData(null); setError('');
    fetch(`${bridgeBaseUrl()}/rd/stored-audit`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`Bridge HTTP ${r.status}`); return r.json(); })
      .then(d => { if (!d.ok || !d.strategies) throw new Error(d.error || 'Invalid report'); if (active) setData(d); })
      .catch(e => { if (active) setError(`Audit unavailable: ${e.message}. The updated bridge must be running.`); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [refresh]);
  return <section style={{ padding: 20, color: '#cbd5e1', overflow: 'auto', height: '100%' }}>
    <h2>Strategy Lab — stored-data evidence</h2>
    <p>Research diagnostics only. No random signals, generated candles, or assumed win rates. Not approval for live trading.</p>
    <button onClick={() => setRefresh(n => n + 1)}>Refresh saved results</button>
    {error && <p role="alert" style={{ color: '#fbbf24' }}>{error}</p>}
    {!data && !error && <p>Loading saved audit…</p>}
    {data && <>
      <p>{data.report} · Generated {data.generatedAt} · {Array.isArray(data.files) ? data.files.length : 0} day-files</p>
      <p>Candle provenance: {data.assumptions?.candleProvenance || 'LEGACY_UNVERIFIED — old report has no identity proof'}</p>
      <p style={{ color: '#fbbf24' }}>Gross R includes the report’s slippage assumption but excludes charges. Zero completed legs means no performance estimate. Historical data provenance may be unverified.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Strategy / index', 'Completed legs', 'Unresolved', 'Gross win rate', 'Mean gross R', 'Top rejection'].map(t => <th key={t} style={cell}>{t}</th>)}</tr></thead>
        <tbody>{Object.entries(data.strategies).map(([key, value]) => {
          const s = value?.summary || {}, rejection = Object.entries(value?.gates || {}).sort((a,b) => b[1]-a[1])[0];
          return <tr key={key}><td style={cell}>{key}</td><td style={cell}>{s.completedLegs ?? 'Unavailable'}</td>
            <td style={cell}>{value?.unresolved ?? 'Unavailable'}</td><td style={cell}>{s.completedLegs > 0 ? number(s.winRateGrossPct) + '%' : 'Unavailable'}</td>
            <td style={cell}>{s.completedLegs > 0 ? number(s.expectancyGrossR) : 'Unavailable'}</td><td style={cell}>{rejection ? `${rejection[0]} (${rejection[1]})` : 'None recorded'}</td></tr>;
        })}</tbody>
      </table>
      <h3>Data and execution limitations</h3>
      <p>{data.assumptions?.sizing}</p><p>{data.assumptions?.charges}</p>
      <ul>{(Array.isArray(data.assumptions?.limitations) ? data.assumptions.limitations : []).map((s,i) => <li key={i}>{s}</li>)}</ul>
      {data.errors?.length > 0 && <p role="alert">{data.errors.length} files failed processing. This report is incomplete.</p>}
    </>}
    <p>Legacy dashboard-only strategies have no validated contract-level replay and are not assigned fabricated performance here.</p>
  </section>;
}
