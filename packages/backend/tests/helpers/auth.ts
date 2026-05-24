/**
 * Auth helpers for tests.
 * Sets up a user with a password and returns a session cookie for use in inject() calls.
 */
import type { FastifyInstance } from 'fastify'
import type { DrizzleDB } from '../../src/db/client'
import { COOKIE_NAME } from '../../src/middleware/auth'

const TEST_USERNAME = 'testadmin'
const TEST_PASSWORD = 'testpassword123'

/**
 * Set up auth: call /api/v1/auth/setup to register the first user,
 * returns the session cookie string to include in subsequent requests.
 */
export async function setupAuth(
  app: FastifyInstance
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      displayName: 'Test Admin',
    },
  })

  if (res.statusCode !== 200) {
    throw new Error(`Auth setup failed: ${res.statusCode} ${res.body}`)
  }

  // Extract cookie from Set-Cookie header
  const setCookie = res.headers['set-cookie']
  if (!setCookie) {
    throw new Error('No set-cookie header in auth setup response')
  }

  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie
  // Extract just the cookie value part (e.g. "helix_session=abc123; ...")
  const match = cookieStr.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  if (!match) {
    throw new Error(`Could not find ${COOKIE_NAME} in set-cookie header`)
  }

  return `${COOKIE_NAME}=${match[1]}`
}

/**
 * Login with test credentials, returns the session cookie string.
 */
export async function loginAuth(
  app: FastifyInstance
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    },
  })

  if (res.statusCode !== 200) {
    throw new Error(`Auth login failed: ${res.statusCode} ${res.body}`)
  }

  const setCookie = res.headers['set-cookie']
  if (!setCookie) {
    throw new Error('No set-cookie header in auth login response')
  }

  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie
  const match = cookieStr.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  if (!match) {
    throw new Error(`Could not find ${COOKIE_NAME} in set-cookie header`)
  }

  return `${COOKIE_NAME}=${match[1]}`
}
