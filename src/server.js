'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  openDb,
  loadVersionState,
  loadDraftState,
  getVersionMeta,
  listVersions,
  listDrafts,
  getDraftMeta,
  insertVersion,
  snapshotDraft,
  loadDraftMoved,
  getScheduleRevision,
  bumpScheduleRevision,
  insertPreviewToken,
  getPreviewToken,
  supersedePreviewTokens,
  markPreviewConsumed,
  prunePreviewTokens,
  draftSnapshotJson,
  listDraftOperations,
  getDraftOperation,
  restoreDraftSnapshot,
  appendDraftOperation,
  nowIso,
} = require('./db');
const {
  keyError,
  validateState,
  hasBlockingIssues,
  replayDraft,
  diffStates,
  textDiff,
  pickEffectiveVersion,
  pendingVersions,
  scheduleNeighbors,
} = require('./model');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'charter.db');

const db = openDb(DB_PATH);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5 * 1024 * 1024) reject(new Error('BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serializeState(state) {
  return {
    order: state.order,
    clauses: state.order.map((k) => state.clauses.get(k)),
    refs: state.edges.map((e, i) => ({ id: null, ordinal: i, ...e })),
  };
}

function getCharterTitle() {
  const row = db.prepare('SELECT charter_title FROM meta WHERE id = 1').get();
  return row ? row.charter_title : '社团章程';
}

function setCharterTitle(title) {
  db.prepare(
    `INSERT INTO meta (id, charter_title) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET charter_title = excluded.charter_title`,
  ).run(title);
}

function stateEqual(a, b) {
  if (a.order.length !== b.order.length) return false;
  if (a.order.some((k, i) => b.order[i] !== k)) return false;
  const ea = new Set(a.edges.map((e) => `${e.source}->${e.target}#${e.label || ''}`));
  const eb = new Set(b.edges.map((e) => `${e.source}->${e.target}#${e.label || ''}`));
  if (ea.size !== eb.size) return false;
  for (const k of ea) if (!eb.has(k)) return false;
  for (const k of a.order) {
    const x = a.clauses.get(k);
    const y = b.clauses.get(k);
    if (x.title !== y.title || x.body !== y.body) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 规范化快照：预览凭据的核对依据。同内容必产生相同字符串。
// ---------------------------------------------------------------------------
function canonicalState(state) {
  return JSON.stringify({
    order: state.order,
    clauses: state.order.map((k) => {
      const c = state.clauses.get(k);
      return { key: c.key, title: c.title, body: c.body };
    }),
    edges: state.edges.map((e) => ({ source: e.source, target: e.target, label: e.label || '' })),
  });
}

// 草案指纹：名称、条款状态、显式移动记录任一变化即不同（名称改动也使预览失效）。
function draftFingerprint({ name, state, movedSet }) {
  return JSON.stringify({
    name,
    moved: [...movedSet].sort(),
    state: JSON.parse(canonicalState(state)),
  });
}

// 预览时计算“将落库版本”的规范化内容；确认时重算并逐字节比对。
function versionFingerprint({ state, movedSet }) {
  return JSON.stringify({
    moved: [...movedSet].filter((k) => state.clauses.has(k)).sort(),
    state: JSON.parse(canonicalState(state)),
  });
}

function newPreviewToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// 业务处理
// ---------------------------------------------------------------------------
// 解析“UTC 生效时刻”：必须是带明确时区的合法 ISO-8601 时刻。
// 返回 { ok:true, iso }（统一为 UTC ISO 串）或 { ok:false, message }。
function parseEffectiveAt(value, { field = 'effective_at' } = {}) {
  if (typeof value !== 'string') {
    return { ok: false, message: `${field} 必须是 ISO-8601 时间字符串（带 Z 或 ±HH:mm 时区）` };
  }
  const s = value.trim();
  if (!s) return { ok: false, message: `${field} 不能为空` };
  // 仅接受带时区设计符（Z / ±HH:mm / ±HHmm）的时间，拒绝“天真”的本地时间
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    return { ok: false, message: `${field} 必须带 UTC 设计符 Z 或明确时区偏移（如 2026-10-01T08:30:00Z）` };
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return { ok: false, message: `${field} 不是合法的时间` };
  return { ok: true, ms, iso: new Date(ms).toISOString() };
}

// 当前排程快照：当前生效版、待生效队列、排程修订号。
// nowMs 可注入（测试），默认当前时刻。
function buildSchedule({ nowMs = Date.now(), versions = null } = {}) {
  const all = versions || listVersions(db);
  const currentId = pickEffectiveVersion(all, nowMs);
  const pending = pendingVersions(all, nowMs);
  const summary = (v) => ({
    id: v.id,
    note: v.note,
    effective_at: v.effective_at,
    schedule_status: v.schedule_status,
    created_at: v.created_at,
    draft_id: v.draft_id ?? null,
    baseline_id: v.baseline_id ?? null,
  });
  return {
    now: new Date(nowMs).toISOString(),
    schedule_revision: getScheduleRevision(db),
    current_version_id: currentId,
    current: currentId ? summary(all.find((v) => v.id === currentId)) : null,
    pending: pending.map(summary),
    queue_open: pending.length > 0,
  };
}

function apiOverview() {
  const versions = listVersions(db);
  const drafts = listDrafts(db);
  const schedule = buildSchedule({ versions });
  return {
    charter_title: getCharterTitle(),
    initialized: versions.length > 0,
    latest_version_id: versions.length ? versions[versions.length - 1].id : null,
    current_version_id: schedule.current_version_id,
    schedule_revision: schedule.schedule_revision,
    versions,
    drafts,
  };
}

function handleInitial(body) {
  if (listVersions(db).length > 0) {
    return { status: 409, payload: { error: 'ALREADY_INITIALIZED', message: '首版章程已存在，请从已发布版本创建草案' } };
  }
  const title = String(body.charter_title || '社团章程').slice(0, 100);
  const clausesInput = Array.isArray(body.clauses) ? body.clauses : [];
  const refsInput = Array.isArray(body.refs) ? body.refs : [];

  if (!clausesInput.length) {
    return { status: 400, payload: { error: 'EMPTY', message: '至少需要录入一个条款' } };
  }

  const state = inputToState(clausesInput, refsInput);
  if (!state.ok) return { status: 400, payload: { error: 'VALIDATION', issues: state.issues } };

  const issues = validateState(state.state);
  const blocking = issues.filter((i) => i.level === 'error');
  if (blocking.length) {
    return { status: 400, payload: { error: 'VALIDATION', issues: blocking } };
  }

  // 首版也可指定晚于当前时刻的 UTC 生效时刻（队列必为空，无需顺序校验）
  let scheduled = null;
  if (body.effective_at != null && String(body.effective_at).trim() !== '') {
    const parsed = parseEffectiveAt(body.effective_at);
    if (!parsed.ok) return { status: 400, payload: { error: 'VALIDATION', message: parsed.message } };
    if (parsed.ms <= Date.now()) {
      return {
        status: 400,
        payload: { error: 'PAST_EFFECTIVE_AT', message: '未来生效时刻必须晚于当前 UTC 时间' },
      };
    }
    scheduled = parsed;
  }

  const tx = db.transaction(() => {
    setCharterTitle(title);
    const id = insertVersion(db, {
      note: body.note || '首版发布',
      baselineId: null,
      state: state.state,
      effectiveAt: scheduled ? scheduled.iso : undefined,
      scheduleStatus: scheduled ? 'scheduled' : undefined,
    });
    if (scheduled) bumpScheduleRevision(db);
    return id;
  });
  const id = tx();
  return {
    status: 201,
    payload: { version_id: id, ...(scheduled ? { schedule: buildSchedule() } : {}) },
  };
}

function inputToState(clausesInput, refsInput) {
  const issues = [];
  const clauses = [];
  const order = [];
  const seen = new Set();
  clausesInput.forEach((c, i) => {
    const key = String(c.key || '').trim();
    const title = String(c.title || '').trim();
    const text = String(c.body ?? '');
    const kerr = keyError(key);
    if (kerr) issues.push({ code: 'bad-key', ordinal: i, key, message: `标识无效：${kerr}` });
    if (seen.has(key)) issues.push({ code: 'duplicate-key', key, message: `标识重复：${key}` });
    seen.add(key);
    if (!title) issues.push({ code: 'empty-title', key, message: `条款「${key || i}」缺少标题` });
    if (!text.trim()) issues.push({ code: 'empty-body', key, message: `条款「${key || i}」正文为空` });
    order.push(key);
    clauses.push({ key, title, body: text });
  });

  const refs = refsInput.map((r) => ({
    source: String(r.source || '').trim(),
    target: String(r.target || '').trim(),
    label: String(r.label || '').trim(),
  }));

  const { buildState } = require('./model');
  const state = buildState({ order, clauses, edges: refs });
  if (issues.length) return { ok: false, issues };

  const stateIssues = validateState(state).filter((i) => i.level === 'error');
  if (stateIssues.length) return { ok: false, issues: stateIssues };
  return { ok: true, state };
}

function handleCreateDraft(body) {
  const versions = listVersions(db);
  if (!versions.length) {
    return { status: 409, payload: { error: 'NO_VERSION', message: '还没有已发布版本，请先录入首版章程' } };
  }
  const baselineId = parseInt(body.baseline_id, 10) || versions[versions.length - 1].id;
  const meta = getVersionMeta(db, baselineId);
  if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '基线版本不存在' } };
  const name = String(body.name || '').trim() || `基于 v${baselineId} 的草案`;

  const state = loadVersionState(db, baselineId);
  const draftId = snapshotDraft(db, null, baselineId, name, state);
  return { status: 201, payload: draftDetail(draftId) };
}

function draftDetail(draftId, { withTextDiff = false } = {}) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return null;
  const state = loadDraftState(db, draftId);
  const baseline = loadVersionState(db, meta.baseline_id);
  const issues = validateState(state);
  const movedSet = new Set(meta.moved_keys.filter((k) => state.clauses.has(k)));
  const diff = diffStates(baseline, state, movedSet);
  const detail = {
    ...meta,
    clauses: state.order.map((k, i) => ({ ordinal: i, ...state.clauses.get(k) })),
    refs: state.edges.map((e, i) => ({ ordinal: i, ...e })),
    issues,
    publishable: !hasBlockingIssues(issues),
    diff: summarizeDiff(diff),
  };
  if (withTextDiff) {
    detail.diff.changed_detail = diff.changed.map((c) => {
      const b = baseline.clauses.get(c.key);
      const d = state.clauses.get(c.key);
      return {
        ...c,
        titleSegments: c.body || b.title !== d.title ? textDiff(b.title, d.title) : null,
        bodySegments: c.body ? textDiff(b.body, d.body) : null,
        oldRefs: baseline.edges.filter((e) => e.source === c.key),
        newRefs: state.edges.filter((e) => e.source === c.key),
      };
    });
    detail.diff.refs_added = diff.refsAdded;
    detail.diff.refs_removed = diff.refsRemoved;
  }
  return detail;
}

