import { useState, useCallback, useRef, useEffect } from 'react';
import { PlacedComponent, Wire, Point } from './types';
import { COMPONENT_DEFINITIONS } from './data/components';
import { simulateCircuit, createBlinkDemoCircuit } from './engine/simulation';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import Breadboard from './components/Breadboard';
import PropertiesPanel from './components/PropertiesPanel';
import PowerConfigModal from './components/PowerConfigModal';

let nextId = 1;
function genId() {
  return `comp_${nextId++}`;
}
let nextWireId = 1;
function genWireId() {
  return `wire_${nextWireId++}`;
}

const WIRE_COLORS = ['#ef4444', '#fbbf24', '#4ade80', '#60a5fa', '#c084fc', '#f472b6'];
let wireColorIdx = 0;

function App() {
  const [components, setComponents] = useState<PlacedComponent[]>([]);
  const [wires, setWires] = useState<Wire[]>([]);
  const [simRunning, setSimRunning] = useState(false);
  const [simTime, setSimTime] = useState(0);
  const [wiringFrom, setWiringFrom] = useState<{ componentId: string; pinId: string } | null>(null);
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [selectedWireId, setSelectedWireId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [circuitName, setCircuitName] = useState('untitled');
  const [currentFilePath, setCurrentFilePath] = useState<string | undefined>(undefined);
  const [pendingPowerDrop, setPendingPowerDrop] = useState<Point | null>(null);
  const simInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Simulation loop
  useEffect(() => {
    if (simRunning) {
      simInterval.current = setInterval(() => {
        setSimTime((t) => t + 100);
      }, 100);
    } else {
      if (simInterval.current) clearInterval(simInterval.current);
    }
    return () => {
      if (simInterval.current) clearInterval(simInterval.current);
    };
  }, [simRunning]);

  // Run simulation each tick
  useEffect(() => {
    if (!simRunning) return;

    setComponents((prev) => {
      const states = simulateCircuit(prev, wires, simTime);
      return prev.map((comp) => {
        const newState = states.get(comp.id);
        return newState ? { ...comp, state: newState } : comp;
      });
    });
  }, [simTime, simRunning, wires]);

  const handleDropComponent = useCallback((type: string, position: Point) => {
    if (type === 'power') {
      setPendingPowerDrop(position);
      return;
    }
    const def = COMPONENT_DEFINITIONS[type];
    if (!def) return;
    const defaults: Record<string, number | string> = {};
    if (def.properties) {
      for (const [key, prop] of Object.entries(def.properties)) {
        defaults[key] = prop.default;
      }
    }
    const comp: PlacedComponent = {
      id: genId(),
      type,
      position,
      rotation: 0,
      properties: defaults,
      state: {},
    };
    setComponents((prev) => [...prev, comp]);
  }, []);

  const handlePowerConfigConfirm = useCallback((config: { mode: string; voltage: number; waveform: string }) => {
    if (!pendingPowerDrop) return;
    const comp: PlacedComponent = {
      id: genId(),
      type: 'power',
      position: pendingPowerDrop,
      rotation: 0,
      properties: {
        voltage: config.voltage,
        mode: config.mode,
        waveform: config.waveform,
      },
      state: {},
    };
    setComponents((prev) => [...prev, comp]);
    setPendingPowerDrop(null);
  }, [pendingPowerDrop]);

  const handleMoveComponent = useCallback((id: string, position: Point) => {
    setComponents((prev) => prev.map((c) => (c.id === id ? { ...c, position } : c)));
  }, []);

  const handleSelectComponent = useCallback((id: string | null) => {
    setSelectedComponentId(id);
    if (id) setSelectedWireId(null);
  }, []);

  const handleSelectWire = useCallback((id: string | null) => {
    setSelectedWireId(id);
    if (id) setSelectedComponentId(null);
  }, []);

  const handleDeleteComponent = useCallback((id: string) => {
    setComponents((prev) => prev.filter((c) => c.id !== id));
    setWires((prev) => prev.filter((w) => w.from.componentId !== id && w.to.componentId !== id));
    setSelectedComponentId((prev) => prev === id ? null : prev);
  }, []);

  const handleDeleteWire = useCallback((id: string) => {
    setWires((prev) => prev.filter((w) => w.id !== id));
    setSelectedWireId((prev) => prev === id ? null : prev);
  }, []);

  const handleToggleSwitch = useCallback((id: string) => {
    setComponents((prev) =>
      prev.map((c) =>
        c.id === id && c.type === 'switch'
          ? { ...c, state: { ...c.state, closed: c.state.closed ? 0 : 1 } }
          : c
      )
    );
  }, []);

  const handleStartWire = useCallback((componentId: string, pinId: string) => {
    if (!componentId) {
      // Cancel signal
      setWiringFrom(null);
      return;
    }
    setWiringFrom({ componentId, pinId });
  }, []);

  const handleEndWire = useCallback(
    (componentId: string, pinId: string) => {
      if (!wiringFrom) return;
      const wire: Wire = {
        id: genWireId(),
        from: wiringFrom,
        to: { componentId, pinId },
        waypoints: [],
        color: WIRE_COLORS[wireColorIdx++ % WIRE_COLORS.length],
      };
      setWires((prev) => [...prev, wire]);
      setWiringFrom(null);
    },
    [wiringFrom]
  );

  const handlePropertyChange = useCallback((componentId: string, key: string, value: number | string) => {
    setComponents((prev) =>
      prev.map((c) => (c.id === componentId ? { ...c, properties: { ...c.properties, [key]: value } } : c))
    );
  }, []);

  const handleToggleSimulation = useCallback(() => {
    setSimRunning((prev) => !prev);
    if (simRunning) {
      setSimTime(0);
      setComponents((prev) => prev.map((c) => ({ ...c, state: {} })));
    }
  }, [simRunning]);

  const handleClearCircuit = useCallback(() => {
    setSimRunning(false);
    setSimTime(0);
    setComponents([]);
    setWires([]);
    setWiringFrom(null);
    setSelectedComponentId(null);
    setSelectedWireId(null);
    setCircuitName('untitled');
    setCurrentFilePath(undefined);
  }, []);

  const showStatus = useCallback((msg: string) => {
    setSaveStatus(msg);
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 3000);
  }, []);

  const loadCircuitState = useCallback((data: { components: PlacedComponent[]; wires: Wire[] }, name?: string, filePath?: string) => {
    setComponents(data.components);
    setWires(data.wires);
    setSelectedComponentId(null);
    setWiringFrom(null);
    setSimRunning(false);
    setSimTime(0);
    if (name) setCircuitName(name);
    if (filePath) setCurrentFilePath(filePath);
    const maxCompId = data.components.reduce((max, c) => {
      const num = parseInt(c.id.replace(/\D/g, ''), 10);
      return isNaN(num) ? max : Math.max(max, num);
    }, 0);
    const maxWireId = data.wires.reduce((max, w) => {
      const num = parseInt(w.id.replace(/\D/g, ''), 10);
      return isNaN(num) ? max : Math.max(max, num);
    }, 0);
    nextId = maxCompId + 1;
    nextWireId = maxWireId + 1;
  }, []);

  // ---- Save ---- //

  const handleSave = useCallback(async () => {
    const data = JSON.stringify({ components, wires }, null, 2);
    if (window.electronApi) {
      const result = await window.electronApi.saveCircuit(data, currentFilePath);
      if (result) {
        setCircuitName(result.name);
        setCurrentFilePath(result.filePath);
        showStatus(`Saved "${result.name}.ecx"`);
      }
    } else {
      // Browser fallback: download
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${circuitName}.ecx`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus('Downloaded');
    }
  }, [components, wires, currentFilePath, circuitName, showStatus]);

  // ---- Open ---- //

  const handleLoad = useCallback(async () => {
    if (window.electronApi) {
      const result = await window.electronApi.loadCircuit();
      if (result) {
        try {
          const parsed = JSON.parse(result.data);
          if (parsed.components && parsed.wires) {
            loadCircuitState(parsed, result.name, result.filePath);
            showStatus(`Opened "${result.name}.ecx"`);
          }
        } catch {
          showStatus('Invalid circuit file');
        }
      }
    } else {
      // Browser fallback: file picker
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ecx';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        try {
          const parsed = JSON.parse(text);
          if (parsed.components && parsed.wires) {
            const name = file.name.replace(/\.ecx$/, '');
            loadCircuitState(parsed, name);
            showStatus(`Loaded "${file.name}"`);
          }
        } catch {
          showStatus('Invalid circuit file');
        }
      };
      input.click();
    }
  }, [loadCircuitState, showStatus]);

  // ---- Demo ---- //

  const handleLoadDemo = useCallback(() => {
    loadCircuitState(createBlinkDemoCircuit(), 'LED Blink Demo');
    setCurrentFilePath(undefined);
  }, [loadCircuitState]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        handleLoad();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't delete if focus is in an input
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        if (selectedComponentId) {
          handleDeleteComponent(selectedComponentId);
        }
        if (selectedWireId) {
          handleDeleteWire(selectedWireId);
        }
      }
      if (e.key === 'Escape') {
        setWiringFrom(null);
        setSelectedComponentId(null);
        setSelectedWireId(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleLoad, selectedComponentId, selectedWireId, handleDeleteComponent, handleDeleteWire]);

  const selectedComponent = components.find((c) => c.id === selectedComponentId) ?? null;

  return (
    <div className="app-shell">
      <Sidebar onDragStart={() => {}} />
      <div className="main-area">
        <Toolbar
          simRunning={simRunning}
          onToggleSimulation={handleToggleSimulation}
          onClearCircuit={handleClearCircuit}
          onSave={handleSave}
          onLoad={handleLoad}
          onLoadDemo={handleLoadDemo}
          saveStatus={saveStatus}
          circuitName={circuitName}
        />
        <div className="canvas-container">
          <Breadboard
            components={components}
            wires={wires}
            simRunning={simRunning}
            onDropComponent={handleDropComponent}
            onMoveComponent={handleMoveComponent}
            onStartWire={handleStartWire}
            onEndWire={handleEndWire}
            wiringFrom={wiringFrom}
            onSelectComponent={handleSelectComponent}
            selectedComponentId={selectedComponentId}
            onSelectWire={handleSelectWire}
            selectedWireId={selectedWireId}
            onToggleSwitch={handleToggleSwitch}
          />
          {wiringFrom && (
            <div className="wiring-hint">Click a pin to complete the wire, or press Escape to cancel</div>
          )}
          {components.length === 0 && (
            <div className="empty-state">
              <p>Drag components from the sidebar or click Demo to load the LED blink circuit</p>
            </div>
          )}
        </div>
      </div>
      <PropertiesPanel component={selectedComponent} onPropertyChange={handlePropertyChange} />

      {pendingPowerDrop && (
        <PowerConfigModal
          onConfirm={handlePowerConfigConfirm}
          onCancel={() => setPendingPowerDrop(null)}
        />
      )}
    </div>
  );
}

export default App;
