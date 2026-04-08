// Necklace.ino
//
// Arduino port of Necklace.c
//   original: copyright 2012 Tim Toner (tigeruppp@gmail.com), GPL v2+
//   text-mode mods: Craig Lindley (calhjh@gmail.com)
//
// Drives a 5-row x 7-column LED matrix (originally a Lite-On LTP-747)
// with a 5x7 font, sprite animations, and two pushbuttons to cycle
// through display modes.
//
// The original targeted an ATtiny with PORTA/PORTB/PORTD and a Timer0
// CTC ISR for row multiplexing. This port uses Arduino digitalWrite,
// runs the row refresh in loop() paced by micros(), and stores fonts
// in PROGMEM via pgm_read_byte() — same as the original.
//
// ===== Hardware configuration =====
// Edit ROW_PINS / COL_PINS to match your wiring. Defaults assume:
//   - Rows are anodes,    active HIGH (pin sources current to a row)
//   - Columns are cathodes, active LOW (pin sinks the column's LEDs)
// Flip ROW_ACTIVE_HIGH / COL_ACTIVE_LOW if your matrix is wired the
// other way (e.g. LTP-757 family).

#include <avr/pgmspace.h>
#include <string.h>

#define ROWS 5
#define COLS 7

const uint8_t ROW_PINS[ROWS] = { A0, A1, A2, A3, A4 };
const uint8_t COL_PINS[COLS] = {  2,  3,  4,  5,  6,  7,  8 };

const uint8_t BUTTON1_PIN = 9;   // next mode
const uint8_t BUTTON2_PIN = 10;  // previous mode

const bool ROW_ACTIVE_HIGH = true;   // LTP-747: rows source, cols sink
const bool COL_ACTIVE_LOW  = true;

// ~390 row-refreshes per second, matching the original Timer0 ISR.
const unsigned long REFRESH_PERIOD_US = 1000000UL / 390UL;

// ===== State =====
uint8_t bitmap[ROWS][COLS];
uint8_t current_row = 0;
volatile bool need_refresh_line = false;
volatile bool need_render_frame = false;

int mode;
int t, frame, frame_delay;
int b1, b2;

