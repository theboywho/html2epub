#!/usr/bin/env node
/*
 * End-to-end test: installs the bookmarklet from index.html, runs it on a fixture
 * article in headless Chromium, and checks the downloaded EPUB.
 *
 * Usage:   node test/e2e.js [output-dir]
 * Needs:   Node 18+ and Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
 * Optional: EPUBCHECK="java -jar /path/to/epubcheck.jar" to validate the EPUB with EPUBCheck.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const JSZip = require(path.join(ROOT, 'vendor/jszip/jszip.min.js'));
const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'html2epub-')));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

function serve(dir, transform) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (pathname === '/hang.png') return; // never answers, like a stalled image server
      const file = path.join(dir, pathname);
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      let body = fs.readFileSync(file);
      if (transform && file.endsWith('.html')) body = transform(body.toString());
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: 'http://127.0.0.1:' + server.address().port }));
  });
}

// Run the bookmarklet on a page and return the downloaded EPUB's contents.
async function convert(page, code, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const before = await page.evaluate(() => Object.keys(window));
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.evaluate(code.slice('javascript:'.length))
  ]);
  const file = path.join(OUT, download.suggestedFilename());
  await download.saveAs(file);
  console.log('  saved ' + file);
  const status = (await page.textContent('[role=status]')).trim();
  await page.waitForTimeout(200); // let the converter finish cleaning up
  const leftovers = await page.evaluate((before) => {
    // A top-level function declaration (Readability) can't be deleted, only set to
    // undefined, so count only new globals that still hold a value.
    const added = Object.keys(window).filter((k) => before.indexOf(k) === -1 && window[k] !== undefined);
    if (window.__messageListeners) added.push(window.__messageListeners + " 'message' listener(s)");
    document.querySelectorAll('script[src*="html2epub"], script[src*="vendor/"]').forEach((el) => added.push('<script src=' + el.getAttribute('src') + '>'));
    return added;
  }, before);
  const buf = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(buf);
  const read = (n) => zip.file('OEBPS/' + n).async('string');
  return {
    file,
    name: download.suggestedFilename(),
    status,
    leftovers,
    mimetypeOk: buf.toString('latin1', 30, 38) === 'mimetype' && buf.readUInt16LE(8) === 0,
    names: Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort(),
    content: await read('content.xhtml'),
    opf: await read('content.opf'),
    nav: await read('nav.xhtml')
  };
}

const failures = [];
function check(ok, msg) {
  console.log((ok ? '  ok   ' : '  FAIL ') + msg);
  if (!ok) failures.push(msg);
}

(async () => {
  // A second origin without CORS headers, for an image the converter must skip.
  const other = await serve(path.join(ROOT, 'test/fixtures'));
  const site = await serve(ROOT, (html) => html.replace(/\{\{CROSS_ORIGIN\}\}/g, other.origin));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    // Record 'message' listeners added to window, to catch libraries leaving them behind.
    await context.addInitScript(() => {
      window.__messageListeners = 0;
      const add = window.addEventListener;
      window.addEventListener = function (type) {
        if (type === 'message') window.__messageListeners++;
        return add.apply(this, arguments);
      };
    });
    const page = await context.newPage();
    const epubs = [];
    page.on('pageerror', (e) => failures.push('page error: ' + e.message));

    console.log('Install page');
    await page.goto(site.origin + '/index.html');
    const code = await page.$eval('#bookmarklet', (a) => a.getAttribute('href'));
    check(code.startsWith('javascript:'), 'bookmarklet is a javascript: URL');
    check(code.includes(site.origin + '/src/html2epub.js'), 'bookmarklet points at this site');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    check(readme.includes(code.split(site.origin + '/').join('https://theboywho.github.io/html2epub/')), 'README bookmarklet matches the install page');

    console.log('Fixture: article.html');
    const a = await convert(page, code, site.origin + '/test/fixtures/article.html');
    check(a.name === 'The Quiet Art of Reading Long Articles.epub', 'file name from title');
    check(/Downloaded/.test(a.status), 'status message: ' + a.status);
    check(a.leftovers.length === 0, 'no globals or listeners left on the page' + (a.leftovers.length ? ' (' + a.leftovers.join(', ') + ')' : ''));
    check(a.mimetypeOk, 'mimetype is first and uncompressed');
    const { content, opf, nav, names } = a;

    check(content.includes('Reading long articles on a screen is tiring'), 'article text kept');
    check(!content.includes('Another article') && !content.includes('Privacy') && !content.includes('Subscribe'), 'site furniture removed');
    check(!/onclick|jsaction|data-tracking|javascript:|<script|<font|custom-widget|<time|loading=/.test(content), 'junk markup and attributes removed');
    check(content.includes('custom element') && content.includes('font tag'), 'unwrapped elements keep their text');
    check(content.includes('href="#notes"'), 'internal link kept');
    check(content.includes('href="' + site.origin + '/test/fixtures/article.html#missing-anchor"'), 'link to missing anchor made absolute');
    check(content.includes('href="' + site.origin + '/test/fixtures/other-page.html"'), 'relative link made absolute');
    check(!/[\u0000-\u0008]/.test(content), 'no XML-illegal characters');
    check(content.includes('[Missing image]') && content.includes('[Cross-origin image]'), 'undownloadable images replaced by alt text');

    const images = names.filter((n) => n.startsWith('OEBPS/images/'));
    check(images.length === 4, '4 images embedded (got ' + images.length + ')');
    check(images.filter((n) => n.endsWith('.jpg')).length === 2 && images.filter((n) => n.endsWith('.png')).length === 2,
      'JPEG/PNG kept, WebP converted to JPEG, SVG converted to PNG');
    check(/src="images\/img-001\.jpg"/.test((content.match(/<img[^>]*alt="Compact srcset"[^>]*>/) || [''])[0]), 'largest image picked from a compact srcset');
    check(images.every((n) => content.includes('src="' + n.replace('OEBPS/', '') + '"')), 'every image is referenced');

    check(opf.includes('<dc:title>The Quiet Art of Reading Long Articles</dc:title>'), 'title metadata');
    check(opf.includes('<dc:language>en-GB</dc:language>'), 'language metadata');
    check(opf.includes('Ada Example'), 'author metadata');
    check(nav.includes('href="content.xhtml#notes"'), 'nav lists sections');
    check(content.includes('<h2 id="2024-update">') && content.includes('id="fn:1"'), 'unusual ids kept');
    check(['#fn:1', '#fnref:1', '#2024-update', '#odd(id)%25'].every((f) => content.includes('href="' + f + '"')), 'links to unusual ids kept as internal links');
    check(nav.includes('href="content.xhtml#2024-update"'), 'nav links to heading with unusual id');
    epubs.push(a.file);

    console.log('Fixture: nested/edge-cases.html');
    const e = await convert(page, code, site.origin + '/test/fixtures/nested/edge-cases.html');
    check(/Downloaded/.test(e.status), 'status message: ' + e.status);
    check(e.leftovers.length === 0, 'no globals or listeners left on the page' + (e.leftovers.length ? ' (' + e.leftovers.join(', ') + ')' : ''));
    const amd = await page.evaluate(() => ({
      define: typeof window.define, amd: !!(window.define && window.define.amd && window.define.amd.jQuery), modules: window.amdModules.length
    }));
    check(amd.define === 'function' && amd.amd, "page's AMD loader left intact");
    check(amd.modules === 0, 'JSZip not registered with the AMD loader');
    check(e.content.includes('[Stalled image]'), 'image that never loads is skipped after a timeout');
    check(/src="images\/img-\d+\.jpg"/.test((e.content.match(/<img[^>]*alt="Lazy image"[^>]*>/) || [''])[0]), 'lazy image resolved against <base href>');
    check(e.content.includes('The mean is \\bar{x} = \\frac{1}{n}\\sum x_i for') && e.content.includes('variance is \\sigma^2 in'), 'MathML replaced by its TeX/alt text');
    check(!e.content.includes('HIDDEN-FORMULA') && !e.content.includes('<svg') && !e.content.includes('<math'), 'hidden formulas and decorative SVG removed');
    check(e.content.includes('[Sales by month]'), 'labelled SVG replaced by its label');
    check(/<ul>\s*<li>Loose item one<\/li>\s*<li>Loose item two<\/li>\s*<\/ul>/.test(e.content), 'loose list items wrapped in a list');
    check(/<ul>\s*<li>Menu item one<\/li>\s*<li>Menu item two<\/li>\s*<\/ul>/.test(e.content), 'menu becomes a list');
    check(/<dl>\s*<dt>Term<\/dt>\s*<dd>Definition<\/dd>\s*<\/dl>/.test(e.content), 'orphaned definitions wrapped in a list');
    check(e.content.includes('<p>Summary text</p>') && e.content.includes('<p>Orphaned caption</p>'), 'summary and orphaned caption become paragraphs');
    epubs.push(e.file);

    if (process.env.EPUBCHECK) {
      console.log('EPUBCheck');
      for (const file of epubs) {
        try {
          execSync(process.env.EPUBCHECK + ' ' + JSON.stringify(file), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          check(true, 'valid: ' + path.basename(file));
        } catch (err) {
          console.log(((err.stdout || '') + (err.stderr || '')).trim());
          check(false, 'valid: ' + path.basename(file));
        }
      }
    } else {
      console.log('(Set EPUBCHECK to also validate with EPUBCheck.)');
    }
  } finally {
    await browser.close();
    for (const s of [site.server, other.server]) {
      s.closeAllConnections();
      s.close();
    }
  }

  console.log(failures.length ? '\n' + failures.length + ' failure(s)' : '\nAll checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
