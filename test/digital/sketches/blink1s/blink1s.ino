// D13 toggles every 1000 ms (delay); D12 toggles every 10 ms (delay)
void setup() { pinMode(13, OUTPUT); pinMode(12, OUTPUT); }
unsigned long last = 0; bool s13 = false;
void loop() {
  digitalWrite(12, !digitalRead(12)); delay(10);
  if (millis() - last >= 1000) { last += 1000; s13 = !s13; digitalWrite(13, s13); }
}
