'use strict';
/* 社团章程修订平台 —— 原生 JS 单页前端 */

const state = {
  view: 'drafts',
  overview: null,
  draftId: null,
  draft: null,
  draftHistory: null,
  versionId: null,
  version: null,
  schedule: null,
  effective: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3600);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 浏览器本地时间显示（带时区说明）
function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = Math.floor(Math.abs(off) / 60);
  const om = Math.abs(off) % 60;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（本地 UTC${sign}${p(oh)}${om ? p(om) : ''}）`;
}

// 完整 UTC 时间（秒）
function fmtUtc(iso) {
  if (!iso) return '';
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

// datetime-local 输入值 <-> UTC ISO
function localInputValue(iso) {
  const d = new Date(iso || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function localInputToIso(value) {
  // 无时区的本地串 -> new Date 按本地时区解析 -> UTC ISO
  return new Date(value).toISOString();
}
function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return '已到点';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分后生效`;
  if (m > 0) return `${m} 分 ${sec} 秒后生效`;
  return `${sec} 秒后生效`;
}

function scheduleStatusBadge(v) {
  if (v.schedule_status === 'cancelled') return el('span', { class: 'badge err' }, '已取消');
  if (v.schedule_status === 'scheduled') return el('span', { class: 'badge warn' }, '待生效');
  return el('span', { class: 'badge published' }, '即时生效');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function modal({ title, body, footer, wide }) {
  closeModal();
  const root = $('#modalRoot');
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) closeModal(); } });
  const m = el('div', { class: 'modal', style: wide ? 'max-width:860px' : '' },
    el('div', { class: 'modal-hd' },
      el('h3', {}, title),
      el('button', { class: 'close-x', onclick: closeModal, html: '&times;' }),
    ),
    el('div', { class: 'modal-bd' }, body),
    footer ? el('div', { class: 'modal-ft' }, footer) : null,
  );
  backdrop.appendChild(m);
  root.appendChild(backdrop);
  return m;
}
function closeModal() {
  $('#modalRoot').innerHTML = '';
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function refresh() {
  state.overview = await api('GET', '/api/overview');
  $('#charterTitle').textContent = state.overview.charter_title;
  await render();
}

async function render() {
  if (!state.overview) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
  const main = $('#main');
  main.innerHTML = '';
  if (!state.overview.initialized) {
    main.appendChild(renderInit());
    return;
  }
  if (state.view === 'drafts') main.appendChild(state.draftId ? renderDraft() : renderDraftList());
  else if (state.view === 'schedule') main.appendChild(renderSchedule());
  else main.appendChild(state.versionId ? renderVersion() : renderHistory());
}

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', async () => {
    if (state._scheduleTimer) { clearInterval(state._scheduleTimer); state._scheduleTimer = null; }
    state.view = t.dataset.view;
    state.draftId = null;
    state.versionId = null;
    if (t.dataset.view === 'schedule') state.schedule = null;
    await render();
  }),
);

// ---------------------------------------------------------------------------
// 首版录入
// ---------------------------------------------------------------------------
function renderInit() {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-hd' }, el('h2', {}, '录入首版章程')));
  const bd = el('div', { class: 'panel-bd' });
  panel.appendChild(bd);

  const titleInput = el('input', { type: 'text', value: 'XX社团章程', placeholder: '章程名称' });
  bd.appendChild(el('label', { class: 'fld' }, el('span', {}, '章程名称'), titleInput));

  const clauseBox = el('div', {});
  const refBox = el('div', {});
  const rows = [];

  function addClauseRow(c = {}) {
    const key = el('input', { type: 'text', value: c.key || '', placeholder: '稳定标识，如 A / art-1', style: 'width:170px' });
    const ttl = el('input', { type: 'text', value: c.title || '', placeholder: '条款标题' });
    const body = el('textarea', {}, c.body || '');
    const row = el('div', { class: 'clause' },
      el('div', { class: 'clause-hd' },
        el('span', { class: 'muted small' }, '条款顺序即下方排列顺序，可随时调整'),
        el('div', { style: 'flex:1' }),
        el('button', {
          class: 'btn danger small', onclick: () => { row.remove(); rows.splice(rows.indexOf(row), 1); },
        }, '删除'),
      ),
      el('div', { class: 'panel-bd' },
        el('div', { class: 'grid2' },
          el('label', { class: 'fld' }, el('span', {}, '稳定标识 *'), key),
          el('label', { class: 'fld' }, el('span', {}, '标题 *'), ttl),
        ),
        el('label', { class: 'fld' }, el('span', {}, '正文 *'), body),
      ),
    );
    row._fields = { key, ttl, body };
    rows.push(row);
    clauseBox.appendChild(row);
  }

  const refRows = [];
  function addRefRow(r = {}) {
    const src = el('input', { type: 'text', value: r.source || '', placeholder: '来源标识', style: 'width:150px' });
    const tgt = el('input', { type: 'text', value: r.target || '', placeholder: '目标标识', style: 'width:150px' });
    const lbl = el('input', { type: 'text', value: r.label || '', placeholder: '关系（可选），如 参见' });
    const row = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' },
      src, el('span', { class: 'muted' }, '→'), tgt, lbl,
      el('button', { class: 'btn ghost small', onclick: () => { row.remove(); refRows.splice(refRows.indexOf(row), 1); } }, '移除'),
    );
    row._fields = { src, tgt, lbl };
    refRows.push(row);
    refBox.appendChild(row);
  }

  bd.append(
    el('p', { class: 'muted small' }, '先逐条录入条款（标识一旦发布将保持稳定，草案的编辑/移动/删除均以标识跟踪），再登记条款之间的引用。'),
    clauseBox,
    el('button', { class: 'btn secondary', onclick: () => addClauseRow() }, '+ 添加条款'),
    el('h3', { style: 'margin:18px 0 8px;font-size:14px' }, '条款间引用'),
    refBox,
    el('button', { class: 'btn secondary', onclick: () => addRefRow() }, '+ 添加引用'),
  );

  // 示例数据
  addClauseRow({ key: 'A', title: '总则', body: '本社团名称为登山社，宗旨为组织安全、健康的登山与户外活动。' });
  addClauseRow({ key: 'B', title: '会员', body: '凡承认本章程、履行登记手续者，得为本社会员。会员义务参见 A，退出办法见 C。' });
  addClauseRow({ key: 'C', title: '退出', body: '会员可随时书面申请退出；严重违反章程者由理事会依 D 处理。' });
  addClauseRow({ key: 'D', title: '纪律', body: '理事会对违纪行为进行审议，相关程序参照 B 的会员义务条款。' });
  addRefRow({ source: 'B', target: 'A', label: '参见' });
  addRefRow({ source: 'B', target: 'C', label: '退出办法' });
  addRefRow({ source: 'C', target: 'D', label: '处理依据' });
  addRefRow({ source: 'D', target: 'B', label: '程序参照' });

  const errBox = el('div', { style: 'margin-top:12px' });
  bd.appendChild(errBox);
  // 可选：首版定时生效
  const initModeImm = el('input', { type: 'radio', name: 'initeff', checked: true });
  const initModeSch = el('input', { type: 'radio', name: 'initeff' });
  const initEffInput = el('input', { type: 'datetime-local', step: '1', disabled: true });
  initEffInput.value = localInputValue(new Date(Date.now() + 3600_000).toISOString());
  initModeImm.addEventListener('change', () => { initEffInput.disabled = initModeImm.checked; });
  initModeSch.addEventListener('change', () => { initEffInput.disabled = !initModeSch.checked; });
  bd.appendChild(el('div', { class: 'panel', style: 'margin-bottom:12px' },
    el('div', { class: 'panel-bd' },
      el('div', { style: 'margin-bottom:6px' }, el('strong', {}, '生效时刻（可选）')),
      el('label', { class: 'fld', style: 'display:flex;gap:8px;align-items:center' },
        initModeImm, el('span', {}, '立即生效')),
      el('label', { class: 'fld', style: 'display:flex;gap:8px;align-items:center;margin-top:6px' },
        initModeSch, el('span', {}, '定时生效（UTC，按本地时区输入）'), initEffInput),
      el('div', { class: 'muted small', style: 'margin-top:6px' },
        '发布后立即生成不可变 v1 快照；指定未来时刻时，v1 到点才生效。'),
    ),
  ));
  bd.appendChild(el('div', { style: 'margin-top:14px;display:flex;gap:10px' },
    el('button', {
      class: 'btn',
      onclick: async () => {
        errBox.innerHTML = '';
        const payload = {
          charter_title: titleInput.value.trim(),
          clauses: rows.map((r) => ({
            key: r._fields.key.value.trim(),
            title: r._fields.ttl.value.trim(),
            body: r._fields.body.value,
          })),
          refs: refRows.map((r) => ({
            source: r._fields.src.value.trim(),
            target: r._fields.tgt.value.trim(),
            label: r._fields.lbl.value.trim(),
          })),
          note: '首版发布',
        };
        if (initModeSch.checked) {
          if (!initEffInput.value) { errBox.appendChild(renderIssueList([{ message: '请选择未来生效时刻' }])); return; }
          payload.effective_at = localInputToIso(initEffInput.value);
        }
        try {
          const r = await api('POST', '/api/initialize', payload);
          toast(r.schedule ? `不可变 v1 已生成，将于 ${fmtUtc(r.schedule.pending[0].effective_at)} 生效` : '首版章程已发布（不可变版本 v1）', 'ok');
          await refresh();
        } catch (e) {
          errBox.appendChild(renderIssueList(e.payload.issues || [{ message: e.message }]));
        }
      },
    }, '发布首版（生成不可变 v1）'),
  ));

  return panel;
}

