import { useState, useCallback, useRef, useEffect } from 'react';
import { PlacedComponent, Wire, Point } from './types';
import { COMPONENT_DEFINITIONS } from './data/components';
import { GRID_W, GRID_H, BOARD_X_OFFSET } from './data/breadboard';
import { createBlinkDemoCircuit, createCounterDemoCircuit, createAVRBlinkDemoCircuit, createMatrixDemoCircuit, createNecklaceDemoCircuit, AVR_BLINK_HEX, AVR_MATRIX_HEX, AVR_NECKLACE_HEX } from './engine/simulation';
import { CircuitSimulator } from './engine/CircuitSimulator';
import { useHistory } from './hooks/useHistory';
import {
  parseCircuitText, serializeCircuit, serializeAutosave, maxIdNumber, errorMessage,
  AutosaveData,
} from './hooks/circuitFile';
import { loadExternalChips, chipJSONToDefinition } from './data/chipLoader';
import type { ChipDefinitionJSON } from './data/chipLoader';
import Sidebar, { BUILT_IN_TYPES } from './components/Sidebar';
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
import { ModalLayer, ConfirmDialog, ConfirmButton } from './components/Modal';
import ToastList, { useToasts } from './components/Toast';
import ProblemsPanel from './components/ProblemsPanel';
import { shortcutsBlocked } from './components/modalStack';
import { generateKiCadNetlist, generateBOM } from './engine/pcbExport';
import {
  checkBoardCapacity,
  LIMITS,
  RequestBudget,
  validateAddComponent,
  validateAddWire,
  validateClearCircuit,
  validateCreateComponentType,
  validateDeleteComponentType,
  validateId,
  validateListComponentTypes,
} from './ai/toolValidation';
import { describeComponentType, gridOf, positionForGrid } from './ai/circuitContext';
import { BUILTIN_TYPE_IDS } from './ai/builtinTypes';

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

/**
 * Preload API of the shell branch (shared contract), declared locally and
 * optional so this branch works with or without it.
 */
type ShellApi = ElectronApi & {
  onCloseRequest?: (cb: () => void) => () => void;
  confirmClose?: () => void;
  getDataStatus?: () => Promise<{ dataDir: string; ok: boolean; problem?: string }>;
  /** Always ask for a file name (Save As). Without it, saveCircuit asks. */
  saveCircuitAs?: (data: string, defaultPath?: string) => Promise<{ filePath: string; name: string } | null>;
};
function shellApi(): ShellApi | undefined {
  return window.electronApi as ShellApi | undefined;
}

const isKnownType = (type: string) => !!COMPONENT_DEFINITIONS[type];

/** Load firmware into the current simulator, if this engine version still takes it directly. */
function loadFirmware(sim: CircuitSimulator, componentId: string, hex: string) {
  const s = sim as unknown as { loadAVRProgram?: (id: string, hex: string) => void };
  s.loadAVRProgram?.(componentId, hex);
}

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

interface ConfirmState {
  title: string;
  message: string;
  buttons: ConfirmButton[];
  onCancel: () => void;
}

