import { eq, and, inArray } from 'drizzle-orm'
import { libraryPermissions, libraries, mediaItems } from '../db/schema'
import type { AuthUser } from '../middleware/auth'
import type { DrizzleDB } from '../db/client'

export async function canViewLibrary(
  user: AuthUser,
  libraryId: string,
  db: DrizzleDB
): Promise<boolean> {
  if (user.role === 'admin') return true
  const [perm] = await db
    .select()
    .from(libraryPermissions)
    .where(
      and(
        eq(libraryPermissions.library_id, libraryId),
        eq(libraryPermissions.user_id, user.id)
      )
    )
    .limit(1)
  return perm?.can_view === true
}

export async function canPlayLibrary(
  user: AuthUser,
  libraryId: string,
  db: DrizzleDB
): Promise<boolean> {
  if (user.role === 'admin') return true
  const [perm] = await db
    .select()
    .from(libraryPermissions)
    .where(
      and(
        eq(libraryPermissions.library_id, libraryId),
        eq(libraryPermissions.user_id, user.id)
      )
    )
    .limit(1)
  return perm?.can_view === true && perm?.can_play === true
}

export async function getViewableLibraryIds(
  user: AuthUser,
  db: DrizzleDB
): Promise<string[] | null> {
  if (user.role === 'admin') return null  // null = all libraries
  const perms = await db
    .select({ library_id: libraryPermissions.library_id })
    .from(libraryPermissions)
    .where(
      and(
        eq(libraryPermissions.user_id, user.id),
        eq(libraryPermissions.can_view, true)
      )
    )
  return perms.map((p) => p.library_id)
}

export async function filterLibrariesForUser(
  user: AuthUser,
  db: DrizzleDB
): Promise<typeof libraries.$inferSelect[]> {
  if (user.role === 'admin') {
    return db.select().from(libraries)
  }
  const ids = await getViewableLibraryIds(user, db)
  if (!ids || ids.length === 0) return []
  return db.select().from(libraries).where(inArray(libraries.id, ids))
}

export async function filterMediaForUser(
  user: AuthUser,
  db: DrizzleDB,
  items: (typeof mediaItems.$inferSelect)[]
): Promise<(typeof mediaItems.$inferSelect)[]> {
  if (user.role === 'admin') return items
  const ids = await getViewableLibraryIds(user, db)
  if (!ids || ids.length === 0) return []
  const idSet = new Set(ids)
  return items.filter((item) => idSet.has(item.library_id))
}

export async function getLibraryIdForMediaItem(
  mediaItemId: string,
  db: DrizzleDB
): Promise<string | null> {
  const [item] = await db
    .select({ library_id: mediaItems.library_id })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))
    .limit(1)
  return item?.library_id ?? null
}