function summarizeDiff(diff) {
  return {
    added: diff.added,
    deleted: diff.deleted,
    changed: diff.changed,
    moved: diff.moved,
    refs_added_count: diff.refsAdded.length,
    refs_removed_count: diff.refsRemoved.length,
  };
}

// ---------------------------------------------------------------------------
// 草案编辑
// ---------------------------------------------------------------------------
// fn(state, movedSet) 可直接修改条款状态与显式移动集合；
// 校验失败返回 { error:true, payload }，不产生操作记录、不推进草案修订号；
// 成功且内容确有变化时，在同一事务内写入一条持久操作记录（含完整快照），
// 撤销后再编辑会截断重做分支。
// opts.kind / opts.summary / opts.detail 描述本次操作；
// opts.describe(state, movedSet) 可在修改完成后动态生成 { summary, detail }（如移动后的实际位置）。
// opts.noRecord=true 时只改内容（当前流程未使用，保留给非历史化写入）。
function mutateDraft(draftId, fn, opts = {}) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
  if (meta.status !== 'open') {
    return { status: 409, payload: { error: 'CLOSED', message: '草案已发布，不能再修改' } };
  }
  const state = loadDraftState(db, draftId);
  const movedSet = new Set(meta.moved_keys);
  const before = draftSnapshotJson(meta.name, state, movedSet);
  const result = fn(state, movedSet);
  if (result && result.error) return { status: result.status || 400, payload: result.payload };
  // 移动记录只保留存活条款
  for (const k of [...movedSet]) if (!state.clauses.has(k)) movedSet.delete(k);
  const after = draftSnapshotJson(meta.name, state, movedSet);
  if (after === before) {
    // 无实际改动：不产生操作记录、不递增修订号
    return { status: 200, payload: draftDetail(draftId), unchanged: true };
  }
  const described = opts.describe ? opts.describe(state, movedSet) || {} : {};
  const kind = described.kind || opts.kind || 'edit';
  const summary = described.summary || opts.summary || '编辑草案';
  const detail = described.detail !== undefined ? described.detail : opts.detail || null;
  const tx = db.transaction(() => {
    appendDraftOperation(db, {
      draftId,
      kind,
      summary,
      detail,
      name: meta.name,
      state,
      movedSet,
    });
  });
  tx();
  return { status: 200, payload: draftDetail(draftId) };
}

