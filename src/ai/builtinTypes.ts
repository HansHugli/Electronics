import { COMPONENT_DEFINITIONS } from '../data/components';

/**
 * The built-in component types, captured when this module first loads,
 * before custom chips are registered into COMPONENT_DEFINITIONS. The AI may
 * not delete or replace these.
 */
export const BUILTIN_TYPE_IDS: ReadonlySet<string> = new Set(Object.keys(COMPONENT_DEFINITIONS));
