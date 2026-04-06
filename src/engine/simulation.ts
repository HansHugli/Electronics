import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';

interface Node {
  voltage: number;
  components: { componentId: string; pinId: string }[];
}

/**
 * Simple circuit simulation engine.
 * Builds a node graph from wires, then propagates voltage from power sources
 * through connected components to determine LED states, etc.
 */
export function simulateCircuit(
  components: PlacedComponent[],
  wires: Wire[],
  time: number
): Map<string, Record<string, number | string>> {
  const states = new Map<string, Record<string, number | string>>();

  // Initialize all component states
  for (const comp of components) {
    states.set(comp.id, { ...comp.state });
  }

  // Build adjacency: which pins are connected
  const nodeMap = new Map<string, Node>(); // pinKey -> node
  const pinKey = (compId: string, pinId: string) => `${compId}:${pinId}`;

  // Each pin starts in its own node
  for (const comp of components) {
    const def = COMPONENT_DEFINITIONS[comp.type];
    if (!def) continue;
    for (const pin of def.pins) {
      const key = pinKey(comp.id, pin.id);
      nodeMap.set(key, {
        voltage: 0,
        components: [{ componentId: comp.id, pinId: pin.id }],
      });
    }
  }

  // Merge nodes connected by wires
  function findNode(key: string): Node {
    return nodeMap.get(key)!;
  }

  function mergeNodes(keyA: string, keyB: string) {
    const nodeA = findNode(keyA);
    const nodeB = findNode(keyB);
    if (nodeA === nodeB) return;
    // Merge B into A
    for (const member of nodeB.components) {
      nodeA.components.push(member);
      nodeMap.set(pinKey(member.componentId, member.pinId), nodeA);
    }
    nodeA.voltage = Math.max(nodeA.voltage, nodeB.voltage);
  }

  for (const wire of wires) {
    const fromKey = pinKey(wire.from.componentId, wire.from.pinId);
    const toKey = pinKey(wire.to.componentId, wire.to.pinId);
    if (nodeMap.has(fromKey) && nodeMap.has(toKey)) {
      mergeNodes(fromKey, toKey);
    }
  }

  // Set voltage on power source positive pins
  for (const comp of components) {
    if (comp.type === 'power') {
      const voltage = Number(comp.properties.voltage ?? 5);
      const posKey = pinKey(comp.id, 'pos');
      const node = nodeMap.get(posKey);
      if (node) node.voltage = voltage;
    }
  }

  // Handle switches: if closed (toggled by user click), merge their pins
  for (const comp of components) {
    if (comp.type === 'switch') {
      const state = states.get(comp.id);
      if (state?.closed) {
        mergeNodes(pinKey(comp.id, 'a'), pinKey(comp.id, 'b'));
      }
    }
  }

  // Handle 555 Timer: oscillates output based on interval property
  // When VCC has voltage and GND connects to ground, output toggles
  for (const comp of components) {
    if (comp.type === 'timer') {
      const vccNode = nodeMap.get(pinKey(comp.id, 'vcc'));
      const gndNode = nodeMap.get(pinKey(comp.id, 'gnd'));

      const hasVcc = vccNode && vccNode.voltage > 0;
      const hasGnd = gndNode && gndNode.components.some((member) => {
        const memberComp = components.find((c) => c.id === member.componentId);
        if (!memberComp) return false;
        return memberComp.type === 'power' && member.pinId === 'neg';
      });

      const state = states.get(comp.id) ?? {};
      if (hasVcc && hasGnd) {
        const interval = Number(comp.properties.interval ?? 2000);
        const outputHigh = Math.floor(time / interval) % 2 === 0;
        state.outputHigh = outputHigh ? 1 : 0;

        // If output is high, propagate voltage from VCC to OUT
        if (outputHigh) {
          const outNode = nodeMap.get(pinKey(comp.id, 'out'));
          if (outNode) outNode.voltage = vccNode!.voltage;
        }
      } else {
        state.outputHigh = 0;
      }
      states.set(comp.id, state);
    }
  }

  // Resistors: pass-through (merge pins to propagate voltage)
  for (const comp of components) {
    if (comp.type === 'resistor') {
      mergeNodes(pinKey(comp.id, 'a'), pinKey(comp.id, 'b'));
    }
  }

  // Propagate: check if LED has voltage on anode and ground path on cathode
  for (const comp of components) {
    if (comp.type === 'led') {
      const anodeNode = nodeMap.get(pinKey(comp.id, 'anode'));
      const cathodeNode = nodeMap.get(pinKey(comp.id, 'cathode'));

      const hasVoltage = anodeNode && anodeNode.voltage > 0;
      const hasGround = cathodeNode && cathodeNode.components.some((member) => {
        const memberComp = components.find((c) => c.id === member.componentId);
        if (!memberComp) return false;
        if (memberComp.type === 'power' && member.pinId === 'neg') return true;
        return false;
      });

      const state = states.get(comp.id) ?? {};
      state.on = hasVoltage && hasGround ? 1 : 0;
      states.set(comp.id, state);
    }
  }

  return states;
}