function renderIssueList(issues) {
  const box = el('div', {});
  for (const i of issues) {
    box.appendChild(el('div', { class: `issue ${i.level === 'warning' ? 'warning' : 'error'}` },
      el('span', {}, i.level === 'warning' ? '⚠️' : '⛔'),
      el('span', {}, i.message || JSON.stringify(i)),
    ));
  }
  return box;
}

// ---------------------------------------------------------------------------
// 草案列表
// ---------------------------------------------------------------------------
function renderDraftList() {
  const wrap = el('div', {});
  const ov = state.overview;

  const stats = el('div', { class: 'stat-row' },
    stat(ov.versions.length, '已发布版本'),
    stat(ov.drafts.filter((d) => d.status === 'open').length, '进行中草案'),
    stat(ov.current_version_id ? `v${ov.current_version_id}` : '-', '当前生效版'),
    stat(ov.versions.filter((v) => v.schedule_status === 'scheduled' && new Date(v.effective_at) > new Date()).length, '待生效版本'),
  );
  wrap.appendChild(stats);

  const panel = el('div', { class: 'panel' });
  const baselineSel = el('select', {},
    ...ov.versions.map((v) => el('option', { value: v.id }, `v${v.id} · ${v.note}（${fmtTime(v.created_at)}）`)),
  );
  baselineSel.value = String(ov.latest_version_id);
  const nameInput = el('input', { type: 'text', placeholder: '草案名称（可选）', style: 'width:240px' });
  panel.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, '从已发布版本创建草案'),
  ));
  panel.appendChild(el('div', { class: 'panel-bd' },
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('span', {}, '基线版本'), baselineSel, nameInput,
      el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            const d = await api('POST', '/api/drafts', {
              baseline_id: parseInt(baselineSel.value, 10),
              name: nameInput.value.trim(),
            });
            state.draftId = d.id;
            state.view = 'drafts';
            await refresh();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '创建草案'),
    ),
  ));
  wrap.appendChild(panel);

  const listPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-hd' }, el('h2', {}, '全部草案')),
  );
  const bd = el('div', { class: 'panel-bd' });
  listPanel.appendChild(bd);
  if (!ov.drafts.length) {
    bd.appendChild(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📝'), '还没有草案'));
  } else {
    for (const d of ov.drafts) {
      const baseline = ov.versions.find((v) => v.id === d.baseline_id);
      const stale = d.status === 'open' && d.baseline_id !== ov.latest_version_id;
      bd.appendChild(el('div', { class: 'draft-card' },
        el('div', {},
          el('div', { style: 'display:flex;gap:8px;align-items:center' },
            el('strong', {}, d.name),
            el('span', { class: `badge ${d.status}` }, d.status === 'open' ? '进行中' : '已发布'),
            stale ? el('span', { class: 'badge warn', title: '发布时将先把改动重放到最新版' }, '基线落后于最新版') : null,
          ),
          el('div', { class: 'meta' },
            `基线 v${d.baseline_id} · ${baseline ? baseline.note : ''} · ${d.clause_count} 条 · 更新于 ${fmtTime(d.updated_at)}`),
        ),
        el('div', { style: 'display:flex;gap:8px' },
          d.status === 'open'
            ? el('button', { class: 'btn', onclick: async () => { state.draftId = d.id; await refresh(); } }, '打开编辑')
            : null,
        ),
      ));
    }
  }
  wrap.appendChild(listPanel);
  return wrap;
}

function stat(num, lbl) {
  return el('div', { class: 'stat' }, el('div', { class: 'num' }, String(num)), el('div', { class: 'lbl' }, lbl));
}

// ---------------------------------------------------------------------------
// 草案编辑
// ---------------------------------------------------------------------------
async function openDraft(id) {
  const [draft, history] = await Promise.all([
    api('GET', `/api/drafts/${id}?diff=1`),
    api('GET', `/api/drafts/${id}/history`),
  ]);
  state.draft = draft;
  state.draftHistory = history;
}

// 以接口返回的最新草案/历史同步本地状态（用于撤销、重做及修订号过期响应）。
function syncDraft(draft, history) {
  if (draft) state.draft = draft;
  if (history) state.draftHistory = history;
}

// 编辑类接口成功后：以返回结果确认成功，再取带正文差异的完整草案详情与最新历史并整体刷新。
async function afterDraftEdit() {
  const id = state.draftId;
  const [draft, h] = await Promise.all([
    api('GET', `/api/drafts/${id}?diff=1`),
    api('GET', `/api/drafts/${id}/history`),
  ]);
  syncDraft(draft, h);
  await refresh();
}

