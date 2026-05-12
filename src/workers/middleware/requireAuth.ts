import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../env'
import { verifyToken } from '../jwt'

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const token = header.slice(7)
  const result = await verifyToken(token, c.env.JWT_SECRET)
  if (!result.ok || !result.payload.sub) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const name = (result.payload as { name?: string }).name ?? ''
  c.set('auth', { userId: result.payload.sub, username: name })
  await next()
}
