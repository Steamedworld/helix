/**
 * Tests for usePlaybackRefresh — proactive token refresh before expiry.
 *
 * Uses fake timers (vi.useFakeTimers) for all timer-dependent cases.
 * The ../api/playback module is mocked to avoid real HTTP calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePlaybackRefresh } from './usePlaybackRefresh'
import type { LocalPlaybackSource, RemoteDirectPlaybackSource } from '../api/playback'

// ─── Mock playback API ────────────────────────────────────────────────────────

vi.mock('../api/playback', () => ({
  getPlaybackSource: vi.fn(),
}))

import { getPlaybackSource } from '../api/playback'
const mockGetPlaybackSource = getPlaybackSource as ReturnType<typeof vi.fn>

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLocalSource(overrides: Partial<LocalPlaybackSource> = {}): LocalPlaybackSource {
  const now = Date.now()
  const ttl = 14400
  return {
    code: 'local_playable',
    nodeId: 'local-node',
    nodeBaseUrl: 'http://localhost:3001',
    nodeKind: 'local',
    nodeName: 'Helix Local',
    mediaItemId: 'item-1',
    selectedVersionId: 'v1',
    selectedFileId: 'f1',
    fileId: 'f1',
    versionId: 'v1',
    filename: 'movie.mp4',
    container: 'mp4',
    quality_label: '1080p',
    resolution_width: 1920,
    resolution_height: 1080,
    video_codec: 'h264',
    audio_codec: 'aac',
    streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=abc',
    score: 20,
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    tokenTtlSeconds: ttl,
    ...overrides,
  }
}

function makeRemoteSource(overrides: Partial<RemoteDirectPlaybackSource> = {}): RemoteDirectPlaybackSource {
  const now = Date.now()
  const ttl = 14400
  return {
    code: 'remote_direct',
    sourceType: 'remote_direct',
    nodeId: 'remote-node',
    nodeName: 'Remote Home',
    streamUrl: 'http://remote:3001/api/v1/media-files/rf1/stream?token=xyz',
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    tokenTtlSeconds: ttl,
    mediaFileId: 'rf1',
    contentType: 'video/mp4',
    container: 'mp4',
    ...overrides,
  }
}

function makeOkResponse(source: LocalPlaybackSource | RemoteDirectPlaybackSource) {
  return Promise.resolve({
    ok: true,
    data: { source, unavailable: undefined },
  })
}

function makeFailResponse() {
  return Promise.resolve({
    ok: false,
    error: 'Server error',
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('usePlaybackRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGetPlaybackSource.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not schedule a timer when refreshAfter is absent', () => {
    const source = makeLocalSource({ refreshAfter: undefined })
    renderHook(() => usePlaybackRefresh(source, 'item-1'))

    vi.runAllTimers()

    expect(mockGetPlaybackSource).not.toHaveBeenCalled()
  })

  it('schedules a timer when refreshAfter is set', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeLocalSource({
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    const refreshedSource = makeLocalSource({ streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=new' })
    mockGetPlaybackSource.mockReturnValue(makeOkResponse(refreshedSource))

    renderHook(() => usePlaybackRefresh(source, 'item-1'))

    // Timer should not have fired yet
    expect(mockGetPlaybackSource).not.toHaveBeenCalled()

    // Advance to just past the refresh point
    await act(async () => {
      vi.advanceTimersByTime(ttl * 0.75 * 1000 + 100)
      await Promise.resolve()
    })

    expect(mockGetPlaybackSource).toHaveBeenCalledWith('item-1')
  })

  it('clears timer on unmount', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeLocalSource({
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    const { unmount } = renderHook(() => usePlaybackRefresh(source, 'item-1'))

    unmount()

    // Advance past the refresh time — no call should happen after unmount
    await act(async () => {
      vi.advanceTimersByTime(ttl * 1000 + 100)
      await Promise.resolve()
    })

    expect(mockGetPlaybackSource).not.toHaveBeenCalled()
  })

  it('clears timer on mediaItemId change', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeLocalSource({
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    let mediaItemId = 'item-1'
    const { rerender } = renderHook(
      ({ id }: { id: string }) => usePlaybackRefresh(source, id),
      { initialProps: { id: mediaItemId } }
    )

    // Change the mediaItemId — the old timer should be cleared
    await act(async () => {
      rerender({ id: 'item-2' })
    })

    // Advance past original refresh time
    await act(async () => {
      vi.advanceTimersByTime(ttl * 0.75 * 1000 + 100)
      await Promise.resolve()
    })

    // No call should have been made for the old item-1
    expect(mockGetPlaybackSource).not.toHaveBeenCalledWith('item-1')
  })

  it('calls refresh API when timer fires', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeLocalSource({
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    const refreshed = makeLocalSource({ streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=fresh' })
    mockGetPlaybackSource.mockReturnValue(makeOkResponse(refreshed))

    renderHook(() => usePlaybackRefresh(source, 'item-1'))

    await act(async () => {
      vi.advanceTimersByTime(ttl * 0.75 * 1000 + 100)
      await Promise.resolve()
    })

    expect(mockGetPlaybackSource).toHaveBeenCalledOnce()
    expect(mockGetPlaybackSource).toHaveBeenCalledWith('item-1')
  })

  it('updates source on successful refresh', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeLocalSource({
      streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=old',
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    const refreshed = makeLocalSource({
      streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=new',
    })
    mockGetPlaybackSource.mockReturnValue(makeOkResponse(refreshed))

    const { result } = renderHook(() => usePlaybackRefresh(source, 'item-1'))

    expect(result.current.source?.streamUrl).toContain('token=old')

    await act(async () => {
      vi.advanceTimersByTime(ttl * 0.75 * 1000 + 100)
      await Promise.resolve()
    })

    expect(result.current.source?.streamUrl).toContain('token=new')
    expect(result.current.refreshError).toBeNull()
  })

  it('sets refreshError on failed refresh', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeLocalSource({
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    mockGetPlaybackSource.mockReturnValue(makeFailResponse())

    const { result } = renderHook(() => usePlaybackRefresh(source, 'item-1'))

    await act(async () => {
      vi.advanceTimersByTime(ttl * 0.75 * 1000 + 100)
      await Promise.resolve()
    })

    expect(result.current.refreshError).toBeTruthy()
  })

  it('keeps old source on failed refresh if still usable', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeLocalSource({
      streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=original',
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    mockGetPlaybackSource.mockReturnValue(makeFailResponse())

    const { result } = renderHook(() => usePlaybackRefresh(source, 'item-1'))

    await act(async () => {
      vi.advanceTimersByTime(ttl * 0.75 * 1000 + 100)
      await Promise.resolve()
    })

    // Source should still be the original
    expect(result.current.source?.streamUrl).toContain('token=original')
  })

  it('refreshes immediately if refreshAfter is in the past on mount', async () => {
    const pastRefresh = new Date(Date.now() - 1000).toISOString()
    const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString()
    const source = makeLocalSource({
      refreshAfter: pastRefresh,
      expiresAt: futureExpiry,
    })

    const refreshed = makeLocalSource({ streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=immediate' })
    mockGetPlaybackSource.mockReturnValue(makeOkResponse(refreshed))

    const { result } = renderHook(() => usePlaybackRefresh(source, 'item-1'))

    // Flush microtasks (the immediate async refresh)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockGetPlaybackSource).toHaveBeenCalledWith('item-1')
    expect(result.current.source?.streamUrl).toContain('token=immediate')
  })

  it('respects minimum 30s between refresh calls (min interval guard)', async () => {
    const ttl = 14400
    const now = Date.now()

    // Set refreshAfter to right now so the timer fires immediately on mount
    const source = makeLocalSource({
      refreshAfter: new Date(now + 100).toISOString(),
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    })

    // Each refresh returns a new source with a refreshAfter 100ms away
    let callCount = 0
    mockGetPlaybackSource.mockImplementation(() => {
      callCount++
      const t = Date.now()
      return makeOkResponse(makeLocalSource({
        streamUrl: `http://localhost:3001/api/v1/media-files/f1/stream?token=call${callCount}`,
        refreshAfter: new Date(t + 100).toISOString(),
        expiresAt: new Date(t + ttl * 1000).toISOString(),
      }))
    })

    renderHook(() => usePlaybackRefresh(source, 'item-1'))

    // Advance 10 seconds — many timers would fire, but the 30s guard should block them
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })

    // Should have been called at most once in the first 10s (the 30s guard prevents spam)
    expect(callCount).toBeLessThanOrEqual(1)
  })

  it('handles visibilitychange: refreshes immediately if refreshAfter is past when tab becomes visible', async () => {
    const pastRefresh = new Date(Date.now() - 5000).toISOString()
    const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString()
    const source = makeLocalSource({
      refreshAfter: pastRefresh,
      expiresAt: futureExpiry,
    })

    // Suppress the immediate refresh on mount by advancing past the min interval check
    // (lastRefreshAtRef starts at 0, so first call goes through)
    mockGetPlaybackSource.mockReturnValue(makeOkResponse(source))

    renderHook(() => usePlaybackRefresh(source, 'item-1'))

    // Let the initial mount refresh complete
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const callsAfterMount = mockGetPlaybackSource.mock.calls.length

    // Advance past the minimum interval so the visibility handler can fire
    await act(async () => {
      vi.advanceTimersByTime(31_000)
      await Promise.resolve()
    })

    // Simulate tab becoming visible with an expired refreshAfter
    const refreshed = makeLocalSource({ streamUrl: 'http://localhost:3001/api/v1/media-files/f1/stream?token=woke' })
    mockGetPlaybackSource.mockReturnValue(makeOkResponse(refreshed))

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
      await Promise.resolve()
    })

    // Should have fired at least one more call after the visibility event
    expect(mockGetPlaybackSource.mock.calls.length).toBeGreaterThan(callsAfterMount)
  })

  it('does not schedule a timer for a remote source without refreshAfter', () => {
    const source = makeRemoteSource({ refreshAfter: undefined })
    renderHook(() => usePlaybackRefresh(source, 'item-1'))

    vi.runAllTimers()

    expect(mockGetPlaybackSource).not.toHaveBeenCalled()
  })

  it('schedules a timer for a remote direct source with refreshAfter', async () => {
    const ttl = 14400
    const now = Date.now()
    const source = makeRemoteSource({
      refreshAfter: new Date(now + ttl * 0.75 * 1000).toISOString(),
    })

    const refreshed = makeRemoteSource({ streamUrl: 'http://remote:3001/api/v1/media-files/rf1/stream?token=refreshed' })
    mockGetPlaybackSource.mockReturnValue(makeOkResponse(refreshed))

    const { result } = renderHook(() => usePlaybackRefresh(source, 'item-1'))

    await act(async () => {
      vi.advanceTimersByTime(ttl * 0.75 * 1000 + 100)
      await Promise.resolve()
    })

    expect(mockGetPlaybackSource).toHaveBeenCalledWith('item-1')
    expect(result.current.source?.streamUrl).toContain('token=refreshed')
  })
})
