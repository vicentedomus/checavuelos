// Cloudflare Worker: monitor de precios de vuelos via SerpAPI (Google Flights)
// Secrets necesarios:
//   wrangler secret put SERPAPI_KEY
//   wrangler secret put RESEND_API_KEY

const SERPAPI_URL = 'https://serpapi.com/search';

// Configuracion de busqueda
// Busquedas separadas por aeropuerto de origen (MID y CUN) para asegurar resultados de ambos
// 16 API calls por ejecucion x ~6 ejecuciones/mes (cada martes) = ~96/mes de 100 gratis
const DESTINATIONS = 'FCO,FLR,PSA,MXP,CDG,ORY';
const RETURN_ORIGINS = 'FCO,FLR,PSA,MXP,BGY,NAP,VCE';
const ORIGINS = ['MID', 'CUN'];
const OUTBOUND_DATES = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
const RETURN_DATES = ['2026-10-12', '2026-10-13', '2026-10-14'];
// Round-trip: fecha ancla (la mas probable)
const RT_OUTBOUND = '2026-09-25';
const RT_RETURN = '2026-10-12';

// --- Busqueda SerpAPI ---

async function searchFlights(config, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: config.departure_id,
    arrival_id: config.arrival_id,
    outbound_date: config.outbound_date,
    type: config.type,
    hl: 'es',
    gl: 'mx',
    currency: 'USD',
    sort_by: '2',  // Ordenar por precio
    api_key: apiKey,
  });

  // Agregar return_date solo para round trip
  if (config.return_date) {
    params.set('return_date', config.return_date);
  }

  const res = await fetch(`${SERPAPI_URL}?${params.toString()}`);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SerpAPI error ${res.status}: ${err}`);
  }

  return res.json();
}

// Procesar resultados round-trip (estructura diferente a one-way)
function processRoundtripResults(serpData) {
  const flights = [];

  const bestFlights = serpData?.best_flights || [];
  const otherFlights = serpData?.other_flights || [];
  const allFlights = [...bestFlights, ...otherFlights];

  for (const flight of allFlights.slice(0, 10)) {
    const legs = flight.flights || [];
    if (!legs.length) continue;

    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];
    const airlines = [...new Set(legs.map(l => l.airline))].join(', ');
    const stops = legs.length - 1;
    const fromCode = firstLeg.departure_airport?.id || '';
    const toCode = lastLeg.arrival_airport?.id || '';

    flights.push({
      id: `rt-${fromCode}-${toCode}-${flight.price}-${firstLeg.flight_number || ''}`,
      from: fromCode,
      from_city: firstLeg.departure_airport?.name || fromCode,
      to: toCode,
      to_city: lastLeg.arrival_airport?.name || toCode,
      airlines,
      departure: firstLeg.departure_airport?.time || '',
      arrival: lastLeg.arrival_airport?.time || '',
      stops,
      duration_h: Math.round((flight.total_duration || 0) / 60 * 10) / 10,
      price_usd: flight.price || 0,
      deep_link: `https://www.google.com/travel/flights?q=flights+from+${fromCode}+to+${toCode}`,
      is_best: bestFlights.includes(flight),
      type: 'roundtrip',
    });
  }

  flights.sort((a, b) => a.price_usd - b.price_usd);
  return flights.slice(0, 10);
}