// ---------------------------------------------------------------------------
// 操作历史 / 撤销 / 重做
// 每个草案维护一条持久操作链（序号从 1 开始），每条记录带操作完成后的完整快照。
// 撤销/重做只移动 history_pos 游标并按快照恢复：条款顺序、标题正文、引用、显式
// 移动记录与草案名称一次性还原；游标移动本身不新增操作记录。
// 撤销/重做必须携带读取时的草案修订号（revision，乐观锁）；过期则拒绝覆盖并
// 在响应中返回当前草案与历史，由调用方刷新后重试。
// ---------------------------------------------------------------------------
function draftHistoryPayload(draftId) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return null;
  const operations = listDraftOperations(db, draftId);
  return {
    draft_id: draftId,
    revision: meta.revision,
    history_pos: meta.history_pos,
    can_undo: meta.history_pos > 1,
    can_redo: meta.history_pos < operations.length,
    operations, // 按序号升序；history_pos 即“当前位置对应的操作序号”
  };
}

function handleDraftHistory(draftId) {
  const payload = draftHistoryPayload(draftId);
  return payload ? { status: 200, payload } : { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
}

function handleUndoRedo(draftId, body, direction) {
  const revRaw = body.revision;
  if (revRaw === undefined || revRaw === null || !Number.isInteger(revRaw)) {
    return {
      status: 400,
      payload: { error: 'VALIDATION', message: '请携带读取草案时获得的 revision（整数草案修订号）' },
    };
  }

  return runImmediate(() => {
    const meta = getDraftMeta(db, draftId);
    if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
    if (meta.status !== 'open') {
      return { status: 409, payload: { error: 'CLOSED', message: '草案已发布，不能再撤销或重做' } };
    }
    // 乐观并发：修订号过期则拒绝覆盖，返回当前草案与历史
    if (revRaw !== meta.revision) {
      return {
        status: 409,
        payload: {
          error: 'STALE_DRAFT_REVISION',
          message: `草案修订号已过期（携带 ${revRaw}，当前 ${meta.revision}），${direction === 'undo' ? '撤销' : '重做'}未执行；请以返回的当前草案为准后重试。`,
          draft: draftDetail(draftId),
          history: draftHistoryPayload(draftId),
        },
      };
    }

    const operations = listDraftOperations(db, draftId);
    const targetSeq = direction === 'undo' ? meta.history_pos - 1 : meta.history_pos + 1;
    if (direction === 'undo' && meta.history_pos <= 1) {
      return {
        status: 409,
        payload: { error: 'NOTHING_TO_UNDO', message: '已到最早状态，没有可撤销的操作', draft: draftDetail(draftId), history: draftHistoryPayload(draftId) },
      };
    }
    if (direction === 'redo' && meta.history_pos >= operations.length) {
      return {
        status: 409,
        payload: { error: 'NOTHING_TO_REDO', message: '没有可重做的操作（撤销后若已产生新编辑，重做分支已被舍弃）', draft: draftDetail(draftId), history: draftHistoryPayload(draftId) },
      };
    }
    const snapshotOp = getDraftOperation(db, draftId, targetSeq);
    if (!snapshotOp) {
      return { status: 404, payload: { error: 'NOT_FOUND', message: '目标操作记录不存在' } };
    }
    // 撤销：被撤销的是旧游标位置上的操作（seq=history_pos）；重做：被重做的是目标位置操作。
    const appliedOp =
      direction === 'undo' ? getDraftOperation(db, draftId, meta.history_pos) : snapshotOp;

    // 按快照整体恢复：名称、顺序、标题正文、引用、显式移动记录一次还原。
    // 恢复前取得的预览凭据必须失效。
    supersedePreviewTokens(db, draftId);
    restoreDraftSnapshot(db, draftId, targetSeq, snapshotOp.snapshot);

    return {
      status: 200,
      payload: {
        ok: true,
        action: direction,
        applied_seq: appliedOp.seq,
        applied_kind: appliedOp.kind,
        applied_summary: appliedOp.summary,
        draft: draftDetail(draftId),
        history: draftHistoryPayload(draftId),
      },
    };
  });
}

function draftRoutes(method, url, body, query) {
  const draftMatch = url.match(/^\/api\/drafts\/(\d+)(\/.*)?$/);
  if (!draftMatch) return null;
  const draftId = parseInt(draftMatch[1], 10);
  const sub = draftMatch[2] || '';

  if (method === 'GET' && sub === '') {
    const detail = draftDetail(draftId, { withTextDiff: query.diff === '1' });
    return detail ? { status: 200, payload: detail } : { status: 404, payload: { error: 'NOT_FOUND' } };
  }

  if (method === 'PATCH' && sub === '') {
    const meta = getDraftMeta(db, draftId);
    if (!meta) return { status: 404, payload: { error: 'NOT_FOUND' } };
    if (meta.status !== 'open') {
      return { status: 409, payload: { error: 'CLOSED', message: '草案已发布，不能再重命名' } };
    }
    const name = String(body.name || '').trim();
    if (!name) return { status: 400, payload: { error: 'VALIDATION', message: '草案名称不能为空' } };
    if (name === meta.name) {
      return { status: 200, payload: draftDetail(draftId), unchanged: true };
    }
    const state = loadDraftState(db, draftId);
    const movedSet = new Set(meta.moved_keys);
    const tx = db.transaction(() => {
      appendDraftOperation(db, {
        draftId,
        kind: 'rename',
        summary: `草案改名：「${meta.name}」→「${name}」`,
        detail: { from: meta.name, to: name },
        name,
        state,
        movedSet,
      });
    });
    tx();
    return { status: 200, payload: draftDetail(draftId) };
  }

  if (method === 'GET' && sub === '/history') return handleDraftHistory(draftId);
  if (method === 'POST' && sub === '/undo') return handleUndoRedo(draftId, body, 'undo');
  if (method === 'POST' && sub === '/redo') return handleUndoRedo(draftId, body, 'redo');

  if (method === 'POST' && sub === '/publish') {
    // 携带预览凭据 -> 凭据确认发布；否则沿用原有直接发布
    return body.preview_token !== undefined ? handleConfirmPublish(draftId, body) : handlePublish(draftId, body);
  }
  if (method === 'POST' && sub === '/preview') return handlePreview(draftId, body);

  if (sub === '/clauses' || sub.startsWith('/clauses/')) {
    return clauseRoutes(method, sub, body, draftId);
  }
  if (sub === '/refs' || sub.startsWith('/refs/')) {
    return refRoutes(method, sub, body, draftId);
  }
  return { status: 404, payload: { error: 'NOT_FOUND', message: '未知的草案资源' } };
}

function clauseRoutes(method, sub, body, draftId) {
  if (method === 'POST' && sub === '/clauses') {
    const key = String(body.key || '').trim();
    const title = String(body.title || '').trim();
    const text = String(body.body ?? '');
    return mutateDraft(
      draftId,
      (state) => {
        const kerr = keyError(key);
        if (kerr) return { error: true, payload: { error: 'VALIDATION', message: kerr } };
        if (state.clauses.has(key))
          return { error: true, payload: { error: 'DUP_KEY', message: `条款标识「${key}」已存在` } };
        if (!title) return { error: true, payload: { error: 'VALIDATION', message: '标题不能为空' } };
        if (!text.trim()) return { error: true, payload: { error: 'VALIDATION', message: '正文不能为空' } };
        state.order.push(key);
        state.clauses.set(key, { key, title, body: text });
      },
      {
        kind: 'clause-add',
        summary: `新增条款「${key}」（${title}）`,
        detail: { key, title },
      },
    );
  }

  // 具体条款资源：/clauses/:key 或 /clauses/:key/move
  const m = sub.match(/^\/clauses\/([^/]+)(\/move)?$/);
  if (sub.startsWith('/clauses/') && !m) return { status: 404, payload: { error: 'NOT_FOUND' } };
  const key = decodeURIComponent(m[1]);

  if (m[2] === '/move' && method === 'POST') {
    return mutateDraft(
      draftId,
      (state, movedSet) => {
        if (!state.clauses.has(key)) return { error: true, payload: { error: 'NOT_FOUND', message: '条款不存在' } };
        const oldOrder = [...state.order];
        const idx = state.order.indexOf(key);
        state.order.splice(idx, 1);
        if (typeof body.ordinal === 'number') {
          const target = Math.max(0, Math.min(body.ordinal, state.order.length));
          state.order.splice(target, 0, key);
        } else {
          const after = body.after === undefined ? null : String(body.after);
          if (after === null || after === '') {
            state.order.unshift(key);
          } else {
            const at = state.order.indexOf(after);
            if (at === -1) return { error: true, payload: { error: 'BAD_ANCHOR', message: '锚点条款不存在' } };
            state.order.splice(at + 1, 0, key);
          }
        }
        // 只有顺序真的发生变化才记录显式移动
        if (state.order.some((k, i) => oldOrder[i] !== k)) movedSet.add(key);
      },
      {
        kind: 'clause-move',
        describe: (state) => {
          const pos = state.order.indexOf(key);
          return { summary: `移动条款「${key}」至第 ${pos + 1} 位`, detail: { key, ordinal: pos } };
        },
      },
    );
  }

  if (method === 'PUT') {
    const title = String(body.title || '').trim();
    const text = String(body.body ?? '');
    return mutateDraft(
      draftId,
      (state) => {
        if (!state.clauses.has(key)) return { error: true, payload: { error: 'NOT_FOUND', message: '条款不存在' } };
        if (!title) return { error: true, payload: { error: 'VALIDATION', message: '标题不能为空' } };
        if (!text.trim()) return { error: true, payload: { error: 'VALIDATION', message: '正文不能为空' } };
        state.clauses.set(key, { key, title, body: text });
      },
      {
        kind: 'clause-edit',
        describe: () => ({ summary: `改写条款「${key}」（${title}）`, detail: { key, title } }),
      },
    );
  }

  if (method === 'DELETE') {
    return mutateDraft(
      draftId,
      (state) => {
        if (!state.clauses.has(key)) return { error: true, payload: { error: 'NOT_FOUND', message: '条款不存在' } };
        state.order.splice(state.order.indexOf(key), 1);
        // 删除条款：其出边保留在草案中并成为悬空引用（可暂存、阻止发布、可重新建回同标识条款消除）
        state.clauses.delete(key);
      },
      { kind: 'clause-delete', summary: `删除条款「${key}」`, detail: { key } },
    );
  }

  return { status: 405, payload: { error: 'METHOD_NOT_ALLOWED' } };
}

function refRoutes(method, sub, body, draftId) {
  if (method === 'POST' && sub === '/refs') {
    const source = String(body.source || '').trim();
    const target = String(body.target || '').trim();
    const label = String(body.label || '').trim();
    return mutateDraft(
      draftId,
      (state) => {
        const skerr = keyError(source);
        if (skerr) return { error: true, payload: { error: 'VALIDATION', message: `来源标识无效：${skerr}` } };
        const tkerr = keyError(target);
        if (tkerr) return { error: true, payload: { error: 'VALIDATION', message: `目标标识无效：${tkerr}` } };
        const dup = state.edges.some((e) => e.source === source && e.target === target && (e.label || '') === label);
        if (dup) return { error: true, payload: { error: 'DUP_REF', message: '相同引用已存在' } };
        // 允许暂存指向尚不存在条款的引用
        state.edges.push({ source, target, label });
      },
      {
        kind: 'ref-add',
        summary: `新增引用 ${source} → ${target}${label ? `（${label}）` : ''}`,
        detail: { source, target, label },
      },
    );
  }
  const m = sub.match(/^\/refs\/(\d+)$/);
  if (m && method === 'DELETE') {
    const refOrdinal = parseInt(m[1], 10);
    let removed = null;
    return mutateDraft(
      draftId,
      (state) => {
        if (refOrdinal < 0 || refOrdinal >= state.edges.length)
          return { error: true, payload: { error: 'NOT_FOUND', message: '引用不存在' } };
        removed = state.edges[refOrdinal];
        state.edges.splice(refOrdinal, 1);
      },
      {
        kind: 'ref-delete',
        describe: () => ({
          summary: removed
            ? `删除引用 ${removed.source} → ${removed.target}${removed.label ? `（${removed.label}）` : ''}`
            : '删除引用',
          detail: removed ? { source: removed.source, target: removed.target, label: removed.label || '' } : {},
        }),
      },
    );
  }
  return { status: 404, payload: { error: 'NOT_FOUND' } };
}

// ---------------------------------------------------------------------------
// 发布 / 预览 / 凭据确认
//
// 三条写路径共用同一套判定（evaluatePublish）：
//   1) 直接发布  POST /api/drafts/:id/publish                （原有语义不变）
//   2) 预览      POST /api/drafts/:id/preview                （只存凭据，不写版本、不关草案）
//   3) 凭据确认  POST /api/drafts/:id/publish {preview_token}（事务内核对全部失效条件后原子发布）
// ---------------------------------------------------------------------------

// 在 BEGIN IMMEDIATE 事务中执行：与并发发布/预览串行化，保证读集合可重复、写操作原子。
// 2xx 提交，其余回滚。
function runImmediate(fn) {
  db.pragma('foreign_keys = ON');
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const out = fn();
    if (out.status < 300) db.prepare('COMMIT').run();
    else db.prepare('ROLLBACK').run();
    return out;
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {}
    throw err;
  }
}