// ===== Fonts / sprites (PROGMEM, unchanged from Necklace.c) =====
const unsigned char FONT_CHARS[96][5] PROGMEM = {
  { 0x00, 0x00, 0x00, 0x00, 0x00 }, { 0x00, 0x00, 0x5F, 0x00, 0x00 },
  { 0x00, 0x07, 0x00, 0x07, 0x00 }, { 0x14, 0x7F, 0x14, 0x7F, 0x14 },
  { 0x24, 0x2A, 0x7F, 0x2A, 0x12 }, { 0x23, 0x13, 0x08, 0x64, 0x62 },
  { 0x36, 0x49, 0x55, 0x22, 0x50 }, { 0x00, 0x05, 0x03, 0x00, 0x00 },
  { 0x00, 0x1C, 0x22, 0x41, 0x00 }, { 0x00, 0x41, 0x22, 0x1C, 0x00 },
  { 0x08, 0x2A, 0x1C, 0x2A, 0x08 }, { 0x08, 0x08, 0x3E, 0x08, 0x08 },
  { 0x00, 0x50, 0x30, 0x00, 0x00 }, { 0x08, 0x08, 0x08, 0x08, 0x08 },
  { 0x00, 0x60, 0x60, 0x00, 0x00 }, { 0x20, 0x10, 0x08, 0x04, 0x02 },
  { 0x3E, 0x51, 0x49, 0x45, 0x3E }, { 0x00, 0x42, 0x7F, 0x40, 0x00 },
  { 0x42, 0x61, 0x51, 0x49, 0x46 }, { 0x21, 0x41, 0x45, 0x4B, 0x31 },
  { 0x18, 0x14, 0x12, 0x7F, 0x10 }, { 0x27, 0x45, 0x45, 0x45, 0x39 },
  { 0x3C, 0x4A, 0x49, 0x49, 0x30 }, { 0x01, 0x71, 0x09, 0x05, 0x03 },
  { 0x36, 0x49, 0x49, 0x49, 0x36 }, { 0x06, 0x49, 0x49, 0x29, 0x1E },
  { 0x00, 0x36, 0x36, 0x00, 0x00 }, { 0x00, 0x56, 0x36, 0x00, 0x00 },
  { 0x00, 0x08, 0x14, 0x22, 0x41 }, { 0x14, 0x14, 0x14, 0x14, 0x14 },
  { 0x41, 0x22, 0x14, 0x08, 0x00 }, { 0x02, 0x01, 0x51, 0x09, 0x06 },
  { 0x32, 0x49, 0x79, 0x41, 0x3E }, { 0x7E, 0x11, 0x11, 0x11, 0x7E },
  { 0x7F, 0x49, 0x49, 0x49, 0x36 }, { 0x3E, 0x41, 0x41, 0x41, 0x22 },
  { 0x7F, 0x41, 0x41, 0x22, 0x1C }, { 0x7F, 0x49, 0x49, 0x49, 0x41 },
  { 0x7F, 0x09, 0x09, 0x01, 0x01 }, { 0x3E, 0x41, 0x41, 0x51, 0x32 },
  { 0x7F, 0x08, 0x08, 0x08, 0x7F }, { 0x00, 0x41, 0x7F, 0x41, 0x00 },
  { 0x20, 0x40, 0x41, 0x3F, 0x01 }, { 0x7F, 0x08, 0x14, 0x22, 0x41 },
  { 0x7F, 0x40, 0x40, 0x40, 0x40 }, { 0x7F, 0x02, 0x04, 0x02, 0x7F },
  { 0x7F, 0x04, 0x08, 0x10, 0x7F }, { 0x3E, 0x41, 0x41, 0x41, 0x3E },
  { 0x7F, 0x09, 0x09, 0x09, 0x06 }, { 0x3E, 0x41, 0x51, 0x21, 0x5E },
  { 0x7F, 0x09, 0x19, 0x29, 0x46 }, { 0x46, 0x49, 0x49, 0x49, 0x31 },
  { 0x01, 0x01, 0x7F, 0x01, 0x01 }, { 0x3F, 0x40, 0x40, 0x40, 0x3F },
  { 0x1F, 0x20, 0x40, 0x20, 0x1F }, { 0x7F, 0x20, 0x18, 0x20, 0x7F },
  { 0x63, 0x14, 0x08, 0x14, 0x63 }, { 0x03, 0x04, 0x78, 0x04, 0x03 },
  { 0x61, 0x51, 0x49, 0x45, 0x43 }, { 0x00, 0x00, 0x7F, 0x41, 0x41 },
  { 0x02, 0x04, 0x08, 0x10, 0x20 }, { 0x41, 0x41, 0x7F, 0x00, 0x00 },
  { 0x04, 0x02, 0x01, 0x02, 0x04 }, { 0x40, 0x40, 0x40, 0x40, 0x40 },
  { 0x00, 0x01, 0x02, 0x04, 0x00 }, { 0x20, 0x54, 0x54, 0x54, 0x78 },
  { 0x7F, 0x48, 0x44, 0x44, 0x38 }, { 0x38, 0x44, 0x44, 0x44, 0x00 },
  { 0x38, 0x44, 0x44, 0x48, 0x7F }, { 0x38, 0x54, 0x54, 0x54, 0x18 },
  { 0x08, 0x7E, 0x09, 0x01, 0x02 }, { 0x08, 0x14, 0x54, 0x54, 0x3C },
  { 0x7F, 0x08, 0x04, 0x04, 0x78 }, { 0x00, 0x44, 0x7D, 0x40, 0x00 },
  { 0x20, 0x40, 0x44, 0x3D, 0x00 }, { 0x00, 0x7F, 0x10, 0x28, 0x44 },
  { 0x00, 0x41, 0x7F, 0x40, 0x00 }, { 0x7C, 0x04, 0x18, 0x04, 0x78 },
  { 0x7C, 0x08, 0x04, 0x04, 0x78 }, { 0x38, 0x44, 0x44, 0x44, 0x38 },
  { 0x7C, 0x14, 0x14, 0x14, 0x08 }, { 0x08, 0x14, 0x14, 0x18, 0x7C },
  { 0x7C, 0x08, 0x04, 0x04, 0x08 }, { 0x48, 0x54, 0x54, 0x54, 0x20 },
  { 0x04, 0x3F, 0x44, 0x40, 0x20 }, { 0x3C, 0x40, 0x40, 0x20, 0x7C },
  { 0x1C, 0x20, 0x40, 0x20, 0x1C }, { 0x3C, 0x40, 0x30, 0x40, 0x3C },
  { 0x44, 0x28, 0x10, 0x28, 0x44 }, { 0x0C, 0x50, 0x50, 0x50, 0x3C },
  { 0x44, 0x64, 0x54, 0x4C, 0x44 }, { 0x00, 0x08, 0x36, 0x41, 0x00 },
  { 0x00, 0x00, 0x7F, 0x00, 0x00 }, { 0x00, 0x41, 0x36, 0x08, 0x00 },
  { 0x08, 0x08, 0x2A, 0x1C, 0x08 }, { 0x08, 0x1C, 0x2A, 0x08, 0x08 },
};

