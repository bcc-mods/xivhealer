import { describe, it, expect } from 'vitest'
import { generateObjectId } from './shortId'

describe('shortId', () => {
  it('generateObjectId 返回 10 位纯字母数字 id', () => {
    const id = generateObjectId()
    expect(id).toMatch(/^[0-9A-Za-z]{10}$/)
  })

  it('连续调用返回唯一 id', () => {
    const ids = Array.from({ length: 1000 }, () => generateObjectId())
    expect(new Set(ids).size).toBe(ids.length)
  })
})
