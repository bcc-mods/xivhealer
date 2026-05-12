import type { Context } from 'hono'
import type { AppEnv } from '../env'
import { verifyToken } from '../jwt'

/**
 * 公开路由可选识别身份。失败时返 null，不改变 c.var。
 */
export async function tryReadAuth(
  c: Context<AppEnv>
): Promise<{ userId: string; username: string } | null> {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ') || !c.env.JWT_SECRET) return null
  const token = header.slice(7)
  const result = await verifyToken(token, c.env.JWT_SECRET)
  if (!result.ok || !result.payload.sub) return null
  const name = (result.payload as { name?: string }).name ?? ''
  return { userId: result.payload.sub, username: name }
}