function renderDraft() {
  const wrap = el('div', {});
  if (!state.draft || state.draft.id !== state.draftId || !state.draftHistory || state.draftHistory.draft_id !== state.draftId) {
    openDraft(state.draftId).then(render).catch((e) => toast(e.message, 'err'));
    return wrap;
  }
  const d = state.draft;
  const ov = state.overview;
  const stale = d.baseline_id !== ov.latest_version_id;

  wrap.appendChild(el('div', { class: 'breadcrumb' },
    el('a', { onclick: async () => { state.draftId = null; await refresh(); } }, '草案列表'),
    ` / ${esc(d.name)}`,
  ));

  // 概要
  const panel = el('div', { class: 'panel' });
  const nameInput = el('input', { type: 'text', value: d.name, style: 'width:260px' });
  panel.appendChild(el('div', { class: 'panel-hd' },
    el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      el('h2', {}, d.name),
      el('span', { class: `badge ${d.status}` }, d.status === 'open' ? '进行中' : '已发布'),
      stale ? el('span', { class: 'badge warn' }, `基线 v${d.baseline_id}，最新版 v${ov.latest_version_id}：发布时自动重放`) : null,
    ),
    el('div', { style: 'display:flex;gap:8px' },
      el('button', {
        class: 'btn secondary small',
        onclick: async () => {
          try { const dd = await api('PATCH', `/api/drafts/${d.id}`, { name: nameInput.value }); await afterDraftEdit(dd); toast('草案名称已保存，可在操作历史中撤销', 'ok'); }
          catch (e) { toast(e.message, 'err'); }
        },
      }, '保存名称'),
      el('button', {
        class: d.publishable && d.status === 'open' ? 'btn' : 'btn',
        disabled: !d.publishable || d.status !== 'open',
        onclick: () => openPublish(d.id),
        style: !d.publishable || d.status !== 'open' ? '' : '',
      }, d.status === 'published' ? '已发布' : '发布为新版本'),
    ),
  ));
  panel.appendChild(el('div', { class: 'panel-bd' },
    el('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:6px' },
      el('span', {}, '名称'), nameInput,
      el('span', { class: 'muted small' },
        `基线 v${d.baseline_id} · ${d.clauses?.length ?? 0} 条 · 更新 ${fmtTime(d.updated_at)}`),
    ),
    renderDiffSummary(d),
  ));
  wrap.appendChild(panel);

  // 问题
  if (d.issues.length) {
    const ip = el('div', { class: 'panel' },
      el('div', { class: 'panel-hd' },
        el('h2', {}, '草案问题'),
        d.publishable ? el('span', { class: 'badge ok' }, '可以发布') : el('span', { class: 'badge err' }, '不可发布'),
      ),
      el('div', { class: 'panel-bd' }, renderIssueList(d.issues)),
    );
    wrap.appendChild(ip);
  }

  // 操作历史（持久撤销/重做）
  wrap.appendChild(renderHistoryPanel(d));

  const wrapGrid = el('div', { class: 'grid2' });

  // 条款
  const cp = el('div', { class: 'panel' });
  cp.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, `条款（${d.clauses.length}）`),
    d.status === 'open' ? el('button', { class: 'btn secondary small', onclick: () => openAddClause(d.id) }, '+ 新增条款') : null,
  ));
  const cbd = el('div', { class: 'panel-bd' });
  cp.appendChild(cbd);
  d.clauses.forEach((c, i) => cbd.appendChild(renderDraftClause(d, c, i)));
  wrapGrid.appendChild(cp);

  // 引用
  const rp = el('div', { class: 'panel' });
  rp.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, `条款间引用（${d.refs.length}）`),
    d.status === 'open' ? el('button', { class: 'btn secondary small', onclick: () => openAddRef(d.id) }, '+ 新增引用') : null,
  ));
  const rbd = el('div', { class: 'panel-bd' });
  rp.appendChild(rbd);
  rbd.appendChild(el('p', { class: 'muted small' },
    '引用可指向暂不存在的条款（悬空引用），系统会明确标记并阻止发布；删除条款后其相关引用也会在此列出。'));
  if (!d.refs.length) rbd.appendChild(el('div', { class: 'empty small' }, '暂无引用'));
  const clauseKeys = new Set(d.clauses.map((c) => c.key));
  for (const r of d.refs) {
    const dangling = !clauseKeys.has(r.source) || !clauseKeys.has(r.target);
    rbd.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:7px' },
      el('span', { class: `ref-tag ${dangling ? 'dangling' : ''}` },
        el('span', { class: 'key-chip' }, r.source),
        '→',
        el('span', { class: 'key-chip' }, r.target),
        r.label ? el('span', {}, `（${r.label}）`) : null,
        dangling ? el('span', { class: 'badge err' }, '悬空') : null,
      ),
      d.status === 'open'
        ? el('button', {
            class: 'icon-btn', title: '删除引用',
            onclick: async () => {
              try { const d = await api('DELETE', `/api/drafts/${d.id}/refs/${r.ordinal}`); await afterDraftEdit(d); toast('引用已删除，可在操作历史中撤销', 'ok'); }
              catch (e) { toast(e.message, 'err'); }
            },
          }, '✕')
        : null,
    ));
  }
  wrapGrid.appendChild(rp);
  wrap.appendChild(wrapGrid);
  return wrap;
}

// ---------------------------------------------------------------------------
// 操作历史：查看与逐步撤销/重做
// ---------------------------------------------------------------------------
const OP_KIND_LABEL = {
  create: '创建',
  'clause-add': '新增条款',
  'clause-edit': '改写',
  'clause-delete': '删除条款',
  'clause-move': '移动',
  'ref-add': '新增引用',
  'ref-delete': '删除引用',
  rename: '改名',
};

function renderHistoryPanel(d) {
  const h = state.draftHistory;
  const panel = el('div', { class: 'panel' });
  const hd = el('div', { class: 'panel-hd' },
    el('h2', {}, `操作历史（${h.operations.length}）`),
    el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      el('span', { class: 'muted small' },
        `草案修订号 #${h.revision} · 当前位于第 ${h.history_pos}/${h.operations.length} 步`),
      el('button', {
        class: 'btn secondary small', disabled: !h.can_undo || d.status !== 'open',
        title: '撤销上一步（携带当前草案修订号）',
        onclick: () => stepHistory(d.id, 'undo'),
      }, '↩ 撤销'),
      el('button', {
        class: 'btn secondary small', disabled: !h.can_redo || d.status !== 'open',
        title: '重做下一步',
        onclick: () => stepHistory(d.id, 'redo'),
      }, '↪ 重做'),
    ),
  );
  panel.appendChild(hd);
  const bd = el('div', { class: 'panel-bd' });
  panel.appendChild(bd);
  bd.appendChild(el('p', { class: 'muted small' },
    '条款新增、改写、删除、移动，引用增删与草案改名都会形成持久记录；恢复会同时还原条款顺序、标题正文、引用与显式移动记录。撤销后再编辑将舍弃重做分支；已发布草案仅可查看历史。'));

  const rows = [...h.operations].reverse(); // 最新在上
  const list = el('div', { class: 'history-list' });
  for (const op of rows) {
    const isCurrent = op.seq === h.history_pos;
    const inFuture = op.seq > h.history_pos; // 已撤销、可重做
    list.appendChild(el('div', { class: `history-row ${isCurrent ? 'current' : ''} ${inFuture ? 'future' : ''}` },
      el('span', { class: 'history-seq' }, `#${op.seq}`),
      el('span', { class: `badge ${historyKindClass(op.kind)}` }, OP_KIND_LABEL[op.kind] || op.kind),
      el('span', { class: 'history-summary' }, op.summary),
      el('span', { class: 'muted small' }, fmtTime(op.created_at)),
      isCurrent ? el('span', { class: 'badge open' }, '当前') : inFuture ? el('span', { class: 'muted small' }, '已撤销') : null,
    ));
  }
  bd.appendChild(list);
  return panel;
}

function historyKindClass(kind) {
  if (kind === 'create') return 'open';
  if (kind === 'clause-add' || kind === 'ref-add') return 'ok';
  if (kind === 'clause-delete' || kind === 'ref-delete') return 'err';
  if (kind === 'clause-move') return 'neutral';
  return 'warn';
}

async function stepHistory(draftId, direction) {
  const h0 = state.draftHistory;
  if (h0 == null) return;
  const verb = direction === 'undo' ? '撤销' : '重做';
  try {
    const r = await api('POST', `/api/drafts/${draftId}/${direction}`, { revision: h0.revision });
    syncDraft(r.draft, r.history);
    // 重新取带正文差异的完整详情，保证差异弹窗仍可打开
    state.draft = await api('GET', `/api/drafts/${draftId}?diff=1`);
    await refresh();
    toast(`已${verb}：${r.applied_summary}`, 'ok');
  } catch (e) {
    const p = e.payload || {};
    if (p.error === 'STALE_DRAFT_REVISION') {
      syncDraft(p.draft, p.history);
      await refresh();
      toast(`草案已被其他操作修改，修订号过期；已刷新为当前状态，请重新${verb}`, 'err');
    } else {
      toast(e.message, 'err');
    }
  }
}

function renderDiffSummary(d) {
  const diff = d.diff || {};
  const chips = [];
  if (diff.added?.length) chips.push(el('span', { class: 'badge ok' }, `新增 ${diff.added.length} 条：${diff.added.join('、')}`));
  if (diff.deleted?.length) chips.push(el('span', { class: 'badge err' }, `删除 ${diff.deleted.length} 条：${diff.deleted.join('、')}`));
  if (diff.changed?.length) chips.push(el('span', { class: 'badge warn' }, `修改 ${diff.changed.length} 条：${diff.changed.map((c) => c.key).join('、')}`));
  if ((diff.refs_added_count || 0) + (diff.refs_removed_count || 0)) {
    chips.push(el('span', { class: 'badge neutral' }, `引用 +${diff.refs_added_count} / −${diff.refs_removed_count}`));
  }
  if (!chips.length) chips.push(el('span', { class: 'muted small' }, '与基线无差异'));
  const box = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, chips);

  // 详情查看按钮
  const detailBtn = el('button', {
    class: 'btn ghost small', style: 'margin-top:8px',
    onclick: () => openDiffDetail(d),
  }, '查看相对基线 v' + d.baseline_id + ' 的正文差异');
  return el('div', {}, box, detailBtn);
}

