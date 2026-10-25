import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runSuite } from './runner.mjs';
import { writeReports } from './report.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Value required for ${name}.`);
  return value;
}

try {
  const suitePath = resolve(option('--suite', 'tests/api-sentinel/retailq.json'));
  const outputDirectory = resolve(option('--out', 'artifacts/api-contract'));
  const suite = JSON.parse(await readFile(suitePath, 'utf8'));
  for (const name of ['SENTINEL_EMAIL', 'SENTINEL_PASSWORD', 'SENTINEL_IDEMPOTENCY_KEY']) {
    if (!process.env[name]) throw new Error(`${name} must be set for the stateful API contract suite.`);
  }
  const result = await runSuite(suite, {
    baseUrl: process.env.BASE_URL || suite.baseUrl,
    variables: {
      email: process.env.SENTINEL_EMAIL || '',
      password: process.env.SENTINEL_PASSWORD || '',
      idempotencyKey: process.env.SENTINEL_IDEMPOTENCY_KEY || '',
    },
  });
  await writeReports(result, outputDirectory);
  console.log(`API contract checks: ${result.passed}/${result.total} passed. Report: ${outputDirectory}`);
  if (result.failed > 0) {
    for (const failure of result.results.filter((item) => item.status === 'failed')) {
      console.error(`FAIL ${failure.name}: ${failure.error}`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'API contract runner failed.');
  process.exitCode = 2;
}
