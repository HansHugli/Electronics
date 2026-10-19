import { describe, expect, it } from 'vitest';
import { autoSelectModel, chooseModel, DEFAULT_MODEL, HAIKU, normaliseModelSetting, OPUS, SONNET } from './modelSelect';

describe('autoSelectModel', () => {
  // The reviewer's examples: "thanks!" used to pick Opus.
  it.each([
    ['hi', HAIKU],
    ['thanks!', HAIKU],
    ['what is a resistor?', HAIKU],
    ['why is my LED not lighting?', HAIKU],
    ['what does this circuit do?', HAIKU],
    ['is the timer output high?', HAIKU],
    ['yes', HAIKU],
    ['build me a 555 blink circuit', SONNET],
    ['change R1 to 470 ohms', SONNET],
    ['add a resistor between the LED and ground', SONNET],
    ['wire up the LED to pin 13', SONNET],
    ['start over and make a traffic light', SONNET],
  ])('%s → %s', (msg, model) => {
    expect(autoSelectModel(msg).model).toBe(model);
  });

  it('picks Opus only for clearly multi-part designs', () => {
    const big = 'Design a circuit with an ATmega328 that drives a 7-segment display through a 595 shift register, with a 555 timer as a clock and a 7805 regulator.';
    expect(autoSelectModel(big).model).toBe(OPUS);
    expect(autoSelectModel('build a 555 timer circuit').model).toBe(SONNET);
  });

  it('uses Sonnet for long questions without building', () => {
    const q = 'Can you explain in some detail how the capacitor in this circuit charges and discharges, and why the LED seems to fade slowly instead of switching off at once when the timer output goes low?';
    expect(autoSelectModel(q).model).toBe(SONNET);
  });

  it('gives a one-line reason and an explicit effort', () => {
    const c = autoSelectModel('hi');
    expect(c.reason).toMatch(/Haiku 5\.5/);
    expect(c.effort).toBe('low');
    expect(autoSelectModel('build a blinker').effort).toBe('medium');
  });
});

describe('chooseModel', () => {
  it('chooses once per conversation', () => {
    const first = chooseModel('auto', undefined, 'hi');
    expect(first.model).toBe(HAIKU);
    const second = chooseModel('auto', first, 'now build me a 4-bit counter with a display and an arduino');
    expect(second).toBe(first);
  });

  it('switches when the user changes the dropdown', () => {
    const first = chooseModel('auto', undefined, 'hi');
    const second = chooseModel(OPUS, first, 'hi');
    expect(second.model).toBe(OPUS);
    expect(second.reason).toMatch(/as selected/);
  });

  it('defaults to Sonnet 5.5 and maps legacy settings', () => {
    expect(DEFAULT_MODEL).toBe(SONNET);
    expect(normaliseModelSetting(undefined)).toBe(SONNET);
    expect(normaliseModelSetting('claude-opus-4-6')).toBe(OPUS);
    expect(normaliseModelSetting('claude-haiku-4-5')).toBe(HAIKU);
    expect(normaliseModelSetting('nonsense')).toBe(SONNET);
    expect(chooseModel('claude-sonnet-4-6', undefined, 'x').model).toBe(SONNET);
  });
});
