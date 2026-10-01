'use strict';
// 草案操作历史 / 撤销 / 重做 端到端测试。
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
  return { status: res.status, data };
}

async function main() {
  // 首版 v1：A B C，引用 B->A
  await call('POST', '/api/initialize', {
    charter_title: '历史测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '附则', body: 'CCC' },
    ],
    refs: [{ source: 'B', target: 'A', label: '参见' }],
  }, 201);

  const d0 = await call('POST', '/api/drafts', { name: '原始草案名' }, 201);
  const D = d0.data.id;

  // 新建草案无历史
  let det = (await call('GET', `/api/drafts/${D}`)).data;
  ok(det.revision === 0 && det.history.total === 0 && det.history.can_undo === false && det.history.can_redo === false,
    '新草案 revision=0、无历史、不可撤销/重做');

  // ----------------------------------------------------------------------
  // 1) 各类编辑均形成持久操作记录，页面字段含时间与摘要
  // ----------------------------------------------------------------------
  await call('PATCH', `/api/drafts/${D}`, { name: '新草案名' }, 200);
  det = (await call('GET', `/api/drafts/${D}`)).data;
  ok(det.revision === 1 && det.name === '新草案名', '改名成功，revision 递增为 1');
  ok(det.history.operations[0].kind === 'rename' && /改名/.test(det.history.operations[0].summary),
    '改名形成操作记录与中文摘要');
  ok(typeof det.history.operations[0].created_at === 'string' && det.history.operations[0].created_at.length > 10,
    '操作记录含操作时间');

  await call('POST', `/api/drafts/${D}/clauses`, { key: 'D', title: '新条', body: 'DDD' }, 200);
  await call('PUT', `/api/drafts/${D}/clauses/A`, { title: '总则', body: 'AAA-改' }, 200);
  await call('POST', `/api/drafts/${D}/clauses/C/move`, { after: 'A' }, 200); // A,C,B,D
  await call('POST', `/api/drafts/${D}/refs`, { source: 'A', target: 'C', label: '依据' }, 200);
  await call('POST', `/api/drafts/${D}/clauses`, { key: 'E', title: '再新条', body: 'EEE' }, 200);

  det = (await call('GET', `/api/drafts/${D}?diff=1`)).data;
  ok(det.revision === 6, `6 次成功编辑后 revision=6（实际 ${det.revision}）`);
  ok(JSON.stringify(det.clauses.map((c) => c.key)) === JSON.stringify(['A', 'C', 'B', 'D', 'E']), '当前顺序 A,C,B,D,E');
  ok(det.refs.some((r) => r.source === 'A' && r.target === 'C'), '新引用已登记');
  ok(det.history.operations.map((o) => o.kind).join(',') ===
    'rename,clause-add,clause-edit,clause-move,ref-add,clause-add',
    '操作记录顺序与类型正确：' + det.history.operations.map((o) => o.kind).join(','));
  ok(det.history.operations.every((o) => o.active), '当前所有记录均处于生效状态');

  // 移动摘要含旧/新位置
  const moveOp = det.history.operations.find((o) => o.kind === 'clause-move');
  ok(moveOp.detail.from === 2 && moveOp.detail.to === 1 && /第 3 位 → 第 2 位/.test(moveOp.summary), '移动记录摘要与位置细节');

  // ----------------------------------------------------------------------
  // 2) 校验失败不产生记录；无变化操作不产生记录
  // ----------------------------------------------------------------------
  const badAdd = await call('POST', `/api/drafts/${D}/clauses`, { key: 'D', title: 'x', body: 'y' }, 400);
  ok(badAdd.data.error === 'DUP_KEY', '重复标识新增被拒绝');
  const badEdit = await call('PUT', `/api/drafts/${D}/clauses/A`, { title: '总则', body: '   ' }, 400);
  ok(badEdit.data.error === 'VALIDATION', '空正文改写被拒绝');
  det = (await call('GET', `/api/drafts/${D}`)).data;
  ok(det.revision === 6 && det.history.total === 6, '校验失败不产生记录、revision 不变');

  await call('PUT', `/api/drafts/${D}/clauses/B`, { title: '会员', body: 'BBB' }, 200); // 与现状完全一致
  await call('PATCH', `/api/drafts/${D}`, { name: '新草案名' }, 200); // 同名
  await call('POST', `/api/drafts/${D}/clauses/B/move`, { ordinal: 2 }, 200); // B 已在索引 2
  det = (await call('GET', `/api/drafts/${D}`)).data;
  ok(det.revision === 6 && det.history.total === 6, '无变化操作不产生记录');

  // ----------------------------------------------------------------------
  // 3) 逐步撤销：顺序、标题正文、引用、显式移动记录、名称逐项还原
  // ----------------------------------------------------------------------
  // 撤销新增 E
  let r = (await call('POST', `/api/drafts/${D}/undo`, { revision: 6 }, 200)).data;
  ok(r.revision === 5 && r.draft.clauses.map((c) => c.key).join() === 'A,C,B,D', '撤销新增 E：条款消失，revision→5');
  ok(r.history.can_redo === true && r.history.redo_seq === 6, '撤销后可重做（redo_seq=6）');

  // 撤销新增引用 A->C：引用还原
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: 5 }, 200)).data;
  ok(r.draft.refs.some((x) => x.source === 'B' && x.target === 'A') &&
    !r.draft.refs.some((x) => x.source === 'A' && x.target === 'C'), '撤销引用新增：引用集还原');
  ok(r.revision === 4, 'revision→4');

  // 撤销移动 C：顺序与显式移动记录还原（相对基线不再标记 moved）
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: 4 }, 200)).data;
  ok(r.draft.clauses.map((c) => c.key).join() === 'A,B,C,D', '撤销移动：顺序还原为 A,B,C,D');
  const diffView = (await call('GET', `/api/drafts/${D}?diff=1`)).data;
  ok(!diffView.diff.moved.includes('C'), '撤销移动后显式移动记录一并还原（差异不再标记移动）');

  // 撤销改写 A：标题正文还原
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: 3 }, 200)).data;
  ok(r.draft.clauses.find((c) => c.key === 'A').body === 'AAA', '撤销改写：A 正文还原');
  // 撤销新增 D
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: 2 }, 200)).data;
  ok(r.draft.clauses.map((c) => c.key).join() === 'A,B,C', '撤销新增 D：还原为基线三条款');
  // 撤销改名
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: 1 }, 200)).data;
  ok(r.draft.name === '原始草案名' && r.revision === 0 && r.history.can_undo === false,
    '撤销改名：名称还原，revision→0、不可继续撤销');
  ok(r.history.operations.length === 6 && r.history.operations.every((o) => !o.active),
    '记录全部保留但标记为未生效（可重做）');

  // ----------------------------------------------------------------------
  // 4) 逐步重做：状态重新前进
  // ----------------------------------------------------------------------
  r = (await call('POST', `/api/drafts/${D}/redo`, { revision: 0 }, 200)).data;
  ok(r.draft.name === '新草案名' && r.revision === 1, '重做改名');
  r = (await call('POST', `/api/drafts/${D}/redo`, { revision: 1 }, 200)).data;
  ok(r.draft.clauses.some((c) => c.key === 'D') && r.revision === 2, '重做新增 D');
  r = (await call('POST', `/api/drafts/${D}/redo`, { revision: 2 }, 200)).data;
  ok(r.draft.clauses.find((c) => c.key === 'A').body === 'AAA-改', '重做改写 A');
  r = (await call('POST', `/api/drafts/${D}/redo`, { revision: 3 }, 200)).data;
  ok(r.draft.clauses.map((c) => c.key).join() === 'A,C,B,D', '重做移动：顺序与移动记录恢复');
  const diffView2 = (await call('GET', `/api/drafts/${D}?diff=1`)).data;
  ok(diffView2.diff.moved.includes('C'), '重做后显式移动记录恢复（差异重新标记移动）');
  r = (await call('POST', `/api/drafts/${D}/redo`, { revision: 4 }, 200)).data;
  ok(r.draft.refs.some((x) => x.source === 'A' && x.target === 'C'), '重做引用新增');
  r = (await call('POST', `/api/drafts/${D}/redo`, { revision: 5 }, 200)).data;
  ok(r.draft.clauses.map((c) => c.key).join() === 'A,C,B,D,E' && r.history.can_redo === false,
    '重做全部完成：状态回到 A,C,B,D,E，尽头不可继续重做');

  // 到头继续撤销/重做
  const noRedo = await call('POST', `/api/drafts/${D}/redo`, { revision: 6 }, 409);
  ok(noRedo.data.error === 'NOTHING_TO_REDO', '重做尽头返回 NOTHING_TO_REDO');

  // ----------------------------------------------------------------------
  // 5) 删除条款（引用悬空）后撤销：条款与其引用完整还原
  // ----------------------------------------------------------------------
  await call('DELETE', `/api/drafts/${D}/clauses/B`, 200); // B->A 变悬空
  det = (await call('GET', `/api/drafts/${D}`)).data;
  ok(det.publishable === false && det.issues.some((i) => i.code === 'dangling-ref'), '删 B 后引用悬空、不可发布');
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: det.revision }, 200)).data;
  ok(r.draft.clauses.some((c) => c.key === 'B') &&
    r.draft.refs.some((x) => x.source === 'B' && x.target === 'A') && r.draft.publishable === true,
    '撤销删除：条款与出边引用完整还原，悬空消除');

  // 删除引用后撤销（当前引用：B->A（参见）与 A->C（依据））
  const refsBefore = r.draft.refs;
  const refIdx = refsBefore.findIndex((x) => x.source === 'B' && x.target === 'A');
  await call('DELETE', `/api/drafts/${D}/refs/${refIdx}`, 200);
  det = (await call('GET', `/api/drafts/${D}`)).data;
  ok(det.refs.length === refsBefore.length - 1, '删除引用成功');
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: det.revision }, 200)).data;
  ok(r.draft.refs.length === refsBefore.length, '撤销引用删除：引用数量还原');
  ok(r.draft.refs.some((x) => x.source === 'B' && x.target === 'A' && x.label === '参见'),
    '撤销引用删除：被删引用（B→A 参见）还原');

  // ----------------------------------------------------------------------
  // 6) 乐观锁：修订号过期拒绝覆盖并返回当前草案；缺修订号 400
  // ----------------------------------------------------------------------
  det = (await call('GET', `/api/drafts/${D}`)).data;
  const staleRev = det.revision;
  await call('PUT', `/api/drafts/${D}/clauses/A`, { title: '总则', body: 'AAA-并发改' }, 200);
  const stale = await call('POST', `/api/drafts/${D}/undo`, { revision: staleRev }, 409);
  ok(stale.data.error === 'STALE_DRAFT_REVISION', '过期修订号撤销被拒绝');
  ok(stale.data.draft && stale.data.draft.revision === staleRev + 1 &&
    stale.data.draft.clauses.find((c) => c.key === 'A').body === 'AAA-并发改', '拒绝响应返回当前草案内容');
  ok(stale.data.history.revision === staleRev + 1, '拒绝响应返回当前历史游标');

  const noRev = await call('POST', `/api/drafts/${D}/undo`, {}, 400);
  ok(noRev.data.error === 'VALIDATION', '缺少 revision 被 400 拒绝');

  // 用返回的当前草案修订号重试：成功
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: staleRev + 1 }, 200)).data;
  ok(r.draft.clauses.find((c) => c.key === 'A').body === 'AAA-改', '携带最新修订号撤销成功');

  // ----------------------------------------------------------------------
  // 7) 撤销后产生新编辑：重做分支舍弃
  // ----------------------------------------------------------------------
  // 当前 revision 回到 6（撤销了并发的 A 改写）。再撤销两步到 revision=4
  await call('POST', `/api/drafts/${D}/undo`, { revision: 6 }, 200);
  r = (await call('POST', `/api/drafts/${D}/undo`, { revision: 5 }, 200)).data;
  ok(r.revision === 4, `撤销到 4（实际 revision=${r.revision}）`);
  ok(r.history.can_redo === true && r.history.total >= 5, '撤销后重做分支保留、可重做');
  // 新编辑：新增 F
  await call('POST', `/api/drafts/${D}/clauses`, { key: 'F', title: '分支新条', body: 'FFF' }, 200);
  det = (await call('GET', `/api/drafts/${D}`)).data;
  ok(det.revision === 5 && det.history.total === 5 && det.history.can_redo === false,
    '新编辑后重做分支被舍弃（total=5、不可重做）');
  ok(det.history.operations[4].kind === 'clause-add' && det.history.operations[4].detail.key === 'F',
    '新编辑占据 seq=5');
  ok(det.clauses.some((c) => c.key === 'F'), '新编辑生效：F 存在');

  // 重做尽头
  const noRedo2 = await call('POST', `/api/drafts/${D}/redo`, { revision: 5 }, 409);
  ok(noRedo2.data.error === 'NOTHING_TO_REDO', '分支舍弃后无操作可重做');

  // ----------------------------------------------------------------------
  // 8) 恢复后的草案仍按现有规则差异/预览/发布；恢复前预览凭据失效
  // ----------------------------------------------------------------------
  // 撤销到与基线一致（撤销新增 F、引用 A->C、移动 C、改写 A、新增 D、改名），
  // 构造一个干净的“与 v1 完全一致”的草案：直接新建一个草案验证 NO_CHANGES。
  const dClean = (await call('POST', '/api/drafts', { name: '干净草案' }, 201)).data;
  const noChanges = await call('POST', `/api/drafts/${dClean.id}/publish`, {}, 400);
  ok(noChanges.data.error === 'NO_CHANGES', '恢复/未改动草案沿用现有发布校验（NO_CHANGES）');

  // 恢复前取得的预览凭据在撤销后失效
  const dPv = (await call('POST', '/api/drafts', { name: '凭据草案' }, 201)).data;
  await call('PUT', `/api/drafts/${dPv.id}/clauses/A`, { title: '总则', body: 'AAA-预览' }, 200);
  const pv = (await call('POST', `/api/drafts/${dPv.id}/preview`, { note: '待撤销' }, 200)).data;
  ok(/^[0-9a-f]{64}$/.test(pv.token), '预览成功发放凭据');
  det = (await call('GET', `/api/drafts/${dPv.id}`)).data;
  await call('POST', `/api/drafts/${dPv.id}/undo`, { revision: det.revision }, 200);
  const gone = await call('POST', `/api/drafts/${dPv.id}/publish`, { preview_token: pv.token }, 404);
  ok(gone.data.error === 'PREVIEW_TOKEN_NOT_FOUND', '撤销恢复后恢复前的预览凭据失效（404）');

  // 重做后重新预览并确认发布成功——恢复后的草案照常预览/发布
  r = (await call('POST', `/api/drafts/${dPv.id}/redo`, { revision: 0 }, 200)).data;
  ok(r.draft.clauses.find((c) => c.key === 'A').body === 'AAA-预览', '重做恢复编辑内容');
  const pv2 = (await call('POST', `/api/drafts/${dPv.id}/preview`, { note: '恢复后发布' }, 200)).data;
  const pub = (await call('POST', `/api/drafts/${dPv.id}/publish`, { preview_token: pv2.token }, 201)).data;
  ok(pub.version_id >= 2 && pub.confirmed_from_preview === true, '恢复后的草案可重新预览并凭据确认发布');

  // ----------------------------------------------------------------------
  // 9) 已发布草案不可撤销/重做（历史仍可查看）
  // ----------------------------------------------------------------------
  const closedUndo = await call('POST', `/api/drafts/${dPv.id}/undo`, { revision: 1 }, 409);
  ok(closedUndo.data.error === 'CLOSED', '已发布草案不可撤销');
  const closedRedo = await call('POST', `/api/drafts/${dPv.id}/redo`, { revision: 0 }, 409);
  ok(closedRedo.data.error === 'CLOSED', '已发布草案不可重做');
  const hist = (await call('GET', `/api/drafts/${dPv.id}/history`)).data;
  ok(hist.total >= 1 && hist.operations[0].summary && hist.operations[0].created_at,
    'GET /history 可查看已发布草案的完整操作记录（时间+摘要）');

  console.log(`\n${pass} 项历史/撤销/重端端到端断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
