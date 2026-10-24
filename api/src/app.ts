import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://retailq:retailq@localhost:5432/retailq',
});

const secret = process.env.JWT_SECRET || 'local-development-only-change-me';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || secret.length < 32)) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters in production');
}

type UserClaims = JwtPayload & { id: number; role: string };
type AuthenticatedRequest = Request & { user: UserClaims };

export const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
});
app.use(cors({
  origin(origin, callback) {
    return callback(null, !origin || allowedOrigins.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '32kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again later.' },
});

const asyncRoute = (
  fn: (req: Request, res: Response) => Promise<unknown>,
) => (req: Request, res: Response, next: NextFunction) => {
  void Promise.resolve(fn(req, res)).catch(next);
};

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authorization = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const claims = jwt.verify(match[1], secret);
    if (typeof claims === 'string' || typeof claims.id !== 'number' || typeof claims.role !== 'string') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    (req as AuthenticatedRequest).user = claims as UserClaims;
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if ((req as AuthenticatedRequest).user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
};

const registerSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) });
const cartItemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
});
const validateUniqueItems = (items: CartItemInput[], context: z.RefinementCtx) => {
  const ids = items.map((item) => item.productId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate product', path: ['items'] });
  }
};
type CartItemInput = z.infer<typeof cartItemSchema>;
const cartSchema = z.object({
  items: z.array(cartItemSchema).max(100).superRefine(validateUniqueItems),
});
const checkoutSchema = z.object({
  items: z.array(cartItemSchema).min(1).max(100).superRefine(validateUniqueItems),
  promo: z.string().max(50).optional(),
  idempotencyKey: z.string().min(8).max(100),
});

const userId = (req: Request) => (req as AuthenticatedRequest).user.id;

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => {
  const taxBps = Number(process.env.TEST_TAX_BPS || 825);
  if (!Number.isSafeInteger(taxBps) || taxBps < 0 || taxBps > 10000) {
    return res.status(500).json({ error: 'Invalid tax configuration' });
  }
  return res.json({ tax_bps: taxBps });
});

