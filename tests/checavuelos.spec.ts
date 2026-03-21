import { test, expect } from '@playwright/test';

const LIVE_URL = 'https://vicentedomus.github.io/checavuelos/';
const WORKER_URL = 'https://checavuelos-api.vichomiguel.workers.dev';

test.describe('checavuelos — validacion completa', () => {

  test('1. Pagina carga y muestra datos', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    // Nav visible
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('nav')).toContainText('checavuelos');
    // Hero con precios
    const hero = page.locator('#hero');
    await expect(hero).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#hero-per-person')).not.toHaveText('-');
    await expect(page.locator('#hero-per-person')).toContainText('MXN');
  });

  test('2. Boton Actualizar existe en nav', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    const btn = page.locator('#btn-refresh');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Actualizar');
  });

  test('3. Tablas tienen datos y botones Kayak', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    // Tabla ida
    const idaRows = page.locator('#table-outbound tbody tr');
    await expect(idaRows.first()).toBeVisible({ timeout: 10000 });
    const idaCount = await idaRows.count();
    expect(idaCount).toBeGreaterThan(0);
    // Tabla vuelta
    const vueltaRows = page.locator('#table-return tbody tr');
    expect(await vueltaRows.count()).toBeGreaterThan(0);
    // Tabla RT
    const rtRows = page.locator('#table-roundtrip tbody tr');
    expect(await rtRows.count()).toBeGreaterThan(0);
    // Botones Kayak existen en tablas
    const kayakBtns = page.locator('a.btn-kayak');
    expect(await kayakBtns.count()).toBeGreaterThan(0);
  });

  test('4. Links Kayak ida tienen formato one-way correcto (sept 2026)', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    const kayakLinks = page.locator('#table-outbound a.btn-kayak');
    await expect(kayakLinks.first()).toBeVisible({ timeout: 10000 });
    const count = await kayakLinks.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const href = await kayakLinks.nth(i).getAttribute('href');
      expect(href).toBeTruthy();
      // Format: https://www.kayak.com.mx/flights/XXX-YYY/2026-09-XX?sort=bestflight_a
      expect(href).toContain('kayak.com.mx/flights/');
      expect(href).toContain('/2026-09-');
      expect(href).toContain('?sort=bestflight_a');
      // Must be one-way (only 1 date, no second slash-date)
      const pathPart = href!.split('flights/')[1].split('?')[0];
      const segments = pathPart.split('/');
      expect(segments).toHaveLength(2); // "MID-CDG" + "2026-09-XX" (no third segment = one-way)
    }
  });

  test('5. Links Kayak vuelta tienen formato one-way correcto (oct 2026)', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    const kayakLinks = page.locator('#table-return a.btn-kayak');
    await expect(kayakLinks.first()).toBeVisible({ timeout: 10000 });
    const count = await kayakLinks.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const href = await kayakLinks.nth(i).getAttribute('href');
      expect(href).toContain('kayak.com.mx/flights/');
      expect(href).toContain('/2026-10-');
      // One-way: 2 segments only
      const pathPart = href!.split('flights/')[1].split('?')[0];
      expect(pathPart.split('/')).toHaveLength(2);
    }
  });

  test('6. Links Kayak RT tienen formato round-trip (sept+oct 2026)', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    const kayakLinks = page.locator('#table-roundtrip a.btn-kayak');
    await expect(kayakLinks.first()).toBeVisible({ timeout: 10000 });
    const count = await kayakLinks.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const href = await kayakLinks.nth(i).getAttribute('href');
      expect(href).toContain('kayak.com.mx/flights/');
      // RT format: 3 segments "MID-CDG/2026-09-XX/2026-10-12"
      const pathPart = href!.split('flights/')[1].split('?')[0];
      const segments = pathPart.split('/');
      expect(segments).toHaveLength(3);
      expect(segments[1]).toMatch(/^2026-09-/);
      expect(segments[2]).toMatch(/^2026-10-/);
    }
  });

  test('7. Ningun precio es $0 en las tablas', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    const priceCells = page.locator('td.price');
    const count = await priceCells.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const text = await priceCells.nth(i).textContent();
      expect(text).not.toBe('$0');
    }
  });

  test('8. Worker API /api/latest responde con kayak_link', async ({ request }) => {
    const res = await request.get(`${WORKER_URL}/api/latest`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.outbound.length).toBeGreaterThan(0);
    expect(data.returns.length).toBeGreaterThan(0);
    expect(data.roundtrips.length).toBeGreaterThan(0);
    // kayak_link present
    expect(data.outbound[0].kayak_link).toContain('kayak.com.mx');
    expect(data.returns[0].kayak_link).toContain('kayak.com.mx');
    expect(data.roundtrips[0].kayak_link).toContain('kayak.com.mx');
    // No zero prices
    for (const f of data.outbound) expect(f.price_usd).toBeGreaterThan(0);
    for (const f of data.returns) expect(f.price_usd).toBeGreaterThan(0);
  });

  test('9. Worker API /api/refresh responde con cooldown', async ({ request }) => {
    // Should be in cooldown from our earlier refresh
    const res = await request.get(`${WORKER_URL}/api/refresh?key=checavuelos2026`);
    // Either 200 (fresh data) or 429 (cooldown) — both are valid
    expect([200, 429]).toContain(res.status());
    const data = await res.json();
    if (res.status() === 429) {
      expect(data.status).toBe('cooldown');
      expect(data.hours_left).toBeDefined();
    }
  });

  test('10. Link Kayak ida abre con fecha correcta (sept 2026)', async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });
    const firstKayak = page.locator('#table-outbound a.btn-kayak').first();
    await expect(firstKayak).toBeVisible({ timeout: 10000 });
    const href = await firstKayak.getAttribute('href');
    // Navigate to Kayak and check the page loads with correct route
    await page.goto(href!, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    // Check URL still contains our date
    const finalUrl = page.url();
    expect(finalUrl).toContain('kayak');
    // Take screenshot for visual verification
    await page.screenshot({ path: 'tests/kayak-ida-test.png', fullPage: false });
    // Check page content for September 2026
    const pageText = await page.textContent('body');
    const hasSept = pageText?.includes('sept') || pageText?.includes('Sep') || pageText?.includes('SEP');
    expect(hasSept).toBeTruthy();
  });
});
