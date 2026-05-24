import { describe, it, expect } from 'vitest'
import { parseFilename } from '../src/services/scanner'

describe('parseFilename — title/year extraction', () => {
  it('handles dot-separated with year and quality: Movie.Name.2020.1080p.BluRay.x264.mkv', () => {
    const r = parseFilename('Movie.Name.2020.1080p.BluRay.x264.mkv')
    expect(r.title).toBe('Movie Name')
    expect(r.year).toBe(2020)
  })

  it('handles parenthesised year: Movie Name (2020).mkv', () => {
    const r = parseFilename('Movie Name (2020).mkv')
    expect(r.title).toBe('Movie Name')
    expect(r.year).toBe(2020)
  })

  it('handles dot-separated 4K WEB-DL: Movie.Name.2020.2160p.WEB-DL.mkv', () => {
    const r = parseFilename('Movie.Name.2020.2160p.WEB-DL.mkv')
    expect(r.title).toBe('Movie Name')
    expect(r.year).toBe(2020)
  })

  it('handles TV SxxExx dot-separated: Show.Name.S01E02.Episode.Title.1080p.mkv', () => {
    const r = parseFilename('Show.Name.S01E02.Episode.Title.1080p.mkv')
    expect(r.title).toBe('Show Name')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(2)
    expect(r.year).toBeNull()
  })

  it('handles TV SxxExx dash-separated: Show Name - S01E02 - Episode Title.mkv', () => {
    const r = parseFilename('Show Name - S01E02 - Episode Title.mkv')
    expect(r.title).toBe('Show Name')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(2)
  })
})

describe('parseFilename — quality label inference', () => {
  it('extracts 1080p quality label', () => {
    const r = parseFilename('Movie.Name.2020.1080p.mkv')
    expect(r.qualityLabel).toBe('1080p')
    expect(r.resolutionWidth).toBe(1920)
    expect(r.resolutionHeight).toBe(1080)
  })

  it('extracts 4K / 2160p quality label', () => {
    const r = parseFilename('Movie.Name.2020.2160p.mkv')
    expect(r.qualityLabel).toBe('4K')
    expect(r.resolutionWidth).toBe(3840)
    expect(r.resolutionHeight).toBe(2160)
  })

  it('extracts 720p quality label', () => {
    const r = parseFilename('Movie.Name.2020.720p.mkv')
    expect(r.qualityLabel).toBe('720p')
    expect(r.resolutionWidth).toBe(1280)
    expect(r.resolutionHeight).toBe(720)
  })

  it('extracts 480p quality label', () => {
    const r = parseFilename('Movie.Name.2020.480p.mkv')
    expect(r.qualityLabel).toBe('480p')
    expect(r.resolutionWidth).toBe(720)
    expect(r.resolutionHeight).toBe(480)
  })

  it('returns null quality label for unlabelled file', () => {
    const r = parseFilename('Movie Name (2020).mkv')
    expect(r.qualityLabel).toBeNull()
    expect(r.resolutionWidth).toBeNull()
    expect(r.resolutionHeight).toBeNull()
  })
})

describe('parseFilename — codec extraction', () => {
  it('detects x264', () => {
    const r = parseFilename('Movie.2020.1080p.BluRay.x264.mkv')
    expect(r.videoCodec).toBe('H.264')
  })

  it('detects x265', () => {
    const r = parseFilename('Movie.2020.1080p.BluRay.x265.mkv')
    expect(r.videoCodec).toBe('H.265')
  })

  it('detects HEVC as H.265', () => {
    const r = parseFilename('Movie.2020.1080p.HEVC.mkv')
    expect(r.videoCodec).toBe('H.265')
  })

  it('detects AAC audio codec', () => {
    const r = parseFilename('Movie.2020.1080p.x264.AAC.mkv')
    expect(r.audioCodec).toBe('AAC')
  })

  it('detects DTS audio codec', () => {
    const r = parseFilename('Movie.2020.1080p.x265.DTS.mkv')
    expect(r.audioCodec).toBe('DTS')
  })

  it('extracts container from extension', () => {
    const r = parseFilename('Movie.2020.mkv')
    expect(r.container).toBe('mkv')
  })

  it('extracts mp4 container', () => {
    const r = parseFilename('Movie.2020.mp4')
    expect(r.container).toBe('mp4')
  })
})
