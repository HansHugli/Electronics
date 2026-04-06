# E101 Electronics Simulator

A desktop electronics circuit simulator built with React, TypeScript, and Electron.

## Goals

- Enable users to build and simulate electronics circuits using visual components.
- Support breadboard-style wiring, digital and analog components, and exportable designs.
- Provide a modern desktop experience with settings, file storage, and local persistence.

## What's included

- React + TypeScript renderer app under `src/`
- Electron main/preload process under `electron/`
- Vite bundler for fast development and builds
- Electron Builder packaging config for Mac and Windows
- Project plan and feature list in `PROJECT_PLAN.md`

## Getting started

Install dependencies:

```bash
npm install
```

Run the full Electron desktop app in development:

```bash
npm run electron-dev
```

Build the app for release:

```bash
npm run build
```

Package the app:

```bash
npm run package:win
npm run package:mac
```

## Project structure

- `electron/` — Electron main and preload code
- `public/` — Static assets and icons
- `src/` — React app
  - `src/components/` — UI components (Breadboard, Sidebar, Toolbar, PropertiesPanel)
  - `src/data/` — Component definitions
  - `src/engine/` — Circuit simulation engine
- `dist/` — Build output

## Features (Phase 1)

- Breadboard canvas with power supply area and grid
- Component palette: DC/AC Power, Resistor, Capacitor, Switch, 555 Timer, LED
- Drag-and-drop component placement
- Orthogonal wire routing with rounded corners and obstacle avoidance
- Click pins to draw wires with live preview
- Component selection, property editing, and deletion (Del key)
- Wire selection and deletion
- 555 Timer with full 8-pin DIP pinout
- DC/AC power supply with configurable voltage and waveform
- Circuit simulation with LED blink demo
- Save/Open circuits as `.ecx` files via native dialogs
- Keyboard shortcuts (Ctrl+S, Ctrl+O, Delete, Escape)

For the full roadmap, see `PROJECT_PLAN.md`.
