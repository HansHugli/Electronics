import type { ComponentDefinition, PlacedComponent, Wire } from '../types';

/**
 * Validation for every tool call the AI makes, before anything changes on
 * the board. Pure functions: no React, no window, no globals, so it is unit
 * tested directly. Each validator returns either the cleaned value or a
 * sentence the model can act on.
 */

// ---- Board geometry (grid units) ---- //

export const BOARD_MIN_COL = 0;
export const BOARD_MAX_COL = 30;
export const BOARD_MIN_ROW = 0;
export const BOARD_MAX_ROW = 49;
/** Columns without holes: each board's centre gap and the space between boards. */
export const NO_HOLE_COLS = new Set([7, 15, 23]);
/** Off-board column for power supplies. */
export const SUPPLY_COL = -4;
/** DIP chips straddle the gap: left pins on these columns. */
export const DIP_COLS = [6, 22];

// ---- Caps ---- //

export const LIMITS = {
  /** Tool calls handled from one assistant message. */
  toolCallsPerBatch: 40,
  /** Per user request (the whole tool loop). */
  perRequest: {
    add_component: 60,
    add_wire: 200,
    remove_component: 60,
    remove_wire: 200,
    create_component_type: 5,
    delete_component_type: 5,
    clear_circuit: 1,
  } as Record<string, number>,
  maxComponentsOnBoard: 300,
  maxWiresOnBoard: 1000,
  maxPins: 40,
  maxProperties: 12,
  maxStringLength: 200,
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });

export const TYPE_ID_RE = /^[a-z][a-z0-9_-]{0,40}$/;
const PIN_ID_RE = /^[A-Za-z0-9_+.-]{1,24}$/;
const PROP_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

function shortString(v: unknown, what: string, max = LIMITS.maxStringLength, required = true): Result<string | undefined> {
  if (v === undefined || v === null || v === '') return required ? fail(`${what} is required.`) : ok(undefined);
  if (typeof v !== 'string') return fail(`${what} must be a string.`);
  if (v.length > max) return fail(`${what} is too long (max ${max} characters).`);
  return ok(v);
}

// ---- Request budget ---- //

/** Counts tool calls over one user request so a runaway loop is stopped. */
export class RequestBudget {
  private counts = new Map<string, number>();
  constructor(readonly userText = '') {}

  /** Reserve one call of `tool`; returns an error sentence when the cap is reached. */
  take(tool: string): string | null {
    const cap = LIMITS.perRequest[tool];
    if (cap === undefined) return null;
    const n = (this.counts.get(tool) ?? 0) + 1;
    if (n > cap) return `Limit reached: at most ${cap} ${tool} calls per request. Stop and tell the user what is left to do.`;
    this.counts.set(tool, n);
    return null;
  }
}

// ---- Board holes ---- //

export function isBoardHole(col: number, row: number): boolean {
  return (
    isInt(col) && isInt(row) &&
    col >= BOARD_MIN_COL && col <= BOARD_MAX_COL &&
    row >= BOARD_MIN_ROW && row <= BOARD_MAX_ROW &&
    !NO_HOLE_COLS.has(col)
  );
}

/** Parse a board pin "col,row"; null unless it names a real hole. */
export function parseBoardPin(pinId: unknown): { col: number; row: number } | null {
  if (typeof pinId !== 'string') return null;
  const m = /^\s*(-?\d{1,3})\s*,\s*(-?\d{1,3})\s*$/.exec(pinId);
  if (!m) return null;
  const col = Number(m[1]);
  const row = Number(m[2]);
  return isBoardHole(col, row) ? { col, row } : null;
}

// ---- add_component ---- //

export interface AddComponentInput {
  type: string;
  col: number;
  row: number;
  properties: Record<string, number | string>;
}

const POSITIVE_KEYS = /^(resistance|capacitance|frequency|clockSpeed|gain|amplitude)$/;

export function validateProperties(
  raw: unknown,
  def: ComponentDefinition,
): Result<Record<string, number | string>> {
  if (raw === undefined || raw === null) return ok({});
  if (!isObject(raw)) return fail('properties must be an object of property values.');
  const allowed = def.properties ?? {};
  const out: Record<string, number | string> = {};
  const entries = Object.entries(raw);
  if (entries.length > LIMITS.maxProperties) return fail('Too many properties.');
  for (const [key, value] of entries) {
    const spec = allowed[key];
    if (!spec) {
      const names = Object.keys(allowed);
      return fail(
        `"${def.type}" has no property "${key}". ${names.length ? `Its properties are: ${names.join(', ')}.` : 'It has no editable properties.'}`,
      );
    }
    if (typeof spec.default === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail(`Property "${key}" must be a finite number${spec.unit ? ` in ${spec.unit}` : ''} (got ${JSON.stringify(value)}).`);
      }
      if (Math.abs(value) > 1e12) return fail(`Property "${key}" is out of range.`);
      if (POSITIVE_KEYS.test(key) && value <= 0) return fail(`Property "${key}" must be greater than zero.`);
      out[key] = value;
    } else {
      if (typeof value !== 'string' && typeof value !== 'number') return fail(`Property "${key}" must be a string.`);
      const s = String(value);
      if (s.length > 40) return fail(`Property "${key}" is too long.`);
      out[key] = s;
    }
  }
  return ok(out);
}

