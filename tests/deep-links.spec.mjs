import { chromium } from 'playwright';

const SITE = 'https://vicentedomus.github.io/checavuelos/';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'es-MX',
    timezoneId: 'America/Merida',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  console.log('1. Cargando checavuelos...');
  await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Collect all Google Flights links with context
  const links = await page.evaluate(() => {
    const allLinks = Array.from(document.querySelectorAll('a[href*="google.com/travel/flights"]'));
    return allLinks.map((a, i) => {
      const tableId = a.closest('table')?.id || '';
      const isHero = !!a.closest('#hero');
      const row = a.closest('tr');
      const cells = row ? Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim()) : [];
      return { href: a.href, tableId, isHero, label: isHero ? 'Hero' : `${tableId} fila`, rowData: cells.slice(0, 3).join(' ') };
    });
  });

  console.log(`   ${links.length} links encontrados\n`);

  // Pick 3 sample links to test: 1 from hero/outbound, 1 from return, 1 from roundtrip
  const samples = [];
  const heroLink = links.find(l => l.isHero);
  const outLink = links.find(l => l.tableId === 'table-outbound');
  const retLink = links.find(l => l.tableId === 'table-return');
  const rtLink = links.find(l => l.tableId === 'table-roundtrip');
  if (heroLink) samples.push({ ...heroLink, expected: 'sept.*oct', name: 'Hero IDA' });
  if (outLink) samples.push({ ...outLink, expected: 'sept', name: 'Tabla IDA' });
  if (retLink) samples.push({ ...retLink, expected: 'oct', name: 'Tabla VUELTA' });
  if (rtLink) samples.push({ ...rtLink, expected: 'sept.*oct', name: 'Tabla RT' });

  let passed = 0;
  let failed = 0;

  for (const sample of samples) {
    console.log(`2. Probando ${sample.name}: ${sample.rowData || 'hero link'}`);
    const gfPage = await context.newPage();
    try {
      await gfPage.goto(sample.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await gfPage.waitForTimeout(6000);

      // Get dates shown in Google Flights date pickers
      const dateText = await gfPage.evaluate(() => {
        // Google Flights date inputs
        const inputs = Array.from(document.querySelectorAll('input[type="text"], [data-type="date"], [aria-label*="fecha"], [aria-label*="Ida"], [aria-label*="Vuelta"], [data-placeholder*="fecha"]'));
        const dateButtons = Array.from(document.querySelectorAll('button[aria-label*="sept"], button[aria-label*="oct"], button[aria-label*="abr"]'));
        const allText = document.body.innerText;

        // Find date-like patterns in the page
        const datePatterns = allText.match(/\d{1,2}\s+(?:de\s+)?(?:ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)[a-z]*/gi) || [];
        const monthPatterns = allText.match(/(?:ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)[a-z]*\s+\d{4}/gi) || [];

        return {
          inputs: inputs.map(i => i.value || i.textContent?.trim()).filter(Boolean).slice(0, 4),
          datePatterns: datePatterns.slice(0, 10),
          monthPatterns: monthPatterns.slice(0, 5),
          hasAbril: /\babr(?:il)?\b/i.test(allText),
          hasSept: /\bsept?\b/i.test(allText),
          hasOct: /\boct\b/i.test(allText),
        };
      });

      const screenshotName = `tests/gf-${sample.name.replace(/\s/g, '-').toLowerCase()}.png`;
      await gfPage.screenshot({ path: screenshotName, fullPage: false });

      console.log(`   Fechas encontradas: ${dateText.datePatterns.slice(0, 4).join(', ')}`);
      console.log(`   Sept: ${dateText.hasSept}, Oct: ${dateText.hasOct}, Abril: ${dateText.hasAbril}`);

      // Validate
      const hasCorrectMonth = dateText.hasSept || dateText.hasOct;
      const hasWrongMonth = dateText.hasAbril;

      if (hasCorrectMonth && !hasWrongMonth) {
        console.log(`   [PASS] Fechas sept/oct correctas\n`);
        passed++;
      } else if (hasWrongMonth) {
        console.log(`   [FAIL] Muestra abril!\n`);
        failed++;
      } else {
        console.log(`   [WARN] No se pudo confirmar las fechas\n`);
        // Check deeper
        const bodySnippet = await gfPage.evaluate(() => {
          return document.body.innerText.substring(0, 500);
        });
        console.log(`   Body preview: ${bodySnippet.substring(0, 200)}\n`);
        failed++;
      }
    } catch (e) {
      console.log(`   [SKIP] Error: ${e.message}\n`);
    }
    await gfPage.close();
  }

  // Also verify all links use tfs= format (not ?q=)
  console.log('3. Verificando formato de URLs...');
  let urlPassed = 0;
  let urlFailed = 0;
  for (const link of links) {
    const hasTfs = link.href.includes('tfs=');
    const hasOldQ = link.href.includes('?q=flights');
    if (hasTfs && !hasOldQ) {
      urlPassed++;
    } else {
      urlFailed++;
      console.log(`   [FAIL] ${link.name}: usa formato viejo (?q=)`);
    }
  }
  console.log(`   ${urlPassed}/${links.length} usan formato tfs (protobuf)\n`);

  console.log(`=== RESULTADOS: ${passed} passed, ${failed} failed (de ${samples.length} links probados en Google Flights) ===`);
  console.log(`=== URLs: ${urlPassed}/${links.length} formato correcto ===`);

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
