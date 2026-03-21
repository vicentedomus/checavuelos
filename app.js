// checavuelos - Frontend logic

(async function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Helpers ---

  function getPriceLevel(totalPerPerson) {
    if (totalPerPerson <= CONFIG.BUDGET_COMPRA_YA) return 'compra-ya';
    if (totalPerPerson <= CONFIG.BUDGET_BUEN_PRECIO) return 'buen-precio';
    if (totalPerPerson <= (CONFIG.BUDGET_NORMAL_MAX || 18000)) return 'normal';
    return 'caro';
  }

  function formatPrice(amount) {
    return '$' + amount.toLocaleString('es-MX');
  }

  function getLevelText(level) {
    const map = { 'compra-ya': 'COMPRA YA', 'buen-precio': 'Buen precio', 'normal': 'Normal', 'caro': 'Caro' };
    return map[level] || '';
  }

  function formatDate(isoStr) {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Merida' });
  }

  function timeAgo(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 1) return 'hace menos de 1 hora';
    if (hours === 1) return 'hace 1 hora';
    if (hours < 24) return `hace ${hours} horas`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'hace 1 dia' : `hace ${days} dias`;
  }

  // --- Render hero ---

  function renderHero(data) {
    if (!data?.best_combo) { $('#no-data').classList.remove('hidden'); return; }
    const combo = data.best_combo;
    const level = getPriceLevel(combo.total_per_person);
    $('#hero').classList.remove('hidden');
    const badge = $('#hero-badge');
    badge.textContent = getLevelText(level);
    badge.className = `hero-badge ${level}`;
    $('#hero-per-person').textContent = `${formatPrice(combo.total_per_person)} MXN`;
    $('#hero-total').textContent = `${formatPrice(combo.total_2_passengers)} MXN`;
    const ob = combo.outbound;
    $('#hero-out-route').textContent = `${ob.from} \u2192 ${ob.to}`;
    $('#hero-out-info').textContent = `${ob.airlines} \u00b7 ${ob.stops} escala(s) \u00b7 ${ob.duration_h}h \u00b7 ${formatPrice(ob.price_usd)}`;
    $('#hero-out-date').textContent = formatDate(ob.departure);
    $('#hero-out-link').href = ob.deep_link;
    const ret = combo.return;
    $('#hero-ret-route').textContent = `${ret.from} \u2192 ${ret.to}`;
    $('#hero-ret-info').textContent = `${ret.airlines} \u00b7 ${ret.stops} escala(s) \u00b7 ${ret.duration_h}h \u00b7 ${formatPrice(ret.price_usd)}`;
    $('#hero-ret-date').textContent = formatDate(ret.departure);
    $('#hero-ret-link').href = ret.deep_link;
  }

  // --- Render tables ---

  function renderTable(tableId, flights) {
    const tbody = $(`#${tableId} tbody`);
    if (!flights?.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#718096;padding:1.5rem">Sin resultados</td></tr>'; return; }
    tbody.innerHTML = flights.map(f => {
      const level = getPriceLevel(f.price_usd * 2);
      return `<tr>
        <td>${f.from}</td><td>${f.to}</td><td>${f.airlines}</td>
        <td>${formatDate(f.departure)}</td><td>${f.stops}</td><td>${f.duration_h}h</td>
        <td class="price ${level}">${formatPrice(f.price_usd)}</td>
        <td><a href="${f.deep_link}" target="_blank" class="btn btn-sm">GFlights</a>${f.kayak_link ? `<a href="${f.kayak_link}" target="_blank" class="btn btn-sm btn-kayak">Kayak</a>` : ''}</td>
      </tr>`;
    }).join('');
  }

  function renderRoundtripTable(flights) {
    const tbody = $('#table-roundtrip tbody');
    if (!flights?.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:1.5rem">Sin resultados</td></tr>'; return; }
    tbody.innerHTML = flights.map(f => {
      const level = getPriceLevel(f.price_usd);
      return `<tr>
        <td>${f.from}</td><td>${f.to}</td><td>${f.airlines}</td>
        <td>${f.stops}</td><td>${f.duration_h}h</td>
        <td class="price ${level}">${formatPrice(f.price_usd)}</td>
        <td><a href="${f.deep_link}" target="_blank" class="btn btn-sm">GFlights</a>${f.kayak_link ? `<a href="${f.kayak_link}" target="_blank" class="btn btn-sm btn-kayak">Kayak</a>` : ''}</td>
      </tr>`;
    }).join('');
  }

  // --- Render chart ---

  let priceChart = null;
  function renderChart(history) {
    if (!history?.length || history.length < 2) { $('#chart-empty').classList.remove('hidden'); return; }
    const labels = history.map(h => new Date(h.timestamp).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }));
    const ctx = $('#price-chart').getContext('2d');
    if (priceChart) priceChart.destroy();
    priceChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Total ida+vuelta', data: history.map(h => h.best_total), borderColor: '#2b6cb0', backgroundColor: 'rgba(43,108,176,0.1)', fill: true, tension: 0.3, pointRadius: 3 },
        { label: 'Ida', data: history.map(h => h.best_outbound_price), borderColor: '#38a169', borderDash: [5, 5], tension: 0.3, pointRadius: 2 },
        { label: 'Vuelta', data: history.map(h => h.best_return_price), borderColor: '#e53e3e', borderDash: [5, 5], tension: 0.3, pointRadius: 2 },
        { label: 'Round-trip', data: history.map(h => h.best_roundtrip_price || null), borderColor: '#805ad5', backgroundColor: 'rgba(128,90,213,0.1)', tension: 0.3, pointRadius: 3, spanGaps: true },
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: false, ticks: { callback: (v) => '$' + v.toLocaleString('es-MX') } } } },
      plugins: [{
        id: 'thresholdLines',
        afterDraw(chart) {
          const yScale = chart.scales.y, ctx = chart.ctx;
          for (const [val, color, label] of [[CONFIG.BUDGET_COMPRA_YA, '#e53e3e', '$11,000 COMPRA YA'], [CONFIG.BUDGET_BUEN_PRECIO, '#38a169', '$14,000 Buen precio']]) {
            const y = yScale.getPixelForValue(val);
            if (y >= yScale.top && y <= yScale.bottom) {
              ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
              ctx.beginPath(); ctx.moveTo(chart.chartArea.left, y); ctx.lineTo(chart.chartArea.right, y); ctx.stroke();
              ctx.fillStyle = color; ctx.font = '11px sans-serif'; ctx.fillText(label, chart.chartArea.left + 4, y - 4); ctx.restore();
            }
          }
        },
      }],
    });
  }

  // --- Load data ---

  async function loadData() {
    try {
      const [latestRes, historyRes] = await Promise.all([fetch(`${CONFIG.WORKER_URL}/api/latest`), fetch(`${CONFIG.WORKER_URL}/api/history`)]);
      if (latestRes.ok) {
        const latest = await latestRes.json();
        const source = latest.source === 'n8n' ? 'via n8n' : latest.source === 'serpapi' ? 'via SerpAPI' : '';
        $('#updated').textContent = `Actualizado: ${timeAgo(latest.updated_at)} ${source} (${formatDateTime(latest.updated_at)})`;
        renderHero(latest); renderTable('table-outbound', latest.outbound); renderTable('table-return', latest.returns); renderRoundtripTable(latest.roundtrips);
      } else { $('#updated').textContent = 'Sin datos disponibles'; $('#no-data').classList.remove('hidden'); }
      if (historyRes.ok) { renderChart(await historyRes.json()); }
    } catch (err) { console.error('Error cargando datos:', err); $('#updated').textContent = 'Error al conectar con el servidor'; $('#no-data').classList.remove('hidden'); }
  }

  // --- Countdown ---
  function startCountdown() {
    function getNextRun() {
      const now = new Date(), RUN_DAYS = [2, 5];
      for (let offset = 0; offset <= 7; offset++) {
        const c = new Date(now); c.setUTCDate(now.getUTCDate() + offset); c.setUTCHours(8, 0, 0, 0);
        if (c > now && RUN_DAYS.includes(c.getUTCDay())) return c;
      }
      const next = new Date(now); next.setUTCDate(now.getUTCDate() + ((2 - now.getUTCDay() + 7) % 7 || 7)); next.setUTCHours(8, 0, 0, 0); return next;
    }
    function update() {
      const diff = getNextRun() - Date.now();
      if (diff <= 0) { $('#countdown').textContent = 'Actualizando...'; return; }
      const d = Math.floor(diff / 86400000), h = Math.floor((diff % 86400000) / 3600000), m = Math.floor((diff % 3600000) / 60000);
      let p = []; if (d > 0) p.push(`${d}d`); if (h > 0) p.push(`${h}h`); p.push(`${m}m`);
      $('#countdown').textContent = `Siguiente busqueda en ${p.join(' ')}`;
    }
    update(); setInterval(update, 60000);
  }

  // --- Wedding countdown ---
  function updateWeddingCountdown() {
    const el = $('#wedding-countdown'); if (!el) return;
    const diff = new Date('2026-10-01T00:00:00') - Date.now();
    el.textContent = diff <= 0 ? '0' : Math.ceil(diff / 86400000);
  }

  // --- Boton Actualizar ---
  function setupRefreshButton() {
    const btn = $('#btn-refresh'); if (!btn) return;
    btn.addEventListener('click', async () => {
      const icon = $('#refresh-icon'), text = $('#refresh-text');
      btn.disabled = true; icon.style.animation = 'spin 1s linear infinite';
      if (text) text.textContent = 'Buscando...';
      try {
        const res = await fetch(`${CONFIG.WORKER_URL}/api/refresh?key=${CONFIG.REFRESH_SECRET}`);
        const data = await res.json();
        if (res.status === 429) { if (text) text.textContent = `En ${data.hours_left || '?'}h`; setTimeout(() => { if (text) text.textContent = 'Actualizar'; }, 5000); }
        else if (res.ok) { if (text) text.textContent = 'Listo!'; setTimeout(() => { loadData(); if (text) text.textContent = 'Actualizar'; }, 1000); }
        else { if (text) text.textContent = 'Error'; setTimeout(() => { if (text) text.textContent = 'Actualizar'; }, 3000); }
      } catch { if (text) text.textContent = 'Error'; setTimeout(() => { if (text) text.textContent = 'Actualizar'; }, 3000); }
      finally { icon.style.animation = ''; btn.disabled = false; }
    });
  }

  // --- Google Flights protobuf URL builder ---
  function encodeVarint(value) {
    const bytes = []; let v = value >>> 0;
    if (v === 0) return [0];
    while (v > 0) { if (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; } else { bytes.push(v & 0x7f); v = 0; } }
    return bytes;
  }
  function encodeVarintField(fn, val) { return [...encodeVarint((fn << 3) | 0), ...encodeVarint(val)]; }
  function encodeLenDelim(fn, data) { return [...encodeVarint((fn << 3) | 2), ...encodeVarint(data.length), ...data]; }
  function encodeStrField(fn, str) { return encodeLenDelim(fn, Array.from(new TextEncoder().encode(str))); }
  function encodeAirport(fn, code) { return encodeLenDelim(fn, [...encodeVarintField(1, 1), ...encodeStrField(2, code)]); }

  function buildTfsParam(tripType, legs) {
    let b = [...encodeVarintField(1, 28), ...encodeVarintField(2, tripType)];
    for (const leg of legs) {
      let lb = [...encodeStrField(2, leg.date)];
      for (const o of [].concat(leg.origins)) lb.push(...encodeAirport(13, o));
      for (const d of [].concat(leg.destinations)) lb.push(...encodeAirport(14, d));
      b.push(...encodeLenDelim(3, lb));
    }
    b.push(...encodeVarintField(8, 1), ...encodeVarintField(9, 1), ...encodeVarintField(14, 1));
    b.push(...encodeLenDelim(16, [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]));
    b.push(...encodeVarintField(19, 1));
    const uint8 = new Uint8Array(b); let binary = '';
    for (const byte of uint8) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function buildGFRoundTripUrl(origin, destinations, outDate, retDate) {
    const tfs = buildTfsParam(1, [
      { date: outDate, origins: origin, destinations },
      { date: retDate, origins: destinations, destinations: origin },
    ]);
    return `https://www.google.com/travel/flights/search?tfs=${tfs}&curr=MXN&hl=es&gl=mx`;
  }

  // --- Panel "Buscar vuelos" con 16 links RT ---
  function setupSearchAllButton() {
    const btn = $('#btn-gf-all'); if (!btn) return;
    const ORIGINS = ['MID', 'CUN'];
    const DESTS = ['FCO', 'FLR', 'PSA', 'MXP', 'CDG', 'ORY'];
    const OUT_DATES = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
    const RET_DATES = ['2026-10-12', '2026-10-13'];
    const DL = { '2026-09-24': 'Sep 24', '2026-09-25': 'Sep 25', '2026-09-26': 'Sep 26', '2026-09-27': 'Sep 27', '2026-10-12': 'Oct 12', '2026-10-13': 'Oct 13' };

    const panel = document.createElement('div');
    panel.id = 'gf-panel';
    panel.className = 'hidden';
    panel.style.cssText = 'position:fixed;top:64px;right:8px;z-index:100;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.18);max-height:80vh;overflow-y:auto;width:320px;padding:16px;';

    let html = '<p style="font-size:11px;color:#9c8e7d;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;margin-bottom:12px">Buscar en Google Flights</p>';
    for (const origin of ORIGINS) {
      html += `<p style="font-size:13px;font-weight:700;color:#556B2F;margin:12px 0 6px">Desde ${origin}</p>`;
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">';
      for (const outDate of OUT_DATES) {
        for (const retDate of RET_DATES) {
          const url = buildGFRoundTripUrl(origin, DESTS, outDate, retDate);
          html += `<a href="${url}" target="_blank" style="display:block;padding:6px 10px;background:#FDF5E6;border-radius:6px;text-decoration:none;font-size:12px;color:#2B2D24;text-align:center;transition:background 0.15s" onmouseover="this.style.background='#E2725B';this.style.color='#fff'" onmouseout="this.style.background='#FDF5E6';this.style.color='#2B2D24'">${DL[outDate]} \u2192 ${DL[retDate]}</a>`;
        }
      }
      html += '</div>';
    }
    html += '<p style="font-size:10px;color:#9c8e7d;margin-top:12px;text-align:center">Cada link busca 6 destinos (FCO, FLR, PSA, MXP, CDG, ORY)</p>';
    panel.innerHTML = html;
    document.body.appendChild(panel);

    btn.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) panel.classList.add('hidden');
    });
  }

  loadData();
  startCountdown();
  updateWeddingCountdown();
  setupRefreshButton();
  setupSearchAllButton();
})();
