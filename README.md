# 社团章程修订 Web 应用

一款面向社团章程（条款制规章）的版本化修订平台：

- 录入**首版条款及条款间引用**，原子生成不可变版本；
- 从任意已发布版本创建**草案**，对带**稳定标识**的条款进行编辑、移动、删除，并登记/删除条款引用；
- 随时查看草案相对其**基线版本**的结构差异与正文逐字差异；
- 草案编辑具备**可追溯的撤销与重做**：条款的新增、改写、删除、移动，引用增删与草案改名均形成**持久操作记录**（含操作时间与摘要、操作后完整快照），可逐步撤销/重做；恢复同时还原条款顺序、标题正文、引用与显式移动记录；撤销后产生新编辑会舍弃重做分支；撤销/重做须携带读取时的**草案修订号**（乐观并发），恢复前取得的预览凭据立即失效；已发布草案仅可查看历史；
- 发布前可先**预览将要落库的最终版本**：沿用同一套三方重放与排程规则，返回相对**最新发布版**的条款正文、顺序、引用差异；预览只发放一枚**确认凭据**，不写版本、不关闭草案；持凭据确认时只能提交与预览**逐字节一致**的内容和生效安排，草案被编辑/重命名、其他草案先发布、排程改期/取消、预定时刻已过都会使凭据失效（附原因、保留草案，重新预览即可）；
- 并行草案发布时，系统把草案相对基线的改动**重放（replay）**到最新发布版：
  - **不相交**的条款改动自动合并；
  - **同一条款被双方改动**（或一方删除、另一方修改，或双方新增同标识但内容不同）→ **拒绝发布**，逐条说明冲突；
  - 重放后产生**悬空引用**（引用来源或目标条款不存在）→ **拒绝发布**并列出悬空引用；
  - 冲突/悬空时**草案原样保留**，可继续修改后再次发布；
- 草案允许**暂存悬空引用**并在界面明确标红，但**不能发布**；
- 发布成功在**单个 SQLite 原子事务**中写入不可变新版本；历史版本可完整**还原该版的条款顺序、正文与引用**，并支持任意两版差异对比。
- 发布可指定**晚于当前时间的 UTC 生效时刻**：发布后仍**立即生成不可变版本快照**，但到点才自动成为当前生效版（惰性生效，无后台任务）。
- 页面「生效排程」展示**当前生效版**与**待生效队列**，支持生效前**改期 / 取消**（携带读取时的**排程修订号**乐观并发控制）。
- 可按任意 UTC 时点查询**当时生效版本**的完整条款、顺序与引用；**已发生时点的结果不随后续改期或取消变化**。

## 技术栈

- Node.js 20（内置 `http`，无额外 Web 框架）
- SQLite（[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)，同步事务）
- 浏览器端原生 HTML/CSS/JavaScript 单页应用（无需构建）

## 一键启动（Docker Compose）

需要已安装 Docker 与 Compose 插件（`docker compose version` 可用）。

```bash
docker compose up -d --build
```

启动后访问：

- **地址：** http://localhost:3000
- **端口：** 容器内固定 `3000`；宿主机端口可用环境变量 `HOST_PORT` 修改：

```bash
HOST_PORT=8080 docker compose up -d --build
# 访问 http://localhost:8080
```

停止与清理：

```bash
docker compose down            # 停止并删除容器（数据库卷保留）
docker compose down -v         # 同时删除数据库卷（清空全部数据，谨慎）
docker compose logs -f         # 查看日志
```

SQLite 数据库文件位于命名卷 `charter-data` 内（容器路径 `/data/charter.db`），首次启动若库表不存在会自动建表初始化，无需手工迁移。

## 本地直接运行（不使用 Docker）

要求 Node.js ≥ 20。

```bash
npm install
npm start
```

运行单元测试（纯业务逻辑：差异 / 三方重放 / 悬空引用）：

```bash
npm test
```

## 配置

通过环境变量配置，均有默认值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `./data/charter.db`（本地）/ `/data/charter.db`（Docker） | SQLite 数据库文件路径，目录不存在会自动创建；首次启动自动建表 |

Docker Compose 额外支持：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口 |

## 使用流程

