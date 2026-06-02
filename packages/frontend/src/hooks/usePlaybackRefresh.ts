import { useState, useEffect, useRef, useCallback } from 'react'
import { getPlaybackSource } from '../api/playback'
import { apiFetch } from '../api/client'
import type { LocalPlaybackSource, RemoteDirectPlaybackSource } from '../api/playback'

export type RefreshableSource = LocalPlaybackSource | RemoteDirectPlaybackSource

// Minimum gap between consecutive refresh calls (ms)
const MIN_REFRESH_INTERVAL_MS = 30_000

export interface UsePlaybackRefreshResult {
  source: RefreshableSource | null
  refreshError: string | null
  isRefreshing: boolean
}

/**
 * Schedules a proactive playback-source refresh before the signed URL expires.
 *
 * - Uses `source.refreshAfter` to set a timer; does nothing when absent (old server compat).
 * - For remote proxy sources, uses `source.refreshUrl` (the dedicated refresh endpoint)
 *   rather than re-fetching the general playback-source endpoint. Falls back to the
 *   general endpoint for local sources or when refreshUrl is absent.
 * - On tab wake (visibilitychange), refreshes immediately if the token is expired or the
 *   refresh window has passed.
 * - Enforces a minimum 30s gap between refresh calls regardless of how timers fire.
 * - Cleans up the timer on unmount or when mediaItemId changes.
 * - Error messages are always sanitized — never expose token, URL, or upstream details.
 */
export function usePlaybackRefresh(
  initialSource: RefreshableSource | null,
  mediaItemId: string
): UsePlaybackRefreshResult {
  const [source, setSource] = useState<RefreshableSource | null>(initialSource)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Keep a ref to the current source so callbacks always see the latest value
  // without causing re-renders or re-scheduling timers.
  const sourceRef = useRef<RefreshableSource | null>(initialSource)
  sourceRef.current = source

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRefreshAtRef = useRef<number>(0)

  // Synchronise state when initialSource changes (e.g. mediaItemId navigation)
  useEffect(() => {
    setSource(initialSource)
    setRefreshError(null)
  }, [initialSource])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Core refresh call — fetches a fresh playback-source and updates state.
  // For remote proxy sources with a refreshUrl, calls the dedicated refresh endpoint
  // rather than the general playback-source endpoint.
  // Returns the new source on success, null on failure.
  const doRefresh = useCallback(async (): Promise<RefreshableSource | null> => {
    const now = Date.now()
    if (now - lastRefreshAtRef.current < MIN_REFRESH_INTERVAL_MS) {
      // Too soon — skip silently
      return null
    }
    lastRefreshAtRef.current = now
    setIsRefreshing(true)

    const currentSource = sourceRef.current
    // Prefer the dedicated refresh endpoint when available (remote proxy sources)
    const refreshUrl = currentSource?.code === 'remote_direct'
      ? (currentSource as RemoteDirectPlaybackSource).refreshUrl
      : undefined

    try {
      if (refreshUrl) {
        // Use the refresh endpoint — returns a fresh PlaybackSource directly
        const res = await apiFetch<RemoteDirectPlaybackSource>(refreshUrl)
        if (res.ok) {
          const newSource = res.data as RefreshableSource
          setSource(newSource)
          setRefreshError(null)
          setIsRefreshing(false)
          return newSource
        } else {
          setRefreshError("Couldn't refresh playback. Try restarting the video.")
          setIsRefreshing(false)
          return null
        }
      } else {
        // Fall back to general playback-source endpoint (local sources, legacy)
        const res = await getPlaybackSource(mediaItemId)
        if (res.ok && !res.data.unavailable && res.data.source) {
          const newSource = res.data.source as RefreshableSource
          setSource(newSource)
          setRefreshError(null)
          setIsRefreshing(false)
          return newSource
        } else {
          setRefreshError("Couldn't refresh playback. Try restarting the video.")
          setIsRefreshing(false)
          return null
        }
      }
    } catch {
      setRefreshError("Couldn't refresh playback. Try restarting the video.")
      setIsRefreshing(false)
      return null
    }
  }, [mediaItemId])

  // Schedule a timer based on the given source's refreshAfter field.
  // Cancels any existing timer first.
  const scheduleTimer = useCallback((src: RefreshableSource | null) => {
    clearTimer()
    if (!src?.refreshAfter) return

    const refreshAt = new Date(src.refreshAfter).getTime()
    const delay = refreshAt - Date.now()

    if (delay <= 0) {
      // refreshAfter is already in the past — refresh immediately (subject to min interval)
      void doRefresh().then((newSrc) => {
        if (newSrc) scheduleTimer(newSrc)
      })
      return
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void doRefresh().then((newSrc) => {
        if (newSrc) scheduleTimer(newSrc)
      })
    }, delay)
  }, [clearTimer, doRefresh])

  // Initial schedule when source or mediaItemId changes
  useEffect(() => {
    clearTimer()
    scheduleTimer(source)
    return clearTimer
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaItemId, source?.refreshAfter])

  // Tab visibility handler: if the tab wakes and the token is expired or
  // the refresh window has passed, refresh immediately.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      const src = sourceRef.current
      if (!src) return

      const now = Date.now()
      const expired = src.expiresAt ? now >= new Date(src.expiresAt).getTime() : false
      const refreshPast = src.refreshAfter ? now >= new Date(src.refreshAfter).getTime() : false

      if (expired || refreshPast) {
        clearTimer()
        void doRefresh().then((newSrc) => {
          if (newSrc) scheduleTimer(newSrc)
        })
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [clearTimer, doRefresh, scheduleTimer])

  return { source, refreshError, isRefreshing }
}
