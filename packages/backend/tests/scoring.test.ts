import { describe, it, expect } from 'vitest'
import { scoreCandidate, MATCH_THRESHOLD } from '../src/services/metadata/scoring'
import type { MetadataCandidate } from '../src/services/metadata/types'

function makeCandidate(title: string, year?: number): MetadataCandidate {
  return {
    providerId: 'tmdb',
    externalId: '1',
    title,
    year,
    score: 0,
  }
}

describe('scoreCandidate', () => {
  // ─── Exact title match ────────────────────────────────────────────────────────

  it('exact title match (no year) returns score >= 0.85', () => {
    const s = scoreCandidate(makeCandidate('The Matrix'), { title: 'The Matrix' })
    expect(s).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
  })

  it('exact title match with matching year returns score >= 0.9', () => {
    const s = scoreCandidate(makeCandidate('The Matrix', 1999), { title: 'The Matrix', year: 1999 })
    expect(s).toBeGreaterThanOrEqual(0.9)
  })

  it('exact title match returns score <= 1.0', () => {
    const s = scoreCandidate(makeCandidate('The Matrix', 1999), { title: 'The Matrix', year: 1999 })
    expect(s).toBeLessThanOrEqual(1.0)
  })

  // ─── Close match ──────────────────────────────────────────────────────────────

  it('close title match with matching year returns score >= 0.85', () => {
    // Same title + same year = very high confidence
    const s = scoreCandidate(makeCandidate('Inception', 2010), { title: 'Inception', year: 2010 })
    expect(s).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
  })

  it('very close title match with year match reaches threshold', () => {
    const s = scoreCandidate(
      makeCandidate('The Dark Knight', 2008),
      { title: 'The Dark Knight', year: 2008 }
    )
    expect(s).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
  })

  // ─── Wrong title ──────────────────────────────────────────────────────────────

  it('completely wrong title returns score below 0.5', () => {
    const s = scoreCandidate(makeCandidate('Frozen'), { title: 'The Matrix' })
    expect(s).toBeLessThan(0.5)
  })

  it('partially overlapping title but different movie stays below threshold', () => {
    // "The Matrix" vs "The Phantom Menace" — some overlap ("the") but low
    const s = scoreCandidate(makeCandidate('The Phantom Menace', 1999), { title: 'The Matrix', year: 1999 })
    expect(s).toBeLessThan(MATCH_THRESHOLD)
  })

  // ─── Year mismatch ────────────────────────────────────────────────────────────

  it('year mismatch by 2+ penalizes score vs exact year match', () => {
    const withCorrectYear = scoreCandidate(
      makeCandidate('Dune', 2021),
      { title: 'Dune', year: 2021 }
    )
    const withWrongYear = scoreCandidate(
      makeCandidate('Dune', 2017),
      { title: 'Dune', year: 2021 }
    )
    expect(withCorrectYear).toBeGreaterThan(withWrongYear)
  })

  it('year mismatch by exactly 1 gives partial bonus', () => {
    const exact = scoreCandidate(makeCandidate('Dune', 2021), { title: 'Dune', year: 2021 })
    const off1 = scoreCandidate(makeCandidate('Dune', 2022), { title: 'Dune', year: 2021 })
    const off2 = scoreCandidate(makeCandidate('Dune', 2019), { title: 'Dune', year: 2021 })
    expect(exact).toBeGreaterThan(off1)
    expect(off1).toBeGreaterThan(off2)
  })

  it('missing candidate year with matching query year gets 0 year bonus', () => {
    const withYear = scoreCandidate(makeCandidate('Dune', 2021), { title: 'Dune', year: 2021 })
    const noYear = scoreCandidate(makeCandidate('Dune', undefined), { title: 'Dune', year: 2021 })
    expect(withYear).toBeGreaterThan(noYear)
  })

  // ─── Threshold ────────────────────────────────────────────────────────────────

  it('MATCH_THRESHOLD is 0.85', () => {
    expect(MATCH_THRESHOLD).toBe(0.85)
  })

  // ─── Score bounds ─────────────────────────────────────────────────────────────

  it('score is always in [0, 1]', () => {
    const cases = [
      { c: makeCandidate('The Matrix', 1999), q: { title: 'The Matrix', year: 1999 } },
      { c: makeCandidate('Frozen'), q: { title: 'The Dark Knight Rises', year: 2012 } },
      { c: makeCandidate(''), q: { title: '' } },
    ]
    for (const { c, q } of cases) {
      const s = scoreCandidate(c, q)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1.0)
    }
  })
})
