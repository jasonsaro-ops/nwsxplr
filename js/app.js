/**
 * NWSXPLR — National Weather Service Explore
 * Public APIs: api.weather.gov · Iowa Environmental Mesonet NEXRAD · NOAA
 * UI: EONETXPLR layout · MONTCO-style alert tones & severity
 */
(function () {
  'use strict';

  const NWS = {
    base: 'https://api.weather.gov',
    headers: {
      Accept: 'application/geo+json, application/json',
      // NWS asks for an identifying User-Agent (product + contact)
      'User-Agent': 'NWSXPLR/1.1 (https://github.com; nwsxplr@local)'
    }
  };

  // Iowa State Mesonet radar tiles (public, no key)
  // Animation frames: 50 min ago → live
  const RADAR_FRAMES = ['m50m', 'm45m', 'm40m', 'm35m', 'm30m', 'm25m', 'm20m', 'm15m', 'm10m', 'm05m', ''];
  const RADAR = {
    baseReflTpl: (frame) =>
      `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q${frame ? '-' + frame : ''}-900913/{z}/{x}/{y}.png`,
    velocityTpl: (frame) =>
      `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0v${frame ? '-' + frame : ''}-900913/{z}/{x}/{y}.png`,
    baseRefl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
    velocity: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0v-900913/{z}/{x}/{y}.png',
    goesIR: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes-ir-4km-900913/{z}/{x}/{y}.png',
    qpe: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-n1p-900913/{z}/{x}/{y}.png'
  };

  const SEV_ORDER = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

  // ── State ──
  const state = {
    stations: [],           // WFO list enriched
    selected: null,         // WFO code
    allAlerts: [],          // national active alerts
    stationAlerts: [],      // alerts for selected office
    filter: 'all',          // all | active
    search: '',
    alertSearch: '',
    alertSev: 'all',
    audioEnabled: false,
    autoRefreshMs: 60000,
    refreshTimer: null,
    map: null,
    layers: {
      stations: null,
      alerts: null,
      radar: null,
      radarVel: null,
      satellite: null,
      precip: null
    },
    markers: new Map(),
    knownAlertIds: new Set(),
    firstAlertLoad: true,
    radarFrame: RADAR_FRAMES.length - 1,
    radarPlaying: false,
    radarTimer: null,
    radarSpeed: 1200,
    lastObs: null
  };

  // ── DOM ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Boot ──
  function setBoot(pct, msg) {
    const bar = $('#boot-progress');
    const status = $('#boot-status');
    if (bar) bar.style.width = pct + '%';
    if (status) status.textContent = msg;
  }

  function boot() {
    // Fast path: local data only — show UI immediately (no network wait)
    setBoot(20, 'LOADING WFO DIRECTORY…');
    state.stations = (window.WFO_LIST || []).map((s) => ({
      ...s,
      key: `${s.state} ${s.name} ${s.code}`.toLowerCase(),
      alertCount: 0,
      maxSev: null
    }));
    state.stations.sort((a, b) => {
      if (a.state !== b.state) return a.state.localeCompare(b.state);
      return a.name.localeCompare(b.name);
    });

    setBoot(50, 'OPENING UI…');
    bindUI();
    startClock();
    scheduleAutoRefresh();
    renderStationList();
    $('#stat-stations').textContent = String(state.stations.length);

    setBoot(100, 'READY');
    // Reveal app first so #map has real dimensions, then init Leaflet
    const bootEl = $('#boot-screen');
    const appEl = $('#app');
    bootEl.classList.add('fade-out');
    appEl.classList.remove('hidden');
    setApiStatus('connecting', 'LOADING');

    // Next frame: map needs visible container size
    requestAnimationFrame(() => {
      initMap();
      plotStations();
      fitUSA(false);
      // Second pass after layout settles
      setTimeout(() => {
        if (state.map) {
          state.map.invalidateSize(true);
          fitUSA(false);
        }
      }, 50);
      setTimeout(() => bootEl.remove(), 500);
      // Alerts load in background — does not block UI
      refreshAlerts(true);
    });
  }

  function fitUSA(animate) {
    if (!state.map) return;
    // Contiguous US bounds (exclude most of AK/HI for a true "USA overview")
    const bounds = L.latLngBounds(
      [24.5, -125.0], // SW
      [49.5, -66.5]   // NE
    );
    state.map.fitBounds(bounds, {
      padding: [12, 12],
      animate: !!animate,
      maxZoom: 5
    });
  }

  // ── Map ──
  function initMap() {
    // Esri World Dark Gray — free, no API key, works worldwide
    // Fallback chain if a tile host fails
    state.map = L.map('map', {
      center: [39.5, -98.35],
      zoom: 4,
      minZoom: 3,
      maxZoom: 18,
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true
    });

    const basemap = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Esri · OpenStreetMap · NWS · Iowa State Mesonet',
        maxZoom: 18,
        maxNativeZoom: 16
      }
    );
    basemap.addTo(state.map);

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 18, maxNativeZoom: 16, opacity: 0.85, pane: 'overlayPane' }
    ).addTo(state.map);

    state.layers.stations = L.layerGroup().addTo(state.map);
    state.layers.alerts = L.layerGroup().addTo(state.map);

    // Radar layers (off by default) — public Iowa State Mesonet, no key
    state.layers.radar = L.tileLayer(RADAR.baseRefl, {
      opacity: 0.65,
      maxZoom: 18,
      maxNativeZoom: 12,
      attribution: 'NEXRAD · Iowa State Mesonet'
    });
    state.layers.radarVel = L.tileLayer(RADAR.velocity, {
      opacity: 0.55,
      maxZoom: 18,
      maxNativeZoom: 12
    });
    state.layers.satellite = L.tileLayer(RADAR.goesIR, {
      opacity: 0.5,
      maxZoom: 14,
      maxNativeZoom: 10
    });
    state.layers.precip = L.tileLayer(RADAR.qpe, {
      opacity: 0.6,
      maxZoom: 14,
      maxNativeZoom: 10
    });

    // Keep center correct on resize
    window.addEventListener('resize', () => {
      if (state.map) state.map.invalidateSize(true);
    });
  }

  function stationMarkerStyle(s) {
    const selected = state.selected === s.code;
    const hasAlert = s.alertCount > 0;
    return {
      radius: selected ? 8 : 5,
      color: selected ? '#f59e0b' : hasAlert ? '#f97316' : '#0c111b',
      weight: selected ? 2 : 1.5,
      fillColor: selected ? '#f59e0b' : hasAlert ? '#f97316' : '#06b6d4',
      fillOpacity: 0.95
    };
  }

  function plotStations() {
    if (!state.layers.stations) return;
    state.layers.stations.clearLayers();
    state.markers.clear();
    // Circle markers (canvas-friendly) — much faster than per-station DOM icons
    state.stations.forEach((s) => {
      const m = L.circleMarker([s.lat, s.lon], stationMarkerStyle(s));
      m.on('click', () => selectStation(s.code));
      m.bindTooltip(`${s.code} · ${s.name}, ${s.state}`, {
        direction: 'top',
        offset: [0, -6],
        opacity: 0.95
      });
      state.layers.stations.addLayer(m);
      state.markers.set(s.code, m);
    });
    $('#stat-stations').textContent = String(state.stations.length);
  }

  function updateMarkerStyles() {
    state.stations.forEach((s) => {
      const m = state.markers.get(s.code);
      if (m) m.setStyle(stationMarkerStyle(s));
    });
  }

  // ── Alerts (national) ──
  async function refreshAlerts(isBoot) {
    try {
      if (!isBoot) setApiStatus('connecting', 'REFRESHING');
      else setApiStatus('connecting', 'ALERTS…');
      // Prefer status=actual; abort if NWS is very slow so UI stays responsive
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
      const res = await fetch(`${NWS.base}/alerts/active?status=actual`, {
        headers: NWS.headers,
        signal: ctrl ? ctrl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('alerts ' + res.status);
      const data = await res.json();
      const features = data.features || [];

      state.allAlerts = features.map((f) => {
        const p = f.properties || {};
        const sev = p.severity || 'Unknown';
        return {
          id: p.id || f.id,
          event: p.event || 'Alert',
          severity: sev,
          urgency: p.urgency || '',
          certainty: p.certainty || '',
          headline: p.headline || '',
          description: p.description || '',
          instruction: p.instruction || '',
          areaDesc: p.areaDesc || '',
          senderName: p.senderName || '',
          sent: p.sent,
          effective: p.effective,
          expires: p.expires,
          onset: p.onset,
          ends: p.ends,
          office: extractOffice(p),
          geometry: f.geometry,
          raw: p
        };
      });

      // Aggregate per WFO
      const byOffice = new Map();
      state.allAlerts.forEach((a) => {
        if (!a.office) return;
        if (!byOffice.has(a.office)) byOffice.set(a.office, []);
        byOffice.get(a.office).push(a);
      });
      state.stations.forEach((s) => {
        const list = byOffice.get(s.code) || [];
        s.alertCount = list.length;
        s.maxSev = list.length
          ? list.reduce((best, a) => {
              const o = SEV_ORDER[a.severity] ?? 9;
              const bo = SEV_ORDER[best] ?? 9;
              return o < bo ? a.severity : best;
            }, 'Unknown')
          : null;
      });

      // New alert audio (MONTCO tones)
      if (!state.firstAlertLoad && state.audioEnabled) {
        const newOnes = state.allAlerts.filter((a) => a.id && !state.knownAlertIds.has(a.id));
        if (newOnes.some((a) => a.severity === 'Extreme' || a.severity === 'Severe')) {
          playSevereTone();
        } else if (newOnes.length) {
          playRefreshTone();
        }
      }
      state.knownAlertIds = new Set(state.allAlerts.map((a) => a.id).filter(Boolean));
      state.firstAlertLoad = false;

      $('#stat-alerts').textContent = String(state.allAlerts.length);
      drawAlertPolygons();
      if (state.selected) {
        filterStationAlerts();
        renderAlerts();
      }
      renderStationList();
      updateMarkerStyles();
      setApiStatus('ok', 'LIVE');
    } catch (err) {
      console.error('Alerts fetch failed', err);
      setApiStatus('error', 'ALERTS ERR');
    }
  }

  function extractOffice(props) {
    // sender often like "NWS Philadelphia PA" or id contains /XX/
    const id = props.id || '';
    const m = id.match(/\.([A-Z]{3})\./);
    if (m) return m[1];
    // try senderName
    const sn = props.senderName || '';
    for (const s of state.stations) {
      if (sn.includes(s.name) || sn.includes(s.code)) return s.code;
    }
    // parameters VTEC
    const params = props.parameters || {};
    const vtec = params.VTEC || params.vtec;
    if (Array.isArray(vtec) && vtec[0]) {
      const vm = String(vtec[0]).match(/\.([A-Z]{3})\./);
      if (vm) return vm[1];
    }
    return null;
  }

  function drawAlertPolygons() {
    state.layers.alerts.clearLayers();
    const show = $('#layer-alerts')?.checked !== false;
    if (!show) return;

    // Prefer alerts for selected office; otherwise sample high-severity
    let toDraw = state.selected
      ? state.allAlerts.filter((a) => a.office === state.selected && a.geometry)
      : state.allAlerts.filter((a) => a.geometry && (a.severity === 'Extreme' || a.severity === 'Severe')).slice(0, 80);

    toDraw.forEach((a) => {
      try {
        const color = severityColor(a.severity);
        const layer = L.geoJSON(a.geometry, {
          style: {
            color,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.18,
            opacity: 0.85
          }
        });
        layer.bindPopup(
          `<strong style="color:${color}">${esc(a.event)}</strong><br/>` +
            `<span style="font-size:11px;opacity:0.8">${esc(a.severity)} · ${esc(a.areaDesc || '').slice(0, 120)}</span>`
        );
        state.layers.alerts.addLayer(layer);
      } catch (e) { /* skip bad geom */ }
    });
  }

  function severityColor(sev) {
    const map = {
      Extreme: '#ef4444',
      Severe: '#f97316',
      Moderate: '#eab308',
      Minor: '#3b82f6',
      Unknown: '#64748b'
    };
    return map[sev] || map.Unknown;
  }

  // ── Station select ──
  async function selectStation(code) {
    const st = state.stations.find((s) => s.code === code);
    if (!st) return;
    state.selected = code;
    $('#stat-selected').textContent = code;
    updateMarkerStyles();
    renderStationList();
    $$('.fav-btn').forEach((b) => b.classList.toggle('active', b.dataset.code === code));

    // Zoom in closer on selected WFO
    state.map.setView([st.lat, st.lon], Math.max(state.map.getZoom(), 9), { animate: true });

    // Show detail shell
    $('#detail-empty').classList.add('hidden');
    $('#detail-content').classList.remove('hidden');
    $('#detail-code').textContent = st.code;
    $('#detail-name').textContent = st.name;
    $('#detail-meta').textContent = `${st.state} · ${st.lat.toFixed(2)}, ${st.lon.toFixed(2)}`;

    filterStationAlerts();
    renderAlerts();
    drawAlertPolygons();

    // Parallel fetches
    $('#tab-forecast').innerHTML = '<p class="empty-state">Loading forecast…</p>';
    $('#tab-obs').innerHTML = '<p class="empty-state">Loading observations…</p>';
    $('#tab-office').innerHTML = '<p class="empty-state">Loading office…</p>';
    $('#tab-raw').innerHTML = '';

    await Promise.all([
      loadForecast(st),
      loadObservations(st),
      loadOffice(st)
    ]);
  }

  function filterStationAlerts() {
    if (!state.selected) {
      state.stationAlerts = [];
      return;
    }
    state.stationAlerts = state.allAlerts
      .filter((a) => a.office === state.selected)
      .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  }

  async function loadForecast(st) {
    try {
      const pts = await fetchJson(`${NWS.base}/points/${st.lat.toFixed(4)},${st.lon.toFixed(4)}`);
      const props = pts.properties || {};
      const forecastUrl = props.forecast;
      const hourlyUrl = props.forecastHourly;
      if (!forecastUrl) {
        $('#tab-forecast').innerHTML = '<p class="empty-state">No forecast endpoint for this point.</p>';
        return;
      }
      const fc = await fetchJson(forecastUrl);
      const periods = (fc.properties && fc.properties.periods) || [];
      if (!periods.length) {
        $('#tab-forecast').innerHTML = '<p class="empty-state">No forecast periods returned.</p>';
        return;
      }
      let strip = '<div class="forecast-strip">';
      periods.slice(0, 8).forEach((p) => {
        strip += `<div class="fp-chip"><div class="fc-name">${esc(p.name)}</div><div class="fc-temp">${p.temperature}°</div><div class="fc-short">${esc(p.shortForecast || '')}</div></div>`;
      });
      strip += '</div>';
      let html = strip;
      periods.slice(0, 14).forEach((p) => {
        html += `<div class="forecast-period">
          <div class="fp-name">${esc(p.name)}</div>
          <div class="fp-temp">${p.temperature}°${p.temperatureUnit || 'F'}</div>
          <div class="fp-wind">${esc(p.windDirection || '')} ${esc(p.windSpeed || '')} · ${esc(p.shortForecast || '')}</div>
          <div class="fp-detail">${esc(p.detailedForecast || '')}</div>
        </div>`;
      });
      $('#tab-forecast').innerHTML = html;

      // stash raw for API tab
      state._lastRaw = state._lastRaw || {};
      state._lastRaw.points = pts;
      state._lastRaw.forecast = fc;
      if (hourlyUrl) {
        try {
          state._lastRaw.hourly = await fetchJson(hourlyUrl);
        } catch (_) { /* optional */ }
      }
      renderRawTab();
    } catch (err) {
      console.error(err);
      $('#tab-forecast').innerHTML = `<p class="empty-state">Forecast error: ${esc(err.message)}</p>`;
    }
  }

  function cToF(c) {
    return c == null ? null : c * 9 / 5 + 32;
  }
  function msToMph(ms) {
    return ms == null ? null : ms * 2.237;
  }
  function paToInHg(pa) {
    return pa == null ? null : pa / 3386.39;
  }

  function arcGaugeSvg(value, min, max, color, label, unit, displayVal) {
    const pct = value == null || isNaN(value) ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
    const start = -135;
    const sweep = 270;
    const angle = start + sweep * pct;
    const r = 42;
    const cx = 50;
    const cy = 50;
    const toRad = (d) => (d * Math.PI) / 180;
    const x1 = cx + r * Math.cos(toRad(start));
    const y1 = cy + r * Math.sin(toRad(start));
    const x2 = cx + r * Math.cos(toRad(start + sweep));
    const y2 = cy + r * Math.sin(toRad(start + sweep));
    const nx = cx + r * Math.cos(toRad(angle));
    const ny = cy + r * Math.sin(toRad(angle));
    const large = sweep * pct > 180 ? 1 : 0;
    const track = `M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2}`;
    const fill = value == null ? '' : `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${nx} ${ny}`;
    const shown = displayVal != null ? displayVal : (value == null ? '—' : Math.round(value));
    return `<div class="g-title">${esc(label)}</div>
      <svg class="gauge-svg" viewBox="0 0 100 78" aria-hidden="true">
        <path d="${track}" fill="none" stroke="rgba(148,163,184,0.2)" stroke-width="8" stroke-linecap="round"/>
        ${fill ? `<path d="${fill}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>` : ''}
        <text x="50" y="52" text-anchor="middle" fill="#f8fafc" font-size="16" font-family="IBM Plex Mono, monospace" font-weight="600">${esc(String(shown))}</text>
        <text x="50" y="66" text-anchor="middle" fill="#64748b" font-size="8" font-family="IBM Plex Mono, monospace">${esc(unit)}</text>
      </svg>`;
  }

  function compassSvg(deg, speedMph) {
    const d = deg == null || isNaN(deg) ? 0 : deg;
    const spd = speedMph == null ? '—' : speedMph.toFixed(1);
    const dir = deg == null ? '—' : Math.round(deg) + '°';
    return `<div class="g-title">Wind</div>
      <svg class="compass-rose" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(148,163,184,0.25)" stroke-width="2"/>
        <circle cx="50" cy="50" r="32" fill="none" stroke="rgba(148,163,184,0.12)" stroke-width="1"/>
        <text x="50" y="14" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="IBM Plex Mono,monospace">N</text>
        <text x="90" y="53" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="IBM Plex Mono,monospace">E</text>
        <text x="50" y="94" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="IBM Plex Mono,monospace">S</text>
        <text x="10" y="53" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="IBM Plex Mono,monospace">W</text>
        <g class="needle" style="transform:rotate(${d}deg)">
          <polygon points="50,18 54,50 50,46 46,50" fill="#f59e0b"/>
          <polygon points="50,82 54,50 50,54 46,50" fill="rgba(148,163,184,0.45)"/>
          <circle cx="50" cy="50" r="4" fill="#06b6d4"/>
        </g>
      </svg>
      <div class="g-value" style="font-size:14px">${esc(spd)} <span class="g-unit">mph</span></div>
      <div style="font-size:10px;color:var(--text-dim);font-family:var(--font-mono)">${esc(dir)}</div>`;
  }

  function renderDashboard(obs) {
    const tempF = obs.tempF;
    const rh = obs.rh;
    const windMph = obs.windMph;
    const windDeg = obs.windDeg;
    const colorTemp = tempF == null ? '#64748b' : tempF < 32 ? '#3b82f6' : tempF > 90 ? '#ef4444' : tempF > 75 ? '#f97316' : '#22c55e';
    const colorRh = '#eab308';
    const colorWind = '#06b6d4';

    const gt = $('#gauge-temp');
    const gh = $('#gauge-humid');
    const gw = $('#gauge-wind');
    const gc = $('#gauge-compass');
    if (gt) gt.innerHTML = arcGaugeSvg(tempF, -20, 110, colorTemp, 'Temperature', '°F', tempF == null ? '—' : tempF.toFixed(0));
    if (gh) gh.innerHTML = arcGaugeSvg(rh, 0, 100, colorRh, 'Humidity', '%', rh == null ? '—' : Math.round(rh));
    if (gw) gw.innerHTML = arcGaugeSvg(windMph, 0, 60, colorWind, 'Wind speed', 'mph', windMph == null ? '—' : windMph.toFixed(0));
    if (gc) gc.innerHTML = compassSvg(windDeg, windMph);

    const mini = $('#obs-mini-grid');
    if (mini) {
      const uv = obs.uvIndex;
      const uvPct = uv == null ? 0 : Math.min(100, (uv / 11) * 100);
      mini.innerHTML = `
        <div class="obs-mini"><div class="om-label">Feels like</div><div class="om-val">${obs.feelsF == null ? '—' : obs.feelsF.toFixed(1) + ' °F'}</div></div>
        <div class="obs-mini"><div class="om-label">Dewpoint</div><div class="om-val">${obs.dewF == null ? '—' : obs.dewF.toFixed(1) + ' °F'}</div></div>
        <div class="obs-mini"><div class="om-label">Pressure</div><div class="om-val">${obs.pressInHg == null ? '—' : obs.pressInHg.toFixed(2) + ' inHg'}</div></div>
        <div class="obs-mini"><div class="om-label">Visibility</div><div class="om-val">${obs.visMi == null ? '—' : obs.visMi.toFixed(1) + ' mi'}</div></div>
        <div class="obs-mini"><div class="om-label">Gust</div><div class="om-val">${obs.gustMph == null ? '—' : obs.gustMph.toFixed(1) + ' mph'}</div></div>
        <div class="obs-mini"><div class="om-label">Station</div><div class="om-val" style="font-size:11px">${esc(obs.sid || '—')}</div></div>
        <div class="uv-bar-wrap">
          <div class="om-label">UV Index ${uv == null ? '' : '· ' + uv}</div>
          <div class="uv-bar-track"><div class="uv-bar-marker" style="left:${uvPct}%"></div></div>
        </div>`;
    }
    const cond = $('#detail-cond');
    if (cond) cond.textContent = obs.text || '';
  }

  async function loadObservations(st) {
    try {
      let obsHtml = '';
      const pts = state._lastRaw && state._lastRaw.points;
      let obsStationId = null;
      if (pts && pts.properties && pts.properties.observationStations) {
        try {
          const coll = await fetchJson(pts.properties.observationStations);
          const feats = coll.features || [];
          if (feats[0]) obsStationId = feats[0].properties.stationIdentifier || feats[0].id;
        } catch (_) {}
      }

      if (obsStationId) {
        const sid = String(obsStationId).replace(/.*\//, '');
        const latest = await fetchJson(`${NWS.base}/stations/${sid}/observations/latest`);
        const p = latest.properties || {};
        const tempF = p.temperature && p.temperature.value != null ? cToF(p.temperature.value) : null;
        const dewF = p.dewpoint && p.dewpoint.value != null ? cToF(p.dewpoint.value) : null;
        const rh = p.relativeHumidity && p.relativeHumidity.value != null ? p.relativeHumidity.value : null;
        const windMph = p.windSpeed && p.windSpeed.value != null ? msToMph(p.windSpeed.value) : null;
        const gustMph = p.windGust && p.windGust.value != null ? msToMph(p.windGust.value) : null;
        const windDeg = p.windDirection && p.windDirection.value != null ? p.windDirection.value : null;
        const pressInHg = p.barometricPressure && p.barometricPressure.value != null
          ? paToInHg(p.barometricPressure.value) : null;
        const visMi = p.visibility && p.visibility.value != null ? p.visibility.value / 1609.34 : null;
        const text = p.textDescription || '';
        // Heat index / wind chill approximate "feels like"
        let feelsF = tempF;
        if (tempF != null && rh != null && tempF >= 80) {
          // simplified heat index
          feelsF = -42.379 + 2.04901523 * tempF + 10.14333127 * rh - 0.22475541 * tempF * rh
            - 0.00683783 * tempF * tempF - 0.05481717 * rh * rh + 0.00122874 * tempF * tempF * rh
            + 0.00085282 * tempF * rh * rh - 0.00000199 * tempF * tempF * rh * rh;
        } else if (tempF != null && windMph != null && tempF <= 50 && windMph > 3) {
          feelsF = 35.74 + 0.6215 * tempF - 35.75 * Math.pow(windMph, 0.16) + 0.4275 * tempF * Math.pow(windMph, 0.16);
        }

        const obs = {
          tempF, dewF, rh, windMph, gustMph, windDeg, pressInHg, visMi,
          feelsF, text, sid, uvIndex: null, timestamp: p.timestamp
        };
        state.lastObs = obs;
        renderDashboard(obs);

        obsHtml = `<div class="obs-grid">
          <div class="obs-card"><div class="label">Temperature</div><div class="value">${tempF == null ? '—' : tempF.toFixed(1) + ' °F'}</div></div>
          <div class="obs-card"><div class="label">Feels like</div><div class="value">${feelsF == null ? '—' : feelsF.toFixed(1) + ' °F'}</div></div>
          <div class="obs-card"><div class="label">Dewpoint</div><div class="value">${dewF == null ? '—' : dewF.toFixed(1) + ' °F'}</div></div>
          <div class="obs-card"><div class="label">Humidity</div><div class="value">${rh == null ? '—' : Math.round(rh) + '%'}</div></div>
          <div class="obs-card"><div class="label">Wind</div><div class="value">${windMph == null ? '—' : windMph.toFixed(1) + ' mph'}</div></div>
          <div class="obs-card"><div class="label">Direction</div><div class="value">${windDeg == null ? '—' : Math.round(windDeg) + '°'}</div></div>
          <div class="obs-card"><div class="label">Gust</div><div class="value">${gustMph == null ? '—' : gustMph.toFixed(1) + ' mph'}</div></div>
          <div class="obs-card"><div class="label">Pressure</div><div class="value">${pressInHg == null ? '—' : pressInHg.toFixed(2) + ' inHg'}</div></div>
          <div class="obs-card"><div class="label">Visibility</div><div class="value">${visMi == null ? '—' : visMi.toFixed(1) + ' mi'}</div></div>
          <div class="obs-card"><div class="label">Conditions</div><div class="value" style="font-size:13px">${esc(text || '—')}</div></div>
        </div>
        <p style="margin-top:10px;font-size:11px;color:var(--text-dim);font-family:var(--font-mono)">Station ${esc(sid)} · ${esc(p.timestamp || '')}</p>`;
        state._lastRaw = state._lastRaw || {};
        state._lastRaw.observation = latest;
        renderRawTab();
      } else {
        renderDashboard({ tempF: null, rh: null, windMph: null, windDeg: null, dewF: null, feelsF: null, pressInHg: null, visMi: null, gustMph: null, text: '', sid: null });
        obsHtml = '<p class="empty-state">No nearby observation station resolved. Forecast still available.</p>';
      }
      $('#tab-obs').innerHTML = obsHtml;
    } catch (err) {
      $('#tab-obs').innerHTML = `<p class="empty-state">Observation error: ${esc(err.message)}</p>`;
    }
  }

  async function loadOffice(st) {
    try {
      const office = await fetchJson(`${NWS.base}/offices/${st.code}`);
      const p = office.properties || {};
      const addr = p.address || {};
      const phone = (p.telephone || p.phone || '').toString();
      const html = `<div class="office-block">
        <p><strong style="color:var(--text-hi)">${esc(p.name || st.name)}</strong></p>
        <p>${esc(addr.streetAddress || '')}<br/>
        ${esc(addr.addressLocality || '')}${addr.addressLocality && addr.addressRegion ? ', ' : ''}${esc(addr.addressRegion || '')} ${esc(addr.postalCode || '')}</p>
        ${phone ? `<p>☎ ${esc(phone)}</p>` : ''}
        ${p.email ? `<p>✉ ${esc(p.email)}</p>` : ''}
        ${p.sameAs ? `<p><a href="${esc(p.sameAs)}" target="_blank" rel="noopener">Office website ↗</a></p>` : ''}
        <p style="margin-top:10px;font-size:11px;color:var(--text-dim)">Responsible counties / zones are available via NWS zone endpoints. Alerts for this office appear in column 4.</p>
      </div>`;
      $('#tab-office').innerHTML = html;
      state._lastRaw = state._lastRaw || {};
      state._lastRaw.office = office;
      renderRawTab();
    } catch (err) {
      $('#tab-office').innerHTML = `<div class="office-block">
        <p><strong>${esc(st.name)} (${esc(st.code)})</strong></p>
        <p>Office metadata unavailable (${esc(err.message)}).</p>
        <p><a href="https://www.weather.gov/${st.code.toLowerCase()}/" target="_blank" rel="noopener">weather.gov/${st.code.toLowerCase()} ↗</a></p>
      </div>`;
    }
  }

  function renderRawTab() {
    const raw = state._lastRaw || {};
    $('#tab-raw').innerHTML = `<pre class="raw-pre">${esc(JSON.stringify(raw, null, 2))}</pre>`;
  }

  // ── Render station list ──
  function renderStationList() {
    const q = state.search.trim().toLowerCase();
    let list = state.stations;
    if (state.filter === 'active') list = list.filter((s) => s.alertCount > 0);
    if (q) {
      list = list.filter((s) =>
        s.key.includes(q) ||
        s.code.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q) ||
        (s.name && s.name.toLowerCase().includes(q))
      );
    }

    const wrap = $('#station-list');
    if (!list.length) {
      wrap.innerHTML = '<p class="empty-state">No stations match.</p>';
      return;
    }

    let html = '';
    let lastState = '';
    list.forEach((s) => {
      if (s.state !== lastState) {
        lastState = s.state;
        html += `<div class="station-group-head">${esc(s.state)}</div>`;
      }
      const active = state.selected === s.code ? ' active' : '';
      const dotClass = s.maxSev === 'Extreme' ? 'extreme has' : s.alertCount > 0 ? 'has' : '';
      html += `<div class="station-item${active}" data-code="${esc(s.code)}">
        <span class="station-code">${esc(s.code)}</span>
        <div class="station-info">
          <div class="station-name">${esc(s.name)}</div>
          <div class="station-state">${esc(s.state)}${s.alertCount ? ' · ' + s.alertCount + ' alert' + (s.alertCount > 1 ? 's' : '') : ''}</div>
        </div>
        <span class="station-alert-dot ${dotClass}"></span>
      </div>`;
    });
    wrap.innerHTML = html;
  }

  // ── Render alerts ──
  function renderAlerts() {
    const q = state.alertSearch.trim().toLowerCase();
    let list = state.stationAlerts.slice();
    if (state.alertSev !== 'all') {
      list = list.filter((a) => a.severity === state.alertSev);
    }
    if (q) {
      list = list.filter((a) =>
        (a.event || '').toLowerCase().includes(q) ||
        (a.areaDesc || '').toLowerCase().includes(q) ||
        (a.headline || '').toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q)
      );
    }

    $('#alerts-count').textContent = String(list.length);
    const empty = $('#alerts-empty');
    const wrap = $('#alerts-list');

    if (!state.selected) {
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>Select a WFO station to see its active alerts.</p>';
      wrap.innerHTML = '';
      return;
    }
    if (!list.length) {
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>No active alerts for this office' + (q || state.alertSev !== 'all' ? ' (with current filters)' : '') + '.</p>';
      wrap.innerHTML = '';
      return;
    }
    empty.classList.add('hidden');

    wrap.innerHTML = list.map((a, i) => {
      const sev = a.severity || 'Unknown';
      const exp = a.expires ? new Date(a.expires).toLocaleString() : '—';
      const sent = a.sent ? new Date(a.sent).toLocaleString() : '—';
      return `<div class="alert-card sev-${esc(sev)}" data-idx="${i}">
        <div class="alert-card-head">
          <span class="alert-sev-badge">${esc(sev)}</span>
          <div>
            <div class="alert-event">${esc(a.event)}</div>
            <div class="alert-area">${esc(a.areaDesc || '').slice(0, 140)}</div>
          </div>
        </div>
        <div class="alert-card-body">
          ${a.headline ? `<p><strong>${esc(a.headline)}</strong></p>` : ''}
          <p>${esc((a.description || '').slice(0, 800))}${(a.description || '').length > 800 ? '…' : ''}</p>
          ${a.instruction ? `<p style="margin-top:8px;color:var(--amber)"><strong>Instruction:</strong> ${esc(a.instruction.slice(0, 400))}</p>` : ''}
          <div class="alert-meta">
            <span>Sent ${esc(sent)}</span>
            <span>Expires ${esc(exp)}</span>
            <span>${esc(a.urgency || '')} / ${esc(a.certainty || '')}</span>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Audio (MONTCO-style Web Audio tones) ──
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function scheduleTone(freq, startTime, duration, waveType, peakGain) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveType || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  function playSevereTone() {
    const ctx = ensureAudio();
    if (!ctx || !state.audioEnabled) return;
    const now = ctx.currentTime;
    // urgent alternating two-tone (fire-style)
    [880, 660, 880, 660, 880].forEach((freq, i) => {
      scheduleTone(freq, now + i * 0.14, 0.12, 'sawtooth', 0.18);
    });
  }

  function playRefreshTone() {
    const ctx = ensureAudio();
    if (!ctx || !state.audioEnabled) return;
    const now = ctx.currentTime;
    scheduleTone(660, now, 0.08, 'sine', 0.1);
    scheduleTone(990, now + 0.09, 0.12, 'sine', 0.08);
  }

  // ── UI binding ──
  function bindUI() {
    // Favorites
    const favGrid = $('#fav-grid');
    if (favGrid) {
      favGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.fav-btn');
        if (!btn || !btn.dataset.code) return;
        selectStation(btn.dataset.code);
      });
    }

    // Station search (+ zip → nearest WFO)
    let searchTimer = null;
    $('#station-search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderStationList();
      clearTimeout(searchTimer);
      const q = state.search.trim();
      if (/^\d{5}$/.test(q)) {
        searchTimer = setTimeout(() => resolveZipToNearestWfo(q), 280);
      }
    });
    $('#station-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = state.search.trim();
        if (/^\d{5}$/.test(q)) resolveZipToNearestWfo(q);
      }
    });

    // Station list click
    $('#station-list').addEventListener('click', (e) => {
      const item = e.target.closest('.station-item');
      if (item) selectStation(item.dataset.code);
    });

    // Filter seg
    $('#state-filter-seg').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      $$('#state-filter-seg button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderStationList();
    });

    // Alert search + severity
    $('#alert-search').addEventListener('input', (e) => {
      state.alertSearch = e.target.value;
      renderAlerts();
    });
    $('#severity-seg').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      $$('#severity-seg button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.alertSev = btn.dataset.sev;
      renderAlerts();
    });

    // Expand alert cards
    $('#alerts-list').addEventListener('click', (e) => {
      const card = e.target.closest('.alert-card');
      if (card) card.classList.toggle('expanded');
    });

    // Detail tabs
    $$('.detail-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.detail-tabs .tab').forEach((t) => t.classList.remove('active'));
        $$('.tab-pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const pane = $(`#tab-${tab.dataset.tab}`);
        if (pane) pane.classList.add('active');
      });
    });

    // Layers
    $('#layer-stations').addEventListener('change', (e) => {
      if (e.target.checked) state.map.addLayer(state.layers.stations);
      else state.map.removeLayer(state.layers.stations);
    });
    $('#layer-alerts').addEventListener('change', () => drawAlertPolygons());
    $('#layer-radar').addEventListener('change', (e) => {
      if (e.target.checked) {
        state.map.addLayer(state.layers.radar);
        $('#stat-radar').textContent = 'ON';
      } else {
        state.map.removeLayer(state.layers.radar);
        if (!$('#layer-radar-vel').checked) $('#stat-radar').textContent = 'OFF';
      }
    });
    $('#layer-radar-vel').addEventListener('change', (e) => {
      if (e.target.checked) {
        state.map.addLayer(state.layers.radarVel);
        $('#stat-radar').textContent = 'VEL';
      } else {
        state.map.removeLayer(state.layers.radarVel);
        if (!$('#layer-radar').checked) $('#stat-radar').textContent = 'OFF';
        else $('#stat-radar').textContent = 'ON';
      }
    });
    $('#layer-satellite').addEventListener('change', (e) => {
      if (e.target.checked) state.map.addLayer(state.layers.satellite);
      else state.map.removeLayer(state.layers.satellite);
    });
    $('#layer-precip').addEventListener('change', (e) => {
      if (e.target.checked) state.map.addLayer(state.layers.precip);
      else state.map.removeLayer(state.layers.precip);
    });
    $('#radar-opacity').addEventListener('input', (e) => {
      const o = Number(e.target.value) / 100;
      state.layers.radar.setOpacity(o);
      state.layers.radarVel.setOpacity(o * 0.85);
      state.layers.satellite.setOpacity(o * 0.75);
      state.layers.precip.setOpacity(o);
    });

    // Map chips
    $('#btn-fit-usa').addEventListener('click', () => fitUSA(true));
    $('#btn-fit-selected').addEventListener('click', () => {
      if (!state.selected) return;
      const st = state.stations.find((s) => s.code === state.selected);
      if (st) state.map.setView([st.lat, st.lon], 8, { animate: true });
    });

    // Top actions
    $('#brand-refresh').addEventListener('click', () => softRefresh());
    $('#btn-refresh').addEventListener('click', () => softRefresh());
    $('#btn-fullscreen').addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
    $('#btn-audio').addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      const btn = $('#btn-audio');
      btn.classList.toggle('active', state.audioEnabled);
      btn.setAttribute('aria-pressed', state.audioEnabled ? 'true' : 'false');
      const on = btn.querySelector('.ico-tones-on');
      const off = btn.querySelector('.ico-tones-off');
      if (on && off) {
        on.classList.toggle('hidden', !state.audioEnabled);
        off.classList.toggle('hidden', state.audioEnabled);
      }
      if (state.audioEnabled) {
        ensureAudio();
        playRefreshTone();
      }
    });

    // Radar animation controls
    const playBtn = $('#btn-radar-play');
    const frameSlider = $('#radar-frame');
    const speedSel = $('#radar-speed');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (state.radarPlaying) stopRadarAnim();
        else startRadarAnim();
      });
    }
    if (frameSlider) {
      frameSlider.max = String(RADAR_FRAMES.length - 1);
      frameSlider.value = String(RADAR_FRAMES.length - 1);
      frameSlider.addEventListener('input', (e) => {
        stopRadarAnim();
        setRadarFrame(Number(e.target.value));
      });
    }
    if (speedSel) {
      speedSel.addEventListener('change', (e) => {
        state.radarSpeed = Number(e.target.value) || 1200;
        if (state.radarPlaying) {
          stopRadarAnim();
          startRadarAnim();
        }
      });
    }
    $('#autorefresh-select').addEventListener('change', (e) => {
      state.autoRefreshMs = Number(e.target.value) * 1000;
      scheduleAutoRefresh();
    });
  }

  // ── Radar animation ──
  function setRadarFrame(idx) {
    const i = Math.max(0, Math.min(RADAR_FRAMES.length - 1, idx));
    state.radarFrame = i;
    const frame = RADAR_FRAMES[i];
    const label = $('#radar-frame-label');
    if (label) label.textContent = frame ? frame.replace('m', '') + ' ago' : 'Live';
    const slider = $('#radar-frame');
    if (slider) slider.value = String(i);

    if (state.layers.radar) {
      state.layers.radar.setUrl(RADAR.baseReflTpl(frame));
    }
    if (state.layers.radarVel) {
      state.layers.radarVel.setUrl(RADAR.velocityTpl(frame));
    }
  }

  function startRadarAnim() {
    // Ensure a radar layer is on
    if (!$('#layer-radar')?.checked && !$('#layer-radar-vel')?.checked) {
      const lr = $('#layer-radar');
      if (lr) {
        lr.checked = true;
        lr.dispatchEvent(new Event('change'));
      }
    }
    state.radarPlaying = true;
    const btn = $('#btn-radar-play');
    if (btn) {
      btn.textContent = '⏸';
      btn.classList.add('playing');
    }
    if (state.radarTimer) clearInterval(state.radarTimer);
    state.radarTimer = setInterval(() => {
      let next = state.radarFrame + 1;
      if (next >= RADAR_FRAMES.length) next = 0;
      setRadarFrame(next);
    }, state.radarSpeed);
  }

  function stopRadarAnim() {
    state.radarPlaying = false;
    if (state.radarTimer) {
      clearInterval(state.radarTimer);
      state.radarTimer = null;
    }
    const btn = $('#btn-radar-play');
    if (btn) {
      btn.textContent = '▶';
      btn.classList.remove('playing');
    }
  }

  // ── Zip → nearest WFO ──
  function haversineMi(lat1, lon1, lat2, lon2) {
    const R = 3958.8;
    const toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(lat2 - lat1);
    const dLon = toR(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async function resolveZipToNearestWfo(zip) {
    try {
      setApiStatus('connecting', 'ZIP…');
      const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
      if (!res.ok) throw new Error('zip not found');
      const data = await res.json();
      const place = (data.places && data.places[0]) || null;
      if (!place) throw new Error('no place');
      const lat = parseFloat(place.latitude);
      const lon = parseFloat(place.longitude);
      let best = null;
      let bestD = Infinity;
      state.stations.forEach((s) => {
        const d = haversineMi(lat, lon, s.lat, s.lon);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      });
      if (best) {
        state.search = '';
        const input = $('#station-search');
        if (input) input.value = `${zip} → ${best.code}`;
        renderStationList();
        selectStation(best.code);
        setApiStatus('ok', 'LIVE');
      }
    } catch (err) {
      console.warn('Zip lookup failed', err);
      setApiStatus('error', 'ZIP ERR');
      setTimeout(() => setApiStatus('ok', 'LIVE'), 2000);
    }
  }

  function softRefresh() {
    playRefreshTone();
    refreshAlerts(false);
    if (state.selected) {
      const st = state.stations.find((s) => s.code === state.selected);
      if (st) {
        loadForecast(st);
        loadObservations(st);
        loadOffice(st);
      }
    }
    // Refresh radar at current frame
    setRadarFrame(state.radarFrame);
    [state.layers.satellite, state.layers.precip].forEach((ly) => {
      if (ly && state.map.hasLayer(ly)) ly.redraw();
    });
  }

  function scheduleAutoRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (state.autoRefreshMs > 0) {
      state.refreshTimer = setInterval(() => softRefresh(), state.autoRefreshMs);
    }
  }

  function startClock() {
    const tick = () => {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, '0');
      const m = String(now.getUTCMinutes()).padStart(2, '0');
      const s = String(now.getUTCSeconds()).padStart(2, '0');
      $('#clock-zulu').innerHTML = `${h}:${m}:${s}<span>Z</span>`;
    };
    tick();
    setInterval(tick, 1000);
  }

  function setApiStatus(stateName, text) {
    const el = $('#api-status');
    if (!el) return;
    el.dataset.state = stateName;
    $('#api-status-text').textContent = text;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: NWS.headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
