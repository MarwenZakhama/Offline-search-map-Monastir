# Moknine Map

A phone app (installable web app) that shows your Google Sheet / CSV points on an offline map.
Works with no internet once the map and your data have been saved on the phone.

- Each reference type has its own small marker: **8 digits** orange circle, **6 digits** yellow upside-down triangle, **3 digits** blue diamond. The buttons under the search bar show only that icon and the number of points.
- References are shown as `65 123 456` (8 digits) and `123 456` (6 digits). On the map, small labels appear from zoom 16 and leave out the first 2 digits of an 8-digit reference (`123 456`); 6-digit labels are red.
- **Search never hides anything.** Matching points turn green (and get their label); every other point stays on the map, faded.
- **Reference search: pick 8, 6 or 3 in the search bar** (orange / yellow / blue, like the markers). Only references of that length are searched, from the first digit in order: with **8** selected, `65` → references starting with 65, then `65 312` → starting with 65312, and so on. Your choice is remembered.
- **The map never moves while you type.** It only jumps to a point (and opens it) once all the digits of the chosen length are typed and they belong to one single spot. Clearing the search with ✕ keeps you exactly where you are.
- Text search (client, address, area…) works too, with the same green highlight.
- Points on exactly the same coordinates share one marker with a small count badge. Tap it to see every point there.
- Layers button: switch between the offline map and satellite imagery (satellite needs internet). The map shows no credits text.
- Tap a point for its details, directions and a Google Maps link. GPS button: shows your position with a beam and arrow for the direction you are facing (phone compass; while walking it falls back to GPS heading). On iPhone the app asks for compass permission the first time. Tap again to stop following.

## Set it up (about 15 minutes, once)

### 1. Get the offline map file
On a computer, install the `pmtiles` command-line tool (https://github.com/protomaps/go-pmtiles/releases), pick a recent
build date at https://maps.protomaps.com/builds/ and run:

    pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles monastir.pmtiles --bbox=10.45,35.35,11.15,35.95 --maxzoom=15

Put `monastir.pmtiles` next to `index.html`. (Use `--maxzoom=14` for a smaller file.)
Map data: © OpenStreetMap contributors, via Protomaps (credits are not drawn on the map, but the data licence still applies).

### 2. Put the folder online
GPS only works on https. Upload this whole folder to any static host: GitHub Pages, Netlify (drag & drop) or Cloudflare Pages.
To try it on your computer first: `python3 -m http.server 8080` and open http://localhost:8080

### 3. Install it on the phone
Open the link on the phone, then **Add to Home Screen** (Share menu on iPhone, ⋮ menu on Android).
Open the app while online, tap the database icon (top left) and:
1. **Save map for offline use**
2. Paste your Google Sheet link (or choose a CSV file), then **Load link**

Do this once per phone. After that everything opens offline. When the phone is online again, linked sheets refresh by themselves.

## Your sheet
Needs the columns **Reference**, **Latitude**, **Longitude**. These are also used when present:
Client Name, CTR Number, Area, Address, Transformater, Status, Notes. Any other column is shown in the point's details.
- Put all three types in one sheet, or use one sheet per type and add each link. The type comes from the number of digits.
- The “Google Maps” column is ignored (a CSV export keeps only the text “Open Map”, not the link); the app makes its own links.
- If a reference can start with 0, format that column as *Plain text* so Sheets doesn't drop the zero.
- Sharing: **File ▸ Share ▸ Publish to web ▸ pick the sheet ▸ CSV** and paste that link, or share as “Anyone with the link”.
  If a link won't load, upload a CSV file instead.

## Good to know
- iPhone/Safari can delete saved data from sites you haven't opened for a week. Installing to the Home Screen avoids this.
- Satellite imagery comes from Esri's public World Imagery service and is not saved for offline use. Use it for light, occasional viewing.
- The online fallback map (used only until you save the map) is the public OpenStreetMap server: fine for light use.
- To update the app, replace the files and change `VERSION` in `sw.js`. Phones pick up the new version the second time they open the app.

## Files
`index.html` `style.css` `app.js` (the app) · `lib.js` (CSV/search helpers) · `sw.js` (offline app files) ·
`manifest.webmanifest` + icons · `data/sample.csv` (try it from the Data screen) · `vendor/` (Leaflet, Protomaps Leaflet, PMTiles, PapaParse — bundled so nothing loads from the internet).
