'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { buildState } = require('./model');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  charter_title TEXT NOT NULL DEFAULT '社团章程',
  schedule_revision INTEGER NOT NULL DEFAULT 0  -- 排程修订号：任一待生效版本入队/改期/取消后递增
);

-- 已发布版本（内容快照不可变；生效排程字段可在生效前改期/取消）
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,                  -- 版本快照生成时刻（发布即冻结）
  effective_at TEXT NOT NULL,               -- UTC 生效时刻（ISO8601）；生效前可随改期更新
  schedule_status TEXT NOT NULL DEFAULT 'immediate', -- immediate | scheduled | cancelled
  note TEXT NOT NULL DEFAULT '',
  baseline_id INTEGER REFERENCES versions(id),
  draft_id INTEGER,
  moved_keys TEXT NOT NULL DEFAULT '[]'  -- 相对版本基线被显式移动过的条款标识
);

CREATE TABLE IF NOT EXISTS version_clauses (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  ordinal INTEGER NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (version_id, ordinal),
  UNIQUE (version_id, key)
);

CREATE TABLE IF NOT EXISTS version_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);

-- 草案
-- revision：草案修订号（乐观锁）。任一次被记录的编辑、重命名、撤销、重做都使其递增；
--           校验失败/无实际改动的请求不递增。撤销/重做必须携带读取时的修订号。
-- history_pos：当前状态对应的历史操作序号（1 = 创建操作后的状态）；新编辑会截断其后的重做分支。
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  baseline_id INTEGER NOT NULL REFERENCES versions(id),
  created_from TEXT NOT NULL DEFAULT 'draft', -- initial | draft
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | published
  moved_keys TEXT NOT NULL DEFAULT '[]',     -- 草案中被显式移动过的条款标识
  revision INTEGER NOT NULL DEFAULT 1,
  history_pos INTEGER NOT NULL DEFAULT 0
);

