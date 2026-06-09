import { describe, it, expect } from 'vitest'
import { normalizeActionId } from './normalizeActionId'

describe('normalizeActionId', () => {
  it('子变体 id 归一为父 trackGroup id', () => {
    // 37016 降临之章 trackGroup:37013 意气轩昂之策
    expect(normalizeActionId(37016)).toBe(37013)
  })
  it('父 id 原样返回', () => {
    expect(normalizeActionId(37013)).toBe(37013)
  })
  it('未知 id 原样返回(不在注册表)', () => {
    expect(normalizeActionId(999999)).toBe(999999)
  })
})
