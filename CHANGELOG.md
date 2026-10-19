# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.2.0](https://github.com/HansHugli/Electronics/compare/v0.1.16...v0.2.0) (2026-10-19)


### Features

* **ai:** pricing, model choice, history, tool schemas and tool validation ([45ff40d](https://github.com/HansHugli/Electronics/commit/45ff40dd63224bbc6d4a8522da04228cafd72ceb))
* **data:** direct Save to the current file, Save As, New, corrupt autosave copy ([98957f8](https://github.com/HansHugli/Electronics/commit/98957f889e130c0205e9ba487ee9df8a521c995a))
* **engine:** sub-stepped nonlinear solver with settling logic and MCU replay ([9a11ca7](https://github.com/HansHugli/Electronics/commit/9a11ca7ea5163c4da09be1de3620111bf223fbd2))
* **engine:** tie sim time to wall-clock time with useSimulationLoop ([901bd9e](https://github.com/HansHugli/Electronics/commit/901bd9e1dc62aa8d137b6ea89f22d22f7febe6d9))
* **ui:** one modal stack with in-app dialogs and Escape ([e4740bc](https://github.com/HansHugli/Electronics/commit/e4740bcc7f65e9f5ad94acd0d82452e0211c349b))


### Bug Fixes

* **ai:** validate every tool call, one undo step per batch, Stop button ([16e61c1](https://github.com/HansHugli/Electronics/commit/16e61c1359b3ef77928ae98d4b724996fc8efa64))
* connect the engine, UI and AI branches ([8cb0fef](https://github.com/HansHugli/Electronics/commit/8cb0fef01a19869aeeaff25da9d8b45bd814b214))
* **data:** config store that never overwrites a damaged file, OneDrive detection ([4d40d3a](https://github.com/HansHugli/Electronics/commit/4d40d3a78d4e2280fa26dcf3b667d81fdd440e14))
* **data:** real breadboard rails, real DIP pinouts, validated custom chips ([501c908](https://github.com/HansHugli/Electronics/commit/501c90847cbeba7663a167c0b3d8cc55ea451f19))
* **data:** validate circuit files and track unsaved changes in history ([2b7e22d](https://github.com/HansHugli/Electronics/commit/2b7e22dfab74c38d13f39b98727b1bdc5bb192bc))
* **engine:** rewire the demo circuits for real pinouts and full rails ([1ceb4ba](https://github.com/HansHugli/Electronics/commit/1ceb4ba706965f344b27b211539a8d0e811da870))
* **engine:** validate HEX files, ADC in volts, clock speed, reset, serial in ([75caf1c](https://github.com/HansHugli/Electronics/commit/75caf1c95cf209f090d00847a4b4a05ec29fbf1d))
* **format:** show small values, round at prefix boundaries, add parseSI ([cce432b](https://github.com/HansHugli/Electronics/commit/cce432b190544b9ab123176888b9280b67351fea))
* **security:** lock down the window and IPC; safe data handling in main ([7dc2749](https://github.com/HansHugli/Electronics/commit/7dc2749e7fdb16537eb3d030be2d387c77922336))
* **security:** verified arduino-cli download, path guards and a CSP ([a4ed7c4](https://github.com/HansHugli/Electronics/commit/a4ed7c4769ec4febec9b86dc5484eeb52f669bb1))
* **ui:** an AI batch is one Undo step ([c70259d](https://github.com/HansHugli/Electronics/commit/c70259dd3bcd72478c6a745d942db076b6b9cc4e))
* **ui:** exact mouse mapping, drags that always finish, fit and zoom ([13934cd](https://github.com/HansHugli/Electronics/commit/13934cd53338f512d461fa16fed610453b59fb97))
* **ui:** reachable toolbar, safe loads, close guard and readable chrome ([9b9f067](https://github.com/HansHugli/Electronics/commit/9b9f06726bb2fbed572a460c600441cdefbd1b8a))
* **ui:** SI value entry, warnings and flip polarity in the properties panel ([9763625](https://github.com/HansHugli/Electronics/commit/9763625fc82f88cc03c435d31d6ff11979502001))


### Documentation

* describe the reviewed app: rails, chips, clock, warnings, AI and data safety ([ae1d99c](https://github.com/HansHugli/Electronics/commit/ae1d99c95ce42828020127dd7d2b1703ce263330))
* point Claude sessions at Synora for E101's rules and design notes ([eba12d4](https://github.com/HansHugli/Electronics/commit/eba12d400b63c3d088eb73f2e3903a13bb1b59ed))


### Build System

* add vitest for engine and logic tests ([7e77ea4](https://github.com/HansHugli/Electronics/commit/7e77ea4832d1c1680475f2d3fdb4f401a0340b76))

## [0.1.16](https://github.com/HansHugli/Electronics/compare/v0.1.15...v0.1.16) (2026-04-10)


### Features

* API usage tracking dashboard with chart.js and fix keyboard shortcut leak ([017be3e](https://github.com/HansHugli/Electronics/commit/017be3e40e50b58dddad0157188a443b6158e2cf))

## [0.1.15](https://github.com/HansHugli/Electronics/compare/v0.1.14...v0.1.15) (2026-04-10)


### Features

* click-to-place, pin-aware grid snapping, component type management, and placement fixes ([64f018c](https://github.com/HansHugli/Electronics/commit/64f018cf0fe26890d8bbaa0e35e8c4a323e394e7))

## [0.1.14](https://github.com/HansHugli/Electronics/compare/v0.1.13...v0.1.14) (2026-04-10)


### Features

* AI circuit builder with tool use, auto-model selection, and autosave ([ad39344](https://github.com/HansHugli/Electronics/commit/ad393443453124aee6adce6eb7bdc34615e244f5))

## [0.1.13](https://github.com/HansHugli/Electronics/compare/v0.1.12...v0.1.13) (2026-04-08)


### Features

* in-app Claude chat panel with circuit-aware context ([c6fa7a9](https://github.com/HansHugli/Electronics/commit/c6fa7a9ddab6b0de4d949db9f75b25f720c7926c))

## [0.1.12](https://github.com/HansHugli/Electronics/compare/v0.1.11...v0.1.12) (2026-04-08)


### Features

* momentary pushbuttons and necklace demo polish ([14a5387](https://github.com/HansHugli/Electronics/commit/14a53877447d253692a9ae58c21aff9f6129d836))

## [0.1.11](https://github.com/HansHugli/Electronics/compare/v0.1.10...v0.1.11) (2026-04-08)


### Features

* necklace demo circuit with direct-AVR LED matrix support ([8b934ec](https://github.com/HansHugli/Electronics/commit/8b934ec0f417880b6477fd3b603e720712d947d3))

## [0.1.10](https://github.com/HansHugli/Electronics/compare/v0.1.9...v0.1.10) (2026-04-08)


### Features

* accurate multiplexed LED matrix rendering and sketch file workflow ([303b4a7](https://github.com/HansHugli/Electronics/commit/303b4a7c5c92f8a1d1477a56f8102e2a5c560626))

## [0.1.9](https://github.com/HansHugli/Electronics/compare/v0.1.8...v0.1.9) (2026-04-07)


### Features

* working 5x7 matrix demo, PCB auto-routing, sketch editor polish ([609c837](https://github.com/HansHugli/Electronics/commit/609c837dbdec2d2a8d934111470add10fe7c6a3c))

## [0.1.8](https://github.com/HansHugli/Electronics/compare/v0.1.7...v0.1.8) (2026-04-07)


### Features

* complete multi-select/group operations and update docs ([8fa4889](https://github.com/HansHugli/Electronics/commit/8fa48897935fe860cd83cddaa034cfc15bc3961f))

## [0.1.7](https://github.com/HansHugli/Electronics/compare/v0.1.6...v0.1.7) (2026-04-07)

## [0.1.6](https://github.com/HansHugli/Electronics/compare/v0.1.5...v0.1.6) (2026-04-06)


### Features

* fix 555 astable topology, add AVR blink demo, and UX polish ([57d15c2](https://github.com/HansHugli/Electronics/commit/57d15c289a744a8e7e202aef328361bdd5fd8561))

## [0.1.5](https://github.com/HansHugli/Electronics/compare/v0.1.4...v0.1.5) (2026-04-06)


### Features

* app polish, new components, Arduino sketch editor, and simulation accuracy ([dad73ea](https://github.com/HansHugli/Electronics/commit/dad73ea7e6c656bb9b3eeb224d79cfd01d9e60ab))

## [0.1.4](https://github.com/HansHugli/Electronics/compare/v0.1.3...v0.1.4) (2026-04-06)


### Bug Fixes

* correct build order and move electron to devDependencies ([6c1868f](https://github.com/HansHugli/Electronics/commit/6c1868fd82488146b956adf6f65d4d4c3e1be5ad))
* packaged app loads local HTML instead of localhost ([5c45b08](https://github.com/HansHugli/Electronics/commit/5c45b08515257a593d837ab68272cfe9b8c09583))
* use relative asset paths for Electron file:// protocol ([1544cf1](https://github.com/HansHugli/Electronics/commit/1544cf1d434126c240312bb8d08a0279334054df))

## [0.1.3](https://github.com/HansHugli/Electronics/compare/v0.1.2...v0.1.3) (2026-04-06)


### Features

* UX polish, new ICs, oscilloscope, PCB export, and AVR simulation ([38ae63e](https://github.com/HansHugli/Electronics/commit/38ae63e7c8e939dda6c2e13f31736f1e1509e129))

## [0.1.2](https://github.com/HansHugli/Electronics/compare/v0.1.1...v0.1.2) (2026-04-06)


### Features

* analog simulation engine with MNA solver and real 555 astable circuit ([d0a8b0e](https://github.com/HansHugli/Electronics/commit/d0a8b0e58f042fe0dfd0b97b8780db1a46de3310))

## [0.1.1](https://github.com/HansHugli/Electronics/compare/v0.1.0...v0.1.1) (2026-04-06)


### Features

* realistic breadboard with pin holes, dual boards, component redesign, and zoom/pan ([3ebe385](https://github.com/HansHugli/Electronics/commit/3ebe3859cc1f6b5c96216aceac77a892f3130b9b))

## 0.1.0 (2026-04-06)


### Features

* Phase 1 — circuit simulator with breadboard, components, wiring, and simulation 38e3208