// 解析发布说明 / 生效时刻（事务外做格式校验；顺序与队列规则在事务内判定，与原发布一致）。
function parsePublishRequest(body, draftName) {
  const note = String(body.note || '').trim() || `发布草案：${draftName}`;
  let requestedAt = null;
  if (body.effective_at != null && String(body.effective_at).trim() !== '') {
    const parsed = parseEffectiveAt(body.effective_at);
    if (!parsed.ok) {
      return { error: { status: 400, payload: { error: 'VALIDATION', message: parsed.message } } };
    }
    requestedAt = parsed;
  }
  return { note, requestedAt };
}

// 核心判定：排程规则 → 草案静态校验 → （必要时）三方重放。
// 返回 { plan }（可提交的发布计划）或 { status, payload }（与直接发布完全相同的错误）。
function evaluatePublish({ draftId, meta, note, requestedAt, nowMs, versions }) {
  versions = versions || listVersions(db);
  const latestId = versions[versions.length - 1].id;
  const latestMeta = getVersionMeta(db, latestId);
  const pending = pendingVersions(versions, nowMs);

  // 0) 排程规则（与直接发布逐字一致）
  if (requestedAt) {
    if (requestedAt.ms <= nowMs) {
      return {
        status: 400,
        payload: {
          error: 'PAST_EFFECTIVE_AT',
          message: '未来生效时刻必须严格晚于当前 UTC 时间',
          schedule: buildSchedule({ nowMs, versions }),
        },
      };
    }
    // 未来生效时刻须按发布版顺序严格递增：仅需晚于队列末尾（最大 id 的待生效版本）
    const tail = pending.length ? pending[pending.length - 1] : null;
    if (tail && Date.parse(tail.effective_at) >= requestedAt.ms) {
      return {
        status: 409,
        payload: {
          error: 'SCHEDULE_ORDER_VIOLATION',
          message: `未来生效时刻必须严格晚于已排程的最后一个版本 v${tail.id}（${tail.effective_at}）`,
          schedule: buildSchedule({ nowMs, versions }),
        },
      };
    }
  } else if (pending.length) {
    // 队列未清空时，未指定时刻的发布（即时生效）拒绝
    const tail = pending[pending.length - 1];
    return {
      status: 409,
      payload: {
        error: 'QUEUE_NOT_EMPTY',
        message: `已有 ${pending.length} 个待生效版本（下一个 v${pending[0].id} 于 ${pending[0].effective_at} 生效，队列至 v${tail.id}）。队列未清空时不能即时发布；如需继续，请指定严格晚于 v${tail.id}（${tail.effective_at}）的未来生效时刻，或先取消/改期清空队列。`,
        schedule: buildSchedule({ nowMs, versions }),
      },
    };
  }

  const draftState = loadDraftState(db, draftId);
  const draftMoved = new Set(loadDraftMoved(db, draftId));
  const baselineState = loadVersionState(db, meta.baseline_id);
  const latestState = loadVersionState(db, latestId);

  // 1) 草案自身的结构问题（悬空引用等）：拒绝发布，草案原样保留
  const issues = validateState(draftState).filter((i) => i.level === 'error');
  if (issues.length) {
    return { status: 409, payload: { error: 'DRAFT_INVALID', message: '草案存在必须修复的问题，已保留草案', issues } };
  }

  const effectiveAt = requestedAt ? requestedAt.iso : new Date(nowMs).toISOString();
  const scheduleStatus = requestedAt ? 'scheduled' : 'immediate';

  const makePlan = (finalState, finalMoved, replayed) => ({
    draftId,
    note,
    baselineId: latestId,
    latestId,
    replayed,
    finalState,
    finalMoved,
    effectiveAt,
    scheduleStatus,
  });

  // 2) 基线即最新版：直接采用草案内容
  if (meta.baseline_id === latestId) {
    if (stateEqual(draftState, latestState) && draftMoved.size === 0) {
      return { status: 400, payload: { error: 'NO_CHANGES', message: '草案与最新版完全一致，无需发布' } };
    }
    const newMoved = new Set(latestMeta.moved_keys);
    for (const k of draftMoved) if (draftState.clauses.has(k)) newMoved.add(k);
    return { plan: makePlan(draftState, newMoved, false) };
  }

  // 3) 基线落后：最新版相对本草案基线累积移动过的条款（基线之后各版移动记录的并集）
  const latestMovedKeys = new Set();
  for (const v of versions) {
    if (v.id > meta.baseline_id && v.id <= latestId) {
      for (const k of v.moved_keys) latestMovedKeys.add(k);
    }
  }

  const result = replayDraft({
    baseline: baselineState,
    latest: latestState,
    draft: draftState,
    draftMoved,
    latestMovedKeys,
  });
  if (!result.ok) {
    return {
      status: 409,
      payload: {
        error: 'CONFLICT',
        message: '发布被拒绝：与最新发布版存在冲突，草案已保留',
        conflicts: result.conflicts,
        dangling: result.dangling,
      },
    };
  }
  if (stateEqual(result.merged, latestState)) {
    return { status: 400, payload: { error: 'NO_CHANGES', message: '改动已全部包含在最新版中，无需发布' } };
  }
  return { plan: makePlan(result.merged, result.mergedMoved, true) };
}

