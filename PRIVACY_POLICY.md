# Privacy Policy

**Open-Motions – Open Source Screen Recorder with Auto Zoom**

_Effective date: October 2, 2026_

This Privacy Policy explains how the Open-Motions browser extension ("Open-Motions", "the extension", "we") handles your information. Open-Motions is a free, open-source screen recorder. Its full source code is available at <https://github.com/NikhilKumarMandal/open-motion>, so every statement below can be verified.

## Summary

- **We do not collect, store, sell, or share any of your personal data.**
- Recordings, cursor data and settings are processed and stored **only on your device**.
- Open-Motions has **no servers, no accounts, no analytics, no tracking, and no advertising**.
- Nothing you record is ever uploaded by the extension.

## What the extension handles, and where it stays

All of the following data is created and used locally inside your browser. None of it is transmitted to us or to any third party by the extension.

| Data | Why it is used | Where it is kept |
| --- | --- | --- |
| **Screen / tab video** you choose to share | To create your recording | In memory and in your browser's local IndexedDB storage on your device |
| **Tab or system audio** (only if you enable it in Chrome's sharing dialog) | To include sound in your recording | Inside the local recording |
| **Microphone audio** (only if you click "Enable microphone") | To include your voice in your recording | Inside the local recording |
| **Camera video** (only if you click "Enable camera") | To show a picture-in-picture webcam overlay | Inside the local recording |
| **Cursor position, clicks and scroll events** on the tab being recorded, while recording | To generate automatic zoom & pan and to draw a smooth cursor and click highlights | In memory and in local storage alongside the recording |
| **Shortcut / navigation keys** (e.g. Ctrl+K, Enter, arrow keys) while recording | To optionally display a keystroke overlay in your video | Alongside the recording, locally |
| **Settings** (quality, frame rate, audio and cursor options, countdown) | To remember your preferences | `chrome.storage.local` and `localStorage` on your device |

**Typing is never recorded.** Keystrokes made inside text fields, text areas and editable content are ignored, and ordinary letter/number keys are not captured. Only shortcut and navigation keys are recorded, and only while a recording is active.

Cursor and keystroke tracking runs **only while you are actively recording**. When you are not recording, the content script does not collect anything.

Exported videos and GIFs are saved to your computer through Chrome's normal download flow. What you do with them afterwards is up to you.

## Permissions and why they are needed

| Permission | Purpose |
| --- | --- |
| `desktopCapture` | Lets you choose a screen, window or tab to record. Chrome always asks you to pick what to share. |
| `activeTab`, `tabs` | Identifies the tab you want to record, opens the recording and editor pages, and returns you to your tab when recording starts. |
| `scripting` and host access (`<all_urls>`) | Injects the cursor-tracking script into the tab you are recording so auto-zoom works on any website. It is used only for recording, and only in the tab you record. |
| `storage` | Saves your settings and the current recording state locally. |

Camera and microphone access are requested by Chrome only when you click the corresponding button, and you can revoke them at any time in Chrome's site settings.

## Third-party services

Open-Motions does not integrate any third-party analytics, advertising, crash-reporting or tracking services.

The extension's recording and editor pages load the **Geist** typeface from **Google Fonts** (`fonts.googleapis.com` / `fonts.gstatic.com`). When those pages open, your browser requests the font files from Google, which may receive standard request information such as your IP address and browser user agent. No recording content or personal data is sent with these requests. See [Google's Privacy Policy](https://policies.google.com/privacy) for how Google handles these requests.

If you try to start a recording on a page Chrome does not allow extensions to access (for example `chrome://` pages or the Chrome Web Store), the extension may open a new tab at `https://www.google.com` so there is a normal page to record. That is an ordinary page visit in your browser; the extension sends no data to it.

## Data retention and deletion

Because all data is stored on your device, you are in full control of it:

- Recordings remain in the extension's local browser storage until you delete them.
- You can delete all extension data, including stored recordings and settings, at any time by removing the extension from `chrome://extensions`.
- We hold no copy of your data, so there is nothing for us to delete or hand over.

## Chrome Web Store User Data Policy

The use of information by Open-Motions complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the **Limited Use** requirements. Specifically:

- Data is used only to provide the extension's single purpose: recording your screen and producing an edited video.
- Data is not transferred to any third party.
- Data is not used for advertising, personalised or otherwise.
- Data is not used to determine creditworthiness or for lending purposes.
- Data is not sold, and no human reads your data.

## Children's privacy

Open-Motions does not knowingly collect any personal information from anyone, including children under 13.

## Your responsibility when recording

You are responsible for what you choose to record and share. Please make sure you have permission to record other people, meetings, or content that is not yours, and that you follow the laws that apply to you. The editor's blur tool can help you hide sensitive details such as emails, passwords or API keys before exporting.

## Changes to this policy

If this policy changes, the updated version will be published in this file in the GitHub repository and the effective date above will be updated. The full change history is visible in the repository's commit log.

## Contact

If you have questions about this policy or about privacy in Open-Motions, or need any help, you can contact us:

- **Email:** [kumarnikhil48578@gmail.com](mailto:kumarnikhil48578@gmail.com)
- **GitHub Issues:** <https://github.com/NikhilKumarMandal/open-motion/issues>
