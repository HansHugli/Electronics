import {
  CPU,
  avrInstruction,
  AVRIOPort,
  AVRTimer,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  PinState,
} from 'avr8js';
import { parse as parseHex } from 'intel-hex';

/**
 * Arduino pin number → AVR port/bit mapping (ATmega328P).
 *
 * Digital 0-7  = PORTD bits 0-7
 * Digital 8-13 = PORTB bits 0-5
 * Analog  A0-A5 = PORTC bits 0-5
 */

/** Pin IDs in our component definition → Arduino pin number. */
const PIN_TO_ARDUINO: Record<string, number> = {
  pd0: 0, pd1: 1, pd2: 2, pd3: 3, pd4: 4, pd5: 5, pd6: 6, pd7: 7,
  pb0: 8, pb1: 9, pb2: 10, pb3: 11, pb4: 12, pb5: 13,
  pc0: 14, pc1: 15, pc2: 16, pc3: 17, pc4: 18, pc5: 19,
};

/** Arduino pin → { port: 'B'|'C'|'D', bit: 0-7 }. */
function arduinoPinToPort(pin: number): { port: 'B' | 'C' | 'D'; bit: number } {
  if (pin >= 0 && pin <= 7) return { port: 'D', bit: pin };
  if (pin >= 8 && pin <= 13) return { port: 'B', bit: pin - 8 };
  if (pin >= 14 && pin <= 19) return { port: 'C', bit: pin - 14 };
  return { port: 'D', bit: 0 };
}

/**
 * Parse an Intel HEX string into a Uint16Array suitable for avr8js CPU.
 */
export function loadHexFile(hexString: string): Uint16Array {
  const { data } = parseHex(hexString);
  const progMem = new Uint16Array(data.length / 2);
  for (let i = 0; i < data.length; i += 2) {
    progMem[i / 2] = data[i] | (data[i + 1] << 8); // little-endian
  }
  return progMem;
}

export type PinOutputState = 'low' | 'high' | 'input' | 'input_pullup';

export interface AVRPinStates {
  /** Map from our pin ID (pd0, pb5, etc.) to output state. */
  pins: Map<string, PinOutputState>;
}

/**
 * Manages an AVR CPU instance and its peripherals.
 * Acts as the bridge between avr8js and our circuit simulator.
 */
export class AVRBridge {
  cpu: CPU | null = null;
  portB: AVRIOPort | null = null;
  portC: AVRIOPort | null = null;
  portD: AVRIOPort | null = null;
  private timer0: AVRTimer | null = null;
  private timer1: AVRTimer | null = null;
  private timer2: AVRTimer | null = null;
  private clockFreq = 16_000_000; // 16 MHz
  private loaded = false;

  /** Current output pin states (updated each tick). */
  pinStates = new Map<string, PinOutputState>();

  /** Load a hex program and initialize the CPU + peripherals. */
  load(hexString: string, clockFreq?: number): void {
    if (clockFreq) this.clockFreq = clockFreq;
    const progMem = loadHexFile(hexString);
    this.cpu = new CPU(progMem);

    // Attach peripherals
    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);

    this.loaded = true;
    this.pinStates.clear();
  }

  /** Reset the CPU (keep program loaded). */
  reset(): void {
    if (this.cpu) {
      this.cpu.reset();
      this.pinStates.clear();
    }
  }

  /** Unload the program. */
  unload(): void {
    this.cpu = null;
    this.portB = null;
    this.portC = null;
    this.portD = null;
    this.timer0 = null;
    this.timer1 = null;
    this.timer2 = null;
    this.loaded = false;
    this.pinStates.clear();
  }

  isLoaded(): boolean {
    return this.loaded && this.cpu !== null;
  }

  /**
   * Set an external voltage on an AVR pin (from the MNA solver).
   * If voltage > VCC/2 (2.5V), the pin reads HIGH; otherwise LOW.
   */
  setExternalPin(pinId: string, voltage: number, vcc: number): void {
    const arduinoPin = PIN_TO_ARDUINO[pinId];
    if (arduinoPin === undefined) return;
    const { port, bit } = arduinoPinToPort(arduinoPin);
    const portObj = this.getPort(port);
    if (!portObj) return;

    const isHigh = voltage > vcc * 0.5;
    portObj.setPin(bit, isHigh);
  }

  /**
   * Run the CPU for one simulation tick.
   * @param dt - simulation timestep in seconds (e.g. 0.1 for 100ms)
   * @returns updated pin states
   */
  tick(dt: number): AVRPinStates {
    if (!this.cpu) return { pins: this.pinStates };

    const cyclesToRun = Math.round(this.clockFreq * dt);
    const targetCycles = this.cpu.cycles + cyclesToRun;

    // Run CPU instructions until we hit the target cycle count
    while (this.cpu.cycles < targetCycles) {
      avrInstruction(this.cpu);
      this.cpu.tick();
    }

    // Read all pin states
    this.readPinStates();

    return { pins: this.pinStates };
  }

  private getPort(port: 'B' | 'C' | 'D'): AVRIOPort | null {
    switch (port) {
      case 'B': return this.portB;
      case 'C': return this.portC;
      case 'D': return this.portD;
    }
  }

  private readPinStates(): void {
    for (const [pinId, arduinoPin] of Object.entries(PIN_TO_ARDUINO)) {
      const { port, bit } = arduinoPinToPort(arduinoPin);
      const portObj = this.getPort(port);
      if (!portObj) continue;

      const state = portObj.pinState(bit);
      let output: PinOutputState;
      switch (state) {
        case PinState.Low: output = 'low'; break;
        case PinState.High: output = 'high'; break;
        case PinState.Input: output = 'input'; break;
        case PinState.InputPullUp: output = 'input_pullup'; break;
        default: output = 'input';
      }
      this.pinStates.set(pinId, output);
    }
  }
}
