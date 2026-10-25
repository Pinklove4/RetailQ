import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanSecrets } from '../../scripts/scan-secrets.mjs';

test('reports supported credential patterns without retaining their values', async () => {
  const target = await mkdtemp(join(tmpdir(), 'retailq-secrets-'));
  try {
    const privateKey = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
    const awsKey = 'AKIA' + 'A'.repeat(16);
    const githubToken = 'ghp' + '_' + 'a'.repeat(36);
    await writeFile(join(target, 'credentials.txt'), `${privateKey}\n${awsKey}\n${githubToken}\n`);

    const findings = await scanSecrets(target);

    assert.deepEqual(findings.map(({ rule, line }) => ({ rule, line })), [
      { rule: 'private-key', line: 1 },
      { rule: 'aws-access-key', line: 2 },
      { rule: 'github-token', line: 3 },
    ]);
    assert.equal(JSON.stringify(findings).includes(awsKey), false);
    assert.equal(JSON.stringify(findings).includes(githubToken), false);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('skips generated and dependency directories', async () => {
  const target = await mkdtemp(join(tmpdir(), 'retailq-secrets-ignore-'));
  try {
    const generated = join(target, 'node_modules');
    await mkdir(generated);
    await writeFile(join(generated, 'fixture.txt'), 'AKIA' + 'B'.repeat(16));

    assert.deepEqual(await scanSecrets(target), []);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
