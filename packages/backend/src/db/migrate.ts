import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { DrizzleDB } from './client'
import { join } from 'path'

export function runMigrations(db: DrizzleDB, migrationsFolder: string) {
  migrate(db, { migrationsFolder })
}

export function getMigrationsFolder() {
  // Resolve relative to process.cwd(), which is the package root when
  // the server is started as documented (cd packages/backend && node ...).
  // This avoids __dirname path depth differences between ts-node and compiled output.
  return join(process.cwd(), 'drizzle')
}
