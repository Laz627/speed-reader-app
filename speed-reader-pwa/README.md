# Speed Reader

RSVP speed reader PWA for EPUB books.

## Deploy to GitHub Pages

1. **Create a new repository** on GitHub (e.g., `speed-reader`)

2. **Upload these files** to the repo:
   - `index.html`
   - `manifest.json`
   - `sw.js`
   - `icon-192.png`
   - `icon-512.png`

3. **Enable GitHub Pages:**
   - Go to repo **Settings** → **Pages**
   - Source: **Deploy from a branch**
   - Branch: **main** / **root**
   - Click **Save**

4. **Access your app** at `https://yourusername.github.io/repo-name`

5. **Add to home screen** (Android):
   - Open the URL in Chrome
   - Tap menu (⋮) → **Add to Home Screen**

## Features

- EPUB file support (drag & drop or file picker)
- RSVP with ORP (optimal recognition point) highlighting
- Chapter navigation
- Adjustable speed (100-1000 WPM)
- Smart pauses at punctuation
- Progress auto-save (localStorage)
- Offline support (PWA)
- Dark/light theme

## Customization

Replace `icon-192.png` and `icon-512.png` with your own app icons.

## EPUB Workflow

1. Install [Calibre](https://calibre-ebook.com)
2. Install [DeDRM plugin](https://github.com/noDRM/DeDRM_tools)
3. Download `.azw3` from Amazon → drag to Calibre → convert to EPUB
4. Drop EPUB into Speed Reader
