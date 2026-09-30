'use strict';
// 纯业务逻辑：条款状态、差异计算、并行草案重放（三方合并）、悬空引用检测。
// 不依赖数据库，便于单元测试。
//
// state 结构：
//   { order: [key, ...],
//     clauses: Map<key, {key,title,body}>,
//     edges:   [{source,target,label}] }

const KEY_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

function keyError(key) {
  if (typeof key !== 'string' || key.length === 0) return '标识不能为空';
  if (key.length > 40) return '标识长度不能超过 40';
  if (!KEY_RE.test(key)) return '标识只能包含字母、数字、汉字、下划线或连字符';
  return null;
}

// ---------------------------------------------------------------------------
// 位置变动：方向性（旧序 -> 新序）锚点法。对旧序中每个共同锚点 P，若其旧后继
// 为 X，而在新序中 P 后的共同条款不再是 X 且 X 仍位于 P 之后，则 X 被移动。
// 这样把“把某条款后移”精确归因于被移动者；被插队而被动前移的条款不标记。
//   [A,B,C] -> [A,C,B]：仅 B 被标记（C 是被插队的被动方）
// 意义：并行重放时，草案移动 B、最新版只修改 C 的正文不会误判为同条款冲突。
// ---------------------------------------------------------------------------
function movedKeys(orderA, orderB) {
  const inB = new Set(orderB);
  const common = orderA.filter((k) => inB.has(k));
  const moved = new Set();
  for (let i = 0; i < common.length - 1; i++) {
    const anchor = common[i];
    const oldNext = common[i + 1];
    const idx = orderB.indexOf(anchor);
    let nextOne = null;
    for (let j = idx + 1; j < orderB.length; j++) {
      if (inB.has(orderB[j])) {
        nextOne = orderB[j];
        break;
      }
    }
    if (nextOne !== oldNext && orderB.indexOf(oldNext) > idx) moved.add(oldNext);
  }
  return moved;
}

function edgeKey(e) {
  return `${e.source}->${e.target}#${e.label || ''}`;
}

function edgeMap(state) {
  const m = new Map();
  for (const e of state.edges) m.set(edgeKey(e), e);
  return m;
}

// 基线 -> 工作稿之间，每个被触碰条款的改动面。
// movedSet：用户显式移动过的条款标识集合（移动操作记录），位置改动以它为准；
// 不传时退化为顺序启发式（仅用于版本对比展示）。
// 返回 Map<key, {added, deleted, body, position, edges}>
function touchedClauses(baseline, draft, movedSet) {
  const out = new Map();
  const moved = movedSet instanceof Set ? movedSet : movedKeys(baseline.order, draft.order);

  for (const key of draft.order) {
    if (!baseline.clauses.has(key)) {
      out.set(key, { added: true, deleted: false, body: false, position: false, edges: false });
      continue;
    }
    const b = baseline.clauses.get(key);
    const d = draft.clauses.get(key);
    const body = b.title !== d.title || b.body !== d.body;
    const position = moved.has(key);
    const edges = !edgeSetsEqual(edgesOf(baseline, key), edgesOf(draft, key));
    if (body || position || edges) {
      out.set(key, { added: false, deleted: false, body, position, edges });
    }
  }
  for (const key of baseline.order) {
    if (!draft.clauses.has(key)) {
      out.set(key, { added: false, deleted: true, body: false, position: false, edges: false });
    }
  }
  return out;
}

function edgesOf(state, source) {
  return state.edges.filter((e) => e.source === source);
}

function edgeSetsEqual(a, b) {
  const ka = new Set(a.map(edgeKey));
  const kb = new Set(b.map(edgeKey));
  if (ka.size !== kb.size) return false;
  for (const k of ka) if (!kb.has(k)) return false;
  return true;
}

function clauseEqual(x, y) {
  return x.title === y.title && x.body === y.body;
}

