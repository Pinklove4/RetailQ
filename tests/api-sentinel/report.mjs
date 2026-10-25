import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[char]);

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
})[char]);

export async function writeReports(result, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);

  const cases = result.results.map((item) => (
    `<testcase name="${escapeXml(item.name)}" time="${(item.durationMs / 1000).toFixed(3)}">` +
    (item.status === 'failed' ? `<failure message="${escapeXml(item.error)}"/>` : '') +
    '</testcase>'
  )).join('');
  await writeFile(
    join(outputDirectory, 'junit.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><testsuite name="RetailQ API contract" tests="${result.total}" failures="${result.failed}">${cases}</testsuite>\n`,
  );

  const rows = result.results.map((item) => (
    `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.status)}</td>` +
    `<td>${item.durationMs}</td><td>${escapeHtml(item.error || '')}</td></tr>`
  )).join('');
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>RetailQ API contract results</title>
<style>body{font:16px system-ui;max-width:1000px;margin:3rem auto;padding:0 1rem;color:#14251f}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.7rem;border-bottom:1px solid #ccd8d2}.passed{color:#176b3a}.failed{color:#a11}</style>
<h1>RetailQ API contract checks</h1>
<p>Target: ${escapeHtml(result.target)} · ${escapeHtml(result.generatedAt)}</p>
<p><strong>${result.passed}</strong> passed · <strong>${result.failed}</strong> failed</p>
<table><thead><tr><th>Check</th><th>Status</th><th>Duration (ms)</th><th>Failure</th></tr></thead><tbody>${rows}</tbody></table>
</html>`;
  await writeFile(join(outputDirectory, 'index.html'), html);
}