1. **录入首版**：打开首页即见首版录入表单（已附 4 条示例条款与引用，可直接“发布首版”体验）。逐条填写稳定标识（字母、数字、汉字、`_`、`-`，≤40 字符）、标题、正文，并登记条款间引用；提交后原子生成不可变 `v1`。
2. **创建草案**：在“草案”页选择基线版本创建草案。可同时创建多个草案（并行修订）。
3. **编辑草案**：
   - 新增条款（获得新的稳定标识，追加后可用 ↑/↓ 移动）；
   - 编辑标题/正文（标识不可修改，保证跨版本稳定）；
   - 移动条款顺序、删除条款；
   - 新增/删除引用，允许引用暂不存在的条款——会被标记为**悬空引用**并阻止发布；
   - 以上每次编辑、移动、删除、引用增删与改名都可在草案页「操作历史」中**逐步撤销/重做**（历史持久保存，撤销/重做按钮自动携带草案修订号）。
4. **查看差异**：草案页实时显示相对基线的新增/删除/修改/移动与引用增删，可打开“正文差异”查看逐字增删（`<ins>` / `<del>`）。
5. **预览（可选）与发布**：
   - 点「预览将要发布的版本」可先查看将要落库的最终条款全文/顺序/引用（相对最新发布版的增删改、移动与引用差异），以及立即/定时生效安排；预览**不写版本、不关闭草案**；
   - 草案存在错误级问题（空正文、悬空引用、标识重复等）、重放冲突或排程不满足规则时，预览与发布一样被拒绝并说明原因，且**不发凭据**；
   - 预览成功后点「按此预览确认发布」即持凭据在同一事务内原子发布与预览完全一致的内容；期间草案被编辑/重命名、其他草案先发布、排程改期/取消、预定时刻已过，页面会提示凭据失效原因，返回重新预览即可；
   - 原有「直接发布（不预览）」按钮与 `POST /publish` 一步到位方式继续可用；若基线不是最新版，发布在 `BEGIN IMMEDIATE` 事务内把改动重放到最新版；不相交改动合并成功则生成新版本；同条款双方改动或重放后悬空则返回冲突说明、回滚事务并保留草案；
   - 发布/预览时均可选择「立即生效」或「定时生效」（UTC 时刻，必须晚于当前）。
6. **发布历史**：在“发布历史”中查看每个不可变版本（顺序/正文/引用完整还原），可下拉选择任意其他版本做两版对比；版本列表标注「即时生效 / 待生效 / 已取消」与生效时刻。
7. **生效排程**：在“生效排程”页查看当前生效版、待生效队列与排程修订号，对待生效版本改期或取消，并按任意 UTC 时点查询当时生效版本。

## 定时生效与排程规则

- **发布即固化、到点才生效**：指定 `effective_at`（带 `Z` 或时区偏移的 ISO-8601，晚于当前 UTC）后，版本内容快照立即不可变写入，`schedule_status = scheduled`；到点后查询自动命中（惰性，无需定时任务/重启迁移）。
- **严格递增**：同一待生效队列中，各版本的生效时刻必须按**发布版顺序**严格递增——新入队时刻须严格晚于队列末尾版本，否则以 `SCHEDULE_ORDER_VIOLATION` 拒绝。
- **队列保护**：队列非空时，**未指定**生效时刻的发布会被拒绝（`QUEUE_NOT_EMPTY`）并返回当前排程；队列为空时未指定时刻仍沿用**即时生效**。
- **改期**：只能改仍未到点的待生效版本；新时刻必须晚于当前，且**不得越过相邻版本**（严格位于前后相邻待生效版本的时刻之间）。
- **取消**：生效前可取消（`schedule_status = cancelled`），快照保留、永不生效；已生效或已取消版本不可再改期/取消。
- **排程修订号（乐观锁）**：任一入队/改期/取消都会使 `meta.schedule_revision` 递增。改期/取消必须携带读取排程时获得的 `schedule_revision`；修订号过期或版本已生效时**整次拒绝**并在响应中返回**当前排程**。
- **时点查询不可变**：`GET /api/effective?at=<ISO>` 返回该时点生效版本及其完整条款/顺序/引用。由于改期只能指向未来、取消只作用于待生效版本，**已发生时点的查询结果不会因之后的改期或取消而改变**。
- **草案基线**：始终以**最新发布版**（最大版本号，含待生效/已取消快照）为默认基线；现有版本快照、两版差异与草案编辑操作均不受排程影响。

## 合并（重放）语义

设基线为 `B`，草案为 `D`，最新发布版为 `L`，逐条款判定：

