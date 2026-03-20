// Cloudflare Worker: monitor de precios de vuelos
// Soporta dos fuentes de datos:
//   1. n8n/Make via POST /api/ingest (recomendado - sin limites de API)
//   2. SerpAPI via cron/refresh (legacy - 100 calls/mes gratis)
//
// Secrets necesarios:
//   wrangler secret put INGEST_SECRET   (para autenticar POST desde n8n)
//   wrangler secret put RESEND_API_KEY  (para alertas email)
//   wrangler secret put SERPAPI_KEY     (opcional, solo si usas SerpAPI)

const SERPAPI_URL = 'https://serpapi.com/search';

// Configuracion de busqueda (usada por SerpAPI y como referencia para n8n)
const DESTINATIONS = 'FCO,FLR,PSA,MXP,CDG,ORY';
const RETURN_ORIGINS = 'FCO,FLR,PSA,MXP,BGY,NAP,VCE';
const ORIGINS = ['MID', 'CUN'];
const OUTBOUND_DATES = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
const RETURN_DATES = ['2026-10-12', '2026-10-13', '2026-10-14'];
const RT_OUTBOUND = '2026-09-25';
const RT_RETURN = '2026-10-12';

// --- Procesamiento de vuelos (compartido entre ambos approaches) ---

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

function buildBestResults(allOutbound, allReturns, allRoundtrips) {
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

  return { bestOutbound, bestReturn, bestCombo, bestRoundtrip, bestOverall };
}

