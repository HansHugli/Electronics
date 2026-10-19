void setup() { pinMode(2, INPUT_PULLUP); pinMode(3, INPUT); pinMode(13, OUTPUT); pinMode(12, OUTPUT); }
void loop() { digitalWrite(13, digitalRead(2)); digitalWrite(12, digitalRead(3)); }
