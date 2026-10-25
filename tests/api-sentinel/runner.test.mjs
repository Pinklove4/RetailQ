import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { runSuite } from './runner.mjs';

let server;
let baseUrl;
let contractCart = [];
let contractOrder;
const contractIdempotency = new Map();

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

before(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'x-contract': 'retailq' });
      response.end(JSON.stringify({ ok: true, count: 3 }));
      return;
    }
    if (request.url === '/api/empty') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/api/config') {
      sendJson(response, 200, { tax_bps: 825 });
      return;
    }
    if (request.url === '/api/products') {
      sendJson(response, 200, [{
        id: 7,
        name: 'Fixture Apples',
        category: 'Produce',
        price_cents: 299,
        inventory: 10,
        image_url: 'https://example.test/apples.jpg',
      }]);
      return;
    }
    if (request.url === '/api/register' && request.method === 'POST') {
      const user = await readJson(request);
      if (!user.email.includes('@')) {
        sendJson(response, 400, { error: 'Validation failed' });
        return;
      }
      sendJson(response, 201, { id: 11, email: user.email });
      return;
    }
    if (request.url === '/api/login' && request.method === 'POST') {
      sendJson(response, 200, { token: 'fixture-token' });
      return;
    }
    if (request.url === '/api/cart') {
      if (request.headers.authorization !== 'Bearer fixture-token') {
        sendJson(response, 401, { error: 'Unauthorized' });
      } else if (request.method === 'PUT') {
        contractCart = (await readJson(request)).items;
        sendJson(response, 200, { items: contractCart });
      } else {
        sendJson(response, 200, { items: contractCart });
      }
      return;
    }
    if (request.url === '/api/orders' && request.method === 'POST') {
      const order = await readJson(request);
      if (order.promo !== 'SAVE10') {
        sendJson(response, 400, { error: 'Invalid promo' });
        return;
      }
      if (contractIdempotency.has(order.idempotencyKey)) {
        sendJson(response, 200, { id: contractIdempotency.get(order.idempotencyKey), replayed: true });
        return;
      }
      contractOrder = {
        id: 19,
        subtotal_cents: 299,
        discount_cents: 29,
        tax_cents: 22,
        total_cents: 292,
      };
      contractIdempotency.set(order.idempotencyKey, contractOrder.id);
      contractCart = [];
      sendJson(response, 201, contractOrder);
      return;
    }
    if (request.url === '/api/orders' && request.method === 'GET') {
      sendJson(response, 200, contractOrder ? [contractOrder] : []);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('runs schema, typed capture, equality, and response-header checks', async () => {
  const result = await runSuite({
    tests: [{
      name: 'health',
      path: 'health',
      status: 200,
      schema: { type: 'object', required: ['ok', 'count'], properties: { ok: { const: true }, count: { type: 'integer' } } },
      equals: { count: 3 },
      responseHeaders: { 'x-contract': 'retailq' },
      capture: { count: 'count' },
    }, {
      name: 'typed capture remains numeric',
      path: 'health',
      status: 200,
      equals: { count: '{{count}}' },
    }],
  }, { baseUrl });
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 0);
});

test('rejects cross-origin request paths without making the request', async () => {
  const result = await runSuite({
    tests: [{ name: 'cross-origin', path: 'https://example.com/api/health', status: 200 }],
  }, { baseUrl });
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /Cross-origin/);
});

test('reports non-JSON responses as failed contracts', async () => {
  const result = await runSuite({
    tests: [{ name: 'empty body', path: 'empty', status: 204 }],
  }, { baseUrl });
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].name, 'empty body');
});

test('rejects HTTP base URLs outside the configured API path', async () => {
  const result = await runSuite({
    tests: [{ name: 'path escape', path: '../health', status: 200 }],
  }, { baseUrl });
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /escapes/);
});

test('times out a stalled HTTP request and closes the test server', async () => {
  const stalled = createServer(() => {});
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSuite({
      tests: [{ name: 'stalled endpoint', path: '/', status: 200, timeoutMs: 25 }],
    }, { baseUrl: `http://127.0.0.1:${stalled.address().port}` });
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].error, 'Request timed out.');
  } finally {
    stalled.closeAllConnections();
    await new Promise((resolve, reject) => stalled.close((error) => error ? reject(error) : resolve()));
  }
});

test('RetailQ API Sentinel suite covers the complete customer checkout flow', async () => {
  contractCart = [];
  contractOrder = undefined;
  contractIdempotency.clear();
  const suite = JSON.parse(
    await readFile(resolve('tests/api-sentinel/retailq.json'), 'utf8'),
  );
  const result = await runSuite(suite, {
    baseUrl,
    variables: {
      email: 'sentinel@example.test',
      password: 'contract-password',
      idempotencyKey: 'sentinel-run-1234',
    },
  });
  assert.equal(result.passed, suite.tests.length, JSON.stringify(result.results.filter((item) => item.status === 'failed')));
  assert.equal(result.failed, 0);
});
