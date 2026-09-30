'use strict';
// 草案操作历史 / 撤销 / 重做 端到端冒烟测试。
// 用法：先启动服务，再 E2E_BASE=http://127.0.0.1:PORT node test/history.e2e.js
const base = process.env.E2E_BASE || 'http://127.0.0.1:3999';

let pass = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  pass++;
  console.log('  ✓ ' + msg);
}

async function call(method, p, body, expected) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (expected && res.status !== expected) {
    console.error(`✗ ${method} ${p} expected ${expected}, got ${res.status}:`, JSON.stringify(data));
    process.exit(1);
  }
  return data;
}

const orderOf = (det) => det.clauses.map((c) => c.key).join(',');
const edgesOf = (det) => det.refs.map((r) => `${r.source}->${r.target}#${r.label || ''}`).sort();

async function main() {
  await call('POST', '/api/initialize', {
    charter_title: '历史测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '附则', body: 'CCC' },
    ],
    refs: [{ source: 'B', target: 'A', label: '参见' }],
  }, 201);

  // ------------------------------------------------------------------
  // 1) 创建草案即有一条 create 记录，修订号从 1 开始
  // ------------------------------------------------------------------
  const created = await call('POST', '/api/drafts', { name: '修订草案' }, 201);
  const id = created.id;
  ok(created.revision === 1 && created.history_pos === 1, '新草案修订号为 1、历史游标为 1');
  let h = await call('GET', `/api/drafts/${id}/history`);
  ok(h.operations.length === 1 && h.operations[0].kind === 'create', '创建草案生成 create 操作记录');
  ok(h.can_undo === false && h.can_redo === false, '初始状态不能撤销/重做');
  ok(typeof h.operations[0].created_at === 'string', '操作记录带操作时间');
  ok(h.operations[0].summary.includes('修订草案'), '操作记录带摘要');

  // 已到最早状态：撤销被拒
  let err = await call('POST', `/api/drafts/${id}/undo`, { revision: 1 }, 409);
  ok(err.error === 'NOTHING_TO_UNDO', '已到最早状态时撤销返回 NOTHING_TO_UNDO');

  // ------------------------------------------------------------------
  // 2) 各类编辑逐步形成记录、修订号递增
  // ------------------------------------------------------------------
  let det = await call('POST', `/api/drafts/${id}/clauses`, { key: 'D', title: '新条', body: 'DDD' }, 200);
  ok(det.revision === 2, '新增条款后修订号递增为 2');
  det = await call('PUT', `/api/drafts/${id}/clauses/A`, { title: '总则', body: 'AAA-改' }, 200);
  ok(det.revision === 3, '改写条款后修订号递增为 3');
  await call('POST', `/api/drafts/${id}/clauses/C/move`, { after: 'A' }, 200); // A,C,B,D
  det = await call('GET', `/api/drafts/${id}?diff=1`);
  ok(orderOf(det) === 'A,C,B,D', '移动后顺序为 A,C,B,D');
  ok(det.revision === 4 && (det.diff.moved || []).includes('C'), '移动记录修订号 4 且差异标记 C 已移动');
  await call('POST', `/api/drafts/${id}/refs`, { source: 'A', target: 'C', label: '依据' }, 200);
  det = await call('GET', `/api/drafts/${id}`);
  ok(det.refs.length === 2 && det.revision === 5, '新增引用后共 2 条引用、修订号 5');
  await call('DELETE', `/api/drafts/${id}/refs/0`, 200);
  det = await call('GET', `/api/drafts/${id}`);
  ok(det.refs.length === 1 && det.refs[0].source === 'A' && det.refs[0].target === 'C', '删除引用 B->A，剩 A->C');
  ok(det.revision === 6, '删除引用后修订号 6');
  await call('PATCH', `/api/drafts/${id}`, { name: '修订草案-改名' }, 200);
  det = await call('GET', `/api/drafts/${id}`);
  ok(det.name === '修订草案-改名' && det.revision === 7, '改名生效、修订号 7');

  h = await call('GET', `/api/drafts/${id}/history`);
  ok(
    h.operations.map((o) => o.kind).join(',') ===
      'create,clause-add,clause-edit,clause-move,ref-add,ref-delete,rename',
    '七类操作记录齐全且顺序正确',
  );
  ok(h.history_pos === 7 && h.can_undo && !h.can_redo, '历史游标位于 7，可撤销不可重做');

  // ------------------------------------------------------------------
  // 3) 校验失败 / 无实际改动不产生记录、不递增修订号
  // ------------------------------------------------------------------
  err = await call('POST', `/api/drafts/${id}/clauses`, { key: '坏 标识', title: 'x', body: 'y' }, 400);
  ok(err.error === 'VALIDATION', '非法标识被拒绝');
  await call('PUT', `/api/drafts/${id}/clauses/A`, { title: '总则', body: 'AAA-改' }, 200); // 与当前相同
  await call('POST', `/api/drafts/${id}/clauses/A/move`, { ordinal: 0 }, 200); // A 已在第 0 位，无变化
  await call('PATCH', `/api/drafts/${id}`, { name: '修订草案-改名' }, 200); // 同名
  h = await call('GET', `/api/drafts/${id}/history`);
  ok(h.operations.length === 7 && h.revision === 7, '校验失败/无变化操作不产生记录、修订号保持 7');

  // ------------------------------------------------------------------
  // 4) 逐步撤销：名称、顺序、正文、引用、显式移动记录逐一还原
  // ------------------------------------------------------------------
  // 撤销改名
  let r = await call('POST', `/api/drafts/${id}/undo`, { revision: 7 }, 200);
  ok(r.applied_kind === 'rename' && r.draft.name === '修订草案', '撤销改名：名称还原');
  // 撤销删引用：B->A 恢复
  r = await call('POST', `/api/drafts/${id}/undo`, { revision: r.history.revision }, 200);
  ok(r.applied_kind === 'ref-delete' && edgesOf(r.draft).includes('B->A#参见') && r.draft.refs.length === 2,
    '撤销删除引用：B->A 恢复');
  // 撤销新增引用：回到仅 B->A
  r = await call('POST', `/api/drafts/${id}/undo`, { revision: r.history.revision }, 200);
  ok(r.applied_kind === 'ref-add' && r.draft.refs.length === 1 && r.draft.refs[0].source === 'B',
    '撤销新增引用：仅剩 B->A');
  // 撤销移动：顺序还原 A,B,C,D 且 C 不再是“已移动”
  r = await call('POST', `/api/drafts/${id}/undo`, { revision: r.history.revision }, 200);
  det = await call('GET', `/api/drafts/${id}?diff=1`);
  ok(r.applied_kind === 'clause-move' && orderOf(det) === 'A,B,C,D', '撤销移动：顺序还原 A,B,C,D');
  ok(!(det.diff.moved || []).includes('C'), '撤销移动：C 的显式移动记录被还原（差异不再标记移动）');
  // 撤销改写
  r = await call('POST', `/api/drafts/${id}/undo`, { revision: r.history.revision }, 200);
  ok(r.draft.clauses.find((c) => c.key === 'A').body === 'AAA', '撤销改写：A 正文还原为 AAA');
  // 撤销新增：D 消失，回到创建状态
  r = await call('POST', `/api/drafts/${id}/undo`, { revision: r.history.revision }, 200);
  ok(r.applied_kind === 'clause-add' && orderOf(r.draft) === 'A,B,C' && r.draft.name === '修订草案',
    '撤销新增：回到创建时完整状态（顺序/正文/引用/名称）');
  ok(r.history.history_pos === 1 && r.history.can_undo === false && r.history.can_redo === true, '撤销到顶：游标 1，只能重做');

  // ------------------------------------------------------------------
  // 5) 乐观修订号：过期拒绝覆盖并返回当前草案与历史
  // ------------------------------------------------------------------
  const stale = await call('POST', `/api/drafts/${id}/undo`, { revision: 3 }, 409);
  ok(stale.error === 'STALE_DRAFT_REVISION', '携带过期修订号撤销 -> 409 STALE_DRAFT_REVISION');
  ok(stale.draft && stale.history && stale.draft.revision === stale.history.revision, '过期响应返回当前草案与历史');
  const noRev = await call('POST', `/api/drafts/${id}/undo`, {}, 400);
  ok(noRev.error === 'VALIDATION', '缺少 revision -> 400 VALIDATION');

  // ------------------------------------------------------------------
  // 6) 逐步重做：重新回到最新状态（每次撤销/重做也推进修订号）
  // ------------------------------------------------------------------
  // 7 次编辑后 rev=7；6 次撤销后 rev=13、pos=1
  let curRev = r.history.revision;
  ok(curRev === 13, '六次撤销后修订号为 13（每次恢复也推进修订号）');
  r = await call('POST', `/api/drafts/${id}/redo`, { revision: curRev }, 200);
  ok(r.applied_kind === 'clause-add' && orderOf(r.draft) === 'A,B,C,D', '重做新增条款');
  for (let i = 0; i < 5; i++) {
    r = await call('POST', `/api/drafts/${id}/redo`, { revision: r.history.revision }, 200);
  }
  det = await call('GET', `/api/drafts/${id}?diff=1`);
  ok(det.name === '修订草案-改名' && orderOf(det) === 'A,C,B,D' && det.revision === 19,
    '全部重做后名称、顺序为最新状态，修订号随每次撤销/重做递增至 19');
  ok(det.refs.length === 1 && det.refs[0].source === 'A' && det.refs[0].target === 'C', '重做后引用为最新状态 A->C');
  err = await call('POST', `/api/drafts/${id}/redo`, { revision: det.revision }, 409);
  ok(err.error === 'NOTHING_TO_REDO', '已到最新状态时重做返回 NOTHING_TO_REDO');

  // ------------------------------------------------------------------
  // 7) 撤销后产生新编辑 -> 重做分支被舍弃
  // ------------------------------------------------------------------
  await call('POST', `/api/drafts/${id}/undo`, { revision: 19 }, 200); // 撤销改名 -> pos 6
  det = await call('POST', `/api/drafts/${id}/clauses`, { key: 'E', title: '另一条', body: 'EEE' }, 200);
  h = await call('GET', `/api/drafts/${id}/history`);
  const kinds = h.operations.map((o) => o.kind);
  ok(!kinds.includes('rename') && kinds.filter((k) => k === 'clause-add').length === 2,
    '撤销后再编辑：旧重做分支（rename）被删除，新编辑接在当前游标之后');
  ok(h.history_pos === h.operations.length && h.can_redo === false, '新编辑后无可重做项');
  // 改名记录被舍弃意味着名称停留在撤销后状态
  const dd = await call('GET', `/api/drafts/${id}`);
  ok(dd.name === '修订草案', '舍弃分支后名称为撤销后状态');

  // ------------------------------------------------------------------
  // 8) 删除条款后撤销：条款与其引用悬空状态一并还原
  // ------------------------------------------------------------------
  // 当前：A,C,B,D,E，引用 A->C（有效）。删除 A 后其出边悬空。
  let ddel = await call('DELETE', `/api/drafts/${id}/clauses/A`, 200);
  ok(ddel.publishable === false && ddel.issues.some((i) => i.code === 'dangling-ref'),
    '删除来源条款 A 后引用悬空、草案不可发布');
  ok(!ddel.clauses.some((c) => c.key === 'A'), '删除后条款集中无 A');
  r = await call('POST', `/api/drafts/${id}/undo`, { revision: ddel.revision }, 200);
  ok(r.draft.clauses.some((c) => c.key === 'A') && r.draft.publishable === true,
    '撤销删除：A 恢复、悬空引用消失、草案重新可发布');

  // ------------------------------------------------------------------
  // 9) 撤销/重做使恢复前取得的预览凭据失效
  // ------------------------------------------------------------------
  const pv = await call('POST', `/api/drafts/${id}/preview`, { note: '历史预览' }, 200);
  let hv = await call('GET', `/api/drafts/${id}/history`);
  await call('POST', `/api/drafts/${id}/undo`, { revision: hv.revision }, 200);
  const staleToken = await call('POST', `/api/drafts/${id}/publish`, { preview_token: pv.token }, 404);
  ok(staleToken.error === 'PREVIEW_TOKEN_NOT_FOUND', '撤销后恢复前的预览凭据失效 -> 404 PREVIEW_TOKEN_NOT_FOUND');
  // 重做回最新内容
  hv = await call('GET', `/api/drafts/${id}/history`);
  await call('POST', `/api/drafts/${id}/redo`, { revision: hv.revision }, 200);

  // ------------------------------------------------------------------
  // 10) 恢复后的草案仍按现有规则计算差异、预览与发布
  // ------------------------------------------------------------------
  det = await call('GET', `/api/drafts/${id}?diff=1`);
  ok(Array.isArray(det.diff.added) && Array.isArray(det.issues), '恢复后草案差异与问题清单仍正常计算');
  const pv2 = await call('POST', `/api/drafts/${id}/preview`, { note: '恢复后预览' }, 200);
  ok(pv2.token && pv2.preview === true, '恢复后可重新预览');
  const pub = await call('POST', `/api/drafts/${id}/publish`, { preview_token: pv2.token }, 201);
  ok(pub.version_id >= 2 && pub.confirmed_from_preview === true, '恢复后的草案可按现有凭据确认流程发布');

  // ------------------------------------------------------------------
  // 11) 已发布草案：历史可查看，撤销/重做及一切编辑不可操作
  // ------------------------------------------------------------------
  const closed = await call('GET', `/api/drafts/${id}`);
  ok(closed.status === 'published', '发布后草案状态为 published');
  h = await call('GET', `/api/drafts/${id}/history`);
  ok(h.operations.length >= 1 && Array.isArray(h.operations), '已发布草案仍可查看操作历史');
  err = await call('POST', `/api/drafts/${id}/undo`, { revision: h.revision }, 409);
  ok(err.error === 'CLOSED', '已发布草案撤销被拒（CLOSED）');
  err = await call('POST', `/api/drafts/${id}/redo`, { revision: h.revision }, 409);
  ok(err.error === 'CLOSED', '已发布草案重做被拒（CLOSED）');
  err = await call('POST', `/api/drafts/${id}/clauses`, { key: 'Z', title: 'z', body: 'z' }, 409);
  ok(err.error === 'CLOSED', '已发布草案不能再编辑');

  // ------------------------------------------------------------------
  // 12) 持久化：操作记录落 SQLite（历史可重复读取，重启由 run-e2e 库文件持久性保证）
  // ------------------------------------------------------------------
  h = await call('GET', `/api/drafts/${id}/history`);
  const seqCount = h.operations.length;
  // create / 6 类编辑 / 撤销后新增 E（截断 rename）/ 删除 A（删除记录在撤销后仍保留）
  ok(seqCount === 8, `操作历史条目完整保留（${seqCount} 条：create、各类编辑，撤销后新编辑截断旧分支，撤销不删记录）`);

  console.log(`\n${pass} 项历史/撤销/重开端到端断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
