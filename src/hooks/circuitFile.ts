import { PlacedComponent, Wire } from '../types';

/**
 * Reading and writing circuits (.ecx files and the autosave).
 *
 * Everything that comes from disk goes through validateCircuit() before any
 * React state is touched, so a malformed file shows a message instead of a
 * white window (D6).
 */

export interface CircuitData {
  components: PlacedComponent[];
  wires: Wire[];
}

/** What the autosave keeps on top of the circuit itself. */
export interface AutosaveData extends CircuitData {
  circuitName?: string;
  currentFilePath?: string;
  /** The circuit had unsaved changes when it was autosaved. */
  dirty?: boolean;
}

export type ValidationResult =
  | { ok: true; circuit: AutosaveData; droppedWires: number }
  | { ok: false; error: string };

const ROTATIONS = new Set([0, 90, 180, 270]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Check the shape of parsed JSON and return a clean copy.
 * `knownTypes` is the component catalog: a part of an unknown type is an
 * error (its chip definition is missing), not something to drop silently.
 * Wires whose ends point at parts that don't exist are dropped and counted.
 */
export function validateCircuit(data: unknown, knownTypes: (type: string) => boolean): ValidationResult {
  const fail = (error: string): ValidationResult => ({ ok: false, error });
  if (!isObj(data)) return fail('the file does not contain a circuit object.');
  if (!Array.isArray(data.components)) return fail('"components" is missing or is not a list.');
  if (data.wires !== undefined && !Array.isArray(data.wires)) return fail('"wires" is not a list.');

  const components: PlacedComponent[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < data.components.length; i++) {
    const c = data.components[i];
    const where = `part ${i + 1}`;
    if (!isObj(c)) return fail(`${where} is not an object.`);
    if (typeof c.id !== 'string' || !c.id) return fail(`${where} has no id.`);
    if (ids.has(c.id)) return fail(`two parts share the id "${c.id}".`);
    ids.add(c.id);
    if (typeof c.type !== 'string' || !c.type) return fail(`part "${c.id}" has no type.`);
    if (!knownTypes(c.type)) return fail(`part "${c.id}" is of an unknown type "${c.type}" (is its chip definition installed?).`);
    if (!isObj(c.position) || !isFiniteNum(c.position.x) || !isFiniteNum(c.position.y)) {
      return fail(`part "${c.id}" has no valid position.`);
    }
    const rotation = c.rotation === undefined ? 0 : c.rotation;
    if (!isFiniteNum(rotation) || !ROTATIONS.has(rotation)) return fail(`part "${c.id}" has an invalid rotation.`);
    if (c.properties !== undefined && !isObj(c.properties)) return fail(`part "${c.id}" has invalid properties.`);
    const properties: Record<string, number | string> = {};
    for (const [k, v] of Object.entries((c.properties as Record<string, unknown>) ?? {})) {
      if (typeof v === 'number' || typeof v === 'string') properties[k] = v;
      else return fail(`property "${k}" of part "${c.id}" is not a number or text.`);
    }
    const state = isObj(c.state) ? (c.state as PlacedComponent['state']) : {};
    components.push({
      id: c.id,
      type: c.type,
      position: { x: c.position.x, y: c.position.y },
      rotation,
      properties,
      state: { ...state },
    });
  }

  const wires: Wire[] = [];
  const wireIds = new Set<string>();
  let droppedWires = 0;
  const rawWires = (data.wires as unknown[] | undefined) ?? [];
  for (let i = 0; i < rawWires.length; i++) {
    const w = rawWires[i];
    const where = `wire ${i + 1}`;
    if (!isObj(w)) return fail(`${where} is not an object.`);
    if (typeof w.id !== 'string' || !w.id) return fail(`${where} has no id.`);
    if (wireIds.has(w.id)) return fail(`two wires share the id "${w.id}".`);
    wireIds.add(w.id);
    const ends: Wire['from'][] = [];
    for (const end of [w.from, w.to]) {
      if (!isObj(end) || typeof end.componentId !== 'string' || typeof end.pinId !== 'string') {
        return fail(`wire "${w.id}" has an invalid end.`);
      }
      ends.push({ componentId: end.componentId, pinId: end.pinId });
    }
    if (ends.some((e) => e.componentId !== 'board' && !ids.has(e.componentId))) {
      droppedWires++;
      continue;
    }
    const waypoints = Array.isArray(w.waypoints)
      ? w.waypoints.filter((p): p is { x: number; y: number } => isObj(p) && isFiniteNum(p.x) && isFiniteNum(p.y))
      : [];
    wires.push({
      id: w.id,
      from: ends[0],
      to: ends[1],
      waypoints: waypoints.map((p) => ({ x: p.x, y: p.y })),
      color: typeof w.color === 'string' ? w.color : '#60a5fa',
    });
  }

  const circuit: AutosaveData = { components, wires };
  if (typeof data.circuitName === 'string' && data.circuitName) circuit.circuitName = data.circuitName;
  if (typeof data.currentFilePath === 'string' && data.currentFilePath) circuit.currentFilePath = data.currentFilePath;
  if (typeof data.dirty === 'boolean') circuit.dirty = data.dirty;
  return { ok: true, circuit, droppedWires };
}

/** Parse text, then validate. JSON errors become a readable message. */
export function parseCircuitText(text: string, knownTypes: (type: string) => boolean): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `it is not valid JSON (${e instanceof Error ? e.message : String(e)}).` };
  }
  return validateCircuit(parsed, knownTypes);
}

/**
 * Runtime state that belongs in a file: only a switch's position. Everything
 * else in `state` is recomputed by the simulator on every tick.
 */
function persistentState(c: PlacedComponent): PlacedComponent['state'] {
  if (c.type === 'switch' && c.state?.closed) return { closed: c.state.closed };
  return {};
}

/** The circuit as stored on disk: runtime readings left out. */
export function circuitForDisk(components: PlacedComponent[], wires: Wire[]): CircuitData {
  return {
    components: components.map((c) => ({ ...c, state: persistentState(c) })),
    wires,
  };
}

export function serializeCircuit(components: PlacedComponent[], wires: Wire[]): string {
  return JSON.stringify({ version: 1, ...circuitForDisk(components, wires) }, null, 2);
}

export function serializeAutosave(data: AutosaveData): string {
  return JSON.stringify({
    version: 1,
    ...circuitForDisk(data.components, data.wires),
    circuitName: data.circuitName,
    currentFilePath: data.currentFilePath,
    dirty: data.dirty,
  });
}

/** Highest numeric suffix among ids such as "comp_12", so new ids don't collide. */
export function maxIdNumber(items: { id: string }[]): number {
  return items.reduce((max, item) => {
    const num = parseInt(item.id.replace(/\D/g, ''), 10);
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);
}

/** Turn whatever a rejected promise carried into a sentence for the user. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Electron wraps errors from ipcMain handlers: "Error invoking remote
    // method 'save-circuit': Error: The disk is full." Keep the sentence.
    const m = err.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
    return m || 'Unknown error.';
  }
  return String(err);
}
