/* Pure helpers (no DOM). Works in the browser (window.Lib) and in Node for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- text helpers ---------- */
  const strip = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normHeader = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const norm = (s) => strip(s).toLowerCase();
  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- reference type (by number of digits) ---------- */
  function detectType(ref) {
    const s = String(ref).trim();
    if (/^\d+$/.test(s)) {
      if (s.length === 8) return 'd8';
      if (s.length === 6) return 'd6';
      if (s.length === 3) return 'd3';
    }
    return 'other';
  }

  // 65123456 -> "65 123 456", 123456 -> "123 456"; other references are shown as they are.
  function formatRef(ref, type) {
    const s = String(ref);
    if (type === 'd8') return s.slice(0, 2) + ' ' + s.slice(2, 5) + ' ' + s.slice(5);
    if (type === 'd6') return s.slice(0, 3) + ' ' + s.slice(3);
    return s;
  }
  // Short text drawn next to a point on the map: the first 2 digits of an 8-digit reference are left out.
  function mapLabel(ref, type) {
    const s = String(ref);
    if (type === 'd8') return s.slice(2, 5) + ' ' + s.slice(5);
    return formatRef(s, type);
  }
  // Points with identical coordinates (to ~10 cm) share one spot on the map.
  const groupKey = (r) => r.lat.toFixed(6) + ',' + r.lng.toFixed(6);

  /* ---------- columns ---------- */
  const ALIASES = {
    ref: ['reference', 'ref', 'refnumber', 'refno', 'referencenumber', 'referenceno', 'numref', 'numeroreference'],
    lat: ['latitude', 'lat'],
    lng: ['longitude', 'lng', 'lon', 'long'],
    name: ['clientname', 'client', 'name', 'nom', 'nomclient'],
    ctr: ['ctrnumber', 'ctr', 'ctrno'],
    area: ['area', 'zone', 'delegation', 'ville', 'city'],
    address: ['address', 'adresse'],
    transformer: ['transformater', 'transformer', 'transformateur', 'poste'],
    status: ['status', 'statut', 'etat'],
    notes: ['notes', 'note', 'remarque', 'remarques', 'comment', 'comments'],
  };
  // Columns that add nothing once we build our own map links.
  const IGNORED = ['googlemaps', 'googlemap', 'map', 'maps', 'link', 'url', 'location', 'position'];

  function parseNumber(v) {
    if (v == null) return NaN;
    let s = String(v).trim().replace(/\s+/g, '');
    if (!s) return NaN;
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function findHeaderRow(matrix) {
    const limit = Math.min(matrix.length, 15);
    for (let i = 0; i < limit; i++) {
      const h = matrix[i].map(normHeader);
      const has = (list) => h.some((x) => list.includes(x));
      if (has(ALIASES.ref) && has(ALIASES.lat) && has(ALIASES.lng)) return i;
    }
    return -1;
  }

  /**
   * matrix: array of rows (arrays of strings), as returned by Papa.parse(text).data
   * returns { rows, skipped: {noRef, noCoords}, headers }
   */
  function parseMatrix(matrix) {
    const hi = findHeaderRow(matrix);
    if (hi < 0) {
      const seen = (matrix[0] || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8).join(', ');
      throw new Error(
        'Could not find the columns Reference, Latitude and Longitude in the first rows.' +
          (seen ? ' Columns found: ' + seen + '.' : '')
      );
    }
    const headers = matrix[hi].map((h) => String(h).trim());
    const nh = headers.map(normHeader);
    const idx = {};
    for (const role of Object.keys(ALIASES)) idx[role] = nh.findIndex((h) => ALIASES[role].includes(h));

    const used = new Set(Object.values(idx).filter((i) => i >= 0));
    const extraCols = [];
    headers.forEach((h, i) => {
      if (!h || used.has(i) || IGNORED.includes(nh[i])) return;
      extraCols.push([i, h]);
    });

    const rows = [];
    const skipped = { noRef: 0, noCoords: 0 };
    const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');

    for (let k = hi + 1; k < matrix.length; k++) {
      const r = matrix[k];
      if (!r || !r.some((c) => String(c).trim() !== '')) continue;
      const ref = cell(r, idx.ref);
      if (!ref) { skipped.noRef++; continue; }
      let lat = parseNumber(r[idx.lat]);
      let lng = parseNumber(r[idx.lng]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skipped.noCoords++; continue; }
      // Latitude/longitude typed the wrong way round (Tunisia: lat ~30-37, lng ~7-12).
      if (lat < 20 && lng > 25) [lat, lng] = [lng, lat];
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) { skipped.noCoords++; continue; }

      const extra = {};
      for (const [i, h] of extraCols) {
        const v = cell(r, i);
        if (v) extra[h] = v;
      }
      rows.push({
        ref,
        type: detectType(ref),
        lat,
        lng,
        name: cell(r, idx.name),
        ctr: cell(r, idx.ctr),
        area: cell(r, idx.area),
        address: cell(r, idx.address),
        transformer: cell(r, idx.transformer),
        status: cell(r, idx.status),
        notes: cell(r, idx.notes),
        extra,
      });
    }
    return { rows, skipped, headers };
  }

  /* ---------- search ---------- */
  function haystack(r) {
    return norm([r.ref, r.name, r.ctr, r.area, r.address, r.transformer, r.status, r.notes].join(' '));
  }
  const digitsOnly = (q) => (/^[\d\s]+$/.test(String(q).trim()) ? String(q).replace(/\s+/g, '') : '');
  function matchQuery(hay, q) {
    const d = digitsOnly(q);
    if (d) return hay.includes(d);
    const tokens = norm(q).split(/\s+/).filter(Boolean);
    return tokens.every((t) => hay.includes(t));
  }
  // Order: exact reference, then the 6 digits shown on the map for an 8-digit reference, then starts-with, then the rest.
  function rank(rows, q) {
    const first = digitsOnly(q) || norm(q).split(/\s+/).filter(Boolean)[0] || '';
    const score = (r) => {
      const ref = r.ref.toLowerCase();
      if (!first) return 9;
      if (ref === first) return 0;
      if (r.type === 'd8' && ref.slice(2) === first) return 1;
      if (ref.startsWith(first)) return 2;
      return 3;
    };
    return rows.slice().sort((a, b) => score(a) - score(b) || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  }
  // Rows whose whole reference was typed: 65123456 (exact), or the 6 digits you see on the map for an 8-digit reference.
  function refHits(rows, q) {
    const c = digitsOnly(q);
    if (!/^\d{3,8}$/.test(c)) return [];
    return rows.filter((r) => r.ref === c || (r.type === 'd8' && r.ref.slice(2) === c));
  }

  /* ---------- Google Sheets links ---------- */
  function sheetCsvUrls(input) {
    const url = String(input).trim();
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    const pub = url.match(/docs\.google\.com\/spreadsheets\/d\/e\/([\w-]+)/);
    if (pub) {
      return [`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid ? '&gid=' + gid : ''}`];
    }
    const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
    if (m) {
      const g = gid ? '&gid=' + gid : '';
      return [
        `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv${g}`,
        `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${g}`,
      ];
    }
    return [url];
  }

  /* ---------- misc ---------- */
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function formatDistance(m) {
    return m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }
  const mapsUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const directionsUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

  // CSV files from Excel are often Windows-1252, not UTF-8.
  function decodeCsv(buffer) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch (e) { text = new TextDecoder('windows-1252').decode(buffer); }
    return text.replace(/^\uFEFF/, '');
  }

  return {
    detectType, formatRef, mapLabel, groupKey, parseNumber, parseMatrix, haystack, matchQuery, rank, refHits,
    sheetCsvUrls, haversine, formatDistance, mapsUrl, directionsUrl,
    decodeCsv, escapeHtml, norm,
  };
});
