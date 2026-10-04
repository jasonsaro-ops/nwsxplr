# NWSXPLR — National Weather Service Explore

Live explorer for **NWS Weather Forecast Offices (WFOs)**, forecasts, observations, active alerts, and NEXRAD radar layers.

## Features

- **All NWS WFOs** mapped on a dark USA basemap (clickable markers)
- **Column 1** — alphabetical station list by state, searchable (state, city, code)
- **Column 2** — full-width map, zoomable, fit-USA / fit-selected
- **Column 3** — forecast, observations, office metadata, raw API JSON
- **Column 4** — active alerts for the selected office, colored by severity (Extreme → red)
- **NEXRAD / layers** — base reflectivity, velocity, GOES IR, QPE (Iowa State Mesonet tiles)
- **Alert tones** — MONTCO-style Web Audio chimes for new severe/extreme alerts
- **Auto-refresh** — 1 / 2 / 5 min (default 1 min)
- **Soft refresh** — click the **NWSXPLR** logo (top-left) or the ⟳ button
- Boot screen and mission UI styled after **EONETXPLR**

## Data sources (public, no API key)

| Source | Endpoint / tiles |
|--------|------------------|
| NWS API | `https://api.weather.gov` (alerts, points, forecast, offices, stations, observations) |
| NEXRAD / GOES / QPE | Iowa Environmental Mesonet tile cache |
| Basemap | CARTO Dark Matter |

User-Agent is set per NWS API guidelines.

## Deploy on GitHub Pages

1. Create a new repository (e.g. `nwsxplr`).
2. Upload the contents of this folder to the repo root (or `/docs`).
3. **Settings → Pages → Source**: Deploy from branch `main` / root (or `/docs`).
4. Site will be at `https://<user>.github.io/nwsxplr/`.

Or push with git:

```bash
cd nwsxplr
git init
git add .
git commit -m "NWSXPLR initial"
git branch -M main
git remote add origin https://github.com/<you>/nwsxplr.git
git push -u origin main
```

Then enable Pages as above.

## Local

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` (or the port shown).

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ NWSXPLR  STATIONS  ALERTS  SELECTED  RADAR   clock  refresh │
├──────────┬────────────────────────┬────────────┬────────────┤
│ Stations │                        │ Forecast   │ Alerts     │
│ search   │         MAP            │ Obs        │ severity   │
│ list     │      + NEXRAD          │ Office     │ cards      │
│ layers   │                        │ API raw    │            │
└──────────┴────────────────────────┴────────────┴────────────┘
```

## License

Public NWS / NOAA data. Site code provided as-is for educational use.
