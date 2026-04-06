import { ComponentDefinition } from '../types';

export const COMPONENT_DEFINITIONS: Record<string, ComponentDefinition> = {
  resistor: {
    type: 'resistor',
    label: 'Resistor',
    category: 'passive',
    width: 3,
    height: 1,
    color: '#c084fc',
    pins: [
      { id: 'a', label: 'A', side: 'left', offset: 0.5, type: 'bidirectional' },
      { id: 'b', label: 'B', side: 'right', offset: 0.5, type: 'bidirectional' },
    ],
    properties: {
      resistance: { label: 'Resistance', default: 220, unit: 'Ω' },
    },
  },
  capacitor: {
    type: 'capacitor',
    label: 'Capacitor',
    category: 'passive',
    width: 2,
    height: 1,
    color: '#60a5fa',
    pins: [
      { id: 'pos', label: '+', side: 'left', offset: 0.5, type: 'bidirectional' },
      { id: 'neg', label: '-', side: 'right', offset: 0.5, type: 'bidirectional' },
    ],
    properties: {
      capacitance: { label: 'Capacitance', default: 100, unit: 'μF' },
    },
  },
  led: {
    type: 'led',
    label: 'LED',
    category: 'output',
    width: 1,
    height: 1,
    color: '#f87171',
    pins: [
      { id: 'anode', label: '+', side: 'top', offset: 0.5, type: 'input' },
      { id: 'cathode', label: '-', side: 'bottom', offset: 0.5, type: 'output' },
    ],
    properties: {
      forwardVoltage: { label: 'Forward Voltage', default: 2.0, unit: 'V' },
      color: { label: 'Color', default: 'red' },
    },
  },
  switch: {
    type: 'switch',
    label: 'Switch',
    category: 'input',
    width: 2,
    height: 1,
    color: '#fbbf24',
    pins: [
      { id: 'a', label: 'A', side: 'left', offset: 0.5, type: 'bidirectional' },
      { id: 'b', label: 'B', side: 'right', offset: 0.5, type: 'bidirectional' },
    ],
    properties: {},
  },
  timer: {
    type: 'timer',
    label: '555',
    category: 'active',
    width: 4,
    height: 4,
    color: '#f472b6',
    pins: [
      // Left side (pins 1-4, bottom to top like a real DIP)
      { id: 'gnd',   label: 'GND',  side: 'left', offset: 0.875, type: 'input' },
      { id: 'trig',  label: 'TRIG', side: 'left', offset: 0.625, type: 'input' },
      { id: 'out',   label: 'OUT',  side: 'left', offset: 0.375, type: 'output' },
      { id: 'reset', label: 'RST',  side: 'left', offset: 0.125, type: 'input' },
      // Right side (pins 5-8, bottom to top)
      { id: 'ctrl',  label: 'CTRL', side: 'right', offset: 0.875, type: 'input' },
      { id: 'thr',   label: 'THR',  side: 'right', offset: 0.625, type: 'input' },
      { id: 'dis',   label: 'DIS',  side: 'right', offset: 0.375, type: 'output' },
      { id: 'vcc',   label: 'VCC',  side: 'right', offset: 0.125, type: 'input' },
    ],
    properties: {
      interval: { label: 'Interval', default: 2000, unit: 'ms' },
    },
  },
  power: {
    type: 'power',
    label: 'Power',
    category: 'power',
    width: 2,
    height: 4,
    color: '#4ade80',
    pins: [
      { id: 'pos', label: '+', side: 'right', offset: 0.25, type: 'power' },
      { id: 'neg', label: '-', side: 'right', offset: 0.75, type: 'ground' },
    ],
    properties: {
      voltage: { label: 'Voltage', default: 5, unit: 'V' },
      mode: { label: 'Mode', default: 'DC' },
      waveform: { label: 'Waveform', default: 'square' },
    },
  },
};

export const COMPONENT_CATEGORIES = [
  { id: 'power', label: 'Power' },
  { id: 'passive', label: 'Passive' },
  { id: 'input', label: 'Input' },
  { id: 'output', label: 'Output' },
  { id: 'active', label: 'Active' },
] as const;