| 情况 | 结果 |
| --- | --- |
| 仅 `D` 改动（新增/编辑/移动/删除） | 采用草案内容与位置 |
| 仅 `L` 改动 | 保留最新版内容 |
| `D` 与 `L` 改动完全相同（收敛） | 自动采纳，不算冲突 |
| 双方对同一标识都做了不同改动 | **冲突，拒绝发布**（`modify-modify` / `delete-modify` / `modify-delete` / `add-add`） |
| 双方都删除同一条款 | 收敛为删除 |
| 重放后任一引用的来源或目标条款缺失 | **悬空，拒绝发布** |

条款的出边（引用）跟随条款归属：条款采纳自哪一侧，其引用集就来自哪一侧。新增条款的位置按其在草案中的锚点（前一条款）插入到最新版顺序中；移动条款同理重定位。

“移动”按方向性锚点判定：旧序锚点的后继在新序中发生变化且该后继仍位于锚点之后，才算该条款被主动移动（被插队而被动让位的条款不计）。因此“草案后移 B、最新版仅修改 C 正文”这类不相交改动可以干净重放。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/overview` | 章程标题、版本列表（含排程状态/生效时刻）、草案列表、当前生效版与排程修订号 |
| `POST` | `/api/initialize` | 录入并发布首版（仅一次）；可选 `effective_at` 定时生效 |
| `GET` | `/api/effective?at=:iso` | 查询指定 UTC 时点（缺省为当前）当时生效版本及完整条款、顺序、引用 |
| `GET` | `/api/schedule` | 当前生效版、待生效队列（顺序）、排程修订号 |
| `POST` | `/api/versions/:id/schedule` | 改期 `{effective_at, schedule_revision}` |
| `POST` | `/api/versions/:id/cancel` | 取消待生效排程 `{schedule_revision}` |
| `GET` | `/api/versions/:id?compare=:otherId` | 查看版本快照（可选两版差异） |
| `POST` | `/api/drafts` | 从基线版本创建草案 `{baseline_id?, name?}` |
| `GET` | `/api/drafts/:id?diff=1` | 草案详情、问题清单、基线差异 |
| `PATCH` | `/api/drafts/:id` | 重命名草案 |
| `POST` | `/api/drafts/:id/clauses` | 新增条款 |
| `PUT` | `/api/drafts/:id/clauses/:key` | 编辑条款标题/正文 |
| `DELETE` | `/api/drafts/:id/clauses/:key` | 删除条款（相关引用保留为悬空） |
| `POST` | `/api/drafts/:id/clauses/:key/move` | 移动条款 `{ordinal}` 或 `{after}` |
| `POST` | `/api/drafts/:id/refs` | 新增引用（允许悬空暂存） |
| `DELETE` | `/api/drafts/:id/refs/:ordinal` | 删除引用 |
| `GET` | `/api/drafts/:id/history` | 操作历史（持久记录、时间、摘要、当前游标、修订号、可否撤销/重做） |
| `POST` | `/api/drafts/:id/undo` | 撤销一步 `{revision}`（乐观草案修订号） |
| `POST` | `/api/drafts/:id/redo` | 重做一步 `{revision}` |
| `POST` | `/api/drafts/:id/preview` | 发布预览（不写版本/不关草案）：跑完整重放与排程校验，成功返回确认凭据与相对最新版的最终条款/顺序/引用差异 |
| `POST` | `/api/drafts/:id/publish` | 原子发布；可选 `effective_at`（未来 UTC 时刻）定时生效；携带 `preview_token` 时为**凭据确认发布**（内容须与预览完全一致） |

### 定时生效调用示例（curl）

```bash
# 1) 定时发布：指定未来 UTC 时刻，立即得到不可变版本号与当前排程
curl -s -X POST http://localhost:3000/api/drafts/1/publish \
  -H 'Content-Type: application/json' \
  -d '{"note":"秋季修订","effective_at":"2026-10-01T08:30:00Z"}'
# -> { "version_id": 5, "schedule_status": "scheduled",
#      "effective_at": "2026-10-01T08:30:00.000Z",
#      "schedule": { "schedule_revision": 3, "current_version_id": 4,
#                    "pending": [ {"id":5,"effective_at":"..."} ] } }

# 2) 队列非空时不指定时刻 -> 409 QUEUE_NOT_EMPTY（响应携带当前排程）
#    入队时刻必须严格晚于队列末尾，否则 409 SCHEDULE_ORDER_VIOLATION

