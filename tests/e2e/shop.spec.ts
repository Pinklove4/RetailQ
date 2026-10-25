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

  const saved = page.waitForResponse((response) =>
    response.url().endsWith('/api/cart') &&
    response.request().method() === 'PUT' &&
    response.ok());
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
