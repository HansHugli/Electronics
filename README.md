# E101 Electronics Simulator

A desktop electronics circuit simulator built with React, TypeScript, and Electron. Build circuits on a realistic breadboard, wire components together, and run analog simulations — including real AVR microcontroller code.

## Getting started

```bash
npm install
npm run electron-dev
```

## Features

- Realistic dual-breadboard with internal wiring (power rails, 5-pin strips, center gap)
- 15+ component types: resistors, capacitors, LEDs, switches, ICs, op-amps, 7-segment displays, LED matrix
- Logic gates: AND (7408), OR (7432), NAND (7400), NOT (7404)
- 555 Timer and CD4026 counter with full behavioral simulation
- ATmega328P (Arduino Uno) with real AVR code execution via avr8js
- Modified Nodal Analysis (MNA) analog simulation engine
- Oscilloscope with multi-channel voltage probing
- Undo/redo, copy/paste, component rotation
- Save/open circuits as `.ecx` files
- KiCad netlist and BOM export for PCB layout
- Custom chip definitions via JSON files
- Configurable simulation speed (0.25x to 10x)
- Zoom and pan with mousewheel and Ctrl+click

For detailed usage instructions, see [FEATURES.md](FEATURES.md).

## Scripts

| Command | Description |
|---------|-------------|
| `npm run electron-dev` | Run in dev mode (React + Electron) |
| `npm run build` | Build for production |
| `npm run package:win` | Package for Windows |
| `npm run package:mac` | Package for macOS |
| `npm run ship` | Full release: version bump, build, push |

## Project structure

- `electron/` — Electron main and preload
- `src/` — React app
  - `src/components/` — UI: Breadboard, Sidebar, Toolbar, PropertiesPanel, Oscilloscope
  - `src/data/` — Component definitions, breadboard model, chip loader
  - `src/engine/` — MNA solver, CircuitSimulator, AVR bridge, PCB export
  - `src/hooks/` — Undo/redo history
- `chips/` — Custom chip definition JSON files
- `dist/` — Build output

## Roadmap

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for the full roadmap.
