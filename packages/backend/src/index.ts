import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { config, isLoopbackUrl } from './config'
import { createDb } from './db/client'
import { runMigrations, getMigrationsFolder } from './db/migrate'
import { bootstrap } from './bootstrap'
import { buildServer } from './server'

function emitBaseUrlWarnings(port: number) {
  if (!config.baseUrl) {
    console.warn(
      `[helix] BASE_URL is not set. Federation remote direct playback URLs will default to` +
      ` http://localhost:${port}. Remote browsers may not be able to reach this node.` +
      ` Set BASE_URL to the URL your browser uses to reach this server.`
    )
    return
  }
  if (isLoopbackUrl(config.baseUrl)) {
    console.warn(
      `[helix] BASE_URL appears to be a loopback address (${config.baseUrl}).` +
      ` Remote browsers outside this machine will not be able to use direct playback from this node.`
    )
  }
}

async function main() {
  // Ensure data directory exists before opening SQLite
  mkdirSync(dirname(config.dbPath), { recursive: true })
  mkdirSync(config.metadataCacheDir, { recursive: true })

  // Create DB
  const db = createDb(config.dbPath)

  // Run migrations
  const migrationsFolder = getMigrationsFolder()
  runMigrations(db, migrationsFolder)

  // Bootstrap (create local node and admin user if needed)
  const localNodeId = await bootstrap(db, config.dataDir)

  // Resolve effective base URL: use configured BASE_URL if set, otherwise
  // fall back to a localhost URL constructed from host/port.
  const effectiveBaseUrl = config.baseUrl ?? `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`

  // Emit federation base-URL warnings (non-fatal)
  emitBaseUrlWarnings(config.port)

  // Build and start the server
  const app = buildServer(db, localNodeId, effectiveBaseUrl, config.dataDir)

  try {
    await app.listen({ port: config.port, host: config.host })
    console.log(`Helix backend running at http://${config.host}:${config.port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()
