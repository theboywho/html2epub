# html2epub

A bookmarklet that saves the article on the current web page as an EPUB, e.g. for your reMarkable.

## Install

Open the install page and drag **Save as EPUB** to your bookmarks bar:
<https://theboywho.github.io/html2epub/>

Or create a bookmark by hand with this URL:

```text
javascript:(function(){var d=document,s=d.createElement('script');s.src='https://theboywho.github.io/html2epub/src/html2epub.js?t='+Date.now();s.onload=function(){s.remove()};s.onerror=function(){s.remove();alert('html2epub: could not load the converter. This site may block external scripts.')};(d.head||d.documentElement).appendChild(s)})();
```

## How it works

1. The bookmarklet loads [`src/html2epub.js`](src/html2epub.js) from this repo's GitHub Pages site.
2. That script loads its libraries from the same site ([`vendor/`](vendor/README.md)):
   [Readability](https://github.com/mozilla/readability) to pull out the article and
   [JSZip](https://github.com/Stuk/jszip) to package the EPUB.
3. The article is cleaned up into valid XHTML. Images are downloaded and embedded when the
   browser is allowed to fetch them; JPEG, PNG and GIF are kept as-is, other formats (WebP,
   SVG, …) are converted to JPEG/PNG. Images that can't be fetched are replaced by their alt text.
4. An EPUB 3 file (with an EPUB 2 NCX table of contents for older readers) is downloaded.

Everything runs in your browser; nothing is uploaded.

## Limitations

- Sites with a strict Content-Security-Policy block scripts from other origins, so the
  bookmarklet can't run there.
- Cross-origin images without CORS headers can't be downloaded and are left out.
- Formulas (MathML) are replaced by their TeX or alt text, and inline SVG drawings by their
  label (or removed if they have none).
- Video, audio, iframes and forms are removed.
- Images that take longer than 15 seconds to download are left out.

## Development

No build step: the files in this repo are served as-is by GitHub Pages from `main`.
See [AGENTS.md](AGENTS.md) for contribution rules.

Run the end-to-end test (needs Node 18+ and [Playwright](https://playwright.dev/) with Chromium):

```sh
node test/e2e.js
# also validate with EPUBCheck (https://github.com/w3c/epubcheck):
EPUBCHECK="java -jar /path/to/epubcheck.jar" node test/e2e.js
```

To try local changes in a browser, serve the repo (e.g. `python3 -m http.server`) and open
`http://localhost:8000/`; the install page builds a bookmarklet that points at wherever it is served from.
