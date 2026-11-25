/* An Naashir app worker (specs/v12-take-it-home.md). Plain JavaScript with no build step: tools/build.mjs only stamps
   the version. Every address is built from the worker's scope, so the GitHub Pages sub-address works; no string or
   template literal in this file may start with a slash, because tools/rebase.mjs rewrites those (W2 proves it).
   It keeps (a) the app shell: the two saved-books pages and the site's own scripts, styles and fonts, and (b) the
   books a reader chose to save. It never stores visited pages or pictures (decision 1). */
const VERSION = 'dd887464';
const SHELL = 'an-shell-' + VERSION;
const SAVED = 'an-saved'; // never versioned: app updates keep saved books (decision 4)
const SCOPE = self.registration.scope;
const at = (p) => new URL(p, SCOPE).href;
const META = at('an-saved-meta/');
const SHELL_PAGES = ['saved/', 'en/saved/'];
const LOOK = { ignoreSearch: true };
const QUARTER_HOUR = 15 * 60 * 1000;
const saving = new Set(); // URLs a save or re-save is storing right now (decision 4c)
const jobs = new Set(); // running saves and re-saves; cancel marks them

/* collect(page, get): every same-origin file a page needs (decision 3). get(url) returns a Response or throws.
   Returns a Map url -> Response holding the page itself and every file found, each fetched once. */
