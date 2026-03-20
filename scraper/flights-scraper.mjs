#!/usr/bin/env node
// checavuelos - Google Flights Scraper con Playwright
// Scrapes flight prices and posts to /api/ingest
//
// Uso:
//   INGEST_SECRET=xxx node flights-scraper.mjs
//   DEBUG=1 INGEST_SECRET=xxx node flights-scraper.mjs  (modo verbose)
//
// Prerequisitos:
//   npm install playwright
//   npx playwright install chromium

import { chromium } from 'playwright';

// ═══════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════

const CONFIG = {
  WORKER_URL: process.env.WORKER_URL || 'https://checavuelos-api.vicente-domus.workers.dev',
  INGEST_SECRET: process.env.INGEST_SECRET || '',
  DEBUG: process.env.DEBUG === '1',

  // Rutas de búsqueda
  ORIGINS: ['MID', 'CUN'],
  DESTINATIONS: ['FCO', 'FLR', 'PSA', 'MXP', 'CDG', 'ORY'],
  RETURN_ORIGINS: ['FCO', 'FLR', 'PSA', 'MXP', 'BGY', 'NAP', 'VCE'],

  // Fechas
  OUTBOUND_DATES: ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'],
  RETURN_DATES: ['2026-10-12', '2026-10-13', '2026-10-14'],
  RT_OUTBOUND: '2026-09-25',
  RT_RETURN: '2026-10-12',

  // Scraping settings
  TIMEOUT_MS: 45000,
  DELAY_BETWEEN_SEARCHES_MS: 4000,
  MAX_RETRIES: 2,
};

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function debug(...args) {
  if (CONFIG.DEBUG) console.log(`  [debug]`, ...args);
}

// ═══════════════════════════════════════════════════════
// PROTOBUF ENCODER - Construye URLs de Google Flights
// ═══════════════════════════════════════════════════════

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  if (v === 0) return [0];
  while (v > 0) {
    if (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    } else {
      bytes.push(v & 0x7f);
      v = 0;
    }
  }
  return bytes;
}

function encodeVarintField(fieldNum, value) {
  return [...encodeVarint((fieldNum << 3) | 0), ...encodeVarint(value)];
}

function encodeLengthDelimited(fieldNum, data) {
  const tag = encodeVarint((fieldNum << 3) | 2);
  return [...tag, ...encodeVarint(data.length), ...data];
}

function encodeStringField(fieldNum, str) {
  const encoded = Array.from(new TextEncoder().encode(str));
  return encodeLengthDelimited(fieldNum, encoded);
}

function encodeAirport(fieldNum, code) {
  const inner = [...encodeVarintField(1, 1), ...encodeStringField(2, code)];
  return encodeLengthDelimited(fieldNum, inner);
}

