'use strict';
// 发布预览 / 凭据确认 端到端冒烟测试。
// 用法：先启动服务，再 E2E_BASE=http://127.0.0.1:PORT node test/preview.e2e.js
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
    charter_title: '预览测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '附则', body: 'CCC' },
    ],
    refs: [{ source: 'B', target: 'A', label: '参见' }],
  }, 201);

  // ----------------------------------------------------------------------
  // 1) 预览成功：不写版本、不关闭草案，返回凭据与差异
  // ----------------------------------------------------------------------
  const d1 = await call('POST', '/api/drafts', { name: '预览草案1' }, 201);
  await call('POST', `/api/drafts/${d1.data.id}/clauses`, { key: 'D', title: '新条', body: 'DDD' });
  await call('PUT', `/api/drafts/${d1.data.id}/clauses/A`, { title: '总则', body: 'AAA-改' });

  const pv = await call('POST', `/api/drafts/${d1.data.id}/preview`, { note: '预览版说明' }, 200);
  const p = pv.data;
  ok(/^[0-9a-f]{64}$/.test(p.token), '预览成功返回 64 位十六进制确认凭据');
  ok(p.preview === true && p.schedule_status === 'immediate' && p.effective_at === null, '即时预览生效安排为 immediate / effective_at=null');
  ok(p.final.order.join() === 'A,B,C,D', '预览返回最终条款顺序 A,B,C,D');
  ok(p.final.clauses.find((c) => c.key === 'A').body === 'AAA-改', '预览返回最终条款正文');
  ok(p.diff.added.join() === 'D' && p.diff.changed.some((c) => c.key === 'A'), '预览返回相对最新版的新增/修改差异');
  ok(p.changed_detail.find((c) => c.key === 'A').bodySegments.some((s) => s.op === 'ins'), '预览返回正文逐字差异');
  ok(p.diff.refs_removed.length === 0 && p.final.refs.some((r) => r.source === 'B' && r.target === 'A'), '预览返回最终引用集');

  let ov = await call('GET', '/api/overview');
  ok(ov.data.latest_version_id === 1, '预览不产生新版本（最新仍为 v1）');
  let det = await call('GET', `/api/drafts/${d1.data.id}`);
  ok(det.data.status === 'open', '预览不关闭草案（仍为 open）');
  ok(p.note === '预览版说明', '预览回显发布说明');

  // ----------------------------------------------------------------------
  // 2) 草案预览后被编辑 -> 凭据失效，重新预览后可确认发布
  // ----------------------------------------------------------------------
  await call('PUT', `/api/drafts/${d1.data.id}/clauses/B`, { title: '会员', body: 'BBB-编辑后' });
  let stale = await call('POST', `/api/drafts/${d1.data.id}/publish`, { preview_token: p.token }, 409);
  ok(stale.data.error === 'DRAFT_CHANGED_AFTER_PREVIEW' && stale.data.retained === true, '预览后编辑草案 -> 409 DRAFT_CHANGED_AFTER_PREVIEW 并保留草案');
  ok(stale.data.schedule && typeof stale.data.schedule.schedule_revision === 'number', '失效响应附带当前排程');
  det = await call('GET', `/api/drafts/${d1.data.id}`);
  ok(det.data.status === 'open', '失效后草案仍为 open');

  const pv2 = await call('POST', `/api/drafts/${d1.data.id}/preview`, { note: '预览版说明v2' }, 200);
  // 旧凭据因同草案重新预览已被取代（删除）
  stale = await call('POST', `/api/drafts/${d1.data.id}/publish`, { preview_token: p.token }, 404);
  ok(stale.data.error === 'PREVIEW_TOKEN_NOT_FOUND', '同一草案重新预览后旧凭据作废 -> 404 PREVIEW_TOKEN_NOT_FOUND');

  const conf = await call('POST', `/api/drafts/${d1.data.id}/publish`, { preview_token: pv2.data.token }, 201);
  ok(conf.data.version_id === 2 && conf.data.confirmed_from_preview === true, '持新凭据确认发布成功为 v2');
  ok(conf.data.replayed === false && conf.data.preview_token === pv2.data.token, '确认响应回显凭据且非重放');
  const v2 = await call('GET', '/api/versions/2');
  ok(v2.data.clauses.map((c) => c.key).join() === 'A,B,C,D', 'v2 条款顺序与预览一致');
  ok(v2.data.clauses.find((c) => c.key === 'B').body === 'BBB-编辑后', 'v2 正文与预览一致（含编辑后内容）');
  ok(v2.data.note === '预览版说明v2', 'v2 发布说明即预览时锁定的说明');
  det = await call('GET', `/api/drafts/${d1.data.id}`);
  ok(det.data.status === 'published', '确认发布后草案关闭');

  // 凭据不可重复使用
  const reused = await call('POST', `/api/drafts/${d1.data.id}/publish`, { preview_token: pv2.data.token }, 409);
  ok(reused.data.error === 'PREVIEW_ALREADY_CONSUMED' || reused.data.error === 'CLOSED' || reused.data.error === 'DRAFT_ALREADY_PUBLISHED',
    `重复使用凭据被拒（${reused.data.error}）`);

  // ----------------------------------------------------------------------
  // 3) 其他草案先发布 -> 凭据失效（LATEST_VERSION_CHANGED），重预览后走重放
  //    v2 改了 A、B，故本草案改 C 保证不相交
  // ----------------------------------------------------------------------
  const d2 = await call('POST', '/api/drafts', { name: '预览草案2', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d2.data.id}/clauses/C`, { title: '附则', body: 'CCC-预览2' });
  const pvD2 = await call('POST', `/api/drafts/${d2.data.id}/preview`, {}, 200);
  ok(pvD2.data.replayed === true && pvD2.data.latest_version_id === 2, '基线落后时预览标注将重放到最新版 v2');
  ok(pvD2.data.final.order.join() === 'A,B,C,D', '预览重放结果保留 v2 的新增 D');

  // 另一草案先发布（v3，即时；当前队列空）——基于 v2 改 A 会与 d2（基于 v1）冲突？
  // d2 改 C，不相交，安全。
  const dOther = await call('POST', '/api/drafts', { name: '抢先发布的草案' }, 201);
  await call('POST', `/api/drafts/${dOther.data.id}/clauses`, { key: 'E', title: '抢先新条', body: 'EEE-抢先' });
  const otherPub = await call('POST', `/api/drafts/${dOther.data.id}/publish`, { note: '抢先v3' }, 201);
  ok(otherPub.data.version_id === 3, '另一草案直接发布为 v3');

  stale = await call('POST', `/api/drafts/${d2.data.id}/publish`, { preview_token: pvD2.data.token }, 409);
  ok(stale.data.error === 'LATEST_VERSION_CHANGED', '预览后其他草案先发布 -> 409 LATEST_VERSION_CHANGED');

  // 重新预览：d2 改 C 与 v3 新增 E 不相交 -> 重放成功；确认后 v4 同时含两侧改动
  const pvD2b = await call('POST', `/api/drafts/${d2.data.id}/preview`, {}, 200);
  ok(pvD2b.data.replayed === true && pvD2b.data.latest_version_id === 3, '重新预览基于新最新版 v3 重放');
  const conf2 = await call('POST', `/api/drafts/${d2.data.id}/publish`, { preview_token: pvD2b.data.token }, 201);
  ok(conf2.data.version_id === 4 && conf2.data.replayed === true, '重放预览确认发布为 v4');
  const v4 = await call('GET', '/api/versions/4');
  ok(v4.data.clauses.find((c) => c.key === 'C').body === 'CCC-预览2', 'v4 含本草案的 C 修改');
  ok(v4.data.clauses.find((c) => c.key === 'E').body === 'EEE-抢先', 'v4 含抢先发布 v3 的新增 E');
  ok(v4.data.clauses.find((c) => c.key === 'B').body === 'BBB-编辑后', 'v4 保留 v2 的 B 修改');

  // ----------------------------------------------------------------------
  // 4) 预览冲突 / 悬空 / 无改动：沿用发布错误语义，不返回凭据
  // ----------------------------------------------------------------------
  const d3 = await call('POST', '/api/drafts', { name: '冲突草案', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d3.data.id}/clauses/A`, { title: '总则', body: 'AAA-冲突方' });
  const conflict = await call('POST', `/api/drafts/${d3.data.id}/preview`, {}, 409);
  ok(conflict.data.error === 'CONFLICT' && conflict.data.conflicts[0].kind === 'modify-modify', '预览检测到同条款冲突 -> 409 CONFLICT（与发布同语义）');
  ok(conflict.data.token === undefined, '预览失败不返回确认凭据');

  const dBad = await call('POST', '/api/drafts', { name: '悬空草案' }, 201);
  await call('POST', `/api/drafts/${dBad.data.id}/refs`, { source: 'A', target: 'GHOST', label: '' });
  const invalid = await call('POST', `/api/drafts/${dBad.data.id}/preview`, {}, 409);
  ok(invalid.data.error === 'DRAFT_INVALID' && invalid.data.issues.some((i) => i.code === 'dangling-ref'), '悬空草案预览 -> 409 DRAFT_INVALID 并列问题');

  const dNoop = await call('POST', '/api/drafts', { name: '无改动草案' }, 201);
  const noop = await call('POST', `/api/drafts/${dNoop.data.id}/preview`, {}, 400);
  ok(noop.data.error === 'NO_CHANGES', '无改动预览 -> 400 NO_CHANGES');

  // 草案重命名也使凭据失效
  const dRename = await call('POST', '/api/drafts', { name: '改名草案' }, 201);
  await call('PUT', `/api/drafts/${dRename.data.id}/clauses/A`, { title: '总则', body: 'AAA-改名预览' });
  const pvR = await call('POST', `/api/drafts/${dRename.data.id}/preview`, {}, 200);
  await call('PATCH', `/api/drafts/${dRename.data.id}`, { name: '改名草案-新名字' });
  stale = await call('POST', `/api/drafts/${dRename.data.id}/publish`, { preview_token: pvR.data.token }, 409);
  ok(stale.data.error === 'DRAFT_CHANGED_AFTER_PREVIEW', '预览后仅重命名草案 -> 凭据同样失效');

  // 非法 / 不存在凭据
  const badToken = await call('POST', `/api/drafts/${dRename.data.id}/publish`, { preview_token: 'not-a-token' }, 400);
  ok(badToken.data.error === 'VALIDATION', '凭据格式非法 -> 400 VALIDATION');
  const missingToken = await call('POST', `/api/drafts/${dRename.data.id}/publish`, { preview_token: 'f'.repeat(64) }, 404);
  ok(missingToken.data.error === 'PREVIEW_TOKEN_NOT_FOUND', '凭据不存在 -> 404 PREVIEW_TOKEN_NOT_FOUND');

  // ----------------------------------------------------------------------
  // 5) 定时预览 + 确认；预定时刻过期、排程改期/取消使凭据失效
  // ----------------------------------------------------------------------
  const T = Date.now();
  const isoAt = (relMs) => new Date(T + relMs).toISOString();

  const dS = await call('POST', '/api/drafts', { name: '定时预览草案' }, 201);
  await call('PUT', `/api/drafts/${dS.data.id}/clauses/A`, { title: '总则', body: 'AAA-定时预览' });

  // 队列非空时无时刻预览 -> QUEUE_NOT_EMPTY（此刻队列空，先制造一个排程版本）
  const dQueue = await call('POST', '/api/drafts', { name: '排程占位' }, 201);
  await call('POST', `/api/drafts/${dQueue.data.id}/clauses`, { key: 'Q', title: '排队条', body: 'qqq' });
  const qPub = await call('POST', `/api/drafts/${dQueue.data.id}/publish`, { note: '排队v', effective_at: isoAt(3600_000) }, 201);
  const rev = qPub.data.schedule.schedule_revision;
  ok(qPub.data.schedule_status === 'scheduled', '占位版本定时发布入队');

  const noTime = await call('POST', `/api/drafts/${dS.data.id}/preview`, {}, 409);
  ok(noTime.data.error === 'QUEUE_NOT_EMPTY' && noTime.data.schedule.pending.length === 1, '队列非空时即时预览 -> 409 QUEUE_NOT_EMPTY 并返回当前排程');
  const badOrder = await call('POST', `/api/drafts/${dS.data.id}/preview`, { effective_at: isoAt(60_000) }, 409);
  ok(badOrder.data.error === 'SCHEDULE_ORDER_VIOLATION', '预览时刻不晚于队列末尾 -> 409 SCHEDULE_ORDER_VIOLATION');
  const naive = await call('POST', `/api/drafts/${dS.data.id}/preview`, { effective_at: '2027-01-01T00:00:00' }, 400);
  ok(naive.data.error === 'VALIDATION', '预览时刻不带时区设计符 -> 400 VALIDATION');

  // 合法定时预览（晚于队列末尾）
  const pvS = await call('POST', `/api/drafts/${dS.data.id}/preview`, { note: '定时预览版', effective_at: isoAt(7200_000) }, 200);
  ok(pvS.data.schedule_status === 'scheduled' && pvS.data.effective_at === isoAt(7200_000), '定时预览返回生效安排');
  ok(pvS.data.schedule_revision === rev, '预览记录当前排程修订号');

  // 排程改期（修订号递增）使凭据失效
  await call('POST', `/api/versions/${qPub.data.version_id}/schedule`, { effective_at: isoAt(1800_000), schedule_revision: rev }, 200);
  stale = await call('POST', `/api/drafts/${dS.data.id}/publish`, { preview_token: pvS.data.token }, 409);
  ok(stale.data.error === 'SCHEDULE_CHANGED_AFTER_PREVIEW', '预览后排程改期 -> 409 SCHEDULE_CHANGED_AFTER_PREVIEW');

  // 重新预览（新时刻仍须晚于改期后的队列末尾 1800s）
  const pvS2 = await call('POST', `/api/drafts/${dS.data.id}/preview`, { note: '定时预览版', effective_at: isoAt(7200_000) }, 200);
  // 取消排程也使新凭据失效
  const rev2 = (await call('GET', '/api/schedule')).data.schedule_revision;
  await call('POST', `/api/versions/${qPub.data.version_id}/cancel`, { schedule_revision: rev2 }, 200);
  stale = await call('POST', `/api/drafts/${dS.data.id}/publish`, { preview_token: pvS2.data.token }, 409);
  ok(stale.data.error === 'SCHEDULE_CHANGED_AFTER_PREVIEW', '预览后排程取消 -> 409 SCHEDULE_CHANGED_AFTER_PREVIEW');

  // 队列清空后重新预览为即时 -> 确认成功
  const pvS3 = await call('POST', `/api/drafts/${dS.data.id}/preview`, { note: '定时预览版改即时' }, 200);
  ok(pvS3.data.schedule_status === 'immediate', '队列清空后可重新预览为即时生效');
  const confS = await call('POST', `/api/drafts/${dS.data.id}/publish`, { preview_token: pvS3.data.token }, 201);
  ok(confS.data.version_id > 0 && confS.data.schedule_status === 'immediate', '即时预览确认发布成功');

  // 定时预览的预定时刻已过 -> 凭据失效（先入队再等待）
  const dT = await call('POST', '/api/drafts', { name: '短定时草案' }, 201);
  await call('PUT', `/api/drafts/${dT.data.id}/clauses/A`, { title: '总则', body: 'AAA-短定时' });
  const pvT = await call('POST', `/api/drafts/${dT.data.id}/preview`, { effective_at: new Date(Date.now() + 1500).toISOString() }, 200);
  await new Promise((r) => setTimeout(r, 1800));
  stale = await call('POST', `/api/drafts/${dT.data.id}/publish`, { preview_token: pvT.data.token }, 409);
  ok(stale.data.error === 'EFFECTIVE_TIME_PASSED', '预定时刻已过 -> 409 EFFECTIVE_TIME_PASSED 并保留草案');
  det = await call('GET', `/api/drafts/${dT.data.id}`);
  ok(det.data.status === 'open', '时刻过期确认失败后草案仍 open');
  // 重新预览（队列空，即时）后可确认
  const pvT2 = await call('POST', `/api/drafts/${dT.data.id}/preview`, {}, 200);
  const confT = await call('POST', `/api/drafts/${dT.data.id}/publish`, { preview_token: pvT2.data.token }, 201);
  ok(confT.data.version_id > 0, '过期后重新预览并确认发布成功');

  // ----------------------------------------------------------------------
  // 6) 预览本身绝不写版本：以上所有失败预览后版本号不跳变（由最终版本号连续佐证）
  // ----------------------------------------------------------------------
  ov = await call('GET', '/api/overview');
  const expectedVersions = 7; // v1 首版 + v2,v3,v4 + 占位v + dS + dT
  ok(ov.data.versions.length === expectedVersions, `版本总数 ${ov.data.versions.length} === ${expectedVersions}（预览不产生版本）`);

  console.log(`\n${pass} 项预览端到端断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
