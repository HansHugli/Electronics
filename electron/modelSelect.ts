/**
 * Which Claude model answers. "Auto" picks once per conversation (switching
 * mid-conversation would throw away the prompt cache) and says why.
 */

export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5-5';
export const HAIKU = 'claude-haiku-5-5';
export const DEFAULT_MODEL = SONNET;

/** What the model dropdown may hold. */
export const MODEL_SETTINGS = ['auto', OPUS, SONNET, HAIKU] as const;

const LEGACY_TO_CURRENT: Record<string, string> = {
  'claude-opus-4-6': OPUS,
  'claude-sonnet-4-6': SONNET,
  'claude-haiku-4-5': HAIKU,
};

/** Normalise a stored setting: legacy IDs map to their 5.5 successor, junk → default. */
export function normaliseModelSetting(setting: string | undefined): string {
  if (!setting) return DEFAULT_MODEL;
  if ((MODEL_SETTINGS as readonly string[]).includes(setting)) return setting;
  return LEGACY_TO_CURRENT[setting] ?? DEFAULT_MODEL;
}

export type Effort = 'low' | 'medium';

export interface ModelChoice {
  /** The dropdown value this choice was made for ('auto' or a model ID). */
  setting: string;
  model: string;
  effort: Effort;
  /** One line for the UI. */
  reason: string;
}

const BUILD_PATTERNS: RegExp[] = [
  /\b(build|create|design|construct|assemble)\b/,
  /\bmake\s+(me\s+)?(a|an|the|it|this|that)\b/,
  /\b(add|place|put|insert)\s+(a|an|the|some|two|three|\d+)\b/,
  /\b(wire|hook|connect)\s+(it\s+|them\s+)?(up|to|together)\b/,
  /\bset\s+up\b/, /\bput\s+together\b/,
  /\b(change|replace|swap|modify|move|remove|delete|rewire|fix)\b.*\b(circuit|resistor|led|capacitor|chip|wire|component|board|it|r\d+|c\d+)\b/,
  /\bstart\s+over\b/, /\bfrom\s+scratch\b/,
];

/** Distinct building blocks; three or more in one build request reads as a multi-part design. */
const SUBSYSTEM_PATTERNS: RegExp[] = [
  /\b(arduino|atmega|microcontroller|mcu|avr)\b/,
  /\b(counter|4026)\b/, /\b(7[- ]?seg|seven[- ]segment|display)\b/,
  /\b(shift register|595)\b/, /\b(matrix)\b/, /\b(555|timer|oscillator|astable|monostable)\b/,
  /\b(op[- ]?amp|amplifier|comparator)\b/, /\b(regulator|7805|power supply)\b/,
  /\b(flip[- ]?flop|latch|74hc74)\b/, /\b(logic gates?|and gate|or gate|nand|inverter)\b/,
  /\b(sensor|potentiometer|button|switch)\b/, /\b(filter|scope|function generator)\b/,
];

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function isBuildRequest(text: string): boolean {
  const msg = text.toLowerCase();
  return BUILD_PATTERNS.some((p) => p.test(msg));
}

/** Pick a model for the first message of a conversation. */
export function autoSelectModel(text: string): Omit<ModelChoice, 'setting'> {
  const msg = text.toLowerCase();
  const words = wordCount(text);
  const building = isBuildRequest(text);
  const subsystems = SUBSYSTEM_PATTERNS.filter((p) => p.test(msg)).length;
  const listItems = (text.match(/^\s*(\d+[.)]|[-*])\s+/gm) ?? []).length;

  if (building && (subsystems >= 3 || (words > 120 && subsystems >= 2) || listItems >= 4)) {
    return { model: OPUS, effort: 'medium', reason: 'Auto picked Opus 5.5: this looks like a multi-part design.' };
  }
  if (building) {
    return { model: SONNET, effort: 'medium', reason: 'Auto picked Sonnet 5.5: it builds or changes circuits.' };
  }
  if (words <= 25) {
    return { model: HAIKU, effort: 'low', reason: 'Auto picked Haiku 5.5: a short question, no building.' };
  }
  return { model: SONNET, effort: 'low', reason: 'Auto picked Sonnet 5.5: a longer question.' };
}

/**
 * Resolve the model for this turn. Keeps the previous choice for the whole
 * conversation unless the user changed the dropdown.
 */
export function chooseModel(setting: string | undefined, previous: ModelChoice | undefined, firstUserText: string): ModelChoice {
  const s = normaliseModelSetting(setting);
  if (previous && previous.setting === s) return previous;
  if (s === 'auto') return { setting: s, ...autoSelectModel(firstUserText) };
  const label = s === OPUS ? 'Opus 5.5' : s === HAIKU ? 'Haiku 5.5' : 'Sonnet 5.5';
  return {
    setting: s,
    model: s,
    effort: s === HAIKU ? 'low' : 'medium',
    reason: `${label}, as selected.`,
  };
}
