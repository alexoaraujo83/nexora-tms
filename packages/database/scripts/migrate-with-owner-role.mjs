import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATOR_DATABASE_URL or DATABASE_URL is required');

const sql = postgres(url, {
  max: 1,
  prepare: false,
});

try {
  const [identity] = await sql`select session_user, current_user, current_database()`;
  if (identity.session_user !== 'nexora_migrator' || identity.current_user !== 'nexora_migrator' || identity.current_database !== 'nexora') {
    throw new Error(`Unexpected migration identity: ${identity.session_user}:${identity.current_user}:${identity.current_database}`);
  }

  await sql`set role nexora_owner`;

  const [elevated] = await sql`select session_user, current_user, current_database()`;
  if (elevated.session_user !== 'nexora_migrator' || elevated.current_user !== 'nexora_owner' || elevated.current_database !== 'nexora') {
    throw new Error(`SET ROLE validation failed: ${elevated.session_user}:${elevated.current_user}:${elevated.current_database}`);
  }

  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  console.log(`Migration role chain verified: ${elevated.session_user} -> ${elevated.current_user}`);
} finally {
  await sql.end({ timeout: 5 });
}