// 按计划原子写入不可变新版本并关闭草案（运行在调用方事务内）。
function commitPlan(plan) {
  const newId = insertVersion(db, {
    note: plan.note,
    baselineId: plan.baselineId,
    draftId: plan.draftId,
    state: plan.finalState,
    movedKeys: plan.finalMoved,
    effectiveAt: plan.effectiveAt,
    scheduleStatus: plan.scheduleStatus,
  });
  db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run('published', plan.draftId);
  if (plan.scheduleStatus === 'scheduled') bumpScheduleRevision(db);
  return newId;
}

// 发布成功响应（与历史直接发布响应字段保持一致）。
function publishResponse(plan, newId) {
  return {
    status: 201,
    payload: {
      version_id: newId,
      replayed: plan.replayed,
      ...(plan.replayed ? { baseline_latest_id: plan.latestId } : {}),
      schedule_status: plan.scheduleStatus,
      effective_at: plan.effectiveAt,
      ...(plan.scheduleStatus === 'scheduled' ? { schedule: buildSchedule() } : {}),
    },
  };
}

// 直接发布（原有入口与错误语义保持可用）。
function handlePublish(draftId, body) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
  if (meta.status !== 'open') {
    return { status: 409, payload: { error: 'CLOSED', message: '草案已发布' } };
  }
  const parsed = parsePublishRequest(body, meta.name);
  if (parsed.error) return parsed.error;

  return runImmediate(() => {
    const evaluated = evaluatePublish({
      draftId,
      meta,
      note: parsed.note,
      requestedAt: parsed.requestedAt,
      nowMs: Date.now(),
    });
    if (!evaluated.plan) return evaluated;
    const newId = commitPlan(evaluated.plan);
    return publishResponse(evaluated.plan, newId);
  });
}

