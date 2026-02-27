# WebMast - A Browser-Native Intelligent Agent System for Multi-Tab Question Answering

![Chrome Extension](https://github.com/mlc-ai/mlc-llm/assets/11940172/0d94cc73-eff1-4128-a6e4-70dc879f04e0)

A Chrome extension that runs large language models **entirely in the browser** via WebGPU — no server, no API key, fully private. The extension adds a side panel for chatting with LLMs and can automatically read and summarize the current page to provide contextually relevant answers.

> [!WARNING]
> WebGPU in Service Workers is enabled by default starting from **Chrome 124**.
> On Chrome 123, navigate to `chrome://flags/#enable-experimental-web-platform-features`, enable the flag, and relaunch.

---

## Features

- **100% local inference** — model weights run on your GPU via WebGPU; nothing leaves your machine
- **Page-aware chat** — the content script extracts the current page's text, which is pre-summarized in the background so you can ask questions about any webpage
- **Streaming responses** — tokens stream back in real time with an animated progress bar during model load
- **Model switcher** — choose from the full WebLLM model catalog (filtered to < 8 GB VRAM); default is `Qwen3-1.7B-q4f16_1`
- **Manifest V3 + Side Panel** — modern extension architecture with a persistent side panel instead of a popup
- **Request cancellation** — in-flight inference can be aborted; requests are queued when the engine is busy

---

## Architecture

The extension is split into three isolated execution contexts that communicate via `chrome.runtime` messaging:

```
┌─────────────────────────────────────────────────┐
│  sidebar.ts  (Side Panel UI)                    │
│  · Chat interface, model selector, progress bar │
│  · Sends requests → Background                  │
│  · Renders streaming chunks ← Background        │
└────────────────────┬────────────────────────────┘
                     │ chrome.runtime messages
┌────────────────────▼────────────────────────────┐
│  background.ts  (Service Worker — control plane) │
│  · Routes requests, manages sessions & queues   │
│  · Creates / wakes the offscreen document       │
│  · Caches page summaries in chrome.storage      │
└────────────────────┬────────────────────────────┘
                     │ chrome.runtime messages
┌────────────────────▼────────────────────────────┐
│  offscreen.ts  (Offscreen Document — inference) │
│  · Initialises WebGPU via @mlc-ai/web-llm       │
│  · Loads model weights (cached after first run) │
│  · Streams tokens back, supports abort          │
└─────────────────────────────────────────────────┘

  content.js  (Content Script — injected into every tab)
  · Reads document.body.innerText on page load
  · Pushes content to Background for pre-summarisation
```

| File | Role |
|---|---|
| `src/manifest.json` | Manifest V3 declaration — permissions, side panel, offscreen, service worker |
| `src/background.ts` | Service worker: request routing, session management, offscreen lifecycle |
| `src/offscreen.ts` | Offscreen document: WebGPU engine init, model loading, streaming inference |
| `src/sidebar.ts` | Side panel UI: chat, model selection, progress display |
| `src/sidebar.html/css` | Side panel markup and styles |
| `src/content.js` | Content script: DOM text extraction and page pre-processing |
| `src/offscreen.html` | Minimal HTML host for the offscreen document |
| `src/example.html` | Static test page for verifying page-context chat |

---

## Requirements

- **Chrome 124+** (or Chrome 123 with `#enable-experimental-web-platform-features` enabled)
- A GPU that supports WebGPU (most modern discrete and integrated GPUs)
- Sufficient VRAM for your chosen model (default Qwen3-1.7B requires ~1.5 GB)

---

## Getting Started

### 1. Build

```bash
npm install
npm run build
```

The bundled extension is written to `./dist/` by [Parcel](https://parceljs.org/) using `@parcel/config-webextension`.

### 2. Load into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `./dist/` directory
4. Pin **WebMast** to your toolbar

### 3. Use

1. Click the WebMast icon → the side panel opens
2. The model downloads and caches on first run (progress bar shown)
3. Navigate to any webpage; the content script will automatically pre-process the page
4. Type a question — the model answers in the context of the current page

---

## Configuration

### Switch models

Open the **Settings** panel (gear icon) to pick a different model from the WebLLM catalog. The selection is persisted in `chrome.storage.local`.

### Disable page context

Set `useContext = false` in `src/sidebar.ts` to chat without injecting page content into the prompt. This is useful when the active tab is a restricted page (`chrome://`, `chrome-extension://`) or when the page content is very large.

For testing page-context features, open `src/example.html` directly as a local file.

---

## Project Structure

```
src/
├── manifest.json       # Extension manifest (V3)
├── background.ts       # Service worker (control plane)
├── offscreen.ts        # WebGPU inference (offscreen document)
├── offscreen.html      # Offscreen document host
├── sidebar.ts          # Side panel logic
├── sidebar.html        # Side panel markup
├── sidebar.css         # Side panel styles
├── content.js          # Content script (DOM extraction)
└── example.html        # Test page for page-context chat
```
