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
let suites;
if (Array.isArray(report.testResults) && report.testResults.length > 0) {
  suites = report.testResults.map((result) => {
    const assertions = result.assertionResults || [];
    const failures = assertions
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => ({
        title: assertion.fullName || assertion.title,
        messages: assertion.failureMessages || [],
      }));
    return {
      suite: basename(result.name || filePath),
      passed: assertions.filter((assertion) => assertion.status === 'passed').length,
      failed: failures.length,
      duration_ms: Math.max(0, (result.endTime || Date.now()) - (result.startTime || Date.now())),
      details: failures,
    };
  });
} else if (report.tool === 'API Sentinel' && Array.isArray(report.results)) {
  suites = [{
    suite: 'API Sentinel contract suite',
    passed: report.passed,
    failed: report.failed,
    duration_ms: report.results.reduce((sum, result) => sum + (result.durationMs || 0), 0),
    details: report.results
      .filter((result) => result.status === 'failed')
      .map(({ name, error }) => ({ name, error })),
  }];
} else {
  throw new Error('Expected a Vitest JSON report or an API Sentinel JSON report.');
}

let hasFailedTests = report.success === false;
for (const suite of suites) {
  const response = await fetch(`${apiUrl}/quality/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      suite: suite.suite,
      passed: suite.passed,
      failed: suite.failed,
      duration_ms: Math.round(suite.duration_ms),
      details: suite.details,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Quality ingestion failed (${response.status}): ${error}`);
  }
  console.log(`Ingested ${suite.passed} passed, ${suite.failed} failed from ${suite.suite}.`);
  hasFailedTests ||= suite.failed > 0;
}

if (hasFailedTests) process.exitCode = 1;
