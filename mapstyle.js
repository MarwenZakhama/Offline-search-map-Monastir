/* Extra drawing for the saved (offline) map.
   The built-in Protomaps style draws roads, water and a few town names, but no shops, schools, mosques, banks...
   Everything below only reads what is already inside monastir.pmtiles - no internet, no new download.
   It adds: places (icon + name), neighbourhood / stream / canal names, house numbers, more land use, clearer buildings. */
window.MapStyle = (() => {
  'use strict';

  /* ---------- colours (close to the standard OpenStreetMap look) ---------- */
  const COL = {
    food: '#a4550a', shop: '#7b3fa6', health: '#c2255c', edu: '#7a5210', money: '#1d7a6f', gov: '#46587e',
    transport: '#1c64c8', green: '#1f7a43', lodging: '#0d7b91', worship: '#4a4a4a', other: '#6b6b6b',
  };

  /* ---------- what to draw for each kind of place: [icon, colour, priority(1 = most important)] ---------- */
  const P = {
    // religion, health, education, public services: the landmarks people look for first
    place_of_worship: ['🕌', 'worship', 1], hospital: ['🏥', 'health', 1], clinic: ['🏥', 'health', 1], pharmacy: ['💊', 'health', 1],
    doctors: ['🩺', 'health', 2], dentist: ['🦷', 'health', 2], veterinary: ['🐾', 'health', 2],
    school: ['🏫', 'edu', 1], kindergarten: ['🧸', 'edu', 2], childcare: ['🧸', 'edu', 2], university: ['🎓', 'edu', 1], college: ['🎓', 'edu', 1],
    library: ['📚', 'edu', 1], driving_school: ['🚗', 'edu', 2], research_institute: ['🔬', 'edu', 2],
    townhall: ['🏛️', 'gov', 1], courthouse: ['⚖️', 'gov', 1], police: ['👮', 'gov', 1], fire_station: ['🚒', 'gov', 1],
    post_office: ['✉️', 'gov', 1], community_centre: ['👥', 'gov', 2], prison: ['⛓️', 'gov', 2], vehicle_inspection: ['🚗', 'gov', 3],
    bank: ['🏦', 'money', 1], atm: ['🏧', 'money', 2], bureau_de_change: ['💱', 'money', 3],
    // transport
    fuel: ['⛽', 'transport', 1], bus_station: ['🚌', 'transport', 1], bus_stop: ['🚏', 'transport', 3], station: ['🚉', 'transport', 1],
    halt: ['🚉', 'transport', 2], taxi: ['🚕', 'transport', 3], parking: ['🅿️', 'transport', 3], car_rental: ['🚗', 'transport', 3],
    car_repair: ['🔧', 'transport', 3], car_wash: ['🚿', 'transport', 3], charging_station: ['🔌', 'transport', 3],
    ferry_terminal: ['⛴️', 'transport', 1], aerodrome: ['✈️', 'transport', 1], harbour: ['⚓', 'transport', 1], marina: ['⛵', 'transport', 2],
    tyres: ['🛞', 'transport', 3], car_parts: ['🔧', 'transport', 3], car: ['🚗', 'transport', 3], motorcycle: ['🏍️', 'transport', 3], car_sharing: ['🚗', 'transport', 3],
    // leisure, culture, tourism
    park: ['🌳', 'green', 1], garden: ['🌷', 'green', 2], stadium: ['🏟️', 'green', 1], pitch: ['⚽', 'green', 3], sports_centre: ['🏅', 'green', 2],
    sports_hall: ['🏅', 'green', 2], sports: ['🏅', 'green', 3], fitness_centre: ['🏋️', 'green', 2], swimming_pool: ['🏊', 'green', 3],
    theme_park: ['🎢', 'green', 1], beach: ['🏖️', 'green', 1], golf_course: ['⛳', 'green', 2], playground: ['🛝', 'green', 3],
    cinema: ['🎬', 'lodging', 2], theatre: ['🎭', 'lodging', 2], arts_centre: ['🎨', 'lodging', 2], museum: ['🏛️', 'lodging', 1],
    monument: ['🗿', 'lodging', 2], memorial: ['🕯️', 'lodging', 3], attraction: ['⭐', 'lodging', 1], artwork: ['🎨', 'lodging', 3],
    viewpoint: ['👁️', 'lodging', 3], castle: ['🏰', 'lodging', 1], archaeological_site: ['🏺', 'lodging', 1], fountain: ['⛲', 'lodging', 3],
    city_gate: ['🚪', 'lodging', 2], events_venue: ['🎉', 'lodging', 2], studio: ['🎙️', 'lodging', 3], information: ['ℹ️', 'lodging', 3],
    hotel: ['🏨', 'lodging', 1], guest_house: ['🛏️', 'lodging', 2], hostel: ['🛏️', 'lodging', 2], chalet: ['🏡', 'lodging', 2], apartment: ['🏢', 'lodging', 3],
    toilets: ['🚻', 'lodging', 3], drinking_water: ['🚰', 'lodging', 3], public_bath: ['♨️', 'lodging', 3], rest_area: ['🪑', 'lodging', 3],
    // food and drink
    cafe: ['☕', 'food', 2], restaurant: ['🍽️', 'food', 2], fast_food: ['🍔', 'food', 2], bakery: ['🥖', 'food', 2], pastry: ['🥐', 'food', 2],
    ice_cream: ['🍦', 'food', 3], bar: ['🍸', 'food', 3], seafood: ['🐟', 'food', 3], butcher: ['🥩', 'food', 3], greengrocer: ['🥬', 'food', 3],
    confectionery: ['🍬', 'food', 3], alcohol: ['🍷', 'food', 3],
    // shops
    supermarket: ['🛒', 'shop', 1], convenience: ['🏪', 'shop', 2], marketplace: ['🧺', 'shop', 1], mall: ['🏬', 'shop', 1], department_store: ['🏬', 'shop', 2],
    clothes: ['👕', 'shop', 3], shoes: ['👟', 'shop', 3], hardware: ['🔨', 'shop', 3], electronics: ['📺', 'shop', 3], mobile_phone: ['📱', 'shop', 3],
    computer: ['💻', 'shop', 3], books: ['📖', 'shop', 3], hairdresser: ['💇', 'shop', 3], gift: ['🎁', 'shop', 3], optician: ['👓', 'shop', 3],
    furniture: ['🛋️', 'shop', 3], newsagent: ['📰', 'shop', 3], pet: ['🐾', 'shop', 3], photographer: ['📷', 'shop', 3], laundry: ['🧺', 'shop', 3],
    copyshop: ['🖨️', 'shop', 3], travel_agency: ['🧳', 'shop', 3], internet_cafe: ['💻', 'shop', 3], music: ['🎵', 'shop', 3], electrical: ['💡', 'shop', 3],
  };
  // Not places (road furniture, land use, admin areas...): never drawn as a place.
  const SKIP = new Set(['tree', 'crossing', 'level_crossing', 'railway_crossing', 'give_way', 'stop', 'switch', 'turning_circle', 'buffer_stop',
    'traffic_signals', 'yes', 'industrial', 'residential', 'commercial', 'administrative', 'municipality', 'basin', 'platform', 'secondary',
    'primary', 'tertiary', 'water', 'scrub', 'depot', 'post_box', 'telephone', 'compressed_air', 'ticket', 'clockmaker', 'radiotechnics',
    'photographic_laboratory', 'trade', 'shoemaker', 'carpenter', 'fishing', 'cemetery']);

  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  const TEXT_FONT = '600 10px system-ui, "Segoe UI", Roboto, sans-serif';
  const NAME_ZOOM = 17;   // names are written from this zoom; below it only the icon
  // Every icon and every name of the background map (places, streets, neighbourhoods, house numbers...)
  // is drawn at this opacity, so it stays readable but never competes with your own points.
  // 1 = as before, 0.25 = very faint. Change this single number to make the map more or less visible.
  const MAP_FADE = 0.42;

  const pick = (props, lang) => {
    const n = props['name:' + lang] || props.name || '';
    return n.length > 26 ? n.slice(0, 25) + '…' : n;
  };
  const info = (props) => {
    const k = props.kind;
    if (SKIP.has(k)) return null;
    let e = P[k];
    if (k === 'place_of_worship') {
      const d = props.kind_detail;
      e = [d === 'christian' ? '⛪' : d === 'jewish' ? '🕍' : d === 'muslim' ? '🕌' : '🛐', 'worship', 1];
    }
    if (e) return e;
    return props.name ? ['', 'other', 3] : null;   // any other named place: a small dot + its name
  };

  const roundRect = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };

  /* ---------- places: a small rounded badge with an icon, then the name ---------- */
  function poiSymbolizer(lang) {
    return {
      place(layout, geom, feature) {
        const pt = geom && geom[0] && geom[0][0];
        if (!pt) return;
        const meta = info(feature.props);
        if (!meta) return;
        const [icon, colKey] = meta;
        const color = COL[colKey];
        const name = pick(feature.props, lang);
        const showName = name && layout.zoom >= NAME_ZOOM;
        const B = 13; // badge size
        let textW = 0;
        if (showName) { layout.scratch.font = TEXT_FONT; textW = layout.scratch.measureText(name).width; }
        const hasIcon = !!icon;
        const left = hasIcon ? -B / 2 : -3, right = (hasIcon ? B / 2 : 3) + (showName ? 3 + textW : 0);
        return [{
          anchor: pt,
          bboxes: [{ minX: pt.x + left - 1, minY: pt.y - B / 2 - 1, maxX: pt.x + right + 1, maxY: pt.y + B / 2 + 1 }],
          draw: (ctx) => {
            ctx.globalAlpha = 1;
            let tx = 0;
            if (hasIcon) {
              roundRect(ctx, -B / 2, -B / 2, B, B, 4);
              ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
              ctx.lineWidth = 1.2; ctx.strokeStyle = color; ctx.stroke();
              ctx.font = `8.5px ${EMOJI_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
              ctx.fillText(icon, 0, 0.6);
              tx = B / 2 + 3;
            } else {
              ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
              ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke();
              tx = 5;
            }
            if (showName) {
              ctx.font = TEXT_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
              ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.strokeText(name, tx, 0.5);
              ctx.fillStyle = color; ctx.fillText(name, tx, 0.5);
            }
          },
        }];
      },
    };
  }

  /* ---------- plain centred text (neighbourhoods, streams, house numbers) ---------- */
  function textSymbolizer({ font, color, halo = 'rgba(255,255,255,0.9)', upper = false, text }) {
    return {
      place(layout, geom, feature) {
        const pt = geom && geom[0] && geom[0][0];
        if (!pt) return;
        let s = text(feature.props);
        if (!s) return;
        if (upper) s = s.toUpperCase();
        layout.scratch.font = font;
        const w = layout.scratch.measureText(s).width;
        return [{
          anchor: pt,
          bboxes: [{ minX: pt.x - w / 2 - 1, minY: pt.y - 7, maxX: pt.x + w / 2 + 1, maxY: pt.y + 7 }],
          draw: (ctx) => {
            ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
            ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(s, 0, 0);
            ctx.fillStyle = color; ctx.fillText(s, 0, 0);
          },
        }];
      },
    };
  }

  /* ---------- fade every map icon and name (ours and the built-in ones) ----------
     Each label draws itself on the canvas and most of them set their own opacity back to 1,
     so the drawing context is wrapped: anything the label sets is multiplied by MAP_FADE. */
  const ctxCache = new WeakMap();
  const fadedCtx = (ctx) => {
    let p = ctxCache.get(ctx);
    if (!p) {
      p = new Proxy(ctx, {
        get: (t, k) => { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; },
        set: (t, k, v) => { t[k] = k === 'globalAlpha' ? v * MAP_FADE : v; return true; },
      });
      ctxCache.set(ctx, p);
    }
    return p;
  };

  function fadeLabelRules(rules) {
    for (const rule of rules) {
      const sym = rule.symbolizer;
      if (!sym || typeof sym.place !== 'function' || sym._faded) continue;
      const place = sym.place.bind(sym);
      sym.place = (layout, geom, feature) => {
        const out = place(layout, geom, feature);
        if (!out) return out;
        for (const label of out) {
          const draw = label.draw;
          label.draw = (ctx, extra) => {
            ctx.globalAlpha = MAP_FADE;          // for labels that never set an opacity themselves
            draw(fadedCtx(ctx), extra);
            ctx.globalAlpha = 1;
          };
        }
        return out;
      };
      sym._faded = true;
    }
  }

  /* ---------- polygon fills for land use the built-in style leaves out ---------- */
  const fill = (kinds, color, extra) => ({
    dataLayer: 'landuse',
    symbolizer: new protomapsL.PolygonSymbolizer(Object.assign({ fill: color }, extra || {})),
    filter: (z, f) => kinds.includes(f.props.kind),
  });

  /**
   * Adds everything above to a protomapsL layer. Call it right after creating the layer, before it is put on the map.
   */
  function extend(layer, { lang = 'fr' } = {}) {
    const paint = layer.paintRules, label = layer.labelRules;
    if (!Array.isArray(paint) || !Array.isArray(label)) return;

    // land use that is missing: pitches, gardens, commercial areas, farmland, wetland, railway platforms
    const at = Math.max(0, paint.findIndex((r) => r.dataLayer === 'landuse'));
    paint.splice(at, 0,
      fill(['commercial', 'retail'], '#efd9d8'),
      fill(['farmland', 'farm', 'meadow', 'orchard', 'vineyard'], '#eef0d5'),
      fill(['wetland', 'marsh'], '#cfe3dc'),
      fill(['garden', 'village_green'], '#cdebb0'),
      fill(['pitch'], '#aae0cb', { stroke: '#8bcdb3', width: 0.8 }),
      fill(['platform'], '#bbbbcc'),
      fill(['railway'], '#e6dde3'),
    );

    // buildings: clearer, with an outline (the default is very pale)
    const b = paint.find((r) => r.dataLayer === 'buildings');
    if (b) {
      b.symbolizer = new protomapsL.PolygonSymbolizer({ fill: '#d9d0c9', stroke: '#b9ada1', width: 0.6, opacity: 1 });
      b.minzoom = 14;
    }

    // labels. Rule order = priority when two labels want the same spot (earlier wins).
    const ok = (tier) => (z, f) => f.geomType === 1 && z >= (f.props.min_zoom || 0) - 0.01 && (info(f.props) || [])[2] === tier;
    const poi = poiSymbolizer(lang);
    label.push(
      { dataLayer: 'places', minzoom: 12,
        symbolizer: textSymbolizer({ font: 'italic 700 11px system-ui, sans-serif', color: '#5f5f5f', upper: true, text: (p) => pick(p, lang) }),
        filter: (z, f) => f.props.kind === 'neighbourhood' || f.props.kind === 'macrohood' },
      { dataLayer: 'pois', symbolizer: poi, filter: ok(1) },
      { dataLayer: 'pois', symbolizer: poi, filter: ok(2) },
      { dataLayer: 'pois', symbolizer: poi, filter: ok(3) },
      { dataLayer: 'water', minzoom: 14,
        symbolizer: textSymbolizer({ font: 'italic 600 10px system-ui, sans-serif', color: '#4b86ad', text: (p) => pick(p, lang) }),
        filter: (z, f) => f.geomType === 1 && !['ocean', 'sea', 'bay', 'lake', 'strait', 'fjord'].includes(f.props.kind) },
      { dataLayer: 'buildings', minzoom: 17,
        symbolizer: textSymbolizer({ font: '600 9px system-ui, sans-serif', color: '#7a6f66', text: (p) => p.addr_housenumber || '' }),
        filter: (z, f) => f.geomType === 1 && !!f.props.addr_housenumber },
    );

    // last: fade them all (street names and town names of the built-in style included)
    fadeLabelRules(label);
  }

  return { extend };
})();
