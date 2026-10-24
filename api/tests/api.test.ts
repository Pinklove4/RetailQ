import {afterAll,beforeAll,describe,it,expect} from 'vitest';import {randomUUID} from 'node:crypto';import request from 'supertest';import {app,pool,totals} from '../src/app.js';
describe('pricing unit tests',()=>{it('applies discount before tax',()=>expect(totals([{price:1000,quantity:2}],'SAVE10',825)).toEqual({subtotal_cents:2000,discount_cents:200,tax_cents:149,total_cents:1949}));it('rounds tax to nearest cent',()=>expect(totals([{price:99,quantity:1}],'',825).tax_cents).toBe(8));});
describe('HTTP validation',()=>{it('health endpoint',async()=>{const r=await request(app).get('/api/health');expect(r.status).toBe(200);expect(r.body.ok).toBe(true);expect(r.headers['x-content-type-options']).toBe('nosniff');expect(r.headers['x-powered-by']).toBeUndefined()});it('returns the configured tax rate',async()=>{const r=await request(app).get('/api/config');expect(r.status).toBe(200);expect(r.body.tax_bps).toBe(Number(process.env.TEST_TAX_BPS||825))});it('rejects unauthenticated order',async()=>{const r=await request(app).post('/api/orders').send({});expect(r.status).toBe(401)});it('rejects unauthenticated cart access',async()=>{const r=await request(app).get('/api/cart');expect(r.status).toBe(401)});it('rejects invalid registration payload',async()=>{const r=await request(app).post('/api/register').send({email:'bad',password:'short'});expect(r.status).toBe(400)});it('rejects malformed product filters',async()=>{const r=await request(app).get('/api/products?q=a&q=b');expect(r.status).toBe(400)});});

const runDatabaseTests = process.env.RUN_DB_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
describe.skipIf(!runDatabaseTests)('concurrent checkout integration', () => {
  const suffix = randomUUID();
  const password = `retailq-${randomUUID()}`;
  const createdUsers: number[] = [];
  let productId: number;
  let originalInventory: number;
  let firstToken: string;
  let secondToken: string;

  async function register(email: string) {
    const result = await request(app).post('/api/register').send({ email, password });
    expect(result.status).toBe(201);
    createdUsers.push(result.body.id);
    const login = await request(app).post('/api/login').send({ email, password });
    expect(login.status).toBe(200);
    return login.body.token as string;
  }

  beforeAll(async () => {
    const product = await pool.query('SELECT id,inventory FROM products ORDER BY id LIMIT 1');
    if (!product.rowCount) throw new Error('Concurrency tests require at least one seeded product');
    productId = product.rows[0].id;
    originalInventory = product.rows[0].inventory;
    await pool.query('UPDATE products SET inventory=1 WHERE id=$1', [productId]);
    firstToken = await register(`checkout-one-${suffix}@example.test`);
    secondToken = await register(`checkout-two-${suffix}@example.test`);
  });

  afterAll(async () => {
    if (!productId) return;
    await pool.query(
      `DELETE FROM order_items WHERE order_id IN
       (SELECT id FROM orders WHERE user_id=ANY($1::int[]))`,
      [createdUsers],
    );
    await pool.query('DELETE FROM idempotency_keys WHERE user_id=ANY($1::int[])', [createdUsers]);
    await pool.query('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id=ANY($1::int[]))', [createdUsers]);
    await pool.query('DELETE FROM carts WHERE user_id=ANY($1::int[])', [createdUsers]);
    await pool.query('DELETE FROM orders WHERE user_id=ANY($1::int[])', [createdUsers]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::int[])', [createdUsers]);
    await pool.query('UPDATE products SET inventory=$1 WHERE id=$2', [originalInventory, productId]);
    await pool.end();
  });

  it('replays concurrent submissions with the same idempotency key', async () => {
    await pool.query('UPDATE products SET inventory=1 WHERE id=$1', [productId]);
    const payload = {
      items: [{ productId, quantity: 1 }],
      idempotencyKey: `same-${suffix}`,
    };
    const responses = await Promise.all([
      request(app).post('/api/orders').set('Authorization', `Bearer ${firstToken}`).send(payload),
      request(app).post('/api/orders').set('Authorization', `Bearer ${firstToken}`).send(payload),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(responses.filter((response) => response.body.replayed)).toHaveLength(1);
    const inventory = await pool.query('SELECT inventory FROM products WHERE id=$1', [productId]);
    expect(inventory.rows[0].inventory).toBe(0);
  });

  it('does not oversell when different customers check out concurrently', async () => {
    await pool.query('UPDATE products SET inventory=1 WHERE id=$1', [productId]);
    const responses = await Promise.all([
      request(app).post('/api/orders').set('Authorization', `Bearer ${firstToken}`).send({
        items: [{ productId, quantity: 1 }],
        idempotencyKey: `buyer-one-${suffix}`,
      }),
      request(app).post('/api/orders').set('Authorization', `Bearer ${secondToken}`).send({
        items: [{ productId, quantity: 1 }],
        idempotencyKey: `buyer-two-${suffix}`,
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const inventory = await pool.query('SELECT inventory FROM products WHERE id=$1', [productId]);
    expect(inventory.rows[0].inventory).toBe(0);
  });
});