# 3) 改期：携带读取时的排程修订号；不得越过相邻版本或落到过去
curl -s -X POST http://localhost:3000/api/versions/5/schedule \
  -H 'Content-Type: application/json' \
  -d '{"effective_at":"2026-10-02T09:00:00Z","schedule_revision":3}'
# -> { "ok": true, "schedule_revision": 4, "schedule": {...} }
# 修订号过期 -> 409 STALE_SCHEDULE_REVISION（响应返回当前排程）
# 版本已生效 -> 409 ALREADY_EFFECTIVE；已取消 -> 409 VERSION_CANCELLED

# 4) 生效前取消（快照仍保留、永不生效）
curl -s -X POST http://localhost:3000/api/versions/5/cancel \
  -H 'Content-Type: application/json' -d '{"schedule_revision":4}'

# 5) 时点查询：当时生效版本及完整条款/顺序/引用（已发生时点结果恒定）
curl -s 'http://localhost:3000/api/effective?at=2026-10-01T08:30:00Z'
curl -s 'http://localhost:3000/api/effective'   # 当前生效版
```

时间参数只接受**带明确时区设计符**的 ISO-8601（`...Z` 或 `...+08:00`），服务端统一转为 UTC 存储与比较；不带时区的“天真”时间串会以 `400 VALIDATION` 拒绝。

### 发布预览与凭据确认（curl）

预览与发布走**完全相同**的校验路径（排程规则 → 草案静态校验 → 三方重放），因此预览能看到的就是确认时将落库的内容：预览成功只生成一枚确认凭据（随机 256-bit，十六进制串），**不写版本、不关闭草案**；确认时服务端在同一个 `BEGIN IMMEDIATE` 事务内重新核对全部前提并重放一遍，只有结果与预览**逐字节一致**才原子发布。

```bash
# 1) 预览：入参与发布一致（note、可选 effective_at）
curl -s -X POST http://localhost:3000/api/drafts/1/preview \
  -H 'Content-Type: application/json' \
  -d '{"note":"秋季修订","effective_at":"2026-12-01T08:30:00Z"}'
# 200 ->
# { "preview": true,
#   "token": "9f2c…（64 位十六进制确认凭据）",
#   "draft_id": 1, "note": "秋季修订",
#   "latest_version_id": 7, "replayed": false,
#   "schedule_status": "scheduled",
#   "effective_at": "2026-12-01T08:30:00.000Z",
#   "schedule_revision": 3, "schedule": {...},
#   "final": { "order": ["A","B",…],
#              "clauses": [{ordinal,key,title,body},…],
#              "refs":    [{ordinal,source,target,label},…] },
#   "final_moved_keys": ["B"],
#   "diff": { "added": ["D"], "deleted": [],
#             "changed": [{key,body,position,edges,…}],
#             "moved": ["B"],
#             "refs_added":   [{source,target,label},…],
#             "refs_removed": [{source,target,label},…] },
#   "changed_detail": [{ key, titleSegments, bodySegments }] }  # 正文逐字增删（<ins>/<del>）
# 立即生效预览时 schedule_status="immediate"、effective_at=null。
# 冲突/悬空/排程问题返回与发布完全相同的 4xx，且响应中没有 token。

# 2) 凭据确认：同一事务内发布与预览完全一致的内容和生效安排
curl -s -X POST http://localhost:3000/api/drafts/1/publish \
  -H 'Content-Type: application/json' \
  -d '{"preview_token":"9f2c…"}'
# 201 -> 与直接发布相同的响应，另带
# { "version_id": 8, "replayed": true|false,
#   "schedule_status": "scheduled", "effective_at": "…",
#   "confirmed_from_preview": true, "preview_token": "9f2c…",
#   "schedule": {...} }

# 3) 不带凭据的直接发布继续可用（原有语义不变）
curl -s -X POST http://localhost:3000/api/drafts/1/publish \
  -H 'Content-Type: application/json' -d '{"note":"直接发布"}'
