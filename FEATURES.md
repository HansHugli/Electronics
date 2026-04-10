# E101 Features Guide

## Getting Started

Launch the app and you'll see:
- **Left sidebar** — component palette organized by category
- **Center** — breadboard canvas with power supply area
- **Right panel** — properties for the selected component or wire
- **Top toolbar** — file operations, undo/redo, demos, export, and simulation controls
- **Bottom** — oscilloscope (click "Scope" to expand)

## Breadboard

The breadboard models real hardware:
- **Power rails** (outer columns) — grouped in 2x5 blocks, each block is internally connected
- **Component strips** (inner columns) — 5 pins per row, connected horizontally
- **Center gap** — breaks horizontal connections, DIP chips straddle it
- **Two boards** side by side for larger circuits

Hover any pin hole to see its connected strip highlighted in yellow.

## Components

### Power
- **Power Supply** — drop onto the supply area (left of board). A dialog lets you choose DC/AC, voltage, and waveform (square/sine).

### Passive
- **Resistor** (1x2) — configurable resistance in ohms
- **Capacitor** (1x1) — configurable capacitance in microfarads
- **Potentiometer** (1x2) — adjustable position slider in properties panel

### Input
- **Switch** (1x1) — click to toggle between 0 (open) and 1 (closed). Supports a **momentary** mode (pushbutton) — closed only while held/clicked.

### Output
- **LED** (1x1) — configurable color, glows during simulation based on current
- **7-Segment Display** (2x5) — driven by segment pins (a-g)

### Chips
- **555 Timer** (2x4) — full 8-pin DIP, behavioral model with threshold comparators
- **CD4026 Counter** (2x8) — decade counter with 7-segment outputs
- **7408 AND Gate** (2x7) — quad 2-input AND, 14-pin DIP
- **7432 OR Gate** (2x7) — quad 2-input OR
- **7400 NAND Gate** (2x7) — quad 2-input NAND
- **7404 NOT Gate** (2x7) — hex inverter
- **LM741 Op-Amp** (2x4) — configurable open-loop gain, rail-to-rail saturation
- **5x7 LED Matrix** (2x7) — 5 column anodes x 7 row cathodes, configurable color
- **ATmega328P** (2x14) — Arduino Uno MCU, full DIP-28 pinout (see AVR section below)

### Measurement
- **Multimeter** (2x2) — voltage or current mode, displays reading during simulation

## Placing Components

1. Click a component in the sidebar to place it on the breadboard — it appears at the first available position, ready to drag to its final location
2. Components snap to the grid so pins align with breadboard holes
3. DIP chips are automatically positioned to straddle the center gap
4. Components cannot overlap — the placement is rejected if it would collide
5. Any component type can be deleted from the sidebar with the **x** button (with confirmation)

## Wiring

1. Click any pin (component or breadboard hole) to start a wire
2. Move the mouse to see a preview
3. Click another pin to complete the connection
4. Press **Escape** to cancel
5. Wires route orthogonally with rounded corners and avoid crossing components

## Selection and Editing

- **Click** a component to select it — properties appear in the right panel
- **Ctrl+Click** a component to add/remove it from the current selection
- **Drag** any selected component to move the whole selected group together
- **Click** a wire to select it — color picker appears
- **Delete/Backspace** — delete the selected component(s) or wire
- **R** — rotate the selected component 90 degrees (only when a single component is selected)
- **Escape** — deselect everything and cancel wiring

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+S | Save circuit |
| Ctrl+O | Open circuit |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |
| Ctrl+C | Copy selected component |
| Ctrl+V | Paste component |
| Delete | Delete selected |
| R | Rotate selected |
| Escape | Cancel / deselect |
| Mousewheel | Zoom in/out |
| Ctrl+Click | Add/remove component to/from selection |
| Drag selected components | Move grouped selection |
| Ctrl+Click drag (empty board) | Pan the view |

## Simulation

1. Build your circuit with power, components, and wires
2. Set the speed using the dropdown (0.25x to 10x)
3. Click **Run** to start the simulation
4. Voltage/current readouts appear below passive components
5. LEDs glow, 7-segment displays update, counters count
6. Click **Stop** to reset

### Run-Mode Display

When the simulation is running, chip part numbers, pin numbers, and pin labels are hidden across the breadboard so the visual focus is on the live state of LEDs, displays, and indicators. Stop the simulation to bring the labels back for editing.

### Oscilloscope

1. Select a component and click **Probe** in the properties panel
2. Click **Scope** at the bottom to expand the oscilloscope
3. Voltage traces appear in real time during simulation
4. Add up to 6 simultaneous probes
5. Remove traces with the "x" button on each tag

## AVR / Arduino Simulation

The ATmega328P component runs real AVR machine code in the browser using avr8js.

### How to use

1. Drag the **328P** chip from the sidebar onto the breadboard
2. Wire **VCC** (pin 7) and **GND** (pin 8) to power
3. Wire output pins (D0-D13, A0-A5) to LEDs, resistors, etc.
4. Select the chip and click **Load .hex** in the properties panel
5. Load a compiled Arduino sketch (.hex file from Arduino IDE)
6. Click **Run** — the AVR executes your code at 16 MHz

