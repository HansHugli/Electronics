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

/** GPIO pin ids of the ATmega328P that the simulator models. */
export const AVR_GPIO_PINS = Object.keys(PIN_TO_ARDUINO);

/** Arduino pin → { port: 'B'|'C'|'D', bit: 0-7 }. */
function arduinoPinToPort(pin: number): { port: 'B' | 'C' | 'D'; bit: number } {
  if (pin >= 0 && pin <= 7) return { port: 'D', bit: pin };
  if (pin >= 8 && pin <= 13) return { port: 'B', bit: pin - 8 };
  if (pin >= 14 && pin <= 19) return { port: 'C', bit: pin - 14 };
  return { port: 'D', bit: 0 };
}

/** Flash size of the ATmega328P in bytes. */
export const ATMEGA328P_FLASH_BYTES = 32 * 1024;

/**
 * Parse an Intel HEX string into a Uint16Array suitable for avr8js CPU.
 * Pure JS implementation — no Node Buffer dependency.
 *
 * Throws an Error with a readable message when the text is not a valid HEX
 * file: a line that isn't a record, a bad checksum, a record that doesn't
 * match its byte count, data beyond `flashBytes`, or no data at all.
 */
export function loadHexFile(hexString: string, flashBytes = ATMEGA328P_FLASH_BYTES): Uint16Array {
  if (typeof hexString !== 'string') throw new Error('The program is not text.');
  const bytes = new Uint8Array(flashBytes);
  let baseAddr = 0;
  let maxAddr = 0;
  let dataRecords = 0;
  let sawEof = false;

  const lines = hexString.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (line === '') continue;
    if (sawEof) break;
    if (!line.startsWith(':')) {
      throw new Error(`Line ${ln + 1} is not an Intel HEX record (it should start with ':').`);
    }
    const body = line.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(body) || body.length % 2 !== 0 || body.length < 10) {
      throw new Error(`Line ${ln + 1} is not a valid Intel HEX record.`);
    }
    const rec: number[] = [];
    for (let i = 0; i < body.length; i += 2) rec.push(parseInt(body.substring(i, i + 2), 16));
    const byteCount = rec[0];
    if (rec.length !== byteCount + 5) {
      throw new Error(`Line ${ln + 1}: the record length doesn't match its byte count.`);
    }
    const sum = rec.reduce((a, b) => a + b, 0) & 0xff;
    if (sum !== 0) {
      throw new Error(`Line ${ln + 1}: checksum error — the file is damaged.`);
    }
    const addr = (rec[1] << 8) | rec[2];
    const type = rec[3];
    const data = rec.slice(4, 4 + byteCount);

    switch (type) {
      case 0: { // Data record
        const fullAddr = baseAddr + addr;
        if (fullAddr + byteCount > flashBytes) {
          throw new Error(`The program is larger than the chip's ${flashBytes / 1024} KB flash memory.`);
        }
        bytes.set(data, fullAddr);
        if (fullAddr + byteCount > maxAddr) maxAddr = fullAddr + byteCount;
        if (byteCount > 0) dataRecords++;
        break;
      }
      case 1: // EOF
        sawEof = true;
        break;
      case 2: // Extended segment address
        if (byteCount !== 2) throw new Error(`Line ${ln + 1}: bad extended segment address record.`);
        baseAddr = ((data[0] << 8) | data[1]) << 4;
        break;
      case 4: // Extended linear address
        if (byteCount !== 2) throw new Error(`Line ${ln + 1}: bad extended linear address record.`);
        baseAddr = ((data[0] << 8) | data[1]) * 0x10000;
        break;
      case 3: // Start segment address (ignored by AVR)
      case 5: // Start linear address (ignored by AVR)
        break;
      default:
        throw new Error(`Line ${ln + 1}: unknown record type ${type}.`);
    }
  }

  if (dataRecords === 0) throw new Error('No program found in the HEX file.');

  // Pad to even length
  if (maxAddr % 2 !== 0) maxAddr++;
  const progMem = new Uint16Array(Math.max(1, maxAddr / 2));
  for (let i = 0; i < maxAddr; i += 2) {
    progMem[i / 2] = bytes[i] | (bytes[i + 1] << 8); // little-endian
  }
  return progMem;
}

export type PinOutputState = 'low' | 'high' | 'input' | 'input_pullup';

