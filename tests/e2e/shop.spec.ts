import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures/shop.js';

test('catalog search and cart show server-priced totals', async ({ page, shop }) => {
  await shop.search('Apples');
  await expect(page.locator('.product')).toHaveCount(1);
  await shop.add('Honeycrisp Apples');
  await expect(page.locator('.grand')).toContainText('$3.24');
});

test('category filter narrows the visible products', async ({ page, shop }) => {
  await shop.filterCategory('Dairy');
  await expect(page.locator('.product')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Organic Milk' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Honeycrisp Apples' })).toHaveCount(0);
});

test('invalid login displays an actionable API response', async ({ shop }) => {
  await shop.login(`missing-${randomUUID()}@example.test`, 'wrong-password');
  await expect(shop.status).toContainText('Invalid credentials');
});

test('signed-in basket persists after a page reload', async ({ page, shop }) => {
  const email = `browser-${randomUUID()}@example.test`;
  const password = `test-${randomUUID()}`;
  await shop.register(email, password);
  await shop.login(email, password, true);
  await expect(shop.status).toContainText('Signed in');

  const saved = page.waitForResponse(async (response) => {
    if (!response.url().endsWith('/api/cart') ||
      response.request().method() !== 'PUT' ||
      !response.ok()) return false;
    const body = await response.json() as { items?: Array<{ quantity: number }> };
    return body.items?.length === 1 && body.items[0].quantity === 1;
  });
  await shop.add('Honeycrisp Apples');
  await saved;
  await page.reload();
  await expect(page.locator('.cart-line')).toContainText('Honeycrisp Apples');
  await expect(page.getByRole('heading', { name: 'Your basket 1' })).toBeVisible();
});

test('customer can place a simulated order and see its order history', async ({ page, shop }) => {
  const email = `checkout-${randomUUID()}@example.test`;
  const password = `test-${randomUUID()}`;
  await shop.register(email, password);
  await shop.login(email, password, true);
  await expect(shop.status).toContainText('Signed in');
  await shop.add('Honeycrisp Apples');
  await shop.applyPromo('SAVE10');
  await shop.checkout();

  await expect(shop.status).toContainText('placed successfully');
  await expect(page.getByRole('heading', { name: 'Order history' })).toBeVisible();
  await expect(page.locator('.record')).toContainText('$2.92');
});

test('guest basket persists after a reload', async ({ page, shop }) => {
  await shop.add('Honeycrisp Apples');
  await expect(page.locator('.cart-line')).toContainText('Honeycrisp Apples');
  await expect.poll(() => page.evaluate(() => {
    const cart = JSON.parse(localStorage.getItem('cart') || '{}') as Record<string, number>;
    return Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  })).toBe(1);
  await page.reload();
  await expect(page.locator('.cart-line')).toContainText('Honeycrisp Apples');
  await expect(page.getByRole('heading', { name: 'Your basket 1' })).toBeVisible();
});

test('guest checkout is blocked without clearing the basket', async ({ page, shop }) => {
  await shop.add('Honeycrisp Apples');
  await shop.checkout();
  await expect(shop.status).toContainText('Sign in to checkout');
  await expect(page.locator('.cart-line')).toContainText('Honeycrisp Apples');
});

test('invalid promotion is rejected and preserves the basket', async ({ page, shop }) => {
  const email = `invalid-promo-${randomUUID()}@example.test`;
  const password = `test-${randomUUID()}`;
  await shop.register(email, password);
  await shop.login(email, password, true);
  await expect(shop.status).toContainText('Signed in');
  await shop.add('Honeycrisp Apples');
  await shop.applyPromo('NOT-VALID');
  await shop.checkout();

  await expect(shop.status).toContainText('Invalid promo');
  await expect(page.locator('.cart-line')).toContainText('Honeycrisp Apples');
  await expect(page.getByRole('heading', { name: 'Your basket 1' })).toBeVisible();
});

test('storefront fits a narrow mobile viewport without horizontal overflow', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Explore the market' })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await expect(page.getByRole('button', { name: 'Place test order' })).toBeVisible();
});
