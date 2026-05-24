import { config } from './config'
import { createDb } from './db/client'
import { runMigrations, getMigrationsFolder } from './db/migrate'
import { bootstrap } from './bootstrap'
import { buildServer } from './server'

async function main() {
  // Create DB
  const db = createDb(config.dbPath)

  // Run migrations
  const migrationsFolder = getMigrationsFolder()
  runMigrations(db, migrationsFolder)

  // Bootstrap (create local node and admin user if needed)
  const localNodeId = await bootstrap(db, config.dataDir)

  // Build and start the server
  const baseUrl = process.env.BASE_URL ?? `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`
  const app = buildServer(db, localNodeId, baseUrl)

  try {
    await app.listen({ port: config.port, host: config.host })
    console.log(`Helix backend running at http://${config.host}:${config.port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()
