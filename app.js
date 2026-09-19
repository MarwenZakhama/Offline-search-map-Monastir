(() => {
  'use strict';

  /* ================= settings ================= */
  const APP_VERSION = '1.3.0';
  const TILES_URL = 'monastir.pmtiles';           // vector map of the Monastir area (see README)
  const VIEW = [[35.50, 10.65], [35.80, 11.05]];  // where the map opens
  const LIMITS = [[35.25, 10.35], [36.05, 11.35]]; // the map can't be dragged beyond this
  const LIST_LIMIT = 150;
  const LABEL_ZOOM = 16;          // references are written next to the points from this zoom
  const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  // How each type of reference looks on the map, in the list and in the legend.
  const TYPES = {
    d8: { label: '8 digits', color: '#d9480f', shape: 'circle' },
    d6: { label: '6 digits', color: '#ffd43b', shape: 'tri' },      // upside-down triangle
    d3: { label: '3 digits', color: '#1c7ed6', shape: 'diamond' },
    other: { label: 'Other', color: '#5c6773', shape: 'circle' },
  };
  const MIXED = { color: '#ffffff', shape: 'circle' };              // several types on one spot
  const INK = '#14212b';
  const HIT = '#22c55e';          // search matches turn green
  const R_BASE = 3, R_HIT = 4.2, R_DIM = 2.4; // marker radius (px): normal, search match, not a match
  const TYPE_ORDER = { d8: 0, d6: 1, d3: 2, other: 3 };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = Lib.escapeHtml;
  for (const k in TYPES) document.documentElement.style.setProperty('--c-' + k, TYPES[k].color);

  /* ================= point shapes (drawn on the map canvas) ================= */
  L.Canvas.include({
    _updateShape(layer) {
      if (!this._drawing || layer._empty()) return;
      const p = layer._point, ctx = this._ctx, o = layer.options;
      const r = Math.max(layer._radius, 1);
      ctx.beginPath();
      if (o.shape === 'tri') {            // pointing down
        const w = r * 1.2, top = -r * 0.62, bot = r * 1.25;
        ctx.moveTo(p.x - w, p.y + top); ctx.lineTo(p.x + w, p.y + top); ctx.lineTo(p.x, p.y + bot); ctx.closePath();
      } else if (o.shape === 'diamond') {
        const d = r * 1.3;
        ctx.moveTo(p.x, p.y - d); ctx.lineTo(p.x + d, p.y); ctx.lineTo(p.x, p.y + d); ctx.lineTo(p.x - d, p.y); ctx.closePath();
      } else {
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2, false);
      }
      ctx.setLineDash([]);
      ctx.lineJoin = 'round';
      ctx.globalAlpha = o.dim ? 0.3 : 1;                                // points that don't match the search fade back
      ctx.lineWidth = o.dim ? 2 : 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();   // thin white halo: readable on map and satellite
      ctx.lineWidth = o.dim ? 0.8 : 1.3; ctx.strokeStyle = INK; ctx.stroke();     // thin dark outline
      ctx.fillStyle = o.fillColor; ctx.fill();
      if (o.count > 1 && !o.dim) {                                      // several points on this exact spot
        const bx = p.x + r + 2.5, by = p.y - r - 2.5;
        ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.fillStyle = INK; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        ctx.fillStyle = '#ffffff'; ctx.font = '700 7px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(o.count > 9 ? '9+' : String(o.count), bx, by + 0.3);
      }
      ctx.globalAlpha = 1;
    },
  });
  L.ShapeMarker = L.CircleMarker.extend({ _updatePath() { this._renderer._updateShape(this); } });

  // Small SVG version of a marker, for the legend, the list and popups.
  function shapeHtml(type) {
    const t = TYPES[type] || TYPES.other;
    const g = { circle: '<circle cx="8" cy="8" r="6"', tri: '<polygon points="2,3.5 14,3.5 8,14"', diamond: '<polygon points="8,1.5 14.5,8 8,14.5 1.5,8"' }[t.shape];
    return `<svg class="shp" viewBox="0 0 16 16" aria-hidden="true">${g} fill="${t.color}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }

  /* ================= tiny IndexedDB key/value store ================= */
  const idb = (() => {
    let dbp;
    const open = () =>
      (dbp ||= new Promise((res, rej) => {
        const r = indexedDB.open('monastir-map', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('kv', mode);
        const req = fn(t.objectStore('kv'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
    };
  })();

  /* ================= state ================= */
  const state = {
    datasets: [],   // [{id, name, source:{kind,url?}, rows, updated}]
    rows: [],
    q: '',
    mode: '8',      // reference length being searched: '8' | '6' | '3'
    types: new Set(Object.keys(TYPES)),
    area: '',
    status: '',
  };
  let map, markerLayer, labelLayer, canvasRenderer, streetLayer, satLayer, ring;
  let mode = 'map';     // 'map' | 'sat'
  let groups = [];      // one entry per exact coordinate: {key, lat, lng, rows[], marker}
  let groupOf = new Map();
  let shown = [];       // rows currently on the map
  let listRows = [];    // rows currently in the list
  let tilesMeta = null; // {size, saved}
  let lastFix = null;

  /* ================= small UI helpers ================= */
  let toastTimer;
  function toast(msg, ms = 3400) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  const fmtBytes = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n > 1e8 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
  function ago(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString();
  }
  function showMsg(el, text, isErr) {
    el.textContent = text || '';
    el.hidden = !text;
    el.classList.toggle('err', !!isErr);
  }

  /* ================= map ================= */
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  $('#appVersion').textContent = APP_VERSION;

  function initMap() {
    canvasRenderer = L.canvas({ padding: 0.4, tolerance: 10 }); // tiny markers, generous tap area
    map = L.map('map', {
      zoomControl: false,
      attributionControl: false,   // clean map: no credits text on it
      minZoom: 9,
      maxZoom: 19,
      maxBounds: LIMITS,
      maxBoundsViscosity: 0.9,
      renderer: canvasRenderer,
      zoomSnap: 0.5,
    });
    map.fitBounds(VIEW);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    labelLayer = L.layerGroup().addTo(map);
    map.on('popupclose', () => { if (ring) { ring.remove(); ring = null; } });
    map.on('dragstart', () => setCentered(false));
    map.on('moveend', scheduleLabels);
  }

  /* ---------- base map: saved vector tiles (or online fallback), and satellite ---------- */
  function tileSourceFromBlob(blob) {
    return {
      getKey: () => 'monastir-saved-map',
      getBytes: async (offset, length) => ({ data: await blob.slice(offset, offset + length).arrayBuffer() }),
    };
  }
  function setStreet(layer) {
    if (streetLayer) streetLayer.remove();
    streetLayer = layer;
    refreshBase();
  }
  function refreshBase() {
    if (mode === 'sat') {
      if (streetLayer) streetLayer.remove();
      if (!satLayer) {
        satLayer = L.tileLayer(SAT_URL, { maxZoom: 19, maxNativeZoom: 18 });
      }
      if (!map.hasLayer(satLayer)) satLayer.addTo(map);
      satLayer.bringToBack();
    } else {
      if (satLayer) satLayer.remove();
      if (streetLayer) { if (!map.hasLayer(streetLayer)) streetLayer.addTo(map); streetLayer.bringToBack(); }
    }
    const b = $('#btnLayers');
    b.setAttribute('aria-pressed', String(mode === 'sat'));
    b.setAttribute('aria-label', mode === 'sat' ? 'Switch to map view' : 'Switch to satellite view');
    b.title = b.getAttribute('aria-label');
  }
  function setMode(next, { quiet } = {}) {
    if (next === 'sat' && !navigator.onLine) { if (!quiet) toast('Satellite needs internet. It will work again when you have signal.', 4200); return; }
    mode = next;
    store.set('monastir.base', mode);
    refreshBase();
  }

  async function setupBasemap() {
    let blob = null;
    try { blob = await idb.get('tiles'); tilesMeta = await idb.get('tilesMeta'); } catch (e) { /* private mode etc. */ }
    if (blob) {
      useSavedTiles(blob);
    } else {
      useOnlineTiles();
      $('#banner').hidden = false;
    }
    renderTilesStatus();
  }
  function useSavedTiles(blob) {
    const archive = new pmtiles.PMTiles(tileSourceFromBlob(blob));
    const layer = protomapsL.leafletLayer({
      url: archive,
      flavor: 'light',
      lang: 'fr',
    });
    MapStyle.extend(layer, { lang: 'fr' });   // places with icons, names, house numbers, more land use (see mapstyle.js)
    setStreet(layer);
    $('#banner').hidden = true;
  }
  function useOnlineTiles() {
    setStreet(
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      })
    );
  }

  async function downloadTiles() {
    const btn = $('#tilesBtn'), bar = $('#tilesProgress'), msg = $('#tilesMsg');
    showMsg(msg, '');
    if (!navigator.onLine) return showMsg(msg, "You're offline. Connect to the internet to save the map.", true);
    btn.disabled = true;
    bar.hidden = false;
    const fill = $('i', bar);
    fill.style.width = '0%';
    try {
      const res = await fetch(TILES_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Map file not found (error ${res.status}). Upload monastir.pmtiles next to index.html — see README.`);
      const total = +res.headers.get('Content-Length') || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        fill.style.width = total ? Math.min(99, (got / total) * 100) + '%' : '50%';
      }
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      const magic = await blob.slice(0, 2).text();
      if (magic !== 'PM') throw new Error('That file is not a PMTiles map. Check that monastir.pmtiles was uploaded correctly.');
      await idb.set('tiles', blob);
      tilesMeta = { size: blob.size, saved: Date.now() };
      await idb.set('tilesMeta', tilesMeta);
      fill.style.width = '100%';
      useSavedTiles(blob);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast('Map saved for offline use');
    } catch (e) {
      showMsg(msg, e.message || 'Could not save the map.', true);
    } finally {
      btn.disabled = false;
      bar.hidden = true;
      renderTilesStatus();
    }
  }
  function renderTilesStatus() {
    const s = $('#tilesStatus'), b = $('#tilesBtn');
    if (tilesMeta) {
      s.textContent = `Saved on this phone · ${fmtBytes(tilesMeta.size)} · ${ago(tilesMeta.saved)}. The map works with no internet.`;
      b.textContent = 'Update saved map';
    } else {
      s.textContent = 'Not saved yet. Save it once while online (about the size of a few photos) and the map will work anywhere, with no signal.';
      b.textContent = 'Save map for offline use';
    }
  }

  /* ================= data ================= */
  const uid = () => Math.random().toString(36).slice(2, 9);

  async function persist() {
    // rows contain only plain data; markers/haystacks are non-enumerable so they aren't stored
    await idb.set('datasets', state.datasets);
  }

  function prepareRows(rows) {
    for (const r of rows) {
      Object.defineProperty(r, '_hay', { value: Lib.haystack(r), enumerable: false, writable: true });
    }
    return rows;
  }

  const byTypeThenRef = (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.ref.localeCompare(b.ref, undefined, { numeric: true });

  // Rows with the same coordinates form one group, drawn as one marker with a count.
  // Groups are made from everything in scope (area/status/type filters). Nothing is hidden by the search:
  // g.match tells which spots contain a match (drawn green); the others stay on the map, faded.
  function buildGroups(scoped, matchSet) {
    const byKey = new Map();
    for (const r of scoped) {
      const k = Lib.groupKey(r);
      let g = byKey.get(k);
      if (!g) { g = { key: k, lat: r.lat, lng: r.lng, rows: [] }; byKey.set(k, g); }
      g.rows.push(r);
    }
    groups = [];
    groupOf = new Map();
    for (const g of byKey.values()) {
      g.rows.sort(byTypeThenRef);
      for (const r of g.rows) groupOf.set(r, g);
      g.match = !matchSet || g.rows.some((r) => matchSet.has(r));
      const kinds = new Set(g.rows.map((r) => r.type));
      const style = kinds.size > 1 ? MIXED : TYPES[g.rows[0].type];
      const searching = !!matchSet;
      g.marker = new L.ShapeMarker([g.lat, g.lng], {
        renderer: canvasRenderer, radius: !searching ? R_BASE : g.match ? R_HIT : R_DIM, weight: 1,
        shape: style.shape, fillColor: searching && g.match ? HIT : style.color, count: g.rows.length,
        dim: searching && !g.match,
      });
      g.marker.on('click', () => openAt(g));
      groups.push(g);
    }
    groups.sort((a, b) => a.match - b.match); // faded ones first, so matches are drawn on top
  }

  function rebuild() {
    state.rows = state.datasets.flatMap((d) => d.rows);
    refreshFilterOptions();
    applyFilters({ fit: false });
    renderDatasets();
  }

  async function addDataset({ name, source, text, fit = true }) {
    const matrix = Papa.parse(text, { skipEmptyLines: true }).data;
    const { rows, skipped } = Lib.parseMatrix(matrix);
    if (!rows.length) throw new Error('No valid points found. Check that Latitude and Longitude are filled in.');
    prepareRows(rows);
    const key = source.kind === 'url' ? source.url : null;
    let ds = key && state.datasets.find((d) => d.source.url === key);
    if (ds) { ds.rows = rows; ds.updated = Date.now(); if (name) ds.name = name; }
    else {
      ds = { id: uid(), name, source, rows, updated: Date.now() };
      state.datasets.push(ds);
    }
    await persist();
    rebuild();
    if (fit) fitToShown();
    const bits = [];
    if (skipped.noCoords) bits.push(`${skipped.noCoords} without valid coordinates`);
    if (skipped.noRef) bits.push(`${skipped.noRef} without a reference`);
    return { count: rows.length, note: bits.length ? ' Skipped: ' + bits.join(', ') + '.' : '' };
  }

  async function fetchCsv(url) {
    const candidates = Lib.sheetCsvUrls(url);
    let lastErr;
    for (const u of candidates) {
      try {
        const res = await fetch(u, { cache: 'no-store', credentials: 'omit' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = Lib.decodeCsv(await res.arrayBuffer());
        if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('The link returned a web page, not data (the sheet is probably private).');
        return text;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Could not load the link.');
  }

  const LINK_HELP =
    "Couldn't read that link. In Google Sheets use File ▸ Share ▸ Publish to web ▸ choose the sheet and CSV, then paste that link — or share the sheet as “Anyone with the link”. You can also choose a CSV file instead.";

  async function loadFromUrl(url, name) {
    if (!navigator.onLine) throw new Error("You're offline. Connect to load a link, or choose a CSV file.");
    let text;
    try { text = await fetchCsv(url); } catch (e) { throw new Error(LINK_HELP + ' (' + (e.message || 'network error') + ')'); }
    return addDataset({ name: name || 'Google Sheet', source: { kind: 'url', url }, text });
  }

  async function refreshDataset(ds, { quiet } = {}) {
    try {
      const text = await fetchCsv(ds.source.url);
      const before = ds.rows.length;
      await addDataset({ name: ds.name, source: ds.source, text, fit: false });
      if (!quiet) toast(`${ds.name} updated · ${ds.rows.length} points` + (ds.rows.length !== before ? ` (was ${before})` : ''));
    } catch (e) {
      if (!quiet) toast(navigator.onLine ? 'Could not refresh — showing saved data' : "You're offline — showing saved data");
    }
  }

  function renderDatasets() {
    const box = $('#dsList');
    box.innerHTML = state.datasets
      .map(
        (d) => `<div class="ds" data-id="${d.id}">
          <div class="grow"><div class="name">${esc(d.name)}</div>
          <div class="meta">${d.rows.length.toLocaleString()} points · ${d.source.kind === 'url' ? 'link' : 'file'} · ${ago(d.updated)}</div></div>
          ${d.source.kind === 'url' ? '<button type="button" data-act="refresh">Refresh</button>' : ''}
          <button type="button" class="danger" data-act="remove">Remove</button></div>`
      )
      .join('');
  }

  /* ================= filtering ================= */
  function refreshFilterOptions() {
    const fill = (sel, values, any) => {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${any}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
      sel.value = values.includes(cur) ? cur : '';
    };
    const uniq = (k) => [...new Set(state.rows.map((r) => r[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const areas = uniq('area'), statuses = uniq('status');
    fill($('#fArea'), areas, 'All areas');
    fill($('#fStatus'), statuses, 'Any status');
    $('#fArea').parentElement.hidden = !areas.length;
    $('#statusField').hidden = !statuses.length;
    state.area = $('#fArea').value;
    state.status = $('#fStatus').value;
  }

  function applyFilters({ fit = false } = {}) {
    const q = state.q.trim();
    const scoped = state.rows.filter((r) => (!state.area || r.area === state.area) && (!state.status || r.status === state.status));
    const matched = q ? scoped.filter((r) => Lib.matchRow(r, q, state.mode)) : scoped;
    const counts = { d8: 0, d6: 0, d3: 0, other: 0 };
    for (const r of matched) counts[r.type]++;
    const visibleType = (r) => state.types.has(r.type);
    shown = matched.filter(visibleType);
    buildGroups(scoped.filter(visibleType), q ? new Set(shown) : null);
    markerLayer.clearLayers();
    for (const g of groups) markerLayer.addLayer(g.marker);

    for (const chip of document.querySelectorAll('.chip')) {
      const t = chip.dataset.type;
      $('b', chip).textContent = counts[t].toLocaleString();
      chip.setAttribute('aria-pressed', String(state.types.has(t)));
      if (t === 'other') chip.hidden = !state.rows.some((r) => r.type === 'other');
    }
    const active = (state.area ? 1 : 0) + (state.status ? 1 : 0);
    $('#filterBadge').hidden = !active;
    $('#filterBadge').textContent = active;
    $('#qClear').hidden = !state.q;

    renderCount();
    renderList();
    scheduleLabels();
    if (fit) fitToShown();
  }

  function renderCount() {
    const el = $('#count');
    if (!state.rows.length) { el.textContent = 'No data yet'; return; }
    const total = state.rows.length, sharing = shown.filter((r) => groupOf.get(r).rows.length > 1).length;
    el.innerHTML =
      `${shown.length.toLocaleString()} ${shown.length === 1 ? 'point' : 'points'}` +
      (shown.length !== total ? `<small>of ${total.toLocaleString()}</small>` : '') +
      (sharing > 0 ? `<small>· ${sharing.toLocaleString()} share a spot</small>` : '');
  }

  function renderList() {
    const box = $('#list');
    if (!state.rows.length) {
      box.innerHTML = `<div class="empty">Add a Google Sheet link or a CSV file to see your points on the map.<br><br><button type="button" class="primary" data-open-data>Add points</button></div>`;
      listRows = [];
      return;
    }
    if (!shown.length) {
      box.innerHTML = '<div class="empty">No points match. Try a shorter search or reset the filters.</div>';
      listRows = [];
      return;
    }
    listRows = Lib.rank(shown, state.q).slice(0, LIST_LIMIT);
    box.innerHTML =
      listRows
        .map((r, i) => {
          const same = groupOf.get(r).rows.length;
          const meta = [r.name, r.area].filter(Boolean).join(' · ') || r.address || '';
          return `<button type="button" class="item" role="listitem" data-i="${i}">${shapeHtml(r.type)}<span class="ref">${esc(Lib.formatRef(r.ref, r.type))}</span>` +
            `<span class="meta">${esc(meta)}${same > 1 ? (meta ? ' · ' : '') + `<b class="same">${same} at this spot</b>` : ''}</span></button>`;
        })
        .join('') +
      (shown.length > LIST_LIMIT ? `<div class="more">Showing the first ${LIST_LIMIT}. Search or filter to narrow down.</div>` : '');
  }

  function fitToShown() {
    if (!shown.length) return;
    const gs = groups.filter((g) => g.match);
    if (!gs.length) return;
    if (gs.length === 1) return map.setView([gs[0].lat, gs[0].lng], 18);
    const b = L.latLngBounds(gs.map((g) => [g.lat, g.lng]));
    map.fitBounds(b, { paddingTopLeft: [24, 140], paddingBottomRight: [24, 40], maxZoom: 18 });
  }

  /* ================= references written next to the points ================= */
  let labelRaf = 0;
  function scheduleLabels() {
    if (labelRaf) return;
    labelRaf = requestAnimationFrame(() => { labelRaf = 0; drawLabels(); });
  }

  function labelLines(g) {
    const lines = g.rows.slice(0, 3).map((r) => ({ text: Lib.mapLabel(r.ref, r.type), type: r.type }));
    if (g.rows.length > 3) lines.push({ text: `+${g.rows.length - 3} more`, type: 'more' });
    return lines;
  }

  // Labels appear from LABEL_ZOOM (or earlier when only a few points are in view).
  // Each label tries right, left, above, below, and is skipped if it would cover another label or point.
  function drawLabels() {
    labelLayer.clearLayers();
    if (!groups.length) return;
    const z = map.getZoom();
    if (z < 14) return;
    const view = map.getBounds().pad(0.05);
    const size = map.getSize(), mid = { x: size.x / 2, y: size.y / 2 };
    const vis = [];
    const searching = !!state.q.trim();
    for (const g of groups) {
      if (!view.contains([g.lat, g.lng])) continue;
      const p = map.latLngToContainerPoint([g.lat, g.lng]);
      // while searching, points that don't match keep their reference: it is only faded, like the point
      const faded = searching && !g.match;
      vis.push({ g, p, faded, d: Math.hypot(p.x - mid.x, p.y - mid.y) });
      if (vis.length > 2500) break;
    }
    if (z < LABEL_ZOOM && vis.length > 30) return;
    vis.sort((a, b) => (a.faded - b.faded) || (a.d - b.d)); // matches get a place first, faded ones fill the rest
    const taken = vis.map(({ p }) => ({ x1: p.x - 6, y1: p.y - 6, x2: p.x + 6, y2: p.y + 6 })); // the markers themselves
    const hit = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
    let placed = 0;
    for (const { g, p, faded } of vis) {
      if (placed >= 600) break;
      const lines = labelLines(g);
      const w = Math.max(...lines.map((l) => l.text.length)) * 5.6 + 7, h = lines.length * 10 + 2;
      const options = [
        ['r', p.x + 6, p.y - h / 2], ['l', p.x - 6 - w, p.y - h / 2],
        ['t', p.x - w / 2, p.y - 6 - h], ['b', p.x - w / 2, p.y + 6],
      ];
      for (const [pos, x, y] of options) {
        const box = { x1: x, y1: y, x2: x + w, y2: y + h };
        if (x < 4 || y < 4 || box.x2 > size.x - 4 || box.y2 > size.y - 4) continue;
        if (taken.some((t) => hit(t, box))) continue;
        taken.push(box);
        const only6 = g.rows.every((r) => r.type === 'd6') ? ' lb-d6' : '';
        const html = `<span class="lb p-${pos}${only6}${faded ? ' lb-dim' : ''}">${lines.map((l) => `<b class="t-${l.type}">${esc(l.text)}</b>`).join('')}</span>`;
        labelLayer.addLayer(L.marker([g.lat, g.lng], { icon: L.divIcon({ className: 'lbl', html, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: faded ? 300 : 500 }));
        placed++;
        break;
      }
    }
  }

  /* ================= point popup (one point, or every point on the same spot) ================= */
  function kbOverlap() { // how much of the map an on-screen keyboard is covering
    const vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, Math.round($('#map').getBoundingClientRect().bottom - (vv.offsetTop + vv.height)));
  }

  function detailHtml(r, backCount) {
    const t = TYPES[r.type];
    const rows = [['Client', r.name], ['CTR', r.ctr], ['Area', r.area], ['Address', r.address], ['Transformer', r.transformer], ['Status', r.status], ['Notes', r.notes], ...Object.entries(r.extra || {})]
      .filter(([, v]) => v)
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join('');
    const near = lastFix ? `<div class="near">${Lib.formatDistance(Lib.haversine(lastFix.lat, lastFix.lng, r.lat, r.lng))} from you</div>` : '';
    return (backCount ? `<button type="button" class="back" data-back>‹ All ${backCount} points here</button>` : '') +
      `<div class="ref">${esc(Lib.formatRef(r.ref, r.type))}</div><div class="tag">${shapeHtml(r.type)}${t.label}</div>
      ${rows ? `<dl>${rows}</dl>` : '<div style="height:10px"></div>'}${near}
      <div class="acts"><a class="go" href="${Lib.directionsUrl(r.lat, r.lng)}" target="_blank" rel="noopener">Directions</a><a href="${Lib.mapsUrl(r.lat, r.lng)}" target="_blank" rel="noopener">Google Maps</a></div>`;
  }
  function groupHtml(g) {
    const items = g.rows
      .map((r, i) => {
        const meta = [r.name, r.area].filter(Boolean).join(' · ') || r.address || '';
        return `<button type="button" class="gitem" data-i="${i}">${shapeHtml(r.type)}<span class="ref">${esc(Lib.formatRef(r.ref, r.type))}</span><span class="meta">${esc(meta)}</span></button>`;
      })
      .join('');
    return `<div class="ghead">${g.rows.length} points on this spot</div><div class="glist">${items}</div>`;
  }

  function openAt(g, row) {
    if (ring) { ring.remove(); ring = null; }
    const el = document.createElement('div');
    el.className = 'pop';
    const many = g.rows.length > 1;
    const show = (r) => { el.innerHTML = r ? detailHtml(r, many ? g.rows.length : 0) : groupHtml(g); };
    show(many ? row || null : g.rows[0]);
    const popup = L.popup({
      offset: [0, -8], maxWidth: 300,
      maxHeight: Math.max(220, Math.min(380, Math.round(map.getSize().y * 0.55))),
      autoPanPaddingTopLeft: [20, 130], autoPanPaddingBottomRight: [20, 40 + kbOverlap()],
    }).setLatLng([g.lat, g.lng]).setContent(el);
    el.addEventListener('click', (e) => {
      e.stopPropagation(); // the button is replaced below; without this Leaflet would treat the click as a map click and close the popup
      const item = e.target.closest('.gitem');
      if (item) { show(g.rows[+item.dataset.i]); popup.update(); }
      else if (e.target.closest('[data-back]')) { show(null); popup.update(); }
    });
    popup.openOn(map);
    ring = L.circleMarker([g.lat, g.lng], { renderer: canvasRenderer, radius: 10, weight: 2, color: INK, fill: false, interactive: false }).addTo(map);
  }
  function goTo(g, row) { // used by the list and by search
    map.setView([g.lat, g.lng], Math.max(map.getZoom(), 17), { animate: false });
    openAt(g, row);
  }
  function focusRow(r) {
    const go = () => { map.invalidateSize({ pan: false }); goTo(groupOf.get(r), r); };
    if ($('#sheet').classList.contains('open')) { setSheet(false); setTimeout(go, 260); } // wait for the sheet to slide down
    else go();
  }

  /* ---------- typing a whole reference opens it straight away ---------- */
  let autoTimer = 0, autoKey = '';
  function scheduleAutoOpen() {
    clearTimeout(autoTimer);
    const hits = Lib.refHits(shown, state.q, state.mode);
    const spots = new Set(hits.map(Lib.groupKey));
    if (!hits.length || spots.size !== 1) { autoKey = ''; return false; }
    const g = groupOf.get(hits[0]);
    const key = state.q.replace(/\s+/g, '') + '|' + g.key;
    if (key === autoKey) return true; // already opened for this search
    // the view only moves here: every digit of the chosen length is typed and it points to one single spot
    autoTimer = setTimeout(() => { autoKey = key; goTo(g, hits.length === 1 ? hits[0] : null); }, 150);
    return true;
  }

  /* ================= results sheet ================= */
  function setSheet(open) {
    const sheet = $('#sheet');
    sheet.classList.toggle('open', open);
    $('#sheetHandle').setAttribute('aria-expanded', String(open));
    setTimeout(() => map.invalidateSize({ pan: false }), 260);
  }

  /* ================= GPS ================= */
  let watchId = null, meDot = null, meAcc = null, meBeam = null, wantCenter = false, centered = false;

  /* ---------- which way you are facing ---------- */
  // Compass sensor first (works when standing still); GPS heading only while moving and no compass is available.
  let heading = null, shownHeading = null, lastCompassAt = 0, compassOn = false, headingRaf = 0;
  const ME_HTML =
    '<div class="me-wrap">' +
    '<svg class="me-beam" viewBox="0 0 80 80" aria-hidden="true"><defs><radialGradient id="meBeamG" cx="40" cy="40" r="40" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0.15" stop-color="#1a73e8" stop-opacity="0.6"/><stop offset="1" stop-color="#1a73e8" stop-opacity="0"/></radialGradient></defs>' +
    '<path d="M40 40 L20 6 A40 40 0 0 1 60 6 Z" fill="url(#meBeamG)"/>' +
    '<path d="M40 19.5 L34.5 30 L45.5 30 Z" fill="#1a73e8" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>' +
    '<span class="me-pulse"></span><span class="me-core"></span></div>';

  function compassHeading(alpha, beta, gamma) { // W3C formula: the direction the phone faces, 0 = north, clockwise
    const d = Math.PI / 180;
    const cA = Math.cos(alpha * d), sA = Math.sin(alpha * d), cB = Math.cos(beta * d), sB = Math.sin(beta * d), cG = Math.cos(gamma * d), sG = Math.sin(gamma * d);
    const rA = -cA * sG - sA * sB * cG, rB = -sA * sG + cA * sB * cG;
    if (Math.hypot(rA, rB) < 0.3) return (360 - alpha + 360) % 360; // phone (nearly) flat: use the way its top edge points
    let h = Math.atan(rA / rB) * 180 / Math.PI;
    if (rB < 0) h += 180; else if (rA < 0) h += 360;
    return h;
  }
  function setHeading(h) {
    heading = h;
    if (!headingRaf) headingRaf = requestAnimationFrame(paintHeading);
  }
  function paintHeading() {
    headingRaf = 0;
    if (!meBeam || heading === null) return;
    if (shownHeading === null) shownHeading = heading;
    let diff = ((heading - shownHeading + 540) % 360) - 180;       // shortest way round, so it never spins the long way
    shownHeading = (shownHeading + diff * 0.3 + 360) % 360;        // smoothing: the compass is jittery
    meBeam.style.transform = `rotate(${shownHeading.toFixed(1)}deg)`;
    meBeam.classList.add('on');
    if (Math.abs(diff) > 0.5) headingRaf = requestAnimationFrame(paintHeading);
  }
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading; // iPhone
    else if ((e.absolute || e.type === 'deviceorientationabsolute') && e.alpha != null && e.beta != null && e.gamma != null) h = compassHeading(e.alpha, e.beta, e.gamma); // Android
    if (h === null || Number.isNaN(h)) return;
    lastCompassAt = Date.now();
    setHeading((h + 360) % 360);
  }
  function startCompass() { // must run straight from the tap: iPhone asks for permission there
    if (compassOn || !('DeviceOrientationEvent' in window)) return;
    const listen = () => {
      compassOn = true;
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
    };
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then((r) => { if (r === 'granted') listen(); else toast('Compass not allowed: your direction will show only while you are moving.', 5000); })
        .catch(() => {});
    } else listen();
  }
  function stopCompass() {
    window.removeEventListener('deviceorientationabsolute', onOrient, true);
    window.removeEventListener('deviceorientation', onOrient, true);
    compassOn = false; heading = shownHeading = null; lastCompassAt = 0;
  }

  function setCentered(v) {
    centered = v;
    setLocateUi();
  }
  function setLocateUi() {
    const b = $('#btnLocate');
    b.setAttribute('aria-pressed', String(watchId !== null));
    b.setAttribute('aria-label', watchId === null ? 'Show my position' : centered ? 'Stop following my position' : 'Center on my position');
    b.classList.toggle('centered', centered && watchId !== null);
    if (watchId === null) b.classList.remove('busy');
  }
  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    lastFix = { lat, lng, accuracy };
    const gh = pos.coords.heading, sp = pos.coords.speed;
    if (typeof gh === 'number' && !Number.isNaN(gh) && sp > 1 && Date.now() - lastCompassAt > 2500) setHeading(gh); // moving, no compass
    $('#btnLocate').classList.remove('busy');
    if (!meDot) {
      meAcc = L.circle([lat, lng], { renderer: canvasRenderer, radius: accuracy, weight: 1, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
      meDot = L.marker([lat, lng], { icon: L.divIcon({ className: 'me-dot', html: ME_HTML, iconSize: [80, 80], iconAnchor: [40, 40] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
      meBeam = meDot.getElement().querySelector('.me-beam');
      if (heading !== null) paintHeading();
    } else {
      meDot.setLatLng([lat, lng]);
      meAcc.setLatLng([lat, lng]).setRadius(accuracy);
    }
    if (wantCenter) {
      wantCenter = false;
      if (!L.latLngBounds(LIMITS).contains([lat, lng])) toast("You're outside the saved map area.");
      map.setView([lat, lng], Math.max(map.getZoom(), 16));
      centered = true;
    } else if (centered) {
      map.panTo([lat, lng], { animate: true });
    }
    setLocateUi();
  }
  function onGeoError(err) {
    const msg = {
      1: 'Location is blocked. Allow location for this app in your phone or browser settings.',
      2: "Can't get a GPS position right now. Try moving to an open area.",
      3: 'Finding your position is taking too long. Try again in an open area.',
    }[err.code] || 'Could not get your position.';
    toast(msg, 5000);
    if (err.code === 1) stopWatch();
    else $('#btnLocate').classList.remove('busy');
  }
  function stopWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    centered = false;
    wantCenter = false;
    if (meDot) { meDot.remove(); meAcc.remove(); meDot = meAcc = meBeam = null; }
    stopCompass();
    setLocateUi();
  }
  function onLocateTap() {
    if (!('geolocation' in navigator)) return toast("This browser can't use GPS.");
    if (!window.isSecureContext) return toast('GPS needs the app to be opened over https.', 5000);
    if (watchId === null) {
      wantCenter = true;
      startCompass();
      $('#btnLocate').classList.add('busy');
      watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 4000, timeout: 25000 });
      setLocateUi();
    } else if (centered) {
      stopWatch();
      toast('Stopped following your position');
    } else if (lastFix) {
      map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom(), 16));
      centered = true;
      setLocateUi();
    } else {
      wantCenter = true;
    }
  }

  /* ================= events ================= */
  function openData() { $('#dataView').hidden = false; renderDatasets(); renderTilesStatus(); $('#dataClose').focus(); }
  function closeData() { $('#dataView').hidden = true; $('#btnData').focus(); }

  function wireEvents() {
    // 8 / 6 / 3 selector: which reference length the digits you type are searched in
    const savedMode = store.get('monastir.mode');
    if (['8', '6', '3'].includes(savedMode)) state.mode = savedMode;
    const paintMode = () => { for (const b of document.querySelectorAll('#modeSeg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)); };
    paintMode();
    $('#modeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b || b.dataset.mode === state.mode) return;
      state.mode = b.dataset.mode;
      store.set('monastir.mode', state.mode);
      paintMode();
      clearTimeout(autoTimer); autoKey = '';
      applyFilters();                                   // re-highlight only: the map does not move
      if (state.q.trim().length >= 1) scheduleAutoOpen();
    });

    // search: results update as you type; a whole reference opens its point straight away
    let t;
    $('#q').addEventListener('input', (e) => {
      state.q = e.target.value;
      $('#qClear').hidden = !state.q;
      clearTimeout(t);
      t = setTimeout(() => {
        applyFilters();
        if (!state.q.trim()) { clearTimeout(autoTimer); autoKey = ''; return; }
        scheduleAutoOpen(); // the map stays where it is, until the typed number is one complete, unique reference
      }, 140);
    });
    $('#q').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.target.blur();
      if (listRows.length > 1 && !document.querySelector('.leaflet-popup')) setSheet(true);
    });
    $('#qClear').addEventListener('click', () => {
      clearTimeout(autoTimer); autoKey = '';
      $('#q').value = ''; state.q = ''; applyFilters({ fit: false }); $('#q').focus(); // stay exactly where you are
    });

    for (const chip of document.querySelectorAll('.chip')) {
      $('.dot', chip).outerHTML = shapeHtml(chip.dataset.type);
      chip.setAttribute('aria-label', TYPES[chip.dataset.type].label); // read out by screen readers, not shown
    }
    // type chips (plain toggles; if you switch every type off they all come back on)
    $('#chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const t = chip.dataset.type;
      state.types.has(t) ? state.types.delete(t) : state.types.add(t);
      if (!state.types.size) Object.keys(TYPES).forEach((k) => state.types.add(k));
      applyFilters();
    });

    // filters
    $('#btnFilter').addEventListener('click', () => {
      const p = $('#filters'), open = p.hidden;
      p.hidden = !open;
      $('#btnFilter').setAttribute('aria-expanded', String(open));
    });
    $('#fArea').addEventListener('change', (e) => { state.area = e.target.value; applyFilters({ fit: true }); });
    $('#fStatus').addEventListener('change', (e) => { state.status = e.target.value; applyFilters({ fit: true }); });
    $('#fReset').addEventListener('click', () => {
      state.area = state.status = ''; $('#fArea').value = $('#fStatus').value = '';
      state.types = new Set(Object.keys(TYPES));
      applyFilters({ fit: true });
    });

    // sheet + list
    $('#sheetHandle').addEventListener('click', () => setSheet(!$('#sheet').classList.contains('open')));
    $('#list').addEventListener('click', (e) => {
      if (e.target.closest('[data-open-data]')) return openData();
      const it = e.target.closest('.item');
      if (it) focusRow(listRows[+it.dataset.i]);
    });

    // map buttons
    $('#btnFit').addEventListener('click', fitToShown);
    $('#btnLocate').addEventListener('click', onLocateTap);
    $('#btnLayers').addEventListener('click', () => setMode(mode === 'sat' ? 'map' : 'sat'));

    // data dialog
    $('#btnData').addEventListener('click', openData);
    $('#dataClose').addEventListener('click', closeData);
    $('#dataView').addEventListener('click', (e) => { if (e.target.id === 'dataView') closeData(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dataView').hidden) closeData(); });
    $('#bannerBtn').addEventListener('click', () => { openData(); downloadTiles(); });
    $('#tilesBtn').addEventListener('click', downloadTiles);

    const msg = $('#importMsg');
    const busy = (b) => { $('#urlLoad').disabled = b; };
    $('#urlLoad').addEventListener('click', async () => {
      const url = $('#urlInput').value.trim();
      if (!url) return showMsg(msg, 'Paste a Google Sheet link first.', true);
      busy(true); showMsg(msg, 'Loading…');
      try {
        const r = await loadFromUrl(url, $('#nameInput').value.trim());
        showMsg(msg, `Loaded ${r.count.toLocaleString()} points.${r.note}`);
        $('#urlInput').value = ''; $('#nameInput').value = '';
        closeData();
      } catch (e) { showMsg(msg, e.message, true); }
      busy(false);
    });
    $('#fileInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      showMsg(msg, 'Reading file…');
      try {
        const text = Lib.decodeCsv(await f.arrayBuffer());
        const r = await addDataset({ name: $('#nameInput').value.trim() || f.name.replace(/\.[^.]+$/, ''), source: { kind: 'file' }, text });
        showMsg(msg, `Loaded ${r.count.toLocaleString()} points.${r.note}`);
        $('#nameInput').value = '';
        closeData();
      } catch (err) { showMsg(msg, err.message, true); }
    });
    $('#sampleBtn').addEventListener('click', async () => {
      try {
        const res = await fetch('data/sample.csv');
        if (!res.ok) throw new Error('Sample file not found.');
        const r = await addDataset({ name: 'Sample data', source: { kind: 'file' }, text: Lib.decodeCsv(await res.arrayBuffer()) });
        showMsg(msg, `Loaded ${r.count} sample points.`);
        closeData();
      } catch (err) { showMsg(msg, err.message, true); }
    });
    $('#dsList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const ds = state.datasets.find((d) => d.id === btn.closest('.ds').dataset.id);
      if (!ds) return;
      if (btn.dataset.act === 'remove') {
        if (!confirm(`Remove “${ds.name}” from this phone? The original sheet is not changed.`)) return;
        state.datasets = state.datasets.filter((d) => d !== ds);
        await persist();
        rebuild();
      } else {
        btn.disabled = true; btn.textContent = 'Refreshing…';
        await refreshDataset(ds);
        renderDatasets();
      }
    });

    // connectivity
    const net = () => { $('#netDot').hidden = navigator.onLine; };
    window.addEventListener('online', () => { net(); toast('Back online'); refreshLinks(); });
    window.addEventListener('offline', () => {
      net();
      if (mode === 'sat') { setMode('map', { quiet: true }); toast("You're offline — switched back to the saved map.", 4500); }
      else toast("You're offline — saved map and points still work.", 4500);
    });
    net();
  }

  async function refreshLinks() {
    if (!navigator.onLine) return;
    for (const ds of state.datasets.filter((d) => d.source.kind === 'url')) await refreshDataset(ds, { quiet: true });
  }

  /* ================= start ================= */
  async function start() {
    initMap();
    if (store.get('monastir.base') === 'sat' && navigator.onLine) mode = 'sat';
    wireEvents();
    setupBasemap();
    try {
      const saved = (await idb.get('datasets')) || [];
      state.datasets = saved.map((d) => ({ ...d, rows: prepareRows(d.rows) }));
    } catch (e) { state.datasets = []; }
    rebuild();
    if (state.rows.length) fitToShown();
    else openData();
    refreshLinks();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  start();
})();