export function validateAddComponent(
  input: unknown,
  definitions: Record<string, ComponentDefinition>,
): Result<AddComponentInput> {
  if (!isObject(input)) return fail('add_component needs an object input.');
  const { type, col, row, properties } = input;
  if (typeof type !== 'string' || !type) return fail('type is required.');
  const def = definitions[type];
  if (!def) return fail(`Unknown component type "${type}". Call list_component_types for the valid types.`);
  if (!isInt(col) || !isInt(row)) {
    return fail(`col and row must be whole numbers (got col=${JSON.stringify(col)}, row=${JSON.stringify(row)}).`);
  }
  const height = Math.max(1, Math.ceil(def.height || 1));
  if (row < BOARD_MIN_ROW || row + height - 1 > BOARD_MAX_ROW) {
    return fail(`row ${row} puts ${def.label} (${height} rows tall) off the board; use a row from 0 to ${BOARD_MAX_ROW - height + 1}.`);
  }

  let finalCol = col;
  if (type === 'power') {
    if (col !== SUPPLY_COL) return fail(`Power supplies go off the board at col ${SUPPLY_COL}.`);
  } else if (def.width >= 2 && type !== 'multimeter') {
    // Mirrors the placement auto-correction: chips straddle a centre gap.
    if (col >= 2 && col <= 8) finalCol = DIP_COLS[0];
    else if (col >= 18 && col <= 24) finalCol = DIP_COLS[1];
    else return fail(`${def.label} is ${def.width} columns wide and must straddle a centre gap: use col 6 (board 1) or col 22 (board 2).`);
  } else {
    const width = Math.max(1, Math.ceil(def.width || 1));
    if (col < BOARD_MIN_COL || col + width - 1 > BOARD_MAX_COL) {
      return fail(`col ${col} is off the board; use a column from 0 to ${BOARD_MAX_COL - width + 1}.`);
    }
    if (width === 1 && NO_HOLE_COLS.has(col)) {
      return fail(`col ${col} is a gap with no holes; use cols 2-6 or 8-12 (board 1) or 18-22 / 24-28 (board 2).`);
    }
  }

  const props = validateProperties(properties, def);
  if (!props.ok) return props;
  return ok({ type, col: finalCol, row, properties: props.value });
}

// ---- add_wire ---- //

export interface Endpoint {
  componentId: string;
  pinId: string;
}

export function validateEndpoint(
  raw: unknown,
  which: 'from' | 'to',
  components: Pick<PlacedComponent, 'id' | 'type'>[],
  definitions: Record<string, ComponentDefinition>,
): Result<Endpoint> {
  if (!isObject(raw)) return fail(`${which} must be { componentId, pinId }.`);
  const { componentId, pinId } = raw;
  if (typeof componentId !== 'string' || typeof pinId !== 'string' || !componentId || !pinId) {
    return fail(`${which} needs a componentId and a pinId (strings).`);
  }
  if (componentId === 'board') {
    const hole = parseBoardPin(pinId);
    if (!hole) {
      return fail(
        `${which}: "${pinId}" is not a board hole. Use "col,row" with col 0-30 (not 7, 15 or 23) and row 0-49.`,
      );
    }
    return ok({ componentId: 'board', pinId: `${hole.col},${hole.row}` });
  }
  const comp = components.find((c) => c.id === componentId);
  if (!comp) return fail(`${which}: component "${componentId}" is not on the board. Call list_components to see the IDs.`);
  const def = definitions[comp.type];
  if (!def) return fail(`${which}: component "${componentId}" has an unknown type "${comp.type}".`);
  if (!def.pins.some((p) => p.id === pinId)) {
    return fail(`${which}: ${comp.type} (${comp.id}) has no pin "${pinId}". Its pins are: ${def.pins.map((p) => p.id).join(', ')}.`);
  }
  return ok({ componentId, pinId });
}

