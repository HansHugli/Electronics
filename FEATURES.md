# E101 Features Guide

## Getting Started

Launch the app and you'll see:
- **Left sidebar** — component palette organized by category
- **Center** — breadboard canvas with power supply area
- **Right panel** — properties for the selected component or wire
- **Top toolbar** — Run/Stop with the simulation clock, speed and accuracy, undo/redo, New/Open/Save/Save As, the **Examples** and **Export** menus, and Clear. It wraps onto a second row in small windows, so every button stays reachable. A dot after the circuit name means unsaved changes.
- **Bottom** — oscilloscope (click "Scope" to expand)

## Breadboard

The breadboard models real hardware:
- **Power rails** (outer columns) — each rail runs the full length of its side, like a real breadboard: power the + rail anywhere and every hole in that column is connected. The spacing between groups of five holes is only a visual guide.
- **Power terminals** connect to nothing until you wire them to a rail or a strip
- **Component strips** (inner columns) — 5 pins per row, connected horizontally
- **Center gap** — breaks horizontal connections, DIP chips straddle it
- **Two boards** side by side for larger circuits

Hover any pin hole to see its connected strip highlighted in yellow.

## Components

### Power
- **Power Supply** — drop onto the supply area (left of board). A dialog lets you choose DC or AC and the voltage; for AC, also the frequency and the waveform (sine/square). It has a small internal resistance and a 1 A current limit, and warns you about a short circuit.
- **Function Generator** — sine, square, triangle or sawtooth at an adjustable frequency. Its GND terminal is the circuit ground when there is no Power Supply.
- **Voltage Regulator (7805)** — outputs 5 V as long as its input is at least 2 V higher; below that, the output follows the input minus the dropout.

### Passive
- **Resistor** (1x2) — configurable resistance; its colour bands show the value
- **Capacitor** (1x1) — configurable capacitance (a plain number is in microfarads)
- **Potentiometer** (1x2) — adjustable position slider in properties panel

Values can be typed with SI prefixes or resistor codes: `220`, `4.7k`, `4k7`, `1M`, `100n`, `2.2u`. A value is committed when you press Enter or leave the field, and an invalid or empty value is rejected instead of becoming 0.

### Input
- **Switch** (1x1) — click to toggle between 0 (open) and 1 (closed). Supports a **momentary** mode (pushbutton) — closed only while held/clicked.

### Output
- **LED** (1x1) — configurable colour; its forward voltage follows the colour (red about 2 V, blue and white about 3.2 V), and it glows in proportion to its current. The flat side marks the cathode; **Flip polarity** in the properties panel turns it round.
- **7-Segment Display** (2x5) — common cathode; each segment is a real LED, so it needs current-limiting resistors

### Chips
- **555 Timer** (2x4) — full 8-pin DIP with threshold comparators, RESET and CONTROL; timing follows the datasheet formulas
- **CD4026 Counter** (2x8) — decade counter with 7-segment outputs, carry out, display enable and reset, pinned out as in the datasheet
- **AND Gate (74HC08)** (2x7) — quad 2-input AND, 14-pin DIP
- **OR Gate (74HC32)** (2x7) — quad 2-input OR
- **NAND Gate (74HC00)** (2x7) — quad 2-input NAND
- **NOT Gate (74HC04)** (2x7) — hex inverter
- **Shift Register (74HC595)** and **D Flip-Flop (74HC74)**
- **Op-Amp (LM741)** (2x4) — solved together with the rest of the circuit, so feedback amplifiers give the right gain; the output stops about 1.25 V short of each supply rail

All chips are pinned out like the real parts: pin 1 is at the top left by the notch, and the numbers run down the left side and back up the right. Every chip needs its VCC and GND wired, or it does nothing and says so. The logic chips behave as 74HC CMOS: an input reads LOW below 0.3 × VCC and HIGH above 0.7 × VCC, and an unconnected input gets a warning. Outputs have realistic drive limits, so an LED straight from an output without a resistor is flagged.
- **5x7 LED Matrix** (2x7) — 5 column anodes x 7 row cathodes, configurable color
- **ATmega328P** (2x14) — Arduino Uno MCU, full DIP-28 pinout (see AVR section below)

### Measurement
- **Multimeter** (2x2) — voltage mode (high resistance, connect it across a part) or current mode (low resistance, connect it in series), displays reading during simulation

## Placing Components

