#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

//confg del sensor.
const bool USE_TEST_MODE = true;      // true = envía valor fijo, false = usa el sensor
const float TEST_PH_VALUE = 7.00;     // Valor pruebas

float calibration_value = 21.34;      

int buffer_arr[10], temp;
unsigned long int avgval;
float ph_act;

void setup() {
  Serial.begin(9600);

  
  lcd.init();
  lcd.backlight();

  lcd.setCursor(0, 0);
  lcd.print("pH:");
}

void loop() {

  // modo de prueba
  if (USE_TEST_MODE) {

    Serial.println(TEST_PH_VALUE, 2);

    lcd.setCursor(4, 0);
    lcd.print("      ");     // Borra el valor anterior
    lcd.setCursor(4, 0);
    lcd.print(TEST_PH_VALUE, 2);

    delay(500);
    return;
  }

  // Lectura del sensor
  for (int i = 0; i < 10; i++) {
    buffer_arr[i] = analogRead(A0);
    delay(30);
  }

  // Ordenar lecturas
  for (int i = 0; i < 9; i++) {
    for (int j = i + 1; j < 10; j++) {
      if (buffer_arr[i] > buffer_arr[j]) {
        temp = buffer_arr[i];
        buffer_arr[i] = buffer_arr[j];
        buffer_arr[j] = temp;
      }
    }
  }

  avgval = 0;
  for (int i = 2; i < 8; i++) {
    avgval += buffer_arr[i];
  }

  float volt = (float)avgval * 5.0 / 1024.0 / 6.0;
  ph_act = -5.70 * volt + calibration_value;

  
  Serial.println(ph_act, 2);

  
  lcd.setCursor(4, 0);
  lcd.print("      ");      
  lcd.setCursor(4, 0);
  lcd.print(ph_act, 2);

  delay(500);
}
