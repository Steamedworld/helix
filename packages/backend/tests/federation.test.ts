import { describe, it, expect } from 'vitest'
import { registerNode, discoverNodes } from '../src/services/federation/nodeRegistry'
import { pushCatalogUpdate, pullCatalogUpdates } from '../src/services/federation/catalogSync'
import { selectBestSource } from '../src/services/federation/sourceSelection'
import { signPlaybackUrl } from '../src/services/federation/playbackSigning'
import { checkNodeHealth } from '../src/services/federation/healthCheck'
import type { Node } from '@helix/shared'

const mockLocalNode: Node = {
  id: 'node-1',
  name: 'Helix Local',
  kind: 'local',
  base_url: null,
  status: 'online',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const mockRemoteNode: Node = {
  id: 'node-2',
  name: 'Remote Node',
  kind: 'remote',
  base_url: 'http://remote:3001',
  status: 'unknown',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

describe('federation stubs', () => {
  it('registerNode does not throw', async () => {
    await expect(registerNode(mockLocalNode)).resolves.toBeUndefined()
  })

  it('discoverNodes returns empty array', async () => {
    const result = await discoverNodes()
    expect(result).toEqual([])
  })

  it('pushCatalogUpdate does not throw', async () => {
    await expect(pushCatalogUpdate([])).resolves.toBeUndefined()
  })

  it('pullCatalogUpdates returns empty array', async () => {
    const result = await pullCatalogUpdates('node-2')
    expect(result).toEqual([])
  })

  it('selectBestSource returns null', async () => {
    const result = await selectBestSource('media-1', 'user-1')
    expect(result).toBeNull()
  })

  it('signPlaybackUrl returns a stub URL', () => {
    const url = signPlaybackUrl('http://localhost:3001', 'file-1', 'user-1')
    expect(url).toBe('http://localhost:3001/api/v1/stream/file-1')
  })

  it('checkNodeHealth returns online for local node', async () => {
    const status = await checkNodeHealth(mockLocalNode)
    expect(status).toBe('online')
  })

  it('checkNodeHealth returns unknown for remote node', async () => {
    const status = await checkNodeHealth(mockRemoteNode)
    expect(status).toBe('unknown')
  })
})
