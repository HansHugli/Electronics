# E101 Project Plan

## Vision

Build a desktop electronics circuit simulation app that lets users design, wire, and test circuits visually using a component-based editor.

## Core Objectives

1. Visual circuit building with drag-and-drop component placement
2. Real-time simulation of basic electrical behavior
3. Desktop persistence with configurable storage paths
4. Expandable component library for analog, digital, and programmable parts

## Phase 1 — Foundation (Complete)

- [x] Scaffold React 18 + TypeScript + Electron 28 + Vite app
- [x] Create initial renderer UI and Electron shell
- [x] Implement breadboard editor with component palette sidebar
- [x] Build LED blink demo circuit (555 astable)
- [x] Add local storage configuration (OneDrive-aware, configurable path)
- [x] Project save/load (.ecx files) with Ctrl+S / Ctrl+O
- [x] Undo/redo with 50-entry snapshot stack
- [x] electron-builder packaging for Windows and Mac

## Phase 2 — Core Components (Complete)

### Passive Components
- [x] Resistor (1x2) — configurable resistance, engineering notation display (47kΩ)
- [x] Capacitor (1x1) — configurable capacitance, backward Euler companion model
- [x] Potentiometer (1x2) — adjustable position slider, two-resistor model
- [x] Switch (1x1) — click to toggle, union-find merge when closed

### Power & Measurement
- [x] Power supply — DC and AC modes, sine/square waveforms, configurable voltage
- [x] Multimeter (2x2) — voltage and current measurement modes

### Output
- [x] LED (1x1) — configurable color, brightness from current, second-pass MNA re-solve
- [x] 7-Segment Display (2x5) — driven by segment pins (a-g)
- [x] 5x7 LED Matrix (2x7) — 5 column anodes x 7 row cathodes

### Active / Chips
- [x] 555 Timer (2x4) — behavioral model with threshold comparators, astable/monostable
- [x] CD4026 Counter (2x8) — decade counter with 7-segment outputs, edge detection
- [x] 7408 AND Gate (2x7) — quad 2-input AND, 14-pin DIP
- [x] 7432 OR Gate (2x7) — quad 2-input OR
- [x] 7400 NAND Gate (2x7) — quad 2-input NAND
- [x] 7404 NOT Gate (2x7) — hex inverter
- [x] LM741 Op-Amp (2x4) — configurable gain, rail-to-rail saturation
- [x] Shift Register 74HC595 (2x8) — serial-in parallel-out with latch
- [x] D Flip-Flop 74HC74 (2x7) — dual edge-triggered with preset/clear
- [x] Voltage Regulator 7805 (1x3) — clamped output model
- [x] Function Generator (2x3) — sine, square, triangle, sawtooth waveforms

### Programmable
- [x] ATmega328P (2x14) — full DIP-28 pinout, avr8js CPU emulation
- [x] GPIO, Timer0/1/2, USART, SPI, TWI, ADC peripheral support
- [x] Hex file loading from Arduino IDE exports
- [x] Inline Intel HEX parser (no Node.js Buffer dependency)
- [x] Arduino sketch editor with arduino-cli compilation

### Simulation Engine
- [x] Modified Nodal Analysis (MNA) with Gaussian elimination solver
- [x] Union-Find for breadboard strip/rail group merging
- [x] Backward Euler capacitor companion model
- [x] Sub-stepping for simulation accuracy (configurable 1-10x)
- [x] Pre-LED voltage saving to prevent re-solve corruption
- [x] Adjustable simulation speed (0.25x to 10x)

## Phase 3 — Advanced Features (In Progress)

### Export & Integration
- [x] PCB layout preview (auto-layout with Union-Find net building)
- [x] KiCad netlist export (.net)
- [x] Bill of Materials export (.csv)
- [x] Custom chip definitions via JSON files in chips/ directory
- [x] Serial monitor for AVR UART output

### UX Polish
- [x] Smart orthogonal wire routing with collision avoidance
- [x] Cursor-centered zoom (0.3x-10x) and Ctrl+click pan
- [x] Copy/paste components (Ctrl+C / Ctrl+V) with overlap detection
- [x] Engineering value formatting (47kΩ, 100μF, 15mA)
- [x] Simulation readout pills with formatted voltage/current
- [x] Properties panel formatted value hints
- [x] Right-click context menu (Rotate, Copy, Delete)
- [x] Sidebar description tooltips
- [x] Wire properties panel (ID, from/to endpoints, color)
- [x] Pin hole coordinate display on hover (with voltage during sim)
- [x] Breadboard strip highlighting on pin hover
- [x] Current flow direction arrows on wires during simulation

### App Chrome
- [x] Electron app menu (File, Edit, View with DevTools, Help)
- [x] Circuit name in titlebar
- [x] About dialog with version and pioneer quotes
- [x] Settings dialog for data path
- [x] Oscilloscope with up to 6 simultaneous probes

### Demo Circuits
- [x] LED Blink — 555 astable (Ra=47k, Rb=68k, C=47μF)
- [x] 7-Seg Counter — 555 astable → CD4026 → 7-segment display
- [x] AVR Blink — ATmega328P with pre-loaded hand-assembled hex (pin 13 LED)

### Remaining
- [ ] PCB layout improvements (trace overlap, better auto-placement)
- [x] Multi-select and group operations
- [ ] Wire routing refinements
- [ ] Arduino sketch editor compile workflow polish

## Technical Stack

- **Frontend:** React 18 + TypeScript
- **Desktop:** Electron 28
- **Bundler:** Vite
- **Packaging:** electron-builder
- **Versioning:** commit-and-tag-version (conventional commits)
- **AVR Emulation:** avr8js
- **Arduino CLI:** arduino-cli (bundled binary)
