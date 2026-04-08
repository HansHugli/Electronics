// 5x7 LED Matrix demo — reverse-engineered from AVR_MATRIX_HEX
// in src/engine/simulation.ts. This is the source that corresponds
// to the firmware actually loaded by the "5x7 Matrix Demo" button.
//
// Hardware (see createMatrixDemoCircuit):
//   ATmega328P + 74HC595 shift register driving a 5x7 LED matrix.
//
//   Row cathodes (sunk by AVR pins, LOW = row active):
//     R1=D2 (PD2)  R2=D3 (PD3)  R3=D4 (PD4)  R4=D5 (PD5)
//     R5=D6 (PD6)  R6=D7 (PD7)  R7=D9 (PB1)
//
//   74HC595 control:
//     SER   = D11 (PB3)   data
//     SRCLK = D12 (PB4)   shift clock
//     RCLK  = D8  (PB0)   latch
//
//   Column anodes — because the firmware shifts LSB-first, the low 5
//   bits of the pattern byte end up on QD..QH, which are wired to the
//   columns:  C1=QD  C2=QE  C3=QF  C4=QG  C5=QH
//   Pattern bit 4 = C1 (leftmost), bit 0 = C5 (rightmost).

const uint8_t ROW_PINS[7] = { 2, 3, 4, 5, 6, 7, 9 };

const uint8_t LATCH_PIN = 8;   // RCLK
const uint8_t DATA_PIN  = 11;  // SER
const uint8_t CLOCK_PIN = 12;  // SRCLK

// Three 7-row patterns, 5 bits each (bit4 = C1 ... bit0 = C5).
const uint8_t PATTERNS[3][7] = {
  // Heart
  { 0x0A, 0x1F, 0x1F, 0x0E, 0x04, 0x00, 0x00 },
  // Rectangle
  { 0x1F, 0x11, 0x11, 0x11, 0x11, 0x1F, 0x00 },
  // X
  { 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x00, 0x00 },
};

const uint16_t FRAME_HOLD_MS = 1000;  // dwell per pattern

void setup() {
  for (uint8_t i = 0; i < 7; i++) {
    pinMode(ROW_PINS[i], OUTPUT);
    digitalWrite(ROW_PINS[i], HIGH);  // HIGH = row off
  }
  pinMode(LATCH_PIN, OUTPUT);
  pinMode(DATA_PIN,  OUTPUT);
  pinMode(CLOCK_PIN, OUTPUT);
  digitalWrite(LATCH_PIN, LOW);
}

void displayFrame(const uint8_t pattern[7], uint16_t durationMs) {
  unsigned long start = millis();
  while (millis() - start < durationMs) {
    for (uint8_t row = 0; row < 7; row++) {
      // Blank all rows while latching new column data.
      for (uint8_t r = 0; r < 7; r++) {
        digitalWrite(ROW_PINS[r], HIGH);
      }
      // Shift the row's column bits LSB-first so they land on QD..QH.
      shiftOut(DATA_PIN, CLOCK_PIN, LSBFIRST, pattern[row]);
      digitalWrite(LATCH_PIN, HIGH);
      digitalWrite(LATCH_PIN, LOW);
      // Drive this row's cathode low to light its lit columns.
      digitalWrite(ROW_PINS[row], LOW);
      delay(2);
    }
  }
}

void loop() {
  for (uint8_t i = 0; i < 3; i++) {
    displayFrame(PATTERNS[i], FRAME_HOLD_MS);
  }
}
