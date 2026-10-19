import type Anthropic from '@anthropic-ai/sdk';

/**
 * Tool definitions for the circuit assistant. Every input is validated again
 * in the renderer (src/ai/toolValidation.ts) before anything changes.
 *
 * Tools with a closed schema are marked `strict: true` on models that
 * support strict tool use; the two tools with a free-form `properties` map
 * can't be strict (strict requires additionalProperties: false everywhere).
 */

const endpointSchema = {
  type: 'object' as const,
  properties: {
    componentId: { type: 'string', description: 'A component ID such as "comp_3", or "board" for a bare breadboard hole' },
    pinId: { type: 'string', description: 'The pin ID on that component, or "col,row" for a board hole (e.g. "3,12")' },
  },
  required: ['componentId', 'pinId'],
  additionalProperties: false,
};

export const CIRCUIT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_component',
    description: `Add a component to the breadboard. col,row is the grid hole where the component's FIRST pin lands.
- col: integer 0-30 on the boards (see the board layout in the system prompt); power supplies use col -4.
- row: integer 0-49.
- DIP chips (width 2) must use col 6 (board 1) or col 22 (board 2); they straddle the centre gap.
- properties: only keys the type defines (see the catalog or list_component_types), numbers for numeric properties.
Returns the new component's ID. Fails (with a reason) for an unknown type, an off-board position or an overlap.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Component type ID from the catalog (e.g. "resistor", "led", "timer", "atmega328")' },
        col: { type: 'integer', description: 'Grid column of the first pin (0-30, or -4 for a power supply)' },
        row: { type: 'integer', description: 'Grid row of the first pin (0-49)' },
        properties: {
          type: 'object',
          description: 'Optional property values, e.g. {"resistance": 1000} for a resistor',
          additionalProperties: { type: ['number', 'string'] },
        },
      },
      required: ['type', 'col', 'row'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_wire',
    description: `Connect two pins with a wire. Each end is either a component pin { componentId: "comp_1", pinId: "anode" } or a breadboard hole { componentId: "board", pinId: "col,row" }.
Pin IDs differ per type: use the catalog or list_component_types. Board holes reach the power rails and the strips' internal connections.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        from: endpointSchema,
        to: endpointSchema,
        color: { type: 'string', description: 'Optional wire colour as #rrggbb (e.g. "#e74c3c" for red)' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_component',
    description: 'Remove a component by its ID, with all wires connected to it.',
    input_schema: {
      type: 'object' as const,
      properties: { componentId: { type: 'string', description: 'The component ID (e.g. "comp_1")' } },
      required: ['componentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_wire',
    description: 'Remove a wire by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: { wireId: { type: 'string', description: 'The wire ID (e.g. "wire_1")' } },
      required: ['wireId'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_circuit',
    description: `Remove ALL components and wires. Only use it when the user asked to start over or to clear the board, or after they confirmed when you asked. On a board with components it refuses unless the user's latest message asks for it, or confirmed_by_user is true because the user just said yes to your question. The user can undo it.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        confirmed_by_user: { type: 'boolean', description: 'True only if the user just confirmed that the board should be cleared' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'list_components',
    description: 'List the components on the board (IDs, types, first-pin col,row, properties) and the wires. Use it to check the current state before changing it.',
    input_schema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'list_component_types',
    description: 'List the available component types, or give details (pins with IDs and sides, size in grid units, properties with defaults) for the given types. Custom types created earlier are included.',
    input_schema: {
      type: 'object' as const,
      properties: {
        types: { type: 'array', items: { type: 'string' }, description: 'Type IDs to describe in detail; omit for the full list' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'create_component_type',
    description: `Create a component type that isn't in the catalog (e.g. a relay, a sensor, a Geiger tube). It is drawn as a DIP-style chip with labelled pins and has no electrical model. If the type ID already exists, the existing type is returned and nothing is created. Built-in types can't be replaced. Then place it with add_component.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'New type ID: lowercase letters, digits, "_" or "-", starting with a letter (e.g. "relay_spdt")' },
        label: { type: 'string', description: 'Short label for the chip body (e.g. "Relay")' },
        description: { type: 'string', description: 'One-line description for the sidebar' },
        category: { type: 'string', enum: ['passive', 'active', 'input', 'output', 'measurement', 'power'] },
        pins: {
          type: 'array',
          description: 'Pins (1-40); put about half on "left" and half on "right".',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Pin ID used in wiring (e.g. "coil_a", "vcc")' },
              label: { type: 'string', description: 'Short label shown on the pin (e.g. "VCC")' },
              side: { type: 'string', enum: ['left', 'right'] },
              type: { type: 'string', enum: ['power', 'ground', 'input', 'output', 'bidirectional'] },
            },
            required: ['id', 'label', 'side', 'type'],
            additionalProperties: false,
          },
        },
        color: { type: 'string', description: 'Body colour as #rrggbb (default dark grey)' },
        properties: {
          type: 'object',
          description: 'Optional editable properties, e.g. {"voltage": {"label": "HV Output", "default": 400, "unit": "V"}}',
          additionalProperties: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              default: { type: ['number', 'string'] },
              unit: { type: 'string' },
            },
            required: ['label', 'default'],
          },
        },
      },
      required: ['type', 'label', 'pins'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_component_type',
    description: 'Delete a custom (AI-created or imported) component type, with its placed instances and their wires. Built-in types cannot be deleted.',
    input_schema: {
      type: 'object' as const,
      properties: { type: { type: 'string', description: 'The custom type ID (e.g. "relay_spdt")' } },
      required: ['type'],
      additionalProperties: false,
    },
  },
];

/** Tools whose schemas are closed (no free-form maps) and so can be strict. */
const STRICT_OK = new Set(['add_wire', 'remove_component', 'remove_wire', 'clear_circuit', 'list_components', 'list_component_types', 'delete_component_type']);

/** Models that support strict tool use (claude-api reference, 2026-10-06). */
export function supportsStrictTools(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)-5-5\b/.test(model) || /^claude-haiku-4-5\b/.test(model);
}

export function toolsForModel(model: string): Anthropic.Tool[] {
  if (!supportsStrictTools(model)) return CIRCUIT_TOOLS;
  return CIRCUIT_TOOLS.map((t) => (STRICT_OK.has(t.name) ? { ...t, strict: true } : t));
}