// ---------------------------------------------------------------------------
// 发布预览：跑完整发布判定，成功仅落一份确认凭据（不生成版本、不关闭草案）。
// 返回相对最新发布版的条款正文、顺序、引用差异；冲突/校验问题按发布的原错误语义返回。
// ---------------------------------------------------------------------------
function handlePreview(draftId, body) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
  if (meta.status !== 'open') {
    return { status: 409, payload: { error: 'CLOSED', message: '草案已发布，不能再预览' } };
  }
  const parsed = parsePublishRequest(body, meta.name);
  if (parsed.error) return parsed.error;

  return runImmediate(() => {
    const nowMs = Date.now();
    // 顺手清理陈旧凭据：已消费或超过 7 天的记录。
    prunePreviewTokens(db, new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString());

    const versions = listVersions(db);
    const evaluated = evaluatePublish({
      draftId,
      meta,
      note: parsed.note,
      requestedAt: parsed.requestedAt,
      nowMs,
      versions,
    });
    if (!evaluated.plan) return evaluated; // 冲突/校验/排程问题：与发布同语义，且不发凭据
    const plan = evaluated.plan;

    const draftState = loadDraftState(db, draftId);
    const draftMoved = new Set(loadDraftMoved(db, draftId));
    const token = newPreviewToken();
    const scheduleRevision = getScheduleRevision(db);

    // 同一草案只保留最新一份未消费凭据（旧凭据确认时返回 PREVIEW_SUPERSEDED）。
    supersedePreviewTokens(db, draftId);
    insertPreviewToken(db, {
      token,
      draftId,
      latestVersionId: plan.latestId,
      scheduleRevision,
      note: plan.note,
      scheduleStatus: plan.scheduleStatus,
      effectiveAt: plan.scheduleStatus === 'scheduled' ? plan.effectiveAt : null,
      replayed: plan.replayed,
      draftContent: draftFingerprint({ name: meta.name, state: draftState, movedSet: draftMoved }),
      finalContent: versionFingerprint({ state: plan.finalState, movedSet: plan.finalMoved }),
    });

    return buildPreviewPayload({ plan, token, meta, scheduleRevision, nowMs, versions });
  });
}

