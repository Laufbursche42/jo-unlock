# Guide: Laufbursche Joyor unlock

> **Feasibility study.** This tool shows what the Bluetooth protocol of these scooters makes possible.
> It is not a finished product. Error-free operation is not promised and there is no warranty. Whatever
> you do with it, you do at your own risk and on your own vehicle only.

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## 1. What you need

Everything happens in the browser over Web Bluetooth: connect, read the live values, lock and unlock the
vehicle, switch the light, the cruise and the start mode, set the walk-assist cap. There is nothing to
install. You need:

**A browser that supports Web Bluetooth.**

- **iOS:** the **Bluefy** browser (free on the App Store). Safari and every other iOS browser run on
  the Safari engine, which has no Web Bluetooth at all.
- **Android or desktop:** **Chrome** or another Chromium browser. Web Bluetooth is built in.

**A Joyor (or a compatible Lenzod-platform) scooter.** The app is a white-label base, so the same
protocol serves the NIUNIU and HUABAN model families and many voltage classes (24 / 36 / 48 / 60 V) and
wheel sizes. Not every model exposes every function; the page shows the controls that apply and an
expert panel for the rest.

---

## 2. About the model dropdown and the GATT service

The model dropdown offers **Auto detect** plus the two families (NIUNIU, HUABAN). The families differ
only in how the self-test bitfield maps to components; they do not change the commands.

The more important point is the GATT service. The app matches its characteristics (write `0x8877`,
notify `0x8888`) by UUID across all services and never stores a service UUID. Web Bluetooth needs one up
front, so the page connects with **accept all devices** and probes a short list of common vendor
services. If your scooter's service is not in that list, the page connects but reports that it found no
matching characteristics. In that case read the real service UUID with nRF Connect and add it to
`CANDIDATE_SERVICES` in `app.js`.

---

## 3. Connect

1. Open the page in Bluefy or Chrome.
2. Turn the scooter on. Keep it a few meters next to the phone.
3. Tap **Connect** and choose your scooter in the browser chooser.
4. Watch the status top right: `connecting`, then `connected`, and the matched service in the log.

**Android: Location must be on.** On Android, Chrome only scans for Bluetooth when Location services
(GPS) are on and Chrome has the Location or Nearby-devices permission. Otherwise the device list stays
empty even though the scooter is right there. Also close the manufacturer app fully first (swipe it
away), otherwise it holds the connection and the scooter no longer advertises for the browser to see.
If in doubt, power the scooter off and on again right before you scan.

The page then polls the status frame (`FF 55 01 00 55`) about every 2 seconds, sends a keep-alive
(`FF 55 08 00 5C`) every 5 seconds, and fills the telemetry tiles as frames arrive.

---

## 4. Read live values

Once data arrives, the tiles fill in. This protocol reports:

- **Speed** (register `0x0A`), **battery** percent (`0x0D`), **trip** (`0x0B`), **total** (`0x0C`).
- **Lock** state, from the `0x17` echo.
- **Error**, from the `0x1E` self-test bitfield (0 means no fault; a non-zero value is a bit per
  component and its meaning differs between NIUNIU and HUABAN).
- **Firmware**, the `0x03` version string (for example `V0.12580`).

**Voltage, current and a max-speed value are not part of this protocol**, so those tiles stay a dash.
Temperature (`0x11`) and run time (`0x22`) are not tiled either; they appear in the log when the scooter
sends them.

---

## 5. Walk-assist speed cap (register 0x38)

This is the only speed register the app has, and it is important to understand what it does:

- It sets the **walk-assist / valet cap**, a single byte in km/h times ten. The app offers 3, 6, 9, 12
  and 15 km/h and resets the stored value if it goes above 18.
- It **caps the speed down**, for pushing or parking. It does **not** raise the road top speed. There is
  no register anywhere in the app that raises the top speed; that limit is in the controller firmware and
  is never sent over Bluetooth.

Enter a value in km/h, keep the target on `0x38`, and tap **Set**. The page sends the 8-byte frame
`FF 55 38 00 00 00 <VAL> 00` (no checksum on this frame family).

---

## 6. Lock and unlock the vehicle

This is the **immobilizer**, NOT the speed. Unlock releases the scooter, lock immobilizes it
(register `0x17`: `01` unlock, `02` lock, simple form without a PIN).

---

## 7. Cruise, start mode and light

- **Cruise** on / off: register `0x1D` (`01` on, `02` off).
- **Start mode**: register `0x1A` (`01` zero-start, `02` non-zero-start). Zero-start lets the motor run
  from a standstill; non-zero-start needs a kick first.
- **Light** on / off: register `0x23` (`02` on, `01` off).

---

## 8. Expert panel

For anything the dedicated buttons do not cover, or for a model where the exact register differs:

- **Write register (short frame):** enter a register and a value; the page builds
  `FF 55 <REG> <LEN> <DATA> <CHK>` with the additive checksum.
- **Read register (8-byte query):** send `FF 55 <REG> 00 00 00 <VAL> 00`. Use it for the identity
  queries (serial `0x61`, versions `0x3B`, model `0x3C`) or the limit query (`0x38`).
- **Send raw frame:** paste bytes; **Send** appends the additive checksum, **Send raw** sends them
  unchanged (use this for the checksum-less 8-byte frames).
- **Frame XOR:** none, because this protocol uses no XOR. The option is there only as a generic
  passthrough.

---

## 9. Test cleanly and report

Test on your own device on private ground only. The log at the bottom is a full transcript of every
byte sent and received. Report problems or successes as a
[GitHub issue](https://github.com/Laufbursche42/jo-unlock/issues) with the copied log so it is clear
what was sent and received. If you had to add your device's service UUID, please include it.

---

## 10. Limits worth knowing

- **No top-speed unlock exists.** Section 5 explains why. If you need more, it is a controller-firmware
  matter, not a Bluetooth one.
- Voltage, current, individual cell data, a separate motor-vs-controller temperature and numeric fault
  codes are **not** reported over Bluetooth.
- The real GATT service UUID must be read from the device once (nRF Connect).
- There is no firmware flashing here.

---

## 11. Legal

Use it on your own vehicle and at your own risk only. Changing settings over Bluetooth can leave a
vehicle outside the condition it was approved in; that responsibility is yours.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