function renderDraftClause(d, c, i) {
  const change = (d.diff?.changed || []).find((x) => x.key === c.key);
  const isAdded = (d.diff?.added || []).includes(c.key);
  const glow = isAdded ? 'added-glow' : change ? 'changed-glow' : '';

  const outgoing = d.refs.filter((r) => r.source === c.key);
  const clauseKeys = new Set(d.clauses.map((x) => x.key));

  const head = el('div', { class: 'clause-hd' },
    el('span', { class: 'ord' }, `#${i + 1}`),
    el('span', { class: 'key-chip' }, c.key),
    el('span', { class: 'title' }, c.title),
    isAdded ? el('span', { class: 'badge ok' }, '新增') : null,
    change?.body ? el('span', { class: 'badge warn' }, '正文修改') : null,
    change?.position ? el('span', { class: 'badge warn' }, '已移动') : null,
    change?.edges ? el('span', { class: 'badge neutral' }, '引用变化') : null,
  );
  if (d.status === 'open') {
    head.appendChild(el('div', { style: 'flex:1' }));
    head.appendChild(el('div', { class: 'move-controls' },
      el('button', { class: 'icon-btn', title: '上移', onclick: () => moveClause(d.id, c.key, i - 1) }, '↑'),
      el('button', { class: 'icon-btn', title: '下移', onclick: () => moveClause(d.id, c.key, i + 1) }, '↓'),
    ));
    head.appendChild(el('button', { class: 'btn secondary small', onclick: () => openEditClause(d.id, c) }, '编辑'));
    head.appendChild(el('button', { class: 'btn danger small', onclick: () => deleteClause(d.id, c) }, '删除'));
  }

  const bd = el('div', { class: 'clause-bd' },
    el('div', { class: 'clause-body' }, c.body),
    outgoing.length ? el('div', { class: 'refs-line' }, '引用：',
      ...outgoing.map((r) => el('span', { class: `ref-tag ${clauseKeys.has(r.target) ? '' : 'dangling'}` },
        '→ ', el('span', { class: 'key-chip' }, r.target), r.label ? `（${r.label}）` : '',
        !clauseKeys.has(r.target) ? el('span', { class: 'badge err' }, '目标悬空') : null,
      )),
    ) : null,
  );
  return el('div', { class: `clause ${glow}` }, head, bd);
}

async function moveClause(draftId, key, newOrdinal) {
  try {
    const d = await api('POST', `/api/drafts/${draftId}/clauses/${encodeURIComponent(key)}/move`, { ordinal: newOrdinal });
    await afterDraftEdit(d);
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteClause(draftId, c) {
  if (!confirm(`删除条款「${c.key} ${c.title}」？\n其相关引用会保留为悬空引用（草案仍可暂存，但不能发布，直到删除悬空引用或重建同标识条款）。\n该操作可在“操作历史”中撤销。`)) return;
  try {
    const d = await api('DELETE', `/api/drafts/${draftId}/clauses/${encodeURIComponent(c.key)}`);
    await afterDraftEdit(d);
    toast('条款已删除；引用暂存为悬空状态，可在操作历史中撤销', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------------------
// 弹窗：新增/编辑条款、新增引用、差异详情、发布
// ---------------------------------------------------------------------------
function openAddClause(draftId) {
  const key = el('input', { type: 'text', placeholder: '如 E / art-5' });
  const ttl = el('input', { type: 'text', placeholder: '条款标题' });
  const body = el('textarea', { placeholder: '条款正文' });
  const err = el('div', {});
  modal({
    title: '新增条款（新稳定标识）',
    body: el('div', {},
      el('p', { class: 'muted small' }, '标识在后续所有版本中保持稳定；条款会追加到末尾，可用 ↑/↓ 调整位置。'),
      el('label', { class: 'fld' }, el('span', {}, '稳定标识 *'), key),
      el('label', { class: 'fld' }, el('span', {}, '标题 *'), ttl),
      el('label', { class: 'fld' }, el('span', {}, '正文 *'), body),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn', onclick: async () => {
          err.innerHTML = '';
          try {
            const d = await api('POST', `/api/drafts/${draftId}/clauses`, {
              key: key.value, title: ttl.value, body: body.value,
            });
            closeModal(); await afterDraftEdit(d); toast('条款已新增，可在操作历史中撤销', 'ok');
          } catch (e) { err.appendChild(renderIssueList([{ message: e.message }])); }
        },
      }, '添加'),
    ],
  });
}

function openEditClause(draftId, c) {
  const ttl = el('input', { type: 'text', value: c.title });
  const body = el('textarea', {}, c.body);
  const err = el('div', {});
  modal({
    title: `编辑条款 ${c.key}（标识不可修改）`,
    body: el('div', {},
      el('label', { class: 'fld' }, el('span', {}, '标题 *'), ttl),
      el('label', { class: 'fld' }, el('span', {}, '正文 *'), body),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn', onclick: async () => {
          try {
            const d = await api('PUT', `/api/drafts/${draftId}/clauses/${encodeURIComponent(c.key)}`, {
              title: ttl.value, body: body.value,
            });
            closeModal(); await afterDraftEdit(d); toast('条款已保存，可在操作历史中撤销', 'ok');
          } catch (e) { err.innerHTML = ''; err.appendChild(renderIssueList([{ message: e.message }])); }
        },
      }, '保存'),
    ],
  });
}

function openAddRef(draftId) {
  const src = el('input', { type: 'text', placeholder: '来源条款标识', list: 'keyOpts' });
  const tgt = el('input', { type: 'text', placeholder: '目标条款标识', list: 'keyOpts' });
  const lbl = el('input', { type: 'text', placeholder: '关系标签（可选），如 参见 / 依据' });
  const err = el('div', {});
  const opts = el('datalist', { id: 'keyOpts' }, ...state.draft.clauses.map((c) => el('option', { value: c.key })));
  modal({
    title: '新增条款引用',
    body: el('div', {},
      el('p', { class: 'muted small' }, '允许引用暂不存在的条款：会被标记为悬空引用并阻止发布，直到对应条款被建立。'),
      opts,
      el('div', { class: 'grid2' },
        el('label', { class: 'fld' }, el('span', {}, '来源标识 *'), src),
        el('label', { class: 'fld' }, el('span', {}, '目标标识 *'), tgt),
      ),
      el('label', { class: 'fld' }, el('span', {}, '关系标签'), lbl),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn', onclick: async () => {
          try {
            const d = await api('POST', `/api/drafts/${draftId}/refs`, { source: src.value, target: tgt.value, label: lbl.value });
            closeModal(); await afterDraftEdit(d); toast('引用已暂存，可在操作历史中撤销', 'ok');
          } catch (e) { err.innerHTML = ''; err.appendChild(renderIssueList([{ message: e.message }])); }
        },
      }, '添加引用'),
    ],
  });
}

function segmentsHtml(segs) {
  if (!segs) return null;
  return segs.map((s) => {
    if (s.op === 'equal') return esc(s.text);
    if (s.op === 'ins') return `<ins>${esc(s.text)}</ins>`;
    return `<del>${esc(s.text)}</del>`;
  }).join('');
}