/**
 * Creates the LED blink demo circuit:
 * Power -> 555 Timer -> Resistor -> LED -> Ground
 * Timer oscillates every 2 seconds, blinking the LED.
 *
 * Layout: Power on far left (supply area), then 555, resistor, LED
 * spaced out with room for clean wiring.
 */
export function createBlinkDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  // SUPPLY_WIDTH = 5 * 24 = 120, BOARD_X = 120
  // Grid = 24px. 555 is 4x4 (96x96), Resistor 3x1 (72x24), LED 1x1 (24x24)
  const components: PlacedComponent[] = [
    {
      id: 'power1',
      type: 'power',
      position: { x: 24, y: 120 },
      rotation: 0,
      properties: { voltage: 5, mode: 'DC', waveform: 'square' },
      state: {},
    },
    {
      id: 'timer1',
      type: 'timer',
      position: { x: 216, y: 96 },
      rotation: 0,
      properties: { interval: 2000 },
      state: { outputHigh: 0 },
    },
    {
      id: 'resistor1',
      type: 'resistor',
      position: { x: 432, y: 168 },
      rotation: 0,
      properties: { resistance: 220 },
      state: {},
    },
    {
      id: 'led1',
      type: 'led',
      position: { x: 564, y: 156 },
      rotation: 0,
      properties: { forwardVoltage: 2.0, color: 'red' },
      state: { on: 0 },
    },
  ];

  const wires: Wire[] = [
    // Power + -> Timer VCC (right side of 555)
    {
      id: 'w1',
      from: { componentId: 'power1', pinId: 'pos' },
      to: { componentId: 'timer1', pinId: 'vcc' },
      waypoints: [],
      color: '#ef4444',
    },
    // Power - -> Timer GND (left side of 555)
    {
      id: 'w2',
      from: { componentId: 'power1', pinId: 'neg' },
      to: { componentId: 'timer1', pinId: 'gnd' },
      waypoints: [],
      color: '#3b82f6',
    },
    // Timer OUT (left side) -> Resistor A
    {
      id: 'w3',
      from: { componentId: 'timer1', pinId: 'out' },
      to: { componentId: 'resistor1', pinId: 'a' },
      waypoints: [],
      color: '#fbbf24',
    },
    // Resistor B -> LED Anode (top)
    {
      id: 'w4',
      from: { componentId: 'resistor1', pinId: 'b' },
      to: { componentId: 'led1', pinId: 'anode' },
      waypoints: [],
      color: '#fbbf24',
    },
    // LED Cathode (bottom) -> Power GND
    {
      id: 'w5',
      from: { componentId: 'led1', pinId: 'cathode' },
      to: { componentId: 'power1', pinId: 'neg' },
      waypoints: [],
      color: '#3b82f6',
    },
  ];

  return { components, wires };
}
