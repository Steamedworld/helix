import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { DrizzleDB } from '../db/client'
import { nodes, users } from '../db/schema'
import { count } from 'drizzle-orm'
import { logger } from '../lib/logger'

export async function bootstrap(db: DrizzleDB, dataDir: string): Promise<string> {
  // 1. Ensure data directory exists
  mkdirSync(dataDir, { recursive: true })

  // 2. Check if admin user exists — if not, create one
  const [userCount] = await db.select({ count: count() }).from(users)
  if (userCount.count === 0) {
    const now = new Date().toISOString()
    await db.insert(users).values({
      id: crypto.randomUUID(),
      display_name: 'Admin',
      role: 'admin',
      created_at: now,
      updated_at: now,
    })
    logger.info('Bootstrap: created default admin user')
  }

  // 3. Check if local node exists — if not, create one
  const [nodeCount] = await db.select({ count: count() }).from(nodes)
  if (nodeCount.count === 0) {
    const now = new Date().toISOString()
    const localNodeId = crypto.randomUUID()
    await db.insert(nodes).values({
      id: localNodeId,
      name: 'Helix Local',
      kind: 'local',
      base_url: null,
      status: 'online',
      created_at: now,
      updated_at: now,
    })
    logger.info('Bootstrap: created local node')
    return localNodeId
  }

  // Return existing local node ID
  const [localNode] = await db.select({ id: nodes.id }).from(nodes).limit(1)
  return localNode.id
}
