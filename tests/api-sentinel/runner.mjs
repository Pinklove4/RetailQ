import Ajv from 'ajv';
import { isDeepStrictEqual } from 'node:util';

const ajv = new Ajv({ allErrors: true, strict: true });

function at(value, path) {
  return path === '' ? value : path.split('.').reduce((current, key) => current?.[key], value);
}

function expand(value, variables) {
  if (typeof value === 'string') {
    const exact = /^\{\{([\w]+)\}\}$/.exec(value);
    if (exact) {
      if (!(exact[1] in variables)) throw new Error(`Missing variable: ${exact[1]}`);
      return variables[exact[1]];
    }
    return value.replace(/\{\{([\w]+)\}\}/g, (_match, key) => {
      if (!(key in variables)) throw new Error(`Missing variable: ${key}`);
      return String(variables[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expand(item, variables)]),
    );
  }
  return value;
}

export async function runSuite(suite, { baseUrl, variables = {} } = {}) {
  if (!suite || !Array.isArray(suite.tests) || suite.tests.length === 0) {
    throw new Error('Suite must contain at least one test.');
  }
  const base = new URL(baseUrl || suite.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('API base URL must use HTTP or HTTPS.');
  }

  const values = { ...variables };
  const results = [];
  for (const test of suite.tests) {
    const startedAt = performance.now();
    let httpStatus;
    try {
      if (!test || typeof test.name !== 'string' || typeof test.path !== 'string') {
        throw new Error('Each test requires a name and path.');
      }
      const request = expand(test, values);
      const url = new URL(request.path, base);
      if (url.origin !== base.origin) throw new Error('Cross-origin API path rejected.');
      if (!url.pathname.startsWith(base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`) &&
          url.pathname !== base.pathname) {
        throw new Error('API path escapes the configured base path.');
      }
      const method = request.method || 'GET';
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error(`Unsupported HTTP method: ${method}`);
      }
      const response = await fetch(url, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...request.headers },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs || 5000),
        redirect: 'error',
      });
      httpStatus = response.status;
      const body = await response.json();
      if (response.status !== request.status) {
        throw new Error(`Expected HTTP ${request.status}, received ${response.status}.`);
      }
      if (request.schema && !ajv.validate(request.schema, body)) {
        throw new Error(`Response schema mismatch: ${ajv.errorsText()}`);
      }
      for (const [path, expected] of Object.entries(request.equals || {})) {
        if (!isDeepStrictEqual(at(body, path), expected)) {
          throw new Error(`Response assertion failed at "${path}".`);
        }
      }
      for (const [name, expected] of Object.entries(request.responseHeaders || {})) {
        if (!(response.headers.get(name) || '').includes(expected)) {
          throw new Error(`Response header assertion failed for "${name}".`);
        }
      }
      const durationMs = Math.round(performance.now() - startedAt);
      if (request.maxMs && durationMs > request.maxMs) {
        throw new Error(`Response took ${durationMs}ms; maximum is ${request.maxMs}ms.`);
      }
      for (const [name, path] of Object.entries(request.capture || {})) {
        const captured = at(body, path);
        if (captured === undefined) throw new Error(`Response capture path "${path}" is missing.`);
        values[name] = captured;
      }
      results.push({ name: test.name, status: 'passed', durationMs, httpStatus });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown request failure.';
      results.push({
        name: typeof test?.name === 'string' ? test.name : 'Invalid test',
        status: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        error: message.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]'),
      });
    }
  }

  return {
    tool: 'API Sentinel',
    generatedAt: new Date().toISOString(),
    target: base.origin,
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  };
}
