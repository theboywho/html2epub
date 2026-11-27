/*
 * html2epub — turns the article on the current page into an EPUB 3 file and downloads it.
 *
 * Loaded by the bookmarklet from GitHub Pages. Libraries are loaded from the same site
 * (see vendor/README.md). Everything runs in the browser; nothing is uploaded.
 */
(function () {
  'use strict';

  if (window.__html2epubRunning) return;
  window.__html2epubRunning = true;

  var FALLBACK_BASE = 'https://theboywho.github.io/html2epub/';
  var script = document.currentScript;
  // Site root: one level up from src/html2epub.js (query string is dropped).
  var BASE = script && script.src ? new URL('..', script.src).href : FALLBACK_BASE;

  var IMAGE_TIMEOUT_MS = 15000;
  var XHTML_NS = 'http://www.w3.org/1999/xhtml';
  var XML_NS = 'http://www.w3.org/XML/1998/namespace';
  var OPS_NS = 'http://www.idpf.org/2007/ops';

  // Elements kept as-is. Anything not listed here or in DROP_ELEMENTS is unwrapped
  // (replaced by its children) so the output stays valid XHTML for EPUB.
  var KEEP_ELEMENTS = toSet(
    'a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del ' +
    'dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li mark ' +
    'ol p pre q rp rt ruby s samp section small span strong sub sup table tbody td tfoot th thead ' +
    'tr u ul var wbr'
  );
  // Elements removed together with their content.
  var DROP_ELEMENTS = toSet(
    'script style noscript iframe frame frameset object embed applet form input button select ' +
    'option textarea video audio canvas template link meta svg math source track map area dialog'
  );
  // Elements converted to a supported equivalent before the rules above apply.
  var RENAME_ELEMENTS = { menu: 'ul', dir: 'ul', details: 'div', summary: 'p' };
  // Attributes kept per element ('*' = every element); everything else is removed.
  var KEEP_ATTRS = {
    '*': ['id', 'title', 'lang', 'dir'],
    a: ['href'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed'],
    col: ['span'],
    colgroup: ['span']
  };

  var status = createStatus();

  // Page globals we change while running; each is put back afterwards.
  var restoreGlobals = [];

  run()
    .catch(function (err) {
      console.error('html2epub:', err);
      status.error(err && err.message ? err.message : String(err));
    })
    .then(function () {
      restoreAll(restoreGlobals);
      try { delete window.__html2epubRunning; } catch (e) { window.__html2epubRunning = undefined; }
    });

  async function run() {
    status.set('Loading…');
    var libs = await loadLibraries();

    status.set('Extracting article…');
    var article = new libs.Readability(document.cloneNode(true), {
      serializer: function (el) { return el; } // keep a DOM node, avoid re-parsing HTML
    }).parse();
    if (!article || !article.content) {
      throw new Error("Couldn't find an article on this page.");
    }

    var content = article.content;
    var title = cleanText(article.title) || cleanText(document.title) || 'Untitled';
    var lang = validLang(article.lang) || validLang(document.documentElement.lang) || 'en';

    prepareImageSources(content);
    sanitize(content);
    var headings = addHeadingIds(content);
    fixLinks(content);

    status.set('Downloading images…');
    var images = await embedImages(content);

    status.set('Building EPUB…');
    var meta = {
      id: 'urn:uuid:' + uuid(),
      title: title,
      lang: lang,
      byline: cleanText(article.byline),
      siteName: cleanText(article.siteName),
      published: w3cDate(article.publishedTime),
      modified: w3cDate(new Date()),
      source: location.href
    };
    var blob = await buildEpub(libs.JSZip, meta, content, headings, images.files);

    download(blob, fileName(title) + '.epub');
    var msg = 'Downloaded “' + title + '”';
    if (images.files.length || images.skipped) {
      msg += ' (' + images.files.length + ' image' + (images.files.length === 1 ? '' : 's');
      if (images.skipped) msg += ', ' + images.skipped + ' skipped';
      msg += ')';
    }
    status.done(msg);
  }

  // ---------------------------------------------------------------------------
  // Library loading

  async function loadLibraries() {
    // JSZip calls a global setImmediate and, if there is none, installs a polyfill that
    // adds window globals and a permanent 'message' listener. Provide our own (removed
    // when we finish) so the polyfill never installs itself.
    if (typeof window.setImmediate !== 'function') {
      var shim = setImmediateShim();
      setGlobal(restoreGlobals, window, 'setImmediate', shim.setImmediate);
      setGlobal(restoreGlobals, window, 'clearImmediate', shim.clearImmediate);
      restoreGlobals.push({ restore: shim.close });
    }

    // The libraries attach to window; capture them, then put back whatever the page had.
    var libGlobals = [];
    setGlobal(libGlobals, window, 'Readability', undefined);
    setGlobal(libGlobals, window, 'JSZip', undefined);
    try {
      await loadScript(new URL('vendor/readability/Readability.js', BASE).href);
      // JSZip's UMD wrapper registers with an AMD loader if the page has one (RequireJS
      // etc.). Hide only define.amd, and only while JSZip loads, so the page's own
      // define() keeps working.
      var amd = [];
      if (typeof window.define === 'function' && window.define.amd) setGlobal(amd, window.define, 'amd', undefined);
      try {
        await loadScript(new URL('vendor/jszip/jszip.min.js', BASE).href);
      } finally {
        restoreAll(amd);
      }
      var libs = { Readability: window.Readability, JSZip: window.JSZip };
      if (typeof libs.Readability !== 'function' || typeof libs.JSZip !== 'function') {
        throw new Error('Libraries failed to initialise on this page.');
      }
      return libs;
    } finally {
      restoreAll(libGlobals);
    }
  }

  // Set obj[name], remembering how to undo it.
  function setGlobal(list, obj, name, value) {
    var had = Object.prototype.hasOwnProperty.call(obj, name);
    var old = obj[name];
    list.push({
      restore: function () {
        try {
          if (had) obj[name] = old;
          else delete obj[name];
        } catch (e) {
          // Non-configurable (e.g. a top-level function declaration): just clear it.
          try { obj[name] = undefined; } catch (e2) { /* leave it */ }
        }
      }
    });
    obj[name] = value;
  }

  function restoreAll(list) {
    while (list.length) list.pop().restore();
  }

  // A small setImmediate built on a private MessageChannel (no page-wide listeners).
  function setImmediateShim() {
    var channel = new MessageChannel();
    var tasks = new Map();
    var next = 1;
    channel.port1.onmessage = function (e) {
      var task = tasks.get(e.data);
      if (!task) return;
      tasks.delete(e.data);
      task.fn.apply(null, task.args);
    };
    return {
      setImmediate: function (fn) {
        var id = next++;
        tasks.set(id, { fn: fn, args: Array.prototype.slice.call(arguments, 1) });
        channel.port2.postMessage(id);
        return id;
      },
      clearImmediate: function (id) { tasks.delete(id); },
      close: function () { channel.port1.close(); channel.port2.close(); tasks.clear(); }
    };
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { s.remove(); resolve(); };
      s.onerror = function () {
        s.remove();
        reject(new Error('Could not load ' + src + ' — this site may block external scripts.'));
      };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  // ---------------------------------------------------------------------------
  // Content clean-up

  function prepareImageSources(root) {
    root.querySelectorAll('img').forEach(function (img) {
      var src = img.getAttribute('src');
      var fromSet = bestFromSrcset(img.getAttribute('srcset'));
      if (!src || /^data:image\/gif/i.test(src) || (fromSet && !/^https?:/i.test(src))) {
        src = fromSet || img.getAttribute('data-src') || src;
      }
      if (src) img.setAttribute('src', src);
      else img.removeAttribute('src');
    });
  }

  function bestFromSrcset(srcset) {
    if (!srcset) return null;
    var best = null;
    var bestScore = -1;
    srcset.split(/,\s+/).forEach(function (part) {
      var bits = part.trim().split(/\s+/);
      if (!bits[0]) return;
      var d = bits[1] || '1x';
      var n = parseFloat(d) || 1;
      var score = /w$/i.test(d) ? n : n * 1000;
      if (score > bestScore) { best = bits[0]; bestScore = score; }
    });
    return best;
  }

  function sanitize(root) {
    // Remove comments and processing instructions; strip characters that are illegal in XML.
    var walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_TEXT);
    var remove = [];
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) node.data = stripXmlIllegal(node.data);
      else remove.push(node);
    }
    remove.forEach(function (n) { n.remove(); });

    var seenIds = new Set();
    Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function (el) {
      if (!root.contains(el)) return; // inside something already removed
      var name = el.localName;
      if (el.namespaceURI !== XHTML_NS || DROP_ELEMENTS.has(name)) {
        el.remove();
        return;
      }
      if (RENAME_ELEMENTS[name]) {
        el = renameElement(el, RENAME_ELEMENTS[name]);
        name = el.localName;
      }
      if (!KEEP_ELEMENTS.has(name)) {
        el.replaceWith.apply(el, Array.prototype.slice.call(el.childNodes));
        return;
      }
      var allowed = KEEP_ATTRS['*'].concat(KEEP_ATTRS[name] || []);
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        if (allowed.indexOf(attr.name) === -1 || attr.namespaceURI || !validAttr(attr.name, attr.value)) {
          el.removeAttribute(attr.name);
        } else {
          var clean = stripXmlIllegal(attr.value);
          if (clean !== attr.value) el.setAttribute(attr.name, clean);
        }
      });
      if (el.hasAttribute('id')) {
        var id = el.getAttribute('id');
        if (seenIds.has(id)) el.removeAttribute('id');
        else seenIds.add(id);
      }
      if (name === 'img') {
        if (!el.hasAttribute('src')) { el.remove(); return; }
        if (!el.hasAttribute('alt')) el.setAttribute('alt', '');
      }
      if (name === 'ol' && el.hasAttribute('reversed')) el.setAttribute('reversed', 'reversed');
    });
    repairStructure(root);
  }

  // Unwrapping can leave elements outside the parent they require (e.g. <li> from a
  // <custom-list>), which is invalid XHTML. Put them back in a valid structure.
  function repairStructure(root) {
    Array.prototype.slice.call(root.querySelectorAll('li, dt, dd, figcaption, caption, tr, td, th, thead, tbody, tfoot, colgroup, col')).forEach(function (el) {
      if (!root.contains(el)) return;
      var name = el.localName;
      var parent = el.parentElement;
      var p = parent ? parent.localName : '';
      if (name === 'li' && p !== 'ul' && p !== 'ol') {
        wrapRun(el, 'ul', ['li']);
      } else if ((name === 'dt' || name === 'dd') && p !== 'dl' && !(p === 'div' && parent.parentElement && parent.parentElement.localName === 'dl')) {
        wrapRun(el, 'dl', ['dt', 'dd']);
      } else if ((name === 'figcaption' && p !== 'figure') || (name === 'caption' && p !== 'table') ||
                 ((name === 'td' || name === 'th') && p !== 'tr')) {
        renameElement(el, p === 'p' ? 'span' : 'p');
      } else if (name === 'tr' && !/^(table|thead|tbody|tfoot)$/.test(p)) {
        el.replaceWith.apply(el, Array.prototype.slice.call(el.childNodes));
      } else if (/^(thead|tbody|tfoot|colgroup)$/.test(name) && p !== 'table') {
        el.replaceWith.apply(el, Array.prototype.slice.call(el.childNodes));
      } else if (name === 'col' && p !== 'colgroup' && p !== 'table') {
        el.remove();
      }
    });
  }

  // Wrap el and its following sibling elements of the given names in a new container.
  function wrapRun(el, containerName, names) {
    var parent = el.parentElement;
    // A list can't sit inside a paragraph; make the paragraph a div.
    if (parent && parent.localName === 'p') renameElement(parent, 'div');
    var container = el.ownerDocument.createElementNS(XHTML_NS, containerName);
    el.before(container);
    var node = el;
    while (node) {
      var next = node.nextSibling;
      if (node.nodeType === Node.ELEMENT_NODE && names.indexOf(node.localName) !== -1) container.appendChild(node);
      else if (node.nodeType === Node.TEXT_NODE && !node.data.trim() && next && next.nodeType === Node.ELEMENT_NODE && names.indexOf(next.localName) !== -1) container.appendChild(node);
      else break;
      node = next;
    }
  }

  // Replace el with a new element called name, keeping its children and attributes.
  function renameElement(el, name) {
    var replacement = el.ownerDocument.createElementNS(XHTML_NS, name);
    Array.prototype.slice.call(el.attributes).forEach(function (attr) {
      if (!attr.namespaceURI) replacement.setAttribute(attr.name, attr.value);
    });
    while (el.firstChild) replacement.appendChild(el.firstChild);
    el.replaceWith(replacement);
    return replacement;
  }

  function validAttr(name, value) {
    switch (name) {
      case 'id': return /^[^\s]+$/.test(value);
      case 'lang': return value === '' || !!validLang(value);
      case 'dir': return /^(ltr|rtl|auto)$/.test(value);
      case 'width': case 'height': case 'colspan': case 'rowspan': case 'span':
        return /^[1-9]\d*$/.test(value);
      case 'start': return /^-?\d+$/.test(value);
      case 'scope': return /^(row|col|rowgroup|colgroup)$/.test(value);
      default: return true;
    }
  }

  function addHeadingIds(root) {
    var headings = [];
    var n = 0;
    root.querySelectorAll('h2').forEach(function (h) {
      var text = cleanText(h.textContent);
      if (!text) return;
      if (!h.id) {
        var id;
        do { id = 'section-' + (++n); } while (root.ownerDocument.getElementById(id) || root.querySelector('#' + id));
        h.id = id;
      }
      headings.push({ id: h.id, text: text });
    });
    return headings;
  }

  function fixLinks(root) {
    var ids = new Set();
    root.querySelectorAll('[id]').forEach(function (el) { ids.add(el.id); });
    var page = location.href.split('#')[0];
    root.querySelectorAll('a[href]').forEach(function (a) {
      var url;
      try { url = new URL(a.getAttribute('href'), location.href); } catch (e) { a.removeAttribute('href'); return; }
      if (url.hash && url.href.split('#')[0] === page) {
        var target = safeDecode(url.hash.slice(1));
        if (ids.has(target)) { a.setAttribute('href', fragment(target)); return; }
      }
      if (/^(https?|mailto):$/.test(url.protocol)) a.setAttribute('href', url.href);
      else a.removeAttribute('href');
    });
  }

  // ---------------------------------------------------------------------------
  // Images

  async function embedImages(root) {
    var imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
    var cache = new Map();
    var files = [];
    var skipped = 0;
    var counter = 0;

    function load(url) {
      if (!cache.has(url)) {
        var index = ++counter;
        cache.set(url, fetchImage(url).then(function (img) {
          if (!img) return null;
          var file = { href: 'images/img-' + pad(index) + '.' + img.ext, type: img.type, data: img.data, id: 'img-' + pad(index) };
          files.push(file);
          return file;
        }));
      }
      return cache.get(url);
    }

    await pool(imgs, 6, async function (img) {
      var src = img.getAttribute('src');
      var url;
      try { url = new URL(src, location.href).href; } catch (e) { url = null; }
      var file = url ? await load(url) : null;
      if (file) {
        img.setAttribute('src', file.href);
      } else {
        skipped++;
        var alt = cleanText(img.getAttribute('alt'));
        if (alt) img.replaceWith(img.ownerDocument.createTextNode('[' + alt + ']'));
        else img.remove();
      }
    });

    files.sort(function (a, b) { return a.href < b.href ? -1 : 1; });
    return { files: files, skipped: skipped };
  }

  async function fetchImage(url) {
    // Give up on an image that takes too long, so one slow server can't stall the book.
    var controller = new AbortController();
    var timer;
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        controller.abort();
        reject(new Error('Timed out after ' + IMAGE_TIMEOUT_MS / 1000 + 's'));
      }, IMAGE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([timeout, (async function () {
        var res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        var buf = await res.arrayBuffer();
        var type = sniffImageType(new Uint8Array(buf));
        if (type) return { data: buf, type: type, ext: type === 'image/jpeg' ? 'jpg' : type.split('/')[1] };
        // Other formats (WebP, AVIF, SVG…) are converted for wider reader support.
        var mime = (res.headers.get('content-type') || '').split(';')[0].trim();
        return await rasterize(new Blob([buf], { type: mime }), /svg/i.test(mime));
      })()]);
    } catch (e) {
      console.warn('html2epub: could not embed image', url, e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function sniffImageType(b) {
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    return null;
  }

  async function rasterize(blob, isSvg) {
    var source;
    try {
      source = await createImageBitmap(blob);
    } catch (e) {
      source = await loadImageElement(blob); // e.g. SVG, which createImageBitmap may reject
    }
    var w = source.width || source.naturalWidth || 1000;
    var h = source.height || source.naturalHeight || 1000;
    var max = 1600;
    if (Math.max(w, h) > max) {
      var k = max / Math.max(w, h);
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    if (source.close) source.close();
    var type = isSvg ? 'image/png' : 'image/jpeg';
    var out = await new Promise(function (resolve) { canvas.toBlob(resolve, type, 0.85); });
    if (!out) return null;
    return { data: await out.arrayBuffer(), type: type, ext: isSvg ? 'png' : 'jpg' };
  }

  function loadImageElement(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Unsupported image')); };
      img.src = url;
    });
  }

  async function pool(items, size, fn) {
    var next = 0;
    var workers = [];
    for (var i = 0; i < Math.min(size, items.length); i++) {
      workers.push((async function () {
        while (next < items.length) await fn(items[next++]);
      })());
    }
    await Promise.all(workers);
  }

  // ---------------------------------------------------------------------------
  // EPUB packaging

  async function buildEpub(JSZip, meta, content, headings, images) {
    var zip = new JSZip();
    // The mimetype file must come first and be stored uncompressed.
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n' +
      '</container>\n');
    zip.file('OEBPS/content.opf', opf(meta, images));
    zip.file('OEBPS/toc.ncx', ncx(meta, headings));
    zip.file('OEBPS/nav.xhtml', navDocument(meta, headings));
    zip.file('OEBPS/content.xhtml', contentDocument(meta, content));
    zip.file('OEBPS/style.css', STYLESHEET);
    images.forEach(function (img) {
      zip.file('OEBPS/' + img.href, img.data, { compression: 'STORE' });
    });
    return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
  }

  function opf(meta, images) {
    var md = [
      '<dc:identifier id="uid">' + esc(meta.id) + '</dc:identifier>',
      '<dc:title>' + esc(meta.title) + '</dc:title>',
      '<dc:language>' + esc(meta.lang) + '</dc:language>'
    ];
    if (meta.byline) md.push('<dc:creator>' + esc(meta.byline) + '</dc:creator>');
    if (meta.siteName) md.push('<dc:publisher>' + esc(meta.siteName) + '</dc:publisher>');
    if (meta.published) md.push('<dc:date>' + esc(meta.published) + '</dc:date>');
    md.push('<dc:source>' + esc(meta.source) + '</dc:source>');
    md.push('<meta property="dcterms:modified">' + esc(meta.modified) + '</meta>');

    var items = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      '<item id="css" href="style.css" media-type="text/css"/>',
      '<item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>'
    ].concat(images.map(function (img) {
      return '<item id="' + img.id + '" href="' + esc(img.href) + '" media-type="' + img.type + '"/>';
    }));

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="' + esc(meta.lang) + '">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    ' + md.join('\n    ') + '\n  </metadata>\n' +
      '  <manifest>\n    ' + items.join('\n    ') + '\n  </manifest>\n' +
      '  <spine toc="ncx">\n    <itemref idref="content"/>\n  </spine>\n' +
      '</package>\n';
  }

  function ncx(meta, headings) {
    var points = [{ text: meta.title, src: 'content.xhtml' }].concat(headings.map(function (h) {
      return { text: h.text, src: 'content.xhtml' + fragment(h.id) };
    }));
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '  <head>\n' +
      '    <meta name="dtb:uid" content="' + esc(meta.id) + '"/>\n' +
      '    <meta name="dtb:depth" content="1"/>\n' +
      '    <meta name="dtb:totalPageCount" content="0"/>\n' +
      '    <meta name="dtb:maxPageNumber" content="0"/>\n' +
      '  </head>\n' +
      '  <docTitle><text>' + esc(meta.title) + '</text></docTitle>\n' +
      '  <navMap>\n' +
      points.map(function (p, i) {
        return '    <navPoint id="np-' + (i + 1) + '" playOrder="' + (i + 1) + '">' +
          '<navLabel><text>' + esc(p.text) + '</text></navLabel><content src="' + esc(p.src) + '"/></navPoint>';
      }).join('\n') + '\n' +
      '  </navMap>\n' +
      '</ncx>\n';
  }

  function navDocument(meta, headings) {
    var x = newXhtmlDocument(meta.title, meta.lang);
    var nav = x.el('nav');
    nav.setAttributeNS(OPS_NS, 'epub:type', 'toc');
    nav.id = 'toc';
    var h = x.el('h1');
    h.textContent = 'Contents';
    var ol = x.el('ol');
    var li = x.el('li');
    li.appendChild(x.link('content.xhtml', meta.title));
    if (headings.length) {
      var sub = x.el('ol');
      headings.forEach(function (hd) {
        var item = x.el('li');
        item.appendChild(x.link('content.xhtml' + fragment(hd.id), hd.text));
        sub.appendChild(item);
      });
      li.appendChild(sub);
    }
    ol.appendChild(li);
    nav.append(h, ol);
    x.body.appendChild(nav);
    return x.serialize();
  }

  function contentDocument(meta, content) {
    var x = newXhtmlDocument(meta.title, meta.lang);
    var header = x.el('header');
    var h1 = x.el('h1');
    h1.textContent = meta.title;
    header.appendChild(h1);
    if (meta.byline) {
      var by = x.el('p');
      by.className = 'byline';
      by.textContent = meta.byline;
      header.appendChild(by);
    }
    var src = x.el('p');
    src.className = 'source';
    src.appendChild(x.link(meta.source, meta.siteName || hostOf(meta.source)));
    header.appendChild(src);
    x.body.appendChild(header);
    x.body.appendChild(x.doc.importNode(content, true));
    return x.serialize();
  }

  function newXhtmlDocument(title, lang) {
    var doc = document.implementation.createDocument(XHTML_NS, 'html', null);
    var html = doc.documentElement;
    html.setAttribute('lang', lang);
    html.setAttributeNS(XML_NS, 'xml:lang', lang);
    function el(name) { return doc.createElementNS(XHTML_NS, name); }
    var head = el('head');
    var t = el('title');
    t.textContent = title;
    var css = el('link');
    css.setAttribute('rel', 'stylesheet');
    css.setAttribute('type', 'text/css');
    css.setAttribute('href', 'style.css');
    head.append(t, css);
    var body = el('body');
    html.append(head, body);
    return {
      doc: doc,
      body: body,
      el: el,
      link: function (href, text) {
        var a = el('a');
        a.setAttribute('href', href);
        a.textContent = text;
        return a;
      },
      serialize: function () {
        return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
          new XMLSerializer().serializeToString(html) + '\n';
      }
    };
  }

  var STYLESHEET = [
    'body { font-family: serif; line-height: 1.5; margin: 0 1em; }',
    'h1, h2, h3, h4, h5, h6 { font-family: sans-serif; line-height: 1.2; }',
    'header { margin-bottom: 2em; }',
    '.byline, .source { font-family: sans-serif; font-size: 0.9em; margin: 0.3em 0; }',
    'img { max-width: 100%; height: auto; }',
    'figure { margin: 1em 0; }',
    'figcaption { font-size: 0.9em; font-style: italic; }',
    'blockquote { margin: 1em 1.5em; }',
    'pre { white-space: pre-wrap; font-size: 0.85em; }',
    'table { border-collapse: collapse; }',
    'td, th { border: 1px solid #999; padding: 0.2em 0.4em; }'
  ].join('\n') + '\n';

  // ---------------------------------------------------------------------------
  // Download and status UI

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function createStatus() {
    var el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    var style = {
      position: 'fixed', zIndex: '2147483647', top: '16px', right: '16px', maxWidth: '360px',
      padding: '10px 14px', background: '#222', color: '#fff', font: '14px/1.4 system-ui, sans-serif',
      borderRadius: '6px', boxShadow: '0 2px 10px rgba(0,0,0,.3)', cursor: 'pointer'
    };
    Object.keys(style).forEach(function (k) { el.style[k] = style[k]; });
    el.title = 'Click to dismiss';
    el.addEventListener('click', function () { el.remove(); });
    document.documentElement.appendChild(el);
    function set(text) { el.textContent = 'html2epub: ' + text; }
    return {
      set: set,
      done: function (text) { set(text); setTimeout(function () { el.remove(); }, 5000); },
      error: function (text) { el.style.background = '#a01818'; set(text); setTimeout(function () { el.remove(); }, 10000); }
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers

  function toSet(s) { return new Set(s.split(/\s+/)); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function stripXmlIllegal(s) {
    return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  }

  function cleanText(s) {
    return s ? stripXmlIllegal(String(s)).replace(/\s+/g, ' ').trim() : '';
  }

  function validLang(s) {
    return s && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(s) ? s : null;
  }

  function w3cDate(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function fileName(title) {
    return title.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'article';
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return url; }
  }

  // '#id' as a URL fragment; ids can contain characters that need escaping in URLs.
  function fragment(id) {
    return '#' + encodeURI(id).replace(/#/g, '%23');
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function pad(n) { return String(n).padStart(3, '0'); }
})();