#define CHARS 35
const unsigned char charset[CHARS][5] PROGMEM = {
  { 0xFF, 0x41, 0x5D, 0x41, 0xFF },  // 0  psycho 2
  { 0x00, 0x3E, 0x22, 0x3E, 0x00 },  // 1  psycho 1
  { 0x0E, 0x3B, 0x17, 0x3B, 0x0E },  // 2  skull
  { 0x0C, 0x12, 0x24, 0x12, 0x0C },  // 3  heart
  { 0x0A, 0x00, 0x55, 0x00, 0x0A },  // 4  flower
  { 0x08, 0x14, 0x2A, 0x14, 0x08 },  // 5  diamond
  { 0x07, 0x49, 0x71, 0x49, 0x07 },  // 6  cup
  { 0x22, 0x14, 0x6B, 0x14, 0x22 },  // 7  star2
  { 0x36, 0x36, 0x08, 0x36, 0x36 },  // 8  star3
  { 0x06, 0x15, 0x69, 0x15, 0x06 },  // 9  nuke
  { 0x0F, 0x1A, 0x3E, 0x1A, 0x0F },  // 10 fox
  { 0x6C, 0x1A, 0x6F, 0x1A, 0x6C },  // 11 alien
  { 0x7D, 0x5A, 0x1E, 0x5A, 0x7D },  // 12 alien
  { 0x4E, 0x7B, 0x0F, 0x7B, 0x4E },  // 13 alien
  { 0x3D, 0x66, 0x7C, 0x66, 0x3D },  // 14 alien
  { 0x11, 0x11, 0x11, 0x11, 0x11 },  // 15 horizontal lines
  { 0x01, 0x01, 0x01, 0x01, 0x01 },  // 16 h wall 0
  { 0x02, 0x02, 0x02, 0x02, 0x02 },  // 17
  { 0x04, 0x04, 0x04, 0x04, 0x04 },  // 18
  { 0x08, 0x08, 0x08, 0x08, 0x08 },  // 19
  { 0x10, 0x10, 0x10, 0x10, 0x10 },  // 20
  { 0x20, 0x20, 0x20, 0x20, 0x20 },  // 21
  { 0x40, 0x40, 0x40, 0x40, 0x40 },  // 22
  { 0x40, 0x40, 0x20, 0x20, 0x10 },  // 23 ld wall 0
  { 0x40, 0x20, 0x10, 0x10, 0x08 },  // 24
  { 0x40, 0x20, 0x10, 0x08, 0x04 },  // 25
  { 0x40, 0x20, 0x18, 0x04, 0x02 },  // 26
  { 0x40, 0x30, 0x0C, 0x02, 0x01 },  // 27
  { 0x40, 0x38, 0x04, 0x03, 0x00 },  // 28
  { 0xF0, 0x0F, 0x00, 0x00, 0x00 },  // 29
  { 0xFF, 0x00, 0x00, 0x00, 0x00 },  // 30 v wall 1
  { 0x00, 0xFF, 0x00, 0x00, 0x00 },  // 31
  { 0x00, 0x00, 0xFF, 0x00, 0x00 },  // 32
  { 0x00, 0x00, 0x00, 0xFF, 0x00 },  // 33
  { 0x00, 0x00, 0x00, 0x00, 0xFF },  // 34
};

// ===== LED driver =====

void reset_led() {
  for (uint8_t r = 0; r < ROWS; r++) {
    digitalWrite(ROW_PINS[r], ROW_ACTIVE_HIGH ? LOW : HIGH);
  }
  for (uint8_t c = 0; c < COLS; c++) {
    digitalWrite(COL_PINS[c], COL_ACTIVE_LOW ? HIGH : LOW);
  }
}