function buildTfsParam(tripType, legs) {
  // tripType: 1 = round-trip, 2 = one-way
  let bytes = [];
  bytes.push(...encodeVarintField(1, 28));
  bytes.push(...encodeVarintField(2, tripType));

  for (const leg of legs) {
    let legBytes = [];
    legBytes.push(...encodeStringField(2, leg.date));

    const origins = Array.isArray(leg.origins) ? leg.origins : [leg.origins];
    for (const origin of origins) {
      legBytes.push(...encodeAirport(13, origin));
    }

    const destinations = Array.isArray(leg.destinations) ? leg.destinations : [leg.destinations];
    for (const dest of destinations) {
      legBytes.push(...encodeAirport(14, dest));
    }

    bytes.push(...encodeLengthDelimited(3, legBytes));
  }

  bytes.push(...encodeVarintField(8, 1));
  bytes.push(...encodeVarintField(9, 1));
  bytes.push(...encodeVarintField(14, 1));

  // Field 16: config
  const configInner = [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
  bytes.push(...encodeLengthDelimited(16, configInner));
  bytes.push(...encodeVarintField(19, 1));

  const uint8 = new Uint8Array(bytes);
  const base64 = Buffer.from(uint8).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildGoogleFlightsUrl(tfs) {
  return `https://www.google.com/travel/flights/search?tfs=${tfs}&curr=MXN&hl=es&gl=mx`;
}

// ═══════════════════════════════════════════════════════
// GENERADOR DE BÚSQUEDAS
// ═══════════════════════════════════════════════════════

function generateSearches() {
  const searches = [];

  // Outbound: origin → all destinations, one per origin per date
  for (const origin of CONFIG.ORIGINS) {
    for (const date of CONFIG.OUTBOUND_DATES) {
      const tfs = buildTfsParam(2, [{
        date,
        origins: origin,
        destinations: CONFIG.DESTINATIONS,
      }]);
      searches.push({
        type: 'outbound',
        label: `IDA ${origin} → ALL (${date})`,
        url: buildGoogleFlightsUrl(tfs),
        origin,
        date,
      });
    }
  }

  // Return: all return origins → destination, one per destination per date
  for (const dest of CONFIG.ORIGINS) {
    for (const date of CONFIG.RETURN_DATES) {
      const tfs = buildTfsParam(2, [{
        date,
        origins: CONFIG.RETURN_ORIGINS,
        destinations: dest,
      }]);
      searches.push({
        type: 'return',
        label: `VUELTA ALL → ${dest} (${date})`,
        url: buildGoogleFlightsUrl(tfs),
        destination: dest,
        date,
      });
    }
  }

  // Round-trip: origin → all destinations
  for (const origin of CONFIG.ORIGINS) {
    const tfs = buildTfsParam(1, [
      { date: CONFIG.RT_OUTBOUND, origins: origin, destinations: CONFIG.DESTINATIONS },
      { date: CONFIG.RT_RETURN, origins: CONFIG.DESTINATIONS, destinations: origin },
    ]);
    searches.push({
      type: 'roundtrip',
      label: `ROUNDTRIP ${origin} (${CONFIG.RT_OUTBOUND} → ${CONFIG.RT_RETURN})`,
      url: buildGoogleFlightsUrl(tfs),
      origin,
    });
  }

  return searches;
}

// ═══════════════════════════════════════════════════════
// EXTRACTOR DE DATOS DE VUELOS
// ═══════════════════════════════════════════════════════

async function extractFlightsFromPage(page) {
  // Wait for flight results to render
  try {
    await page.waitForSelector('[role="list"] li, [jsname="IWWIKb"], [data-resultid]', {
      timeout: 15000,
    });
  } catch {
    debug('No flight result selectors found, trying fallback...');
  }

  // Extra wait for dynamic content
  await page.waitForTimeout(3000);

  // Extract flight data from the DOM
  const flights = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Known airport codes for filtering
    const KNOWN_AIRPORTS = new Set([
      'MID', 'CUN', 'FCO', 'FLR', 'PSA', 'MXP', 'CDG', 'ORY', 'BGY', 'NAP', 'VCE',
      'MEX', 'GDL', 'MTY', 'TIJ', 'SJD', 'CJS', 'PVR', 'ACA',
      'DFW', 'IAH', 'ATL', 'JFK', 'LAX', 'ORD', 'MIA', 'EWR', 'SFO', 'CLT', 'PHX',
      'AMS', 'MAD', 'BCN', 'LHR', 'LGW', 'FRA', 'MUC', 'IST', 'DOH', 'DXB',
      'GRU', 'BOG', 'LIM', 'SCL', 'PTY', 'SAL', 'HAV',
      'YYZ', 'YUL', 'YVR',
    ]);

    // Words that look like airport codes but aren't
    const EXCLUDE_CODES = new Set([
      'USD', 'MXN', 'EUR', 'AND', 'THE', 'FOR', 'NOT', 'ALL', 'HRS', 'MIN',
      'VIA', 'DAY', 'NEW', 'AIR', 'SEP', 'OCT', 'NOV', 'JUN', 'JUL', 'AUG',
      'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN',
      'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM',
    ]);

    // Strategy: find all list items that look like flight cards
    const candidates = document.querySelectorAll('li, [role="listitem"]');

    for (const el of candidates) {
      const text = el.innerText || '';
      if (text.length < 30 || text.length > 3000) continue;

      // Must have a price (MXN format: $12,345 or MX$12,345 or MXN 12,345)
      const priceMatch = text.match(/(?:MX|MXN\s*)?\$([\d,. ]+)/);
      if (!priceMatch) continue;

      const rawPrice = priceMatch[1].replace(/[\s,]/g, '').replace(/\.(?=\d{3})/g, '');
      const price = Math.round(parseFloat(rawPrice));
      if (!price || price < 1000 || price > 500000) continue;

      // Extract airport codes
      const codeMatches = text.match(/\b[A-Z]{3}\b/g) || [];
      const airports = codeMatches.filter(c => KNOWN_AIRPORTS.has(c) && !EXCLUDE_CODES.has(c));
      if (airports.length < 2) continue;

      // Deduplicate this card
      const dedupKey = `${airports[0]}-${airports[1]}-${price}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // Extract times (various formats)
      const timeMatches = text.match(/\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?/gi) || [];

      // Extract duration
      const durMatch = text.match(/(\d+)\s*(?:hr?|h|hora)(?:\s*(\d+)\s*(?:min|m))?/i);
      let durationH = 0;
      if (durMatch) {
        durationH = parseInt(durMatch[1]) + (parseInt(durMatch[2] || '0') / 60);
        durationH = Math.round(durationH * 10) / 10;
      }

      // Extract stops
      let stops = 0;
      const stopsMatch = text.match(/(\d+)\s*(?:stop|escala|parada)/i);
      const nonStopMatch = text.match(/(nonstop|directo|sin\s*escala)/i);
      if (stopsMatch) {
        stops = parseInt(stopsMatch[1]);
      } else if (!nonStopMatch && !stopsMatch) {
        stops = 0; // default
      }

      // Extract airline name
      let airline = 'Unknown';
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const line of lines) {
        // Airline names: capitalized, no numbers, reasonable length
        if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]+$/.test(line) && line.length >= 3 && line.length <= 35) {
          // Exclude lines that are just airport/city names
          if (!KNOWN_AIRPORTS.has(line.toUpperCase()) && !/^\d/.test(line)) {
            airline = line;
            break;
          }
        }
      }

      results.push({
        from: airports[0],
        to: airports[1],
        airlines: airline,
        price_usd: price,
        departure: timeMatches[0] || '',
        arrival: timeMatches[1] || '',
        stops,
        duration_h: durationH,
      });
    }

    return results;
  });

  return flights;
}

// ═══════════════════════════════════════════════════════
// SCRAPER PRINCIPAL
// ═══════════════════════════════════════════════════════

async function scrapeSearch(browser, search) {
  const context = await browser.newContext({
    locale: 'es-MX',
    timezoneId: 'America/Merida',
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    debug(`Navigating to: ${search.url}`);
    await page.goto(search.url, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.TIMEOUT_MS,
    });

    // Handle cookie consent
    try {
      const consentBtn = page.locator('button:has-text("Aceptar"), button:has-text("Accept"), button:has-text("Acepto")').first();
      await consentBtn.click({ timeout: 3000 });
      await page.waitForTimeout(1000);
    } catch {
      // No consent dialog
    }

    // Wait for page to settle
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const flights = await extractFlightsFromPage(page);

    // Add deep_link to each flight
    for (const f of flights) {
      f.deep_link = `https://www.google.com/travel/flights?q=flights+from+${f.from}+to+${f.to}`;
    }

    debug(`Extracted ${flights.length} flights from ${search.label}`);

    if (CONFIG.DEBUG && flights.length === 0) {
      // Save screenshot for debugging
      const filename = `/tmp/gf-debug-${search.type}-${Date.now()}.png`;
      await page.screenshot({ path: filename, fullPage: true });
      debug(`Screenshot saved: ${filename}`);
    }

    return flights;
  } catch (err) {
    log(`ERROR scraping ${search.label}: ${err.message}`);
    return [];
  } finally {
    await context.close();
  }
}

async function scrapeAllRoutes() {
  const searches = generateSearches();
  log(`Generated ${searches.length} searches`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const allOutbound = [];
  const allReturns = [];
  const allRoundtrips = [];
  const errors = [];

  try {
    for (let i = 0; i < searches.length; i++) {
      const search = searches[i];
      log(`[${i + 1}/${searches.length}] ${search.label}`);

      let flights = [];
      for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
        flights = await scrapeSearch(browser, search);
        if (flights.length > 0) break;
        if (attempt < CONFIG.MAX_RETRIES) {
          log(`  Retry ${attempt + 1}/${CONFIG.MAX_RETRIES}...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (flights.length === 0) {
        errors.push(`No flights found: ${search.label}`);
      }

      // Categorize flights
      if (search.type === 'outbound') {
        allOutbound.push(...flights);
      } else if (search.type === 'return') {
        allReturns.push(...flights);
      } else if (search.type === 'roundtrip') {
        for (const f of flights) f.type = 'roundtrip';
        allRoundtrips.push(...flights);
      }

      // Rate limiting
      if (i < searches.length - 1) {
        await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_SEARCHES_MS));
      }
    }
  } finally {
    await browser.close();
  }

  return { outbound: allOutbound, returns: allReturns, roundtrips: allRoundtrips, errors };
}

// ═══════════════════════════════════════════════════════
// DEDUPLICACIÓN
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
// ENVÍO A /api/ingest
// ═══════════════════════════════════════════════════════

async function postToIngest(data) {
  const url = `${CONFIG.WORKER_URL}/api/ingest`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.INGEST_SECRET}`,
    },
    body: JSON.stringify(data),
  });

  const body = await res.json();

  if (!res.ok) {
    throw new Error(`Ingest failed (${res.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  log('=== checavuelos scraper starting ===');

  if (!CONFIG.INGEST_SECRET) {
    console.error('ERROR: Set INGEST_SECRET environment variable');
    process.exit(1);
  }

  // Scrape all routes
  const raw = await scrapeAllRoutes();

  // Deduplicate and limit
  const outbound = deduplicateFlights(raw.outbound).slice(0, 15);
  const returns = deduplicateFlights(raw.returns).slice(0, 15);
  const roundtrips = deduplicateFlights(raw.roundtrips).slice(0, 10);

  log(`Results: ${outbound.length} outbound, ${returns.length} return, ${roundtrips.length} roundtrip`);

  if (raw.errors.length > 0) {
    log(`Warnings: ${raw.errors.length} searches had no results`);
    for (const err of raw.errors) debug(err);
  }

  if (outbound.length === 0 && returns.length === 0 && roundtrips.length === 0) {
    log('No flights found at all. Check DEBUG=1 output for screenshots.');
    process.exit(1);
  }

  // Send to API
  log('Sending to /api/ingest...');
  const payload = { outbound, returns, roundtrips };
  const result = await postToIngest(payload);

  log('Ingest response:', JSON.stringify(result, null, 2));
  log('=== scraper finished ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
