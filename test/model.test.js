'use strict';
// 纯逻辑测试：node test/model.test.js
const assert = require('assert');
const {
  buildState,
  touchedClauses,
  replayDraft,
  validateState,
  hasBlockingIssues,
  diffStates,
  movedKeys,
  textDiff,
} = require('../src/model');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function S(order, clauses, edges = []) {
  return buildState({
    order,
    clauses: clauses.map(([key, title, body]) => ({ key, title, body: body || title })),
    edges,
  });
}

const baseline = S(
  ['A', 'B', 'C'],
  [
    ['A', '总则'],
    ['B', '会员'],
    ['C', '附则'],
  ],
  [{ source: 'A', target: 'B', label: '见' }],
);

test('不相交改动可重放：草案改 A，最新版改 C', () => {
  const draft = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则修订', '新内容'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则修订'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.clauses.get('A').title, '总则修订');
  assert.strictEqual(r.merged.clauses.get('C').title, '附则修订');
});

test('同一条款双方改动 -> modify-modify 冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则Y'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts[0].kind, 'modify-modify');
  assert.strictEqual(r.conflicts[0].key, 'A');
});

test('双方同样修改（收敛）不冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok);
});

test('草案删除、最新版修改 -> delete-modify 冲突', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'delete-modify' && c.key === 'A'));
});

test('双方都删除 A -> 收敛，结果不含 A', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.ok(!r.merged.clauses.has('A'));
  assert.deepStrictEqual(r.merged.order, ['B', 'C']);
});

test('重放后引用悬空（草案删 B，但保留 A->B 引用为悬空暂存；最新版没动）-> 拒绝', () => {
  // 删除条款时入边保留在草案中（可暂存的悬空引用）
  const draft = S(
    ['A', 'C'],
    [
      ['A', '总则'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [
      { source: 'A', target: 'B', label: '见' },
      { source: 'C', target: 'A', label: '' },
    ],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.dangling.some((d) => d.source === 'A' && d.target === 'B'));
});

test('草案删除 B 且最新版也删除 B（引用一并消失）-> 不悬空', () => {
  const draft = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const latest = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.edges.length, 0);
});

test('新增条款不相交：草案加 D，最新版加 E，顺序按锚点插入', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '附则二']], baseline.edges);
  const latest = S(['A', 'E', 'B', 'C'], [['A', '总则'], ['E', '新增E'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  // E 在最新版的位置（A 后），D 由草案放置在末尾
  assert.deepStrictEqual(r.merged.order, ['A', 'E', 'B', 'C', 'D']);
});

test('双方新增同标识但内容不同 -> add-add 冲突', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '草案的D']], baseline.edges);
  const latest = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '最新版的D']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'add-add'));
});

test('草案移动 B 到末尾，最新版改 C：重放后 B 在末尾', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员'], ['C', '附则X']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['B']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('C').title, '附则X');
  assert.ok(r.mergedMoved.has('B'));
});

test('草案前移 C（显式移动 C），最新版只改 B 正文：不相交，可重放', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员修订'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['C']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('B').title, '会员修订');
});

test('显式移动集合用于触碰判定（被动让位条款不算移动）', () => {
  const other = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const t = touchedClauses(baseline, other, new Set(['C']));
  assert.ok(t.get('C').position); // C 被显式移动
  assert.strictEqual(t.get('B'), undefined); // B 只是被动让位
  assert.strictEqual(t.get('A'), undefined);
});

test('草案可暂存悬空引用：validate 报 error，阻止发布', () => {
  const s = S(['A'], [['A', '总则']], [{ source: 'A', target: 'ZZZ', label: '' }]);
  const issues = validateState(s);
  assert.ok(issues.some((i) => i.code === 'dangling-ref'));
  assert.ok(hasBlockingIssues(issues));
});

test('结构差异：新增/删除/修改分类', () => {
  const d = diffStates(
    baseline,
    S(['A', 'C'], [['A', '总则改'], ['C', '附则']], [{ source: 'C', target: 'A', label: '' }]),
  );
  assert.deepStrictEqual(d.deleted, ['B']);
  assert.ok(d.changed.some((c) => c.key === 'A' && c.body));
  assert.strictEqual(d.refsRemoved.length, 1);
  assert.strictEqual(d.refsAdded.length, 1);
});

test('textDiff 中文按字标注增删', () => {
  const segs = textDiff('社团章程', '社团新章程');
  const ins = segs.filter((s) => s.op === 'ins').map((s) => s.text).join('');
  const del = segs.filter((s) => s.op === 'del').map((s) => s.text).join('');
  assert.strictEqual(ins, '新');
  assert.strictEqual(del, '');
});

test('movedKeys 检测前驱锚点变化（交换中只标记后移者）', () => {
  assert.deepStrictEqual([...movedKeys(['A', 'B', 'C'], ['A', 'C', 'B'])], ['B']);
});

// ---------------------------------------------------------------------------
// 生效排程
// ---------------------------------------------------------------------------
const {
  pickEffectiveVersion,
  pendingVersions,
  scheduleNeighbors,
} = require('../src/model');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const H = 3600 * 1000;
function sch(rows) {
  // rows: [id, 相对 T0 的小时数, 状态]
  return rows.map(([id, h, status = 'scheduled']) => ({
    id,
    effective_at: new Date(T0 + h * H).toISOString(),
    schedule_status: status,
  }));
}

test('pickEffectiveVersion：取生效时刻已到且最大的版本；未到/已取消排除', () => {
  const vs = sch([
    [1, -10, 'immediate'], // v1 早已即时生效
    [2, 2, 'scheduled'],   // T0+2h 生效
    [3, 4, 'cancelled'],   // 被取消，永不生效
    [4, 6, 'scheduled'],   // 更晚
  ]);
  assert.strictEqual(pickEffectiveVersion(vs, T0 - H), 1);
  assert.strictEqual(pickEffectiveVersion(vs, T0), 1);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 2 * H), 2);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 3 * H), 2);
  // v3 被取消：跳过，仍是 v2
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 5 * H), 2);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 6 * H), 4);
  // 无任何已生效版本
  assert.strictEqual(pickEffectiveVersion(sch([[1, 1]]), T0), null);
});

test('pickEffectiveVersion：生效时刻相同时取较大 id（确定性）', () => {
  const vs = sch([
    [1, 0, 'immediate'],
    [2, 1, 'scheduled'],
  ]);
  // 构造相同时刻
  vs[1].effective_at = vs[0].effective_at;
  assert.strictEqual(pickEffectiveVersion(vs, T0 + H), 2);
});

test('pendingVersions：仅返回时刻仍在未来的 scheduled，按 id 升序', () => {
  const vs = sch([
    [1, -10, 'immediate'],
    [2, -1, 'scheduled'],  // 已到点（惰性生效），不在队列
    [3, 1, 'cancelled'],   // 取消，不在队列
    [4, 3, 'scheduled'],
    [5, 5, 'scheduled'],
  ]);
  assert.deepStrictEqual(pendingVersions(vs, T0).map((v) => v.id), [4, 5]);
});

test('scheduleNeighbors：按发布版顺序找相邻待生效版本', () => {
  const q = sch([
    [2, 1],
    [4, 3],
    [7, 5],
  ]);
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 4)).map(([k, v]) => [k, v?.id ?? null])),
    { before: 2, after: 7 },
  );
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 2)).map(([k, v]) => [k, v?.id ?? null])),
    { before: null, after: 4 },
  );
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 7)).map(([k, v]) => [k, v?.id ?? null])),
    { before: 4, after: null },
  );
});

console.log(`\n${passed} 项测试全部通过`);
