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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!window.electronApi?.usageGet) {
      setLoading(false);
      return;
    }
    window.electronApi.usageGet().then((data) => {
      setRecords(data);
      setLoading(false);
    });
  }, []);

  const handleClear = useCallback(async () => {
    if (!window.confirm('Clear all usage history?')) return;
    if (window.electronApi?.usageClear) {
      await window.electronApi.usageClear();
      setRecords([]);
    }
  }, []);

  const totalCost = records.reduce((sum, r) => sum + r.cost, 0);
  const totalInput = records.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutput = records.reduce((sum, r) => sum + r.outputTokens, 0);

  // Group records by date for the chart
  const dailyMap = new Map<string, number>();
  const cumulativeMap = new Map<string, number>();
  let runningTotal = 0;
  for (const r of records) {
    const date = r.timestamp.slice(0, 10); // YYYY-MM-DD
    dailyMap.set(date, (dailyMap.get(date) || 0) + r.cost);
    runningTotal += r.cost;
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
    entry.cost += r.cost;
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
                <span className="usage-stat-label">Total Cost</span>
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

        <div className="modal-actions">
          {records.length > 0 && (
            <button type="button" className="modal-btn small danger" onClick={handleClear}>
              Clear History
            </button>
          )}
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
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
