/**
 * Encryption tests for API key encryption/decryption.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { encryptApiKey, decryptApiKey, maskApiKey } from '../src/services/integrations/encryption'

describe('API key encryption', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `helix-enc-test-${crypto.randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('encryptApiKey produces non-plaintext output', () => {
    const plaintext = 'super-secret-api-key-1234'
    const encrypted = encryptApiKey(plaintext, testDir)
    expect(encrypted).not.toBe(plaintext)
    expect(encrypted).not.toContain(plaintext)
    // Should be "iv:authTag:ciphertext" format
    expect(encrypted.split(':').length).toBe(3)
  })

  it('decryptApiKey recovers original value', () => {
    const plaintext = 'super-secret-api-key-abcdef'
    const encrypted = encryptApiKey(plaintext, testDir)
    const decrypted = decryptApiKey(encrypted, testDir)
    expect(decrypted).toBe(plaintext)
  })

  it('two encryptions of the same value produce different ciphertext (IV randomness)', () => {
    const plaintext = 'same-key-value-xyz'
    const enc1 = encryptApiKey(plaintext, testDir)
    const enc2 = encryptApiKey(plaintext, testDir)
    expect(enc1).not.toBe(enc2)
    // Both should decrypt correctly
    expect(decryptApiKey(enc1, testDir)).toBe(plaintext)
    expect(decryptApiKey(enc2, testDir)).toBe(plaintext)
  })

  it('plaintext never appears in encrypted string', () => {
    const plaintext = 'my-radarr-api-key-12345'
    const encrypted = encryptApiKey(plaintext, testDir)
    // The encrypted output should not contain the plaintext in any recognizable form
    expect(encrypted).not.toContain(plaintext)
    // Also verify plaintext is not in the hex-encoded parts
    const parts = encrypted.split(':')
    for (const part of parts) {
      expect(Buffer.from(part, 'hex').toString('utf8')).not.toBe(plaintext)
    }
  })

  it('key file is created in dataDir if missing', () => {
    const keyFile = join(testDir, '.helix_key')
    expect(existsSync(keyFile)).toBe(false)
    // Calling encrypt should create the key file
    encryptApiKey('test-key', testDir)
    expect(existsSync(keyFile)).toBe(true)
  })
})

describe('maskApiKey', () => {
  it('masks middle of key showing first 4 and last 4', () => {
    const key = 'abcd1234efgh5678'
    const masked = maskApiKey(key)
    expect(masked.startsWith('abcd')).toBe(true)
    expect(masked.endsWith('5678')).toBe(true)
    expect(masked).toContain('*')
  })

  it('masks short keys completely', () => {
    const key = 'short'
    const masked = maskApiKey(key)
    expect(masked).toBe('*****')
  })

  it('masks 9-char key with one asterisk in middle', () => {
    const key = '123456789'
    const masked = maskApiKey(key)
    expect(masked.startsWith('1234')).toBe(true)
    expect(masked.endsWith('6789')).toBe(true)
    expect(masked).toContain('*')
  })
})
