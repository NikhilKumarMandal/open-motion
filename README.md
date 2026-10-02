# Open-Motions

**A free, open-source screen recorder for Chrome with automatic cinematic zoom & pan.**

Open-Motions records your browser tab, tracks your cursor and clicks, and turns the raw capture into a polished demo video — smoothly zooming in on the parts you interact with. Everything runs locally in your browser: no account, no uploads, no servers.

---

## Features

- **One-click recording** — record the current tab straight from the toolbar popup.
- **Cursor & click tracking** — cursor movement, clicks and keystrokes are captured alongside the video.
- **Automatic zoom & pan** — zooms in ahead of each click, pans between nearby clicks, follows the cursor while you scroll, and zooms back out during pauses.
- **Countdown** — an optional 3 or 5 second countdown on the recorded tab before recording starts.
- **Audio** — optionally record system/tab audio and your microphone.
- **Camera overlay** — optionally add your webcam to the recording.
- **Built-in editor**
  - Trim the start and end of a recording
  - Aspect ratio presets (Native, 16:9, and more)
  - Backgrounds and padding around the captured screen
  - Toggle zoom, click highlights, browser UI and the taskbar / Dock
  - Smooth, larger cursor drawn from your recorded mouse movement
  - Keystroke overlay for shortcuts like Ctrl+K or Enter (typing in text fields is never recorded)
  - Blur areas to hide emails, passwords or API keys, for the whole clip or part of it
  - Export presets for YouTube, X, LinkedIn and Reels / TikTok, plus animated GIF export
- **Quality controls** — 480p / 720p / 1080p at 24, 30 or 60 FPS.
- **100% offline & private** — recordings are processed on your device and never leave it.

## Installation

Open-Motions isn't on the Chrome Web Store yet, so install it as an unpacked extension:

1. Clone or download this repository:
   ```bash
   git clone <repository-url> open-motion
   ```
2. Open `chrome://extensions` in Chrome (or any Chromium browser such as Edge or Brave).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension to your toolbar.

Requires Chrome **102** or newer.

## Usage

1. Open the tab you want to record and click the Open-Motions icon.
2. Choose your options (cursor tracking, audio, microphone, quality, frame rate).
3. Click **Start Recording** and follow the on-screen steps to share the tab and, optionally, enable your camera and microphone.
4. Use the toolbar icon to **pause** or **stop** the recording.
5. When you stop, the editor opens — trim, pick an aspect ratio and background, tweak zoom, then **export** your video.

> Recording isn't possible on protected pages such as `chrome://` URLs, extension pages, or the Chrome Web Store.

## How auto-zoom works

`zoom-analyzer.js` reads the recorded cursor data and builds zoom segments:

- Zoom starts **~2 seconds before** a click, easing in over about a second.
- While clicks are close together, the camera **stays zoomed and pans** from one click to the next.
- If the next click is **5+ seconds away**, it zooms back out.

`video-processor.js` then renders the video frame by frame on a canvas, applying the zoom, background, padding and overlays before encoding the final file.

## Project structure

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker — recording state, messaging, storage |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup with recording controls and options |
| `record.html` / `record.js` | Recording setup page (screen share, camera, microphone) |
| `recorder.js` | Injected into the tab to run `MediaRecorder` |
| `offscreen.html` / `offscreen.js` | Offscreen document for media capture outside the service worker |
| `content.js` | Content script that tracks cursor movement, clicks and keystrokes |
| `zoom-analyzer.js` | Generates zoom/pan segments from cursor data |
| `video-processor.js` | Canvas renderer and encoder for the final video |
| `editor.html` / `editor.js` | Post-recording editor and export |
| `processor.html` / `processor-ui.js` | Standalone tool to add zoom effects to an existing recording |
| `icons/` | Extension icons |

## Privacy

Open-Motions does not collect, transmit or store any data outside your browser. Recordings and cursor data stay on your machine until you export them.

## Contributing

Contributions are welcome! To get started:

1. Fork the repository and create a feature branch.
2. Load the extension unpacked (see [Installation](#installation)) and make your changes.
3. Reload the extension from `chrome://extensions` to test.
4. Open a pull request describing what you changed and why.

Please report bugs and feature ideas through the issue tracker.

## License

Released under the [MIT License](LICENSE). Based on CursorFly by Anu S Pillai.
