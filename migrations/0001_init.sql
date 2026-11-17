-- AI 文字冒险游戏 · 核心数据表
-- 对应需求文档「表 4 核心数据表」

CREATE TABLE IF NOT EXISTS user (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'anonymous',   -- anonymous | account
  token       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_token ON user(token);

CREATE TABLE IF NOT EXISTS story_template (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  worldview     TEXT NOT NULL,
  initial_state TEXT NOT NULL,   -- JSON
  endings       TEXT NOT NULL,   -- JSON
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_session (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  template_id TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  state_json  TEXT NOT NULL,     -- JSON：当前状态
  version     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'playing',   -- playing | ended
  ending_json TEXT,              -- JSON：结局内容
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user ON game_session(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_status ON game_session(status);

CREATE TABLE IF NOT EXISTS game_turn (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  turn_no      INTEGER NOT NULL,
  player_input TEXT NOT NULL,
  ai_raw       TEXT NOT NULL,
  state_after  TEXT NOT NULL,   -- JSON
  degraded     INTEGER NOT NULL DEFAULT 0,   -- 1 = 走了兜底文案
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_session_no ON game_turn(session_id, turn_no);
