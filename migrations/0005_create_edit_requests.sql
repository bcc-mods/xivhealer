-- 申请开关:每条时间轴是否允许他人申请编辑权限
ALTER TABLE timelines ADD COLUMN allow_edit_requests INTEGER NOT NULL DEFAULT 0;

-- 编辑者列表需展示用户名(原表无此列)
ALTER TABLE timeline_editors ADD COLUMN user_name TEXT NOT NULL DEFAULT '';

-- 待处理的编辑权限申请。只存 pending 状态:通过/拒绝即删行。
CREATE TABLE IF NOT EXISTS timeline_edit_requests (
  timeline_id TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  user_name   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (timeline_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_edit_requests_timeline
  ON timeline_edit_requests (timeline_id);
