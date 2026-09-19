# Monastir Map

A phone app (installable web app) that shows your Google Sheet / CSV points on a map of Monastir.
Works with no internet once the map and your data have been saved on the phone.

- Points are coloured by reference type: **8 digits** (orange), **6 digits** (teal), **3 digits** (violet).
- Search by reference, client, address, area… Filter by type, area and status.
- Tap a point for its details, directions and a Google Maps link.
- GPS button: shows your position, tap again to stop following.

## Set it up (about 15 minutes, once)

### 1. Get the offline map file
On a computer, install the `pmtiles` command-line tool (https://github.com/protomaps/go-pmtiles/releases), pick a recent
build date at https://maps.protomaps.com/builds/ and run:

    pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles monastir.pmtiles --bbox=10.45,35.35,11.15,35.95 --maxzoom=15

Put `monastir.pmtiles` next to `index.html`. (Use `--maxzoom=14` for a smaller file.)
Map data: © OpenStreetMap contributors, via Protomaps.

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
- The online fallback map (used only until you save the map) is the public OpenStreetMap server: fine for light use.
- To update the app, replace the files and change `VERSION` in `sw.js`.

## Files
`index.html` `style.css` `app.js` (the app) · `lib.js` (CSV/search helpers) · `sw.js` (offline app files) ·
`manifest.webmanifest` + icons · `data/sample.csv` (try it from the Data screen) · `vendor/` (Leaflet, Protomaps Leaflet, PMTiles, PapaParse — bundled so nothing loads from the internet).
