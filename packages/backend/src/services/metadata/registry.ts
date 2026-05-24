import type { MediaItemKind } from '@helix/shared'
import type { MetadataProvider, ProviderInfo } from './types'

export class MetadataProviderRegistry {
  private providers = new Map<string, MetadataProvider>()

  register(provider: MetadataProvider): void {
    this.providers.set(provider.id, provider)
  }

  getProvider(id: string): MetadataProvider | undefined {
    return this.providers.get(id)
  }

  listProviders(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      label: p.label,
      status: p.configurationStatus,
      supportedKinds: p.supportedKinds,
    }))
  }

  getEnabledProvidersForKind(kind: MediaItemKind): MetadataProvider[] {
    return Array.from(this.providers.values()).filter(
      (p) => p.isConfigured() && p.supportedKinds.includes(kind)
    )
  }
}

// Singleton instance
export const metadataRegistry = new MetadataProviderRegistry()
