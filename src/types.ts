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
}

export interface ComponentDefinition {
  type: string;
  label: string;
  category: 'passive' | 'active' | 'power' | 'output' | 'input';
  width: number;  // grid units
  height: number; // grid units
  pins: Pin[];
  color: string;
  properties?: Record<string, { label: string; default: number | string; unit?: string }>;
}

export interface PlacedComponent {
  id: string;
  type: string;
  position: Point;       // grid position on breadboard
  rotation: number;      // degrees (0, 90, 180, 270)
  properties: Record<string, number | string>;
  state: Record<string, number | string>; // runtime state (e.g. LED on/off, voltage)
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