export interface AVRPinStates {
  /** Map from our pin ID (pd0, pb5, etc.) to output state. */
  pins: Map<string, PinOutputState>;
}

/** Characters kept for the serial monitor (the total count is unbounded). */
const MAX_SERIAL_BUFFER = 1024;

/**
 * Manages an AVR CPU instance and its peripherals.
 * Acts as the bridge between avr8js and our circuit simulator.
 *
 * The simulator runs the CPU in short chunks (`runFor`) and exchanges pin
 * levels with the circuit between chunks; `transitions` collects every pin
 * edge since the last `beginTick()` with its CPU cycle, so sequential logic
 * can replay edges that happen inside a chunk.
 */
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
  private program: Uint16Array | null = null;
  /** Fractional cycles carried between chunks so the clock never drifts. */
  private cycleDebt = 0;
  private inReset = false;
  private serialIn: number[] = [];

  /** Current output pin states (updated after each chunk). */
  pinStates = new Map<string, PinOutputState>();

  /** Serial output buffer — the last characters sent via Serial.print() */
  serialOutput: string[] = [];
  /** Total number of characters ever received from the MCU (monotonic). */
  serialTotal = 0;

  /** SPI bytes transmitted (MOSI data). */
  spiOutput: number[] = [];

  /** I2C transaction log: { addr, data, write } */
  i2cLog: { addr: number; data: number[]; write: boolean }[] = [];

  /** Per-pin transition counts since the last beginTick() (debug). */
  transitionCounts = new Map<string, number>();
  /**
   * Ordered transition log since the last beginTick(). Each entry records
   * the AVR cycle at which a pin changed and its new logical level.
   */
  transitions: { cycle: number; pinId: string; high: boolean }[] = [];
  private prevPortValues: Record<'B' | 'C' | 'D', number> = { B: 0, C: 0, D: 0 };
  /** Last level fed into each input pin (avoids redundant setPin calls). */
  private fedLevels = new Map<string, boolean>();

  /**
   * Load a hex program and initialize the CPU + peripherals.
   * Throws (and keeps the previous program) when the HEX text is invalid.
   */
  load(hexString: string, clockFreq?: number): void {
    const progMem = loadHexFile(hexString);
    if (clockFreq && Number.isFinite(clockFreq) && clockFreq > 0) this.clockFreq = clockFreq;
    this.program = progMem;
    this.boot();
    this.serialOutput = [];
    this.serialTotal = 0;
    this.spiOutput = [];
    this.i2cLog = [];
    this.serialIn = [];
  }

  /** (Re)create the CPU and peripherals from the loaded program: a power-on reset. */
  private boot(): void {
    if (!this.program) return;
    // avr8js needs the full flash array so the PC can't run off the end.
    const flash = new Uint16Array(ATMEGA328P_FLASH_BYTES / 2);
    flash.set(this.program.subarray(0, flash.length));
    this.cpu = new CPU(flash);

    // Attach GPIO
    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);
    this.prevPortValues = { B: 0, C: 0, D: 0 };
    this.fedLevels.clear();

    // Listen for port value changes to record pin transitions.
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
      this.serialOutput.push(String.fromCharCode(byte));
      this.serialTotal++;
      if (this.serialOutput.length > MAX_SERIAL_BUFFER) {
        this.serialOutput.splice(0, this.serialOutput.length - MAX_SERIAL_BUFFER);
      }
    };
    this.usart.onRxComplete = () => this.feedSerial();

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
    this.cycleDebt = 0;
    this.pinStates.clear();
    this.readPinStates();
  }

  /** Reset the CPU (keep program loaded) and clear its output buffers. */
  reset(): void {
    if (this.program) {
      this.boot();
      this.serialOutput = [];
      this.serialTotal = 0;
      this.spiOutput = [];
      this.i2cLog = [];
      this.serialIn = [];
      this.inReset = false;
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
    this.program = null;
    this.loaded = false;
    this.pinStates.clear();
    this.serialOutput = [];
    this.serialTotal = 0;
    this.spiOutput = [];
    this.i2cLog = [];
  }

  /** CPU clock in Hz (the ATmega's clockSpeed property). */
  get clockHz(): number { return this.clockFreq; }

  /** Change the CPU clock; takes effect from the next chunk. */
  setClock(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0 || hz === this.clockFreq) return;
    this.clockFreq = Math.min(32e6, Math.max(1e3, hz));
  }

  /**
   * Hold the CPU in reset (RESET pin LOW, or no power). While held, the CPU
   * doesn't run and every pin is an input. Releasing it restarts the
   * program from the beginning, like a real power-on or reset.
   */
  holdReset(held: boolean): void {
    if (held === this.inReset) return;
    this.inReset = held;
    if (!held) this.boot();
    else this.readPinStates();
  }

  get isHeldInReset(): boolean { return this.inReset; }

  /** Queue text to send to the MCU's serial input (Serial.read()). */
  sendSerial(text: string): void {
    for (let i = 0; i < text.length; i++) this.serialIn.push(text.charCodeAt(i) & 0xff);
    this.feedSerial();
  }

  private feedSerial(): void {
    if (!this.usart || this.serialIn.length === 0) return;
    if (this.usart.rxBusy || !this.usart.rxEnable) return;
    const byte = this.serialIn[0];
    if (this.usart.writeByte(byte)) this.serialIn.shift();
  }

  /**
   * Feed an analog voltage into an ADC channel (0-5 for A0-A5). avr8js wants
   * volts; `vRef` is the AVCC voltage used when the sketch selects AVCC.
   */
  setAnalogInput(channel: number, voltage: number, vRef: number): void {
    if (!this.adc || channel < 0 || channel > 5) return;
    this.adc.channelValues[channel] = Math.max(0, Number.isFinite(voltage) ? voltage : 0);
    if (Number.isFinite(vRef) && vRef > 0) this.adc.avcc = vRef;
  }

  /** Set the AREF pin voltage for analogReference(EXTERNAL). */
  setAref(voltage: number): void {
    if (this.adc && Number.isFinite(voltage) && voltage > 0) this.adc.aref = voltage;
  }

  isLoaded(): boolean {
    return this.loaded && this.cpu !== null;
  }

  /**
   * Set the logic level the circuit applies to an AVR pin. The simulator
   * decides the level (thresholds and hysteresis); this only forwards
   * changes to the port.
   */
  setInputLevel(pinId: string, high: boolean): void {
    if (this.fedLevels.get(pinId) === high) return;
    const arduinoPin = PIN_TO_ARDUINO[pinId];
    if (arduinoPin === undefined) return;
    const { port, bit } = arduinoPinToPort(arduinoPin);
    const portObj = this.getPort(port);
    if (!portObj) return;
    this.fedLevels.set(pinId, high);
    portObj.setPin(bit, high);
  }

  /**
   * Set an external voltage on an AVR pin (from the MNA solver).
   * Reads HIGH above VCC/2. Kept for callers outside the simulator.
   */
  setExternalPin(pinId: string, voltage: number, vcc: number): void {
    this.setInputLevel(pinId, voltage > vcc * 0.5);
  }

  /** Output bit the CPU last wrote for a pin (PORT value, including timer outputs). */
  portLevel(pinId: string): boolean {
    const arduinoPin = PIN_TO_ARDUINO[pinId];
    if (arduinoPin === undefined) return false;
    const { port, bit } = arduinoPinToPort(arduinoPin);
    return ((this.prevPortValues[port] >> bit) & 1) === 1;
  }

  /** Start a new simulator tick: clears the transition log. */
  beginTick(): void {
    this.transitionCounts.clear();
    this.transitions.length = 0;
  }

  /** CPU cycle counter (0 when no program). */
  get cycles(): number { return this.cpu ? this.cpu.cycles : 0; }

  /**
   * Run the CPU for `seconds` of simulated time (does nothing while held in
   * reset). Transitions are appended to `transitions`.
   */
  runFor(seconds: number): void {
    if (!this.cpu || this.inReset || !(seconds > 0)) return;
    this.cycleDebt += this.clockFreq * seconds;
    const n = Math.floor(this.cycleDebt);
    this.cycleDebt -= n;
    const cpu = this.cpu;
    const targetCycles = cpu.cycles + n;
    while (cpu.cycles < targetCycles) {
      avrInstruction(cpu);
      cpu.tick();
    }
    this.readPinStates();
  }

  /**
   * Run the CPU for one simulation tick (clears the transition log first).
   * @param dt - simulation timestep in seconds (e.g. 0.1 for 100ms)
   * @returns updated pin states
   */
  tick(dt: number): AVRPinStates {
    this.beginTick();
    this.runFor(dt);
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
      if (this.inReset) { this.pinStates.set(pinId, 'input'); continue; }
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