app.post('/api/register', authLimiter, asyncRoute(async (req, res) => {
  const data = registerSchema.parse(req.body);
  const hash = await bcrypt.hash(data.password, 10);
  try {
    const result = await pool.query(
      'INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email',
      [data.email.toLowerCase(), hash],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    throw error;
  }
}));

app.post('/api/login', authLimiter, asyncRoute(async (req, res) => {
  const data = loginSchema.parse(req.body);
  const result = await pool.query('SELECT * FROM users WHERE email=$1', [data.email.toLowerCase()]);
  const account = result.rows[0];
  if (!account || !(await bcrypt.compare(data.password, account.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({
    token: jwt.sign({ id: account.id, role: account.role }, secret, { expiresIn: '2h' }),
  });
}));

app.get('/api/products', asyncRoute(async (req, res) => {
  const query = z.string().max(100).optional().default('').parse(req.query.q);
  const category = z.string().max(100).optional().default('').parse(req.query.category);
  const result = await pool.query(
    `SELECT * FROM products WHERE name ILIKE $1 AND ($2 = '' OR category=$2) ORDER BY id`,
    [`%${query}%`, category],
  );
  res.json(result.rows);
}));

app.get('/api/inventory', asyncRoute(async (_req, res) => {
  const result = await pool.query('SELECT id,name,inventory FROM products ORDER BY id');
  res.json(result.rows);
}));

app.get('/api/cart', authenticate, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT ci.product_id AS "productId", ci.quantity
     FROM cart_items ci JOIN carts c ON c.id=ci.cart_id
     WHERE c.user_id=$1 ORDER BY ci.product_id`,
    [userId(req)],
  );
  res.json({ items: result.rows });
}));

app.put('/api/cart', authenticate, asyncRoute(async (req, res) => {
  const data = cartSchema.parse(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productIds = data.items.map((item) => item.productId);
    if (productIds.length > 0) {
      const available = await client.query(
        'SELECT id,inventory FROM products WHERE id=ANY($1::int[])',
        [productIds],
      );
      if (available.rowCount !== productIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Unknown product' });
      }
      if (data.items.some((item) => {
        const product = available.rows.find((row) => row.id === item.productId);
        return product && item.quantity > product.inventory;
      })) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Insufficient inventory' });
      }
    }
    const cart = await client.query(
      `INSERT INTO carts(user_id) VALUES($1)
       ON CONFLICT(user_id) DO UPDATE SET updated_at=now()
       RETURNING id`,
      [userId(req)],
    );
    await client.query('DELETE FROM cart_items WHERE cart_id=$1', [cart.rows[0].id]);
    for (const item of data.items) {
      await client.query(
        'INSERT INTO cart_items(cart_id,product_id,quantity) VALUES($1,$2,$3)',
        [cart.rows[0].id, item.productId, item.quantity],
      );
    }
    await client.query('COMMIT');
    res.json({ items: data.items });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

export function totals(lines: { price: number; quantity: number }[], promo: string, taxBps: number) {
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const discount = promo === 'SAVE10' ? Math.floor(subtotal * 0.1) : 0;
  const tax = Math.round((subtotal - discount) * taxBps / 10000);
  return {
    subtotal_cents: subtotal,
    discount_cents: discount,
    tax_cents: tax,
    total_cents: subtotal - discount + tax,
  };
}

app.post('/api/orders', authenticate, asyncRoute(async (req, res) => {
  const data = checkoutSchema.parse(req.body);
  if (data.promo && data.promo !== 'SAVE10') return res.status(400).json({ error: 'Invalid promo' });
  const ids = data.items.map((item) => item.productId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${userId(req)}:${data.idempotencyKey}`],
    );
    const existing = await client.query(
      'SELECT order_id FROM idempotency_keys WHERE user_id=$1 AND key=$2',
      [userId(req), data.idempotencyKey],
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return res.status(200).json({ id: existing.rows[0].order_id, replayed: true });
    }
    const products = await client.query(
      'SELECT id,price_cents,inventory FROM products WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',
      [ids],
    );
    if (products.rowCount !== ids.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unknown product' });
    }
    const lines = data.items.map((item) => {
      const product = products.rows.find((row) => row.id === item.productId);
      return {
        id: item.productId,
        price: product.price_cents,
        quantity: item.quantity,
        inventory: product.inventory,
      };
    });
    if (lines.some((line) => line.quantity > line.inventory)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Insufficient inventory' });
    }
    const taxBps = Number(process.env.TEST_TAX_BPS || 825);
    if (!Number.isSafeInteger(taxBps) || taxBps < 0 || taxBps > 10000) {
      throw new Error('TEST_TAX_BPS must be an integer between 0 and 10000');
    }
    const amounts = totals(lines, data.promo || '', taxBps);
    const order = await client.query(
      `INSERT INTO orders(user_id,subtotal_cents,discount_cents,tax_cents,total_cents)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [userId(req), amounts.subtotal_cents, amounts.discount_cents, amounts.tax_cents, amounts.total_cents],
    );
    for (const line of lines) {
      await client.query('UPDATE products SET inventory=inventory-$1 WHERE id=$2', [line.quantity, line.id]);
      await client.query(
        'INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES($1,$2,$3,$4)',
        [order.rows[0].id, line.id, line.quantity, line.price],
      );
    }
    await client.query(
      'INSERT INTO idempotency_keys(user_id,key,order_id) VALUES($1,$2,$3)',
      [userId(req), data.idempotencyKey, order.rows[0].id],
    );
    await client.query('DELETE FROM cart_items WHERE cart_id=(SELECT id FROM carts WHERE user_id=$1)', [userId(req)]);
    await client.query('COMMIT');
    res.status(201).json(order.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/orders', authenticate, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC', [userId(req)]);
  res.json(result.rows);
}));

app.get('/api/quality', asyncRoute(async (_req, res) => {
  const [runs, defects] = await Promise.all([
    pool.query('SELECT * FROM test_runs ORDER BY id DESC LIMIT 50'),
    pool.query('SELECT * FROM defects ORDER BY id DESC'),
  ]);
  res.json({ runs: runs.rows, defects: defects.rows });
}));

app.post('/api/quality/runs', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const data = z.object({
    suite: z.string().trim().min(1).max(200),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    details: z.array(z.unknown()).max(1000).default([]),
  }).parse(req.body);
  const result = await pool.query(
    `INSERT INTO test_runs(suite,passed,failed,duration_ms,details)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [data.suite, data.passed, data.failed, data.duration_ms, JSON.stringify(data.details)],
  );
  res.status(201).json(result.rows[0]);
}));

app.post('/api/quality/defects', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const data = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
  }).parse(req.body);
  const result = await pool.query(
    'INSERT INTO defects(title,description) VALUES($1,$2) RETURNING *',
    [data.title, data.description],
  );
  res.status(201).json(result.rows[0]);
}));

app.patch('/api/quality/defects/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const data = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    status: z.enum(['open', 'in_progress', 'resolved']).optional(),
  }).refine((value) => Object.keys(value).length > 0).parse(req.body);
  const fields = Object.keys(data) as Array<keyof typeof data>;
  const values = fields.map((field) => data[field]);
  const assignments = fields.map((field, index) => `${field}=$${index + 1}`).join(', ');
  const result = await pool.query(
    `UPDATE defects SET ${assignments} WHERE id=$${fields.length + 1} RETURNING *`,
    [...values, id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Defect not found' });
  res.json(result.rows[0]);
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation failed', issues: error.issues });
  }
  console.error(error);
  return res.status(500).json({ error: 'Internal server error' });
});
