/**
 * 共享 Popover 组件
 * 三种状态:未登录 / 已登录未发布 / 已发布
 */

import { useState } from 'react'
import { Copy, Check, Loader2, Globe, Upload, CloudUpload, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/store/authStore'
import { useTimelineStore } from '@/store/timelineStore'
import type { Timeline } from '@/types/timeline'
import { publishTimeline } from '@/api/timelineShareApi'
import { IndexedDBDocStore } from '@/collab/storage/IndexedDBDocStore'
import { track } from '@/utils/analytics'

interface SharePopoverProps {
  timeline: Timeline
  /** 是否已发布(editor 模式) */
  isPublished: boolean
  viewMode: 'timeline' | 'table'
  /** 发布成功(参数为服务端最终 id,可能被清洗变更) */
  onPublished: (newId: string) => void
}

const SHARE_BASE_URL = window.location.origin

export default function SharePopover({
  timeline,
  isPublished,
  viewMode,
  onPublished,
}: SharePopoverProps) {
  const { isLoggedIn, login } = useAuth()
  const accessToken = useAuthStore(s => s.accessToken)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const shareUrl = isPublished
    ? `${SHARE_BASE_URL}/timeline/${timeline.id}${viewMode === 'table' ? '?view=table' : ''}`
    : ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('复制失败,请手动复制链接')
    }
  }

  const handlePublish = async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const engine = useTimelineStore.getState().engine
      if (!engine) throw new Error('引擎未就绪')
      await engine.flush()
      const { id: newId } = await publishTimeline(timeline.id, timeline.name)
      const store = new IndexedDBDocStore()
      await store.open()
      if (newId !== timeline.id) {
        await store.rekey(timeline.id, newId)
      }
      const meta = await store.getMeta(newId)
      if (meta) await store.putMeta({ ...meta, published: true })
      await useTimelineStore.getState().applyPublishResult(newId)
      track('timeline-publish', { encounterId: timeline.encounter?.id })
      onPublished(newId)
      toast.success('发布成功')
    } catch (err) {
      toast.error(`发布失败:${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认发布时间轴</AlertDialogTitle>
            <AlertDialogDescription>
              发布后,互联网上获得链接的人都能够访问该时间轴。被加入编辑者名单的人可以协同编辑。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handlePublish}>确认发布</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 font-normal whitespace-nowrap"
          >
            {isPublished ? <Globe className="w-4 h-4" /> : <CloudUpload className="w-4 h-4" />}
            <span className="hidden lg:inline">共享</span>
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-80" align="end">
          <div className="space-y-3">
            <div>
              <h4 className="font-medium text-sm">共享时间轴</h4>
              <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                {!isLoggedIn ? (
                  <>
                    <Lock className="w-3.5 h-3.5 shrink-0" />
                    <span>需要登录才能共享时间轴</span>
                  </>
                ) : isPublished ? (
                  <>
                    <Globe className="w-3.5 h-3.5 shrink-0" />
                    <span>时间轴已发布,获得链接的人可阅读</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-3.5 h-3.5 shrink-0" />
                    <span>时间轴未共享,仅本设备可查看</span>
                  </>
                )}
              </div>
            </div>
            {!isLoggedIn ? (
              <div className="space-y-3">
                <Button className="w-full" onClick={login}>
                  登录 FFLogs
                </Button>
              </div>
            ) : !isPublished ? (
              <div className="space-y-3">
                <Button
                  variant="default"
                  className="w-full"
                  onClick={() => setConfirmOpen(true)}
                  disabled={loading}
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  发布
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 px-2 py-1 text-xs border rounded bg-muted font-mono truncate"
                  />
                  <Button variant="outline" size="sm" onClick={handleCopy}>
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">改动会实时同步,无需手动保存。</p>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