const RX_HTML = /(?:href|src)="([^"]+\.(?:css|m?js|woff2))"/g;
const RX_URL = /url\(["']?([^"')]+\.woff2)/g;
const RX_IMP = /(?:from|import)\s*\(?\s*["'`]([^"'`]+\.m?js)["'`]/g;
const RX_ASTRO = /["'`]([^"'`]*_astro\/[^"'`]+\.(?:m?js|css|woff2))["'`]/g;

async function collect(page, get, got = new Map()) {
  const queue = [page];
  const scan = (text, rx, base) => {
    for (const m of text.matchAll(rx)) {
      let u;
      try { u = new URL(m[1], base); } catch { continue; }
      if (u.origin !== self.location.origin) continue;
      u.search = ''; u.hash = '';
      if (!got.has(u.href) && !queue.includes(u.href)) queue.push(u.href);
    }
  };
  while (queue.length) {
    const u = queue.shift();
    if (got.has(u)) continue;
    const r = await get(u);
    got.set(u, r);
    const ext = (u.match(/\.(\w+)$/) || [])[1];
    if (u === page) {
      const t = await r.clone().text();
      scan(t, RX_HTML, u); scan(t, RX_URL, u);
    } else if (ext === 'css') {
      scan(await r.clone().text(), RX_URL, u);
    } else if ((ext === 'js' || ext === 'mjs') && !/pdf\.worker[^\/]*$/.test(u)) {
      const t = await r.clone().text();
      scan(t, RX_IMP, u); scan(t, RX_ASTRO, u);
    }
  }
  return got;
}

// From the network; page HTML is revalidated (GitHub Pages lets browsers keep HTML for 10 minutes).
async function net(u) {
  const r = await fetch(u, { cache: /\/$/.test(u) ? 'no-cache' : 'default' });
  if (!r.ok) throw new Error(u + ' ' + r.status);
  return r;
}

// Past every HTTP cache: a deploy can rewrite a file in place under the same name (decision 5b).
async function fresh(u) {
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error(u + ' ' + r.status);
  return r;
}

// What goes into an-saved: the body as it is (already unpacked), stamped with the time (decision 4b).
function stored(r) {
  const h = new Headers(r.headers);
  h.delete('content-encoding'); h.delete('content-length');
  h.set('X-Saved-At', String(Date.now()));
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// The saved books' records (decision 4b). A missing an-saved cache means nothing is saved: it is never created here.
async function records() {
  if (!(await caches.has(SAVED))) return [];
  const c = await caches.open(SAVED);
  const keys = (await c.keys()).filter((r) => r.url.startsWith(META));
  const out = [];
  for (const k of keys) { try { out.push(await (await c.match(k)).json()); } catch { /* a broken record lists nothing */ } }
  return out;
}

const recordUrl = (r) => at('an-saved-meta/' + r.lang + '-' + r.slug + '.json');
const putRecord = (c, r) => c.put(recordUrl(r), new Response(JSON.stringify(r), {
  headers: { 'Content-Type': 'application/json', 'X-Saved-At': String(Date.now()) },
}));
const listed = (recs) => new Set(recs.flatMap((r) => [r.page, r.pdf, ...(r.assets || [])]));

function start(urls) {
  const job = { cancel: false, urls };
  urls.forEach((u) => saving.add(u));
  jobs.add(job);
  return job;
}
function end(job) {
  jobs.delete(job);
  job.urls.forEach((u) => { if (![...jobs].some((j) => j.urls.includes(u))) saving.delete(u); });
}

// Delete these URLs unless a record lists them.
async function drop(c, urls) {
  const keep = listed(await records());
  for (const u of urls) if (!keep.has(u)) await c.delete(u, LOOK);
}

/* Decision 4b: the page has put the PDF; store the reader page's files, then the page, then the record last. */
async function save(d) {
  if (!(await caches.has(SAVED))) return 'save-failed';
  const c = await caches.open(SAVED);
  if (!(await c.match(d.pdf, LOOK))) return 'save-failed';
  let job = null;
  const mine = [];
  try {
    const got = await collect(d.page, net);
    if (d.worker && !got.has(d.worker)) got.set(d.worker, await net(d.worker));
    job = start([...got.keys()]);
    for (const [u, r] of got) {
      if (u === d.page) continue;
      if (job.cancel) return 'cancelled';
      await c.put(u, stored(r)); mine.push(u);
    }
    if (job.cancel) return 'cancelled';
    await c.put(d.page, stored(got.get(d.page))); mine.push(d.page);
    const assets = [...got.keys()].filter((u) => u !== d.page && u !== d.pdf);
    for (const u of [d.pdf, d.page, ...assets]) if (!(await c.match(u, LOOK))) throw new Error('missing ' + u);
    const pdf = await c.match(d.pdf, LOOK);
    const size = Number(pdf.headers.get('Content-Length')) || (await pdf.blob()).size;
    if (job.cancel) return 'cancelled';
    await putRecord(c, { slug: d.slug, lang: d.lang, page: d.page, pdf: d.pdf, bytes: d.bytes, size, title: d.title,
      titleEn: d.titleEn, savedAt: Date.now(), stale: false, assets });
    return 'saved';
  } catch (err) {
    await drop(c, mine);
    return 'save-failed';
  } finally {
    if (job) end(job);
  }
}

/* Decision 5b: a saved reader page answered 200 by the network. A new edition marks the record stale; otherwise the
   book is saved again from the new HTML, so renamed files never leave a saved page without its scripts. */
async function refresh(rec, res) {
  const html = await res.clone().text();
  const c = await caches.open(SAVED);
  const old = await c.match(rec.page, LOOK);
  if (old && (await old.text()) === html) return;
  const tag = (html.match(/<div class="reader"[^>]*>/) || [''])[0];
  const attr = (n) => (tag.match(new RegExp(' ' + n + '="([^"]*)"')) || [])[1];
  if (!attr('data-pdf')) return;
  if (new URL(attr('data-pdf'), rec.page).href !== rec.pdf || Number(attr('data-bytes')) !== rec.bytes) {
    await putRecord(c, { ...rec, stale: true });
    return;
  }
  if (self.navigator.connection && self.navigator.connection.saveData) return;
  let job = null;
  try {
    const got = await collect(rec.page, (u) => (u === rec.page ? res : fresh(u)));
    job = start([...got.keys()]);
    for (const [u, r] of got) {
      if (u === rec.page) continue;
      if (job.cancel) return;
      await c.put(u, stored(r));
    }
    const assets = [...got.keys()].filter((u) => u !== rec.page && u !== rec.pdf);
    for (const u of [rec.pdf, ...assets]) if (!(await c.match(u, LOOK))) return;
    if (job.cancel) return;
    await c.put(rec.page, stored(res));
    await putRecord(c, { ...rec, assets });
    await drop(c, (rec.assets || []).filter((u) => !assets.includes(u)));
  } catch {
    /* the network failed: the saved copy stays as it was */
  } finally {
    if (job) end(job);
  }
}

/* Decision 4c: delete what no record lists (orphans of an interrupted save). URLs in drop go whatever their age;
   others only when no save is storing them and they are over 15 minutes old. */
async function sweep(dropUrls = []) {
  if (!(await caches.has(SAVED))) return;
  const c = await caches.open(SAVED);
  const keep = listed(await records());
  const old = Date.now() - QUARTER_HOUR;
  for (const r of await c.keys()) {
    const u = r.url;
    if (u.startsWith(META) || keep.has(u)) continue;
    if (dropUrls.includes(u)) { await c.delete(r); continue; }
    if (saving.has(u)) continue;
    const hit = await c.match(r);
    if ((Number(hit && hit.headers.get('X-Saved-At')) || 0) < old) await c.delete(r);
  }
}

/* Clearing (decision 8): the shell also gathers scripts as pages are visited, and their names hint at what was read.
   Keep only what the two saved pages need, read from the shell itself (works offline), add what is missing. If the
   set cannot be worked out (offline and a file missing), nothing is deleted. */
async function resetShell() {
  const c = await caches.open(SHELL);
  const got = new Map();
  const get = async (u) => (await c.match(u)) || net(u);
  try {
    for (const p of SHELL_PAGES) await collect(at(p), get, got);
  } catch { return; }
  for (const k of await c.keys()) if (!got.has(k.url)) await c.delete(k);
  for (const [u, r] of got) if (!(await c.match(u))) await c.put(u, r);
}

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const got = new Map();
  for (const p of SHELL_PAGES) await collect(at(p), net, got);
  const c = await caches.open(SHELL);
  await Promise.all([...got].map(([u, r]) => c.put(u, r)));
  await self.skipWaiting();
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('an-shell-') && k !== SHELL) await caches.delete(k);
  await sweep();
  await self.clients.claim();
})()));

self.addEventListener('message', (e) => {
  const d = e.data || {};
  const reply = (m) => { if (e.source) e.source.postMessage(m); };
  if (d.type === 'save') e.waitUntil(save(d).then((type) => reply({ type, slug: d.slug, lang: d.lang })));
  else if (d.type === 'sweep') e.waitUntil(sweep(Array.isArray(d.drop) ? d.drop : []).then(() => reply({ type: 'swept' })));
  else if (d.type === 'cancel') {
    jobs.forEach((j) => { j.cancel = true; });
    e.waitUntil((async () => {
      while (jobs.size) await new Promise((r) => setTimeout(r, 100));
      reply({ type: 'cancelled' });
    })());
  } else if (d.type === 'reset-shell') e.waitUntil(resetShell().then(() => reply({ type: 'shell-reset' })));
});

// Decision 5c: a saved PDF, in whole or in byte ranges, the way GitHub Pages answers.
function ranged(req, blob) {
  const size = blob.size;
  const head = (n) => ({ 'Accept-Ranges': 'bytes', 'Content-Length': String(n), 'Content-Type': 'application/pdf' });
  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('Range') || '').trim());
  if (!m || (!m[1] && !m[2])) return new Response(blob, { status: 200, headers: head(size) }); // none, or several ranges
  let a, b;
  if (!m[1]) { a = Math.max(0, size - Number(m[2])); b = size - 1; }
  else { a = Number(m[1]); b = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (a >= size || a > b) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(blob.slice(a, b + 1), { status: 206, headers: { ...head(b + 1 - a), 'Content-Range': `bytes ${a}-${b}/${size}` } });
}

async function pdf(req, bare) {
  const mine = (await records()).filter((r) => r.pdf === bare);
  const hit = mine.length ? await caches.match(bare, { ...LOOK, cacheName: SAVED }) : null;
  if (!hit) return fetch(req);
  if (mine.every((r) => r.stale)) {
    try { return await fetch(req); } catch { /* offline: the saved edition */ }
  }
  return ranged(req, await hit.blob());
}

// Decision 5b and 5e: page navigations.
async function navigate(e, req, bare, rel) {
  const rec = (await records()).find((r) => r.page === bare);
  if (rec) {
    const saved = await caches.match(rec.page, { ...LOOK, cacheName: SAVED });
    let bg = null;
    const live = fetch(req).then((r) => { if (r.status === 200) bg = refresh(rec, r.clone()).catch(() => {}); return r; });
    e.waitUntil(live.then(() => bg, () => null));
    const r = await Promise.race([live.catch(() => null), new Promise((ok) => setTimeout(() => ok(null), 4000))]);
    if (r && r.status === 200) return r;
    if (saved) return saved;
    if (r) return r;
  }
  try {
    return await fetch(req);
  } catch (err) {
    const hit = await caches.match(at(rel === 'en' || rel.startsWith('en/') ? 'en/saved/' : 'saved/'), { cacheName: SHELL });
    if (hit) return hit;
    throw err;
  }
}

// Decision 5d and 5f: a saved book's files first, then the shell (scripts, styles, fonts), cache first.
async function asset(req, rel) {
  if (await caches.has(SAVED)) {
    const hit = await caches.match(req, { ...LOOK, cacheName: SAVED });
    if (hit) return hit;
  }
  if (!/\.(?:js|css)$/.test(rel) && !rel.startsWith('fonts/')) return fetch(req);
  const c = await caches.open(SHELL);
  const hit = await c.match(req, LOOK);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone());
  return r;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.searchParams.get('an-fresh') === '1') return;
  const bare = url.origin + url.pathname;
  if (url.origin !== self.location.origin) {
    if (/\.pdf$/i.test(url.pathname)) e.respondWith(pdf(req, bare)); // a saved book whose PDF lives elsewhere
    return;
  }
  if (!url.href.startsWith(SCOPE)) return;
  const rel = url.href.slice(SCOPE.length).split(/[?#]/)[0];
  if (rel === 'admin' || rel.startsWith('admin/')) return;
  if (req.mode === 'navigate') return e.respondWith(navigate(e, req, bare, rel));
  if (/\.pdf$/i.test(rel)) return e.respondWith(pdf(req, bare));
  if (/^_astro\/[^\/]+\.(?:m?js|css|woff2)$/.test(rel) || rel.startsWith('fonts/')) return e.respondWith(asset(req, rel));
});
