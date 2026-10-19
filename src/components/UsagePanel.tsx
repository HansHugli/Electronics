import { useCallback, useEffect, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

export default function UsagePanel({ onClose }: { onClose: () => void }) {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [pricing, setPricing] = useState<ModelPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.electronApi?.usageGet) {
      setLoading(false);
      return;
    }
    window.electronApi.usageGet()
      .then((data) => setRecords(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    window.electronApi.usagePricing?.().then(setPricing).catch(() => {});
  }, []);

  const handleClear = useCallback(async () => {
    setConfirmingClear(false);
    if (!window.electronApi?.usageClear) return;
    try {
      await window.electronApi.usageClear();
      setRecords([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cost = (r: UsageRecord) => (typeof r.cost === 'number' && Number.isFinite(r.cost) ? r.cost : 0);
  const unknownPriced = records.filter((r) => r.cost === null || r.cost === undefined).length;
  const totalCost = records.reduce((sum, r) => sum + cost(r), 0);
  const totalInput = records.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutput = records.reduce((sum, r) => sum + r.outputTokens, 0);

  // Group records by date for the chart
  const dailyMap = new Map<string, number>();
  const cumulativeMap = new Map<string, number>();
  let runningTotal = 0;
  for (const r of records) {
    const date = r.timestamp.slice(0, 10); // YYYY-MM-DD
    dailyMap.set(date, (dailyMap.get(date) || 0) + cost(r));
    runningTotal += cost(r);
    cumulativeMap.set(date, runningTotal);
  }
  const dates = Array.from(cumulativeMap.keys());
  const cumulativeValues = dates.map((d) => cumulativeMap.get(d)!);
  const dailyValues = dates.map((d) => dailyMap.get(d)!);

  // Per-model breakdown
  const modelTotals = new Map<string, { count: number; cost: number }>();
  for (const r of records) {
    const label = shortModel(r.model);
    const entry = modelTotals.get(label) || { count: 0, cost: 0 };
    entry.count++;
    entry.cost += cost(r);
    modelTotals.set(label, entry);
  }

  const chartData = {
    labels: dates.map((d) => d.slice(5)), // MM-DD
    datasets: [
      {
        label: 'Cumulative ($)',
        data: cumulativeValues,
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: '#38bdf8',
      },
      {
        label: 'Daily ($)',
        data: dailyValues,
        borderColor: '#a78bfa',
        backgroundColor: 'rgba(167, 139, 250, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: '#a78bfa',
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: '#94a3b8', font: { size: 11 } },
      },
      tooltip: {
        callbacks: {
          label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) =>
            `${ctx.dataset.label}: $${(ctx.parsed.y ?? 0).toFixed(4)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: '#64748b', font: { size: 10 } },
        grid: { color: '#1e293b' },
      },
      y: {
        ticks: {
          color: '#64748b',
          font: { size: 10 },
          callback: (value: string | number) => `$${Number(value).toFixed(3)}`,
        },
        grid: { color: '#1e293b' },
      },
    },
  };

  return (
    <div className="modal-overlay">
      <div className="modal usage-modal">
        <h2 className="modal-title">API Usage</h2>

        {loading ? (
          <p style={{ color: '#94a3b8' }}>Loading...</p>
        ) : records.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.85rem' }}>No usage recorded yet. Start chatting to track costs.</p>
        ) : (
          <>
            <div className="usage-summary">
              <div className="usage-stat">
                <span className="usage-stat-value">${totalCost.toFixed(4)}</span>
                <span className="usage-stat-label">Estimated Cost</span>
              </div>
              <div className="usage-stat">
                <span className="usage-stat-value">{records.length}</span>
                <span className="usage-stat-label">Requests</span>
              </div>
              <div className="usage-stat">
                <span className="usage-stat-value">{formatTokens(totalInput)}</span>
                <span className="usage-stat-label">Input Tokens</span>
              </div>
              <div className="usage-stat">
                <span className="usage-stat-value">{formatTokens(totalOutput)}</span>
                <span className="usage-stat-label">Output Tokens</span>
              </div>
            </div>

            <div className="usage-chart-container">
              <Line data={chartData} options={chartOptions} />
            </div>

            {unknownPriced > 0 && (
              <p style={{ color: '#fbbf24', fontSize: '0.75rem' }}>
                {unknownPriced} request{unknownPriced === 1 ? '' : 's'} used a model with an unknown price and {unknownPriced === 1 ? 'is' : 'are'} not in the total.
              </p>
            )}

            {modelTotals.size > 0 && (
              <div className="usage-model-breakdown">
                <h3 className="usage-section-title">By Model</h3>
                <table className="usage-table">
                  <thead>
                    <tr><th>Model</th><th>Requests</th><th>Cost</th></tr>
                  </thead>
                  <tbody>
                    {Array.from(modelTotals.entries()).map(([model, data]) => (
                      <tr key={model}>
                        <td>{model}</td>
                        <td>{data.count}</td>
                        <td>${data.cost.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {pricing.length > 0 && (
          <div className="usage-model-breakdown">
            <h3 className="usage-section-title">Prices used ($ per million tokens)</h3>
            <p style={{ color: '#94a3b8', fontSize: '0.72rem', margin: '0 0 4px' }}>
              Estimates; check anthropic.com/pricing for current prices. Cache writes are 1.25x input (5-minute cache).
            </p>
            <table className="usage-table">
              <thead>
                <tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr>
              </thead>
              <tbody>
                {pricing.map((p) => (
                  <tr key={p.model} title={p.note}>
                    <td>{p.label}{p.legacy ? ' (older)' : ''}{p.note ? ' *' : ''}</td>
                    <td>{p.input}</td>
                    <td>{p.output}</td>
                    <td>{p.cacheRead}</td>
                    <td>{p.cacheWrite}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ color: '#64748b', fontSize: '0.68rem', margin: '4px 0 0' }}>
              * {pricing.filter((p) => p.note).map((p) => `${p.label}: ${p.note}`).join('. ')}
            </p>
          </div>
        )}

        {error && <p style={{ color: '#f87171', fontSize: '0.8rem' }}>{error}</p>}

        <div className="modal-actions">
          {records.length > 0 && (
            <button type="button" className="modal-btn small danger" onClick={() => setConfirmingClear(true)}>
              Clear History
            </button>
          )}
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {confirmingClear && (
        // In-app confirmation: explicit buttons only, no backdrop close.
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="usage-clear-title">
          <div className="modal">
            <h2 className="modal-title" id="usage-clear-title">Clear usage history?</h2>
            <p style={{ color: '#cbd5e1', fontSize: '0.85rem' }}>
              This deletes all {records.length} recorded requests and their costs. It can't be undone.
            </p>
            <div className="modal-actions">
              <button type="button" className="modal-btn" onClick={() => setConfirmingClear(false)} autoFocus>
                Cancel
              </button>
              <button type="button" className="modal-btn danger" onClick={handleClear}>
                Clear History
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function shortModel(model: string): string {
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  return model;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
