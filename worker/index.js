// Cloudflare Worker: monitor de precios de vuelos
// Soporta dos fuentes de datos:
//   1. n8n via POST /api/ingest (recomendado)
//   2. SerpAPI via cron/refresh (fallback)
//
// Secrets necesarios:
//   wrangler secret put INGEST_SECRET
//   wrangler secret put SERPAPI_KEY  (opcional, solo si usas el cron fallback)

const SERPAPI_URL = 'https://serpapi.com/search';

// Configuracion de busqueda
const DESTINATIONS = 'FCO,FLR,PSA,MXP,CDG,ORY';
const RETURN_ORIGINS = 'FCO,FLR,PSA,MXP,BGY,NAP,VCE';
const ORIGINS = ['MID', 'CUN'];
const OUTBOUND_DATES = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
const RETURN_DATES = ['2026-10-12', '2026-10-13', '2026-10-14'];
const RT_OUTBOUND = '2026-09-25';
const RT_RETURN = '2026-10-12';

// --- Google Flights deep link builder (protobuf tfs param) ---

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  if (v === 0) return [0];
  while (v > 0) {
    if (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
    else { bytes.push(v & 0x7f); v = 0; }
  }
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
  const uint8 = new Uint8Array(b);
  let binary = '';
  for (const byte of uint8) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildOneWayLink(from, to, date) {
  const tfs = buildTfsParam(2, [{ date, origins: from, destinations: to }]);
  return `https://www.google.com/travel/flights/search?tfs=${tfs}&curr=MXN&hl=es&gl=mx`;
}

function buildRoundTripLink(from, to, outDate, retDate) {
  const tfs = buildTfsParam(1, [
    { date: outDate, origins: from, destinations: to },
    { date: retDate, origins: to, destinations: from },
  ]);
  return `https://www.google.com/travel/flights/search?tfs=${tfs}&curr=MXN&hl=es&gl=mx`;
}

function extractDate(depTime) {
  const match = (depTime || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

// --- Procesamiento compartido ---

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

async function evaluateAlert(env, currentPrice) {
  const budgetCompraYa = parseInt(env.BUDGET_COMPRA_YA || '11000');
  const budgetBuenPrecio = parseInt(env.BUDGET_BUEN_PRECIO || '14000');

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

  if (hoursSinceLast < 24 && (lastPrice - currentPrice) < 500) return null;

  return currentPrice <= budgetCompraYa ? 'COMPRA_YA' : 'BUEN_PRECIO';
}

async function markAlertSent(env, price, level) {
  await env.FLIGHTS_KV.put('alerts_sent', JSON.stringify({
    last_sent: Date.now(),
    last_price: price,
    level,
  }));
}

async function storeResults(env, allOutbound, allReturns, allRoundtrips, source, extraMeta = {}) {
  const { bestOutbound, bestReturn, bestCombo, bestRoundtrip, bestOverall } =
    buildBestResults(allOutbound, allReturns, allRoundtrips);

  const now = new Date().toISOString();

  const alertPrice = bestOverall?.price_per_person || null;
  let alertLevel = null;
  if (alertPrice) {
    alertLevel = await evaluateAlert(env, alertPrice);
    if (alertLevel) {
      await markAlertSent(env, alertPrice, alertLevel);
    }
  }

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

  return { latest, alertLevel };
}

// --- Ingest: recibir datos desde n8n ---

function validateFlightData(flight) {
  const required = ['from', 'to', 'airlines', 'price_usd'];
  for (const field of required) {
    if (!flight[field] && flight[field] !== 0) return false;
  }
  if (typeof flight.price_usd !== 'number' || flight.price_usd < 0) return false;
  return true;
}

function normalizeIngestedFlight(flight, type) {
  const depDate = extractDate(flight.departure);
  let deep_link = flight.deep_link;
  if (!deep_link || deep_link.includes('?q=flights')) {
    if (type === 'roundtrip' && depDate) {
      deep_link = buildRoundTripLink(flight.from, flight.to, depDate, RT_RETURN);
    } else if (depDate) {
      deep_link = buildOneWayLink(flight.from, flight.to, depDate);
    } else {
      deep_link = buildOneWayLink(flight.from, flight.to, OUTBOUND_DATES[0]);
    }
  }
  return {
    id: flight.id || `${type}-${flight.from}-${flight.to}-${flight.price_usd}-${Date.now()}`,
    from: flight.from, from_city: flight.from_city || flight.from,
    to: flight.to, to_city: flight.to_city || flight.to,
    airlines: flight.airlines, departure: flight.departure || '', arrival: flight.arrival || '',
    stops: flight.stops ?? 0, duration_h: flight.duration_h ?? 0, price_usd: flight.price_usd,
    deep_link, is_best: flight.is_best || false,
    ...(type === 'roundtrip' ? { type: 'roundtrip' } : {}),
  };
}

async function handleIngest(request, env) {
  const secret = env.INGEST_SECRET;
  if (!secret) {
    return { error: 'INGEST_SECRET not configured on worker', status: 500 };
  }

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

  const rawOutbound = body.outbound || [];
  const rawReturns = body.returns || [];
  const rawRoundtrips = body.roundtrips || [];

  if (!rawOutbound.length && !rawReturns.length && !rawRoundtrips.length) {
    return { error: 'No flight data provided. Expected: { outbound: [...], returns: [...], roundtrips: [...] }', status: 400 };
  }

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

  const dedupOutbound = deduplicateFlights(outbound).slice(0, 15);
  const dedupReturns = deduplicateFlights(returns).slice(0, 15);
  const dedupRoundtrips = deduplicateFlights(roundtrips).slice(0, 10);

  const { latest, alertLevel } = await storeResults(env, dedupOutbound, dedupReturns, dedupRoundtrips, 'n8n', {
    ingested_at: new Date().toISOString(),
  });

  return {
    data: {
      message: 'Flight data ingested successfully',
      counts: {
        outbound: { received: rawOutbound.length, valid: outbound.length, after_dedup: dedupOutbound.length },
        returns: { received: rawReturns.length, valid: returns.length, after_dedup: dedupReturns.length },
        roundtrips: { received: rawRoundtrips.length, valid: roundtrips.length, after_dedup: dedupRoundtrips.length },
      },
      best_overall: latest.best_overall,
      alert_level: alertLevel,
      errors: errors.length ? errors : undefined,
    },
    status: 200,
  };
}

// --- SerpAPI search (fallback) ---

async function searchFlights(config, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: config.departure_id,
    arrival_id: config.arrival_id,
    outbound_date: config.outbound_date,
    type: config.type,
    hl: 'es',
    gl: 'mx',
    currency: 'MXN',
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

  for (const flight of [...bestFlights, ...otherFlights].slice(0, 10)) {
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
      deep_link: buildRoundTripLink(fromCode, toCode, extractDate(firstLeg.departure_airport?.time) || RT_OUTBOUND, RT_RETURN),
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

  for (const flight of [...bestFlights, ...otherFlights].slice(0, 15)) {
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
      deep_link: buildOneWayLink(fromCode, toCode, extractDate(firstLeg.departure_airport?.time) || OUTBOUND_DATES[0]),
      is_best: bestFlights.includes(flight),
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

  const { latest } = await storeResults(env, allOutbound, allReturns, allRoundtrips, 'serpapi', {
    api_calls_used: totalCalls,
  });

  return latest;
}

// --- Request Handler ---

export default {
  async scheduled(event, env, ctx) {
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
          return new Response(JSON.stringify({ error: 'No data yet. Send data via POST /api/ingest.' }), {
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

      if (path === '/api/ingest' && request.method === 'POST') {
        const result = await handleIngest(request, env);
        return new Response(JSON.stringify(result.data || { error: result.error }), {
          status: result.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
        endpoints: [
          'GET  /api/latest',
          'GET  /api/history',
          'POST /api/ingest  (n8n \u2014 recommended)',
          'GET  /api/refresh?key=<secret>  (SerpAPI fallback)',
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