function App({ skipRestore = false }: { skipRestore?: boolean }) {
  const [components, setComponents] = useState<PlacedComponent[]>([]);
  const [wires, setWires] = useState<Wire[]>([]);
  const [simRunning, setSimRunning] = useState(false);
  const [simTime, setSimTime] = useState(0);
  const [wiringFrom, setWiringFrom] = useState<{ componentId: string; pinId: string } | null>(null);
  const [selectedComponentIds, setSelectedComponentIds] = useState<string[]>([]);
  const [selectedWireId, setSelectedWireId] = useState<string | null>(null);
  const [circuitName, setCircuitName] = useState('untitled');
  const [currentFilePath, setCurrentFilePath] = useState<string | undefined>(undefined);
  const [pendingPowerDrop, setPendingPowerDrop] = useState<Point | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const sidebarResizeStart = useRef<{ x: number; width: number } | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  /** The ATmega whose sketch is open in the editor (null = editor closed). */
  const [sketchTargetId, setSketchTargetId] = useState<string | null>(null);
  const [serialVisible, setSerialVisible] = useState(false);
  const [showPCBView, setShowPCBView] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; componentId?: string; wireId?: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [dataProblem, setDataProblem] = useState<string | null>(null);
  /** Bumped to make the board zoom to fit (after a load). */
  const [fitRequest, setFitRequest] = useState(0);
  /** False until the autosave restore has finished or failed: autosave must not run before (D2). */
  const [restoreDone, setRestoreDone] = useState(false);
  const simulator = useRef(new CircuitSimulator());
  const history = useHistory();
  const toasts = useToasts();
  const showToast = toasts.show;
  const clipboard = useRef<PlacedComponent | null>(null);
  const [simSpeed, setSimSpeed] = useState(1); // multiplier: 0.25, 0.5, 1, 2, 5, 10
  const [simAccuracy, setSimAccuracy] = useState(1); // sub-steps per tick: 1, 2, 5, 10
  const [, setChipsLoaded] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [scopeVisible, setScopeVisible] = useState(false);
  const scope = useOscilloscope();

  const dirty = history.isDirty();
  const circuitNameRef = useRef(circuitName);
  circuitNameRef.current = circuitName;
  const currentFilePathRef = useRef(currentFilePath);
  currentFilePathRef.current = currentFilePath;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /**
   * Put a circuit from disk on the board. `fresh` starts a new undo history
   * (file open, autosave restore); otherwise the load is one undoable step
   * (examples), so the previous circuit can be brought back with Undo.
   */
  const applyCircuit = useCallback((
    data: AutosaveData,
    opts: { name?: string; filePath?: string; fresh: boolean; dirty?: boolean },
  ) => {
    setSimRunning(false);
    setSimTime(0);
    simulator.current.reset();
    setComponents(data.components);
    setWires(data.wires);
    setSelectedComponentIds([]);
    setSelectedWireId(null);
    setWiringFrom(null);
    setCircuitName(opts.name ?? 'untitled');
    setCurrentFilePath(opts.filePath);
    // Never hand out an id that's already used, including by circuits that
    // Undo can bring back.
    nextId = Math.max(nextId, maxIdNumber(data.components) + 1);
    nextWireId = Math.max(nextWireId, maxIdNumber(data.wires) + 1);
    if (opts.fresh) history.reset(data.components, data.wires);
    else history.push(data.components, data.wires);
    if (opts.dirty) history.markUnsaved(); else history.markSaved();
    // Firmware travels in properties.hex; hand it to the simulator too.
    for (const c of data.components) {
      if (c.type === 'atmega328' && typeof c.properties.hex === 'string' && c.properties.hex) {
        try { loadFirmware(simulator.current, c.id, c.properties.hex); } catch { /* reported on Run */ }
      }
    }
    setFitRequest((n) => n + 1);
  }, [history]);

  // Load external chip definitions on mount, then restore the autosaved circuit.
  // Autosave stays off until this has finished or failed (D2), and the
  // restored circuit becomes the start of the undo history (D1).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const count = await loadExternalChips();
        if (count > 0) console.log(`Loaded ${count} external chip definition(s)`);
      } catch (err) {
        if (!cancelled) showToast(`Custom chips couldn't be loaded: ${errorMessage(err)}`, 'error');
      }
      if (cancelled) return;
      setChipsLoaded(true);
      setCatalogVersion((v) => v + 1);

      let restored = false;
      const api = shellApi();
      if (!skipRestore && api?.loadAutosave) {
        try {
          const saved = await api.loadAutosave();
          if (cancelled) return;
          if (saved?.data) {
            const result = parseCircuitText(saved.data, isKnownType);
            if (!result.ok) {
              showToast(`The last autosave couldn't be restored: ${result.error}`, 'error');
            } else if (result.circuit.components.length > 0 || result.circuit.wires.length > 0) {
              const c = result.circuit;
              applyCircuit(c, { name: c.circuitName, filePath: c.currentFilePath, fresh: true, dirty: c.dirty ?? true });
              restored = true;
              lastAutosaved.current = saved.data;
              console.log(`Restored autosaved circuit (${c.components.length} components, ${c.wires.length} wires)`);
            }
          }
        } catch (err) {
          if (!cancelled) showToast(`The last autosave couldn't be read: ${errorMessage(err)}`, 'error');
        }
      }
      if (cancelled) return;
      if (!restored) {
        // An empty, untitled board: the base of the undo history, and clean.
        history.reset([], []);
        history.markSaved();
        lastAutosaved.current = serializeAutosave({ components: [], wires: [], circuitName: 'untitled', dirty: false });
      }
      setRestoreDone(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave: at most once a second, only after the restore, and only when
  // the circuit (not just the simulator's readings) changed. It keeps the
  // file path and name, so a restart continues where you were.
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutosaved = useRef<string | null>(null);
  const autosaveFailed = useRef(false);
  useEffect(() => {
    const api = shellApi();
    if (!restoreDone || !api?.autosave) return;
    if (autosaveTimer.current) return;
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null;
      const data = serializeAutosave({
        components: componentsRef.current,
        wires: wiresRef.current,
        circuitName: circuitNameRef.current,
        currentFilePath: currentFilePathRef.current,
        dirty: dirtyRef.current,
      });
      if (data === lastAutosaved.current) return;
      api.autosave(data).then(() => {
        lastAutosaved.current = data;
        if (autosaveFailed.current) showToast('Autosave is working again.');
        autosaveFailed.current = false;
      }).catch((err) => {
        if (!autosaveFailed.current) {
          showToast(`Autosave failed: ${errorMessage(err)} Use Save to keep your work.`, 'error');
        }
        autosaveFailed.current = true;
      });
    }, 1000);
  }, [components, wires, circuitName, currentFilePath, dirty, restoreDone, showToast]);
  useEffect(() => () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); }, []);

  // Listen for menu actions from Electron — ref set up below after handlers are defined
  const menuActionRef = useRef<(action: string) => void>(() => {});
  useEffect(() => {
    if (!window.electronApi?.onMenuAction) return;
    window.electronApi.onMenuAction((action) => menuActionRef.current(action));
  }, []);

  // Window title shows the circuit name, with * while there are unsaved changes.
  useEffect(() => {
    const title = `${circuitName}${dirty ? ' *' : ''} — E101 Electronics`;
    document.title = title;
    window.electronApi?.setTitle?.(title);
  }, [circuitName, dirty]);

  // A data folder problem (OneDrive missing, not writable…) stays visible.
  useEffect(() => {
    shellApi()?.getDataStatus?.()
      .then((s) => { if (s?.problem) setDataProblem(s.problem); })
      .catch(() => { /* older shell without the check */ });
  }, []);

  // Restore saved sidebar width on mount.
  useEffect(() => {
    if (!window.electronApi?.getConfig) return;
    window.electronApi.getConfig().then((cfg) => {
      if (cfg.sidebarWidth) setSidebarWidth(cfg.sidebarWidth);
    }).catch(() => { /* keep the default width */ });
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
      // Never so wide that the board and toolbar get squeezed out.
      const maxW = Math.max(240, Math.min(720, window.innerWidth - 220 - 560));
      const next = Math.max(240, Math.min(maxW, sidebarResizeStart.current.width - dx));
      setSidebarWidth(next);
    };
    const onUp = () => {
      setSidebarResizing(false);
      sidebarResizeStart.current = null;
      // Persist the new width to config.
      if (window.electronApi?.chatSetSidebarWidth) {
        window.electronApi.chatSetSidebarWidth(sidebarWidth).catch(() => {});
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sidebarResizing, sidebarWidth]);

  // Simulation loop — simple setInterval with tick guard
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wiresRef = useRef(wires);
  wiresRef.current = wires;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    // Clear any existing interval first (guards against StrictMode double-mount)
    if (simIntervalRef.current) {
      clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }
    if (simRunning) {
      const tickMs = Math.round(100 / simSpeed);
      simIntervalRef.current = setInterval(() => {
        setSimTime((prev) => {
          const next = prev + 100;
          simulator.current.subSteps = simAccuracy;
          setComponents((comps) => {
            const states = simulator.current.tick(comps, wiresRef.current, next, 0.1);
            const updated = comps.map((comp) => {
              const newState = states.get(comp.id);
              return newState ? { ...comp, state: newState } : comp;
            });
            scopeRef.current.recordTick(updated, next);
            return updated;
          });
          return next;
        });
      }, tickMs);
    }
    return () => {
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
        simIntervalRef.current = null;
      }
    };
  }, [simRunning, simSpeed, simAccuracy]);

  /**
   * Change the circuit as one undoable step. Computes from the latest state
   * (refs), so history is never pushed from inside a state updater.
   */
  const commitCircuit = useCallback((nextComponents: PlacedComponent[], nextWires: Wire[]) => {
    componentsRef.current = nextComponents;
    wiresRef.current = nextWires;
    setComponents(nextComponents);
    setWires(nextWires);
    history.push(nextComponents, nextWires);
  }, [history]);

  const defaultProperties = (type: string): Record<string, number | string> => {
    const def = COMPONENT_DEFINITIONS[type];
    const defaults: Record<string, number | string> = {};
    if (def?.properties) {
      for (const [key, prop] of Object.entries(def.properties)) {
        defaults[key] = prop.default;
      }
    }
    return defaults;
  };

  const handleDropComponent = useCallback((type: string, position: Point) => {
    if (type === 'power') {
      setPendingPowerDrop(position);
      return;
    }
    const def = COMPONENT_DEFINITIONS[type];
    if (!def) return;
    const comp: PlacedComponent = {
      id: genId(),
      type,
      position,
      rotation: 0,
      properties: defaultProperties(type),
      state: {},
    };
    // Reject drop if it would overlap an existing component
    if (componentsRef.current.some((c) => componentsOverlap(comp, c))) {
      showToast('There is already a part there.');
      return;
    }
    commitCircuit([...componentsRef.current, comp], wiresRef.current);
    setSelectedComponentIds([comp.id]);
    setSelectedWireId(null);
  }, [commitCircuit, showToast]);

  /** Click-to-place: put the component at the first non-overlapping position
   *  near the top-left of the board so the user can see it and drag it. */
  const handleClickPlace = useCallback((type: string) => {
    const current = componentsRef.current;
    if (type === 'power') {
      // Place power in the supply area, scan rows for a free spot
      for (let row = 0; row < 40; row++) {
        const position = { x: 0, y: row * GRID_H };
        const comp: PlacedComponent = {
          id: 'probe', type: 'power', position, rotation: 0,
          properties: { voltage: 5, mode: 'DC', waveform: 'square' },
          state: {},
        };
        if (!current.some((c) => componentsOverlap(comp, c))) {
          setPendingPowerDrop(position);
          return;
        }
      }
      showToast('No free spot left in the supply area.');
      return;
    }

    const def = COMPONENT_DEFINITIONS[type];
    if (!def) return;

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
      const probe: PlacedComponent = {
        id: 'probe', type, position, rotation: 0,
        properties: {}, state: {},
      };
      if (!current.some((c) => componentsOverlap(probe, c))) {
        const comp: PlacedComponent = { ...probe, id: genId(), properties: defaultProperties(type) };
        commitCircuit([...current, comp], wiresRef.current);
        setSelectedComponentIds([comp.id]);
        setSelectedWireId(null);
        return;
      }
    }
    showToast('No free spot left on the left edge of the board. Drag the part to a spot instead.');
  }, [commitCircuit, showToast]);

  /** Remove a custom component type: every instance and its wires (undoable), its definition and its file. */
  const deleteComponentType = useCallback((typeId: string) => {
    const instanceIds = componentsRef.current.filter((c) => c.type === typeId).map((c) => c.id);
    if (instanceIds.length > 0) {
      commitCircuit(
        componentsRef.current.filter((c) => c.type !== typeId),
        wiresRef.current.filter(
          (w) => !instanceIds.includes(w.from.componentId) && !instanceIds.includes(w.to.componentId),
        ),
      );
      setSelectedComponentIds((prev) => prev.filter((id) => !instanceIds.includes(id)));
    }

    delete COMPONENT_DEFINITIONS[typeId];
    setCatalogVersion((v) => v + 1);

    if (window.electronApi?.deleteChip) {
      window.electronApi.deleteChip(typeId).catch((err) => {
        showToast(`The chip file for "${typeId}" couldn't be deleted: ${errorMessage(err)}`, 'error');
      });
    }
  }, [commitCircuit, showToast]);

  /** Ask first (in-app, never window.confirm); built-in parts can't be deleted. */
  const handleDeleteComponentType = useCallback((typeId: string) => {
    const def = COMPONENT_DEFINITIONS[typeId];
    if (!def || BUILT_IN_TYPES.has(typeId)) return;
    const instanceCount = componentsRef.current.filter((c) => c.type === typeId).length;
    const close = () => setConfirm(null);
    setConfirm({
      title: 'Delete custom part?',
      message: instanceCount > 0
        ? `Delete the part type "${def.label}" and remove ${instanceCount} of them from the board? The board change can be undone; the part type itself can't.`
        : `Delete the part type "${def.label}"? This can't be undone.`,
      onCancel: close,
      buttons: [
        { label: 'Delete', kind: 'danger', onClick: () => { close(); deleteComponentType(typeId); } },
        { label: 'Cancel', onClick: close },
      ],
    });
  }, [deleteComponentType]);

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
    setPendingPowerDrop(null);
    if (componentsRef.current.some((c) => componentsOverlap(comp, c))) {
      showToast('There is already a part there.');
      return;
    }
    commitCircuit([...componentsRef.current, comp], wiresRef.current);
    setSelectedComponentIds([comp.id]);
  }, [pendingPowerDrop, commitCircuit, showToast]);

  // Dragging: the board previews positions live (no history), then reports
  // the final positions once; that is one undo entry.
  const handleMoveComponent = useCallback((id: string, position: Point) => {
    setComponents((prev) => {
      const moving = prev.find((c) => c.id === id);
      if (!moving) return prev;
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

  const handleMoveEnd = useCallback((moves: { id: string; position: Point }[] | null) => {
    if (!moves || moves.length === 0) return;
    const next = componentsRef.current.map((c) => {
      const move = moves.find((m) => m.id === c.id);
      return move ? { ...c, position: move.position } : c;
    });
    commitCircuit(next, wiresRef.current);
  }, [commitCircuit]);

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
    if (ids.length === 0) return;
    commitCircuit(
      componentsRef.current.filter((c) => !ids.includes(c.id)),
      wiresRef.current.filter((w) => !ids.includes(w.from.componentId) && !ids.includes(w.to.componentId)),
    );
    setSelectedComponentIds((prev) => prev.filter((entry) => !ids.includes(entry)));
  }, [commitCircuit]);

  const handleDeleteComponent = useCallback((id: string) => {
    handleDeleteComponents([id]);
  }, [handleDeleteComponents]);

  const handleDeleteWire = useCallback((id: string) => {
    commitCircuit(componentsRef.current, wiresRef.current.filter((w) => w.id !== id));
    setSelectedWireId((prev) => prev === id ? null : prev);
  }, [commitCircuit]);

  /** Rotate parts by `degrees` (90 = rotate, 180 = flip an LED's polarity) as one undo entry. */
  const rotateComponents = useCallback((ids: string[], degrees: number) => {
    const targets = componentsRef.current.filter((c) => ids.includes(c.id) && c.type !== 'power');
    if (targets.length === 0) return;
    commitCircuit(
      componentsRef.current.map((c) =>
        targets.includes(c) ? { ...c, rotation: (c.rotation + degrees) % 360 } : c,
      ),
      wiresRef.current,
    );
  }, [commitCircuit]);

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
      commitCircuit(componentsRef.current, [...wiresRef.current, wire]);
      setWiringFrom(null);
    },
    [wiringFrom, commitCircuit]
  );

  /** Set properties on one part as one undo entry. */
  const setPartProperties = useCallback((componentId: string, props: Record<string, number | string>) => {
    commitCircuit(
      componentsRef.current.map((c) => (c.id === componentId ? { ...c, properties: { ...c.properties, ...props } } : c)),
      wiresRef.current,
    );
  }, [commitCircuit]);

  const handlePropertyChange = useCallback((componentId: string, key: string, value: number | string) => {
    setPartProperties(componentId, { [key]: value });
  }, [setPartProperties]);

  /** Live preview (potentiometer drag): no undo entry; the release commits. */
  const handlePropertyPreview = useCallback((componentId: string, key: string, value: number | string) => {
    setComponents((prev) => prev.map((c) => (c.id === componentId ? { ...c, properties: { ...c.properties, [key]: value } } : c)));
  }, []);

  const handleToggleSimulation = useCallback(() => {
    if (simRunning) {
      setSimRunning(false);
      setSimTime(0);
      simulator.current.reset();
      // Readings reset; a switch keeps its position.
      setComponents((prev) => prev.map((c): PlacedComponent => ({
        ...c,
        state: c.type === 'switch' && c.state.closed ? { closed: c.state.closed } : {},
      })));
      scope.clearTraces();
    } else {
      // Firmware lives in properties.hex (saved with the circuit). Make sure
      // the simulator has it, e.g. after a restart or an Undo.
      for (const c of componentsRef.current) {
        if (c.type !== 'atmega328' || typeof c.properties.hex !== 'string' || !c.properties.hex) continue;
        if (simulator.current.isAVRLoaded(c.id)) continue;
        try {
          loadFirmware(simulator.current, c.id, c.properties.hex);
        } catch (err) {
          showToast(`The program on ${c.id} couldn't be loaded: ${errorMessage(err)}`, 'error');
        }
      }
      setSimRunning(true);
    }
  }, [simRunning, scope, showToast]);

  /** Empty the board (same file, same name) as one undoable step. */
  const clearBoard = useCallback(() => {
    setSimRunning(false);
    setSimTime(0);
    simulator.current.reset();
    commitCircuit([], []);
    setWiringFrom(null);
    setSelectedComponentIds([]);
    setSelectedWireId(null);
  }, [commitCircuit]);

  /** A new, untitled circuit (undoable: Undo brings the old parts back). */
  const newCircuit = useCallback(() => {
    clearBoard();
    setCircuitName('untitled');
    setCurrentFilePath(undefined);
    history.markSaved();
    setFitRequest((n) => n + 1);
  }, [clearBoard, history]);

  // Clear is undoable, so it needs no question unless there are unsaved
  // changes; then it asks (in-app) like New and loading an example.
  const handleClearCircuit = useCallback(() => {
    if (componentsRef.current.length === 0 && wiresRef.current.length === 0) return;
    guardUnsavedRef.current('Clear the board?', `"${circuitNameRef.current}" has changes that aren't saved. Clearing can be undone, but save first if you want to keep them in the file.`, clearBoard, 'Clear anyway');
  }, [clearBoard]);

  const handleNewCircuit = useCallback(() => {
    guardUnsavedRef.current('Start a new circuit?', `"${circuitNameRef.current}" has changes that aren't saved.`, newCircuit, "Don't save");
  }, [newCircuit]);

  /** Set from below once save is defined. */
  const guardUnsavedRef = useRef<(title: string, message: string, action: () => void, actionLabel?: string) => void>((_t, _m, a) => a());

  // ---- AI Circuit Tool Executor ---- //
  //
  // Refs that always hold the latest state so the synchronous executor
  // reads current values without needing to be re-created on every render.
  const componentsRef = useRef(components);
  componentsRef.current = components;
  // wiresRef is already declared above for the simulation loop.

  const handleExecuteToolCalls = useCallback(
    (
      toolCalls: { id: string; name: string; input: Record<string, unknown> }[],
      budget?: RequestBudget,
    ) => {
      type ToolResult = { success: boolean; message: string; data?: Record<string, unknown> };
      const results: { id: string; result: ToolResult }[] = [];
      const requestBudget = budget ?? new RequestBudget('');
      const grid = { GRID_W, GRID_H, BOARD_X_OFFSET };

      // The whole batch is ONE undo step. The state before the batch is
      // pushed before the first change, so Undo always gets back to it (even
      // when that state was never pushed, e.g. a restored autosave); the
      // result is pushed once at the end.
      const before = { components: componentsRef.current, wires: wiresRef.current };
      let changed = false;
      const willChange = () => {
        if (!changed) history.push(before.components, before.wires);
        changed = true;
      };

      toolCalls.forEach((tc, index) => {
        if (index >= LIMITS.toolCallsPerBatch) {
          results.push({
            id: tc.id,
            result: { success: false, message: `Skipped: at most ${LIMITS.toolCallsPerBatch} tool calls are handled per message. Send the rest in the next step.` },
          });
          return;
        }
        const capError = requestBudget.take(tc.name);
        if (capError) {
          results.push({ id: tc.id, result: { success: false, message: capError } });
          return;
        }
        try {
          results.push({ id: tc.id, result: executeSingleTool(tc.name, tc.input) });
        } catch (err) {
          results.push({
            id: tc.id,
            result: { success: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` },
          });
        }
      });

      if (changed) history.push(componentsRef.current, wiresRef.current);
      return results;

      function executeSingleTool(name: string, input: Record<string, unknown>): ToolResult {
        switch (name) {
          case 'add_component': {
            const capacity = checkBoardCapacity(componentsRef.current, wiresRef.current, 'component');
            if (capacity) return { success: false, message: capacity };
            const v = validateAddComponent(input, COMPONENT_DEFINITIONS);
            if (!v.ok) return { success: false, message: v.error };
            const { type, col, row, properties } = v.value;
            const def = COMPONENT_DEFINITIONS[type];

            // Defaults, then the validated values on top
            const defaults: Record<string, number | string> = {};
            for (const [key, prop] of Object.entries(def.properties ?? {})) defaults[key] = prop.default;

            const comp: PlacedComponent = {
              id: genId(),
              type,
              position: positionForGrid(def, col, row, grid),
              rotation: 0,
              properties: { ...defaults, ...properties },
              state: {},
            };
            if (componentsRef.current.some((c) => componentsOverlap(comp, c))) {
              return { success: false, message: `Position (${col}, ${row}) would overlap an existing component. Try a different location.` };
            }
            willChange();
            const next = [...componentsRef.current, comp];
            setComponents(next);
            componentsRef.current = next;
            return {
              success: true,
              message: `Added ${def.label} at (${col}, ${row})${col !== input.col ? ` (moved to col ${col} to straddle the gap)` : ''}.`,
              data: { componentId: comp.id, pins: def.pins.map((p) => p.id) },
            };
          }

          case 'add_wire': {
            const capacity = checkBoardCapacity(componentsRef.current, wiresRef.current, 'wire');
            if (capacity) return { success: false, message: capacity };
            const v = validateAddWire(input, componentsRef.current, COMPONENT_DEFINITIONS);
            if (!v.ok) return { success: false, message: v.error };
            const { from, to } = v.value;
            const wire: Wire = {
              id: genWireId(),
              from,
              to,
              waypoints: [],
              color: v.value.color ?? WIRE_COLORS[wireColorIdx++ % WIRE_COLORS.length],
            };
            willChange();
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
            const v = validateId(input, 'componentId');
            if (!v.ok) return { success: false, message: v.error };
            const componentId = v.value;
            const comp = componentsRef.current.find((c) => c.id === componentId);
            if (!comp) return { success: false, message: `Component "${componentId}" not found.` };
            willChange();
            const nextComps = componentsRef.current.filter((c) => c.id !== componentId);
            const nextWires = wiresRef.current.filter(
              (w) => w.from.componentId !== componentId && w.to.componentId !== componentId,
            );
            setComponents(nextComps);
            setWires(nextWires);
            componentsRef.current = nextComps;
            wiresRef.current = nextWires;
            setSelectedComponentIds((ids) => ids.filter((id) => id !== componentId));
            return { success: true, message: `Removed ${comp.type} (${componentId}) and its wires.` };
          }

          case 'remove_wire': {
            const v = validateId(input, 'wireId');
            if (!v.ok) return { success: false, message: v.error };
            const wireId = v.value;
            if (!wiresRef.current.some((w) => w.id === wireId)) return { success: false, message: `Wire "${wireId}" not found.` };
            willChange();
            const nextWires = wiresRef.current.filter((w) => w.id !== wireId);
            setWires(nextWires);
            wiresRef.current = nextWires;
            return { success: true, message: `Removed wire ${wireId}.` };
          }

          case 'clear_circuit': {
            const v = validateClearCircuit(input, componentsRef.current.length, wiresRef.current.length, requestBudget.userText);
            if (!v.ok) return { success: false, message: v.error };
            const removed = componentsRef.current.length;
            if (removed === 0 && wiresRef.current.length === 0) return { success: true, message: 'The board was already empty.' };
            willChange();
            setComponents([]);
            setWires([]);
            componentsRef.current = [];
            wiresRef.current = [];
            setSelectedComponentIds([]);
            setWiringFrom(null);
            return { success: true, message: `Cleared ${removed} components and their wires. The user can undo this with Ctrl+Z.` };
          }

          case 'list_components': {
            const list = componentsRef.current.map((c) => ({
              id: c.id,
              type: c.type,
              ...gridOf(c, COMPONENT_DEFINITIONS[c.type], grid),
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
              data: { components: list, wires: wireList },
            };
          }

          case 'list_component_types': {
            const v = validateListComponentTypes(input);
            if (!v.ok) return { success: false, message: v.error };
            if (!v.value) {
              const types = Object.values(COMPONENT_DEFINITIONS)
                .map((d) => ({ type: d.type, label: d.label, builtin: BUILTIN_TYPE_IDS.has(d.type) }))
                .sort((a, b) => a.type.localeCompare(b.type));
              return { success: true, message: `${types.length} component types.`, data: { types } };
            }
            const found = v.value.filter((t) => COMPONENT_DEFINITIONS[t]);
            const missing = v.value.filter((t) => !COMPONENT_DEFINITIONS[t]);
            return {
              success: found.length > 0,
              message: missing.length ? `Unknown types: ${missing.join(', ')}.` : `${found.length} types described.`,
              data: { types: found.map((t) => describeComponentType(COMPONENT_DEFINITIONS[t], BUILTIN_TYPE_IDS.has(t))) },
            };
          }

          case 'create_component_type': {
            const v = validateCreateComponentType(input);
            if (!v.ok) return { success: false, message: v.error };
            const spec = v.value;
            const existing = COMPONENT_DEFINITIONS[spec.type];
            if (existing) {
              return {
                success: true,
                message: `Component type "${spec.type}" already exists (${existing.label}${BUILTIN_TYPE_IDS.has(spec.type) ? ', built-in' : ''}). Use it directly with add_component.`,
                data: { type: spec.type, pins: existing.pins.map((p) => p.id) },
              };
            }

            const pinsPerSide = Math.ceil(spec.pins.length / 2);
            const chipJson: ChipDefinitionJSON = {
              type: spec.type,
              label: spec.label,
              description: spec.description,
              icon: spec.label.slice(0, 2).toUpperCase(),
              chipLabel: spec.label,
              category: spec.category,
              behavior: 'passthrough',
              color: spec.color,
              width: 2,
              height: pinsPerSide,
              pins: spec.pins.map((p, i) => {
                const sameSide = spec.pins.filter((pp) => pp.side === p.side);
                const sideIdx = sameSide.indexOf(p);
                const totalOnSide = sameSide.length;
                return {
                  id: p.id,
                  label: p.label,
                  side: p.side,
                  offset: totalOnSide === 1 ? 0.5 : (2 * (totalOnSide - 1 - sideIdx) + 1) / (2 * totalOnSide),
                  type: p.type,
                  number: i + 1,
                };
              }),
              properties: spec.properties,
            };

            COMPONENT_DEFINITIONS[spec.type] = chipJSONToDefinition(chipJson);
            setCatalogVersion((n) => n + 1);

            // Persist so the component survives restarts
            if (window.electronApi?.saveChip) {
              window.electronApi.saveChip(chipJson).catch((err) => console.error('Could not save the chip:', err));
            }

            return {
              success: true,
              message: `Created component type "${spec.type}" (${spec.label}) with ${spec.pins.length} pins. Place it with add_component (col 6 or 22).`,
              data: { type: spec.type, pins: spec.pins.map((p) => p.id) },
            };
          }

          case 'delete_component_type': {
            const v = validateDeleteComponentType(input, COMPONENT_DEFINITIONS, BUILTIN_TYPE_IDS);
            if (!v.ok) return { success: false, message: v.error };
            const typeId = v.value;
            const instanceIds = componentsRef.current.filter((c) => c.type === typeId).map((c) => c.id);
            if (instanceIds.length > 0) {
              willChange();
              const nextComps = componentsRef.current.filter((c) => c.type !== typeId);
              const nextWires = wiresRef.current.filter(
                (w) => !instanceIds.includes(w.from.componentId) && !instanceIds.includes(w.to.componentId),
              );
              setComponents(nextComps);
              setWires(nextWires);
              componentsRef.current = nextComps;
              wiresRef.current = nextWires;
            }

            delete COMPONENT_DEFINITIONS[typeId];
            setCatalogVersion((n) => n + 1);
            if (window.electronApi?.deleteChip) {
              window.electronApi.deleteChip(typeId).catch((err) => console.error('Could not delete the chip file:', err));
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

  /** A problem the user must read (bad file, failed open): an in-app message with an OK button. */
  const showProblem = useCallback((title: string, message: string) => {
    const close = () => setConfirm(null);
    setConfirm({ title, message, onCancel: close, buttons: [{ label: 'OK', kind: 'primary', onClick: close }] });
  }, []);

  // ---- Save ---- //

  /**
   * Save writes to the current file; Save As (or a circuit that was never
   * saved) asks for a name. Resolves true when the circuit is on disk.
   */
  const handleSave = useCallback(async (saveAs = false): Promise<boolean> => {
    const data = serializeCircuit(componentsRef.current, wiresRef.current);
    const api = shellApi();
    if (api) {
      try {
        const path = currentFilePathRef.current;
        const result = saveAs && api.saveCircuitAs
          ? await api.saveCircuitAs(data, path)
          : await api.saveCircuit(data, path);
        if (!result) return false; // cancelled
        setCircuitName(result.name);
        setCurrentFilePath(result.filePath);
        history.markSaved();
        showToast(`Saved "${result.name}.ecx"`);
        return true;
      } catch (err) {
        showToast(`Couldn't save the circuit: ${errorMessage(err)}`, 'error');
        return false;
      }
    }
    // Browser fallback: download
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${circuitNameRef.current}.ecx`;
    a.click();
    URL.revokeObjectURL(url);
    history.markSaved();
    showToast('Downloaded');
    return true;
  }, [history, showToast]);

  /** Before replacing the circuit: if it has unsaved changes, ask (Save first / go ahead / Cancel). */
  const guardUnsaved = useCallback((title: string, message: string, action: () => void, actionLabel = "Don't save") => {
    const hasContent = componentsRef.current.length > 0 || wiresRef.current.length > 0;
    if (!history.isDirty() || !hasContent) { action(); return; }
    const close = () => setConfirm(null);
    setConfirm({
      title,
      message,
      onCancel: close,
      buttons: [
        { label: 'Save first', kind: 'primary', onClick: async () => { close(); if (await handleSave()) action(); } },
        { label: actionLabel, onClick: () => { close(); action(); } },
        { label: 'Cancel', onClick: close },
      ],
    });
  }, [history, handleSave]);
  guardUnsavedRef.current = guardUnsaved;

  // ---- Open ---- //

  const openCircuitText = useCallback((text: string, name: string, filePath?: string) => {
    const result = parseCircuitText(text, isKnownType);
    if (!result.ok) {
      showProblem("Can't open this file", `This file isn't a valid circuit: ${result.error}`);
      return;
    }
    applyCircuit(result.circuit, { name, filePath, fresh: true });
    showToast(result.droppedWires > 0
      ? `Opened "${name}" (${result.droppedWires} wire(s) to missing parts were left out)`
      : `Opened "${name}"`);
  }, [applyCircuit, showProblem, showToast]);

  const openCircuit = useCallback(async () => {
    const api = shellApi();
    if (api) {
      try {
        const result = await api.loadCircuit();
        if (result) openCircuitText(result.data, result.name, result.filePath);
      } catch (err) {
        showProblem("Couldn't open the file", errorMessage(err));
      }
      return;
    }
    // Browser fallback: file picker
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ecx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      openCircuitText(await file.text(), file.name.replace(/\.ecx$/, ''));
    };
    input.click();
  }, [openCircuitText, showProblem]);

  const handleLoad = useCallback(() => {
    guardUnsaved('Open another circuit?', `"${circuitNameRef.current}" has changes that aren't saved.`, () => { void openCircuit(); });
  }, [guardUnsaved, openCircuit]);

  // ---- Undo / redo / clipboard ---- //

  const applySnapshot = useCallback((snap: { components: PlacedComponent[]; wires: Wire[] } | null) => {
    if (!snap) return;
    componentsRef.current = snap.components;
    wiresRef.current = snap.wires;
    setComponents(snap.components);
    setWires(snap.wires);
    setSelectedComponentIds([]);
    setSelectedWireId(null);
    setWiringFrom(null);
  }, []);
  const doUndo = useCallback(() => applySnapshot(history.undo()), [applySnapshot, history]);
  const doRedo = useCallback(() => applySnapshot(history.redo()), [applySnapshot, history]);

  const doCopy = useCallback(() => {
    const comp = componentsRef.current.find((c) => c.id === selectedComponentIds[0]);
    if (comp) clipboard.current = { ...comp, properties: { ...comp.properties } };
  }, [selectedComponentIds]);

  const doPaste = useCallback(() => {
    const src = clipboard.current;
    if (!src || !COMPONENT_DEFINITIONS[src.type]) return;
    // Offset paste by 1 grid unit right and down
    const newComp: PlacedComponent = {
      id: genId(), type: src.type,
      position: { x: src.position.x + GRID_W, y: src.position.y + GRID_H },
      rotation: src.rotation, properties: { ...src.properties }, state: {},
    };
    if (componentsRef.current.some((c) => componentsOverlap(newComp, c))) {
      showToast('No room to paste next to the copied part.');
      return;
    }
    commitCircuit([...componentsRef.current, newComp], wiresRef.current);
    setSelectedComponentIds([newComp.id]);
    // Update clipboard to point to new component for repeated paste
    clipboard.current = newComp;
  }, [commitCircuit, showToast]);

  // ---- Examples ---- //

  const loadDemo = useCallback((demoName?: string) => {
    const demoMap: Record<string, { name: string; create: () => { components: PlacedComponent[]; wires: Wire[] }; hex?: string }> = {
      blink:      { name: 'LED Blink Demo',     create: createBlinkDemoCircuit },
      counter:    { name: '7-Seg Counter Demo',  create: createCounterDemoCircuit },
      'avr-blink': { name: 'AVR Blink Demo',    create: createAVRBlinkDemoCircuit, hex: AVR_BLINK_HEX },
      matrix:     { name: '5x7 Matrix Demo',    create: createMatrixDemoCircuit, hex: AVR_MATRIX_HEX },
      necklace:   { name: 'Necklace Demo',      create: createNecklaceDemoCircuit, hex: AVR_NECKLACE_HEX },
    };
    const entry = demoMap[demoName ?? 'blink'] ?? demoMap.blink;

    // Demos are generated from code. Their firmware goes into the
    // ATmega's properties.hex so Save and autosave keep it.
    const circuit = entry.create();
    const components = entry.hex
      ? circuit.components.map((c) => (c.type === 'atmega328' && !c.properties.hex ? { ...c, properties: { ...c.properties, hex: entry.hex! } } : c))
      : circuit.components;
    // Not a file: no current path, so Save asks where to put a copy, and
    // circuits/<Demo>.ecx is never overwritten. Undo brings back what was there.
    applyCircuit({ components, wires: circuit.wires }, { name: entry.name, fresh: false });
    showToast(`Loaded the example "${entry.name}". Press Run to start it.`);
  }, [applyCircuit, showToast]);

  const handleLoadDemo = useCallback((demoName?: string) => {
    guardUnsaved('Load an example?', `"${circuitNameRef.current}" has changes that aren't saved. Loading an example can be undone.`, () => loadDemo(demoName), 'Load anyway');
  }, [guardUnsaved, loadDemo]);

  /** Any dialog open (ours or one that draws its own overlay). */
  const anyModalOpen = () => showUsage || !!document.querySelector('.modal-overlay');

  // Update menu action handler now that save/load are defined
  useEffect(() => {
    menuActionRef.current = (action: string) => {
      // Menu items act on the board; not while a dialog is open.
      if (anyModalOpen() && action !== 'about' && action !== 'settings') return;
      switch (action) {
        case 'about': setShowAbout(true); break;
        case 'settings': setShowSettings(true); break;
        case 'save': void handleSave(); break;
        case 'save-as': void handleSave(true); break;
        case 'open': handleLoad(); break;
        case 'new': handleNewCircuit(); break;
        case 'undo': doUndo(); break;
        case 'redo': doRedo(); break;
        case 'copy': doCopy(); break;
        case 'paste': doPaste(); break;
      }
    };
  });

  // Keyboard shortcuts. All of them are off while a dialog is open or a
  // text field / select has focus (the field keeps its own Ctrl+Z etc.).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (shortcutsBlocked(e, anyModalOpen())) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === 's') { e.preventDefault(); void handleSave(e.shiftKey); return; }
      if (ctrl && key === 'o') { e.preventDefault(); handleLoad(); return; }
      if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      // Redo (Ctrl+Shift+Z or Ctrl+Y)
      if ((ctrl && e.shiftKey && key === 'z') || (ctrl && key === 'y')) { e.preventDefault(); doRedo(); return; }
      if (ctrl && key === 'c') { doCopy(); return; }
      if (ctrl && key === 'v') { e.preventDefault(); doPaste(); return; }
      if (ctrl) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (selectedComponentIds.length > 0) handleDeleteComponents(selectedComponentIds);
        if (selectedWireId) handleDeleteWire(selectedWireId);
        return;
      }
      if (e.key === 'Escape') {
        setWiringFrom(null);
        setSelectedComponentIds([]);
        setSelectedWireId(null);
        setContextMenu(null);
        return;
      }
      if (key === 'r' && !e.altKey) {
        if (selectedComponentIds.length > 0) rotateComponents(selectedComponentIds, 90);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleSave, handleLoad, doUndo, doRedo, doCopy, doPaste, selectedComponentIds, selectedWireId, handleDeleteComponents, handleDeleteWire, rotateComponents, showUsage]);

  // Closing the window with unsaved changes asks first (shell contract).
  const closeRequestRef = useRef<() => void>(() => {});
  closeRequestRef.current = () => {
    const api = shellApi();
    const hasContent = componentsRef.current.length > 0 || wiresRef.current.length > 0;
    if (!history.isDirty() || !hasContent) { api?.confirmClose?.(); return; }
    const close = () => setConfirm(null);
    setConfirm({
      title: 'Save changes before closing?',
      message: `"${circuitNameRef.current}" has changes that aren't saved.`,
      onCancel: close,
      buttons: [
        { label: 'Save', kind: 'primary', onClick: async () => { close(); if (await handleSave()) api?.confirmClose?.(); } },
        { label: "Don't save", kind: 'danger', onClick: () => { close(); api?.confirmClose?.(); } },
        { label: 'Cancel', onClick: close },
      ],
    });
  };
  useEffect(() => {
    const off = shellApi()?.onCloseRequest?.(() => closeRequestRef.current());
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const selectedComponent = components.find((c) => c.id === selectedComponentIds[0]) ?? null;
  const selectedWire = wires.find((w) => w.id === selectedWireId) ?? null;

  const handleWireColorChange = useCallback((wireId: string, color: string) => {
    commitCircuit(componentsRef.current, wiresRef.current.map((w) => w.id === wireId ? { ...w, color } : w));
  }, [commitCircuit]);

  const download = useCallback((text: string, type: string, fileName: string, what: string) => {
    try {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${what}`);
    } catch (err) {
      showToast(`Couldn't export the ${what}: ${errorMessage(err)}`, 'error');
    }
  }, [showToast]);

  const handleExportNetlist = useCallback(() => {
    try {
      download(generateKiCadNetlist(components, wires), 'text/plain', `${circuitName}.net`, 'netlist');
    } catch (err) {
      showToast(`Couldn't build the netlist: ${errorMessage(err)}`, 'error');
    }
  }, [components, wires, circuitName, download, showToast]);

  const handleExportBOM = useCallback(() => {
    try {
      download(generateBOM(components), 'text/csv', `${circuitName}-bom.csv`, 'bill of materials');
    } catch (err) {
      showToast(`Couldn't build the bill of materials: ${errorMessage(err)}`, 'error');
    }
  }, [components, circuitName, download, showToast]);

  /** Put a program on an ATmega: stored in properties.hex (saved with the circuit) and loaded now. */
  const installHex = useCallback((componentId: string, hex: string, extra: Record<string, string> = {}): boolean => {
    try {
      loadFirmware(simulator.current, componentId, hex);
    } catch (err) {
      showProblem("Couldn't load the program", `This isn't a valid Intel HEX file: ${errorMessage(err)}`);
      return false;
    }
    setPartProperties(componentId, { hex, ...extra });
    return true;
  }, [setPartProperties, showProblem]);

  const handleLoadHex = useCallback(async (componentId: string) => {
    if (window.electronApi?.loadHex) {
      try {
        const result = await window.electronApi.loadHex();
        if (result && installHex(componentId, result.data)) showToast(`Loaded "${result.name}"`);
      } catch (err) {
        showProblem("Couldn't open the hex file", errorMessage(err));
      }
      return;
    }
    // Browser fallback: file picker
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.hex';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (installHex(componentId, await file.text())) showToast(`Loaded "${file.name}"`);
    };
    input.click();
  }, [installHex, showProblem, showToast]);

  const sketchTarget = sketchTargetId ? components.find((c) => c.id === sketchTargetId) ?? null : null;

  const scopeTraces = scope.getTraces(components);

  return (
    <div className="app-shell">
      <Sidebar onClick={handleClickPlace} onDeleteType={handleDeleteComponentType} catalogVersion={catalogVersion} />
      <div className="main-area">
        {dataProblem && (
          <div className="data-notice" role="alert">
            <strong>Data folder problem:</strong> <span>{dataProblem}</span>
            <button type="button" className="data-notice-close" aria-label="Hide this notice" onClick={() => setDataProblem(null)}>×</button>
          </div>
        )}
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
          onNew={handleNewCircuit}
          onOpen={handleLoad}
          onSave={() => { void handleSave(); }}
          onSaveAs={() => { void handleSave(true); }}
          onUndo={doUndo}
          onRedo={doRedo}
          canUndo={history.canUndo()}
          canRedo={history.canRedo()}
          circuitName={circuitName}
          dirty={dirty}
          simTime={simTime}
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
            fitRequest={fitRequest}
            onContextMenu={(e, compId, wireId) => {
              setContextMenu({ x: e.clientX, y: e.clientY, componentId: compId, wireId });
            }}
          />
          <ProblemsPanel components={components} onSelect={(id) => handleSelectComponent(id)} />
          {wiringFrom && (
            <div className="wiring-hint">Click a pin or hole to finish the wire, or press Escape to cancel</div>
          )}
          {components.length === 0 && restoreDone && (
            <div className="empty-state">
              <p>Click a part in the list on the left to put it on the board, or drag it to a spot.</p>
              <p>Or open a ready-made circuit from <strong>Examples ▾</strong> in the toolbar.</p>
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
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the side panel"
        />
        <PropertiesPanel
          component={selectedComponent}
          onPropertyChange={handlePropertyChange}
          onPropertyPreview={handlePropertyPreview}
          onRotate={(id) => rotateComponents([id], 90)}
          onFlipPolarity={(id) => rotateComponents([id], 180)}
          selectedWire={selectedWire}
          onWireColorChange={handleWireColorChange}
          onProbe={selectedComponent ? () => {
            scope.addProbe(selectedComponent.id);
            setScopeVisible(true);
          } : undefined}
          isProbed={selectedComponent ? scope.probedIds.has(selectedComponent.id) : false}
          onLoadHex={selectedComponent?.type === 'atmega328' ? () => handleLoadHex(selectedComponent.id) : undefined}
          isHexLoaded={selectedComponent?.type === 'atmega328'
            ? simulator.current.isAVRLoaded(selectedComponent.id) || !!selectedComponent.properties.hex
            : false}
          onWriteSketch={selectedComponent?.type === 'atmega328' ? () => setSketchTargetId(selectedComponent.id) : undefined}
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
      {showUsage && (
        <ModalLayer onClose={() => setShowUsage(false)}>
          <UsagePanel onClose={() => setShowUsage(false)} />
        </ModalLayer>
      )}
      {showPCBView && <PCBView components={components} wires={wires} onClose={() => setShowPCBView(false)} />}
      {sketchTargetId && (
        <SketchEditor
          initialSketch={typeof sketchTarget?.properties.sketch === 'string' ? sketchTarget.properties.sketch : undefined}
          onCompiled={(hex, sketch) => {
            if (installHex(sketchTargetId, hex, { sketch })) showToast('Sketch compiled and loaded');
          }}
          onClose={(sketch) => {
            const target = componentsRef.current.find((c) => c.id === sketchTargetId);
            const saved = typeof target?.properties.sketch === 'string' ? target.properties.sketch : '';
            // Keep edits: the sketch belongs to the part (saved with the circuit).
            if (target && sketch !== saved && sketch.trim()) setPartProperties(target.id, { sketch });
            setSketchTargetId(null);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog title={confirm.title} message={confirm.message} buttons={confirm.buttons} onCancel={confirm.onCancel} />
      )}
      {contextMenu && (() => {
        const items: { label: string; shortcut?: string; onClick: () => void; danger?: boolean }[] = [];
        if (contextMenu.componentId) {
          const compId = contextMenu.componentId;
          const comp = components.find((c) => c.id === compId);
          if (comp && comp.type !== 'power') {
            items.push({ label: 'Rotate', shortcut: 'R', onClick: () => rotateComponents([compId], 90) });
          }
          if (comp?.type === 'led') {
            items.push({ label: 'Flip polarity', onClick: () => rotateComponents([compId], 180) });
          }
          items.push({ label: 'Copy', shortcut: 'Ctrl+C', onClick: () => {
            if (comp) clipboard.current = { ...comp, properties: { ...comp.properties } };
          }});
          items.push({ label: 'Delete', shortcut: 'Del', danger: true, onClick: () => handleDeleteComponent(compId) });
        } else if (contextMenu.wireId) {
          const wireId = contextMenu.wireId;
          items.push({ label: 'Delete Wire', shortcut: 'Del', danger: true, onClick: () => handleDeleteWire(wireId) });
        }
        if (items.length === 0) return null;
        return <ContextMenu x={contextMenu.x} y={contextMenu.y} items={items} onClose={() => setContextMenu(null)} />;
      })()}
      <ToastList toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}

export default App;
