import { describe, it, expect, beforeEach } from 'vitest'
import { MetadataProviderRegistry } from '../src/services/metadata/registry'
import type { MetadataProvider, MetadataCandidate, EnrichedMovieMetadata } from '../src/services/metadata/types'
import type { MediaItemKind } from '@helix/shared'

// ─── Minimal fake providers ──────────────────────────────────────────────────────

function makeProvider(id: string, configured: boolean, kinds: MediaItemKind[] = ['movie']): MetadataProvider {
  return {
    id,
    label: `Provider ${id}`,
    supportedKinds: kinds,
    get configurationStatus() {
      return configured ? 'configured' as const : 'unconfigured' as const
    },
    isConfigured: () => configured,
    searchMovies: async (): Promise<MetadataCandidate[]> => [],
    getMovieDetails: async (): Promise<EnrichedMovieMetadata | null> => null,
  }
}

describe('MetadataProviderRegistry', () => {
  let registry: MetadataProviderRegistry

  beforeEach(() => {
    // Use a fresh registry for each test (not the singleton)
    registry = new MetadataProviderRegistry()
  })

  it('registers a provider and retrieves it by id', () => {
    const p = makeProvider('tmdb', true)
    registry.register(p)
    expect(registry.getProvider('tmdb')).toBe(p)
  })

  it('returns undefined for unknown provider id', () => {
    expect(registry.getProvider('nonexistent')).toBeUndefined()
  })

  it('listProviders returns correct statuses', () => {
    registry.register(makeProvider('tmdb', true))
    registry.register(makeProvider('tvdb', false))

    const list = registry.listProviders()
    expect(list).toHaveLength(2)

    const tmdb = list.find((p) => p.id === 'tmdb')
    const tvdb = list.find((p) => p.id === 'tvdb')

    expect(tmdb?.status).toBe('configured')
    expect(tvdb?.status).toBe('unconfigured')
  })

  it('listProviders returns correct supportedKinds', () => {
    registry.register(makeProvider('tmdb', true, ['movie']))
    registry.register(makeProvider('tvdb', true, ['show', 'episode']))

    const list = registry.listProviders()
    expect(list.find((p) => p.id === 'tmdb')?.supportedKinds).toEqual(['movie'])
    expect(list.find((p) => p.id === 'tvdb')?.supportedKinds).toEqual(['show', 'episode'])
  })

  it('getEnabledProvidersForKind returns only configured providers matching kind', () => {
    registry.register(makeProvider('tmdb', true, ['movie']))
    registry.register(makeProvider('tvdb', false, ['movie'])) // not configured
    registry.register(makeProvider('mb', true, ['track']))    // wrong kind

    const providers = registry.getEnabledProvidersForKind('movie')
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe('tmdb')
  })

  it('getEnabledProvidersForKind returns empty array when no configured providers', () => {
    registry.register(makeProvider('tmdb', false, ['movie']))
    expect(registry.getEnabledProvidersForKind('movie')).toHaveLength(0)
  })

  it('overwrites a provider registered under the same id', () => {
    const p1 = makeProvider('tmdb', true)
    const p2 = makeProvider('tmdb', false)
    registry.register(p1)
    registry.register(p2)
    expect(registry.getProvider('tmdb')).toBe(p2)
    expect(registry.listProviders()).toHaveLength(1)
  })
})

// ─── Re-export class for tests (registry.ts exports singleton; tests need a fresh class) ───

// We test via the class directly — check registry.ts exports it:
import { MetadataProviderRegistry as RegistryClass } from '../src/services/metadata/registry'
describe('MetadataProviderRegistry (import check)', () => {
  it('is importable as a named export', () => {
    expect(RegistryClass).toBeDefined()
    const r = new RegistryClass()
    expect(r.listProviders()).toHaveLength(0)
  })
})