function openDiffDetail(d) {
  const body = el('div', {});
  const diff = d.diff || {};
  const sec = (title, badgeCls, keys) => {
    if (!keys?.length) return null;
    return el('div', { style: 'margin-bottom:14px' },
      el('h4', { style: 'margin:0 0 6px' }, title, el('span', { class: `badge ${badgeCls}`, style: 'margin-left:8px' }, String(keys.length))),
      el('div', {}, keys.join('、')),
    );
  };
  const appendIf = (node) => { if (node) body.appendChild(node); };
  appendIf(sec('新增条款', 'ok', diff.added));
  appendIf(sec('删除条款', 'err', diff.deleted));

  if (d.diff?.changed_detail?.length) {
    body.appendChild(el('h4', {}, '修改条款（正文/标题逐字差异）'));
    for (const c of d.diff.changed_detail) {
      const box = el('div', { class: 'clause' });
      const hd = el('div', { class: 'clause-hd' }, el('span', { class: 'key-chip' }, c.key), el('strong', {}, c.title));
      box.appendChild(hd);
      const cbody = el('div', { class: 'clause-bd' });
      if (c.titleSegments) cbody.appendChild(el('div', {}, el('span', { class: 'muted small' }, '标题：'), el('span', { html: segmentsHtml(c.titleSegments) })));
      if (c.bodySegments) cbody.appendChild(el('div', { style: 'margin-top:6px' }, el('span', { class: 'muted small' }, '正文：'), el('div', { html: segmentsHtml(c.bodySegments) })));
      if (c.oldRefs?.length || c.newRefs?.length) {
        cbody.appendChild(el('div', { class: 'refs-line' }, '引用变化：',
          ...c.oldRefs.filter((o) => !c.newRefs.some((n) => n.target === o.target && n.label === o.label)).map((r) => el('del', {}, ` →${r.target} `)),
          ...c.newRefs.filter((n) => !c.oldRefs.some((o) => o.target === n.target && o.label === n.label)).map((r) => el('ins', {}, ` →${r.target} `)),
        ));
      }
      box.appendChild(cbody);
      body.appendChild(box);
    }
  }
  if (diff.refs_added?.length || diff.refs_removed?.length) {
    body.appendChild(el('h4', {}, '引用变化'));
    for (const r of diff.refs_removed || []) body.appendChild(el('div', {}, el('del', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
    for (const r of diff.refs_added || []) body.appendChild(el('div', {}, el('ins', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
  }
  modal({ title: `相对基线 v${d.baseline_id} 的差异`, body, wide: true, footer: [el('button', { class: 'btn ghost', onclick: closeModal }, '关闭')] });
}

function openPublish(draftId) {
  const note = el('input', { type: 'text', placeholder: '本版说明（可选）' });
  const err = el('div', {});
  const ov = state.overview;
  const d = state.draft;
  const willReplay = d.baseline_id !== ov.latest_version_id;

  // 生效时刻选择：即时 / 定时（UTC）
  const nowMs = Date.now();
  const modeImm = el('input', { type: 'radio', name: 'effmode', checked: true });
  const modeSch = el('input', { type: 'radio', name: 'effmode' });
  const effInput = el('input', { type: 'datetime-local', step: '1', disabled: true });
  effInput.value = localInputValue(new Date(nowMs + 3600_000).toISOString());
  modeImm.addEventListener('change', () => { effInput.disabled = modeImm.checked; });
  modeSch.addEventListener('change', () => { effInput.disabled = !modeSch.checked; });
  const effHint = el('div', { class: 'muted small' }, '发布后立即生成不可变版本快照，到达该 UTC 时刻后自动成为当前生效版。');

  const queuePending = (ov.versions || []).filter(
    (v) => v.schedule_status === 'scheduled' && new Date(v.effective_at) > new Date(),
  );
  if (queuePending.length) {
    modeImm.disabled = true;
    modeSch.checked = true;
    modeImm.checked = false;
    effInput.disabled = false;
    const tail = queuePending[queuePending.length - 1];
    effInput.min = localInputValue(new Date(new Date(tail.effective_at).getTime() + 60_000).toISOString());
  }

  // 表单视图（填写说明/生效时刻）与预览视图（查看将要落库的最终版本）互斥切换。
  const formView = el('div', {});
  const previewView = el('div', { style: 'display:none' });
  let previewData = null;

  function collectPayload() {
    const payload = { note: note.value };
    if (modeSch.checked) payload.effective_at = localInputToIso(effInput.value);
    return payload;
  }
  function validateForm() {
    if (modeSch.checked && !effInput.value) {
      err.innerHTML = '';
      err.appendChild(renderIssueList([{ message: '请选择未来生效时刻' }]));
      return false;
    }
    return true;
  }

  function showForm() {
    previewView.style.display = 'none';
    formView.style.display = '';
  }
  function showPreview(p) {
    previewData = p;
    err.innerHTML = '';
    formView.style.display = 'none';
    previewView.style.display = '';
    previewView.innerHTML = '';
    previewView.appendChild(renderPublishPreview(p));
  }

  formView.appendChild(el('p', { class: 'muted small' },
    willReplay
      ? `基线 v${d.baseline_id} 已落后于最新发布版 v${ov.latest_version_id}：系统将在一个原子事务中，把本草案相对基线的不相交条款改动重放到最新版。若同一条款被双方改动，或重放后产生悬空引用，发布将被拒绝并说明冲突，草案原样保留。`
      : '将在一个原子事务中生成不可变的新版本；发布后历史可完整还原该版顺序、正文与引用。'));
  formView.appendChild(el('label', { class: 'fld' }, el('span', {}, '版本说明'), note));
  formView.appendChild(el('div', { class: 'panel', style: 'margin:6px 0' },
    el('div', { class: 'panel-bd' },
      el('div', { style: 'margin-bottom:8px' }, el('strong', {}, '生效时刻')),
      el('label', { class: 'fld', style: 'display:flex;gap:8px;align-items:center' },
        modeImm,
        el('span', {}, queuePending.length ? '即时生效（队列未清空，不可用）' : '立即生效')),
      el('label', { class: 'fld', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px' },
        modeSch,
        el('span', {}, '定时生效（UTC，按本地时区输入）'),
        effInput,
      ),
      queuePending.length
        ? el('div', { class: 'issue warning', style: 'margin-top:8px' },
            el('span', {}, '⏳'),
            el('span', {},
              `已有 ${queuePending.length} 个待生效版本（队列至 v${tail2id(queuePending)}，最后时刻 ${fmtUtc(queuePending[queuePending.length - 1].effective_at)}）：未指定未来时刻的即时发布会被拒绝；定时时刻必须严格晚于队列末尾。`),
          )
        : null,
      effHint,
    ),
  ));

  // 底部按钮：直接发布保持原有一步到位方式；预览后可返回修改或凭据确认。
  const directBtn = el('button', { class: 'btn ghost', onclick: () => doPublish(false) }, '直接发布（不预览）');
  const previewBtn = el('button', { class: 'btn secondary', onclick: doPreview }, '预览将要发布的版本');
  const backBtn = el('button', { class: 'btn ghost', style: 'display:none', onclick: () => { previewData = null; showForm(); toggleFooter(); } }, '返回修改');
  const confirmBtn = el('button', { class: 'btn', style: 'display:none', onclick: () => doPublish(true) }, '按此预览确认发布');

  function toggleFooter() {
    const showingPreview = previewView.style.display !== 'none';
    directBtn.style.display = showingPreview ? 'none' : '';
    previewBtn.style.display = showingPreview ? 'none' : '';
    backBtn.style.display = showingPreview ? '' : 'none';
    confirmBtn.style.display = showingPreview ? '' : 'none';
  }

  async function doPreview() {
    err.innerHTML = '';
    if (!validateForm()) return;
    previewBtn.disabled = true;
    try {
      const p = await api('POST', `/api/drafts/${draftId}/preview`, collectPayload());
      showPreview(p);
      toggleFooter();
    } catch (e) {
      const p = e.payload || {};
      if (p.error === 'CONFLICT') err.appendChild(renderPublishConflict(p));
      else if (p.schedule) err.appendChild(renderIssueList([{ message: p.message || e.message }]));
      else err.appendChild(renderIssueList(p.issues || [{ message: e.message }]));
    } finally {
      previewBtn.disabled = false;
    }
  }

  async function doPublish(useToken) {
    err.innerHTML = '';
    if (!useToken && !validateForm()) return;
    const payload = useToken ? { preview_token: previewData.token } : collectPayload();
    confirmBtn.disabled = true;
    directBtn.disabled = true;
    try {
      const r = await api('POST', `/api/drafts/${draftId}/publish`, payload);
      closeModal();
      if (r.confirmed_from_preview) {
        toast(`已按预览原子发布：v${r.version_id}（内容与预览完全一致）`, 'ok');
      } else if (r.schedule_status === 'scheduled') {
        toast(`已生成不可变 v${r.version_id}，将于 ${fmtUtc(r.effective_at)} 生效`, 'ok');
      } else {
        toast(`已原子发布：v${r.version_id}${r.replayed ? '（已重放到最新版）' : ''}`, 'ok');
      }
      state.draftId = null;
      await refresh();
    } catch (e) {
      const p = e.payload || {};
      const INVALID_CODES = new Set([
        'DRAFT_CHANGED_AFTER_PREVIEW', 'LATEST_VERSION_CHANGED', 'SCHEDULE_CHANGED_AFTER_PREVIEW',
        'EFFECTIVE_TIME_PASSED', 'PREVIEW_ALREADY_CONSUMED', 'PREVIEW_TOKEN_NOT_FOUND',
        'DRAFT_ALREADY_PUBLISHED', 'PREVIEW_CONTENT_MISMATCH', 'PREVIEW_INVALIDATED',
      ]);
      // 凭据失效：说明原因、保留草案，可返回修改后重新预览
      if (INVALID_CODES.has(p.error)) {
        err.appendChild(renderPreviewInvalid(p));
        previewData = null;
        showForm();
        toggleFooter();
      } else if (p.error === 'CONFLICT') {
        err.appendChild(renderPublishConflict(p));
      } else if (p.schedule) {
        err.appendChild(renderIssueList([{ message: p.message || e.message }]));
      } else {
        err.appendChild(renderIssueList(p.issues || [{ message: e.message }]));
      }
    } finally {
      confirmBtn.disabled = false;
      directBtn.disabled = false;
    }
  }

  modal({
    title: '发布草案为新版本',
    body: el('div', {}, formView, previewView, err),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      directBtn,
      previewBtn,
      backBtn,
      confirmBtn,
    ],
  });
}

// 预览结果面板：将要落库的最终条款全文/顺序/引用 + 相对最新发布版的差异。
function renderPublishPreview(p) {
  const box = el('div', {});
  const latestId = p.latest_version_id;
  box.appendChild(el('div', { class: 'issue' }, el('span', {}, '🔎'),
    el('div', {},
      el('div', {}, el('strong', {}, '以下为将要落库的最终版本（尚未写入，草案未关闭）')),
      el('div', { class: 'small muted' },
        `相对当前最新发布版 v${latestId} 的预览结果${p.replayed ? '（已按三方重放合并）' : ''}；确认发布只能提交与此完全一致的内容与生效安排。`),
    )));

  // 生效安排
  const schedLine = p.schedule_status === 'scheduled'
    ? el('div', {}, '⏰ 定时生效：', el('strong', {}, fmtUtc(p.effective_at)), ' / ', fmtLocal(p.effective_at))
    : el('div', {}, '⚡ ', el('strong', {}, '立即生效'), '（确认提交时即生成并生效）');
  box.appendChild(el('div', { class: 'panel', style: 'margin:10px 0' },
    el('div', { class: 'panel-bd' },
      schedLine,
      el('div', { class: 'muted small', style: 'margin-top:4px' },
        `版本说明：${p.note || '（无）'} · 排程修订号 #${p.schedule_revision}`),
    ),
  ));

  // 差异概览
  const diff = p.diff || {};
  const chips = [];
  if (diff.added?.length) chips.push(el('span', { class: 'badge ok' }, `新增 ${diff.added.length}：${diff.added.join('、')}`));
  if (diff.deleted?.length) chips.push(el('span', { class: 'badge err' }, `删除 ${diff.deleted.length}：${diff.deleted.join('、')}`));
  if (diff.moved?.length) chips.push(el('span', { class: 'badge warn' }, `移动 ${diff.moved.length}：${diff.moved.join('、')}`));
  const changedKeys = (diff.changed || []).map((c) => c.key);
  if (changedKeys.length) chips.push(el('span', { class: 'badge warn' }, `修改 ${changedKeys.length}：${changedKeys.join('、')}`));
  if ((diff.refs_added?.length || 0) + (diff.refs_removed?.length || 0)) {
    chips.push(el('span', { class: 'badge neutral' }, `引用 +${diff.refs_added.length} / −${diff.refs_removed.length}`));
  }
  if (!chips.length) chips.push(el('span', { class: 'muted small' }, '与最新发布版无差异'));
  box.appendChild(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px' }, chips));

  // 最终条款（顺序即发布顺序；新增/修改带左边条）
  const addedSet = new Set(diff.added || []);
  const changedMap = new Map((p.changed_detail || []).map((c) => [c.key, c]));
  const movedSet = new Set(diff.moved || []);
  const deletedSet = new Set(diff.deleted || []);

  if (diff.deleted?.length) {
    box.appendChild(el('div', { class: 'panel deleted-glow', style: 'margin-bottom:12px' },
      el('div', { class: 'panel-bd' },
        el('strong', { style: 'color:var(--red)' }, '本版将删除（相对最新版）：'),
        el('div', { class: 'small' }, [...deletedSet].join('、')),
      )));
  }

  p.final.clauses.forEach((c, i) => {
    const detail = changedMap.get(c.key);
    const cls = addedSet.has(c.key) ? 'added-glow' : changedMap.has(c.key) ? 'changed-glow' : '';
    const node = el('div', { class: `clause ${cls}` });
    node.appendChild(el('div', { class: 'clause-hd' },
      el('span', { class: 'ord' }, `#${i + 1}`),
      el('span', { class: 'key-chip' }, c.key),
      el('span', { class: 'title' }, c.title),
      addedSet.has(c.key) ? el('span', { class: 'badge ok' }, '新增') : null,
      movedSet.has(c.key) ? el('span', { class: 'badge warn' }, '移动') : null,
      detail ? el('span', { class: 'badge warn' }, '修改') : null,
    ));
    const cb = el('div', { class: 'clause-bd' });
    if (detail?.titleSegments) cb.appendChild(el('div', { style: 'margin-bottom:4px' }, el('span', { html: segmentsHtml(detail.titleSegments) })));
    cb.appendChild(el('div', { class: 'clause-body', html: detail?.bodySegments ? segmentsHtml(detail.bodySegments) : esc(c.body) }));
    const outgoing = p.final.refs.filter((r) => r.source === c.key);
    if (outgoing.length) cb.appendChild(el('div', { class: 'refs-line' }, '引用：',
      ...outgoing.map((r) => el('span', { class: 'ref-tag' }, '→ ', el('span', { class: 'key-chip' }, r.target), r.label ? `（${r.label}）` : ''))));
    node.appendChild(cb);
    box.appendChild(node);
  });

  // 引用增删
  if (diff.refs_added?.length || diff.refs_removed?.length) {
    box.appendChild(el('h4', {}, '引用差异'));
    for (const r of diff.refs_removed || []) {
      box.appendChild(el('div', {}, el('del', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
    }
    for (const r of diff.refs_added || []) {
      box.appendChild(el('div', {}, el('ins', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
    }
  }

  box.appendChild(el('div', { class: 'muted small', style: 'margin-top:10px;word-break:break-all' },
    '确认凭据（已由系统在下方确认按钮中携带，无需复制）：', el('br'), el('span', { class: 'key-chip' }, p.token)));
  return box;
}

function renderPreviewInvalid(p) {
  const box = el('div', {});
  const reasonMap = {
    DRAFT_CHANGED_AFTER_PREVIEW: '草案在预览后被编辑或重命名',
    LATEST_VERSION_CHANGED: '预览后有其他草案先发布，最新发布版已变化',
    SCHEDULE_CHANGED_AFTER_PREVIEW: '预览后生效排程被改期或取消',
    EFFECTIVE_TIME_PASSED: '预览预定的生效时刻已过',
    PREVIEW_ALREADY_CONSUMED: '该预览凭据已被使用',
    PREVIEW_TOKEN_NOT_FOUND: '预览凭据不存在或已被新预览取代',
    DRAFT_ALREADY_PUBLISHED: '草案已被发布关闭',
    PREVIEW_CONTENT_MISMATCH: '当前将发布的内容与预览结果不一致',
    PREVIEW_INVALIDATED: '预览时的发布条件已不再满足',
  };
  box.appendChild(el('div', { class: 'issue error' }, el('span', {}, '⚠️'),
    el('div', {},
      el('div', {}, el('strong', {}, `预览凭据已失效（${p.error}）：${reasonMap[p.error] || '请重新预览'}`)),
      el('div', { class: 'small muted' }, p.message || '草案已原样保留，可返回修改后重新预览再确认。'),
    )));
  if (p.conflicts?.length || p.dangling?.length) box.appendChild(renderPublishConflict(p));
  if (p.issues?.length) box.appendChild(renderIssueList(p.issues));
  return box;
}

function tail2id(pending) {
  return pending[pending.length - 1].id;
}

function renderPublishConflict(p) {
  const box = el('div', {});
  box.appendChild(el('div', { class: 'issue error' }, el('span', {}, '⛔'),
    el('span', {}, '发布被拒绝，草案已完整保留。请对照下列冲突修改草案后重新发布。')));
  for (const c of p.conflicts || []) {
    box.appendChild(el('div', { class: 'issue error' }, el('span', {}, '⚔️'),
      el('div', {},
        el('div', {}, el('strong', {}, `条款冲突 · ${c.key}（${c.kind}）`)),
        el('div', { class: 'small muted' }, c.message),
      )));
  }
  for (const dg of p.dangling || []) {
    box.appendChild(el('div', { class: 'issue error' }, el('span', {}, '🔗'),
      el('div', {},
        el('div', {}, el('strong', {}, '重放后引用悬空')),
        el('div', { class: 'small muted' }, dg.message),
      )));
  }
  return box;
}

// ---------------------------------------------------------------------------
// 生效排程：当前生效版 / 待生效队列 / 改期取消 / 时点查询
// ---------------------------------------------------------------------------
async function openSchedule() {
  state.schedule = await api('GET', '/api/schedule');
}

function renderSchedule() {
  const wrap = el('div', {});
  if (!state.schedule) {
    openSchedule().then(render).catch((e) => toast(e.message, 'err'));
    return wrap;
  }
  const s = state.schedule;

  const stats = el('div', { class: 'stat-row' },
    stat(s.current ? `v${s.current.id}` : '-', '当前生效版'),
    stat(s.pending.length, '待生效版本'),
    stat('#' + s.schedule_revision, '排程修订号'),
    el('div', { style: 'flex:1' }),
    el('button', {
      class: 'btn ghost small',
      onclick: async () => {
        if (state._scheduleTimer) { clearInterval(state._scheduleTimer); state._scheduleTimer = null; }
        state.schedule = null;
        await refresh();
      },
    }, '刷新排程'),
  );
  wrap.appendChild(stats);

  // 当前生效版
  const cur = el('div', { class: 'panel' });
  cur.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, '当前生效版'),
    el('span', { class: 'muted small' }, `服务器当前 UTC：${fmtTime(s.now)}`),
  ));
  const curBd = el('div', { class: 'panel-bd' });
  cur.appendChild(curBd);
  if (!s.current) {
    curBd.appendChild(el('div', { class: 'empty' }, el('div', { class: 'big' }, '⏳'), '尚无可生效版本'));
  } else {
    curBd.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('strong', { style: 'font-size:16px' }, `v${s.current.id} · ${s.current.note}`),
      scheduleStatusBadge(s.current),
      el('span', { class: 'muted small' }, `生效时刻 ${fmtUtc(s.current.effective_at)} / ${fmtLocal(s.current.effective_at)}`),
      el('div', { style: 'flex:1' }),
      el('button', {
        class: 'btn secondary small',
        onclick: async () => { state.view = 'history'; state.versionId = s.current.id; await openVersionAndRender(); },
      }, '查看完整条款与引用'),
    ));
    if (s.pending.length) {
      curBd.appendChild(el('p', { class: 'muted small', style: 'margin-top:10px' },
        `注意：最新发布版 v${s.pending[s.pending.length - 1].id} 已生成不可变快照但尚未生效；草案以最新发布版为基线，即时发布需等待队列清空。`));
    }
  }
  wrap.appendChild(cur);

  // 待生效队列
  const qp = el('div', { class: 'panel' });
  qp.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, `待生效队列（${s.pending.length}）`),
    el('span', { class: 'muted small' }, '生效时刻按发布版顺序严格递增；改期不得越过相邻版本或落到过去'),
  ));
  const qbd = el('div', { class: 'panel-bd' });
  qp.appendChild(qbd);
  if (!s.pending.length) {
    qbd.appendChild(el('div', { class: 'empty small' }, '队列为空：新的发布未指定生效时刻时即时生效'));
  } else {
    const tbl = el('table', { class: 'list' },
      el('thead', {}, el('tr', {},
        el('th', {}, '顺序'), el('th', {}, '版本'), el('th', {}, '生效时刻（UTC）'), el('th', {}, '本地时间 / 倒计时'), el('th', {}, '来源'), el('th', {}),
      )),
      el('tbody', {},
        ...s.pending.map((v, i) => el('tr', {},
          el('td', {}, `#${i + 1}`),
          el('td', {}, el('strong', {}, `v${v.id}`), ' ', el('span', { class: 'muted small' }, v.note)),
          el('td', { class: 'small' }, fmtUtc(v.effective_at)),
          el('td', { class: 'small' },
            el('div', {}, fmtLocal(v.effective_at)),
            el('div', { class: 'muted', id: `countdown-${v.id}` }, countdown(v.effective_at)),
          ),
          el('td', { class: 'muted small' }, v.draft_id ? `草案 #${v.draft_id}` : '—'),
          el('td', {},
            el('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
              el('button', { class: 'btn secondary small', onclick: () => openReschedule(v) }, '改期'),
              el('button', { class: 'btn danger small', onclick: () => openCancel(v) }, '取消生效'),
              el('button', {
                class: 'btn ghost small',
                onclick: async () => { state.view = 'history'; state.versionId = v.id; await openVersionAndRender(); },
              }, '快照'),
            ),
          ),
        )),
      ),
    );
    qbd.appendChild(tbl);
  }
  wrap.appendChild(qp);

  // 时点查询
  const tp = el('div', { class: 'panel' });
  tp.appendChild(el('div', { class: 'panel-hd' }, el('h2', {}, '按时点查询当时生效版本')));
  const tbd = el('div', { class: 'panel-bd' });
  tp.appendChild(tbd);
  const atInput = el('input', { type: 'datetime-local', step: '1' });
  const resultBox = el('div', {});
  tbd.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
    el('label', { class: 'fld', style: 'margin:0' }, el('span', { class: 'muted small' }, 'UTC 时点（按本地时区输入）'), atInput),
    el('button', { class: 'btn secondary', onclick: () => queryEffective(null) }, '查询当前'),
    el('button', { class: 'btn', onclick: () => queryEffective(atInput.value) }, '查询指定时点'),
  ));
  tbd.appendChild(el('p', { class: 'muted small' },
    '也可直接调用 GET /api/effective?at=2026-10-01T08:30:00Z。已发生时点的结果不随后续改期或取消变化。'));
  tbd.appendChild(resultBox);
  wrap.appendChild(tp);

  async function queryEffective(localValue) {
    resultBox.innerHTML = '';
    let url = '/api/effective';
    let label = '当前';
    if (localValue) {
      if (!localValue) { toast('请选择时点', 'err'); return; }
      const iso = localInputToIso(localValue);
      url += `?at=${encodeURIComponent(iso)}`;
      label = fmtUtc(iso);
    }
    try {
      const r = await api('GET', url);
      if (!r.version) {
        resultBox.appendChild(el('div', { class: 'empty small', style: 'margin-top:10px' }, `${label}：尚无生效版本`));
        return;
      }
      resultBox.appendChild(el('div', { class: 'issue', style: 'margin-top:10px' },
        el('span', {}, '📌'),
        el('div', {},
          el('div', {}, el('strong', {}, `${label} 生效版本：v${r.version_id} · ${r.version.note}`)),
          el('div', { class: 'small muted' },
            `${r.version.clauses.length} 条条款 · ${r.version.refs.length} 条引用 · 该版自 ${fmtUtc(r.version.effective_at)} 起生效`),
          el('button', {
            class: 'btn ghost small', style: 'margin-top:6px',
            onclick: async () => { state.view = 'history'; state.versionId = r.version_id; await openVersionAndRender(); },
          }, '查看完整条款、顺序与引用'),
        ),
      ));
    } catch (e) {
      resultBox.appendChild(renderIssueList([{ message: e.message }]));
    }
  }

  // 倒计时每秒刷新
  if (s.pending.length && state._scheduleTimer) clearInterval(state._scheduleTimer);
  if (s.pending.length) {
    state._scheduleTimer = setInterval(() => {
      for (const v of s.pending) {
        const node = $(`#countdown-${v.id}`);
        if (node) node.textContent = countdown(v.effective_at);
      }
    }, 1000);
  }
  return wrap;
}

function openReschedule(v) {
  const input = el('input', { type: 'datetime-local', step: '1' });
  input.value = localInputValue(v.effective_at);
  const err = el('div', {});
  const rev = state.schedule.schedule_revision;
  modal({
    title: `改期 v${v.id} · ${v.note}`,
    body: el('div', {},
      el('p', { class: 'muted small' },
        '新生效时刻必须：① 严格晚于当前 UTC 时间；② 不越过相邻待生效版本（按发布版顺序）。改期后排程修订号递增。'),
      el('label', { class: 'fld' }, el('span', {}, '新生效时刻（按本地时区输入，将转为 UTC）'), input),
      el('div', { class: 'muted small' }, `当前排程修订号：${rev}（将随请求一并携带）`),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn', onclick: async () => {
          err.innerHTML = '';
          if (!input.value) { err.appendChild(renderIssueList([{ message: '请选择生效时刻' }])); return; }
          try {
            const r = await api('POST', `/api/versions/${v.id}/schedule`, {
              effective_at: localInputToIso(input.value),
              schedule_revision: rev,
            });
            closeModal();
            state.schedule = r.schedule;
            toast(`v${v.id} 已改期至 ${fmtUtc(r.effective_at)}`, 'ok');
            await render();
          } catch (e) {
            if (e.payload?.schedule) state.schedule = e.payload.schedule;
            err.appendChild(renderIssueList([{ message: e.message }]));
          }
        },
      }, '确认改期'),
    ],
  });
}

