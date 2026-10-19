# E101

Build electronics circuits out of visual components and run them in a simulation

## Synora first

How to work on this project (rules, design notes, checks, gaps and lessons) lives in **Synora** (the `synora` MCP server), shared by every machine and session. Private Claude memory holds only a pointer.

- **Before any work:** call `synora_rules_for` with project `electronics` and follow what it returns: "Skill: work on Electronics (E101)" (the breadboard wiring model, the pin-label rule, the deferred sim-clock TODO, build and release) and the studio rules and skills. Call it again in a long session, because rules and skills change while you work.
- **Accuracy matters:** learners trust what the simulator shows. Check behaviour against physics and datasheets, and add a test for every engine fix.
- **Never spend or expose the API key:** don't send real messages through the in-app Claude chat while testing, and never copy the key into an entry, message, log or screenshot.
- **Write what you learn back:** append fixes, gaps and lessons to the skill (`synora_append`), and record decisions and plans as entries in project `electronics`.
- **Show, don't just tell:** attach screenshots of circuits with `synora_attach`, and draw signal flows and state machines in Mermaid.
- **Taking a feature from another simulator or a real part:** follow "Skill: REA, Reverse Engineer Anything".

## Tech Stack

- **Languaage** Always use TypeScript for any JavaScript-based code
- **Frontend:** React 18 with TypeScript
- **Desktop:** Electron 28
- **Packaging:** electron-builder (builds for Mac and Windows)
- **Versioning:** commit-and-tag-version (conventional commits)

## Project Structure

- `src/` — React app (TypeScript): components, hooks, types
- `electron/` — Electron main, preload, Claude chat and arduino-cli (TypeScript, built with `tsconfig.electron.json`)
- `public/` — Static assets and icons
- `dist/` — Build output (not committed)

## Development

- `npm run electron:dev` — Run in dev mode (React + Electron concurrently)
- `npm run package:mac` / `npm run package:win` — Package for platform
- `npm run ship` — Release flow (version bump, build, push); run `npm run package:win` for the installer

## Data Storage

  - **Default location (configurable via Settings):**
  - New installs with OneDrive: `<OneDrive>/e101/e101.json`
  - Fallback (no OneDrive): `<Electron userData>/e101.json`
  - macOS OneDrive path: `~/Library/CloudStorage/OneDrive-Personal/e101/`
  - Windows OneDrive path: `%USERPROFILE%\OneDrive\Documents\e101\`
- **Config file:** `<Electron userData>/e101-config.json` — stores `dataFilePath` (never moves)
- **Settings dialog:** Accessible from the sidebar; allows browsing/changing the data file folder and optionally moving the existing file

## App Component Types

- Resistors
- Capacitors
- Switches
- Multi-Voltage power sources (DC, AC)
- Capacitors
- Potentiometers
- Chips (Analog and Logical) with pins out and pins in
- Consider the possibilty for adding Arduino input for some logic operations
- LED single color and multicolored for output
- Digital Screen for display
- Add ability to easily add new components such as a GPS, Bluetooth, Accelerometer, etc.

## Other Features

- Ability to use a Bread board or Virtual Connections
- Ability to Generate PCBs schematics

## Initial Goal
- Wire up a bread border to flash an LED on an off every 2 seconds
- 
