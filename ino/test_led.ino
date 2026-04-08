// test_led.ino — walk a single lit LED across the 5x7 matrix
//
// Target hardware: the matrix demo from createMatrixDemoCircuit
// (ATmega328P + 74HC595 + 5x7 LED matrix).
//
// Order: top-left -> top-right, then next row down, ..., bottom-right.
// Each LED stays on for STEP_MS, then the walk restarts.

const uint8_t ROW_PINS[7] = { 2, 3, 4, 5, 6, 7, 9 };  // R1..R7 (cathodes)
const uint8_t LATCH_PIN = 8;   // 74HC595 RCLK
const uint8_t DATA_PIN  = 11;  // 74HC595 SER
const uint8_t CLOCK_PIN = 12;  // 74HC595 SRCLK

const uint16_t STEP_MS = 1000;  // dwell per LED

void writeColumns(uint8_t colMask5) {
  // Columns are wired to QD..QH. With LSBFIRST shifting, the low 5 bits
  // of the byte land on QD..QH where bit4 = C1 and bit0 = C5.
  shiftOut(DATA_PIN, CLOCK_PIN, LSBFIRST, colMask5 & 0x1F);
  digitalWrite(LATCH_PIN, HIGH);
  digitalWrite(LATCH_PIN, LOW);
}

void allRowsOff() {
  for (uint8_t r = 0; r < 7; r++) digitalWrite(ROW_PINS[r], HIGH);
}

void lightOne(uint8_t row, uint8_t col) {
  // col 0 = leftmost (C1) -> bit 4; col 4 = rightmost (C5) -> bit 0.
  allRowsOff();
  writeColumns(1 << (4 - col));
  digitalWrite(ROW_PINS[row], LOW);  // sink this row -> LED on
}

void setup() {
  for (uint8_t r = 0; r < 7; r++) {
    pinMode(ROW_PINS[r], OUTPUT);
    digitalWrite(ROW_PINS[r], HIGH);
  }
  pinMode(LATCH_PIN, OUTPUT);
  pinMode(DATA_PIN,  OUTPUT);
  pinMode(CLOCK_PIN, OUTPUT);
  digitalWrite(LATCH_PIN, LOW);
  writeColumns(0);
}

void loop() {
  for (uint8_t row = 0; row < 7; row++) {
    for (uint8_t col = 0; col < 5; col++) {
      lightOne(row, col);
      delay(STEP_MS);
      allRowsOff();
    }
  }
}