// 预览成功响应：最终条款全文/顺序/引用、相对最新发布版的差异、生效安排、确认凭据。
function buildPreviewPayload({ plan, token, meta, scheduleRevision, nowMs, versions }) {
  const latestState = loadVersionState(db, plan.latestId);
  const finalState = plan.finalState;

  // 本版相对最新版真正发生位置变化的移动条款（剔除历史遗留但本次未动的记录）。
  const latestPos = new Map(latestState.order.map((k, i) => [k, i]));
  const ownMoved = new Set(
    [...plan.finalMoved].filter(
      (k) => finalState.clauses.has(k) && latestPos.get(k) !== finalState.order.indexOf(k),
    ),
  );
  const diff = diffStates(latestState, finalState, ownMoved);

  return {
    status: 200,
    payload: {
      preview: true,
      token,
      draft_id: plan.draftId,
      draft_name: meta.name,
      note: plan.note,
      created_at: nowIso(),
      preview_at: new Date(nowMs).toISOString(),
      baseline_id: meta.baseline_id,
      latest_version_id: plan.latestId,
      replayed: plan.replayed,
      schedule_status: plan.scheduleStatus,
      effective_at: plan.scheduleStatus === 'scheduled' ? plan.effectiveAt : null,
      schedule_revision: scheduleRevision,
      schedule: buildSchedule({ nowMs, versions }),
      final: serializeState(finalState),
      final_moved_keys: [...ownMoved],
      diff: {
        added: diff.added,
        deleted: diff.deleted,
        changed: diff.changed,
        moved: diff.moved,
        refs_added: diff.refsAdded,
        refs_removed: diff.refsRemoved,
      },
      changed_detail: diff.changed.map((c) => {
        const b = latestState.clauses.get(c.key);
        const d = finalState.clauses.get(c.key);
        return {
          ...c,
          titleSegments: textDiff(b.title, d.title),
          bodySegments: c.body ? textDiff(b.body, d.body) : null,
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 凭据确认：只能在同一事务内发布与预览完全一致的内容及生效安排。
// 草案被编辑/重命名、其他草案先发布、排程改期/取消、预定时刻已过、凭据被消费
// 或被更新的预览取代，均整次拒绝、返回原因，草案保留。
// ---------------------------------------------------------------------------
function handleConfirmPublish(draftId, body) {
  const tokenRaw = body.preview_token;
  if (typeof tokenRaw !== 'string' || !/^[0-9a-f]{64}$/.test(tokenRaw)) {
    return {
      status: 400,
      payload: { error: 'VALIDATION', message: '请携带预览成功时返回的 preview_token（64 位十六进制凭据）' },
    };
  }
  const rec = getPreviewToken(db, tokenRaw);
  if (!rec || rec.draft_id !== draftId) {
    return {
      status: 404,
      payload: { error: 'PREVIEW_TOKEN_NOT_FOUND', message: '预览凭据不存在或不属于该草案，请重新预览后再确认发布；草案未被改动。' },
    };
  }

  return runImmediate(() => {
    const nowMs = Date.now();
    const invalid = (code, message, extra = {}) => ({
      status: 409,
      payload: {
        ...extra,
        error: code,
        message,
        draft_id: draftId,
        retained: true,
        schedule: buildSchedule({ nowMs }),
      },
    });

    if (rec.consumed) {
      return invalid('PREVIEW_ALREADY_CONSUMED', '该预览凭据已用于确认发布，不能重复使用；如需再次发布请重新预览，草案未被改动。');
    }

    const meta = getDraftMeta(db, draftId);
    if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
    if (meta.status !== 'open') {
      return invalid('DRAFT_ALREADY_PUBLISHED', '草案在预览后已被发布（直接发布或凭据确认），凭据失效；草案已关闭保留。');
    }

    // 条件 1：草案被编辑或重命名（条款/引用/移动记录/名称任一变化）
    const draftState = loadDraftState(db, draftId);
    const draftMoved = new Set(loadDraftMoved(db, draftId));
    if (draftFingerprint({ name: meta.name, state: draftState, movedSet: draftMoved }) !== rec.draft_content) {
      return invalid('DRAFT_CHANGED_AFTER_PREVIEW', '草案在预览后被编辑或重命名，预览凭据已失效；请重新预览后再确认发布，草案已保留。');
    }

    // 条件 2：其他草案先发布（最新发布版变化）
    const versions = listVersions(db);
    const latestId = versions[versions.length - 1].id;
    if (latestId !== rec.latest_version_id) {
      return invalid(
        'LATEST_VERSION_CHANGED',
        `预览后最新发布版已由 v${rec.latest_version_id} 变为 v${latestId}，预览凭据已失效；请重新预览（将按新的最新版重放），草案已保留。`,
      );
    }

    // 条件 3：排程改期或取消（任一排程写操作都会递增修订号）
    const revision = getScheduleRevision(db);
    if (revision !== rec.schedule_revision) {
      return invalid('SCHEDULE_CHANGED_AFTER_PREVIEW', '预览后生效排程发生了改期或取消，预览凭据已失效；请重新预览，草案已保留。');
    }

    // 条件 4：预定生效时刻已过
    if (rec.schedule_status === 'scheduled' && Date.parse(rec.effective_at) <= nowMs) {
      return invalid(
        'EFFECTIVE_TIME_PASSED',
        `预览预定的生效时刻 ${rec.effective_at} 已过，预览凭据已失效；请重新预览并选择新的未来 UTC 时刻，草案已保留。`,
      );
    }

    // 条件 5（兜底）：在当前世界重放一遍，落库内容必须与预览逐字节一致
    const requestedAt =
      rec.schedule_status === 'scheduled' ? { iso: rec.effective_at, ms: Date.parse(rec.effective_at) } : null;
    const evaluated = evaluatePublish({ draftId, meta, note: rec.note, requestedAt, nowMs, versions });
    if (!evaluated.plan) {
      const p = evaluated.payload || {};
      return invalid('PREVIEW_INVALIDATED', `预览时的发布条件已不再满足（${p.error || '未知原因'}），请重新预览，草案已保留。`, {
        issues: p.issues,
        conflicts: p.conflicts,
        dangling: p.dangling,
      });
    }
    const plan = evaluated.plan;
    if (versionFingerprint({ state: plan.finalState, movedSet: plan.finalMoved }) !== rec.final_content) {
      return invalid('PREVIEW_CONTENT_MISMATCH', '当前将发布的内容与预览结果不一致，预览凭据已失效；请重新预览，草案已保留。');
    }

    // 全部条件满足：同一事务内原子发布与凭据标记
    const newId = commitPlan(plan);
    markPreviewConsumed(db, rec.token);
    return {
      status: 201,
      payload: {
        ...publishResponse(plan, newId).payload,
        confirmed_from_preview: true,
        preview_token: rec.token,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 版本查看（还原顺序、正文、引用）
// ---------------------------------------------------------------------------
function versionDetail(versionId, query) {
  const meta = getVersionMeta(db, versionId);
  if (!meta) return null;
  const state = loadVersionState(db, versionId);
  const payload = {
    ...meta,
    clauses: state.order.map((k, i) => ({ ordinal: i, ...state.clauses.get(k) })),
    refs: state.edges.map((e, i) => ({ ordinal: i, ...e })),
  };
  if (query.compare) {
    const otherId = parseInt(query.compare, 10);
    if (getVersionMeta(db, otherId)) {
      const other = loadVersionState(db, otherId);
      // 比较基线之后各版本显式移动记录的并集，仅保留本版存活条款
      const explicitMoved = new Set();
      for (const v of listVersions(db)) {
        if (v.id > otherId && v.id <= versionId) {
          for (const k of v.moved_keys) if (state.clauses.has(k)) explicitMoved.add(k);
        }
      }
      const diff = diffStates(other, state, explicitMoved);
      payload.compare_to = otherId;
      payload.diff = {
        added: diff.added,
        deleted: diff.deleted,
        changed: diff.changed,
        moved: diff.moved,
        refs_added: diff.refsAdded,
        refs_removed: diff.refsRemoved,
      };
      payload.changed_detail = diff.changed.map((c) => {
        const b = other.clauses.get(c.key);
        const d = state.clauses.get(c.key);
        return {
          ...c,
          titleSegments: textDiff(b.title, d.title),
          bodySegments: c.body ? textDiff(b.body, d.body) : null,
        };
      });
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// 生效排程：时点查询 / 改期 / 取消
// ---------------------------------------------------------------------------
// GET /api/effective?at=ISO8601
// 返回指定 UTC 时点（默认当前）当时生效版本的完整条款、顺序、引用及排程状态。
// 已发生时点的结果不随后续改期/取消变化：改期只能指向未来、取消仅作用于待生效版本，
// 故过去时点的命中结果由不可变历史唯一确定。
function handleEffective(query) {
  let atMs = Date.now();
  if (query.at != null && String(query.at).trim() !== '') {
    const parsed = parseEffectiveAt(query.at, { field: 'at' });
    if (!parsed.ok) return { status: 400, payload: { error: 'VALIDATION', message: parsed.message } };
    atMs = parsed.ms;
  }
  const versions = listVersions(db);
  const id = pickEffectiveVersion(versions, atMs);
  if (id == null) {
    return {
      status: 200,
      payload: { at: new Date(atMs).toISOString(), version_id: null, version: null },
    };
  }
  const state = loadVersionState(db, id);
  const meta = getVersionMeta(db, id);
  return {
    status: 200,
    payload: {
      at: new Date(atMs).toISOString(),
      version_id: id,
      version: {
        ...meta,
        clauses: state.order.map((k, i) => ({ ordinal: i, ...state.clauses.get(k) })),
        refs: state.edges.map((e, i) => ({ ordinal: i, ...e })),
      },
    },
  };
}

// 校验携带的排程修订号（读取排程时拿到的 schedule_revision）
function checkRevision(body) {
  const revRaw = body.schedule_revision;
  if (revRaw === undefined || revRaw === null || !Number.isInteger(revRaw)) {
    return { error: 'VALIDATION', message: '请携带读取排程时获得的 schedule_revision（整数）' };
  }
  return null;
}

// 在 BEGIN IMMEDIATE 事务内执行一次排程写操作（改期/取消）。
// 先查修订号（过期则整次拒绝并返回当前排程），再校验版本状态。
function mutateSchedule(versionId, body, kind) {
  const revError = checkRevision(body);
  if (revError) return { status: 400, payload: { error: revError.error, message: revError.message } };

  let requestedAt = null;
  if (kind === 'reschedule') {
    requestedAt = parseEffectiveAt(body.effective_at);
    if (!requestedAt.ok) {
      return { status: 400, payload: { error: 'VALIDATION', message: requestedAt.message } };
    }
  }

  // 注意：不在外层再包 db.transaction()——本函数整体运行在调用方手动开启的
  // BEGIN IMMEDIATE 事务中（已立即取得写锁），嵌套 SAVEPOINT 会与写锁升级相互阻塞。
  const run = () => {
    const nowMs = Date.now();
    const current = getScheduleRevision(db);
    if (body.schedule_revision !== current) {
      return {
        status: 409,
        payload: {
          error: 'STALE_SCHEDULE_REVISION',
          message: `排程修订号已过期（携带 ${body.schedule_revision}，当前 ${current}），操作未执行；请以返回的当前排程为准后重试。`,
          schedule: buildSchedule({ nowMs }),
        },
      };
    }

    const v = getVersionMeta(db, versionId);
    if (!v) {
      return { status: 404, payload: { error: 'NOT_FOUND', message: '版本不存在' } };
    }
    if (v.schedule_status === 'cancelled') {
      return {
        status: 409,
        payload: { error: 'VERSION_CANCELLED', message: '该版本已被取消，不能再改期或生效', schedule: buildSchedule({ nowMs }) },
      };
    }
    if (v.schedule_status !== 'scheduled' || Date.parse(v.effective_at) <= nowMs) {
      return {
        status: 409,
        payload: { error: 'ALREADY_EFFECTIVE', message: '版本已生效，生效前才能改期或取消', schedule: buildSchedule({ nowMs }) },
      };
    }

    if (kind === 'reschedule') {
      // 不得落到过去
      if (requestedAt.ms <= nowMs) {
        return {
          status: 400,
          payload: { error: 'PAST_EFFECTIVE_AT', message: '新的生效时刻必须严格晚于当前 UTC 时间', schedule: buildSchedule({ nowMs }) },
        };
      }
      // 不得越过相邻版本：严格位于前一待生效版本之后、后一待生效版本之前
      const versions = listVersions(db);
      const pending = pendingVersions(versions, nowMs);
      const { before, after } = scheduleNeighbors(pending, versionId);
      if (before && requestedAt.ms <= Date.parse(before.effective_at)) {
        return {
          status: 409,
          payload: {
            error: 'SCHEDULE_ORDER_VIOLATION',
            message: `改期不能越过相邻的前一版本 v${before.id}：新时刻必须严格晚于 ${before.effective_at}`,
            schedule: buildSchedule({ nowMs, versions }),
          },
        };
      }
      if (after && requestedAt.ms >= Date.parse(after.effective_at)) {
        return {
          status: 409,
          payload: {
            error: 'SCHEDULE_ORDER_VIOLATION',
            message: `改期不能越过相邻的后一版本 v${after.id}：新时刻必须严格早于 ${after.effective_at}`,
            schedule: buildSchedule({ nowMs, versions }),
          },
        };
      }
      db.prepare('UPDATE versions SET effective_at = ? WHERE id = ?').run(requestedAt.iso, versionId);
    } else {
      db.prepare("UPDATE versions SET schedule_status = 'cancelled' WHERE id = ?").run(versionId);
    }

    const revision = bumpScheduleRevision(db);
    return {
      status: 200,
      payload: {
        ok: true,
        action: kind,
        version_id: versionId,
        ...(kind === 'reschedule' ? { effective_at: requestedAt.iso } : {}),
        schedule_revision: revision,
        schedule: buildSchedule({ nowMs }),
      },
    };
  };

  db.pragma('foreign_keys = ON');
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const out = run();
    if (out.status === 200) db.prepare('COMMIT').run();
    else db.prepare('ROLLBACK').run();
    return out;
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 路由 & 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  rel = rel.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const url = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);

  if (!url.startsWith('/api/')) return serveStatic(req, res, url);

  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    let result;

    if (req.method === 'GET' && url === '/api/overview') result = { status: 200, payload: apiOverview() };
    else if (req.method === 'POST' && url === '/api/initialize') result = handleInitial(body);
    else if (req.method === 'GET' && url === '/api/effective') result = handleEffective(query);
    else if (req.method === 'GET' && /^\/api\/versions\/\d+$/.test(url)) {
      const id = parseInt(url.split('/').pop(), 10);
      const detail = versionDetail(id, query);
      result = detail ? { status: 200, payload: detail } : { status: 404, payload: { error: 'NOT_FOUND' } };
    } else if (req.method === 'POST' && /^\/api\/versions\/\d+\/schedule$/.test(url)) {
      const id = parseInt(url.split('/')[3], 10);
      result = mutateSchedule(id, body, 'reschedule');
    } else if (req.method === 'POST' && /^\/api\/versions\/\d+\/cancel$/.test(url)) {
      const id = parseInt(url.split('/')[3], 10);
      result = mutateSchedule(id, body, 'cancel');
    } else if (req.method === 'GET' && url === '/api/schedule') {
      result = { status: 200, payload: buildSchedule() };
    } else if (req.method === 'POST' && url === '/api/drafts') result = handleCreateDraft(body);
    else result = draftRoutes(req.method, url, body, query);

    if (!result) result = { status: 404, payload: { error: 'NOT_FOUND', message: '未知接口' } };
    sendJson(res, result.status, result.payload);
  } catch (err) {
    if (err.message === 'BAD_JSON') return sendJson(res, 400, { error: 'BAD_JSON', message: '请求体不是合法 JSON' });
    if (err.message === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'BODY_TOO_LARGE' });
    console.error(err);
    sendJson(res, 500, { error: 'INTERNAL', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`社团章程修订应用已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据库: ${DB_PATH}`);
});