// ---------------------------------------------------------------------------
// 重放：把草案相对基线的改动，重放到最新发布版上。
// draftMoved：草案中被显式移动的条款标识集合（移动操作记录）。
// latestMovedKeys：最新发布版相对本草案基线被显式移动过的条款（历史累积）。
// 返回 { ok: true, merged, mergedMoved } 或
//      { ok: false, conflicts: [...], dangling: [...] }
// ---------------------------------------------------------------------------
function replayDraft({ baseline, latest, draft, draftMoved = new Set(), latestMovedKeys = new Set() }) {
  const tb = touchedClauses(baseline, draft, draftMoved); // 草案触碰
  const tl = touchedClauses(baseline, latest, latestMovedKeys); // 最新版触碰
  const conflicts = [];

  const mergedClauses = new Map();
  // chosenSource: key -> 'draft' | 'latest'，出边跟随条款归属
  const chosenSource = new Map();
  // 结果版本中被显式移动过的条款（两侧移动集合的并）
  const mergedMoved = new Set(latestMovedKeys);

  const allKeys = new Set([...latest.order, ...draft.order]);
  for (const key of allKeys) {
    const b = baseline.clauses.has(key);
    const d = draft.clauses.get(key);
    const l = latest.clauses.get(key);
    const inD = !!d;
    const inL = !!l;
    const touchedB = tb.has(key);
    const touchedL = tl.has(key);

    if (!b) {
      // 新增条款
      if (inD && inL) {
        // 双方新增同标识：内容与出边完全一致才允许收敛，否则冲突
        const same =
          clauseEqual(d, l) &&
          edgeSetsEqual(edgesOf(draft, key), edgesOf(latest, key));
        if (!same) {
          conflicts.push({
            key,
            kind: 'add-add',
            message: `双方都新增了条款「${key}」但内容或引用不一致`,
          });
        }
        mergedClauses.set(key, { ...l });
        chosenSource.set(key, 'latest');
      } else if (inD) {
        mergedClauses.set(key, { ...d });
        chosenSource.set(key, 'draft');
      } else {
        mergedClauses.set(key, { ...l });
        chosenSource.set(key, 'latest');
      }
      continue;
    }

    // 基线已有的条款
    if (!inD && !inL) {
      // 双方都删除：收敛为空
      continue;
    }
    if (!inD) {
      // 草案删除
      if (touchedL) {
        conflicts.push({
          key,
          kind: 'delete-modify',
          message: `草案删除了条款「${key}」，但最新版同时修改了该条款`,
        });
      }
      continue; // 删除生效
    }
    if (!inL) {
      // 最新版已删除
      if (touchedB) {
        conflicts.push({
          key,
          kind: 'modify-delete',
          message: `草案修改了条款「${key}」，但最新版已删除该条款`,
        });
        continue;
      }
      continue; // 双方都删除（草案未改内容，仅随删除消失）
    }

    // 双方都保留
    if (touchedB && touchedL) {
      const sameBody = clauseEqual(d, l);
      const sameEdges = edgeSetsEqual(edgesOf(draft, key), edgesOf(latest, key));
      const draftMovedHere = draftMoved.has(key);
      const latestMovedHere = latestMovedKeys.has(key);
      const converged = sameBody && sameEdges && draftMovedHere === latestMovedHere;
      if (!converged) {
        conflicts.push({
          key,
          kind: 'modify-modify',
          message: `条款「${key}」被草案与最新版同时改动`,
        });
      }
      mergedClauses.set(key, { ...l });
      chosenSource.set(key, 'latest');
      if (draftMovedHere) mergedMoved.add(key);
    } else if (touchedB) {
      mergedClauses.set(key, { ...d });
      chosenSource.set(key, 'draft');
      if (draftMoved.has(key)) mergedMoved.add(key);
    } else {
      mergedClauses.set(key, { ...l });
      chosenSource.set(key, 'latest');
    }
  }

  // 合并出边：跟随条款归属方
  const mergedEdges = [];
  const seenEdge = new Set();
  for (const [key, src] of chosenSource) {
    const state = src === 'draft' ? draft : latest;
    for (const e of edgesOf(state, key)) {
      const k = edgeKey(e);
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        mergedEdges.push({ ...e });
      }
    }
  }

  // 重放后悬空引用：任一端在合并结果中不存在
  const dangling = [];
  for (const e of mergedEdges) {
    const miss = [];
    if (!mergedClauses.has(e.source)) miss.push('source');
    if (!mergedClauses.has(e.target)) miss.push('target');
    if (miss.length) {
      dangling.push({
        source: e.source,
        target: e.target,
        label: e.label || '',
        missing: miss,
        message: `引用 ${e.source} → ${e.target}${e.label ? `（${e.label}）` : ''} 在重放后${
          miss.includes('target') ? '目标' : ''
        }${miss.length === 2 ? '与来源均' : ''}${miss.includes('source') && miss.length < 2 ? '来源' : ''}已不存在`,
      });
    }
  }

  if (conflicts.length || dangling.length) {
    return { ok: false, conflicts, dangling };
  }

  // 只保留存活条款的移动记录
  for (const k of [...mergedMoved]) {
    if (!mergedClauses.has(k)) mergedMoved.delete(k);
  }

  const merged = {
    order: mergeOrder({ baseline, latest, draft, surviving: mergedClauses, draftMoved }),
    clauses: mergedClauses,
    edges: mergedEdges,
  };
  return { ok: true, merged, mergedMoved };
}