function openCancel(v) {
  const err = el('div', {});
  const rev = state.schedule.schedule_revision;
  modal({
    title: `取消 v${v.id} 的待生效排程`,
    body: el('div', {},
      el('p', {},
        '确认取消版本 v', el('strong', {}, String(v.id)), `（${v.note}）于 `,
        el('strong', {}, fmtUtc(v.effective_at)), ' 的生效排程？'),
      el('p', { class: 'muted small' },
        '取消后该不可变快照仍保留（可在发布历史中查看），但永不生效；已发生时点的查询结果不受影响。此操作需要当前排程修订号。'),
      el('div', { class: 'muted small' }, `当前排程修订号：${rev}`),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '返回'),
      el('button', {
        class: 'btn danger', onclick: async () => {
          err.innerHTML = '';
          try {
            const r = await api('POST', `/api/versions/${v.id}/cancel`, { schedule_revision: rev });
            closeModal();
            state.schedule = r.schedule;
            toast(`v${v.id} 已取消生效，快照保留`, 'ok');
            await render();
          } catch (e) {
            if (e.payload?.schedule) state.schedule = e.payload.schedule;
            err.appendChild(renderIssueList([{ message: e.message }]));
          }
        },
      }, '确认取消生效'),
    ],
  });
}

// ---------------------------------------------------------------------------
// 发布历史 & 版本还原
// ---------------------------------------------------------------------------
function renderHistory() {
  const wrap = el('div', {});
  const versions = state.overview.versions;
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-hd' }, el('h2', {}, `发布历史（${versions.length} 个不可变版本）`)),
  );
  const bd = el('div', { class: 'panel-bd' });
  panel.appendChild(bd);
  const tbl = el('table', { class: 'list' },
    el('thead', {}, el('tr', {},
      el('th', {}, '版本'), el('th', {}, '说明'), el('th', {}, '排程状态'), el('th', {}, '生效时刻 (UTC)'), el('th', {}, '基线'), el('th', {}, '来源草案'), el('th', {}, '发布时间'), el('th', {}),
    )),
    el('tbody', {},
      ...[...versions].reverse().map((v) => {
        const src = v.draft_id ? `草案 #${v.draft_id}` : v.note === '首版发布' ? '首版录入' : '—';
        const isCurrent = v.id === state.overview.current_version_id;
        return el('tr', {},
          el('td', {}, el('strong', {}, `v${v.id}`), isCurrent ? el('span', { class: 'badge open', style: 'margin-left:6px' }, '当前生效') : null),
          el('td', {}, v.note),
          el('td', {}, scheduleStatusBadge(v)),
          el('td', { class: 'small muted' }, v.schedule_status === 'immediate' ? '（即时）' : fmtUtc(v.effective_at)),
          el('td', {}, v.baseline_id ? `v${v.baseline_id}` : '—'),
          el('td', {}, src),
          el('td', { class: 'muted small' }, fmtTime(v.created_at)),
          el('td', {}, el('button', { class: 'btn secondary small', onclick: async () => { state.versionId = v.id; await openVersionAndRender(); } }, '查看 / 还原')),
        );
      }),
    ),
  );
  bd.appendChild(tbl);
  wrap.appendChild(panel);
  return wrap;
}