### Getting a .hex file

In Arduino IDE:
1. Go to **Sketch > Export Compiled Binary**
2. Find the `.hex` file in the sketch folder
3. Load it into E101

### Pin mapping

| Arduino Pin | ATmega328 Pin | Port |
|------------|---------------|------|
| D0-D7 | PD0-PD7 | PORTD |
| D8-D13 | PB0-PB5 | PORTB |
| A0-A5 | PC0-PC5 | PORTC |
| D13 (LED) | PB5 | Built-in LED |

### Supported peripherals

- GPIO (digital read/write)
- Timer0, Timer1, Timer2 (delay, millis, PWM)
- Input pull-up resistors

### Driving sequential digital chips at high speeds

When the AVR bit-bangs a sequential digital chip such as the 74HC595 shift register or 74HC74 D flip-flop, the simulator captures every GPIO transition with its CPU cycle and replays them through the chip's edge logic before the analog matrix is solved. That means the AVR can clock data through a shift register at microsecond timescales even though the outer simulator runs at 100 ms ticks — the chip sees every edge, not just the once-per-tick snapshot.

## Save / Open

- **Save** (Ctrl+S) — saves as `.ecx` file via native dialog
- **Open** (Ctrl+O) — opens an `.ecx` file
- Circuits store all components, wires, and properties
- **Autosave** — circuit state is automatically saved on every change and restored on app launch

## Export

- **PCB** button — exports a KiCad netlist (`.net`) for PCB layout
- **BOM** button — exports a Bill of Materials (`.csv`)

## Custom Chip Definitions

You can add new chip types by placing JSON files in the `chips/` directory next to your data folder.

### Format

```json
{
  "type": "74hc595",
  "label": "HC595",
  "package": "DIP-16",
  "category": "active",
  "behavior": "passthrough",
  "color": "#4a4a4a",
  "pins": [
    { "number": 1, "id": "qb", "label": "QB", "side": "left", "offset": 0.9375, "type": "output" }
  ],
  "properties": {}
}
```

- **package** — DIP-8 through DIP-40 (auto-calculates dimensions)
- **behavior** — references a built-in simulation model: `logic_and`, `logic_or`, `timer555`, `counter`, `opamp`, `passthrough`
- **passthrough** — renders the chip visually but does not simulate

See `chips/example-shift-register.json` for a complete example.

## Claude AI Chat Panel

The app includes a built-in AI assistant powered by Claude that can understand, build, and modify your circuits.

### Setup

1. Open **Settings** and add your Anthropic API key
2. The chat panel appears on the right side of the app

### Capabilities

- **Ask questions** — "what does this circuit do?", "why isn't my LED lighting up?"
- **Build circuits** — "build me a 555 blink circuit" or "create a Geiger counter" — Claude places components and wires them directly on the board
- **Create new components** — if a component doesn't exist in the catalog (e.g. a Geiger-Muller tube, a relay, a sensor), Claude invents it with the correct pins and places it on the board. AI-created components persist across app restarts and appear in the sidebar like any other component.
- **Modify circuits** — "add a second 7-segment display" or "remove the capacitor"
- **Delete component types** — Claude can remove custom component types, or you can delete any component type from the sidebar

### Settings (bottom of chat panel)

- **Model** — choose between Auto, Opus 4.6, Sonnet 4.6, or Haiku 4.5
- **Auto mode** — dynamically selects the best model based on task complexity (Haiku for simple questions, Sonnet for general use, Opus for circuit building and debugging)
- **Circuit context** — controls whether Claude can see your current circuit: on-change (recommended), always, or never

### Processing Indicators

While Claude is working, status messages show what's happening:
- "Thinking..." — processing your request
- "Building circuit..." — placing components and wires
- "Creating new component..." — inventing a new component type
- "Modifying circuit..." — changing the existing circuit

Responses render as formatted markdown with code blocks, tables, and lists.

## Autosave

Your circuit is automatically saved every time you make a change. When you reopen the app, your last circuit is restored exactly as you left it — no manual save required. Autosave works alongside the manual Save/Open workflow.

## Demos

- **Blink** — 555 astable circuit driving an LED (Ra=47k, Rb=68k, C=47uF)
- **Counter** — 555 astable driving a CD4026 decade counter into a 7-segment display
- **AVR Blink** — ATmega328P running a pre-loaded Arduino Blink sketch (pin 13 LED toggle with ~1s delay)
- **5x7 Matrix** — ATmega328P bit-banging a 74HC595 shift register to multiplex three animated patterns (heart, square, X) on a 5x7 LED matrix. Demonstrates AVR-driven sequential digital edge replay and the matrix renderer's sliding-window aggregation that reconstructs row-multiplexed scans into a steady image.
- **Necklace** — Direct-AVR-driven 5x7 LED matrix with scrolling text animation, demonstrating the ATmega328P driving a matrix without external shift registers.
