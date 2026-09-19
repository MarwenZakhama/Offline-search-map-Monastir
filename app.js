(() => {
  'use strict';

  /* ================= settings ================= */
  const TILES_URL = 'monastir.pmtiles';           // vector map of the Monastir area (see README)
  const VIEW = [[35.50, 10.65], [35.80, 11.05]];  // where the map opens
  const LIMITS = [[35.25, 10.35], [36.05, 11.35]]; // the map can't be dragged beyond this
  const LIST_LIMIT = 150;

  const TYPES = {
    d8: { label: '8 digits', color: '#d9480f' },
    d6: { label: '6 digits', color: '#0a7c6b' },
    d3: { label: '3 digits', color: '#6741d9' },
    other: { label: 'Other', color: '#5c6773' },
  };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = Lib.escapeHtml;
  for (const k in TYPES) document.documentElement.style.setProperty('--c-' + k, TYPES[k].color);

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
    types: new Set(Object.keys(TYPES)),
    area: '',
    status: '',
  };
  const markerOf = new WeakMap();
  let map, markerLayer, canvasRenderer, baseLayer, ring;
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
  function initMap() {
    canvasRenderer = L.canvas({ padding: 0.4, tolerance: 8 });
    map = L.map('map', {
      zoomControl: false,
      minZoom: 9,
      maxZoom: 19,
      maxBounds: LIMITS,
      maxBoundsViscosity: 0.9,
      renderer: canvasRenderer,
      zoomSnap: 0.5,
    });
    map.fitBounds(VIEW);
    map.attributionControl.setPrefix(false);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.on('popupclose', () => { if (ring) { ring.remove(); ring = null; } });
    map.on('dragstart', () => setCentered(false));
  }

  /* ---------- base map: saved vector tiles, or online fallback ---------- */
  function tileSourceFromBlob(blob) {
    return {
      getKey: () => 'monastir-saved-map',
      getBytes: async (offset, length) => ({ data: await blob.slice(offset, offset + length).arrayBuffer() }),
    };
  }
  function setBase(layer) {
    if (baseLayer) baseLayer.remove();
    baseLayer = layer.addTo(map);
    baseLayer.bringToBack && baseLayer.bringToBack();
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
    setBase(
      protomapsL.leafletLayer({
        url: archive,
        flavor: 'light',
        lang: 'fr',
        attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
      })
    );
    $('#banner').hidden = true;
  }
  function useOnlineTiles() {
    setBase(
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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

  function markerFor(r) {
    let m = markerOf.get(r);
    if (m) return m;
    m = L.circleMarker([r.lat, r.lng], {
      renderer: canvasRenderer,
      radius: 8,
      weight: 2.5,
      color: '#ffffff',
      fillColor: TYPES[r.type].color,
      fillOpacity: 1,
    });
    m.on('click', () => openRow(r));
    markerOf.set(r, m);
    return m;
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
    const base = state.rows.filter(
      (r) => (!state.area || r.area === state.area) && (!state.status || r.status === state.status) && (!q || Lib.matchQuery(r._hay, q))
    );
    const counts = { d8: 0, d6: 0, d3: 0, other: 0 };
    for (const r of base) counts[r.type]++;
    shown = base.filter((r) => state.types.has(r.type));

    markerLayer.clearLayers();
    for (const r of shown) markerLayer.addLayer(markerFor(r));

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

    renderCount(base.length);
    renderList();
    if (fit) fitToShown();
  }

  function renderCount(baseLen) {
    const el = $('#count');
    if (!state.rows.length) { el.textContent = 'No data yet'; return; }
    const total = state.rows.length;
    el.innerHTML =
      `${shown.length.toLocaleString()} ${shown.length === 1 ? 'point' : 'points'}` +
      (shown.length !== total ? `<small>of ${total.toLocaleString()}</small>` : '');
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
          const meta = [r.name, r.area].filter(Boolean).join(' · ') || r.address || '';
          return `<button type="button" class="item" role="listitem" data-i="${i}"><i class="dot" style="background:${TYPES[r.type].color}"></i><span class="ref">${esc(r.ref)}</span><span class="meta">${esc(meta)}</span></button>`;
        })
        .join('') +
      (shown.length > LIST_LIMIT ? `<div class="more">Showing the first ${LIST_LIMIT}. Search or filter to narrow down.</div>` : '');
  }

  function fitToShown() {
    if (!shown.length) return;
    if (shown.length === 1) return map.setView([shown[0].lat, shown[0].lng], 17);
    const b = L.latLngBounds(shown.map((r) => [r.lat, r.lng]));
    map.fitBounds(b, { paddingTopLeft: [24, 140], paddingBottomRight: [24, 40], maxZoom: 17 });
  }

  /* ================= point popup ================= */
  function popupHtml(r) {
    const t = TYPES[r.type];
    const rows = [['Client', r.name], ['CTR', r.ctr], ['Area', r.area], ['Address', r.address], ['Transformer', r.transformer], ['Status', r.status], ['Notes', r.notes], ...Object.entries(r.extra || {})]
      .filter(([, v]) => v)
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join('');
    const near = lastFix ? `<div class="near">${Lib.formatDistance(Lib.haversine(lastFix.lat, lastFix.lng, r.lat, r.lng))} from you</div>` : '';
    return `<div class="pop"><div class="ref">${esc(r.ref)}</div><div class="tag"><i style="background:${t.color}"></i>${t.label}</div>
      ${rows ? `<dl>${rows}</dl>` : '<div style="height:10px"></div>'}${near}
      <div class="acts"><a class="go" href="${Lib.directionsUrl(r.lat, r.lng)}" target="_blank" rel="noopener">Directions</a><a href="${Lib.mapsUrl(r.lat, r.lng)}" target="_blank" rel="noopener">Google Maps</a></div></div>`;
  }
  function openRow(r) {
    if (ring) { ring.remove(); ring = null; }
    L.popup({ offset: [0, -8], maxWidth: 300, autoPanPaddingTopLeft: [20, 130], autoPanPaddingBottomRight: [20, 40] })
      .setLatLng([r.lat, r.lng])
      .setContent(popupHtml(r))
      .openOn(map);
    ring = L.circleMarker([r.lat, r.lng], { renderer: canvasRenderer, radius: 15, weight: 3, color: '#14212b', fill: false, interactive: false }).addTo(map);
  }
  function focusRow(r) {
    const go = () => {
      map.invalidateSize({ pan: false });
      map.setView([r.lat, r.lng], Math.max(map.getZoom(), 17), { animate: false });
      openRow(r);
    };
    if ($('#sheet').classList.contains('open')) { setSheet(false); setTimeout(go, 260); } // wait for the sheet to slide down
    else go();
  }

  /* ================= results sheet ================= */
  function setSheet(open) {
    const sheet = $('#sheet');
    sheet.classList.toggle('open', open);
    $('#sheetHandle').setAttribute('aria-expanded', String(open));
    setTimeout(() => map.invalidateSize({ pan: false }), 260);
  }

  /* ================= GPS ================= */
  let watchId = null, meDot = null, meAcc = null, wantCenter = false, centered = false;

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
    $('#btnLocate').classList.remove('busy');
    if (!meDot) {
      meAcc = L.circle([lat, lng], { renderer: canvasRenderer, radius: accuracy, weight: 1, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
      meDot = L.marker([lat, lng], { icon: L.divIcon({ className: 'me-dot', html: '<span></span>', iconSize: [20, 20], iconAnchor: [10, 10] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      meDot.setLatLng([lat, lng]);
      meAcc.setLatLng([lat, lng]).setRadius(accuracy);
    }
    if (wantCenter) {
      wantCenter = false;
      if (!L.latLngBounds(LIMITS).contains([lat, lng])) toast("You're outside the saved Monastir area.");
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
    if (meDot) { meDot.remove(); meAcc.remove(); meDot = meAcc = null; }
    setLocateUi();
  }
  function onLocateTap() {
    if (!('geolocation' in navigator)) return toast("This browser can't use GPS.");
    if (!window.isSecureContext) return toast('GPS needs the app to be opened over https.', 5000);
    if (watchId === null) {
      wantCenter = true;
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
    // search
    let t;
    $('#q').addEventListener('input', (e) => {
      state.q = e.target.value;
      $('#qClear').hidden = !state.q;
      clearTimeout(t);
      t = setTimeout(() => applyFilters({ fit: state.q.trim().length >= 2 }), 140);
    });
    $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); if (listRows.length) setSheet(true); } });
    $('#qClear').addEventListener('click', () => { $('#q').value = ''; state.q = ''; applyFilters({ fit: true }); $('#q').focus(); });

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
    window.addEventListener('offline', () => { net(); toast("You're offline — saved map and points still work.", 4500); });
    net();
  }

  async function refreshLinks() {
    if (!navigator.onLine) return;
    for (const ds of state.datasets.filter((d) => d.source.kind === 'url')) await refreshDataset(ds, { quiet: true });
  }

  /* ================= start ================= */
  async function start() {
    initMap();
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
