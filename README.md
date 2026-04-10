# E101 Electronics Simulator

A desktop electronics circuit simulator built with React, TypeScript, and Electron. Build circuits on a realistic breadboard, wire components together, and run analog simulations — including real AVR microcontroller code.

## Getting started

```bash
npm install
npm run electron-dev
```

## Features

- Realistic dual-breadboard with internal wiring (power rails, 5-pin strips, center gap)
- 15+ component types: resistors, capacitors, LEDs, switches (toggle and momentary pushbutton), ICs, op-amps, 7-segment displays, 5x7 LED matrix, function generator
- Logic gates: AND (7408), OR (7432), NAND (7400), NOT (7404)
- 555 Timer, CD4026 counter, 74HC595 shift register, 74HC74 D flip-flop, 7805 voltage regulator
- ATmega328P (Arduino Uno) with real AVR code execution via avr8js
- Arduino sketch editor with arduino-cli compilation
- Modified Nodal Analysis (MNA) analog simulation engine
- Oscilloscope with multi-channel voltage probing
- In-app Claude AI assistant that can build circuits directly on the board via tool use
- AI can create new component types on the fly (sensors, tubes, relays, etc.)
- Auto-model selection (Haiku/Sonnet/Opus) based on task complexity
- Undo/redo, copy/paste, multi-select, component rotation
- Save/open circuits as `.ecx` files with automatic autosave/restore
- KiCad netlist and BOM export for PCB layout
- PCB layout preview with auto-routing
- Custom chip definitions via JSON files (including AI-created components)
- Configurable simulation speed (0.25x to 10x)
- Zoom and pan with mousewheel and Ctrl+click
- 5 built-in demo circuits: LED Blink, Counter, AVR Blink, 5x7 Matrix, Necklace

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
  - `src/components/` — UI: Breadboard, Sidebar, Toolbar, PropertiesPanel, Oscilloscope, ChatPanel, SketchEditor, PCBView
  - `src/data/` — Component definitions, breadboard model, chip loader
  - `src/engine/` — MNA solver, CircuitSimulator, AVR bridge, PCB export
  - `src/hooks/` — Undo/redo history
- `chips/` — Custom chip definition JSON files
- `dist/` — Build output

## Roadmap

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for the full roadmap.