function processResults(serpData) {
  const flights = [];

  const bestFlights = serpData?.best_flights || [];
  const otherFlights = serpData?.other_flights || [];
  const allFlights = [...bestFlights, ...otherFlights];

  for (const flight of allFlights.slice(0, 15)) {
    const legs = flight.flights || [];
    if (!legs.length) continue;

    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];
    const airlines = [...new Set(legs.map(l => l.airline))].join(', ');
    const stops = legs.length - 1;

    const fromCode = firstLeg.departure_airport?.id || '';
    const toCode = lastLeg.arrival_airport?.id || '';

    flights.push({
      id: `${fromCode}-${toCode}-${flight.price}-${firstLeg.flight_number || ''}`,
      from: fromCode,
      from_city: firstLeg.departure_airport?.name || fromCode,
      to: toCode,
      to_city: lastLeg.arrival_airport?.name || toCode,
      airlines,
      departure: firstLeg.departure_airport?.time || '',
      arrival: lastLeg.arrival_airport?.time || '',
      stops,
      duration_h: Math.round((flight.total_duration || 0) / 60 * 10) / 10,
      price_usd: flight.price || 0,
      deep_link: `https://www.google.com/travel/flights?q=flights+from+${fromCode}+to+${toCode}`,
      is_best: bestFlights.includes(flight),
      carbon_emissions: flight.carbon_emissions?.this_flight || null,
    });
  }

  flights.sort((a, b) => a.price_usd - b.price_usd);
  return flights.slice(0, 10);
}

// --- Alertas email via Resend ---

async function shouldSendAlert(env, currentPrice) {
  const budgetCompraYa = parseInt(env.BUDGET_COMPRA_YA || '750');
  const budgetBuenPrecio = parseInt(env.BUDGET_BUEN_PRECIO || '900');

  if (currentPrice > budgetBuenPrecio) return null;

  let alertsData = {};
  try {
    const stored = await env.FLIGHTS_KV.get('alerts_sent', 'json');
    if (stored) alertsData = stored;
  } catch { /* primera vez */ }

  const now = Date.now();
  const lastSent = alertsData.last_sent || 0;
  const lastPrice = alertsData.last_price || Infinity;
  const hoursSinceLast = (now - lastSent) / (1000 * 60 * 60);

  if (hoursSinceLast < 24 && (lastPrice - currentPrice) < 50) return null;

  return currentPrice <= budgetCompraYa ? 'COMPRA_YA' : 'BUEN_PRECIO';
}

async function sendAlert(env, level, bestCombo) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return;

  const isUrgent = level === 'COMPRA_YA';
  const emoji = isUrgent ? '\ud83d\udea8' : '\u2708\ufe0f';
  const levelText = isUrgent ? 'COMPRA YA' : 'Buen precio';
  const color = isUrgent ? '#e53e3e' : '#38a169';

  const totalPerPerson = bestCombo.total_per_person;
  const total2 = bestCombo.total_2_passengers;
  const ob = bestCombo.outbound;
  const ret = bestCombo.return;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h1 style="color:${color}">${emoji} ${levelText}: $${totalPerPerson}/persona</h1>
      <p style="font-size:18px">Total para 2 pasajeros: <strong>$${total2} USD</strong></p>
      <hr>
      <h3>\u2708\ufe0f Ida</h3>
      <p><strong>${ob.from_city} (${ob.from}) \u2192 ${ob.to_city} (${ob.to})</strong></p>
      <p>${ob.airlines} \u00b7 ${ob.stops} escala(s) \u00b7 ${ob.duration_h}h</p>
      <p>Salida: ${ob.departure}</p>
      <p>Precio: <strong>$${ob.price_usd} USD</strong></p>
      <a href="${ob.deep_link}" style="display:inline-block;padding:10px 20px;background:${color};color:#fff;text-decoration:none;border-radius:5px">Buscar en Google Flights</a>
      <hr>
      <h3>\ud83d\udeec Vuelta</h3>
      <p><strong>${ret.from_city} (${ret.from}) \u2192 ${ret.to_city} (${ret.to})</strong></p>
      <p>${ret.airlines} \u00b7 ${ret.stops} escala(s) \u00b7 ${ret.duration_h}h</p>
      <p>Salida: ${ret.departure}</p>
      <p>Precio: <strong>$${ret.price_usd} USD</strong></p>
      <a href="${ret.deep_link}" style="display:inline-block;padding:10px 20px;background:${color};color:#fff;text-decoration:none;border-radius:5px">Buscar en Google Flights</a>
      <hr>
      <p style="color:#888;font-size:12px">checavuelos \u00b7 Datos via Google Flights (SerpAPI)</p>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'checavuelos <onboarding@resend.dev>',
      to: env.ALERT_EMAIL || 'vichomiguel@hotmail.com',
      subject: `${emoji} ${levelText}: $${totalPerPerson}/persona - Vuelo a Italia`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
    return;
  }

  await env.FLIGHTS_KV.put('alerts_sent', JSON.stringify({
    last_sent: Date.now(),
    last_price: totalPerPerson,
    level,
  }));
}

