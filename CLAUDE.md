# E101

Build electronics circuits out of visual components and run them in a simulation

## Tech Stack

- **Languaage** Always use TypeScript for any JavaScript-based code
- **Frontend:** React 18 with TypeScript
- **Desktop:** Electron 28
- **Packaging:** electron-builder (builds for Mac and Windows)
- **Versioning:** standard-version (conventional commits)

## Project Structure

- `src/` — React app (TypeScript): components, hooks, types
- `electron/` — Electron main/preload (currently JS)
- `public/` — Static assets and icons
- `dist/` — Build output (not committed)

## Development

- `npm run electron:dev` — Run in dev mode (React + Electron concurrently)
- `npm run package:mac` / `npm run package:win` — Package for platform
- `npm run ship` — Full release flow (build, package, version bump, push)

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
