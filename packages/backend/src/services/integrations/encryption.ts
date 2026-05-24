import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function getEncryptionKey(dataDir: string): Buffer {
  const envKey = process.env.HELIX_ENCRYPTION_KEY
  if (envKey) {
    // Derive a 32-byte key from the env var using scrypt
    const salt = Buffer.from('helix-integration-key-salt', 'utf8')
    return scryptSync(envKey, salt, KEY_LENGTH) as Buffer
  }

  // Use/create a local key file
  const keyFilePath = join(dataDir, '.helix_key')
  if (existsSync(keyFilePath)) {
    // File stores 64 hex chars as UTF-8 text → decode to 32-byte key
    const raw = readFileSync(keyFilePath, 'utf8').trim()
    return Buffer.from(raw, 'hex')
  }

  // Generate new key and write it
  mkdirSync(dataDir, { recursive: true })
  const newKey = randomBytes(KEY_LENGTH)
  writeFileSync(keyFilePath, newKey.toString('hex'), { mode: 0o600 })
  return newKey
}

/**
 * AES-256-GCM encrypt — returns "iv:authTag:ciphertext" as hex
 */
export function encryptApiKey(plaintext: string, dataDir: string): string {
  const key = getEncryptionKey(dataDir)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * AES-256-GCM decrypt
 */
export function decryptApiKey(encrypted: string, dataDir: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted key format')
  }
  const [ivHex, authTagHex, ciphertextHex] = parts
  const key = getEncryptionKey(dataDir)
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * Mask API key for display: show first 4 + last 4 chars, rest as asterisks
 */
export function maskApiKey(plaintext: string): string {
  if (plaintext.length <= 8) {
    return '*'.repeat(plaintext.length)
  }
  const first = plaintext.slice(0, 4)
  const last = plaintext.slice(-4)
  const masked = '*'.repeat(Math.max(0, plaintext.length - 8))
  return `${first}${masked}${last}`
}
