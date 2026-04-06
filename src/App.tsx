import { useState, useCallback, useRef, useEffect } from 'react';
import { PlacedComponent, Wire, Point } from './types';
import { COMPONENT_DEFINITIONS } from './data/components';
import { GRID_W, GRID_H } from './data/breadboard';
import { createBlinkDemoCircuit, createCounterDemoCircuit } from './engine/simulation';
import { CircuitSimulator } from './engine/CircuitSimulator';
import { useHistory } from './hooks/useHistory';
import { loadExternalChips } from './data/chipLoader';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import Breadboard from './components/Breadboard';
import PropertiesPanel from './components/PropertiesPanel';
import PowerConfigModal from './components/PowerConfigModal';
import Oscilloscope, { useOscilloscope } from './components/Oscilloscope';
import AboutDialog from './components/AboutDialog';
import SettingsDialog from './components/SettingsDialog';
import SketchEditor from './components/SketchEditor';
import { generateKiCadNetlist, generateBOM } from './engine/pcbExport';

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

/** Check if two component rectangles overlap (with small tolerance). */
function componentsOverlap(
  a: PlacedComponent,
  b: PlacedComponent,
): boolean {
  const defA = COMPONENT_DEFINITIONS[a.type];
  const defB = COMPONENT_DEFINITIONS[b.type];
  if (!defA || !defB) return false;
  const isRotA = a.rotation === 90 || a.rotation === 270;
  const isRotB = b.rotation === 90 || b.rotation === 270;
  const aw = (isRotA ? defA.height : defA.width) * GRID_W;
  const ah = (isRotA ? defA.width : defA.height) * GRID_H;
  const bw = (isRotB ? defB.height : defB.width) * GRID_W;
  const bh = (isRotB ? defB.width : defB.height) * GRID_H;
  const margin = 2; // small tolerance
  return (
    a.position.x + margin < b.position.x + bw &&
    a.position.x + aw > b.position.x + margin &&
    a.position.y + margin < b.position.y + bh &&
    a.position.y + ah > b.position.y + margin
  );
}

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
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSketchEditor, setShowSketchEditor] = useState(false);
  const sketchTargetId = useRef<string | null>(null);
  const simInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simulator = useRef(new CircuitSimulator());
  const history = useHistory();
  const clipboard = useRef<PlacedComponent | null>(null);
  const dragStartPos = useRef<Point | null>(null);
  const [simSpeed, setSimSpeed] = useState(1); // multiplier: 0.25, 0.5, 1, 2, 5, 10
  const [simAccuracy, setSimAccuracy] = useState(1); // sub-steps per tick: 1, 2, 5, 10
  const [chipsLoaded, setChipsLoaded] = useState(false);
  const [scopeVisible, setScopeVisible] = useState(false);
  const scope = useOscilloscope();

  // Load external chip definitions on mount
  useEffect(() => {
    loadExternalChips().then((count) => {
      if (count > 0) console.log(`Loaded ${count} external chip definition(s)`);
      setChipsLoaded(true);
    });
  }, []);

  // Listen for menu actions from Electron — ref set up below after handlers are defined
  const menuActionRef = useRef<(action: string) => void>(() => {});
  useEffect(() => {
    if (!window.electronApi?.onMenuAction) return;
    window.electronApi.onMenuAction((action) => menuActionRef.current(action));
  }, []);

  // Update window title when circuit name changes
  useEffect(() => {
    const title = `${circuitName} — E101 Electronics`;
    document.title = title;
    window.electronApi?.setTitle?.(title);
  }, [circuitName]);

  // Simulation loop — tick interval adjusts with speed
  const tickMs = Math.round(100 / simSpeed);
  const dtPerTick = 0.1; // always 100ms of sim time per tick (speed changes real-time pacing)

  useEffect(() => {
    if (simRunning) {
      simInterval.current = setInterval(() => {
        setSimTime((t) => t + Math.round(100 * simSpeed));
      }, tickMs);
    } else {
      if (simInterval.current) clearInterval(simInterval.current);
    }
    return () => {
      if (simInterval.current) clearInterval(simInterval.current);
    };
  }, [simRunning, simSpeed, tickMs]);

  // Run simulation each tick
  useEffect(() => {
    if (!simRunning) return;

    simulator.current.subSteps = simAccuracy;
    setComponents((prev) => {
      const states = simulator.current.tick(prev, wires, simTime, dtPerTick);
      const next = prev.map((comp) => {
        const newState = states.get(comp.id);
        return newState ? { ...comp, state: newState } : comp;
      });
      // Record oscilloscope data
      scope.recordTick(next, simTime);
      return next;
    });
  }, [simTime, simRunning, wires, scope]);

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
    // Reject drop if it would overlap an existing component
    if (components.some((c) => componentsOverlap(comp, c))) return;
    setComponents((prev) => {
      const next = [...prev, comp];
      history.push(next, wires);
      return next;
    });
  }, [components, wires, history]);

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
    if (components.some((c) => componentsOverlap(comp, c))) {
      setPendingPowerDrop(null);
      return;
    }
    setComponents((prev) => {
      const next = [...prev, comp];
      history.push(next, wires);
      return next;
    });
    setPendingPowerDrop(null);
  }, [pendingPowerDrop, components, wires, history]);

  const handleMoveComponent = useCallback((id: string, position: Point) => {
    setComponents((prev) => {
      const moving = prev.find((c) => c.id === id);
      if (!moving) return prev;
      // Save start position on first move for undo
      if (!dragStartPos.current) {
        dragStartPos.current = { ...moving.position };
      }
      const candidate = { ...moving, position };
      const wouldOverlap = prev.some((c) => c.id !== id && componentsOverlap(candidate, c));
      if (wouldOverlap) return prev; // reject the move
      return prev.map((c) => (c.id === id ? { ...c, position } : c));
    });
  }, []);

  const handleMoveEnd = useCallback(() => {
    if (dragStartPos.current) {
      dragStartPos.current = null;
      // Push current state as a history entry after drag completes
      setComponents((prev) => {
        history.push(prev, wires);
        return prev;
      });
    }
  }, [wires, history]);

  const handleSelectComponent = useCallback((id: string | null) => {
    setSelectedComponentId(id);
    if (id) setSelectedWireId(null);
  }, []);

  const handleSelectWire = useCallback((id: string | null) => {
    setSelectedWireId(id);
    if (id) setSelectedComponentId(null);
  }, []);

  const handleDeleteComponent = useCallback((id: string) => {
    setComponents((prev) => {
      const next = prev.filter((c) => c.id !== id);
      setWires((prevWires) => {
        const nextWires = prevWires.filter((w) => w.from.componentId !== id && w.to.componentId !== id);
        history.push(next, nextWires);
        return nextWires;
      });
      return next;
    });
    setSelectedComponentId((prev) => prev === id ? null : prev);
  }, [history]);

  const handleDeleteWire = useCallback((id: string) => {
    setWires((prev) => {
      const next = prev.filter((w) => w.id !== id);
      history.push(components, next);
      return next;
    });
    setSelectedWireId((prev) => prev === id ? null : prev);
  }, [components, history]);

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
      setWires((prev) => {
        const next = [...prev, wire];
        history.push(components, next);
        return next;
      });
      setWiringFrom(null);
    },
    [wiringFrom, components, history]
  );

  const handlePropertyChange = useCallback((componentId: string, key: string, value: number | string) => {
    setComponents((prev) => {
      const next = prev.map((c) => (c.id === componentId ? { ...c, properties: { ...c.properties, [key]: value } } : c));
      history.push(next, wires);
      return next;
    });
  }, [wires, history]);

  const handleToggleSimulation = useCallback(() => {
    setSimRunning((prev) => !prev);
    if (simRunning) {
      setSimTime(0);
      simulator.current.reset();
      setComponents((prev) => prev.map((c) => ({ ...c, state: {} })));
      scope.clearTraces();
    }
  }, [simRunning, scope]);

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
    history.reset([], []);
  }, [history]);

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
    history.reset(data.components, data.wires);
  }, [history]);

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

  // Update menu action handler now that save/load are defined
  useEffect(() => {
    menuActionRef.current = (action: string) => {
      switch (action) {
        case 'about': setShowAbout(true); break;
        case 'settings': setShowSettings(true); break;
        case 'save': handleSave(); break;
        case 'open': handleLoad(); break;
        case 'undo': {
          const snap = history.undo();
          if (snap) { setComponents(snap.components); setWires(snap.wires); setSelectedComponentId(null); setSelectedWireId(null); }
          break;
        }
        case 'redo': {
          const snap = history.redo();
          if (snap) { setComponents(snap.components); setWires(snap.wires); setSelectedComponentId(null); setSelectedWireId(null); }
          break;
        }
        case 'copy': {
          if (selectedComponentId) {
            const comp = components.find((c) => c.id === selectedComponentId);
            if (comp) clipboard.current = comp;
          }
          break;
        }
        case 'paste': {
          if (clipboard.current) {
            const src = clipboard.current;
            const def = COMPONENT_DEFINITIONS[src.type];
            if (!def) break;
            const newPos = { x: src.position.x + GRID_W, y: src.position.y + GRID_H };
            const newComp: PlacedComponent = {
              id: genId(), type: src.type, position: newPos,
              rotation: src.rotation, properties: { ...src.properties }, state: {},
            };
            if (!components.some((c) => componentsOverlap(newComp, c))) {
              setComponents((prev) => {
                const next = [...prev, newComp];
                history.push(next, wires);
                return next;
              });
              setSelectedComponentId(newComp.id);
              clipboard.current = newComp;
            }
          }
          break;
        }
      }
    };
  }, [handleSave, handleLoad, history, selectedComponentId, components, wires]);

  // ---- Demo ---- //

  const handleLoadDemo = useCallback(async (demoName?: string) => {
    const name = demoName === 'counter' ? '7-Seg Counter Demo' : 'LED Blink Demo';
    const fileName = demoName === 'counter' ? '7-Seg Counter Demo' : 'LED Blink Demo';

    // Try loading from disk first (Electron only)
    if (window.electronApi?.loadNamedCircuit) {
      const result = await window.electronApi.loadNamedCircuit(fileName);
      if (result) {
        try {
          const parsed = JSON.parse(result.data);
          if (parsed.components && parsed.wires) {
            loadCircuitState(parsed, result.name, result.filePath);
            simulator.current.reset();
            return;
          }
        } catch { /* fall through to generate */ }
      }
    }

    // Generate the demo and save to disk for next time
    const circuit = demoName === 'counter' ? createCounterDemoCircuit() : createBlinkDemoCircuit();
    loadCircuitState(circuit, name);
    simulator.current.reset();

    if (window.electronApi?.saveDemo) {
      const data = JSON.stringify(circuit, null, 2);
      const filePath = await window.electronApi.saveDemo(fileName, data);
      setCurrentFilePath(filePath);
    } else {
      setCurrentFilePath(undefined);
    }
  }, [loadCircuitState]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isInput = (e.target as HTMLElement).tagName === 'INPUT';
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }
      if (ctrl && e.key === 'o') {
        e.preventDefault();
        handleLoad();
        return;
      }
      // Undo
      if (ctrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        const snap = history.undo();
        if (snap) {
          setComponents(snap.components);
          setWires(snap.wires);
          setSelectedComponentId(null);
          setSelectedWireId(null);
        }
        return;
      }
      // Redo (Ctrl+Shift+Z or Ctrl+Y)
      if ((ctrl && e.shiftKey && (e.key === 'Z' || e.key === 'z')) || (ctrl && e.key === 'y')) {
        e.preventDefault();
        const snap = history.redo();
        if (snap) {
          setComponents(snap.components);
          setWires(snap.wires);
          setSelectedComponentId(null);
          setSelectedWireId(null);
        }
        return;
      }
      // Copy
      if (ctrl && e.key === 'c' && !isInput) {
        if (selectedComponentId) {
          const comp = components.find((c) => c.id === selectedComponentId);
          if (comp) clipboard.current = comp;
        }
        return;
      }
      // Paste
      if (ctrl && e.key === 'v' && !isInput) {
        if (clipboard.current) {
          const src = clipboard.current;
          const def = COMPONENT_DEFINITIONS[src.type];
          if (!def) return;
          // Offset paste by 1 grid unit right and down
          const newPos = { x: src.position.x + GRID_W, y: src.position.y + GRID_H };
          const newComp: PlacedComponent = {
            id: genId(),
            type: src.type,
            position: newPos,
            rotation: src.rotation,
            properties: { ...src.properties },
            state: {},
          };
          // Check overlap
          if (components.some((c) => componentsOverlap(newComp, c))) return;
          setComponents((prev) => {
            const next = [...prev, newComp];
            history.push(next, wires);
            return next;
          });
          setSelectedComponentId(newComp.id);
          // Update clipboard to point to new component for repeated paste
          clipboard.current = newComp;
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isInput) return;
        if (selectedComponentId) {
          handleDeleteComponent(selectedComponentId);
        }
        if (selectedWireId) {
          handleDeleteWire(selectedWireId);
        }
        return;
      }
      if (e.key === 'Escape') {
        setWiringFrom(null);
        setSelectedComponentId(null);
        setSelectedWireId(null);
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        if (isInput) return;
        if (selectedComponentId) {
          setComponents((prev) => {
            const next = prev.map((c) =>
              c.id === selectedComponentId
                ? { ...c, rotation: (c.rotation + 90) % 360 }
                : c
            );
            history.push(next, wires);
            return next;
          });
        }
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleLoad, selectedComponentId, selectedWireId, handleDeleteComponent, handleDeleteWire, components, wires, history]);

  const selectedComponent = components.find((c) => c.id === selectedComponentId) ?? null;
  const selectedWire = wires.find((w) => w.id === selectedWireId) ?? null;

  const handleWireColorChange = useCallback((wireId: string, color: string) => {
    setWires((prev) => {
      const next = prev.map((w) => w.id === wireId ? { ...w, color } : w);
      history.push(components, next);
      return next;
    });
  }, [components, history]);

  const handleExportNetlist = useCallback(() => {
    const netlist = generateKiCadNetlist(components, wires);
    const blob = new Blob([netlist], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${circuitName}.net`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('Exported netlist');
  }, [components, wires, circuitName, showStatus]);

  const handleExportBOM = useCallback(() => {
    const bom = generateBOM(components);
    const blob = new Blob([bom], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${circuitName}-bom.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('Exported BOM');
  }, [components, circuitName, showStatus]);

  const handleLoadHex = useCallback(async (componentId: string) => {
    if (window.electronApi?.loadHex) {
      const result = await window.electronApi.loadHex();
      if (result) {
        try {
          simulator.current.loadAVRProgram(componentId, result.data);
          showStatus(`Loaded "${result.name}"`);
        } catch (e) {
          showStatus('Invalid hex file');
        }
      }
    } else {
      // Browser fallback: file picker
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.hex';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        try {
          simulator.current.loadAVRProgram(componentId, text);
          showStatus(`Loaded "${file.name}"`);
        } catch {
          showStatus('Invalid hex file');
        }
      };
      input.click();
    }
  }, [showStatus]);

  const scopeTraces = scope.getTraces(components);

  return (
    <div className="app-shell">
      <Sidebar onDragStart={() => {}} />
      <div className="main-area">
        <Toolbar
          simRunning={simRunning}
          onToggleSimulation={handleToggleSimulation}
          onClearCircuit={handleClearCircuit}
          onLoadDemo={handleLoadDemo}
          simSpeed={simSpeed}
          onSimSpeedChange={setSimSpeed}
          simAccuracy={simAccuracy}
          onSimAccuracyChange={setSimAccuracy}
          onExportNetlist={handleExportNetlist}
          onExportBOM={handleExportBOM}
          saveStatus={saveStatus}
        />
        <div className="canvas-container">
          <Breadboard
            components={components}
            wires={wires}
            simRunning={simRunning}
            onDropComponent={handleDropComponent}
            onMoveComponent={handleMoveComponent}
            onMoveEnd={handleMoveEnd}
            onStartWire={handleStartWire}
            onEndWire={handleEndWire}
            wiringFrom={wiringFrom}
            onSelectComponent={handleSelectComponent}
            selectedComponentId={selectedComponentId}
            onSelectWire={handleSelectWire}
            selectedWireId={selectedWireId}
            onToggleSwitch={handleToggleSwitch}
            wireCurrents={simulator.current.wireCurrents}
            pinHoleVoltages={simulator.current.pinHoleVoltages}
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
        <Oscilloscope
          traces={scopeTraces}
          visible={scopeVisible}
          onToggle={() => setScopeVisible((v) => !v)}
          onAddProbe={scope.addProbe}
          onRemoveProbe={scope.removeProbe}
          probedIds={scope.probedIds}
          components={components}
          simRunning={simRunning}
        />
      </div>
      <PropertiesPanel
        component={selectedComponent}
        onPropertyChange={handlePropertyChange}
        onRotate={(id) => {
          setComponents((prev) => prev.map((c) =>
            c.id === id ? { ...c, rotation: (c.rotation + 90) % 360 } : c
          ));
        }}
        selectedWire={selectedWire}
        onWireColorChange={handleWireColorChange}
        onProbe={selectedComponent ? () => {
          scope.addProbe(selectedComponent.id);
          setScopeVisible(true);
        } : undefined}
        isProbed={selectedComponent ? scope.probedIds.has(selectedComponent.id) : false}
        onLoadHex={selectedComponent?.type === 'atmega328' ? () => handleLoadHex(selectedComponent.id) : undefined}
        isHexLoaded={selectedComponent?.type === 'atmega328' ? simulator.current.isAVRLoaded(selectedComponent.id) : false}
        onWriteSketch={selectedComponent?.type === 'atmega328' ? () => {
          sketchTargetId.current = selectedComponent.id;
          setShowSketchEditor(true);
        } : undefined}
      />

      {pendingPowerDrop && (
        <PowerConfigModal
          onConfirm={handlePowerConfigConfirm}
          onCancel={() => setPendingPowerDrop(null)}
        />
      )}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showSketchEditor && (
        <SketchEditor
          onCompiled={(hex) => {
            if (sketchTargetId.current) {
              simulator.current.loadAVRProgram(sketchTargetId.current, hex);
              showStatus('Sketch compiled and loaded');
            }
            setShowSketchEditor(false);
          }}
          onClose={() => setShowSketchEditor(false)}
        />
      )}
    </div>
  );
}

export default App;