async function storeResults(env, allOutbound, allReturns, allRoundtrips, source, extraMeta = {}) {
  const { bestOutbound, bestReturn, bestCombo, bestRoundtrip, bestOverall } =
    buildBestResults(allOutbound, allReturns, allRoundtrips);

  const now = new Date().toISOString();

  const latest = {
    updated_at: now,
    source,
    outbound: allOutbound,
    returns: allReturns,
    roundtrips: allRoundtrips,
    best_combo: bestCombo,
    best_roundtrip: bestRoundtrip,
    best_overall: bestOverall,
    search_params: {
      origins: ORIGINS,
      destinations: DESTINATIONS,
      return_origins: RETURN_ORIGINS,
      outbound_dates: OUTBOUND_DATES,
      return_dates: RETURN_DATES,
      rt_outbound: RT_OUTBOUND,
      rt_return: RT_RETURN,
    },
    ...extraMeta,
  };
  await env.FLIGHTS_KV.put('latest', JSON.stringify(latest));

  let history = [];
  try {
    const stored = await env.FLIGHTS_KV.get('history', 'json');
    if (stored) history = stored;
  } catch { /* primera vez */ }

  history.push({
    timestamp: now,
    source,
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

  // Alertas
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

// --- Ingest: recibir datos desde n8n/Make ---

function validateFlightData(flight) {
  const required = ['from', 'to', 'airlines', 'price_usd'];
  for (const field of required) {
    if (!flight[field] && flight[field] !== 0) return false;
  }
  if (typeof flight.price_usd !== 'number' || flight.price_usd < 0) return false;
  return true;
}

function normalizeIngestedFlight(flight, type) {
  return {
    id: flight.id || `${type}-${flight.from}-${flight.to}-${flight.price_usd}-${Date.now()}`,
    from: flight.from,
    from_city: flight.from_city || flight.from,
    to: flight.to,
    to_city: flight.to_city || flight.to,
    airlines: flight.airlines,
    departure: flight.departure || '',
    arrival: flight.arrival || '',
    stops: flight.stops ?? 0,
    duration_h: flight.duration_h ?? 0,
    price_usd: flight.price_usd,
    deep_link: flight.deep_link || `https://www.google.com/travel/flights?q=flights+from+${flight.from}+to+${flight.to}`,
    is_best: flight.is_best || false,
    carbon_emissions: flight.carbon_emissions || null,
    ...(type === 'roundtrip' ? { type: 'roundtrip' } : {}),
  };
}

async function handleIngest(request, env) {
  const secret = env.INGEST_SECRET;
  if (!secret) {
    return { error: 'INGEST_SECRET not configured on worker', status: 500 };
  }

  // Auth: Bearer token or query param
  const authHeader = request.headers.get('Authorization') || '';
  const url = new URL(request.url);
  const queryKey = url.searchParams.get('key');
  const token = authHeader.replace('Bearer ', '').trim() || queryKey;

  if (token !== secret) {
    return { error: 'Unauthorized', status: 401 };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { error: 'Invalid JSON body', status: 400 };
  }

  // Formato esperado:
  // {
  //   outbound: [{ from, to, airlines, price_usd, ... }],
  //   returns: [{ from, to, airlines, price_usd, ... }],
  //   roundtrips: [{ from, to, airlines, price_usd, ... }]  // opcional
  // }

  const rawOutbound = body.outbound || [];
  const rawReturns = body.returns || [];
  const rawRoundtrips = body.roundtrips || [];

  if (!rawOutbound.length && !rawReturns.length && !rawRoundtrips.length) {
    return { error: 'No flight data provided. Expected: { outbound: [...], returns: [...], roundtrips: [...] }', status: 400 };
  }

  // Validar y normalizar
  const errors = [];
  const outbound = [];
  const returns = [];
  const roundtrips = [];

  for (const [i, f] of rawOutbound.entries()) {
    if (!validateFlightData(f)) { errors.push(`outbound[${i}]: missing required fields`); continue; }
    outbound.push(normalizeIngestedFlight(f, 'outbound'));
  }
  for (const [i, f] of rawReturns.entries()) {
    if (!validateFlightData(f)) { errors.push(`returns[${i}]: missing required fields`); continue; }
    returns.push(normalizeIngestedFlight(f, 'return'));
  }
  for (const [i, f] of rawRoundtrips.entries()) {
    if (!validateFlightData(f)) { errors.push(`roundtrips[${i}]: missing required fields`); continue; }
    roundtrips.push(normalizeIngestedFlight(f, 'roundtrip'));
  }

  // Dedup y ordenar
  const dedupOutbound = deduplicateFlights(outbound).slice(0, 15);
  const dedupReturns = deduplicateFlights(returns).slice(0, 15);
  const dedupRoundtrips = deduplicateFlights(roundtrips).slice(0, 10);

  const latest = await storeResults(env, dedupOutbound, dedupReturns, dedupRoundtrips, 'n8n', {
    ingested_at: new Date().toISOString(),
    ingested_counts: {
      outbound: { received: rawOutbound.length, valid: outbound.length, after_dedup: dedupOutbound.length },
      returns: { received: rawReturns.length, valid: returns.length, after_dedup: dedupReturns.length },
      roundtrips: { received: rawRoundtrips.length, valid: roundtrips.length, after_dedup: dedupRoundtrips.length },
    },
    validation_errors: errors.length ? errors : undefined,
  });

  return {
    data: {
      message: 'Flight data ingested successfully',
      counts: latest.ingested_counts,
      best_overall: latest.best_overall,
      errors: errors.length ? errors : undefined,
    },
    status: 200,
  };
}

// --- SerpAPI search (legacy) ---

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
    sort_by: '2',
    api_key: apiKey,
  });

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

async function runSearch(env) {
  const apiKey = env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY not configured (use n8n ingest instead)');

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

  const allResults = await Promise.all([
    ...outboundSearches,
    ...returnSearches,
    ...rtSearches,
  ]);

  const outboundCount = outboundSearches.length;
  const returnCount = returnSearches.length;
  const totalCalls = outboundCount + returnCount + rtSearches.length;

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

  return storeResults(env, allOutbound, allReturns, allRoundtrips, 'serpapi', {
    api_calls_used: totalCalls,
  });
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
      <p style="color:#888;font-size:12px">checavuelos \u00b7 Datos via n8n + Google Flights</p>
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

// --- Request Handler ---

export default {
  async scheduled(event, env, ctx) {
    // Solo ejecuta si hay SERPAPI_KEY configurada (legacy)
    if (env.SERPAPI_KEY) {
      ctx.waitUntil(runSearch(env));
    }
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
          return new Response(JSON.stringify({ error: 'No data yet. Trigger a refresh or send data via POST /api/ingest.' }), {
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

      // n8n/Make ingest endpoint
      if (path === '/api/ingest' && request.method === 'POST') {
        const result = await handleIngest(request, env);
        return new Response(JSON.stringify(result.data || { error: result.error }), {
          status: result.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // SerpAPI refresh (legacy)
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
        endpoints: [
          'GET  /api/latest',
          'GET  /api/history',
          'POST /api/ingest  (n8n/Make - recommended)',
          'GET  /api/refresh?key=<secret>  (SerpAPI legacy)',
        ],
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
