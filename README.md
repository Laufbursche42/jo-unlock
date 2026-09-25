# Laufbursche Joyor Tool (jo-unlock)

A static web page that talks to Joyor (and Lenzod-platform) e-scooters over Web Bluetooth. Connect from
the browser, read the live telemetry, lock and unlock the vehicle, switch the lights, the cruise and the
start mode, and set the walk-assist speed cap. Nothing to install: no app store, no signing, no developer
account. It runs in **Bluefy** on iOS and in **Chrome** on Android or desktop.

> **This is a feasibility study.** It exists to show what the Bluetooth protocol of these scooters
> makes possible, not to be a finished product. The protocol was reconstructed from the official app
> (Joyor, `com.yunshang.speed.joyor`, a white-label of Lenzod `cn.sccss.speed`, ViseBluetooth stack).
> Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it,
> you do at your own risk.

**Open the web app: [laufbursche42.github.io/jo-unlock](https://laufbursche42.github.io/jo-unlock/)**

Or run it yourself, no build step, no dependencies: clone the repo and serve the folder over a local
HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own
documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/jo-unlock.git
cd jo-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from
connecting to the first send.

## No encryption, and no top-speed register

Two facts decide what this tool can and cannot do, and both come straight from the app:

- **No encryption to configure.** The protocol is plaintext frames `FF 55 <REG> <LEN> <DATA...> <CHK>`
  with a trivial additive checksum. There is no pairing key, no bonding, no session key, no AES and no
  challenge-response. The only "PIN" is an optional app-level 6-digit lock code, sent in the clear.
- **There is no register that raises the top speed.** The app exposes exactly one speed register, `0x38`,
  and it is the walk-assist cap: a single byte in km/h times ten that only caps the speed **down** (the
  app itself resets it when it exceeds 18 km/h). The road top speed lives in the controller firmware and
  is never touched over Bluetooth. This tool does not invent one.

## The GATT service is unknown

The app matches its characteristics (write `0x8877`, notify `0x8888`) by UUID across every service and
never records a service UUID. Web Bluetooth, though, needs a service UUID up front. The page therefore
connects with **accept all devices** and probes a small list of common vendor BLE-serial services. If
your device's service is not in that list, the page connects but finds no matching characteristics and
says so. Read the real service UUID off the device with nRF Connect and add it to `CANDIDATE_SERVICES`
in `app.js`.

## What it does

- **Connect to the scooter** (accept-all scan, then probe the candidate services for `0x8877`/`0x8888`).
- **Read the telemetry** the scooter sends back: speed (`0x0A`), battery percent (`0x0D`), trip (`0x0B`),
  total (`0x0C`), lock state (`0x17` echo), self-test bitfield (`0x1E`) and the firmware version string
  (`0x03`). Temperature (`0x11`) and run time (`0x22`) appear in the log. Voltage, current and a max-speed
  value are **not** reported by this protocol, so those tiles stay a dash.
- **Lock and unlock the vehicle** (register `0x17`: `01` unlock, `02` lock). This is the immobilizer.
- **Cruise control on and off** (register `0x1D`).
- **Start mode** (register `0x1A`: zero-start vs non-zero-start).
- **Toggle the light** (register `0x23`).
- **Set the walk-assist speed cap** (register `0x38`, km/h times ten, caps down only).
- **Expert panel** to write any register with a short frame, send an 8-byte query, or send a raw frame.
  The page builds the header and additive checksum for you.

## Browser support

- **iOS:** the **Bluefy** browser. Safari and every other iOS browser run on the Safari engine, which
  has no Web Bluetooth at all.
- **Android or desktop:** **Chrome** or another Chromium browser. Web Bluetooth is built in.

There is no OTA firmware flashing here.

## Project structure

```
index.html               - the single page: cards, the model dropdown, the diagnostic log
app.js                   - all logic: frame builders, connect, decode, UI
i18n.js                  - the German and English string table
styles.css               - theme and layout
GUIDE.de.md, GUIDE.en.md - the step-by-step guide
tools/joyor_speed.py     - a Python (bleak) reference for the frame format
scripts/                 - check-i18n.js and security-scan.py (run in CI and the git hooks)
.github/workflows/       - CI (JS lint plus security scan) and CodeQL
.githooks/               - pre-commit and pre-push checks
```

## Development

No build step and no dependencies. Edit the files and reload the page. Serve locally, Web Bluetooth
needs `https` or `localhost`:

```
python -m http.server 8000
```

Run the same checks as the CI and the hooks:

```
node scripts/check-i18n.js
python scripts/security-scan.py
```

Enable the git hooks with `git config core.hooksPath .githooks`. New user-facing strings go into both
languages in `i18n.js`; `check-i18n.js` fails on a missing or unused key.

## Legal

Use it on your own vehicle only, on private ground. Changing settings over Bluetooth can leave a vehicle
outside the condition it was approved in; that responsibility is yours. Everything you do with this page
is at your own risk.

## License

PolyForm Noncommercial 1.0.0 with two additional terms, in full in [LICENSE.md](LICENSE.md).

## Privacy

Nothing leaves your device but the page load itself. The details are in [PRIVACY.md](PRIVACY.md).

## Trademarks

An independent project, not affiliated with Joyor or Lenzod. "Joyor" and the model names are trademarks
of their respective owners and are used here only to say which scooters this page works with. See
[TRADEMARKS.md](TRADEMARKS.md).