void set_row(uint8_t r) {
  digitalWrite(ROW_PINS[r], ROW_ACTIVE_HIGH ? HIGH : LOW);
}

void set_column(uint8_t c) {
  digitalWrite(COL_PINS[c], COL_ACTIVE_LOW ? LOW : HIGH);
}

// Drive the current row using the bitmap; called from the refresh tick.
void refresh_line() {
  reset_led();
  set_row(current_row);
  for (uint8_t c = 0; c < COLS; c++) {
    if (bitmap[current_row][c]) set_column(c);
  }
  need_refresh_line = false;
}

// ===== Bitmap helpers =====

void clear_bitmap() {
  for (uint8_t r = 0; r < ROWS; r++)
    for (uint8_t c = 0; c < COLS; c++)
      bitmap[r][c] = 0;
}

void render_character(int c) {
  clear_bitmap();
  for (uint8_t y = 0; y < ROWS; y++) {
    uint8_t byte = pgm_read_byte(&(charset[c][y]));
    for (uint8_t x = 0; x < COLS; x++) {
      if (byte & 0x01) bitmap[y][x] = 1;
      byte >>= 1;
    }
  }
}

void render_text_character(int ch) {
  int index = ch - ' ';
  clear_bitmap();
  for (uint8_t y = 0; y < ROWS; y++) {
    uint8_t byte = pgm_read_byte(&(FONT_CHARS[index][y]));
    for (uint8_t x = 0; x < COLS; x++) {
      if (byte & 0x01) bitmap[ROWS - 1 - y][x] = 1;
      byte >>= 1;
    }
  }
}

// ===== Animations =====

void render_checkerboard() {
  frame_delay = 300;
  for (uint8_t c = 0; c < COLS; c++)
    for (uint8_t r = 0; r < ROWS; r++)
      bitmap[r][c] = (r + c + frame) % 2;
}

void render_rain() {
  frame_delay = 19;
  clear_bitmap();
  int y;
  y = frame % 19; if (y < COLS) bitmap[0][y] = 1;
  y = frame % 11; if (y < COLS) bitmap[2][y] = 1;
  y = frame % 17; if (y < COLS) bitmap[4][y] = 1;
}

void render_psycho() {
  frame_delay = 30;
  render_character((frame % 2) ? 0 : 1);
}

void render_walls() {
  frame_delay = 20;
  switch (frame % 35) {
    case  0: render_character(16); break;
    case  1: render_character(17); break;
    case  2: render_character(18); break;
    case  3: render_character(19); break;
    case  4: render_character(20); break;
    case  5: render_character(21); break;
    case  6: render_character(22); break;
    case  7: render_character(23); break;
    case  8: render_character(24); break;
    case  9: render_character(25); break;
    case 10: render_character(26); break;
    case 11: render_character(27); break;
    case 12: render_character(28); break;
    case 13: render_character(29); break;
    case 14: render_character(30); break;
    case 15: render_character(31); break;
    case 16: render_character(32); break;
    case 17: render_character(33); break;
    case 18: render_character(34); break;
    case 19: render_character(33); break;
    case 20: render_character(32); break;
    case 21: render_character(31); break;
    case 22: render_character(30); break;
    case 23: render_character(29); break;
    case 24: render_character(28); break;
    case 25: render_character(27); break;
    case 26: render_character(26); break;
    case 27: render_character(25); break;
    case 28: render_character(24); break;
    case 29: render_character(23); break;
    case 30: render_character(22); break;
    case 31: render_character(21); break;
    case 32: render_character(20); break;
    case 33: render_character(19); break;
    case 34: render_character(18); break;
  }
}

void render_heartbeat() {
  frame_delay = 50;
  switch (frame % 10) {
    case 0: render_character(3); break;
    case 1: clear_bitmap();      break;
    case 2: render_character(3); break;
    case 3: clear_bitmap();      break;
  }
}

