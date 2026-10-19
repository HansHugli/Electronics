import { useState, useCallback, useRef, useEffect } from 'react';
import { PlacedComponent, Wire, Point } from './types';
import { COMPONENT_DEFINITIONS } from './data/components';
import { GRID_W, GRID_H, BOARD_X_OFFSET } from './data/breadboard';
import { createBlinkDemoCircuit, createCounterDemoCircuit, createAVRBlinkDemoCircuit, createMatrixDemoCircuit, createNecklaceDemoCircuit, AVR_BLINK_HEX, AVR_MATRIX_HEX, AVR_NECKLACE_HEX } from './engine/simulation';
import { CircuitSimulator } from './engine/CircuitSimulator';
import { useHistory } from './hooks/useHistory';
import { useSimulationLoop } from './hooks/useSimulationLoop';
import { loadExternalChips, chipJSONToDefinition } from './data/chipLoader';
import type { ChipDefinitionJSON } from './data/chipLoader';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import Breadboard from './components/Breadboard';
import PropertiesPanel from './components/PropertiesPanel';
import ChatPanel from './components/ChatPanel';
import PowerConfigModal from './components/PowerConfigModal';
import Oscilloscope, { useOscilloscope } from './components/Oscilloscope';
import AboutDialog from './components/AboutDialog';
import SettingsDialog from './components/SettingsDialog';
import SketchEditor from './components/SketchEditor';
import SerialMonitor from './components/SerialMonitor';
import PCBView from './components/PCBView';
import ContextMenu from './components/ContextMenu';
import UsagePanel from './components/UsagePanel';
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
  const [selectedComponentIds, setSelectedComponentIds] = useState<string[]>([]);
  const [selectedWireId, setSelectedWireId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [circuitName, setCircuitName] = useState('untitled');
  const [currentFilePath, setCurrentFilePath] = useState<string | undefined>(undefined);
  const [pendingPowerDrop, setPendingPowerDrop] = useState<Point | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const sidebarResizeStart = useRef<{ x: number; width: number } | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [showSketchEditor, setShowSketchEditor] = useState(false);
  const sketchTargetId = useRef<string | null>(null);
  const [serialVisible, setSerialVisible] = useState(false);
  const [showPCBView, setShowPCBView] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; componentId?: string; wireId?: string } | null>(null);
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simulator = useRef(new CircuitSimulator());
  const history = useHistory();
  const clipboard = useRef<PlacedComponent | null>(null);
  const dragStartPos = useRef<Point | null>(null);
  const [simSpeed, setSimSpeed] = useState(1); // multiplier: 0.25, 0.5, 1, 2, 5, 10
  const [simAccuracy, setSimAccuracy] = useState(1); // sub-steps per tick: 1, 2, 5, 10
  const [chipsLoaded, setChipsLoaded] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [scopeVisible, setScopeVisible] = useState(false);
  const scope = useOscilloscope();

  // Load external chip definitions on mount, then restore autosaved circuit
  useEffect(() => {
    loadExternalChips().then(async (count) => {
      if (count > 0) console.log(`Loaded ${count} external chip definition(s)`);
      setChipsLoaded(true);

      // Restore autosaved circuit if available
      if (window.electronApi?.loadAutosave) {
        try {
          const saved = await window.electronApi.loadAutosave();
          if (saved?.data) {
            const parsed = JSON.parse(saved.data);
            if (parsed.components?.length > 0 || parsed.wires?.length > 0) {
              setComponents(parsed.components || []);
              setWires(parsed.wires || []);
              if (parsed.circuitName) setCircuitName(parsed.circuitName);
              // Reset ID counters to avoid collisions
              const maxCompId = (parsed.components || []).reduce((max: number, c: PlacedComponent) => {
                const num = parseInt(c.id.replace(/\D/g, ''), 10);
                return isNaN(num) ? max : Math.max(max, num);
              }, 0);
              const maxWireId = (parsed.wires || []).reduce((max: number, w: Wire) => {
                const num = parseInt(w.id.replace(/\D/g, ''), 10);
                return isNaN(num) ? max : Math.max(max, num);
              }, 0);
              nextId = maxCompId + 1;
              nextWireId = maxWireId + 1;
              console.log(`Restored autosaved circuit (${parsed.components?.length} components, ${parsed.wires?.length} wires)`);
            }
          }
        } catch {
          // Ignore corrupt autosave
        }
      }
    });
  }, []);

  // Autosave circuit state on every change (debounced to 1 second)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!window.electronApi?.autosave) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const data = JSON.stringify({ components, wires, circuitName });
      window.electronApi!.autosave(data).catch(() => {});
    }, 1000);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [components, wires, circuitName]);

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

  // Restore saved sidebar width on mount.
  useEffect(() => {
    if (!window.electronApi?.getConfig) return;
    window.electronApi.getConfig().then((cfg) => {
      if (cfg.sidebarWidth) setSidebarWidth(cfg.sidebarWidth);
    });
  }, []);

  // Sidebar drag-to-resize. We attach window listeners on mousedown so the
  // user can drag past the handle without losing the gesture, and persist
  // the final width to config on mouseup.
  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarResizeStart.current = { x: e.clientX, width: sidebarWidth };
    setSidebarResizing(true);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!sidebarResizing) return;
    const onMove = (e: MouseEvent) => {
      if (!sidebarResizeStart.current) return;
      // Sidebar is on the right, so dragging LEFT (negative dx) widens it.
      const dx = e.clientX - sidebarResizeStart.current.x;
      const next = Math.max(240, Math.min(720, sidebarResizeStart.current.width - dx));
      setSidebarWidth(next);
    };
    const onUp = () => {
      setSidebarResizing(false);
      sidebarResizeStart.current = null;
      // Persist the new width to config.
      if (window.electronApi?.chatSetSidebarWidth) {
        window.electronApi.chatSetSidebarWidth(sidebarWidth);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sidebarResizing, sidebarWidth]);

  // Simulation loop — paced by wall-clock time (useSimulationLoop): each frame
  // advances the circuit by elapsed wall time × speed, with automatic
  // sub-stepping inside the engine. The tick runs outside React updaters.
  const wiresRef = useRef(wires);
  wiresRef.current = wires;
  const simComponentsRef = useRef(components);
  simComponentsRef.current = components;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  simulator.current.scopeProbeIds = scope.probedIds;

  const simClock = useSimulationLoop({
    running: simRunning,
    speed: simSpeed,
    accuracy: simAccuracy,
    simulator: simulator.current,
    componentsRef: simComponentsRef,
    wiresRef,
    setComponents,
    onAdvance: (updated, simTimeMs) => {
      scopeRef.current.recordSamples(simulator.current.scopeSamples, updated, simTimeMs);
      setSimTime(simTimeMs);
    },
  });
  // simClock.lagging / simClock.effectiveSpeed are for the toolbar's sim clock.
  void simClock;

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

  /** Click-to-place: put the component at the first non-overlapping position
   *  near the top-left of the board so the user can see it and drag it. */
  const handleClickPlace = useCallback((type: string) => {
    if (type === 'power') {
      // Place power in the supply area, scan rows for a free spot
      for (let row = 0; row < 40; row++) {
        const position = { x: 0, y: row * GRID_H };
        const comp: PlacedComponent = {
          id: genId(), type: 'power', position, rotation: 0,
          properties: { voltage: 5, mode: 'DC', waveform: 'square' },
          state: {},
        };
        if (!components.some((c) => componentsOverlap(comp, c))) {
          setPendingPowerDrop(position);
          return;
        }
      }
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

    // Choose placement column: DIP chips go at col 6 to straddle gap, others at col 2
    const placeCol = (def.width === 2) ? 6 : 2;

    // Compute pin offset for first pin (same logic as snapComponentToGrid)
    const pin0 = def.pins[0];
    const compW = def.width * GRID_W;
    const compH = def.height * GRID_H;
    let pinOX = 0, pinOY = 0;
    if (pin0) {
      switch (pin0.side) {
        case 'left':   pinOX = 0;                pinOY = compH * pin0.offset; break;
        case 'right':  pinOX = compW;            pinOY = compH * pin0.offset; break;
        case 'top':    pinOX = compW * pin0.offset; pinOY = 0;                break;
        case 'bottom': pinOX = compW * pin0.offset; pinOY = compH;            break;
      }
    }

    // Scan rows for a free spot
    const holeX = BOARD_X_OFFSET + placeCol * GRID_W + GRID_W / 2;
    for (let row = 0; row < 45; row++) {
      const holeY = row * GRID_H + GRID_H / 2;
      const position = { x: holeX - pinOX, y: holeY - pinOY };
      const comp: PlacedComponent = {
        id: genId(), type, position, rotation: 0,
        properties: defaults, state: {},
      };
      if (!components.some((c) => componentsOverlap(comp, c))) {
        setComponents((prev) => {
          const next = [...prev, comp];
          history.push(next, wires);
          return next;
        });
        setSelectedComponentIds([comp.id]);
        return;
      }
    }
  }, [components, wires, history]);

  /** Delete a custom component type — removes all instances, wires, definition, and disk file. */
  const handleDeleteComponentType = useCallback((typeId: string) => {
    const def = COMPONENT_DEFINITIONS[typeId];
    if (!def) return;

    const instanceCount = components.filter((c) => c.type === typeId).length;
    const msg = instanceCount > 0
      ? `Delete "${def.label}" and remove ${instanceCount} instance(s) from the board?`
      : `Delete "${def.label}" component type?`;
    if (!window.confirm(msg)) return;

    // Remove all placed instances and their wires
    const instanceIds = components.filter((c) => c.type === typeId).map((c) => c.id);
    if (instanceIds.length > 0) {
      setComponents((prev) => {
        const next = prev.filter((c) => c.type !== typeId);
        setWires((prevWires) => {
          const nextWires = prevWires.filter(
            (w) => !instanceIds.includes(w.from.componentId) && !instanceIds.includes(w.to.componentId),
          );
          history.push(next, nextWires);
          return nextWires;
        });
        return next;
      });
      setSelectedComponentIds((prev) => prev.filter((id) => !instanceIds.includes(id)));
    }

    delete COMPONENT_DEFINITIONS[typeId];
    setCatalogVersion((v) => v + 1);

    if (window.electronApi?.deleteChip) {
      window.electronApi.deleteChip(typeId).catch(() => {});
    }
  }, [components, history]);

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

  const handleMoveSelection = useCallback((moves: { id: string; position: Point }[]) => {
    setComponents((prev) => prev.map((c) => {
      const move = moves.find((m) => m.id === c.id);
      return move ? { ...c, position: move.position } : c;
    }));
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

  const handleSelectComponent = useCallback((id: string | null, additive = false) => {
    if (id === null) {
      setSelectedComponentIds([]);
    } else if (additive) {
      setSelectedComponentIds((prev) =>
        prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
      );
    } else {
      setSelectedComponentIds([id]);
    }
    if (id) setSelectedWireId(null);
  }, []);

  const handleSelectWire = useCallback((id: string | null) => {
    setSelectedWireId(id);
    if (id) setSelectedComponentIds([]);
  }, []);

  const handleDeleteComponents = useCallback((ids: string[]) => {
    setComponents((prev) => {
      const next = prev.filter((c) => !ids.includes(c.id));
      setWires((prevWires) => {
        const nextWires = prevWires.filter(
          (w) => !ids.includes(w.from.componentId) && !ids.includes(w.to.componentId)
        );
        history.push(next, nextWires);
        return nextWires;
      });
      return next;
    });
    setSelectedComponentIds((prev) => prev.filter((entry) => !ids.includes(entry)));
  }, [history]);

  const handleDeleteComponent = useCallback((id: string) => {
    handleDeleteComponents([id]);
  }, [handleDeleteComponents]);

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

  const handleSetSwitchClosed = useCallback((id: string, closed: boolean) => {
    setComponents((prev) =>
      prev.map((c) =>
        c.id === id && c.type === 'switch'
          ? { ...c, state: { ...c.state, closed: closed ? 1 : 0 } }
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
    if (simRunning) {
      setSimRunning(false);
      setSimTime(0);
      simulator.current.reset();
      setComponents((prev) => prev.map((c) => ({ ...c, state: {} })));
      scope.clearTraces();
    } else {
      setSimRunning(true);
    }
  }, [simRunning, scope]);

  const handleClearCircuit = useCallback(() => {
    setSimRunning(false);
    setSimTime(0);
    setComponents([]);
    setWires([]);
    setWiringFrom(null);
    setSelectedComponentIds([]);
    setSelectedWireId(null);
    setCircuitName('untitled');
    setCurrentFilePath(undefined);
    history.reset([], []);
  }, [history]);

  // ---- AI Circuit Tool Executor ---- //
  //
  // Refs that always hold the latest state so the synchronous executor
  // reads current values without needing to be re-created on every render.
  const componentsRef = useRef(components);
  componentsRef.current = components;
  // wiresRef is already declared above for the simulation loop.

  const handleExecuteToolCalls = useCallback(
    (toolCalls: { id: string; name: string; input: Record<string, unknown> }[]) => {
      const results: { id: string; result: { success: boolean; message: string; data?: Record<string, unknown> } }[] = [];

      for (const tc of toolCalls) {
        try {
          const result = executeSingleTool(tc.name, tc.input);
          results.push({ id: tc.id, result });
        } catch (err) {
          results.push({
            id: tc.id,
            result: { success: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` },
          });
        }
      }

      // Push undo snapshot after all tool calls in the batch
      history.push(componentsRef.current, wiresRef.current);
      return results;

      function executeSingleTool(
        name: string,
        input: Record<string, unknown>,
      ): { success: boolean; message: string; data?: Record<string, unknown> } {
        switch (name) {
          case 'add_component': {
            const type = input.type as string;
            let col = input.col as number;
            const row = input.row as number;
            const props = (input.properties as Record<string, number | string> | undefined) ?? {};

            const def = COMPONENT_DEFINITIONS[type];
            if (!def) {
              return { success: false, message: `Unknown component type "${type}". Check the catalog.` };
            }

            // Build default properties, then overlay any provided values
            const defaults: Record<string, number | string> = {};
            if (def.properties) {
              for (const [key, prop] of Object.entries(def.properties)) {
                defaults[key] = prop.default;
              }
            }
            const mergedProps = { ...defaults, ...props };

            // Auto-correct DIP chip placement to straddle the center gap.
            // Width-2 chips need left pins on col 6 (board 1) or col 22 (board 2).
            if (def.width === 2 && type !== 'power' && type !== 'multimeter') {
              if (col >= 2 && col <= 8) col = 6;
              else if (col >= 18 && col <= 24) col = 22;
            }

            // Compute position so the first pin lands on the grid hole center
            // at (col, row). This mirrors Breadboard's snapComponentToGrid logic.
            const pin0 = def.pins[0];
            const compW = def.width * GRID_W;
            const compH = def.height * GRID_H;
            let pinOffX = 0, pinOffY = 0;
            if (pin0) {
              switch (pin0.side) {
                case 'left':   pinOffX = 0;                pinOffY = compH * pin0.offset; break;
                case 'right':  pinOffX = compW;            pinOffY = compH * pin0.offset; break;
                case 'top':    pinOffX = compW * pin0.offset; pinOffY = 0;                break;
                case 'bottom': pinOffX = compW * pin0.offset; pinOffY = compH;            break;
              }
            }
            // Hole center for the target grid cell
            const holeX = BOARD_X_OFFSET + col * GRID_W + GRID_W / 2;
            const holeY = row * GRID_H + GRID_H / 2;
            // Component position = hole center minus pin offset within component
            const position = { x: holeX - pinOffX, y: holeY - pinOffY };
            const comp: PlacedComponent = {
              id: genId(),
              type,
              position,
              rotation: 0,
              properties: mergedProps,
              state: {},
            };

            // Check for overlap
            if (componentsRef.current.some((c) => componentsOverlap(comp, c))) {
              return { success: false, message: `Position (${col}, ${row}) would overlap an existing component. Try a different location.` };
            }

            const next = [...componentsRef.current, comp];
            setComponents(next);
            componentsRef.current = next;
            return {
              success: true,
              message: `Added ${def.label} at (${col}, ${row})`,
              data: { componentId: comp.id },
            };
          }

          case 'add_wire': {
            const from = input.from as { componentId: string; pinId: string };
            const to = input.to as { componentId: string; pinId: string };
            const color = (input.color as string) || WIRE_COLORS[wireColorIdx++ % WIRE_COLORS.length];

            // Validate endpoints exist
            for (const ep of [from, to]) {
              if (ep.componentId !== 'board') {
                const comp = componentsRef.current.find((c) => c.id === ep.componentId);
                if (!comp) {
                  return { success: false, message: `Component "${ep.componentId}" not found.` };
                }
                const def = COMPONENT_DEFINITIONS[comp.type];
                if (def && !def.pins.some((p) => p.id === ep.pinId)) {
                  return {
                    success: false,
                    message: `Pin "${ep.pinId}" not found on ${comp.type} (${comp.id}). Available pins: ${def.pins.map((p) => p.id).join(', ')}`,
                  };
                }
              }
            }

            const wire: Wire = {
              id: genWireId(),
              from,
              to,
              waypoints: [],
              color,
            };
            const nextWires = [...wiresRef.current, wire];
            setWires(nextWires);
            wiresRef.current = nextWires;
            return {
              success: true,
              message: `Wired ${from.componentId}.${from.pinId} → ${to.componentId}.${to.pinId}`,
              data: { wireId: wire.id },
            };
          }

          case 'remove_component': {
            const componentId = input.componentId as string;
            const comp = componentsRef.current.find((c) => c.id === componentId);
            if (!comp) {
              return { success: false, message: `Component "${componentId}" not found.` };
            }
            const nextComps = componentsRef.current.filter((c) => c.id !== componentId);
            const nextWires = wiresRef.current.filter(
              (w) => w.from.componentId !== componentId && w.to.componentId !== componentId,
            );
            setComponents(nextComps);
            setWires(nextWires);
            componentsRef.current = nextComps;
            wiresRef.current = nextWires;
            return { success: true, message: `Removed ${comp.type} (${componentId}) and its wires.` };
          }

          case 'remove_wire': {
            const wireId = input.wireId as string;
            const wire = wiresRef.current.find((w) => w.id === wireId);
            if (!wire) {
              return { success: false, message: `Wire "${wireId}" not found.` };
            }
            const nextWires = wiresRef.current.filter((w) => w.id !== wireId);
            setWires(nextWires);
            wiresRef.current = nextWires;
            return { success: true, message: `Removed wire ${wireId}.` };
          }

          case 'clear_circuit': {
            setComponents([]);
            setWires([]);
            componentsRef.current = [];
            wiresRef.current = [];
            setSelectedComponentIds([]);
            setWiringFrom(null);
            return { success: true, message: 'Cleared all components and wires.' };
          }

          case 'list_components': {
            const list = componentsRef.current.map((c) => ({
              id: c.id,
              type: c.type,
              col: Math.round((c.position.x - BOARD_X_OFFSET) / GRID_W),
              row: Math.round(c.position.y / GRID_H),
              properties: c.properties,
            }));
            const wireList = wiresRef.current.map((w) => ({
              id: w.id,
              from: `${w.from.componentId}.${w.from.pinId}`,
              to: `${w.to.componentId}.${w.to.pinId}`,
            }));
            return {
              success: true,
              message: `${list.length} components, ${wireList.length} wires on the board.`,
              data: { components: list as unknown as Record<string, unknown>, wires: wireList as unknown as Record<string, unknown> },
            };
          }

          case 'create_component_type': {
            const typeId = input.type as string;
            const label = input.label as string;
            const description = (input.description as string) || `${label} component`;
            const category = (input.category as string) || 'active';
            const color = (input.color as string) || '#4a4a4a';
            const inputPins = input.pins as { id: string; label: string; side: string; type: string }[];
            const props = input.properties as Record<string, { label: string; default: number | string; unit?: string }> | undefined;

            if (!typeId || !label || !inputPins || inputPins.length === 0) {
              return { success: false, message: 'type, label, and at least one pin are required.' };
            }

            if (COMPONENT_DEFINITIONS[typeId]) {
              const existing = COMPONENT_DEFINITIONS[typeId];
              return {
                success: true,
                message: `Component type "${typeId}" already exists (${existing.label}). Use it directly with add_component.`,
                data: { type: typeId, pins: existing.pins.map((p) => p.id) },
              };
            }

            // Build chip JSON and register it
            const totalPins = inputPins.length;
            const pinsPerSide = Math.ceil(totalPins / 2);
            const chipJson: ChipDefinitionJSON = {
              type: typeId,
              label,
              description,
              icon: label.slice(0, 2).toUpperCase(),
              chipLabel: label,
              category,
              behavior: 'passthrough',
              color,
              width: 2,
              height: pinsPerSide,
              pins: inputPins.map((p, i) => {
                const sideCount = inputPins.filter((pp) => pp.side === p.side);
                const sideIdx = sideCount.slice(0, sideCount.indexOf(p) + 1).length - 1;
                const totalOnSide = sideCount.length;
                return {
                  id: p.id,
                  label: p.label,
                  side: p.side as 'left' | 'right',
                  offset: totalOnSide === 1 ? 0.5 : (2 * (totalOnSide - 1 - sideIdx) + 1) / (2 * totalOnSide),
                  type: p.type as 'power' | 'ground' | 'input' | 'output' | 'bidirectional',
                  number: i + 1,
                };
              }),
              properties: props,
            };

            const def = chipJSONToDefinition(chipJson);
            COMPONENT_DEFINITIONS[typeId] = def;
            setCatalogVersion((v) => v + 1);

            // Persist to disk so the component survives app restarts
            if (window.electronApi?.saveChip) {
              window.electronApi.saveChip(chipJson).catch(() => {});
            }

            return {
              success: true,
              message: `Created new component type "${typeId}" (${label}) with ${totalPins} pins. You can now place it with add_component.`,
              data: { type: typeId, pins: inputPins.map((p) => p.id) },
            };
          }

          case 'delete_component_type': {
            const typeId = input.type as string;
            if (!typeId) {
              return { success: false, message: 'type is required.' };
            }
            if (!COMPONENT_DEFINITIONS[typeId]) {
              return { success: false, message: `Component type "${typeId}" not found.` };
            }
            // Remove all placed instances and their wires
            const instanceIds = componentsRef.current.filter((c) => c.type === typeId).map((c) => c.id);
            if (instanceIds.length > 0) {
              const nextComps = componentsRef.current.filter((c) => c.type !== typeId);
              const nextWires = wiresRef.current.filter(
                (w) => !instanceIds.includes(w.from.componentId) && !instanceIds.includes(w.to.componentId),
              );
              setComponents(nextComps);
              setWires(nextWires);
              componentsRef.current = nextComps;
              wiresRef.current = nextWires;
            }

            // Remove the definition
            delete COMPONENT_DEFINITIONS[typeId];
            setCatalogVersion((v) => v + 1);

            // Delete from disk
            if (window.electronApi?.deleteChip) {
              window.electronApi.deleteChip(typeId).catch(() => {});
            }

            return {
              success: true,
              message: `Deleted component type "${typeId}"${instanceIds.length > 0 ? ` and removed ${instanceIds.length} instance(s) from the board` : ''}.`,
            };
          }

          default:
            return { success: false, message: `Unknown tool "${name}".` };
        }
      }
    },
    [history],
  );

  const showStatus = useCallback((msg: string) => {
    setSaveStatus(msg);
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 3000);
  }, []);

  const loadCircuitState = useCallback((data: { components: PlacedComponent[]; wires: Wire[] }, name?: string, filePath?: string) => {
    setComponents(data.components);
    setWires(data.wires);
    setSelectedComponentIds([]);
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
          if (snap) { setComponents(snap.components); setWires(snap.wires); setSelectedComponentIds([]); setSelectedWireId(null); }
          break;
        }
        case 'redo': {
          const snap = history.redo();
          if (snap) { setComponents(snap.components); setWires(snap.wires); setSelectedComponentIds([]); setSelectedWireId(null); }
          break;
        }
        case 'copy': {
          if (selectedComponentIds.length > 0) {
            const comp = components.find((c) => c.id === selectedComponentIds[0]);
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
              setSelectedComponentIds([newComp.id]);
              clipboard.current = newComp;
            }
          }
          break;
        }
      }
    };
  }, [handleSave, handleLoad, history, selectedComponentIds, components, wires]);

  // ---- Demo ---- //

  const handleLoadDemo = useCallback(async (demoName?: string) => {
    const demoMap: Record<string, { name: string; create: () => { components: PlacedComponent[]; wires: Wire[] } }> = {
      blink:      { name: 'LED Blink Demo',     create: createBlinkDemoCircuit },
      counter:    { name: '7-Seg Counter Demo',  create: createCounterDemoCircuit },
      'avr-blink': { name: 'AVR Blink Demo',    create: createAVRBlinkDemoCircuit },
      matrix:     { name: '5x7 Matrix Demo',    create: createMatrixDemoCircuit },
      necklace:   { name: 'Necklace Demo',      create: createNecklaceDemoCircuit },
    };
    const key = demoName ?? 'blink';
    const entry = demoMap[key] ?? demoMap.blink;

    // Always generate from code (demos are code-defined, not user files)
    const circuit = entry.create();
    loadCircuitState(circuit, entry.name);
    simulator.current.reset();

    // For AVR demos, pre-load the hex program
    if (key === 'avr-blink') {
      simulator.current.loadAVRProgram('avr1', AVR_BLINK_HEX);
    } else if (key === 'matrix') {
      console.log('Loading matrix demo with AVR firmware');
      simulator.current.loadAVRProgram('avr1', AVR_MATRIX_HEX);
      showStatus('5x7 matrix demo loaded with AVR firmware');
    } else if (key === 'necklace') {
      console.log('Loading necklace demo with AVR firmware');
      simulator.current.loadAVRProgram('avr1', AVR_NECKLACE_HEX);
      showStatus('Necklace demo loaded with AVR firmware');
    }

    // Save to disk so user can find/modify them
    if (window.electronApi?.saveDemo) {
      const data = JSON.stringify(circuit, null, 2);
      const filePath = await window.electronApi.saveDemo(entry.name, data);
      setCurrentFilePath(filePath);
    } else {
      setCurrentFilePath(undefined);
    }
  }, [loadCircuitState]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
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
          setSelectedComponentIds([]);
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
          setSelectedComponentIds([]);
          setSelectedWireId(null);
        }
        return;
      }
      // Copy
      if (ctrl && e.key === 'c' && !isInput) {
        if (selectedComponentIds.length > 0) {
          const comp = components.find((c) => c.id === selectedComponentIds[0]);
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
          setSelectedComponentIds([newComp.id]);
          // Update clipboard to point to new component for repeated paste
          clipboard.current = newComp;
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isInput) return;
        if (selectedComponentIds.length > 0) {
          handleDeleteComponents(selectedComponentIds);
        }
        if (selectedWireId) {
          handleDeleteWire(selectedWireId);
        }
        return;
      }
      if (e.key === 'Escape') {
        if (isInput) return;
        setWiringFrom(null);
        setSelectedComponentIds([]);
        setSelectedWireId(null);
        setContextMenu(null);
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        if (isInput) return;
        if (selectedComponentIds.length === 1) {
          const selectedId = selectedComponentIds[0];
          setComponents((prev) => {
            const next = prev.map((c) =>
              c.id === selectedId
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
}, [handleSave, handleLoad, selectedComponentIds, selectedWireId, handleDeleteComponents, handleDeleteWire, components, wires, history]);

  const selectedComponent = components.find((c) => c.id === selectedComponentIds[0]) ?? null;
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
      <Sidebar onClick={handleClickPlace} onDeleteType={handleDeleteComponentType} catalogVersion={catalogVersion} />
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
          onShowPCB={() => setShowPCBView(true)}
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
            onMoveSelection={handleMoveSelection}
            onMoveEnd={handleMoveEnd}
            onStartWire={handleStartWire}
            onEndWire={handleEndWire}
            wiringFrom={wiringFrom}
            onSelectComponent={handleSelectComponent}
            selectedComponentIds={selectedComponentIds}
            onSelectWire={handleSelectWire}
            selectedWireId={selectedWireId}
            onToggleSwitch={handleToggleSwitch}
            onSetSwitchClosed={handleSetSwitchClosed}
            wireCurrents={simulator.current.wireCurrents}
            pinHoleVoltages={simulator.current.pinHoleVoltages}
            onContextMenu={(e, compId, wireId) => {
              setContextMenu({ x: e.clientX, y: e.clientY, componentId: compId, wireId });
            }}
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
        <SerialMonitor
          components={components}
          visible={serialVisible}
          onToggle={() => setSerialVisible((v) => !v)}
          simRunning={simRunning}
        />
      </div>
      <div
        className="right-sidebar"
        ref={(el) => {
          if (el) el.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
        }}
      >
        <div
          className={`sidebar-resize-handle ${sidebarResizing ? 'dragging' : ''}`}
          onMouseDown={handleSidebarResizeStart}
        />
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
        <ChatPanel
          components={components}
          wires={wires}
          selectedComponent={selectedComponent}
          onOpenSettings={() => setShowSettings(true)}
          onOpenUsage={() => setShowUsage(true)}
          onExecuteToolCalls={handleExecuteToolCalls}
        />
      </div>

      {pendingPowerDrop && (
        <PowerConfigModal
          onConfirm={handlePowerConfigConfirm}
          onCancel={() => setPendingPowerDrop(null)}
        />
      )}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showUsage && <UsagePanel onClose={() => setShowUsage(false)} />}
      {showPCBView && <PCBView components={components} wires={wires} onClose={() => setShowPCBView(false)} />}
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
      {contextMenu && (() => {
        const items: { label: string; shortcut?: string; onClick: () => void; danger?: boolean }[] = [];
        if (contextMenu.componentId) {
          const comp = components.find((c) => c.id === contextMenu.componentId);
          if (comp && comp.type !== 'power') {
            items.push({ label: 'Rotate', shortcut: 'R', onClick: () => {
              setComponents((prev) => prev.map((c) => c.id === contextMenu.componentId ? { ...c, rotation: (c.rotation + 90) % 360 } : c));
            }});
          }
          items.push({ label: 'Copy', shortcut: 'Ctrl+C', onClick: () => {
            if (comp) clipboard.current = { ...comp };
          }});
          items.push({ label: 'Delete', shortcut: 'Del', danger: true, onClick: () => {
            if (contextMenu.componentId) handleDeleteComponent(contextMenu.componentId);
          }});
        } else if (contextMenu.wireId) {
          items.push({ label: 'Delete Wire', shortcut: 'Del', danger: true, onClick: () => {
            if (contextMenu.wireId) handleDeleteWire(contextMenu.wireId);
          }});
        }
        if (items.length === 0) return null;
        return <ContextMenu x={contextMenu.x} y={contextMenu.y} items={items} onClose={() => setContextMenu(null)} />;
      })()}
    </div>
  );
}

export default App;
