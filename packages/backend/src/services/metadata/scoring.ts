import type { MetadataCandidate } from './types'

// ─── Token-based title similarity ──────────────────────────────────────────────

function normalizeForComparison(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(s: string): string[] {
  return normalizeForComparison(s).split(' ').filter(Boolean)
}

/**
 * Jaccard token overlap similarity — simple, no external deps.
 * Returns 0-1.
 */
function tokenOverlap(a: string, b: string): number {
  const tokA = new Set(tokenize(a))
  const tokB = new Set(tokenize(b))

  if (tokA.size === 0 && tokB.size === 0) return 1
  if (tokA.size === 0 || tokB.size === 0) return 0

  let intersection = 0
  for (const t of tokA) {
    if (tokB.has(t)) intersection++
  }

  const union = tokA.size + tokB.size - intersection
  return intersection / union
}

/**
 * Simple Levenshtein edit distance for short strings.
 * Used as a tiebreaker / booster over token overlap for partial matches.
 */
function levenshtein(a: string, b: string): number {
  const na = normalizeForComparison(a)
  const nb = normalizeForComparison(b)

  if (na === nb) return 0
  if (na.length === 0) return nb.length
  if (nb.length === 0) return na.length

  const dp: number[][] = Array.from({ length: na.length + 1 }, (_, i) =>
    Array.from({ length: nb.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )

  for (let i = 1; i <= na.length; i++) {
    for (let j = 1; j <= nb.length; j++) {
      if (na[i - 1] === nb[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
  }

  return dp[na.length][nb.length]
}

/**
 * Title similarity score (0-1).
 * Combines token overlap (70%) and normalized edit distance (30%).
 */
function titleSimilarity(query: string, candidate: string): number {
  const normQ = normalizeForComparison(query)
  const normC = normalizeForComparison(candidate)

  if (normQ === normC) return 1.0

  const overlap = tokenOverlap(query, candidate)

  const maxLen = Math.max(normQ.length, normC.length)
  const dist = levenshtein(query, candidate)
  const editSimilarity = maxLen === 0 ? 1 : Math.max(0, 1 - dist / maxLen)

  return overlap * 0.7 + editSimilarity * 0.3
}

// ─── Score candidate ────────────────────────────────────────────────────────────

/**
 * Score a metadata candidate against a query.
 * Returns a value in [0, 1].
 *
 * Thresholds (defined in enrichment.ts, referenced here for documentation):
 *   >= 0.85  → metadata_status = 'matched'
 *   <  0.85  → metadata_status = 'needs_review'
 */
export function scoreCandidate(
  candidate: MetadataCandidate,
  query: { title: string; year?: number }
): number {
  // Exact title match short-circuit
  const normQuery = normalizeForComparison(query.title)
  const normCandidate = normalizeForComparison(candidate.title)
  if (normQuery === normCandidate) {
    // Still apply year bonus
    const yearBonus = computeYearBonus(candidate.year, query.year)
    return Math.min(1.0, 0.9 + yearBonus * 0.1)
  }

  // Title similarity (up to 0.7 base weight)
  const titleScore = titleSimilarity(query.title, candidate.title)

  // Year bonus (up to 0.3 additional)
  const yearBonus = computeYearBonus(candidate.year, query.year)

  const finalScore = titleScore * 0.7 + yearBonus * 0.3

  return Math.min(1.0, finalScore)
}

function computeYearBonus(candidateYear: number | undefined, queryYear: number | undefined): number {
  if (!queryYear || !candidateYear) return 0

  const diff = Math.abs(candidateYear - queryYear)
  if (diff === 0) return 1.0
  if (diff === 1) return 0.5
  return 0
}

// ─── Threshold constants ────────────────────────────────────────────────────────

export const MATCH_THRESHOLD = 0.85
