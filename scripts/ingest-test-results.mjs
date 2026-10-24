import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const filePath = process.argv[2] || 'artifacts/api-results.json';
const token = process.env.RETAILQ_ADMIN_TOKEN;
const apiUrl = (process.env.RETAILQ_API_URL || 'http://localhost:4000/api').replace(/\/$/, '');

if (!token) {
  console.error('RETAILQ_ADMIN_TOKEN is required to ingest test results.');
  process.exit(1);
}

const report = JSON.parse(await readFile(resolve(filePath), 'utf8'));
if (!Array.isArray(report.testResults) || report.testResults.length === 0) {
  throw new Error('Expected a Vitest JSON report containing testResults.');
}

let hasFailedTests = report.success === false;
for (const result of report.testResults) {
  const assertions = result.assertionResults || [];
  const failures = assertions
    .filter((assertion) => assertion.status === 'failed')
    .map((assertion) => ({
      title: assertion.fullName || assertion.title,
      messages: assertion.failureMessages || [],
    }));
  const passed = assertions.filter((assertion) => assertion.status === 'passed').length;
  const failed = failures.length;
  const duration = Math.max(0, (result.endTime || Date.now()) - (result.startTime || Date.now()));
  const response = await fetch(`${apiUrl}/quality/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      suite: basename(result.name || filePath),
      passed,
      failed,
      duration_ms: Math.round(duration),
      details: failures,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Quality ingestion failed (${response.status}): ${error}`);
  }
  console.log(`Ingested ${passed} passed, ${failed} failed from ${basename(result.name || filePath)}.`);
  hasFailedTests ||= failed > 0;
}

if (hasFailedTests) process.exitCode = 1;
