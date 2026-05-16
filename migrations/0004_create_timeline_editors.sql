-- 编辑者白名单:(timeline_id, user_id) 决定谁能经 WebSocket 编辑某条时间轴。
-- 本期手工填充 + 发布时自动插入作者(见路由 POST /api/timelines)。
CREATE TABLE IF NOT EXISTS timeline_editors (
  timeline_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (timeline_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_editors_user ON timeline_editors (user_id);
