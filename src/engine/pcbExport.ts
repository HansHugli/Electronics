import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';

/**
 * Map component types to KiCad footprint library names.
 */
const FOOTPRINT_MAP: Record<string, string> = {
  resistor: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal',
  capacitor: 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm',
  led: 'LED_THT:LED_D3.0mm',
  switch: 'Button_Switch_THT:SW_PUSH_6mm',
  potentiometer: 'Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical',
  timer: 'Package_DIP:DIP-8_W7.62mm',
  cd4026: 'Package_DIP:DIP-16_W7.62mm',
  display7seg: 'Display_7Segment:7SegmentLED_LTS6760_LTS6780',
  gate_and: 'Package_DIP:DIP-14_W7.62mm',
  gate_or: 'Package_DIP:DIP-14_W7.62mm',
  gate_nand: 'Package_DIP:DIP-14_W7.62mm',
  gate_not: 'Package_DIP:DIP-14_W7.62mm',
  opamp: 'Package_DIP:DIP-8_W7.62mm',
  multimeter: '',
  ledmatrix: 'Package_DIP:DIP-14_W7.62mm',
};

/**
 * Map component types to KiCad symbol library names.
 */
const SYMBOL_MAP: Record<string, string> = {
  resistor: 'Device:R',
  capacitor: 'Device:C_Polarized',
  led: 'Device:LED',
  switch: 'Switch:SW_Push',
  potentiometer: 'Device:R_Potentiometer',
  timer: 'Timer:NE555',
  cd4026: 'CMOS_4000:CD4026',
  display7seg: 'Display_Character:7SEG-CA',
  gate_and: '74xx:74HC08',
  gate_or: '74xx:74HC32',
  gate_nand: '74xx:74HC00',
  gate_not: '74xx:74HC04',
  opamp: 'Amplifier_Operational:LM741',
  multimeter: '',
  ledmatrix: 'Display_Character:HDSP-5x7',
};

/**
 * Generate a KiCad netlist (.net) for the current circuit.
 * This is KiCad 5 format which is also importable by KiCad 6+.
 */
export function generateKiCadNetlist(components: PlacedComponent[], wires: Wire[]): string {
  const lines: string[] = [];
  const timestamp = Math.floor(Date.now() / 1000).toString(16);

  lines.push('(export (version D)');
  lines.push('  (design');
  lines.push(`    (source "E101 Electronics Simulator")`);
  lines.push(`    (date "${new Date().toISOString()}")`);
  lines.push('    (tool "E101 PCB Export v1.0")');
  lines.push('  )');

  // Components section
  lines.push('  (components');
  for (const comp of components) {
    if (comp.type === 'power' || comp.type === 'multimeter') continue;
    const def = COMPONENT_DEFINITIONS[comp.type];
    if (!def) continue;
    const footprint = FOOTPRINT_MAP[comp.type] ?? 'Package_DIP:DIP-8_W7.62mm';
    const symbol = SYMBOL_MAP[comp.type] ?? `Device:${def.label}`;
    if (!footprint) continue;

    const ref = getRefDesignator(comp);
    lines.push(`    (comp (ref ${ref})`);
    lines.push(`      (value "${getComponentValue(comp)}")`);
    lines.push(`      (footprint "${footprint}")`);
    lines.push(`      (libsource (lib "${symbol.split(':')[0]}") (part "${symbol.split(':')[1]}"))`);
    lines.push(`      (sheetpath (names /) (tstamps /))`);
    lines.push(`      (tstamp ${timestamp}_${comp.id.replace(/\D/g, '')}))`);
  }
  lines.push('  )');

  // Build net graph
  const netMap = buildNetMap(components, wires);

  // Nets section
  lines.push('  (nets');
  lines.push('    (net (code 0) (name "GND"))'); // net 0 is always GND
  let netCode = 1;
  for (const [netName, pins] of netMap) {
    if (netName === 'GND') continue;
    lines.push(`    (net (code ${netCode}) (name "${netName}")`);
    for (const pin of pins) {
      lines.push(`      (node (ref ${pin.ref}) (pin ${pin.pin}))`);
    }
    lines.push('    )');
    netCode++;
  }
  lines.push('  )');
  lines.push(')');

  return lines.join('\n');
}

/**
 * Generate a simpler CSV-based Bill of Materials.
 */
