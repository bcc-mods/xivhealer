/** 内容编辑是否只读 —— useEditLock 的便捷别名，内容类组件沿用 */
import { useEditLock } from './useEditLock'

export function useEditorReadOnly(): boolean {
  return !useEditLock().can('content')
}
