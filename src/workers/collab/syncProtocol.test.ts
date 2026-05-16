import { describe, it, expect } from 'vitest'
import { MSG, encodeMessage, decodeMessage, encodeLoadReply, decodeLoadReply } from './syncProtocol'

describe('syncProtocol', () => {
  it('encodeMessage / decodeMessage round-trip', () => {
    const payload = new Uint8Array([9, 8, 7])
    const frame = encodeMessage(MSG.PUSH, payload)
    const decoded = decodeMessage(frame)
    expect(decoded.type).toBe(MSG.PUSH)
    expect([...decoded.payload]).toEqual([9, 8, 7])
  })

  it('空 payload 也能 round-trip', () => {
    const decoded = decodeMessage(encodeMessage(MSG.AUTH_OK, new Uint8Array()))
    expect(decoded.type).toBe(MSG.AUTH_OK)
    expect(decoded.payload.length).toBe(0)
  })

  it('encodeLoadReply / decodeLoadReply 拆分两段', () => {
    const missing = new Uint8Array([1, 2, 3, 4, 5])
    const sv = new Uint8Array([6, 7])
    const { missing: m, stateVector: s } = decodeLoadReply(encodeLoadReply(missing, sv))
    expect([...m]).toEqual([1, 2, 3, 4, 5])
    expect([...s]).toEqual([6, 7])
  })
})
