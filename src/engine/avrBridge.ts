import {
  CPU,
  avrInstruction,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  AVRSPI,
  AVRTWI,
  AVRADC,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  spiConfig,
  twiConfig,
  adcConfig,
  PinState,
} from 'avr8js';
// Inline Intel HEX parser (no Node Buffer dependency)

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
 * Pure JS implementation — no Node Buffer dependency.
 */
export function loadHexFile(hexString: string): Uint16Array {
  const bytes: number[] = [];
  let baseAddr = 0;
  let maxAddr = 0;

  for (const line of hexString.split(/\r?\n/)) {
    if (!line.startsWith(':') || line.length < 11) continue;
    const byteCount = parseInt(line.substring(1, 3), 16);
    const addr = parseInt(line.substring(3, 7), 16);
    const type = parseInt(line.substring(7, 9), 16);

    if (type === 0) {
      // Data record
      const fullAddr = baseAddr + addr;
      for (let i = 0; i < byteCount; i++) {
        const b = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
        const a = fullAddr + i;
        while (bytes.length <= a) bytes.push(0);
        bytes[a] = b;
        if (a + 1 > maxAddr) maxAddr = a + 1;
      }
    } else if (type === 2) {
      // Extended segment address
      baseAddr = parseInt(line.substring(9, 13), 16) << 4;
    } else if (type === 4) {
      // Extended linear address
      baseAddr = parseInt(line.substring(9, 13), 16) << 16;
    } else if (type === 1) {
      // EOF
      break;
    }
  }

  // Pad to even length
  if (maxAddr % 2 !== 0) maxAddr++;
  const progMem = new Uint16Array(maxAddr / 2);
  for (let i = 0; i < maxAddr; i += 2) {
    progMem[i / 2] = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8); // little-endian
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
const MAX_SERIAL_BUFFER = 1024;

export class AVRBridge {
  cpu: CPU | null = null;
  portB: AVRIOPort | null = null;
  portC: AVRIOPort | null = null;
  portD: AVRIOPort | null = null;
  private timer0: AVRTimer | null = null;
  private timer1: AVRTimer | null = null;
  private timer2: AVRTimer | null = null;
  private usart: AVRUSART | null = null;
  private spi: AVRSPI | null = null;
  private twi: AVRTWI | null = null;
  private adc: AVRADC | null = null;
  private clockFreq = 16_000_000; // 16 MHz
  private loaded = false;

  /** Current output pin states (updated each tick). */
  pinStates = new Map<string, PinOutputState>();

  /** Serial output buffer — characters sent via Serial.print() */
  serialOutput: string[] = [];

  /** SPI bytes transmitted (MOSI data). */
  spiOutput: number[] = [];

  /** I2C transaction log: { addr, data, write } */
  i2cLog: { addr: number; data: number[]; write: boolean }[] = [];

  /** Per-pin transition counts during the most recent tick (debug). */
  transitionCounts = new Map<string, number>();
  /**
   * Ordered transition log for the most recent tick. Each entry records the
   * AVR cycle at which a pin changed and its new logical level. Sequential
   * digital components (shift registers, flip-flops) replay this log so they
   * see every edge that happened *inside* the tick, not just the final state.
   */
  transitions: { cycle: number; pinId: string; high: boolean }[] = [];
  private prevPortValues: Record<'B' | 'C' | 'D', number> = { B: 0, C: 0, D: 0 };

  /** Load a hex program and initialize the CPU + peripherals. */
  load(hexString: string, clockFreq?: number): void {
    if (clockFreq) this.clockFreq = clockFreq;
    const progMem = loadHexFile(hexString);
    this.cpu = new CPU(progMem);

    // Attach GPIO
    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);

    // Listen for port value changes to record per-tick pin transitions.
    const installListener = (portObj: AVRIOPort, portName: 'B' | 'C' | 'D') => {
      portObj.addListener((value: number) => {
        const prev = this.prevPortValues[portName];
        const changed = value ^ prev;
        if (changed !== 0) {
          const cycle = this.cpu ? this.cpu.cycles : 0;
          for (let bit = 0; bit < 8; bit++) {
            if ((changed >> bit) & 1) {
              const pinId = `p${portName.toLowerCase()}${bit}`;
              this.transitionCounts.set(pinId, (this.transitionCounts.get(pinId) ?? 0) + 1);
              this.transitions.push({ cycle, pinId, high: ((value >> bit) & 1) === 1 });
            }
          }
          this.prevPortValues[portName] = value;
        }
      });
    };
    installListener(this.portB, 'B');
    installListener(this.portC, 'C');
    installListener(this.portD, 'D');

    // Timers
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);

    // UART (Serial)
    this.usart = new AVRUSART(this.cpu, usart0Config, this.clockFreq);
    this.usart.onByteTransmit = (byte: number) => {
      const char = String.fromCharCode(byte);
      this.serialOutput.push(char);
      if (this.serialOutput.length > MAX_SERIAL_BUFFER) {
        this.serialOutput.splice(0, this.serialOutput.length - MAX_SERIAL_BUFFER);
      }
    };

    // SPI
    this.spi = new AVRSPI(this.cpu, spiConfig, this.clockFreq);
    this.spi.onTransfer = (byte: number) => {
      this.spiOutput.push(byte);
      if (this.spiOutput.length > 256) this.spiOutput.splice(0, this.spiOutput.length - 256);
      return 0; // MISO response (no slave connected)
    };

    // I2C (TWI)
    this.twi = new AVRTWI(this.cpu, twiConfig, this.clockFreq);

    // ADC
    this.adc = new AVRADC(this.cpu, adcConfig);

    this.loaded = true;
    this.pinStates.clear();
    this.serialOutput = [];
    this.spiOutput = [];
    this.i2cLog = [];
  }

  /** Reset the CPU (keep program loaded). */
  reset(): void {
    if (this.cpu) {
      this.cpu.reset();
      this.pinStates.clear();
      this.serialOutput = [];
      this.spiOutput = [];
      this.i2cLog = [];
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
    this.usart = null;
    this.spi = null;
    this.twi = null;
    this.adc = null;
    this.loaded = false;
    this.pinStates.clear();
    this.serialOutput = [];
    this.spiOutput = [];
    this.i2cLog = [];
  }

  /** Feed an analog voltage into an ADC channel (0-5 for A0-A5). */
  setAnalogInput(channel: number, voltage: number, vRef: number): void {
    if (!this.adc || channel < 0 || channel > 5) return;
    // ADC returns 0-1023 for 0-vRef
    const adcValue = Math.round(Math.max(0, Math.min(1023, (voltage / vRef) * 1023)));
    this.adc.channelValues[channel] = adcValue;
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

    // Reset per-tick transition counters and event log
    this.transitionCounts.clear();
    this.transitions.length = 0;

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
