// Custom chip JSON (src/data/chipLoader.ts, chips/*.json, AI create_component_type).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerChips, chipJSONToDefinition, isSafeChipType, type ChipDefinitionJSON } from '../../src/data/chipLoader';
import { COMPONENT_DEFINITIONS } from '../../src/data/components';
import { Bench } from './bench';

const good = (type: string): ChipDefinitionJSON => ({
  type, label: type, behavior: 'passthrough', package: 'DIP-8',
  pins: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: n, id: `p${n}`, label: `P${n}`, side: n <= 4 ? 'left' : 'right', offset: undefined as unknown as number, type: 'input' as const })),
});

describe('chip JSON validation', () => {
  it('one malformed file does not prevent the other chips from loading', () => {
    const bad = { type: 'bad1', label: 'Bad', behavior: 'x', pins: 'not-an-array' } as unknown as ChipDefinitionJSON;
    let n = -1, err = '';
    try { n = registerChips([good('okA'), bad, good('okB')]); } catch (e) { err = String(e); }
    console.log(`  registerChips -> ${n}, error='${err.slice(0, 60)}', okB registered=${!!COMPONENT_DEFINITIONS.okB}`);
    expect(!!COMPONENT_DEFINITIONS.okB).toBe(true);
  });
  it('a null pin entry is rejected, not thrown', () => {
    const bad = { type: 'bad2', label: 'Bad', behavior: 'x', pins: [null] } as unknown as ChipDefinitionJSON;
    expect(() => registerChips([bad])).not.toThrow();
  });
  it('reserved names (__proto__, constructor) are not registered and do not pollute', () => {
    registerChips([{ ...good('constructor') }, { ...good('__proto__') }]);
    expect(({} as Record<string, unknown>).pins).toBe(undefined);
  });
  it('a chip with nonsense geometry can be placed and simulated without throwing', () => {
    const weird = {
      type: 'weird1', label: 'W', behavior: 'passthrough', width: -3, height: 1e6,
      pins: [
        { id: 'a', label: 'A', side: 'nowhere', offset: Number.NaN, type: 'output' },
        { id: 'a', label: 'dup', side: 'left', offset: 2, type: 'power' },
        { id: 'pos', label: 'collide', side: 'top', offset: 0.5, type: 'ground' },
      ],
    } as unknown as ChipDefinitionJSON;
    registerChips([weird]);
    const b = new Bench(); b.power(); b.add('weird1', 'w');
    b.hi('w.a').lo('w.pos');
    expect(() => b.tick(3)).not.toThrow();
  });
  it('"behavior" selects a simulation model (logic_and makes an AND gate)', () => {
    const json: ChipDefinitionJSON = {
      type: 'myand', label: 'My AND', behavior: 'logic_and', package: 'DIP-14',
      pins: COMPONENT_DEFINITIONS.gate_and.pins.map((p, i) => ({ ...p, number: i + 1 })),
    };
    registerChips([json]);
    const b = new Bench(); b.power(); b.add('myand', 'u');
    b.hi('u.vcc').lo('u.gnd').hi('u.1a').hi('u.1b').probe('u.1y');
    b.tick(3);
    console.log(`  custom chip behavior=logic_and: 1y = ${b.v('u.1y').toFixed(2)} V`);
    expect(b.v('u.1y')).toBeGreaterThan(4);
  });
  it('chips/example-shift-register.json converts with the offsets it declares', () => {
    const j = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'chips', 'example-shift-register.json'), 'utf-8'));
    const def = chipJSONToDefinition(j);
    expect(def.pins.length).toBe(16);
    expect(def.height).toBe(8);
  });
  // The original test exercised path.join itself (which always fails for
  // '../x'). The engine side of the fix: chip type ids are validated, so an
  // unsafe id is never registered, and electron/main.ts can call
  // isSafeChipType() before building `${type}.json`.
  it('chip type ids are safe as file names (save-chip/delete-chip use path.join(dir, `${type}.json`))', () => {
    for (const bad of ['../e101', '..\\e101-config', 'a/b', '', '__proto__', 'x'.repeat(65)]) {
      expect(isSafeChipType(bad)).toBe(false);
    }
    expect(isSafeChipType('my_chip-2')).toBe(true);
    const before = Object.keys(COMPONENT_DEFINITIONS).length;
    registerChips([good('../e101')]);
    expect(Object.keys(COMPONENT_DEFINITIONS).length).toBe(before);
    const dir = 'C:/data/e101/chips';
    const p = join(dir, 'my_chip-2.json').replace(/\\/g, '/');
    expect(p.startsWith(dir + '/')).toBe(true);
  });
});