export function validateAddWire(
  input: unknown,
  components: Pick<PlacedComponent, 'id' | 'type'>[],
  definitions: Record<string, ComponentDefinition>,
): Result<{ from: Endpoint; to: Endpoint; color?: string }> {
  if (!isObject(input)) return fail('add_wire needs an object input.');
  const from = validateEndpoint(input.from, 'from', components, definitions);
  if (!from.ok) return from;
  const to = validateEndpoint(input.to, 'to', components, definitions);
  if (!to.ok) return to;
  if (from.value.componentId === to.value.componentId && from.value.pinId === to.value.pinId) {
    return fail('A wire needs two different ends.');
  }
  let color: string | undefined;
  if (input.color !== undefined && input.color !== null && input.color !== '') {
    if (typeof input.color !== 'string' || !COLOR_RE.test(input.color)) return fail('color must be a hex colour like "#e74c3c".');
    color = input.color;
  }
  return ok({ from: from.value, to: to.value, color });
}

/** A string ID field like componentId / wireId. */
export function validateId(input: unknown, key: string): Result<string> {
  if (!isObject(input)) return fail('The tool needs an object input.');
  const v = input[key];
  if (typeof v !== 'string' || !ENTITY_ID_RE.test(v)) return fail(`${key} must be an ID like "comp_1" or "wire_1".`);
  return ok(v);
}

// ---- clear_circuit ---- //

const START_OVER_RE =
  /\b(start(ing)?\s+(over|again|fresh|from\s+scratch)|from\s+scratch|clear\s+(the\s+|my\s+|this\s+)?(board|circuit|breadboard|everything|it|all)|wipe|erase\s+(the\s+|my\s+)?(board|circuit|everything)|empty\s+the\s+board|reset\s+the\s+(board|circuit)|remove\s+(everything|all\s+(the\s+)?(parts|components))|new\s+(circuit|board)|delete\s+everything|replace\s+(the|my|this)\s+(whole\s+)?(circuit|board))\b/i;
const AFFIRM_RE = /^\s*(yes|yep|yeah|sure|ok(ay)?|go\s+ahead|do\s+it|please\s+do|confirm(ed)?|clear\s+it|y)\b/i;

export function userAskedToStartOver(text: string): boolean {
  return START_OVER_RE.test(text);
}

export function isAffirmation(text: string): boolean {
  return AFFIRM_RE.test(text);
}

/**
 * Clearing a non-empty board needs the user's say-so: either their latest
 * message asks to start over, or the model asked and they said yes.
 */
export function validateClearCircuit(input: unknown, componentCount: number, wireCount: number, userText: string): Result<true> {
  if (componentCount === 0 && wireCount === 0) return ok(true);
  const confirmed = isObject(input) && input.confirmed_by_user === true;
  if (userAskedToStartOver(userText) || (confirmed && isAffirmation(userText))) return ok(true);
  return fail(
    `Not cleared: the board has ${componentCount} components and ${wireCount} wires, and the user has not asked to start over. ` +
      'Ask the user first ("Clear the current circuit and start over?"), or build beside the existing parts.',
  );
}

// ---- create / delete component types ---- //

export interface CreateTypeInput {
  type: string;
  label: string;
  description: string;
  category: ComponentDefinition['category'];
  color: string;
  pins: { id: string; label: string; side: 'left' | 'right'; type: 'power' | 'ground' | 'input' | 'output' | 'bidirectional' }[];
  properties?: Record<string, { label: string; default: number | string; unit?: string }>;
}

const CATEGORIES = ['passive', 'active', 'input', 'output', 'measurement', 'power'] as const;
const PIN_TYPES = ['power', 'ground', 'input', 'output', 'bidirectional'] as const;