1. Click a component in the sidebar to place it at the first free position, or drag it from the sidebar onto the board
2. Components snap to the grid so pins align with breadboard holes
3. DIP chips are automatically positioned to straddle the center gap
4. Components cannot overlap — the placement is rejected if it would collide
5. Custom and AI-created component types can be deleted from the sidebar with the **x** button, after you confirm; built-in parts can't be deleted

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
- **Escape** — close the topmost dialog, or deselect everything and cancel wiring
- Shortcuts don't fire while you type in a field or while a dialog is open, so Ctrl+Z in a text box undoes the text, not the circuit

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+N | New circuit |
| Ctrl+S | Save circuit (to its current file) |
| Ctrl+Shift+S | Save As |
| Ctrl+O | Open circuit |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |
| Ctrl+C | Copy selected component |
| Ctrl+V | Paste component |
| Delete | Delete selected |
| R | Rotate selected |
| Escape | Cancel / deselect |
| Mousewheel | Zoom in/out at the cursor |
| + / − / 0 / F | Zoom in, zoom out, 100%, fit the circuit |
| Ctrl+Click | Add/remove component to/from selection |
| Drag selected components | Move grouped selection |
| Drag the empty board | Pan the view |

The zoom buttons at the bottom right of the board do the same: − / + / 100% / Fit (the circuit) / Board (the whole breadboard). A circuit is fitted to the view when it's loaded.

## Simulation

1. Build your circuit with power, components, and wires
2. Set the speed using the dropdown (0.25x to 10x)
3. Click **Run** to start the simulation
4. Voltage/current readouts appear below passive components. A voltage across a part is signed: it is negative when its second pin is the higher one.
5. LEDs glow, 7-segment displays update, counters count
6. Click **Stop** to reset

### Simulation clock

Simulated time follows real time multiplied by the speed: at 1x, one second on the clock (`t = …` next to Run) is one second of circuit time, on any PC. If the computer can't keep up with the chosen speed, the toolbar says so and shows the speed actually reached.

Inside each frame the simulator takes as many small steps as the circuit needs: short enough for every RC time constant, oscillator and signal frequency, and digital logic settles within each step. **Accuracy** makes the steps finer still, at the cost of more CPU.

### Why isn't it working?

When something is wrong, the part gets a warning badge, and the **Why isn't it working?** list shows every problem in plain words, for example a reversed LED, an LED without a resistor (with a suggested value), a short circuit, a chip without power, or an unconnected input. Click an entry to select the part.

### Run-Mode Display

When the simulation is running, chip part numbers, pin numbers, and pin labels are hidden across the breadboard so the visual focus is on the live state of LEDs, displays, and indicators. Stop the simulation to bring the labels back for editing.

### Oscilloscope

1. Select a component and click **Probe** in the properties panel
2. Click **Scope** at the bottom to expand the oscilloscope
3. Voltage traces appear in real time during simulation, sampled on every simulation step (not just once per frame), so fast signals are drawn correctly
4. Add up to 6 simultaneous probes
5. Remove traces with the "x" button on each tag

## AVR / Arduino Simulation

The ATmega328P component runs real AVR machine code in the browser using avr8js.

### How to use

1. Drag the **328P** chip from the sidebar onto the breadboard
2. Wire **VCC** (pin 7) and **GND** (pin 8) to power
3. Wire output pins (D0-D13, A0-A5) to LEDs, resistors, etc.
4. Select the chip and click **Load .hex** in the properties panel, or write a sketch in the **Sketch Editor** and compile it
5. Load a compiled Arduino sketch (.hex file from Arduino IDE). A damaged file is rejected with a message.
6. Click **Run** — the AVR executes your code at its clock speed (16 MHz by default). Holding RESET (pin 1) low stops it.

The firmware and the sketch source are saved with the circuit (in the `.ecx` file and the autosave), so they come back when you reopen it.

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
- Timer0, Timer1, Timer2 (delay, millis, PWM); an LED on a PWM pin glows at its average brightness
- Analog inputs (`analogRead`, 0–1023 against AVCC)
- Input pull-up resistors
- Serial at 9600 baud (output in the Serial Monitor)

### Driving sequential digital chips at high speeds

The AVR runs in 1 ms slices, and every pin transition is captured with its CPU cycle and replayed in order through the logic it drives: gates, the 74HC74 flip-flop, the 74HC595 shift register and the CD4026 counter. So the AVR can clock a shift register or a counter at microsecond timescales and every edge counts, and two microcontrollers can talk to each other.

## Save / Open

- **Save** (Ctrl+S) — saves to the circuit's current file, or asks for a name the first time
- **Save As** (Ctrl+Shift+S) — always asks for a name
- **Open** (Ctrl+O) — opens an `.ecx` file; a file that isn't a valid circuit is rejected with a message
- **New**, **Clear** and loading an **Example** ask first when you have unsaved changes, and can be undone
- Circuits store all components, wires, properties, firmware and sketches
- Closing the app with unsaved changes asks whether to save
- **Autosave** — see below

