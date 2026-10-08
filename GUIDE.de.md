# Anleitung: Laufbursche Joyor unlock

> **Machbarkeitsstudie.** Dieses Werkzeug zeigt, was das Bluetooth-Protokoll dieser Scooter möglich
> macht. Es ist kein fertiges Produkt. Ein fehlerfreier Betrieb wird nicht zugesichert und es gibt
> keine Gewähr. Was immer du damit tust, tust du auf eigenes Risiko und nur am eigenen Fahrzeug.

> **Wichtig für Fehler-Reports:** Schalte unten auf der Seite den **Diagnose-Log** ein, *bevor* du dich mit dem Scooter verbindest. Nur dann wird der komplette Verbindungsaufbau mitgeschnitten - und genau diese Zeilen brauchen wir in einem [Ticket](https://github.com/Laufbursche42/Laufbursche42/issues), um ein Problem nachzuvollziehen.

## 1. Was du brauchst

Alles läuft im Browser über Web Bluetooth: verbinden, Live-Werte lesen, das Fahrzeug sperren und
entsperren, Licht, Tempomat und Startmodus schalten, den Schiebehilfe-Deckel setzen. Es gibt nichts zu
installieren. Du brauchst:

**Einen Browser mit Web-Bluetooth-Unterstützung.**

- **iOS:** den Browser **Bluefy** (kostenlos im App Store). Safari und jeder andere iOS-Browser laufen
  auf der Safari-Engine, die kein Web Bluetooth hat.
- **Android oder Desktop:** **Chrome** oder ein anderer Chromium-Browser. Web Bluetooth ist eingebaut.

**Einen Joyor (oder einen kompatiblen Scooter der Lenzod-Plattform).** Die App ist eine
White-Label-Basis, daher bedient dasselbe Protokoll die Modellfamilien NIUNIU und HUABAN sowie mehrere
Spannungsklassen (24 / 36 / 48 / 60 V) und Radgrößen. Nicht jedes Modell bietet jede Funktion an; die
Seite zeigt die passenden Bedienelemente und ein Experten-Panel für den Rest.

---

## 2. Zum Modell-Menü und zum GATT-Dienst

Das Modell-Menü bietet **Auto-Erkennung** sowie die beiden Familien (NIUNIU, HUABAN). Die Familien
unterscheiden sich nur darin, wie das Selbsttest-Bitfeld auf Komponenten abgebildet wird; die Kommandos
ändern sich dadurch nicht.

Wichtiger ist der GATT-Dienst. Die App findet ihre Merkmale (Schreiben `0x8877`, Notify `0x8888`) über
die UUID quer durch alle Dienste und merkt sich nie eine Dienst-UUID. Web Bluetooth braucht sie aber
vorab, daher verbindet die Seite mit **alle Geräte annehmen** und probiert eine kurze Liste gängiger
Hersteller-Dienste durch. Ist der Dienst deines Scooters nicht dabei, verbindet die Seite zwar, meldet
aber, dass sie keine passenden Merkmale gefunden hat. Lies dann die echte Dienst-UUID mit nRF Connect aus
und trage sie in `CANDIDATE_SERVICES` in `app.js` ein.

---

## 3. Verbinden

1. Öffne die Seite in Bluefy oder Chrome.
2. Schalte den Scooter ein. Halte ihn ein paar Meter neben das Telefon.
3. Tippe auf **Verbinden** und wähle deinen Scooter im Browser-Dialog.
4. Beobachte den Status oben rechts: `verbinde`, dann `verbunden` und den erkannten Dienst im Protokoll.

**Android: Standort muss an sein.** Unter Android sucht Chrome nur nach Bluetooth, wenn der
Standortdienst (GPS) an ist und Chrome die Berechtigung Standort oder Geräte in der Nähe hat. Sonst
bleibt die Geräteliste leer, obwohl der Scooter direkt daneben steht. Schließe außerdem zuerst die
Hersteller-App vollständig (wegwischen), sonst hält sie die Verbindung und der Scooter meldet sich
nicht mehr für den Browser. Im Zweifel den Scooter direkt vor dem Suchen aus- und wieder einschalten.

Die Seite pollt danach das Status-Frame (`FF 55 01 00 55`) etwa alle 2 Sekunden, sendet alle 5 Sekunden
einen Keep-Alive (`FF 55 08 00 5C`) und füllt die Telemetrie-Kacheln, sobald Frames ankommen.

---

## 4. Live-Werte lesen

Sobald Daten ankommen, füllen sich die Kacheln. Dieses Protokoll meldet:

- **Tempo** (Register `0x0A`), **Akku** in Prozent (`0x0D`), **Fahrt** (`0x0B`), **Gesamt** (`0x0C`).
- **Sperre**, aus dem `0x17`-Echo.
- **Fehler**, aus dem `0x1E`-Selbsttest-Bitfeld (0 heißt kein Fehler; ein Wert ungleich 0 ist ein Bit je
  Komponente, dessen Bedeutung sich zwischen NIUNIU und HUABAN unterscheidet).
- **Firmware**, die `0x03`-Versionszeichenkette (zum Beispiel `V0.12580`).

**Spannung, Strom und ein Max-Tempo-Wert gehören nicht zu diesem Protokoll**, daher bleiben diese
Kacheln ein Strich. Temperatur (`0x11`) und Laufzeit (`0x22`) haben ebenfalls keine Kachel; sie stehen
im Protokoll, wenn der Scooter sie sendet.

---

## 5. Schiebehilfe-Deckel (Register 0x38)

Das ist das einzige Geschwindigkeits-Register der App, und es ist wichtig zu verstehen, was es tut:

- Es setzt den **Schiebehilfe- beziehungsweise Valet-Deckel**, ein einzelnes Byte in km/h mal zehn. Die
  App bietet 3, 6, 9, 12 und 15 km/h und setzt den gespeicherten Wert zurück, wenn er über 18 liegt.
- Es **senkt das Tempo ab**, zum Schieben oder Parken. Es **hebt das Straßen-Topspeed nicht an**. Es gibt
  in der ganzen App kein Register, das die Höchstgeschwindigkeit anhebt; diese Grenze liegt in der
  Controller-Firmware und wird nie über Bluetooth gesendet.

Trage einen Wert in km/h ein, lass das Ziel auf `0x38` und tippe auf **Setzen**. Die Seite sendet das
8-Byte-Frame `FF 55 38 00 00 00 <VAL> 00` (diese Frame-Familie hat keine Prüfsumme).

---

## 6. Fahrzeug sperren und entsperren

Das ist die **Wegfahrsperre**, NICHT die Geschwindigkeit. Entsperren gibt den Scooter frei, Sperren
blockiert ihn (Register `0x17`: `01` entsperren, `02` sperren, einfache Form ohne PIN).

---

## 7. Tempomat, Startmodus und Licht

- **Tempomat** an / aus: Register `0x1D` (`01` an, `02` aus).
- **Startmodus**: Register `0x1A` (`01` Zero-Start, `02` Nicht-Zero-Start). Zero-Start lässt den Motor
  aus dem Stand anlaufen; Nicht-Zero-Start braucht erst einen Anstoß.
- **Licht** an / aus: Register `0x23` (`02` an, `01` aus).

---

## 8. Experten-Panel

Für alles, was die festen Knöpfe nicht abdecken oder für ein Modell mit abweichendem Register:

- **Register schreiben (kurzes Frame):** Register und Wert eingeben; die Seite baut
  `FF 55 <REG> <LEN> <DATA> <CHK>` mit der additiven Prüfsumme.
- **Register lesen (8-Byte-Query):** sendet `FF 55 <REG> 00 00 00 <VAL> 00`. Nützlich für die
  Identitäts-Abfragen (Seriennummer `0x61`, Versionen `0x3B`, Modell `0x3C`) oder die Limit-Abfrage
  (`0x38`).
- **Roh-Frame senden:** Bytes einfügen; **Senden** hängt die additive Prüfsumme an, **Roh senden**
  schickt sie unverändert (für die prüfsummenlosen 8-Byte-Frames).
- **Frame-XOR:** keiner, denn dieses Protokoll nutzt kein XOR. Die Option ist nur ein generischer
  Durchreicher.

---

## 9. Sauber testen und melden

Teste nur am eigenen Gerät auf privatem Gelände. Das Protokoll unten ist ein vollständiger Mitschnitt
jedes gesendeten und empfangenen Bytes. Melde Probleme oder Erfolge als
[GitHub-Issue](https://github.com/Laufbursche42/jo-unlock/issues) mit dem kopierten Protokoll, damit
klar ist, was gesendet und empfangen wurde. Falls du die Dienst-UUID deines Geräts ergänzen musstest,
gib sie bitte mit an.

---

## 10. Grenzen, die man kennen sollte

- **Es gibt kein Topspeed-Unlock.** Abschnitt 5 erklärt, warum. Wer mehr will, ist bei der
  Controller-Firmware, nicht bei Bluetooth.
- Spannung, Strom, einzelne Zelldaten, eine getrennte Motor- und Controller-Temperatur sowie numerische
  Fehlercodes werden **nicht** über Bluetooth gemeldet.
- Die echte GATT-Dienst-UUID muss einmal vom Gerät gelesen werden (nRF Connect).
- Es gibt hier kein Firmware-Flashen.

---

## 11. Rechtliches

Nutze es nur am eigenen Fahrzeug und auf eigenes Risiko. Das Ändern von Einstellungen über Bluetooth kann
ein Fahrzeug außerhalb des Zustands bringen, in dem es genehmigt wurde; diese Verantwortung liegt bei
dir.

## Mithelfen
Willst du herausfinden, ob und wie Tuning bei deinem Scooter geht? Teste dieses Tool an deinem eigenen Fahrzeug und öffne ein Ticket auf [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - mit deinem Modell und was funktioniert hat (oder nicht). So finden wir gemeinsam heraus, was bei welchem Modell möglich ist.