export function validateCreateComponentType(input: unknown): Result<CreateTypeInput> {
  if (!isObject(input)) return fail('create_component_type needs an object input.');
  const type = input.type;
  if (typeof type !== 'string' || !TYPE_ID_RE.test(type)) {
    return fail('type must be lowercase letters, digits, "_" or "-", start with a letter, and be at most 41 characters (e.g. "relay_spdt").');
  }
  const label = shortString(input.label, 'label', 30);
  if (!label.ok) return label;
  const description = shortString(input.description, 'description', 200, false);
  if (!description.ok) return description;
  const category = input.category ?? 'active';
  if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category)) {
    return fail(`category must be one of ${CATEGORIES.join(', ')}.`);
  }
  let color = '#4a4a4a';
  if (input.color !== undefined && input.color !== null && input.color !== '') {
    if (typeof input.color !== 'string' || !COLOR_RE.test(input.color)) return fail('color must be a hex colour like "#4a4a4a".');
    color = input.color;
  }
  if (!Array.isArray(input.pins) || input.pins.length === 0) return fail('pins must be a non-empty array.');
  if (input.pins.length > LIMITS.maxPins) return fail(`At most ${LIMITS.maxPins} pins.`);
  const pins: CreateTypeInput['pins'] = [];
  const seen = new Set<string>();
  for (const [i, p] of input.pins.entries()) {
    if (!isObject(p)) return fail(`pins[${i}] must be an object.`);
    if (typeof p.id !== 'string' || !PIN_ID_RE.test(p.id)) return fail(`pins[${i}].id must be 1-24 letters, digits, "_", "-", "+" or ".".`);
    if (seen.has(p.id)) return fail(`Pin id "${p.id}" is used twice.`);
    seen.add(p.id);
    const plabel = shortString(p.label, `pins[${i}].label`, 12);
    if (!plabel.ok) return plabel;
    if (p.side !== 'left' && p.side !== 'right') return fail(`pins[${i}].side must be "left" or "right".`);
    if (typeof p.type !== 'string' || !(PIN_TYPES as readonly string[]).includes(p.type)) {
      return fail(`pins[${i}].type must be one of ${PIN_TYPES.join(', ')}.`);
    }
    pins.push({ id: p.id, label: plabel.value as string, side: p.side, type: p.type as CreateTypeInput['pins'][number]['type'] });
  }
  let properties: CreateTypeInput['properties'];
  if (input.properties !== undefined && input.properties !== null) {
    if (!isObject(input.properties)) return fail('properties must be an object.');
    const entries = Object.entries(input.properties);
    if (entries.length > LIMITS.maxProperties) return fail(`At most ${LIMITS.maxProperties} properties.`);
    properties = {};
    for (const [key, spec] of entries) {
      if (!PROP_KEY_RE.test(key)) return fail(`Property name "${key}" is not valid (letters, digits, "_").`);
      if (!isObject(spec)) return fail(`Property "${key}" must be { label, default, unit? }.`);
      const plabel = shortString(spec.label, `Property "${key}" label`, 30);
      if (!plabel.ok) return plabel;
      const d = spec.default;
      if (!(typeof d === 'number' && Number.isFinite(d)) && !(typeof d === 'string' && d.length <= 40)) {
        return fail(`Property "${key}" default must be a finite number or a short string.`);
      }
      const unit = shortString(spec.unit, `Property "${key}" unit`, 10, false);
      if (!unit.ok) return unit;
      properties[key] = { label: plabel.value as string, default: d, ...(unit.value ? { unit: unit.value } : {}) };
    }
  }
  return ok({
    type,
    label: label.value as string,
    description: (description.value as string | undefined) ?? `${label.value} component`,
    category: category as CreateTypeInput['category'],
    color,
    pins,
    properties,
  });
}

export function validateDeleteComponentType(
  input: unknown,
  definitions: Record<string, ComponentDefinition>,
  builtinTypes: ReadonlySet<string>,
): Result<string> {
  if (!isObject(input) || typeof input.type !== 'string' || !input.type) return fail('type is required.');
  const type = input.type;
  if (builtinTypes.has(type)) return fail(`"${type}" is a built-in component type and cannot be deleted.`);
  if (!TYPE_ID_RE.test(type)) return fail(`"${type}" is not a valid custom type ID.`);
  if (!definitions[type]) return fail(`Component type "${type}" not found.`);
  return ok(type);
}

// ---- list_component_types ---- //

export function validateListComponentTypes(input: unknown): Result<string[] | null> {
  if (input === undefined || input === null) return ok(null);
  if (!isObject(input)) return fail('list_component_types needs an object input.');
  if (input.types === undefined || input.types === null) return ok(null);
  if (!Array.isArray(input.types) || input.types.some((t) => typeof t !== 'string')) return fail('types must be an array of type IDs.');
  if (input.types.length > 40) return fail('Ask for at most 40 types at a time.');
  return ok(input.types as string[]);
}

// ---- Board size caps ---- //

export function checkBoardCapacity(components: unknown[], wires: Wire[] | unknown[], adding: 'component' | 'wire'): string | null {
  if (adding === 'component' && components.length >= LIMITS.maxComponentsOnBoard) {
    return `The board already has ${components.length} components (limit ${LIMITS.maxComponentsOnBoard}).`;
  }
  if (adding === 'wire' && wires.length >= LIMITS.maxWiresOnBoard) {
    return `The board already has ${wires.length} wires (limit ${LIMITS.maxWiresOnBoard}).`;
  }
  return null;
}
