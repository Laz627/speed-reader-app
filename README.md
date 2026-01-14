# Speed Reader PWA

A Progressive Web App for speed reading EPUB files using RSVP (Rapid Serial Visual Presentation) with ORP (Optimal Recognition Point) highlighting.

## Features

- **EPUB Support**: Drag & drop or file picker for EPUB files
- **ORP Highlighting**: Red focal letter marks the optimal recognition point for each word
- **Smart Pauses**: Automatic delays at punctuation with extended support:
  - Sentence endings (. ! ?): 2.2x delay
  - Commas, semicolons, colons: 1.4x delay
  - Em-dash (—): 1.3x delay
  - Ellipsis (...): 1.8x delay
  - Opening quotes: 1.2x delay (slight pause before dialogue)
  - Paragraph breaks: 2.5 second pause
- **Clean Quote Handling**: Opening/closing quotes and parentheses are dimmed and slightly smaller, keeping focus on the actual word
- **Dialogue Indicator**: Subtle visual indicator when reading dialogue (tracks quote state across words)
- **Chapter Title Splash**: 3-second animated title card when starting a new chapter
- **Paragraph Detection**: Automatic pauses between paragraphs for natural reading rhythm
- **Chapter Navigation**: Dropdown selector for multi-chapter books
- **Progress Saving**: Automatically saves your position in localStorage
- **Adjustable Speed**: WPM slider from 100-1000 words per minute
- **Dark/Light Theme**: Toggle between dark and light modes
- **PWA Ready**: Install as an app, works offline

## Usage

1. Visit the hosted app or open `index.html` locally
2. Drop an EPUB file onto the page (or use the Open button)
3. Press Play to start reading
4. Adjust WPM with the slider
5. Use Prev/Next to navigate sentences
6. Toggle the ⏸ button to enable/disable smart pauses

## Deploy to GitHub Pages

1. **Create a new repository** on GitHub (e.g., `speed-reader-app`)

2. **Upload these files** to the repo root:
   - `index.html`
   - `manifest.json`
   - `sw.js`
   - `icon-192.png`
   - `icon-512.png`
   - `README.md`

3. **Enable GitHub Pages:**
   - Go to repo **Settings** → **Pages**
   - Source: **Deploy from a branch**
   - Branch: **main** / **root**
   - Click **Save**

4. **Access your app** at `https://yourusername.github.io/speed-reader-app`

5. **Add to home screen** (mobile):
   - Android: Open in Chrome → tap menu (⋮) → **Add to Home Screen**
   - iOS: Open in Safari → tap Share → **Add to Home Screen**

## Punctuation Delay Reference

| Punctuation | Delay Multiplier |
|-------------|------------------|
| Period, !, ? | 2.2x |
| Comma, ;, : | 1.4x |
| Em-dash (—) | 1.3x |
| Ellipsis (...) | 1.8x |
| Opening quote | 1.2x |
| Paragraph break | 2.5 seconds (fixed) |
| Long words (8-10 chars) | 1.08x |
| Very long words (11+ chars) | 1.15x |

## Files

- `index.html` - Complete app (single file with embedded React)
- `manifest.json` - PWA configuration
- `sw.js` - Service worker for offline support
- `icon-192.png` / `icon-512.png` - App icons

## Converting Kindle Books

Since Amazon removed "Download & Transfer via USB" in February 2025, use this workflow:

1. Install [Kindle for PC/Mac](https://www.amazon.com/kindle-dbs/fd/kcp)
2. Download your books in the Kindle app
3. Install [Calibre](https://calibre-ebook.com/download)
4. Add [DeDRM plugin v10.0.9](https://github.com/noDRM/DeDRM_tools/releases) to Calibre
5. Import your Kindle books (DRM removed automatically on import)
6. Convert to EPUB format in Calibre
7. Drop the EPUB into this speed reader

## Customization

Replace `icon-192.png` and `icon-512.png` with your own app icons (must be square PNG files at those dimensions).

## Changelog

### v2.0.0
- **Quote/Parenthesis Handling**: Leading and trailing punctuation is now visually separated - dimmed and slightly smaller - so the core word stands out
- **Dialogue Indicator**: A subtle pill-shaped indicator appears when you're inside quoted dialogue
- **Chapter Title Splash**: Animated chapter title screen appears for 3 seconds when switching chapters
- **Paragraph Pauses**: Automatic 2.5-second pauses at paragraph breaks for natural reading rhythm
- **Extended Punctuation Delays**: Added support for em-dashes (1.3x), ellipses (1.8x), and opening quotes (1.2x)
- **Progress Calculation Fix**: Paragraph markers no longer count toward word count/progress

### v1.0.0
- Initial release with EPUB parsing, ORP highlighting, basic punctuation pauses

## License

MIT
