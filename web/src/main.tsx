import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const API = '/api';
type Product = {
  id: number;
  name: string;
  category: string;
  price_cents: number;
  inventory: number;
  image_url: string;
};
type CartItem = { productId: number; quantity: number };
type Run = {
  id: number;
  suite: string;
  passed: number;
  failed: number;
  duration_ms: number;
  created_at: string;
  details: unknown[];
};
type Defect = { id: number; title: string; description: string; status: string };
type Quality = { runs: Run[]; defects: Defect[] };
type Order = { id: number; total_cents: number; created_at: string };
type ApiError = { error?: string };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API + path, init);
  const body = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState<Record<number, number>>(() => {
    const stored = localStorage.getItem('cart');
    return stored ? JSON.parse(stored) as Record<number, number> : {};
  });
  const [cartLoaded, setCartLoaded] = useState(!localStorage.getItem('token'));
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [promo, setPromo] = useState('');
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState('shop');
  const [orders, setOrders] = useState<Order[]>([]);
  const [quality, setQuality] = useState<Quality>({ runs: [], defects: [] });
  const [taxBps, setTaxBps] = useState(825);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [defectTitle, setDefectTitle] = useState('');
  const [defectDescription, setDefectDescription] = useState('');

  const authHeaders = { Authorization: `Bearer ${token}` };
  const reloadProducts = async () => {
    try {
      setProducts(await requestJson<Product[]>('/products'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load products');
    }
  };

  const reloadQuality = async () => {
    try {
      setQuality(await requestJson<Quality>('/quality'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load quality records');
    }
  };

  useEffect(() => {
    void reloadProducts();
    void requestJson<{ tax_bps: number }>('/config')
      .then((config) => setTaxBps(config.tax_bps))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Unable to load store settings'));
  }, []);

  useEffect(() => {
    if (!token) {
      setCartLoaded(true);
      return;
    }
    let cancelled = false;
    setCartLoaded(false);
    void requestJson<{ items: CartItem[] }>('/cart', { headers: authHeaders })
      .then(({ items }) => {
        if (!cancelled) {
          setCart(Object.fromEntries(items.map(({ productId, quantity }) => [productId, quantity])));
          setCartLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : 'Unable to load your saved basket');
          setCartLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!cartLoaded) return;
    localStorage.setItem('cart', JSON.stringify(cart));
    if (token) {
      void requestJson('/cart', {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: Object.entries(cart)
            .filter(([, quantity]) => quantity > 0)
            .map(([productId, quantity]) => ({ productId: Number(productId), quantity })),
        }),
      }).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Unable to save your basket');
      });
    }
  }, [cart, token, cartLoaded]);

  useEffect(() => {
    if (tab === 'quality') void reloadQuality();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'orders' || !token) return;
    void requestJson<Order[]>('/orders', { headers: authHeaders })
      .then(setOrders)
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Unable to load orders'));
  }, [tab, token]);

  async function login(register = false) {
    try {
      const result = await requestJson<{ token: string }>(register ? '/register' : '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (register) {
        setMessage('Account created. Please sign in.');
        return;
      }

      const newToken = result.token;
      const serverCart = await requestJson<{ items: CartItem[] }>('/cart', {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      const nextCart = Object.fromEntries(serverCart.items.map(({ productId, quantity }) => [productId, quantity]));
      const localItems = Object.entries(cart).filter(([, quantity]) => quantity > 0);
      for (const [rawId, quantity] of localItems) {
        const productId = Number(rawId);
        const product = products.find((item) => item.id === productId);
        const maxQuantity = product?.inventory ?? quantity;
        nextCart[productId] = Math.min(maxQuantity, (nextCart[productId] || 0) + quantity);
      }
      const items = Object.entries(nextCart).map(([productId, quantity]) => ({
        productId: Number(productId),
        quantity,
      }));
      await requestJson('/cart', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${newToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      setCart(nextCart);
      setToken(newToken);
      localStorage.setItem('token', newToken);
      setMessage('Signed in');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sign-in failed');
    }
  }

  async function checkout() {
    if (!token) {
      setMessage('Sign in to checkout');
      return;
    }
    const items = Object.entries(cart)
      .filter(([, quantity]) => quantity > 0)
      .map(([productId, quantity]) => ({ productId: Number(productId), quantity }));
    if (!items.length) return;
    setCheckoutPending(true);
    try {
      const order = await requestJson<Order>('/orders', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, promo, idempotencyKey }),
      });
      setMessage(`Order #${order.id} placed successfully`);
      setCart({});
      setIdempotencyKey(crypto.randomUUID());
      await reloadProducts();
      setTab('orders');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Checkout failed');
    } finally {
      setCheckoutPending(false);
    }
  }

  async function createDefect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await requestJson('/quality/defects', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: defectTitle, description: defectDescription }),
      });
      setDefectTitle('');
      setDefectDescription('');
      setMessage('Defect recorded');
      await reloadQuality();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to create defect');
    }
  }

  async function updateDefect(defect: Defect, status: string) {
    try {
      await requestJson(`/quality/defects/${defect.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await reloadQuality();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update defect');
    }
  }

  const visible = products.filter((product) =>
    product.name.toLowerCase().includes(search.toLowerCase()) &&
    (!category || product.category === category));
  const subtotal = products.reduce(
    (sum, product) => sum + product.price_cents * (cart[product.id] || 0),
    0,
  );
  const discount = promo === 'SAVE10' ? Math.floor(subtotal * 0.1) : 0;
  const tax = Math.round((subtotal - discount) * taxBps / 10000);
  const money = (value: number) => `$${(value / 100).toFixed(2)}`;
  const cartCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  const testCount = quality.runs.reduce((sum, run) => sum + run.passed + run.failed, 0);
  const passedCount = quality.runs.reduce((sum, run) => sum + run.passed, 0);

  return (
    <>
      <header>
        <div className="brand">◈ Retail<span>Q</span><small>QUALITY ENGINEERING LAB</small></div>
        <nav>
          {['shop', 'orders', 'quality'].map((name) => (
            <button className={tab === name ? 'active' : ''} onClick={() => setTab(name)} key={name}>
              {name === 'quality' ? 'Quality dashboard' : name === 'orders' ? 'Orders' : 'Shop'}
            </button>
          ))}
        </nav>
        <div className="user">
          {token
            ? <button onClick={() => {
              setToken('');
              localStorage.removeItem('token');
              setMessage('Signed out');
            }}>Sign out</button>
            : <span>Guest session</span>}
        </div>
      </header>
      <main>
        {message && <div className="notice" role="status">{message}<button onClick={() => setMessage('')}>×</button></div>}
        {tab === 'shop' && (
          <>
            <section className="hero">
              <div className="eyebrow">RETAIL ENGINEERING · END-TO-END QUALITY</div>
              <h1>Fresh groceries.<br /><em>Verified quality.</em></h1>
              <p>A real transactional grocery storefront built to validate every step from product discovery to checkout.</p>
              <div className="hero-tags"><span>● Live inventory</span><span>● Secure checkout</span><span>● Automated validation</span></div>
            </section>
            <div className="layout">
              <section>
                <div className="section-head">
                  <div><h2>Explore the market</h2><p>Curated essentials for everyday living</p></div>
                  <b>{visible.length} products</b>
                </div>
                <div className="filters">
                  <input aria-label="Search products" placeholder="Search products..." value={search} onChange={(event) => setSearch(event.target.value)} />
                  <select aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
                    <option value="">All categories</option>
                    {[...new Set(products.map((product) => product.category))].map((name) => <option key={name}>{name}</option>)}
                  </select>
                </div>
                <div className="products">
                  {visible.map((product) => (
                    <article className="product" key={product.id}>
                      <div className="photo"><img src={product.image_url} alt={product.name} /></div>
                      <div className="product-info">
                        <span className="category">{product.category}</span>
                        <h3>{product.name}</h3>
                        <p className="stock">{product.inventory} in stock</p>
                        <div className="buy">
                          <strong>{money(product.price_cents)}</strong>
                          <button
                            disabled={!product.inventory || (cart[product.id] || 0) >= product.inventory}
                            aria-label={`Add ${product.name}`}
                            onClick={() => setCart({ ...cart, [product.id]: (cart[product.id] || 0) + 1 })}
                          >+ Add</button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              <aside>
                <div className="panel">
                  <h2>Your basket <span>{cartCount}</span></h2>
                  {products.filter((product) => cart[product.id]).map((product) => (
                    <div className="cart-line" key={product.id}>
                      <div><b>{product.name}</b><small>{money(product.price_cents)}</small></div>
                      <div className="qty">
                        <button aria-label={`Remove one ${product.name}`} onClick={() => setCart({ ...cart, [product.id]: Math.max(0, cart[product.id] - 1) })}>−</button>
                        {cart[product.id]}
                        <button aria-label={`Add one ${product.name}`} disabled={cart[product.id] >= product.inventory} onClick={() => setCart({ ...cart, [product.id]: Math.min(product.inventory, cart[product.id] + 1) })}>+</button>
                      </div>
                    </div>
                  ))}
                  {!cartCount && <p className="empty">Your basket is empty. Add something fresh.</p>}
                  <label>Promo code<input aria-label="Promo code" placeholder="Try SAVE10" value={promo} onChange={(event) => setPromo(event.target.value)} /></label>
                  <div className="totals">
                    <p>Subtotal <b>{money(subtotal)}</b></p>
                    <p>Discount <b>−{money(discount)}</b></p>
                    <p>Estimated tax ({(taxBps / 100).toFixed(2)}%) <b>{money(tax)}</b></p>
                    <p className="grand">Total <b>{money(subtotal - discount + tax)}</b></p>
                  </div>
                  <button className="checkout" onClick={() => void checkout()} disabled={!subtotal || checkoutPending}>
                    {checkoutPending ? 'Placing order…' : 'Place test order →'}
                  </button>
                  <small className="safe">Simulated payment · No charges</small>
                </div>
                {!token && (
                  <div className="panel auth">
                    <h3>Account access</h3>
                    <input aria-label="Email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
                    <input aria-label="Password" type="password" placeholder="Password (8+ characters)" value={password} onChange={(event) => setPassword(event.target.value)} />
                    <div className="auth-actions">
                      <button onClick={() => void login()}>Sign in</button>
                      <button onClick={() => void login(true)}>Register</button>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
        {tab === 'orders' && (
          <section className="content">
            <h1>Order history</h1>
            {!token ? <p>Sign in to view your orders.</p> : orders.length
              ? orders.map((order) => (
                <div className="record" key={order.id}>
                  Order #{order.id} <b>{money(order.total_cents)}</b>
                  <small>{new Date(order.created_at).toLocaleString()}</small>
                </div>
              ))
              : <p>No orders yet.</p>}
          </section>
        )}
        {tab === 'quality' && (
          <section className="content">
            <div className="eyebrow">LIVE EXECUTION DATA</div>
            <h1>Quality intelligence</h1>
            <p>Metrics are loaded from persisted test execution records. No seeded pass statistics.</p>
            <div className="stats">
              <div><span>Recorded tests</span><strong>{testCount}</strong></div>
              <div><span>Passed</span><strong>{passedCount}</strong></div>
              <div><span>Failed</span><strong>{testCount - passedCount}</strong></div>
              <div><span>Pass rate</span><strong>{testCount ? `${(100 * passedCount / testCount).toFixed(1)}%` : 'N/A'}</strong></div>
            </div>
            <h2>Execution history</h2>
            {quality.runs.length
              ? quality.runs.map((run) => (
                <div className="record" key={run.id}>
                  <b>{run.suite}</b>
                  <span>{run.passed} passed · {run.failed} failed · {(run.duration_ms / 1000).toFixed(2)}s</span>
                  <small>{new Date(run.created_at).toLocaleString()}</small>
                  <details><summary>Failure details / artifacts</summary><pre>{JSON.stringify(run.details, null, 2)}</pre></details>
                </div>
              ))
              : <p>No executions ingested yet. Run tests and ingest the JSON report to populate this dashboard.</p>}
            <h2>Defect register</h2>
            {quality.defects.length
              ? quality.defects.map((defect) => (
                <div className="record" key={defect.id}>
                  <b>{defect.title}</b>
                  <span>{defect.description}</span>
                  <label>Status
                    <select value={defect.status} onChange={(event) => void updateDefect(defect, event.target.value)}>
                      <option value="open">Open</option>
                      <option value="in_progress">In progress</option>
                      <option value="resolved">Resolved</option>
                    </select>
                  </label>
                </div>
              ))
              : <p>No defects recorded.</p>}
            {token && (
              <form className="panel auth" onSubmit={(event) => void createDefect(event)}>
                <h3>Record a defect (admin)</h3>
                <input aria-label="Defect title" placeholder="Title" value={defectTitle} onChange={(event) => setDefectTitle(event.target.value)} required />
                <textarea aria-label="Defect description" placeholder="Description" value={defectDescription} onChange={(event) => setDefectDescription(event.target.value)} required />
                <button type="submit">Create defect</button>
              </form>
            )}
          </section>
        )}
      </main>
      <footer>RETAILQ / SOFTWARE QUALITY ENGINEERING PORTFOLIO <span>Independent demonstration project · Not affiliated with any retailer</span></footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
