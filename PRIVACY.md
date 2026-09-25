# Privacy Policy

This web app is built to keep your data on your device. This policy explains exactly what it does and does not do with your data.

## The short version

The app collects nothing. There are no accounts, no analytics, no telemetry, no tracking, no ads, no cookies and no third-party scripts. Nothing is ever sent to the developer or to any manufacturer backend.

## What data the app handles and where it stays

All of the following stays on your device and is never uploaded anywhere:

- Live scooter data read over Bluetooth LE (the raw notifications the scooter sends back).
- Any settings you make on the page (walk-assist cap, register values, the language and theme choice). They exist only in the open page during your session, except the language and theme, which are stored in your browser's local storage on your device only.
- The on-screen log. It exists only in the open page during your session, is never stored and is never uploaded.

## The only network connection

The app makes network connections in exactly two cases and no others:

### 1. Loading the page

When you open or reload the page, your browser fetches the static files (`index.html`, `app.js`, `i18n.js`, `styles.css` and the favicon) from the host (for example GitHub Pages). The host sees only two things: your **IP address** and which file you requested. Those are the normal web-server logs every website has. It **never** sees any scooter data or commands: not at page load, not at reload, not at any time. That data never reaches any server at all; it exists only on your device and travels only over the local Bluetooth link (see below).

### 2. Bluetooth LE to your scooter

A local radio link to your scooter over Web Bluetooth. This is not an internet connection: no data leaves your device over the network for this. The commands (lock, light, cruise, start mode, walk-assist cap) and the notifications the scooter sends back travel only between your browser and the scooter.

## No developer or manufacturer backend

Nothing is ever sent to the developer or to any manufacturer backend. There is no cloud account and no server operated by this project that receives your data. For comparison: the original Joyor / Lenzod app can reach a manufacturer backend (for example an account or password check on connect). This app does none of that; its Bluetooth commands need no server and no token.

## Contact

For privacy questions, contact the author (Laufbursche) on GitHub: https://github.com/Laufbursche42
