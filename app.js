// checavuelos - Frontend logic

(async function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Helpers ---

  function getPriceLevel(totalPerPerson) {
    if (totalPerPerson <= CONFIG.BUDGET_COMPRA_YA) return 'compra-ya';
    if (totalPerPerson <= CONFIG.BUDGET_BUEN_PRECIO) return 'buen-precio';
    if (totalPerPerson <= 1100) return 'normal';
    return 'caro';
  }

  function getLevelText(level) {
    const map = {
      'compra-ya': 'COMPRA YA',
      'buen-precio': 'Buen precio',
      'normal': 'Normal',
      'caro': 'Caro',
    };
    return map[level] || '';
  }

  function formatDate(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleDateString('es-MX', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleString('es-MX', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Merida',
    });
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
    if (!data?.best_combo) {
      $('#no-data').classList.remove('hidden');
      return;
    }

    const combo = data.best_combo;
    const level = getPriceLevel(combo.total_per_person);

    $('#hero').classList.remove('hidden');
    const badge = $('#hero-badge');
    badge.textContent = getLevelText(level);
    badge.className = `hero-badge ${level}`;

    $('#hero-per-person').textContent = `$${combo.total_per_person} USD`;
    $('#hero-total').textContent = `$${combo.total_2_passengers} USD`;

    // Ida
    const ob = combo.outbound;
    $('#hero-out-route').textContent = `${ob.from} \u2192 ${ob.to}`;
    $('#hero-out-info').textContent = `${ob.airlines} \u00b7 ${ob.stops} escala(s) \u00b7 ${ob.duration_h}h \u00b7 $${ob.price_usd}`;
    $('#hero-out-date').textContent = formatDate(ob.departure);
    $('#hero-out-link').href = ob.deep_link;

    // Vuelta
    const ret = combo.return;
    $('#hero-ret-route').textContent = `${ret.from} \u2192 ${ret.to}`;
    $('#hero-ret-info').textContent = `${ret.airlines} \u00b7 ${ret.stops} escala(s) \u00b7 ${ret.duration_h}h \u00b7 $${ret.price_usd}`;
    $('#hero-ret-date').textContent = formatDate(ret.departure);
    $('#hero-ret-link').href = ret.deep_link;
  }

  // --- Render tables ---

  function renderTable(tableId, flights) {
    const tbody = $(`#${tableId} tbody`);
    if (!flights?.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#718096;padding:1.5rem">Sin resultados</td></tr>';
      return;
    }

    tbody.innerHTML = flights.map(f => {
      const level = getPriceLevel(f.price_usd * 2);
      return `<tr>
        <td>${f.from}</td>
        <td>${f.to}</td>
        <td>${f.airlines}</td>
        <td>${formatDate(f.departure)}</td>
        <td>${f.stops}</td>
        <td>${f.duration_h}h</td>
        <td class="price ${level}">\$${f.price_usd}</td>
        <td><a href="${f.deep_link}" target="_blank" class="btn btn-sm">Ver</a></td>
      </tr>`;
    }).join('');
  }

  // --- Render round-trip table ---

  function renderRoundtripTable(flights) {
    const tbody = $('#table-roundtrip tbody');
    if (!flights?.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:1.5rem">Sin resultados</td></tr>';
      return;
    }

    tbody.innerHTML = flights.map(f => {
      const level = getPriceLevel(f.price_usd);
      return `<tr>
        <td>${f.from}</td>
        <td>${f.to}</td>
        <td>${f.airlines}</td>
        <td>${f.stops}</td>
        <td>${f.duration_h}h</td>
        <td class="price ${level}">\$${f.price_usd}</td>
        <td><a href="${f.deep_link}" target="_blank" class="btn btn-sm">Ver</a></td>
      </tr>`;
    }).join('');
  }

  // --- Render chart ---

  let priceChart = null;

  function renderChart(history) {
    if (!history?.length || history.length < 2) {
      $('#chart-empty').classList.remove('hidden');
      return;
    }

    const labels = history.map(h => {
      const d = new Date(h.timestamp);
      return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    });
    const totals = history.map(h => h.best_total);
    const outbound = history.map(h => h.best_outbound_price);
    const returns = history.map(h => h.best_return_price);
    const roundtrips = history.map(h => h.best_roundtrip_price || null);

    const ctx = $('#price-chart').getContext('2d');

    if (priceChart) priceChart.destroy();

    priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Total ida+vuelta',
            data: totals,
            borderColor: '#2b6cb0',
            backgroundColor: 'rgba(43,108,176,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
          {
            label: 'Ida',
            data: outbound,
            borderColor: '#38a169',
            borderDash: [5, 5],
            tension: 0.3,
            pointRadius: 2,
          },
          {
            label: 'Vuelta',
            data: returns,
            borderColor: '#e53e3e',
            borderDash: [5, 5],
            tension: 0.3,
            pointRadius: 2,
          },
          {
            label: 'Round-trip',
            data: roundtrips,
            borderColor: '#805ad5',
            backgroundColor: 'rgba(128,90,213,0.1)',
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          annotation: undefined,
          legend: {
            position: 'bottom',
          },
        },
        scales: {
          y: {
            beginAtZero: false,
            ticks: {
              callback: (v) => '$' + v,
            },
          },
        },
      },
      plugins: [{
        id: 'thresholdLines',
        afterDraw(chart) {
          const yScale = chart.scales.y;
          const ctx = chart.ctx;

          const y750 = yScale.getPixelForValue(CONFIG.BUDGET_COMPRA_YA);
          if (y750 >= yScale.top && y750 <= yScale.bottom) {
            ctx.save();
            ctx.strokeStyle = '#e53e3e';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(chart.chartArea.left, y750);
            ctx.lineTo(chart.chartArea.right, y750);
            ctx.stroke();
            ctx.fillStyle = '#e53e3e';
            ctx.font = '11px sans-serif';
            ctx.fillText('$750 COMPRA YA', chart.chartArea.left + 4, y750 - 4);
            ctx.restore();
          }

          const y900 = yScale.getPixelForValue(CONFIG.BUDGET_BUEN_PRECIO);
          if (y900 >= yScale.top && y900 <= yScale.bottom) {
            ctx.save();
            ctx.strokeStyle = '#38a169';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(chart.chartArea.left, y900);
            ctx.lineTo(chart.chartArea.right, y900);
            ctx.stroke();
            ctx.fillStyle = '#38a169';
            ctx.font = '11px sans-serif';
            ctx.fillText('$900 Buen precio', chart.chartArea.left + 4, y900 - 4);
            ctx.restore();
          }
        },
      }],
    });
  }

  // --- Load data ---

  async function loadData() {
    try {
      const [latestRes, historyRes] = await Promise.all([
        fetch(`${CONFIG.WORKER_URL}/api/latest`),
        fetch(`${CONFIG.WORKER_URL}/api/history`),
      ]);

      if (latestRes.ok) {
        const latest = await latestRes.json();
        const source = latest.source === 'n8n' ? 'via n8n' : latest.source === 'serpapi' ? 'via SerpAPI' : '';
        $('#updated').textContent = `Actualizado: ${timeAgo(latest.updated_at)} ${source} (${formatDateTime(latest.updated_at)})`;
        renderHero(latest);
        renderTable('table-outbound', latest.outbound);
        renderTable('table-return', latest.returns);
        renderRoundtripTable(latest.roundtrips);
      } else {
        $('#updated').textContent = 'Sin datos disponibles';
        $('#no-data').classList.remove('hidden');
      }

      if (historyRes.ok) {
        const history = await historyRes.json();
        renderChart(history);
      }
    } catch (err) {
      console.error('Error cargando datos:', err);
      $('#updated').textContent = 'Error al conectar con el servidor';
      $('#no-data').classList.remove('hidden');
    }
  }

  // --- Countdown a siguiente actualizacion ---
  function startCountdown() {
    function getNextRun() {
      const now = new Date();
      // Schedule: daily at 2 AM Merida (8 AM UTC)
      const next = new Date(now);
      next.setUTCHours(8, 0, 0, 0);
      if (next <= now) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      return next;
    }

    function updateCountdown() {
      const next = getNextRun();
      const diff = next - Date.now();
      if (diff <= 0) {
        $('#countdown').textContent = 'Actualizando...';
        return;
      }
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

      let parts = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      parts.push(`${mins}m`);

      $('#countdown').textContent = `Siguiente busqueda en ${parts.join(' ')}`;
    }

    updateCountdown();
    setInterval(updateCountdown, 60000);
  }

  loadData();
  startCountdown();
})();