// --- Logica principal ---

function deduplicateFlights(flights) {
  const seen = new Map();
  for (const f of flights) {
    const key = `${f.from}-${f.to}-${f.airlines}-${f.departure}`;
    if (!seen.has(key) || f.price_usd < seen.get(key).price_usd) {
      seen.set(key, f);
    }
  }
  return [...seen.values()].sort((a, b) => a.price_usd - b.price_usd);
}

async function runSearch(env) {
  const apiKey = env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY not configured');

  // Outbound: 2 origenes x 4 fechas = 8 calls
  const outboundSearches = [];
  for (const origin of ORIGINS) {
    for (const date of OUTBOUND_DATES) {
      outboundSearches.push(searchFlights({
        departure_id: origin,
        arrival_id: DESTINATIONS,
        outbound_date: date,
        type: '2',
      }, apiKey));
    }
  }

  // Return: 2 destinos x 3 fechas = 6 calls
  const returnSearches = [];
  for (const dest of ORIGINS) {
    for (const date of RETURN_DATES) {
      returnSearches.push(searchFlights({
        departure_id: RETURN_ORIGINS,
        arrival_id: dest,
        outbound_date: date,
        type: '2',
      }, apiKey));
    }
  }

  // Round-trip: 2 origenes x 1 combo = 2 calls
  const rtSearches = [];
  for (const origin of ORIGINS) {
    rtSearches.push(searchFlights({
      departure_id: origin,
      arrival_id: DESTINATIONS,
      outbound_date: RT_OUTBOUND,
      return_date: RT_RETURN,
      type: '1',
    }, apiKey));
  }

  // Ejecutar todas en paralelo (16 calls)
  const allResults = await Promise.all([
    ...outboundSearches,
    ...returnSearches,
    ...rtSearches,
  ]);

  const outboundCount = outboundSearches.length;
  const returnCount = returnSearches.length;
  const totalCalls = outboundCount + returnCount + rtSearches.length;

  // Procesar y mergear resultados
  let allOutbound = [];
  for (let i = 0; i < outboundCount; i++) {
    allOutbound.push(...processResults(allResults[i]));
  }
  allOutbound = deduplicateFlights(allOutbound).slice(0, 15);

  let allReturns = [];
  for (let i = outboundCount; i < outboundCount + returnCount; i++) {
    allReturns.push(...processResults(allResults[i]));
  }
  allReturns = deduplicateFlights(allReturns).slice(0, 15);

  let allRoundtrips = [];
  for (let i = outboundCount + returnCount; i < allResults.length; i++) {
    allRoundtrips.push(...processRoundtripResults(allResults[i]));
  }
  allRoundtrips = deduplicateFlights(allRoundtrips).slice(0, 10);

  const bestOutbound = allOutbound[0] || null;
  const bestReturn = allReturns[0] || null;
  let bestCombo = null;

  if (bestOutbound && bestReturn) {
    bestCombo = {
      outbound: bestOutbound,
      return: bestReturn,
      total_per_person: bestOutbound.price_usd + bestReturn.price_usd,
      total_2_passengers: (bestOutbound.price_usd + bestReturn.price_usd) * 2,
    };
  }

  const bestRoundtrip = allRoundtrips[0] || null;

  let bestOverall = null;
  const comboPrice = bestCombo?.total_per_person || Infinity;
  const rtPrice = bestRoundtrip?.price_usd || Infinity;

  if (comboPrice <= rtPrice && bestCombo) {
    bestOverall = { source: 'one-way', price_per_person: comboPrice, price_2_passengers: comboPrice * 2 };
  } else if (bestRoundtrip) {
    bestOverall = { source: 'roundtrip', price_per_person: rtPrice, price_2_passengers: rtPrice * 2 };
  }

  const now = new Date().toISOString();

  const latest = {
    updated_at: now,
    outbound: allOutbound,
    returns: allReturns,
    roundtrips: allRoundtrips,
    best_combo: bestCombo,
    best_roundtrip: bestRoundtrip,
    best_overall: bestOverall,
    api_calls_used: totalCalls,
    search_params: {
      origins: ORIGINS,
      destinations: DESTINATIONS,
      return_origins: RETURN_ORIGINS,
      outbound_dates: OUTBOUND_DATES,
      return_dates: RETURN_DATES,
      rt_outbound: RT_OUTBOUND,
      rt_return: RT_RETURN,
    },
  };
  await env.FLIGHTS_KV.put('latest', JSON.stringify(latest));

  let history = [];
  try {
    const stored = await env.FLIGHTS_KV.get('history', 'json');
    if (stored) history = stored;
  } catch { /* primera vez */ }

  history.push({
    timestamp: now,
    best_outbound_price: bestOutbound?.price_usd || null,
    best_return_price: bestReturn?.price_usd || null,
    best_total: bestCombo?.total_per_person || null,
    best_roundtrip_price: bestRoundtrip?.price_usd || null,
    best_overall_price: bestOverall?.price_per_person || null,
    results_outbound: allOutbound.length,
    results_return: allReturns.length,
    results_roundtrip: allRoundtrips.length,
  });

  if (history.length > 300) history = history.slice(-300);
  await env.FLIGHTS_KV.put('history', JSON.stringify(history));

  const alertPrice = bestOverall?.price_per_person || null;
  if (alertPrice) {
    const alertLevel = await shouldSendAlert(env, alertPrice);
    if (alertLevel) {
      if (bestOverall.source === 'one-way' && bestCombo) {
        await sendAlert(env, alertLevel, bestCombo);
      } else if (bestRoundtrip) {
        await sendAlert(env, alertLevel, {
          outbound: bestRoundtrip,
          return: { ...bestRoundtrip, from: bestRoundtrip.to, to: bestRoundtrip.from,
            from_city: bestRoundtrip.to_city, to_city: bestRoundtrip.from_city },
          total_per_person: bestRoundtrip.price_usd,
          total_2_passengers: bestRoundtrip.price_usd * 2,
        });
      }
    }
  }

  return latest;
}

// --- Request Handler ---

export default {
  // Cron: martes 8am UTC (2am Merida). 16 calls/ejecucion x ~6/mes = 96 de 100 gratis
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSearch(env));
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = [
      env.ALLOWED_ORIGIN || 'https://vicentedomus.github.io',
      'http://127.0.0.1:5500',
      'http://localhost:5500',
      'http://127.0.0.1:5501',
      'http://localhost:5501',
    ];
    const matchedOrigin = allowedOrigins.find(o => origin.startsWith(o)) || allowedOrigins[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin': matchedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    try {
      if (path === '/api/latest') {
        const data = await env.FLIGHTS_KV.get('latest');
        if (!data) {
          return new Response(JSON.stringify({ error: 'No data yet. Trigger a refresh first.' }), {
            status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(data, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        });
      }

      if (path === '/api/history') {
        const data = await env.FLIGHTS_KV.get('history');
        return new Response(data || '[]', {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        });
      }

      if (path === '/api/refresh') {
        const key = url.searchParams.get('key');
        if (key !== (env.REFRESH_SECRET || 'checavuelos2026')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const result = await runSearch(env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        error: 'Not found',
        endpoints: ['/api/latest', '/api/history', '/api/refresh?key=<secret>'],
      }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