void render_fire() {
  int r;
  frame_delay = 40;
  clear_bitmap();

  r = (frame + 0) % 3; bitmap[0][6 - r] = 1;
  r = (frame + 1) % 2; bitmap[1][6 - r] = 1;
  r = (frame + 0) % 2; bitmap[2][6 - r] = 1;
  r = (frame + 1) % 2; bitmap[3][6 - r] = 1;
  r = (frame + 1) % 3; bitmap[4][6 - r] = 1;

  r = (frame + 1) % 5; bitmap[1][6 - r] = 1;
  r = (frame + 0) % 3; bitmap[2][6 - r] = 1;
  r = (frame + 2) % 5; bitmap[3][6 - r] = 1;

  r = (frame + 4) % 4; bitmap[0][6 - r] = 1;
  r = (frame + 1) % 4; bitmap[1][6 - r] = 1;
  r = (frame + 0) % 4; bitmap[2][6 - r] = 1;
  r = (frame + 3) % 4; bitmap[3][6 - r] = 1;
  r = (frame + 2) % 4; bitmap[4][6 - r] = 1;

  r = (frame + 0) % 19; if (r < COLS) bitmap[0][6 - r] = 1;
  r = (frame + 0) % 6;  if (r < COLS) bitmap[1][6 - r] = 1;
  r = (frame + 0) % 7;  if (r < COLS) bitmap[2][6 - r] = 1;
  r = (frame + 2) % 6;  if (r < COLS) bitmap[3][6 - r] = 1;
  r = (frame + 0) % 17; if (r < COLS) bitmap[4][6 - r] = 1;
}

void render_text(const char *text, int delay_ticks) {
  frame_delay = delay_ticks;
  int length = strlen(text);
  int index = (frame % (length << 1));
  render_text_character(text[index >> 1]);
}

// ===== Mode dispatcher =====

#define MODES 24
void render_buffer() {
  frame++;
  need_render_frame = false;
  switch (mode) {
    case  1: render_checkerboard();                    break;
    case  2: render_psycho();                          break;
    case  3: render_heartbeat();                       break;
    case  4: render_rain();                            break;
    case  5: render_fire();                            break;
    case  6: render_character(2);                      break;
    case  7: render_character(3);                      break;
    case  8: render_character(4);                      break;
    case  9: render_character(5);                      break;
    case 10: render_character(6);                      break;
    case 11: render_character(7);                      break;
    case 12: render_character(8);                      break;
    case 13: render_character(9);                      break;
    case 14: render_character(10);                     break;
    case 15: render_character(11);                     break;
    case 16: render_character(12);                     break;
    case 17: render_character(13);                     break;
    case 18: render_character(14);                     break;
    case 19: render_character(15);                     break;
    case 20: render_text("Happy Birthday Alex!   ", 163); break;
    case 21: render_text("-\\|/", 20);                 break;
    case 22: render_text("edc   ", 60);                break;
    case 23: render_text("EDC   ", 60);                break;
    case 24: render_walls();                           break;
  }
}

// Active-low pushbuttons with internal pull-ups, debounced by counter.
void check_inputs() {
  if (digitalRead(BUTTON1_PIN) == LOW) b1++; else b1 = 0;
  if (digitalRead(BUTTON2_PIN) == LOW) b2++; else b2 = 0;

  if (b2 == 10) { mode--; frame = -1; need_render_frame = true; }
  if (b1 == 10) { mode++; frame = -1; need_render_frame = true; }

  if (mode > MODES) mode = 1;
  if (mode < 1)     mode = MODES;
}

// ===== Refresh tick =====
//
// Original code used a Timer0 CTC ISR firing ~390 Hz to flip
// need_refresh_line. We poll micros() in loop() instead — no timer
// hardware grab, and easy to read.

void tick_refresh() {
  static unsigned long last_us = 0;
  unsigned long now = micros();
  if (now - last_us >= REFRESH_PERIOD_US) {
    last_us = now;
    need_refresh_line = true;
    if (++current_row >= ROWS) current_row = 0;
    if ((t++ % frame_delay) == 0) need_render_frame = true;
  }
}

// ===== Arduino entry points =====

void setup() {
  for (uint8_t r = 0; r < ROWS; r++) pinMode(ROW_PINS[r], OUTPUT);
  for (uint8_t c = 0; c < COLS; c++) pinMode(COL_PINS[c], OUTPUT);

  pinMode(BUTTON1_PIN, INPUT_PULLUP);
  pinMode(BUTTON2_PIN, INPUT_PULLUP);

  mode = 20;          // initial pattern (text scroll, like the original)
  frame = -1;
  frame_delay = 30;   // safe non-zero default until first render_buffer()
  reset_led();
}

void loop() {
  tick_refresh();
  if (need_render_frame) render_buffer();
  if (need_refresh_line) {
    refresh_line();
    check_inputs();
  }
}
