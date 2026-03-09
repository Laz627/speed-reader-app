# Speed Reader PWA — Kokoro TTS Mobile Integration

## Technical Documentation & Development History

**Last updated:** March 9, 2026
**Repo:** https://github.com/Laz627/speed-reader-app
**Live:** https://laz627.github.io/speed-reader-app/

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [TTS System Design](#tts-system-design)
3. [Mobile WebGPU — What Works and What Doesn't](#mobile-webgpu)
4. [Smart Chunking System](#smart-chunking)
5. [Pre-generation & Buffering Strategy](#pre-generation)
6. [Infrastructure (HF Space, Cloudflare Worker)](#infrastructure)
7. [Service Worker](#service-worker)
8. [Debug System](#debug-system)
9. [Settings & Preferences](#settings)
10. [Approaches Tried & Outcomes](#approaches-tried)
11. [Known Limitations](#known-limitations)
12. [Future Improvements](#future-improvements)
13. [File Inventory](#file-inventory)
14. [Key Code Locations](#key-code-locations)

---

## 1. Architecture Overview <a name="architecture-overview"></a>

The Speed Reader is a single `index.html` file (~3700 lines), built with React 18 via CDN (no JSX, uses `React.createElement`). It supports two reading modes:

- **RSVP Mode:** Rapid Serial Visual Presentation — displays words one at a time with ORP (Optimal Recognition Point) highlighting. Fully working, don't touch.
- **Listen Mode:** AI-powered text-to-speech using Kokoro TTS (82M parameter model). This is the focus of this document.

### Tech Stack

| Layer | Tool | Notes |
|-------|------|-------|
| UI Framework | React 18 via CDN | No JSX, `createElement` calls |
| EPUB Parsing | JSZip via CDN | Extracts chapters from EPUB archives |
| TTS Model | Kokoro-82M (ONNX) | Via kokoro-js library |
| TTS Runtime | transformers.js v4 | New C++ WebGPU runtime, loaded via esm.sh |
| Fallback Runtime | transformers.js v3 | Via jsdelivr CDN if esm.sh fails |
| Service Worker | Custom, v18 | Cache-first with domain passthrough list |

### Dependencies (CDN)

```
React 18:       https://unpkg.com/react@18/umd/react.production.min.js
ReactDOM 18:    https://unpkg.com/react-dom@18/umd/react-dom.production.min.js
JSZip:          https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
kokoro-js:      https://esm.sh/kokoro-js@1.2.1?deps=@huggingface/transformers@next
                (fallback: https://cdn.jsdelivr.net/npm/kokoro-js@1/+esm)
Eruda:          https://cdn.jsdelivr.net/npm/eruda (mobile debug console)
```

---

## 2. TTS System Design <a name="tts-system-design"></a>

### KokoroTTSManager Class

The core TTS engine. Singleton instance `kokoroManager`, referenced via `ttsManager`.

**Key properties:**
- `tts` — The KokoroTTS model instance
- `audioContext` — Web Audio API context
- `gainNode` — Volume control
- `_queue` — AudioBuffer playback queue
- `_preCache` — Pre-generated AudioBuffer cache (`{ "chapterIdx:paraIdx": AudioBuffer }`)
- `_prePromises` — In-flight pre-generation promises
- `_loadedDtype` — The dtype currently loaded (for re-init detection)

**Key methods:**
- `init(onProgress, opts)` — Downloads and initializes the model. `opts.dtype` controls precision.
- `streamParagraph(text, voice, speed, onFirst, onDone)` — Generates audio for a paragraph. On mobile, uses smart chunking (~300 chars). On desktop, uses sentence-by-sentence streaming.
- `pregenerate(key, text, voice, speed)` — Generates audio in background and stores in `_preCache`. Uses smart chunking and concatenates results into a single AudioBuffer.
- `playBuffer(buf, onEnd)` — Plays an AudioBuffer directly (used for cache hits).
- `_toBuf(result)` — Converts any kokoro-js output shape to a Web Audio AudioBuffer.

### Device & Dtype Selection

```javascript
// Device: always try WebGPU first (including mobile)
let device = 'wasm';
if (navigator.gpu) {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter) device = 'webgpu';
}

// Dtype: fp32 required on mobile, user-selectable on desktop
const dtype = IS_MOBILE ? 'fp32' : (device === 'webgpu' ? preferredDtype : 'q8');
```

### Why fp32 on mobile?

Lower precision formats (fp16, q8, q4, q4f16) produce **silent audio** on mobile WebGPU despite generating valid AudioBuffers with correct duration and metadata. This was confirmed by testing all five dtypes on a Pixel 9 Pro — only fp32 produces audible output. The root cause is in the ONNX Runtime WebGPU shader implementation for mobile GPUs. See [Approaches Tried](#approaches-tried) for details.

---

## 3. Mobile WebGPU — What Works and What Doesn't <a name="mobile-webgpu"></a>

### The Original Problem

Kokoro TTS works perfectly on desktop Chrome via WebGPU. On Android Chrome (tested on Pixel 9 Pro), the original implementation (transformers.js v3, q8 dtype) produced **garbled/corrupted audio**. This is a confirmed upstream bug:
- [transformers.js #1320](https://github.com/huggingface/transformers.js/issues/1320)
- [kokoro #193](https://github.com/hexgrad/kokoro/issues/193)

### The Solution

Two changes fixed mobile WebGPU:

1. **transformers.js v4** — Released Feb 2026 with a completely rewritten C++ WebGPU runtime. Loaded via `esm.sh` dependency override: `https://esm.sh/kokoro-js@1.2.1?deps=@huggingface/transformers@next`

2. **fp32 dtype** — The only precision that produces audible audio on mobile WebGPU. All quantized formats (fp16, q8, q4, q4f16) produce silent buffers.

### Performance Characteristics (Pixel 9 Pro, fp32/WebGPU)

| Metric | Value |
|--------|-------|
| Model download | ~330MB (one-time, cached by browser) |
| Generation speed | ~6-7s per sentence, ~20-25s per typical paragraph |
| Audio-to-generation ratio | Roughly 1:1 (25s audio takes ~22s to generate) |
| Voice quality | Identical to desktop |

**Critical finding:** All dtype variants produce identical generation speeds on the Pixel 9 Pro. The bottleneck is not compute precision but likely ONNX Runtime's shader dispatch overhead or memory bandwidth. There is no speed benefit to using quantized models on this device.

---

## 4. Smart Chunking System <a name="smart-chunking"></a>

### The Problem

Kokoro has a ~510 token context limit. Sending a full long paragraph (20-30 sentences, 800+ chars) as a single `generate()` call causes the tail end to degrade into whispers/garbling as it exceeds the context window.

### The Solution

Paragraphs are split into chunks of ~300 characters, splitting on sentence boundaries:

```javascript
const sentences = text.match(/[^.!?]*[.!?]+["'"'\u201D\u2019]?\s*/g) || [text];
const chunks = [];
let current = '';
for (const s of sentences) {
  const t = s.trim();
  if (!t) continue;
  if (current.length > 0 && (current.length + t.length) > 300) {
    chunks.push(current);
    current = t;
  } else {
    current += (current ? ' ' : '') + t;
  }
}
if (current.trim()) chunks.push(current.trim());
```

### Why 300 chars?

- **400 chars** — original limit, caused degradation on dense prose (long words tokenize heavier)
- **300 chars** — provides safe headroom, minor degradation may still occur on rare edge cases but is significantly improved
- Each chunk generates cleanly, and chunks are played sequentially via the audio queue or concatenated for pre-gen cache

### Chunking in Pre-generation

Pre-gen uses the same 300-char chunking, generates each chunk sequentially, then concatenates into a single AudioBuffer:

```javascript
const combined = audioContext.createBuffer(1, totalLength, sampleRate);
const channel = combined.getChannelData(0);
let offset = 0;
for (const buf of buffers) {
  channel.set(buf.getChannelData(0), offset);
  offset += buf.length;
}
```

---

## 5. Pre-generation & Buffering Strategy <a name="pre-generation"></a>

### Architecture

Two completely separate React effects:

**Effect 1: Continuous Pre-gen Loop** (`pregenRunningRef`)
- Starts when listening begins
- Generates paragraphs sequentially from 0 to end of chapter
- Lives on a ref — survives paragraph advances, only cancels on pause/mode/chapter change
- Uses `pregenCancelRef` (not the play effect's `cancelled` variable)

**Effect 2: Play Current Paragraph**
- Checks `_preCache` for the current paragraph
- If cached: plays instantly via `playBuffer()`
- If not cached (on mobile): polls every 300ms waiting for pre-gen to catch up (120s timeout)
- If not cached (on desktop): generates live via `streamParagraph()`

### Initial Buffer (Mobile Only)

On the first paragraph of a chapter, playback waits for pre-gen to build a buffer:

- **Target:** 120 seconds of cached audio (measured by actual AudioBuffer durations)
- **Max wait:** 90 seconds wall clock
- **Only counts contiguous cached paragraphs from start** (gap in the middle doesn't count)
- Prevents the "lockstep" problem where short header paragraphs (2s audio) burn through cache faster than pre-gen can fill it

### Why Not Parallel Pre-gen?

Mobile GPU can only run one `generate()` call at a time. Concurrent pre-gen requests queue behind each other on the GPU. With sentence-by-sentence streaming, concurrent pre-gen was stealing GPU time from the current paragraph's generation, causing 60s+ timeouts. Sequential pre-gen in a single loop is optimal.

### Cache Lifecycle

- Cache key format: `"chapterIndex:paragraphIndex"` (e.g., `"11:7"`)
- Cache persists across paragraph advances (play effect cleanup preserves it)
- Cache is cleared on: mode change, chapter change, voice/speed change, `fullStop()`
- `usePregen(key)` removes a used entry from cache after playback starts
- `getPregen(key)` waits for in-flight promise if generation is in progress

### Pre-gen Cancellation

`pregenCancelRef` is a React ref that:
- Resets to `false` when the play effect starts
- Sets to `true` when `mode !== 'listen'` or `!isListenPlaying` or `chapterIndex` changes
- The pre-gen loop checks it before each paragraph generation

**Critical bug that was fixed:** Originally, pre-gen used the play effect's `cancelled` variable. This variable gets set to `true` every time the paragraph index changes (React re-runs the effect, cleanup fires). Short cached paragraphs advancing rapidly would kill and restart pre-gen every few seconds, preventing it from ever generating uncached paragraphs ahead.

---

## 6. Infrastructure <a name="infrastructure"></a>

### HuggingFace Space (Laz627/Kokoro-TTS)

**URL:** https://huggingface.co/spaces/Laz627/Kokoro-TTS
**Purpose:** Server-side Kokoro TTS for potential future use (currently unused — local WebGPU is the active path)
**Hardware:** CPU Basic (free tier)
**Python:** 3.12 (pinned in README.md — kokoro>=0.9.4 requires <3.13)

**Key files:**
- `app.py` — CPU-only Gradio app with `generate_paragraph` endpoint (concatenates all sentence audio server-side)
- `requirements.txt` — CPU-only PyTorch + kokoro + gradio

**API endpoints:**
- `/predict` — Single sentence generation
- `/generate_paragraph` — Full paragraph generation (server handles sentence splitting + concatenation)
- `/generate_first` — First sentence only (returns audio + phonemes)
- `/generate_all` — Streaming generation (yields sentence-by-sentence)

**Why it exists:** The original approach was to use the HF Space API for mobile TTS (server-side GPU inference). This was blocked by:
1. hexgrad's original Space has `api_open=False` (returns 403)
2. HF's edge proxy blocks cross-origin browser requests to Space APIs (403 with Origin header)
3. CPU Basic inference is ~6s per sentence — too slow for real-time streaming

**Current status:** Space is running and functional but unused. The Cloudflare Worker proxy makes it accessible from the browser. Could be reactivated if HF Pro ($9/mo) is purchased for GPU acceleration.

### Cloudflare Worker (kokoro-proxy)

**URL:** https://kokoro-proxy.brandonlazovic.workers.dev
**Purpose:** CORS proxy for HF Space API (strips Origin header to bypass HF's cross-origin block)
**Tier:** Free (100K requests/day)

**How it works:**
1. Browser sends request to `kokoro-proxy.workers.dev/gradio_api/call/predict`
2. Worker strips `Origin` and `Referer` headers
3. Forwards to `laz627-kokoro-tts.hf.space/gradio_api/call/predict`
4. Adds CORS headers to response
5. Returns to browser

**Allowed origins:** `https://laz627.github.io`, `http://localhost:8080`, `http://localhost:3000`

**Current status:** Deployed and functional but unused (local WebGPU is the active path). Available as fallback if local inference becomes untenable.

---

## 7. Service Worker <a name="service-worker"></a>

**File:** `sw.js`
**Cache version:** `speedreader-v18`

### Cached Assets

```
./
./index.html
./manifest.json
React 18 (unpkg CDN)
ReactDOM 18 (unpkg CDN)
JSZip (cdnjs CDN)
```

### Passthrough Domains

These domains are **never intercepted** by the service worker. Requests pass directly to the network:

```javascript
const PASSTHROUGH_DOMAINS = [
  'hf.space',          // HuggingFace Space API
  'huggingface.co',    // HuggingFace model downloads
  'gradio.live',       // Gradio API
  'workers.dev',       // Cloudflare Worker proxy
  'esm.sh',           // transformers.js v4 dynamic import
  'cdn.jsdelivr.net',  // kokoro-js fallback import
];
```

**Why this matters:** The original service worker (v15) intercepted ALL GET requests including cross-origin API calls. On mobile Chrome, calling `response.clone()` + `cache.put()` on SSE (`text/event-stream`) responses causes them to hang silently. Adding passthrough domains was the first fix that unblocked mobile TTS.

### Cache Strategy

Cache-first, network-fallback for non-passthrough GET requests. Responses are cloned and cached on fetch. `.onnx` and `.wasm` files are also skipped (too large for service worker cache).

### Version Bumping

Increment `CACHE_NAME` version number when deploying changes. Users must **clear site data** to pick up new service worker versions — the PWA serves cached `index.html` by default.

---

## 8. Debug System <a name="debug-system"></a>

### Debug Overlay

A green "DBG" button in the bottom-right corner toggles an on-screen debug log. All `console.log`, `console.error`, and `console.warn` calls are captured and displayed with timestamps.

### Eruda Mobile Console

Full DevTools panel on mobile via the green gear icon (Eruda library). Loaded from CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/eruda"></script>
<script>if (typeof eruda !== 'undefined') eruda.init();</script>
```

### Debug Log Prefixes

| Prefix | Source |
|--------|--------|
| `[TTS]` | KokoroTTSManager — model loading, chunk generation |
| `[PLAY]` | Listen effect — paragraph playback |
| `[AUDIO]` | playBuffer — AudioContext state, gain, timing |
| `[PREGEN]` | Continuous pre-gen loop |
| `[BUFFER]` | Initial chapter buffer (mobile) |
| `[INIT]` | Model initialization |
| `[SW]` | Service worker registration |
| `[HF]` | HFSpaceTTSManager (unused but still in code) |
| `[UI]` | User interaction (play/pause) |

### Removing Debug for Production

To strip the debug overlay and eruda:
1. Remove the `debug-overlay` div, `debug-toggle` button, and eruda script tags from the HTML
2. Remove the `debugLog()` function and console capture overrides
3. Remove individual `debugLog()` calls throughout the code (or leave them — they're no-ops without the overlay)

---

## 9. Settings & Preferences <a name="settings"></a>

### Listen Mode Settings

| Setting | Key | Default | Notes |
|---------|-----|---------|-------|
| Voice | `voice` | `af_heart` | Kokoro voice ID |
| Dialogue Voice | `dialogueVoice` | `af_bella` | For dialogue splitting |
| Dialogue Split | `dialogueSplit` | `false` | Separate voice for quoted text |
| Listen Speed | `listenSpeed` | `1.0` | Kokoro speed parameter (0.5-2.0) |
| Model Quality | `modelQuality` | `fp32` | dtype for WebGPU. Mobile locked to fp32. Desktop: fp32/fp16/q8/q4/q4f16 |

### Available Voices

```javascript
const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', gender: 'F', rating: 'A' },
  { id: 'af_bella', name: 'Bella', gender: 'F', rating: 'A-' },
  { id: 'af_nicole', name: 'Nicole', gender: 'F', rating: 'B-' },
  // ... plus Aoede, Kore, Sarah, Nova, Sky (F) and Adam, Echo, Eric, Liam (M)
];
```

### Preferences Persistence

Saved to `localStorage` under `speedreader-prefs`. Includes all RSVP and listen mode settings. Model quality is saved but overridden to fp32 on mobile at initialization.

---

## 10. Approaches Tried & Outcomes <a name="approaches-tried"></a>

### Approach 1: Local Kokoro-js + WebGPU (Desktop)
**Status: WORKING (desktop only)**
- transformers.js v3, q8 dtype, webgpu device
- 150-600ms per sentence on desktop — perfect for real-time streaming
- Produces garbled audio on mobile Chrome (upstream bug #1320)

### Approach 2: Local Kokoro-js + WASM (Mobile)
**Status: ABANDONED (too slow)**
- Works correctly but 5-15x slower than desktop WebGPU
- Per-sentence generation takes 5-15 seconds — too slow for real-time streaming
- Chapter pre-generation (pre-gen entire chapter upfront) was explored but abandoned for the WebGPU fix

### Approach 3: Piper TTS (Client-side WASM Alternative)
**Status: ABANDONED (voice quality rejected)**
- `@mintplex-labs/piper-tts-web` via jsdelivr CDN
- Works on mobile, fast enough for real-time
- Voice quality is VITS-based — significantly worse than Kokoro's StyleTTS2
- User explicitly rejected: "I hate the audio"

### Approach 4: HuggingFace Space API (Server-side Kokoro)
**Status: FUNCTIONAL BUT UNUSED**
- hexgrad's original Space: `api_open=False` → 403 on all programmatic access
- Duplicated to Laz627/Kokoro-TTS with `api_open=True`
- CPU Basic tier: ~6s per sentence (too slow for real-time)
- Cross-origin browser requests blocked by HF edge proxy (403 with Origin header)
- Solved with Cloudflare Worker proxy stripping Origin header
- Sentence-by-sentence approach caused queue contention on single-threaded CPU
- Paragraph-level endpoint (`generate_paragraph`) eliminated contention but still ~22s per paragraph
- Final verdict: usable but slow without GPU acceleration ($9/mo HF Pro)

### Sub-approaches for HF Space (all encountered issues):
1. **EventSource SSE** — Failed silently on mobile Chrome cross-origin
2. **fetch() + ReadableStream** — Failed silently on mobile
3. **@gradio/client library** — Failed because `show_api=False` on original Space
4. **fetch() + await res.text()** — Failed on mobile for SSE content-type
5. **Gradio queue/join + queue/data** — Worked from curl, 403 from browser (CORS)
6. **Gradio /call/predict REST API** — Simpler, worked through proxy

### Approach 5: Cloudflare Workers AI TTS
**Status: NOT TESTED**
- Free 10K neurons/day, GPU-accelerated
- Available models: Deepgram Aura-2, MeloTTS
- Different voice quality than Kokoro — would need listening test
- Remains a viable fallback option

### Approach 6: Local Kokoro-js + transformers.js v4 + fp32/WebGPU (Mobile)
**Status: CURRENT WORKING SOLUTION**
- transformers.js v4 (new C++ WebGPU runtime) fixes mobile garbled audio
- fp32 is the only dtype that produces audible output on mobile WebGPU
- ~22s per paragraph generation, offset by pre-gen buffering
- Smart chunking (300 chars) prevents context overflow on long paragraphs
- Rolling pre-gen loop fills cache continuously while audio plays

### Dtype Testing Results (Pixel 9 Pro, transformers.js v4)

| dtype | Audio Output | Generation Speed | Download Size |
|-------|-------------|-----------------|---------------|
| fp32 | Clean audio | ~22s/paragraph | ~330MB |
| fp16 | Silent | ~22s/paragraph | ~165MB |
| q8 | Silent | ~22s/paragraph | ~86MB |
| q4 | Silent | ~22s/paragraph | ~45MB |
| q4f16 | Silent | ~22s/paragraph | ~45MB |

All quantized formats produce valid AudioBuffers (correct duration, metadata, `ctx=running`, `gain=1`) but the actual audio samples are zero/near-zero. This is a mobile WebGPU shader bug in the ONNX Runtime, not a Kokoro issue.

---

## 11. Known Limitations <a name="known-limitations"></a>

### Audio Quality
- Minor degradation can occur toward the end of longer chunks (~300 chars). Reducing chunk size further would help but increases round trips.
- Kokoro's ~510 token context limit is the fundamental constraint. Long sentences with many syllables may still overflow.

### Performance
- First paragraph of each chapter requires ~90s buffer fill before playback starts
- fp32 on mobile WebGPU is ~100x slower than fp32 on desktop WebGPU
- All dtype variants produce identical speed on Pixel 9 Pro (GPU bottleneck is not compute precision)
- Pre-gen must be sequential (mobile GPU can't parallelize)

### Playback
- Between-paragraph gaps can occur when pre-gen falls behind (very long paragraphs after short ones)
- `stream()` API hangs after first chunk on mobile Chrome — `generate()` per chunk is used instead
- Web Worker approach hangs after generating chunk 1 on mobile (suspected GPU contention)

### Model Download
- fp32 model is ~330MB — significant first-time download on mobile data
- Cached by browser after first load (works offline after that)
- Browser cache can be evicted under storage pressure

### Listen View
- Word-level highlighting was removed (too imprecise with chunk-based progress)
- Currently shows paragraph indicator + progress bar only
- Progress bar tracks within individual chunks, not across the whole paragraph perfectly

---

## 12. Future Improvements <a name="future-improvements"></a>

### High Impact

1. **transformers.js v4 stable release** — When v4 exits preview, kokoro-js will likely pin it natively, eliminating the esm.sh dependency override hack.

2. **Mobile quantized dtype fix** — If ONNX Runtime fixes the silent audio bug for fp16/q8 on mobile WebGPU, switching from fp32 would not improve speed (same on Pixel 9 Pro) but would reduce download from 330MB to 86-165MB.

3. **HF Pro upgrade ($9/mo)** — GPU-accelerated server-side inference would bring per-sentence latency to <1s, enabling real-time streaming identical to desktop. The Space and proxy infrastructure is already built and functional.

4. **Adaptive chunk sizing** — Instead of fixed 300 chars, estimate token count based on word length distribution and target ~450 tokens per chunk for maximum quality.

### Medium Impact

5. **Chapter-to-chapter pre-gen** — Begin pre-generating the next chapter's first paragraphs while the current chapter's last paragraphs play.

6. **IndexedDB audio cache** — Persist generated audio across sessions. If a user pauses mid-chapter and returns later, cached audio is still available without re-generation.

7. **Background generation via Web Worker** — Currently blocked by mobile GPU contention, but may work with transformers.js v4's new runtime. Would keep UI fully responsive during generation.

8. **Cloudflare Workers AI** — Free GPU-accelerated TTS (Deepgram Aura-2). Different voice but fast. Could offer as an alternative voice option alongside local Kokoro.

### Low Impact

9. **Skip short header paragraphs** — Auto-detect chapter numbers, titles, and epigraphs (< 50 chars, no sentence punctuation) and skip TTS generation. Play them as silent pauses instead.

10. **Estimated time display** — Show "Preparing chapter... ~45s remaining" based on average paragraph generation time.

11. **Remove debug overlay for production** — Strip eruda and debug log capture for cleaner UX and slightly smaller file.

---

## 13. File Inventory <a name="file-inventory"></a>

### Repository Files

| File | Purpose | Notes |
|------|---------|-------|
| `index.html` | Main application (~3700 lines) | React 18, kokoro-js, all UI |
| `sw.js` | Service worker (v18) | Cache-first, passthrough domains |
| `manifest.json` | PWA manifest | App name, icons, theme |
| `icon-192.png` | PWA icon | 192x192 |
| `icon-512.png` | PWA icon | 512x512 |

### External Infrastructure

| Resource | URL | Purpose |
|----------|-----|---------|
| HF Space | https://huggingface.co/spaces/Laz627/Kokoro-TTS | Server-side Kokoro (inactive) |
| CF Worker | https://kokoro-proxy.brandonlazovic.workers.dev | CORS proxy for HF Space (inactive) |

### HF Space Files

| File | Purpose |
|------|---------|
| `app.py` | CPU-only Gradio app with generate_paragraph endpoint |
| `requirements.txt` | CPU PyTorch + kokoro + gradio |
| `README.md` | Space config (python_version: "3.12") |
| `en.txt` | Random quotes for demo |
| `gatsby5k.md` | Demo text |
| `frankenstein5k.md` | Demo text |
| `packages.txt` | System packages (espeak-ng) |

---

## 14. Key Code Locations <a name="key-code-locations"></a>

Line numbers are approximate — they shift with edits.

### Core TTS Engine

| Component | Approximate Location | Description |
|-----------|---------------------|-------------|
| `IS_MOBILE` / `HAS_WEBGPU` | ~Line 526 | Platform detection |
| `debugLog()` | ~Line 475 | Debug overlay capture |
| `KOKORO_VOICES` | ~Line 590 | Voice definitions |
| `KokoroTTSManager` class | ~Line 1179 | Main TTS manager |
| `KokoroTTSManager.init()` | ~Line 1208 | Model loading with dtype/device selection |
| `KokoroTTSManager.streamParagraph()` | ~Line 1315 | Smart chunking + generation |
| `KokoroTTSManager.pregenerate()` | ~Line 1453 | Background pre-gen with chunking + concat |
| `KokoroTTSManager.playBuffer()` | ~Line 1480 | Direct AudioBuffer playback |
| `KokoroTTSManager._toBuf()` | ~Line 1265 | Audio result → AudioBuffer conversion |
| `HFSpaceTTSManager` class | ~Line 1500 | Server-side TTS via HF Space (unused) |
| `ttsManager` routing | ~Line 1796 | Always uses `kokoroManager` |

### Listen Mode Effects

| Component | Approximate Location | Description |
|-----------|---------------------|-------------|
| Continuous pre-gen loop | ~Line 2493 | Independent effect, generates para 0→end |
| Play current paragraph | ~Line 2538 | Checks cache, waits or generates live |
| Initial buffer wait | ~Line 2574 | 120s audio target, 90s max wait |
| Cache-wait fallback | ~Line 2605 | Polls for pre-gen to catch up |
| Progress tracking | ~Line 2650 | 100ms interval, `getProgress()` |

### UI Components

| Component | Approximate Location | Description |
|-----------|---------------------|-------------|
| `handleInitKokoro` | ~Line 2690 | Model init + auto-start |
| `handlePlayPause` | ~Line 2712 | Play/pause toggle |
| `handleModeToggle` | ~Line 2781 | RSVP ↔ Listen switch |
| `renderListenView` | ~Line 3145 | Paragraph indicator + progress bar |
| `renderModelLoading` | ~Line 3148 | Loading overlay with progress |
| Voice settings UI | ~Line 3175 | Voice, speed, quality selectors |
| Model quality dropdown | ~Line 3270 | Desktop only, mobile locked to fp32 |

### State Variables (Listen Mode)

| Variable | Purpose |
|----------|---------|
| `mode` | 'rsvp' or 'listen' |
| `isListenPlaying` | Audio playback active |
| `listenParagraphIdx` | Current paragraph index |
| `modelStatus` | 'idle', 'loading', 'ready', 'error' |
| `modelLoadProgress` | 0-100 download progress |
| `isGenerating` | True while waiting for TTS |
| `listenAudioProgress` | 0-1 progress within current paragraph |
| `selectedVoice` | Kokoro voice ID |
| `listenSpeed` | Playback speed (0.5-2.0) |
| `modelQuality` | dtype preference |
| `pregenRunningRef` | Is pre-gen loop active |
| `pregenCancelRef` | Cancel signal for pre-gen loop |

---

## Deployment Checklist

1. Edit files in GitHub web UI (no CLI needed)
2. Wait for GitHub Pages to deploy (~1 minute)
3. On mobile: **clear site data** (Settings → Site settings → laz627.github.io → Clear & reset)
4. Reload the app
5. If issues: tap DBG button for debug overlay, or use eruda gear icon for full DevTools

### When to Bump SW Version

Increment `CACHE_NAME` in `sw.js` whenever:
- `index.html` changes
- New assets are added
- Passthrough domains change
- Any functional change that needs to reach users immediately

Users with cached SW will see "Update available — tap to refresh" banner.
