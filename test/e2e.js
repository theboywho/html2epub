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
      const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
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
    const page = await context.newPage();
    page.on('pageerror', (e) => failures.push('page error: ' + e.message));

    console.log('Install page');
    await page.goto(site.origin + '/index.html');
    const code = await page.$eval('#bookmarklet', (a) => a.getAttribute('href'));
    check(code.startsWith('javascript:'), 'bookmarklet is a javascript: URL');
    check(code.includes(site.origin + '/src/html2epub.js'), 'bookmarklet points at this site');

    console.log('Run bookmarklet on fixture');
    await page.goto(site.origin + '/test/fixtures/article.html');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.evaluate(code.slice('javascript:'.length))
    ]);
    const file = path.join(OUT, download.suggestedFilename());
    await download.saveAs(file);
    console.log('  saved ' + file);
    check(download.suggestedFilename() === 'The Quiet Art of Reading Long Articles.epub', 'file name from title');
    const statusText = await page.textContent('[role=status]');
    check(/Downloaded/.test(statusText), 'status message: ' + statusText.trim());
    const globals = await page.evaluate(() => [typeof window.JSZip, typeof window.define, typeof window.Readability]);
    check(globals.every((t) => t === 'undefined'), 'no library globals left on the page (' + globals.join(', ') + ')');

    console.log('EPUB contents');
    const buf = fs.readFileSync(file);
    check(buf.toString('latin1', 30, 38) === 'mimetype' && buf.readUInt16LE(8) === 0, 'mimetype is first and uncompressed');
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    console.log('  files: ' + names.join(', '));
    const content = await zip.file('OEBPS/content.xhtml').async('string');
    const opf = await zip.file('OEBPS/content.opf').async('string');
    const nav = await zip.file('OEBPS/nav.xhtml').async('string');

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
    check(images.every((n) => content.includes('src="' + n.replace('OEBPS/', '') + '"')), 'every image is referenced');

    check(opf.includes('<dc:title>The Quiet Art of Reading Long Articles</dc:title>'), 'title metadata');
    check(opf.includes('<dc:language>en-GB</dc:language>'), 'language metadata');
    check(opf.includes('Ada Example'), 'author metadata');
    check(nav.includes('href="content.xhtml#notes"'), 'nav lists sections');

    if (process.env.EPUBCHECK) {
      console.log('EPUBCheck');
      try {
        const out = execSync(process.env.EPUBCHECK + ' ' + JSON.stringify(file), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'));
        check(true, 'EPUBCheck passed');
      } catch (e) {
        console.log(((e.stdout || '') + (e.stderr || '')).trim());
        check(false, 'EPUBCheck passed');
      }
    } else {
      console.log('(Set EPUBCHECK to also validate with EPUBCheck.)');
    }
  } finally {
    await browser.close();
    site.server.close();
    other.server.close();
  }

  console.log(failures.length ? '\n' + failures.length + ' failure(s)' : '\nAll checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
