import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from './uiStore'

describe('uiStore - canvasTool', () => {
  beforeEach(() => useUIStore.setState({ canvasTool: 'pan' }))

  it('默认是 pan', () => {
    expect(useUIStore.getState().canvasTool).toBe('pan')
  })

  it('setCanvasTool 切换到 select', () => {
    useUIStore.getState().setCanvasTool('select')
    expect(useUIStore.getState().canvasTool).toBe('select')
  })
})