## Export

The **Export** menu offers:
- **PCB** — the PCB layout preview
- **.net** — a KiCad netlist for PCB layout
- **BOM** — a Bill of Materials (`.csv`)

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
- **behavior** — references a built-in simulation model: `logic_and`, `logic_or`, `logic_nand`, `logic_nor`, `logic_xor`, `logic_not`, `timer555`, `counter`, `opamp`, `shift_register`, `flipflop_d`, `regulator` (or a built-in type name)
- **passthrough** — renders the chip visually but does not simulate
- **pins** — give each pin a `number` and leave out `offset` to have it laid out like a real DIP; an invalid file or entry is skipped with a message, and the other chips still load

See `chips/example-shift-register.json` for a complete example.

## Claude AI Chat Panel

The app includes a built-in AI assistant powered by Claude that can understand, build, and modify your circuits.

### Setup

1. Open **Settings** and add your Anthropic API key. It is stored encrypted on this computer (Windows/macOS secure storage) and never leaves the app except to call the Claude API.
2. The chat panel appears on the right side of the app

### Capabilities

- **Ask questions** — "what does this circuit do?", "why isn't my LED lighting up?"
- **Build circuits** — "build me a 555 blink circuit" or "create a Geiger counter" — Claude places components and wires them directly on the board
- **Create new components** — if a component doesn't exist in the catalog (e.g. a Geiger-Muller tube, a relay, a sensor), Claude invents it with the correct pins and places it on the board. AI-created components persist across app restarts and appear in the sidebar like any other component.
- **Modify circuits** — "add a second 7-segment display" or "remove the capacitor"
- **Delete component types** — Claude can remove custom component types (never the built-in ones)
- **Undo** — everything Claude changes in one reply is a single undo step. Claude asks before clearing a board that has parts on it.
- **Stop** — the Stop button ends a reply at once

### Settings (bottom of chat panel)

- **Model** — choose between Auto, Opus 5.5, Sonnet 5.5, or Haiku 5.5 (Sonnet 5.5 is the default)
- **Auto mode** — picks a model once per conversation: Haiku 5.5 for short questions that don't build anything, Sonnet 5.5 for building and debugging, and Opus 5.5 only for large multi-part designs. The reason is shown under the options. It doesn't switch models mid-conversation, which keeps prompt caching effective.
- **Usage** (the **$** button) — tokens and estimated cost per request, counted over every round of a reply. Prices are estimates; check anthropic.com/pricing.
- **Circuit context** — controls whether Claude can see your current circuit: on-change (recommended), always, or never

### Processing Indicators

While Claude is working, status messages show what's happening:
- "Thinking..." — processing your request
- "Building circuit..." — placing components and wires
- "Creating new component..." — inventing a new component type
- "Modifying circuit..." — changing the existing circuit

Responses render as formatted markdown with code blocks, tables, and lists.

## Autosave

Your circuit is saved automatically about a second after each change. When you reopen the app, your last circuit is restored exactly as you left it, including its name, its file and any firmware, and Undo works from there. Autosave works alongside the manual Save/Open workflow.

- Every file is written safely (to a temporary file first, then swapped in), and the previous autosave and settings are kept as `.bak` copies.
- The autosave file is per computer (`autosave-<computer name>.ecx`), so two PCs sharing the data folder through OneDrive don't overwrite each other.
- A damaged autosave or settings file is kept aside (`.corrupt-<date>`) rather than overwritten, and the app tells you.
- If the data folder (for example in OneDrive) is missing, the app tells you instead of silently switching folders.
- Only one copy of the app runs at a time; opening it again brings the running one forward.

## Demos

Load them from the **Examples** menu.

- **Blink** — 555 astable circuit driving an LED (Ra=47k, Rb=68k, C=47uF)
- **Counter** — 555 astable driving a CD4026 decade counter into a 7-segment display
- **AVR Blink** — ATmega328P running a pre-loaded Arduino Blink sketch (pin 13 LED toggle with ~1s delay)
- **5x7 Matrix** — ATmega328P bit-banging a 74HC595 shift register to multiplex three animated patterns (heart, square, X) on a 5x7 LED matrix. Demonstrates AVR-driven edge replay into the shift register and the matrix renderer's sliding-window aggregation that reconstructs row-multiplexed scans into a steady image.
- **Necklace** — Direct-AVR-driven 5x7 LED matrix with scrolling text animation, demonstrating the ATmega328P driving a matrix without external shift registers.
