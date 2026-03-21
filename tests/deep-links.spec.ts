import { test, expect } from '@playwright/test';

test.describe('checavuelos - Deep Links', () => {

  test('pagina carga datos del Worker', async ({ page }) => {
    await page.goto('/');
    // Esperar a que carguen datos (hero o no-data)
    await page.waitForSelector('#hero:not(.hidden), #no-data:not(.hidden)', { timeout: 10_000 });

    const noData = await page.$('#no-data:not(.hidden)');
    if (noData) {
      test.skip(true, 'No hay datos en el Worker todavia');
      return;
    }

    // Hero visible con precios MXN
    const heroText = await page.textContent('#hero-per-person');
    expect(heroText).toContain('MXN');
  });

  test('deep links de ida tienen fechas de septiembre 2026', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#hero:not(.hidden), #no-data:not(.hidden)', { timeout: 10_000 });

    const noData = await page.$('#no-data:not(.hidden)');
    if (noData) {
      test.skip(true, 'No hay datos');
      return;
    }

    // Revisar links en tabla de ida
    const links = await page.$$eval('#table-outbound tbody a.btn', els =>
      els.map(a => (a as HTMLAnchorElement).href)
    );

    expect(links.length).toBeGreaterThan(0);

    for (const link of links) {
      // Debe contener "2026-09" en la URL (septiembre 2026)
      expect(link).toMatch(/2026-09/);
      // No debe tener fechas de abril ni mayo
      expect(link).not.toMatch(/on\+2026-0[3-5]/);
    }
  });

  test('deep links de vuelta tienen fechas de octubre 2026', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#hero:not(.hidden), #no-data:not(.hidden)', { timeout: 10_000 });

    const noData = await page.$('#no-data:not(.hidden)');
    if (noData) {
      test.skip(true, 'No hay datos');
      return;
    }

    const links = await page.$$eval('#table-return tbody a.btn', els =>
      els.map(a => (a as HTMLAnchorElement).href)
    );

    expect(links.length).toBeGreaterThan(0);

    for (const link of links) {
      expect(link).toMatch(/2026-10/);
    }
  });

  test('precios se muestran en MXN', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#hero:not(.hidden), #no-data:not(.hidden)', { timeout: 10_000 });

    const noData = await page.$('#no-data:not(.hidden)');
    if (noData) {
      test.skip(true, 'No hay datos');
      return;
    }

    // Hero muestra MXN
    const perPerson = await page.textContent('#hero-per-person');
    expect(perPerson).toContain('MXN');

    const total = await page.textContent('#hero-total');
    expect(total).toContain('MXN');

    // Footer menciona MXN
    const footer = await page.textContent('footer');
    expect(footer).toContain('MXN');
  });

  test('pagina muestra contenido MXN', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('body');
    // Esperar que cargue el JS
    await page.waitForTimeout(3000);
    const body = await page.textContent('body');
    expect(body).toContain('MXN');
  });
});
