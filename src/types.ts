export interface Point {
  x: number;
  y: number;
}

export interface Pin {
  id: string;
  label: string;
  side: 'left' | 'right' | 'top' | 'bottom';
  offset: number; // position along the side (0-1)
  type: 'power' | 'ground' | 'input' | 'output' | 'bidirectional';
  number?: number; // physical pin number (DIP packages count counter-clockwise from pin 1)
}

export interface ComponentDefinition {
  type: string;
  label: string;
  description?: string;  // short blurb for sidebar
  icon?: string;         // 1-3 char icon for sidebar card
  chipLabel?: string;    // short label for chip body on breadboard (e.g. "555", "7408")
  category: 'passive' | 'active' | 'power' | 'output' | 'input' | 'measurement';
  width: number;  // grid units
  height: number; // grid units
  pins: Pin[];
  color: string;
  properties?: Record<string, { label: string; default: number | string; unit?: string }>;
  /** Simulation model for custom chips (e.g. 'logic_and'); built-in parts use their type. */
  behavior?: string;
}

/** Diagnostic codes the engine sets on `comp.state.warning`. */
export type WarningCode =
  | 'led_reversed'
  | 'led_overcurrent'
  | 'short_circuit'
  | 'floating_input'
  | 'unpowered'
  | 'overcurrent'
  | 'no_ground';

/** One plain-language problem the engine found with a component. */
export interface ComponentWarning {
  code: WarningCode;
  message: string;
}

/**
 * Runtime state written by the simulator. Values are numbers or strings (gate
 * outputs are stored as booleans at runtime). `warning` is set when the engine
 * finds a problem with the part and is absent otherwise.
 */
export interface ComponentState {
  /** Model-specific values (numbers or strings; gate outputs are booleans). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  warning?: ComponentWarning;
}

export interface PlacedComponent {
  id: string;
  type: string;
  position: Point;       // grid position on breadboard
  rotation: number;      // degrees (0, 90, 180, 270)
  properties: Record<string, number | string>;
  state: ComponentState; // runtime state (e.g. LED on/off, voltage)
}

/**
 * Wire endpoint — either a component pin or a breadboard pin hole.
 * For component pins: componentId = component id, pinId = pin id
 * For breadboard holes: componentId = 'board', pinId = 'col,row'
 */
export interface WireEndpoint {
  componentId: string;
  pinId: string;
}

export interface Wire {
  id: string;
  from: WireEndpoint;
  to: WireEndpoint;
  waypoints: Point[];    // intermediate points for routing
  color: string;
}

export interface Circuit {
  components: PlacedComponent[];
  wires: Wire[];
}

export interface SimulationState {
  running: boolean;
  time: number;           // ms since simulation start
  tickRate: number;        // ms per tick
  componentStates: Map<string, Record<string, number | string>>;
}