-- 草案操作历史（持久、可追溯；撤销/重做只移动游标，不删除记录；新编辑截断重做分支）
CREATE TABLE IF NOT EXISTS draft_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  seq INTEGER NOT NULL,                        -- 草案内操作序号，从 1 开始
  kind TEXT NOT NULL,                          -- create | clause-add | clause-edit | clause-delete | clause-move | ref-add | ref-delete | rename
  summary TEXT NOT NULL,                       -- 人类可读摘要
  detail TEXT,                                 -- 结构化细节（JSON，可为 NULL）
  snapshot TEXT NOT NULL,                      -- 该操作完成后的完整快照（名称/顺序/条款/引用/显式移动记录）
  created_at TEXT NOT NULL,
  UNIQUE (draft_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_draft_ops ON draft_operations(draft_id);

CREATE TABLE IF NOT EXISTS draft_clauses (
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  ordinal INTEGER NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (draft_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_draft_clauses_draft ON draft_clauses(draft_id);

CREATE TABLE IF NOT EXISTS draft_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_draft_refs_draft ON draft_refs(draft_id);

-- 发布预览凭据：预览成功后落库，确认发布时逐项核对；不产生版本、不关闭草案。
-- 任一行失效条件（草案被编辑/重命名、其他草案先发布、排程改期/取消、预定时刻已过、
-- 被更新的预览取代）都能通过表中记录的快照在确认事务内检出。
CREATE TABLE IF NOT EXISTS preview_tokens (
  token TEXT PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  created_at TEXT NOT NULL,
  latest_version_id INTEGER NOT NULL,          -- 预览时的最新发布版
  schedule_revision INTEGER NOT NULL,          -- 预览时的排程修订号
  note TEXT NOT NULL,
  schedule_status TEXT NOT NULL,               -- immediate | scheduled
  effective_at TEXT,                           -- scheduled 时的 UTC 时刻；immediate 为 NULL
  replayed INTEGER NOT NULL DEFAULT 0,
  draft_content TEXT NOT NULL,                 -- 草案内容（含名称/移动记录）规范化 JSON
  final_content TEXT NOT NULL,                 -- 将落库的最终版本（条款/顺序/引用/移动记录）规范化 JSON
  consumed INTEGER NOT NULL DEFAULT 0          -- 确认发布成功后置 1
);
CREATE INDEX IF NOT EXISTS idx_preview_draft ON preview_tokens(draft_id);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // 并发 BEGIN IMMEDIATE 时短暂等待写锁
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// 轻量迁移：为早期库补齐后加的列
function migrate(db) {
  const addColumnIfMissing = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  addColumnIfMissing('versions', 'moved_keys', "moved_keys TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('drafts', 'moved_keys', "moved_keys TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('versions', 'effective_at', 'effective_at TEXT');
  addColumnIfMissing('versions', 'schedule_status', "schedule_status TEXT NOT NULL DEFAULT 'immediate'");
  addColumnIfMissing('meta', 'schedule_revision', 'schedule_revision INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('drafts', 'revision', 'revision INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('drafts', 'history_pos', 'history_pos INTEGER NOT NULL DEFAULT 0');
  // 早期草案回填操作历史：每个草案补一条“创建草案”快照（旧草案即从该状态起可撤销/重做）。
  const orphanDrafts = db
    .prepare(
      `SELECT d.id AS id, d.name AS name FROM drafts d
       LEFT JOIN draft_operations o ON o.draft_id = d.id
       WHERE o.id IS NULL`,
    )
    .all();
  for (const d of orphanDrafts) {
    const st = loadDraftState(db, d.id);
    const moved = loadDraftMoved(db, d.id);
    const row = db.prepare('SELECT created_at FROM drafts WHERE id = ?').get(d.id);
    insertDraftOperation(db, {
      draftId: d.id,
      seq: 1,
      kind: 'create',
      summary: `创建草案「${d.name}」`,
      detail: null,
      snapshot: draftSnapshotJson(d.name, st, moved),
      createdAt: row.created_at,
    });
    db.prepare('UPDATE drafts SET history_pos = 1 WHERE id = ?').run(d.id);
  }
  // 早期库回填（仅当存在没有生效时刻的旧版本行时执行一次）：
  // 已存在版本按创建时刻即时生效。
  const legacy = db.prepare('SELECT COUNT(*) AS n FROM versions WHERE effective_at IS NULL OR effective_at = ?').get('');
  if (legacy.n > 0) {
    db.exec(
      `UPDATE versions SET effective_at = created_at WHERE effective_at IS NULL OR effective_at = '';
       UPDATE versions SET schedule_status = 'immediate'
         WHERE schedule_status IS NULL OR schedule_status = '';`,
    );
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------
function loadVersionState(db, versionId) {
  const clauses = db
    .prepare('SELECT key, title, body FROM version_clauses WHERE version_id = ? ORDER BY ordinal')
    .all(versionId);
  const refs = db
    .prepare('SELECT source, target, label FROM version_refs WHERE version_id = ? ORDER BY ordinal')
    .all(versionId);
  return buildState({
    order: clauses.map((c) => c.key),
    clauses,
    edges: refs,
  });
}

function loadDraftState(db, draftId) {
  const rows = db
    .prepare('SELECT key, title, body, deleted FROM draft_clauses WHERE draft_id = ? ORDER BY ordinal')
    .all(draftId);
  const live = rows.filter((r) => !r.deleted);
  const refs = db
    .prepare('SELECT source, target, label FROM draft_refs WHERE draft_id = ? AND deleted = 0 ORDER BY ordinal')
    .all(draftId);
  return buildState({
    order: live.map((r) => r.key),
    clauses: live.map((r) => ({ key: r.key, title: r.title, body: r.body })),
    edges: refs,
  });
}

const VERSION_COLS = 'id, created_at, effective_at, schedule_status, note, baseline_id, draft_id, moved_keys';

function getVersionMeta(db, versionId) {
  const row = db.prepare(`SELECT ${VERSION_COLS} FROM versions WHERE id = ?`).get(versionId);
  if (row) row.moved_keys = JSON.parse(row.moved_keys || '[]');
  return row;
}

function listVersions(db) {
  return db
    .prepare(`SELECT ${VERSION_COLS} FROM versions ORDER BY id`)
    .all()
    .map((row) => ({ ...row, moved_keys: JSON.parse(row.moved_keys || '[]') }));
}

function listDrafts(db) {
  return db
    .prepare(
      `SELECT d.id, d.name, d.baseline_id, d.created_at, d.updated_at, d.status,
              (SELECT COUNT(*) FROM draft_clauses WHERE draft_id = d.id AND deleted = 0) AS clause_count
       FROM drafts d ORDER BY d.id`,
    )
    .all();
}

function getDraftMeta(db, draftId) {
  const row = db
    .prepare(
      'SELECT id, name, baseline_id, created_at, updated_at, status, moved_keys, revision, history_pos FROM drafts WHERE id = ?',
    )
    .get(draftId);
  if (row) row.moved_keys = JSON.parse(row.moved_keys || '[]');
  return row;
}

function loadDraftMoved(db, draftId) {
  const row = db.prepare('SELECT moved_keys FROM drafts WHERE id = ?').get(draftId);
  return new Set(row ? JSON.parse(row.moved_keys || '[]') : []);
}

function saveDraftMoved(db, draftId, movedSet) {
  db.prepare('UPDATE drafts SET moved_keys = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify([...movedSet]),
    nowIso(),
    draftId,
  );
}

// ---------------------------------------------------------------------------
// 草案操作历史（调用方负责事务）
// ---------------------------------------------------------------------------
// 操作完成后的完整快照：恢复时一次性还原名称、条款顺序、标题正文、引用与显式移动记录。
function draftSnapshotJson(name, state, movedSet) {
  return JSON.stringify({
    name,
    moved: [...movedSet],
    order: state.order,
    clauses: state.order.map((k) => {
      const c = state.clauses.get(k);
      return { key: c.key, title: c.title, body: c.body };
    }),
    edges: state.edges.map((e) => ({ source: e.source, target: e.target, label: e.label || '' })),
  });
}

function parseDraftSnapshot(json) {
  const s = JSON.parse(json);
  return {
    name: s.name,
    movedSet: new Set(s.moved || []),
    state: buildState({
      order: s.order,
      clauses: s.clauses,
      edges: s.edges || [],
    }),
  };
}

function insertDraftOperation(db, { draftId, seq, kind, summary, detail, snapshot, createdAt }) {
  const ts = createdAt || nowIso();
  db.prepare(
    `INSERT INTO draft_operations (draft_id, seq, kind, summary, detail, snapshot, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(draftId, seq, kind, summary, detail ? JSON.stringify(detail) : null, snapshot, ts);
  return ts;
}

function listDraftOperations(db, draftId) {
  const rows = db
    .prepare('SELECT id, seq, kind, summary, detail, created_at FROM draft_operations WHERE draft_id = ? ORDER BY seq')
    .all(draftId);
  for (const r of rows) r.detail = r.detail ? JSON.parse(r.detail) : null;
  return rows;
}

function getDraftOperation(db, draftId, seq) {
  const row = db
    .prepare('SELECT id, seq, kind, summary, detail, snapshot, created_at FROM draft_operations WHERE draft_id = ? AND seq = ?')
    .get(draftId, seq);
  if (row) row.detail = row.detail ? JSON.parse(row.detail) : null;
  return row || null;
}

function maxDraftOperationSeq(db, draftId) {
  const row = db.prepare('SELECT MAX(seq) AS s FROM draft_operations WHERE draft_id = ?').get(draftId);
  return row.s || 0;
}

// 丢弃重做分支：删除序号大于 pos 的全部操作记录。
function truncateDraftOperationsAfter(db, draftId, pos) {
  db.prepare('DELETE FROM draft_operations WHERE draft_id = ? AND seq > ?').run(draftId, pos);
}

// 按历史快照整体恢复草案（名称/顺序/条款正文/引用/显式移动记录），并推进游标与修订号。
function restoreDraftSnapshot(db, draftId, seq, snapshot) {
  const parsed = parseDraftSnapshot(snapshot);
  replaceDraftContent(db, draftId, parsed.state);
  const ts = nowIso();
  db.prepare(
    `UPDATE drafts
       SET name = ?, moved_keys = ?, history_pos = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(parsed.name, JSON.stringify([...parsed.movedSet]), seq, ts, draftId);
  return parsed;
}

// 追加一次新编辑后的状态：写操作记录、截断重做分支、推进游标与修订号。
function appendDraftOperation(db, { draftId, kind, summary, detail, name, state, movedSet }) {
  const maxSeq = maxDraftOperationSeq(db, draftId);
  const posRow = db.prepare('SELECT history_pos AS p FROM drafts WHERE id = ?').get(draftId);
  const pos = posRow.p;
  // 撤销后再编辑：舍弃重做分支
  if (maxSeq > pos) truncateDraftOperationsAfter(db, draftId, pos);
  const seq = pos + 1;
  const snapshot = draftSnapshotJson(name, state, movedSet);
  const ts = insertDraftOperation(db, { draftId, seq, kind, summary, detail, snapshot });
  // 持久化当前内容（条款/引用表），再推进游标与修订号
  replaceDraftContent(db, draftId, state);
  db.prepare(
    `UPDATE drafts
       SET name = ?, moved_keys = ?, history_pos = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(name, JSON.stringify([...movedSet]), seq, ts, draftId);
  return { seq, ts, snapshot };
}

// ---------------------------------------------------------------------------
// 排程修订号（乐观并发控制：读取时携带，任何队列变动后递增）
// ---------------------------------------------------------------------------
function getScheduleRevision(db) {
  const row = db.prepare('SELECT schedule_revision AS r FROM meta WHERE id = 1').get();
  return row ? row.r : 0;
}

function bumpScheduleRevision(db) {
  db.prepare(
    `INSERT INTO meta (id, schedule_revision) VALUES (1, 1)
     ON CONFLICT(id) DO UPDATE SET schedule_revision = schedule_revision + 1`,
  ).run();
  return getScheduleRevision(db);
}

// ---------------------------------------------------------------------------
// 写入（调用方负责事务）
// ---------------------------------------------------------------------------
function insertVersion(db, { note, baselineId, draftId, state, movedKeys = [], effectiveAt, scheduleStatus }) {
  const ts = nowIso();
  const effAt = effectiveAt || ts;
  const status = scheduleStatus || 'immediate';
  const info = db
    .prepare(
      'INSERT INTO versions (created_at, effective_at, schedule_status, note, baseline_id, draft_id, moved_keys) VALUES (?,?,?,?,?,?,?)',
    )
    .run(ts, effAt, status, note || '', baselineId ?? null, draftId ?? null, JSON.stringify([...movedKeys]));
  const versionId = info.lastInsertRowid;
  const insC = db.prepare(
    'INSERT INTO version_clauses (version_id, ordinal, key, title, body) VALUES (?,?,?,?,?)',
  );
  const insR = db.prepare(
    'INSERT INTO version_refs (version_id, ordinal, source, target, label) VALUES (?,?,?,?,?)',
  );
  state.order.forEach((key, i) => {
    const c = state.clauses.get(key);
    insC.run(versionId, i, key, c.title, c.body);
  });
  state.edges.forEach((e, i) => {
    insR.run(versionId, i, e.source, e.target, e.label || '');
  });
  return versionId;
}

function snapshotDraft(db, draftIdUnused, baselineId, name, state, { from, movedKeys = [] } = {}) {
  const ts = nowIso();
  const info = db
    .prepare(
      'INSERT INTO drafts (name, baseline_id, created_from, created_at, updated_at, moved_keys, revision, history_pos) VALUES (?,?,?,?,?,?,1,0)',
    )
    .run(name, baselineId, from || 'draft', ts, ts, JSON.stringify([...movedKeys]));
  const id = info.lastInsertRowid;
  replaceDraftContent(db, id, state);
  const movedSet = new Set(movedKeys);
  insertDraftOperation(db, {
    draftId: id,
    seq: 1,
    kind: 'create',
    summary: `创建草案「${name}」`,
    detail: { baseline_id: baselineId },
    snapshot: draftSnapshotJson(name, state, movedSet),
    createdAt: ts,
  });
  db.prepare('UPDATE drafts SET history_pos = 1, updated_at = ? WHERE id = ?').run(ts, id);
  return id;
}

function replaceDraftContent(db, draftId, state) {
  db.prepare('DELETE FROM draft_clauses WHERE draft_id = ?').run(draftId);
  db.prepare('DELETE FROM draft_refs WHERE draft_id = ?').run(draftId);
  const insC = db.prepare(
    'INSERT INTO draft_clauses (draft_id, ordinal, key, title, body, deleted) VALUES (?,?,?,?,?,0)',
  );
  const insR = db.prepare(
    'INSERT INTO draft_refs (draft_id, ordinal, source, target, label, deleted) VALUES (?,?,?,?,?,0)',
  );
  state.order.forEach((key, i) => {
    const c = state.clauses.get(key);
    insC.run(draftId, i, key, c.title, c.body);
  });
  state.edges.forEach((e, i) => {
    insR.run(draftId, i, e.source, e.target, e.label || '');
  });
  db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(nowIso(), draftId);
}

// ---------------------------------------------------------------------------
// 发布预览凭据（调用方负责事务）
// ---------------------------------------------------------------------------
function insertPreviewToken(db, row) {
  db.prepare(
    `INSERT INTO preview_tokens
       (token, draft_id, created_at, latest_version_id, schedule_revision, note,
        schedule_status, effective_at, replayed, draft_content, final_content, consumed)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
  ).run(
    row.token,
    row.draftId,
    nowIso(),
    row.latestVersionId,
    row.scheduleRevision,
    row.note,
    row.scheduleStatus,
    row.effectiveAt ?? null,
    row.replayed ? 1 : 0,
    row.draftContent,
    row.finalContent,
  );
}

function getPreviewToken(db, token) {
  const row = db.prepare('SELECT * FROM preview_tokens WHERE token = ?').get(token);
  if (!row) return null;
  row.replayed = !!row.replayed;
  row.consumed = !!row.consumed;
  return row;
}

// 同一草案重新预览：旧凭据作废（确认时返回 PREVIEW_SUPERSEDED）。
function supersedePreviewTokens(db, draftId) {
  db.prepare('DELETE FROM preview_tokens WHERE draft_id = ? AND consumed = 0').run(draftId);
}

function markPreviewConsumed(db, token) {
  db.prepare('UPDATE preview_tokens SET consumed = 1 WHERE token = ?').run(token);
}

// 清理陈旧凭据（已消费或早于截止时间），避免无限堆积。
function prunePreviewTokens(db, createdAtCutoff) {
  db.prepare('DELETE FROM preview_tokens WHERE consumed = 1 OR created_at < ?').run(createdAtCutoff);
}

module.exports = {
  openDb,
  nowIso,
  loadVersionState,
  loadDraftState,
  getVersionMeta,
  listVersions,
  listDrafts,
  getDraftMeta,
  insertVersion,
  snapshotDraft,
  replaceDraftContent,
  loadDraftMoved,
  saveDraftMoved,
  getScheduleRevision,
  bumpScheduleRevision,
  insertPreviewToken,
  getPreviewToken,
  supersedePreviewTokens,
  markPreviewConsumed,
  prunePreviewTokens,
  draftSnapshotJson,
  parseDraftSnapshot,
  insertDraftOperation,
  listDraftOperations,
  getDraftOperation,
  maxDraftOperationSeq,
  truncateDraftOperationsAfter,
  restoreDraftSnapshot,
  appendDraftOperation,
};
