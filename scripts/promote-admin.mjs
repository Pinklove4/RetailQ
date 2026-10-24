import pg from 'pg';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... node scripts/promote-admin.mjs user@example.com');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const result = await client.query('UPDATE users SET role=$1 WHERE email=$2 RETURNING email', ['admin', email]);
  if (result.rowCount !== 1) throw new Error(`Expected one account for ${email}, updated ${result.rowCount ?? 0}.`);
  console.log(`Admin role granted to ${result.rows[0].email}. Sign in again to receive an updated token.`);
} finally {
  await client.end();
}
