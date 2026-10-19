// Two daisy-chained 595s: SER=D11 SRCLK=D12 RCLK=D8. Sends 0xA5 then 0x3C.
void setup() { pinMode(8, OUTPUT); pinMode(11, OUTPUT); pinMode(12, OUTPUT); digitalWrite(8, LOW); }
void loop() {
  shiftOut(11, 12, MSBFIRST, 0xA5);
  shiftOut(11, 12, MSBFIRST, 0x3C);
  digitalWrite(8, HIGH); digitalWrite(8, LOW);
  delay(200);
}
