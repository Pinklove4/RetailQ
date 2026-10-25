import { test as base, expect } from '@playwright/test';
import { ShopPage } from '../pages/ShopPage.js';

export const test = base.extend<{ shop: ShopPage }>({
  shop: async ({ page }, use) => {
    const shop = new ShopPage(page);
    await shop.open();
    await use(shop);
  },
});

export { expect };