// 顺序重排：以最新版顺序为底，草案新增/显式移动的条款按草案中的锚点插入。
function mergeOrder({ baseline, latest, draft, surviving, draftMoved }) {
  const baseHas = (k) => baseline.clauses.has(k);

  // 需要由草案放置的条款：草案新增（最新版里没有）或草案移动过的存活条款
  const toPlace = draft.order.filter(
    (k) =>
      surviving.has(k) &&
      (!latest.clauses.has(k) || (baseHas(k) && draftMoved.has(k))),
  );
  const placeSet = new Set(toPlace);

  let order = latest.order.filter((k) => surviving.has(k) && !placeSet.has(k));
  const anchorSet = new Set(order); // 未被草案移动/新增的锚点条款

  const anchorTail = new Map(); // 锚点 -> 已插到它后面的最后一个条款

  for (const item of toPlace) {
    // 在草案顺序中向前找最近的存活锚点
    const idx = draft.order.indexOf(item);
    let anchor = null;
    for (let i = idx - 1; i >= 0; i--) {
      const k = draft.order[i];
      if (anchorSet.has(k) && order.includes(k)) {
        anchor = k;
        break;
      }
    }

    if (anchor === null) {
      // 放到第一个锚点之前
      let pos = order.findIndex((k) => anchorSet.has(k));
      const tail = anchorTail.get(null);
      if (tail != null && order.includes(tail)) pos = order.indexOf(tail) + 1;
      if (pos === -1) pos = order.length;
      order.splice(pos, 0, item);
      anchorTail.set(null, item);
    } else {
      const tail = anchorTail.get(anchor);
      let pos;
      if (tail != null && order.includes(tail)) {
        pos = order.indexOf(tail) + 1;
      } else {
        pos = order.indexOf(anchor) + 1;
      }
      order.splice(pos, 0, item);
      anchorTail.set(anchor, item);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// 草案静态校验：结构问题（可暂存，不可发布）
// ---------------------------------------------------------------------------
function validateState(state) {
  const issues = [];
  const seen = new Set();
  for (const key of state.order) {
    const c = state.clauses.get(key);
    const kerr = keyError(key);
    if (kerr) issues.push({ level: 'error', code: 'bad-key', key, message: `标识无效：${kerr}` });
    if (seen.has(key)) issues.push({ level: 'error', code: 'duplicate-key', key, message: `标识重复：${key}` });
    seen.add(key);
    if (!c) continue;
    if (!c.title || !c.title.trim())
      issues.push({ level: 'error', code: 'empty-title', key, message: `条款「${key}」缺少标题` });
    if (!c.body || !c.body.trim())
      issues.push({ level: 'error', code: 'empty-body', key, message: `条款「${key}」正文为空` });
  }
  const edgeSeen = new Set();
  for (const e of state.edges) {
    const ek = edgeKey(e);
    if (edgeSeen.has(ek)) {
      issues.push({ level: 'warning', code: 'duplicate-ref', source: e.source, target: e.target, label: e.label || '', message: `重复引用：${e.source} → ${e.target}` });
    }
    edgeSeen.add(ek);
    const miss = [];
    if (!state.clauses.has(e.source)) miss.push('source');
    if (!state.clauses.has(e.target)) miss.push('target');
    if (miss.length) {
      issues.push({
        level: 'error',
        code: 'dangling-ref',
        source: e.source,
        target: e.target,
        label: e.label || '',
        missing: miss,
        message: `悬空引用：${e.source} → ${e.target}（${miss.includes('target') ? '目标条款不存在' : '来源条款不存在'}），可暂存但不能发布`,
      });
    } else if (e.source === e.target) {
      issues.push({
        level: 'warning',
        code: 'self-ref',
        source: e.source,
        target: e.target,
        label: e.label || '',
        message: `条款「${e.source}」引用了自身`,
      });
    }
  }
  return issues;
}

function hasBlockingIssues(issues) {
  return issues.some((i) => i.level === 'error');
}

// ---------------------------------------------------------------------------
// 结构差异。movedSet 为显式移动记录时优先采用，否则按顺序启发式推断。
// ---------------------------------------------------------------------------
function diffStates(baseline, other, movedSet) {
  const added = [];
  const deleted = [];
  const changed = [];
  const moved = movedSet instanceof Set ? movedSet : movedKeys(baseline.order, other.order);

  for (const key of other.order) {
    if (!baseline.clauses.has(key)) {
      added.push(key);
      continue;
    }
    const b = baseline.clauses.get(key);
    const d = other.clauses.get(key);
    const bodyChanged = b.title !== d.title || b.body !== d.body;
    const edgesChanged = !edgeSetsEqual(edgesOf(baseline, key), edgesOf(other, key));
    const positionChanged = moved.has(key);
    if (bodyChanged || edgesChanged || positionChanged) {
      changed.push({
        key,
        title: d.title,
        body: bodyChanged,
        position: positionChanged,
        edges: edgesChanged,
        oldTitle: b.title,
      });
    }
  }
  for (const key of baseline.order) {
    if (!other.clauses.has(key)) deleted.push(key);
  }

  // 引用整体变化
  const baseEdgeKeys = new Set(baseline.edges.map(edgeKey));
  const otherEdgeKeys = new Set(other.edges.map(edgeKey));
  const refsAdded = other.edges.filter((e) => !baseEdgeKeys.has(edgeKey(e)));
  const refsRemoved = baseline.edges.filter((e) => !otherEdgeKeys.has(edgeKey(e)));

  return { added, deleted, changed, moved: [...moved], refsAdded, refsRemoved };
}

// ---------------------------------------------------------------------------
// 正文 token 级差异（LCS），中文按字切分
// ---------------------------------------------------------------------------
function tokenize(text) {
  const tokens = [];
  const re = /[\p{Script=Han}]|[A-Za-z0-9_]+|\s+|./gu;
  let m;
  while ((m = re.exec(text)) !== null) tokens.push(m[0]);
  return tokens;
}

function textDiff(a, b) {
  const A = tokenize(a || '');
  const B = tokenize(b || '');
  const n = A.length;
  const m = B.length;
  // dp[i][j] = LCS 长度；正文一般不长，直接 DP
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segments = [];
  const push = (op, text) => {
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.text += text;
    else segments.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('equal', A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', A[i]);
      i++;
    } else {
      push('ins', B[j]);
      j++;
    }
  }
  while (i < n) {
    push('del', A[i]);
    i++;
  }
  while (j < m) {
    push('ins', B[j]);
    j++;
  }
  return segments;
}

// ---------------------------------------------------------------------------
// 生效排程（纯逻辑）
// 版本行：{ id, effective_at(UTC ISO), schedule_status: immediate|scheduled|cancelled }
// - immediate：发布即生效，effective_at 取发布时刻；
// - scheduled：发布时已生成不可变快照，但 effective_at 尚未到（待生效队列）；
// - cancelled：待生效版本在生效前被取消，快照保留、永不生效。
// 生效判定完全依赖 effective_at 与 schedule_status（惰性生效，无后台任务）。
// ---------------------------------------------------------------------------
function pickEffectiveVersion(versions, atMs) {
  let best = null;
  let bestT = -Infinity;
  for (const v of versions) {
    if (v.schedule_status === 'cancelled') continue;
    const t = Date.parse(v.effective_at);
    if (!Number.isFinite(t) || t > atMs) continue; // 尚未到生效时刻
    if (!best || t > bestT || (t === bestT && v.id > best.id)) {
      best = v;
      bestT = t;
    }
  }
  return best ? best.id : null;
}

// 时刻 nowMs 时仍未生效的待生效版本，按发布版顺序（id）排列
function pendingVersions(versions, nowMs) {
  return versions
    .filter((v) => v.schedule_status === 'scheduled' && Date.parse(v.effective_at) > nowMs)
    .sort((a, b) => a.id - b.id);
}

// 待生效队列中目标版本的相邻版本（按发布版顺序），用于限制改期不得越过邻居
function scheduleNeighbors(pending, versionId) {
  let before = null;
  let after = null;
  for (const v of pending) {
    if (v.id < versionId) {
      if (!before || v.id > before.id) before = v;
    } else if (v.id > versionId) {
      if (!after || v.id < after.id) after = v;
    }
  }
  return { before, after };
}

function buildState({ order, clauses, edges }) {
  return {
    order: [...order],
    clauses: new Map(clauses.map((c) => [c.key, { key: c.key, title: c.title, body: c.body }])),
    edges: edges.map((e) => ({ source: e.source, target: e.target, label: e.label || '' })),
  };
}

module.exports = {
  keyError,
  movedKeys,
  touchedClauses,
  replayDraft,
  validateState,
  hasBlockingIssues,
  diffStates,
  textDiff,
  buildState,
  edgesOf,
  edgeKey,
  pickEffectiveVersion,
  pendingVersions,
  scheduleNeighbors,
};