export function generateBOM(components: PlacedComponent[]): string {
  const lines: string[] = ['Reference,Type,Value,Footprint'];
  for (const comp of components) {
    if (comp.type === 'power' || comp.type === 'multimeter') continue;
    const def = COMPONENT_DEFINITIONS[comp.type];
    if (!def) continue;
    const ref = getRefDesignator(comp);
    const value = getComponentValue(comp);
    const footprint = FOOTPRINT_MAP[comp.type] ?? 'DIP';
    lines.push(`${ref},${def.label},${value},${footprint}`);
  }
  return lines.join('\n');
}

function getRefDesignator(comp: PlacedComponent): string {
  const num = comp.id.replace(/\D/g, '');
  switch (comp.type) {
    case 'resistor': return `R${num}`;
    case 'capacitor': return `C${num}`;
    case 'led': return `D${num}`;
    case 'switch': return `SW${num}`;
    case 'potentiometer': return `RV${num}`;
    case 'timer':
    case 'cd4026':
    case 'gate_and':
    case 'gate_or':
    case 'gate_nand':
    case 'gate_not':
    case 'opamp':
    case 'ledmatrix':
      return `U${num}`;
    case 'display7seg': return `DS${num}`;
    default: return `X${num}`;
  }
}

function getComponentValue(comp: PlacedComponent): string {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (!def) return comp.type;
  if (comp.type === 'resistor') {
    return `${comp.properties.resistance ?? 220}${def.properties?.resistance?.unit ?? 'Ω'}`;
  }
  if (comp.type === 'capacitor') {
    return `${comp.properties.capacitance ?? 100}${def.properties?.capacitance?.unit ?? 'μF'}`;
  }
  if (comp.type === 'led') {
    return `LED_${comp.properties.color ?? 'red'}`;
  }
  return def.label;
}

interface NetPin {
  ref: string;
  pin: string;
}

function buildNetMap(components: PlacedComponent[], wires: Wire[]): Map<string, NetPin[]> {
  // Simple net extraction: each wire connects two pins, merge connected pins into nets
  const parent = new Map<string, string>();

  function find(k: string): string {
    if (!parent.has(k)) parent.set(k, k);
    let p = parent.get(k)!;
    while (parent.get(p) !== p) {
      parent.set(p, parent.get(parent.get(p)!)!);
      p = parent.get(p)!;
    }
    parent.set(k, p);
    return p;
  }

  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Register all component pins
  for (const comp of components) {
    if (comp.type === 'power' || comp.type === 'multimeter') continue;
    const def = COMPONENT_DEFINITIONS[comp.type];
    if (!def) continue;
    for (const pin of def.pins) {
      find(`${comp.id}:${pin.id}`);
    }
  }

  // Merge wires
  for (const wire of wires) {
    const fromKey = wire.from.componentId === 'board'
      ? `board:${wire.from.pinId}`
      : `${wire.from.componentId}:${wire.from.pinId}`;
    const toKey = wire.to.componentId === 'board'
      ? `board:${wire.to.pinId}`
      : `${wire.to.componentId}:${wire.to.pinId}`;
    find(fromKey);
    find(toKey);
    union(fromKey, toKey);
  }

  // Group pins by net root
  const rootToPins = new Map<string, NetPin[]>();
  for (const comp of components) {
    if (comp.type === 'power' || comp.type === 'multimeter') continue;
    const def = COMPONENT_DEFINITIONS[comp.type];
    if (!def) continue;
    const ref = getRefDesignator(comp);
    for (const pin of def.pins) {
      const root = find(`${comp.id}:${pin.id}`);
      if (!rootToPins.has(root)) rootToPins.set(root, []);
      rootToPins.get(root)!.push({ ref, pin: pin.id });
    }
  }

  // Name nets
  const nets = new Map<string, NetPin[]>();
  let netIdx = 1;
  for (const [, pins] of rootToPins) {
    if (pins.length < 2) continue; // unconnected pins don't form nets
    // Check if this net includes a GND pin
    const hasGnd = pins.some((p) => p.pin === 'gnd' || p.pin === 'neg' || p.pin === 'v_neg');
    const hasVcc = pins.some((p) => p.pin === 'vcc' || p.pin === 'v_pos');
    let name: string;
    if (hasGnd) name = 'GND';
    else if (hasVcc) name = 'VCC';
    else name = `Net${netIdx++}`;
    nets.set(name, pins);
  }

  return nets;
}
