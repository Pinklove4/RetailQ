import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ignoredDirectories = new Set([
  '.git',
  'artifacts',
  'coverage',
  'node_modules',
  'playwright-report',
  'reports',
  'test-results',
]);
const maxFileSize = 1_000_000;
const rules = [
  ['private-key', new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'].join(''))],
  ['aws-access-key', new RegExp('AKIA[0-9A-Z]{16}')],
  ['github-token', new RegExp('gh[pousr]_[A-Za-z0-9]{30,}')],
];

export async function scanSecrets(target) {
  const root = resolve(target);
  const findings = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;

      const metadata = await lstat(path);
      if (metadata.size > maxFileSize) continue;
      const content = await readFile(path, 'utf8');
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        for (const [rule, pattern] of rules) {
          if (pattern.test(line)) {
            findings.push({
              file: relative(root, path),
              line: index + 1,
              rule,
            });
          }
        }
      }
    }
  }

  await visit(root);
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule));
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const reportPath = join(root, 'artifacts', 'secrets.json');
  const findings = await scanSecrets(root);
  const report = {
    generatedAt: new Date().toISOString(),
    passed: findings.length === 0,
    rules: rules.map(([name]) => name),
    findings,
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (findings.length) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
    }
    console.error(`Credential-pattern scan failed with ${findings.length} finding(s).`);
    process.exitCode = 1;
  } else {
    console.log(`Credential-pattern scan passed (${rules.length} patterns checked).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Credential-pattern scan could not complete: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