async function openVersionAndRender(compare) {
  const q = compare ? `?compare=${compare}` : '';
  state.version = await api('GET', `/api/versions/${state.versionId}${q}`);
  await render();
}

function renderVersion() {
  const wrap = el('div', {});
  if (!state.version || state.version.id !== state.versionId) {
    openVersionAndRender().catch((e) => toast(e.message, 'err'));
    return wrap;
  }
  const v = state.version;
  wrap.appendChild(el('div', { class: 'breadcrumb' },
    el('a', { onclick: async () => { state.versionId = null; await refresh(); } }, '发布历史'),
    ` / v${v.id}（不可变快照）`,
  ));

  const versions = state.overview.versions;
  const compareSel = el('select', {},
    el('option', { value: '' }, '不比较'),
    ...versions.filter((x) => x.id !== v.id).map((x) => el('option', { value: x.id }, `与 v${x.id} 比较`)),
  );
  if (v.compare_to) compareSel.value = String(v.compare_to);
  compareSel.addEventListener('change', () => openVersionAndRender(compareSel.value || null));

  const changedKeys = new Set((v.diff?.changed || []).map((c) => c.key));
  const addedKeys = new Set(v.diff?.added || []);
  const deletedKeys = new Set(v.diff?.deleted || []);

  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-hd' },
    el('div', {},
      el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        el('h2', { style: 'margin:0' }, `v${v.id} · ${v.note}`),
        scheduleStatusBadge(v),
        v.id === state.overview.current_version_id ? el('span', { class: 'badge open' }, '当前生效') : null,
      ),
      el('div', { class: 'muted small' },
        `发布（快照生成）于 ${fmtTime(v.created_at)} · 生效时刻 ${fmtUtc(v.effective_at)} · 基线 ${v.baseline_id ? 'v' + v.baseline_id : '无'} · 完全还原该版顺序、正文与引用`),
    ),
    el('div', { class: 'compare-picker' }, compareSel),
  ));

  const bd = el('div', { class: 'panel-bd' });
  panel.appendChild(bd);

  if (v.diff) {
    const chips = [
      v.diff.added.length ? el('span', { class: 'badge ok' }, `新增 ${v.diff.added.length}`) : null,
      v.diff.deleted.length ? el('span', { class: 'badge err' }, `删除 ${v.diff.deleted.length}`) : null,
      v.diff.changed.length ? el('span', { class: 'badge warn' }, `修改 ${v.diff.changed.length}`) : null,
    ].filter(Boolean);
    if (chips.length) bd.appendChild(el('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap' }, chips));

    if (v.diff.deleted.length) {
      const tb = el('div', { class: 'panel deleted-glow', style: 'margin-bottom:14px' },
        el('div', { class: 'panel-bd' },
          el('strong', { style: 'color:var(--red)' }, '本版已删除（相对比较基线）：'),
          el('div', { class: 'small' }, [...deletedKeys].join('、')),
        ));
      bd.appendChild(tb);
    }
  }

  const details = new Map((v.changed_detail || []).map((c) => [c.key, c]));
  v.clauses.forEach((c, i) => {
    const node = el('div', { class: 'clause' });
    const cls = addedKeys.has(c.key) ? 'added-glow' : changedKeys.has(c.key) ? 'changed-glow' : '';
    if (cls) node.classList.add(cls);
    const hd = el('div', { class: 'clause-hd' },
      el('span', { class: 'ord' }, `#${i + 1}`),
      el('span', { class: 'key-chip' }, c.key),
      el('span', { class: 'title' }, c.title),
      addedKeys.has(c.key) ? el('span', { class: 'badge ok' }, '新增') : null,
      changedKeys.has(c.key) ? el('span', { class: 'badge warn' }, '修改') : null,
    );
    node.appendChild(hd);
    const detail = details.get(c.key);
    const bodyHtml = detail?.bodySegments ? segmentsHtml(detail.bodySegments) : esc(c.body);
    const titleHtml = detail?.titleSegments ? segmentsHtml(detail.titleSegments) : null;
    const cb = el('div', { class: 'clause-bd' });
    if (titleHtml) cb.appendChild(el('div', { style: 'margin-bottom:4px' }, el('span', { html: titleHtml })));
    cb.appendChild(el('div', { class: 'clause-body', html: bodyHtml }));
    const outgoing = v.refs.filter((r) => r.source === c.key);
    if (outgoing.length) cb.appendChild(el('div', { class: 'refs-line' }, '引用：',
      ...outgoing.map((r) => el('span', { class: 'ref-tag' }, '→ ', el('span', { class: 'key-chip' }, r.target), r.label ? `（${r.label}）` : ''))));
    node.appendChild(cb);
    bd.appendChild(node);
  });

  if (v.diff?.refs_added?.length || v.diff?.refs_removed?.length) {
    bd.appendChild(el('h4', {}, '引用变化'));
    for (const r of v.diff.refs_removed || []) bd.appendChild(el('div', {}, el('del', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
    for (const r of v.diff.refs_added || []) bd.appendChild(el('div', {}, el('ins', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
  }

  wrap.appendChild(panel);
  return wrap;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
refresh().catch((e) => toast('加载失败：' + e.message, 'err'));
