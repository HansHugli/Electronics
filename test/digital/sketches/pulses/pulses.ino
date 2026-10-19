// 37 pulses (5 ms high / 5 ms low) on D7 after 50 ms, then idle.
void setup() {
  pinMode(7, OUTPUT); digitalWrite(7, LOW); delay(50);
  for (int i = 0; i < 37; i++) { digitalWrite(7, HIGH); delay(5); digitalWrite(7, LOW); delay(5); }
}
void loop() {}