```

凭据失效一律 `409`（凭据不存在/被新预览取代为 `404 PREVIEW_TOKEN_NOT_FOUND`），响应附 `retained: true` 与当前 `schedule`，草案原样保留；重新预览即可获得新凭据：

| 错误码 | 触发原因 |
| --- | --- |
| `DRAFT_CHANGED_AFTER_PREVIEW` | 预览后草案的条款/引用被编辑、移动、删除，或草案被重命名 |
| `LATEST_VERSION_CHANGED` | 预览后有其他草案先发布（最新发布版号变化；重预览将重放到新版） |
| `SCHEDULE_CHANGED_AFTER_PREVIEW` | 预览后排程发生改期或取消（排程修订号变化） |
| `EFFECTIVE_TIME_PASSED` | 定时预览预定的 UTC 生效时刻在确认时已过 |
| `PREVIEW_ALREADY_CONSUMED` | 凭据已成功用于一次确认发布，不可重复使用 |
| `PREVIEW_TOKEN_NOT_FOUND` | 凭据不存在、不属于该草案，或已被同一草案的新预览取代（`404`） |
| `PREVIEW_CONTENT_MISMATCH` / `PREVIEW_INVALIDATED` | 兜底：确认事务内重算结果与预览不一致，或发布条件不再满足 |

说明：

- 同一草案重新预览会让旧凭据立即作废；预览凭据不强制过期，已消费/超过 7 天的记录会在下次预览时自动清理。
- 预览在 `BEGIN IMMEDIATE` 事务内读取最新发布版与排程并与并发发布串行化；但预览本身不持有锁到确认时刻，因此上述前提都在**确认事务内**重新核对，即使期间发生并发发布也不会落库与预览不一致的内容。
- 预览从不产生版本号：确认成功写入的版本号以确认时刻为准。

## 草案操作历史、撤销与重做

草案的每一次**条款新增、改写（标题/正文）、删除、移动，引用新增/删除，以及草案改名**都会在 SQLite 中形成一条**持久操作记录**（`draft_operations` 表），记录包含：草案内序号 `seq`、操作类型 `kind`、人类可读摘要 `summary`、结构化细节 `detail`、操作时间 `created_at`，以及该操作完成后的**完整快照**（名称、条款顺序、标题正文、引用、显式移动记录）。

规则：

- **恢复即整体还原**：撤销/重做按目标操作的快照一次性还原**条款顺序、标题正文、引用与显式移动记录**（含草案名称），因此撤销一次“删除”会把条款及其引用状态完整带回，撤销一次“移动”会同时清掉该条移动在差异/重放中的标记。
- **逐步撤销/重做**：每个草案维护游标 `history_pos`（当前状态对应的操作序号，创建操作序号为 1）。撤销只移动游标，不删除记录；重做沿记录前进。
- **撤销后再编辑舍弃重做分支**：若已撤销若干步后又产生了任意新编辑，系统删除游标之后的全部操作记录，新编辑接在当前游标之后，此后不可再重做旧分支。
- **校验失败不留痕**：非法标识、空标题/正文、重复条款/引用、移动锚点不存在等被拒绝的请求，以及“无实际变化”的请求（同名改名、移动到原位、正文未改等），**不产生操作记录、不递增修订号**。
- **草案修订号（乐观锁）**：草案行带整数 `revision`，初始为 1；每次被记录的编辑、改名、撤销、重做都使其 +1。撤销/重做请求必须携带读取草案（`GET /api/drafts/:id` 或 `/history`）时获得的 `revision`；修订号过期时整次拒绝（`409 STALE_DRAFT_REVISION`），不覆盖任何内容，响应中返回**当前草案详情与操作历史**供调用方刷新后重试。
- **恢复后沿用既有规则**：恢复得到的草案仍按现有规则计算差异、问题清单、预览与发布；预览凭据在撤销/重做时**立即作废旧凭据**（确认时为 `404 PREVIEW_TOKEN_NOT_FOUND`），需重新预览。
- **已发布草案不可操作**：草案发布后状态为 `published`，编辑/改名/撤销/重做一律 `409 CLOSED`，但操作历史仍可查看。
- 现有编辑与发布接口保持原有路径与字段，仅在响应的草案详情中额外携带 `revision`、`history_pos`。

### 调用示例（curl）

```bash
# 1) 查看操作历史：按序号升序返回全部持久记录；history_pos 为当前游标
curl -s http://localhost:3000/api/drafts/1/history
# ->
# { "draft_id": 1, "revision": 4, "history_pos": 4,
#   "can_undo": true, "can_redo": false,
#   "operations": [
#     { "seq": 1, "kind": "create",      "summary": "创建草案「秋季修订」", "created_at": "…" },
#     { "seq": 2, "kind": "clause-add",  "summary": "新增条款「E」（经费）", "detail": {"key":"E",…}, "created_at": "…" },
#     { "seq": 3, "kind": "clause-edit", "summary": "改写条款「A」（总则）", "created_at": "…" },
#     { "seq": 4, "kind": "clause-move", "summary": "移动条款「C」至第 2 位", "created_at": "…" }
#   ] }

