import { useRef, useCallback, useMemo } from 'react';
import { PlacedComponent } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';

/** One data point captured per tick. */
export interface TracePoint {
  time: number;   // ms
  voltage: number;
}

/** A single trace (signal being probed). */
export interface Trace {
  componentId: string;
  label: string;
  color: string;
  data: TracePoint[];
}

const TRACE_COLORS = ['#4ade80', '#60a5fa', '#fbbf24', '#f472b6', '#c084fc', '#ef4444'];
const MAX_POINTS = 200;
const CHART_W = 600;
const CHART_H = 140;
const PAD_L = 40;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 20;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

interface OscilloscopeProps {
  traces: Trace[];
  visible: boolean;
  onToggle: () => void;
  onAddProbe: (componentId: string) => void;
  onRemoveProbe: (componentId: string) => void;
  probedIds: Set<string>;
  components: PlacedComponent[];
  simRunning: boolean;
}

export default function Oscilloscope({
  traces,
  visible,
  onToggle,
  onRemoveProbe,
  probedIds,
  simRunning,
}: OscilloscopeProps) {
  if (!visible) {
    return (
      <div className="scope-toggle-bar">
        <button type="button" className="scope-toggle-btn" onClick={onToggle} title="Show oscilloscope">
          Scope
        </button>
      </div>
    );
  }

  // Compute Y range across all traces
  const { yMin, yMax, tMin, tMax } = useMemo(() => {
    let mn = 0, mx = 5;
    let tMn = Infinity, tMx = -Infinity;
    for (const tr of traces) {
      for (const pt of tr.data) {
        if (pt.voltage < mn) mn = pt.voltage;
        if (pt.voltage > mx) mx = pt.voltage;
        if (pt.time < tMn) tMn = pt.time;
        if (pt.time > tMx) tMx = pt.time;
      }
    }
    // Add 10% padding
    const range = mx - mn || 1;
    mn -= range * 0.1;
    mx += range * 0.1;
    if (tMn === Infinity) { tMn = 0; tMx = 1000; }
    return { yMin: mn, yMax: mx, tMin: tMn, tMax: tMx };
  }, [traces]);

  const timeRange = tMax - tMin || 1;
  const yRange = yMax - yMin || 1;

  function xPx(t: number): number {
    return PAD_L + ((t - tMin) / timeRange) * PLOT_W;
  }
  function yPx(v: number): number {
    return PAD_T + (1 - (v - yMin) / yRange) * PLOT_H;
  }

  // Grid lines
  const gridLines: JSX.Element[] = [];
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const v = yMin + (i / ySteps) * yRange;
    const y = yPx(v);
    gridLines.push(
      <line key={`hg-${i}`} x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} stroke="#1e293b" strokeWidth={0.5} />,
      <text key={`hl-${i}`} x={PAD_L - 4} y={y + 3} textAnchor="end" fill="#64748b" fontSize={8}>{v.toFixed(1)}</text>,
    );
  }

  // Time labels
  const tSteps = 5;
  for (let i = 0; i <= tSteps; i++) {
    const t = tMin + (i / tSteps) * timeRange;
    const x = xPx(t);
    gridLines.push(
      <text key={`tl-${i}`} x={x} y={PAD_T + PLOT_H + 14} textAnchor="middle" fill="#64748b" fontSize={8}>
        {(t / 1000).toFixed(1)}s
      </text>,
    );
  }

  return (
    <div className="oscilloscope-panel">
      <div className="scope-header">
        <span className="scope-title">Oscilloscope</span>
        <div className="scope-traces-list">
          {traces.map((tr) => (
            <span key={tr.componentId} className="scope-trace-tag" style={{ borderColor: tr.color }}>
              <span className="scope-trace-dot" style={{ background: tr.color }} />
              {tr.label}
              <button type="button" className="scope-trace-remove" onClick={() => onRemoveProbe(tr.componentId)}>x</button>
            </span>
          ))}
          {traces.length === 0 && <span className="scope-hint">Select a component and click "Probe" to add a trace</span>}
        </div>
        <button type="button" className="scope-close-btn" onClick={onToggle}>x</button>
      </div>
      <svg className="scope-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none">
        {/* Plot background */}
        <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} fill="#0a0f1a" />
        {/* Grid */}
        {gridLines}
        {/* Zero line if in range */}
        {yMin < 0 && yMax > 0 && (
          <line x1={PAD_L} y1={yPx(0)} x2={PAD_L + PLOT_W} y2={yPx(0)} stroke="#334155" strokeWidth={1} />
        )}
        {/* Traces */}
        {traces.map((tr) => {
          if (tr.data.length < 2) return null;
          const d = tr.data.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${xPx(pt.time).toFixed(1)} ${yPx(pt.voltage).toFixed(1)}`).join(' ');
          return <path key={tr.componentId} d={d} stroke={tr.color} strokeWidth={1.5} fill="none" />;
        })}
      </svg>
      {!simRunning && traces.length > 0 && (
        <div className="scope-paused">Simulation paused</div>
      )}
    </div>
  );
}

/**
 * Hook to manage oscilloscope trace data.
 * Call recordTick() each simulation tick.
 */
export function useOscilloscope() {
  const probedRef = useRef<Set<string>>(new Set());
  const tracesRef = useRef<Map<string, TracePoint[]>>(new Map());

  const addProbe = useCallback((componentId: string) => {
    probedRef.current.add(componentId);
    if (!tracesRef.current.has(componentId)) {
      tracesRef.current.set(componentId, []);
    }
  }, []);

  const removeProbe = useCallback((componentId: string) => {
    probedRef.current.delete(componentId);
    tracesRef.current.delete(componentId);
  }, []);

  const recordTick = useCallback((components: PlacedComponent[], simTime: number) => {
    for (const compId of probedRef.current) {
      const comp = components.find((c) => c.id === compId);
      if (!comp) continue;
      const voltage = Number(comp.state?.voltage ?? 0);
      const data = tracesRef.current.get(compId);
      if (!data) continue;
      data.push({ time: simTime, voltage });
      // Trim to max points
      if (data.length > MAX_POINTS) {
        data.splice(0, data.length - MAX_POINTS);
      }
    }
  }, []);

  const clearTraces = useCallback(() => {
    for (const data of tracesRef.current.values()) {
      data.length = 0;
    }
  }, []);

  const getTraces = useCallback((components: PlacedComponent[]): Trace[] => {
    const result: Trace[] = [];
    let colorIdx = 0;
    for (const compId of probedRef.current) {
      const comp = components.find((c) => c.id === compId);
      const def = comp ? COMPONENT_DEFINITIONS[comp.type] : null;
      const data = tracesRef.current.get(compId) ?? [];
      result.push({
        componentId: compId,
        label: def?.label ?? compId,
        color: TRACE_COLORS[colorIdx++ % TRACE_COLORS.length],
        data,
      });
    }
    return result;
  }, []);

  return { probedIds: probedRef.current, addProbe, removeProbe, recordTick, clearTraces, getTraces };
}
