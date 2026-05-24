import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { DrizzleDB } from './client'
import { join } from 'path'

export function runMigrations(db: DrizzleDB, migrationsFolder: string) {
  migrate(db, { migrationsFolder })
}

export function getMigrationsFolder() {
  // In production (compiled), migrations are relative to the dist folder
  // In development, they're relative to the src folder
  const isDev = process.env.NODE_ENV !== 'production'
  if (isDev) {
    return join(__dirname, '../../drizzle')
  }
  return join(__dirname, '../drizzle')
}