# 2) 撤销：携带读取时的草案修订号；响应回显被撤销操作并返回当前草案与最新历史
curl -s -X POST http://localhost:3000/api/drafts/1/undo \
  -H 'Content-Type: application/json' -d '{"revision":4}'
# -> { "ok": true, "action": "undo",
#      "applied_seq": 4, "applied_kind": "clause-move", "applied_summary": "移动条款「C」至第 2 位",
#      "draft":  { …草案详情（已还原）… },
#      "history":{ "revision": 5, "history_pos": 3, "can_undo": true, "can_redo": true, … } }

# 3) 重做：同样携带当前修订号（每次撤销/重做都会使其 +1）
curl -s -X POST http://localhost:3000/api/drafts/1/redo \
  -H 'Content-Type: application/json' -d '{"revision":5}'

# 4) 修订号过期 -> 409，响应返回当前草案与历史（用其中的 revision 重试即可）
#    { "error": "STALE_DRAFT_REVISION", "draft": {…}, "history": {…} }
# 已到最早/最新状态：409 NOTHING_TO_UNDO / NOTHING_TO_REDO（同样附带当前草案与历史）
# 已发布草案：409 CLOSED；缺少 revision：400 VALIDATION
```

页面上在每个进行中草案的“操作历史”面板可直接查看全部记录（时间、类型、摘要、当前位置标记，已撤销记录置灰）并用「↩ 撤销 / ↪ 重做」按钮逐步执行；遇到修订号过期会自动刷新到当前状态。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── src
│   ├── server.js      # HTTP 服务、API、原子发布事务、发布预览/凭据确认、生效排程/改期/取消、时点查询、草案操作历史/撤销/重做
│   ├── db.js          # SQLite 连接、建表、版本/草案快照读写、排程修订号、预览凭据存取、操作历史快照与游标
│   └── model.js       # 纯逻辑：差异、移动判定、三方重放、悬空引用校验、生效判定/队列
├── public
│   ├── index.html     # 单页应用入口
│   ├── styles.css
│   └── app.js         # 首版录入 / 草案编辑 / 差异 / 发布 / 历史还原 / 生效排程 / 操作历史撤销重做
└── test
    ├── model.test.js    # 核心合并逻辑与排程判定单元测试（npm test）
    ├── e2e.js           # 端到端 API 冒烟测试（含定时生效/改期/取消/时点查询）
    ├── preview.e2e.js   # 发布预览/凭据确认端到端测试（各类凭据失效场景）
    └── history.e2e.js   # 操作历史/撤销/重开端到端测试（快照恢复、修订号乐观锁、重做分支截断、凭据失效、已发布保护）
```

## 数据持久化与备份

- 本地运行：数据库即 `DB_PATH` 指向的文件（默认 `./data/charter.db`，WAL 模式另有 `-wal`/`-shm` 伴生文件）。
- Docker：使用命名卷 `charter-data`，可用 `docker cp` 或直接挂载卷备份；已发布版本的**条款内容快照**只追加、不更新不删除，具备不可变性。排程仅改 `effective_at` 或置 `schedule_status = cancelled`，不触碰条款快照；升级后首次启动会自动为旧库补齐排程列（旧版本按发布时刻即时生效）。
- 发布预览凭据保存在 `preview_tokens` 表（首次启动自动建表，无需迁移）：仅记录内容快照哈希所需的规范化 JSON 与生效安排，不是版本数据；重新预览会作废旧凭据，确认成功置为已消费，已消费/超 7 天的记录在下次预览时自动清理。删除该表不影响任何已发布版本。
- 草案操作历史保存在 `draft_operations` 表（首次启动自动建表）：每行存操作完成后的完整快照，草案行的 `history_pos` 为当前游标、`revision` 为草案修订号。撤销/重做只移动游标并按快照恢复，不删除记录；撤销后再编辑会截断游标之后的记录。升级旧库时会自动补齐 `revision`/`history_pos` 列，并为每个已存在草案补一条与当前内容一致的“创建草案”基线记录，旧草案同样可撤销/重做。
