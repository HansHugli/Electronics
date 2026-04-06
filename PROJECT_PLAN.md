# E101 Project Plan

## Vision

Build a desktop electronics circuit simulation app that lets users design, wire, and test circuits visually using a component-based editor.

## Core Objectives

1. Visual circuit building with drag-and-drop component placement
2. Real-time simulation of basic electrical behavior
3. Desktop persistence with configurable storage paths
4. Expandable component library for analog, digital, and programmable parts

## MVP Feature List

### Workspace & UI
- Canvas-based circuit editor
- Sidebar component library
- Breadboard and virtual connection views
- Project save/load and recent files
- Settings dialog for storage path selection

### Components
- Resistors
- Capacitors
- Switches
- Potentiometers
- DC and AC power sources
- LEDs (single-color and RGB)
- Chips with input/output pins
- Digital display output

### Simulation
- Signal propagation through wires
- LED blink example (2-second on/off)
- Basic voltage and current behavior for passive components

### Storage
- Default data path using Electron userData
- OneDrive-aware storage path for Windows and macOS
- Config file (`e101-config.json`) for persistent folder selection

## Phase 1 — Foundation

- Scaffold React + Electron app
- Create initial renderer UI and Electron shell
- Implement breadboard editor shell and component palette
- Build LED blink demo circuit
- Add local storage configuration

## Phase 2 — Core Components

- Add resistor, capacitor, switch, potentiometer, and power source components
- Add chip/pin wiring abstractions
- Build simulation engine for signal states and analog behavior
- Add LED output and digital display

## Phase 3 — Advanced Features

- Add PCB schematic export
- Add Arduino/programmable input components
- Add multi-voltage sources and AC behavior
- Add component import/extension mechanism
- Add configurable simulation speed and waveform visualization

## Technical Plan

- Frontend: React 18 + TypeScript
- Desktop: Electron 28
- Bundler: Vite
- Packaging: electron-builder
- Versioning: standard-version

## Initial Milestone

- `npm install` ✅
- `npm run dev` ✅ (starts Vite on http://localhost:5174)
- `npm run build:electron && npx electron .` ✅ (starts Electron app)
- Confirm starter app loads ✅
- Build first LED blink demo circuit (next) in UI

## Notes

The first concrete deliverable is a working breadboard example that flashes an LED every 2 seconds. This will validate the renderer, Electron integration, and storage flow.
