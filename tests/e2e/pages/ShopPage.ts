import { expect, type Locator, type Page } from '@playwright/test';

export class ShopPage {
  readonly status: Locator;

  constructor(readonly page: Page) {
    this.status = page.getByRole('status');
  }

  async open() {
    await this.page.goto('/');
    await expect(this.page.getByRole('heading', { name: 'Explore the market' })).toBeVisible();
  }

  async search(query: string) {
    await this.page.getByRole('textbox', { name: 'Search products' }).fill(query);
  }

  async filterCategory(category: string) {
    await this.page.getByRole('combobox', { name: 'Category' }).selectOption(category);
  }

  async add(productName: string) {
    await this.page.getByRole('button', { name: `Add ${productName}`, exact: true }).click();
  }

  async applyPromo(code: string) {
    await this.page.getByRole('textbox', { name: 'Promo code' }).fill(code);
  }

  async register(email: string, password: string) {
    await this.page.getByRole('textbox', { name: 'Email' }).fill(email);
    await this.page.getByRole('textbox', { name: 'Password' }).fill(password);
    await this.page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(this.status).toContainText('Account created');
  }

  async login(email: string, password: string, waitForBasket = false) {
    await this.page.getByRole('textbox', { name: 'Email' }).fill(email);
    await this.page.getByRole('textbox', { name: 'Password' }).fill(password);
    const cartLoaded = waitForBasket
      ? this.page.waitForResponse((response) =>
        response.url().endsWith('/api/cart') &&
        response.request().method() === 'GET' &&
        response.ok())
      : undefined;
    await this.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await cartLoaded;
  }

  async checkout() {
    await this.page.getByRole('button', { name: 'Place test order' }).click();
  }

  product(name: string) {
    return this.page.locator('.product').filter({ has: this.page.getByRole('heading', { name }) });
  }
}
