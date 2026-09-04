# dsh-sidechat 设计文档

> 状态：设计中（host 删除配方、选词边界与预填机制取证中）。
> 版本基线：DSH `0.1.1-rc.2`（`D:\dsh\app\node_modules\@deepseek-ai\*`）。

## 1. 背景与目标

在 DSH Web GUI（http://127.0.0.1:3080）中：
1. 只允许在 **assistant 正式回答（final answer）** 文本上划词（思考过程不可划词提问）；
2. 划词后出现"提问"浮标，点击打开 **侧边聊天面板**，划词内容**预填**进面板输入框；
3. 侧边面板是**临时聊天**：关闭即消失、不进用户聊天目录（目录可见性：打开期间允许显示该行，关闭后彻底移除）；
4. 面板聊天功能 = 官方完整聊天；
5. 参考 Codex 侧边聊天，但**禁止套娃**（side-mode 内层实例禁用划词提问）。

## 2. 关键约束（源码考证）

- DSH Web = cordis patch 分层：`dsh-base` + `dsh-web-app` bundle + 用户 profile `cordis.patch.yml` 覆盖层。
- 浏览器插件包契约：npm 包带 `dsh.client` 元数据与 `exports["./client"]`；host 在启动时扫 Loader 行 → `/plugins/<id>/client.js`；bundle 形如
  `window.__ModuleLoader__.load({ id: <packageName>, factory: (require) => ({ apply, inject }) })`。
  证据：`dsh-client-ui-layout/lib/client.js` 头部、`dsh-client-modules/README.md`、`dsh-client-hmr/README.md`（HMR 轮询任一 bundle 变更，重建即热更）。
- UI 注入点：`shell.overlay`（frame-wide floating layer，"additive seat for a frame-wide surface of your own"），
  证据：`dsh-client-ui-layout/lib/types/client/index.d.ts` L67-80、AppFrame `renderSlot("shell.overlay", {})`。
  当前无任何包占用该 seat（我们是首个 occupant）。
- 客户端 ctx 服务词汇表（各 bundle 实测）：`ctx.sessions / ctx.workspaces / ctx.layout / ctx.slots / ctx.remote / ctx.conversation / ctx.locale / ctx.settingsScope`。
- **单活会话舞台**：event window 只对 staged（= list.current）session 打开；"today the stage is `current`; the staged state can widen to a multi-pane list later"。
  证据：`dsh-client-runtime/lib/types/client/sessions/service.d.ts` L8-15。
  → 同页并排双活必须**独立浏览上下文**（同源 iframe，天然各自 stage/SSE）→ 选定 B2 方案。
- ctx.sessions 公开面（ISessions）**不含 create**（只有 open/clear/fork/…）；创建走 `ctx.workspaces.connectWorkspace(workspaceId)` 或具体实例 `SessionRuntime.create`（支持 caller 预分配 sessionId）。
  证据：`dsh-client-runtime/lib/types/client/contract/sessions.d.ts`、`sessions/service.d.ts`、`workspaces/service.d.ts`。
- 浏览器 RPC 词汇表固定，**无 session.delete/remove/end**；只有 `workspace.archiveSession`（归档后所有分组隐藏、current 会被清）。
  证据：`dsh-host-apiproxy/lib/types/api/rpc-map.d.ts`（完整 method map）。
- iframe 同源嵌入：响应头无 X-Frame-Options/CSP frame-ancestors 限制（已实测 `curl -sI`）。
- dsh 启动会写 `$DSH_HOME/profiles/web/cordis.yml`（compose 产物）；重启 dsh web 属于对 `D:\dsh\data` 的写操作。

## 3. 总体架构（B2 变体）

```
┌──────────────────────── 主窗口（dsh web 实例 A）────────────────────────┐
│ [sidebar] [ conversation 主会话 ]            [dsh-sidechat 面板（浮层）] │
│                                                ┌───────────────────────┐ │
│ 划词（仅正式回答区）→ 提问浮标 → 点击            │ iframe: dsh web 实例 B│ │
│                                                │  side-mode=1          │ │
│ postMessage ◄───────────────────────────────►  │  · 官方完整聊天 UI     │ │
│   open-with(text) / close                      │  · 划词功能禁用        │ │
│   ready(sessionId)                             │  · 会话临时、预填文本   │ │
│                                                └───────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                共享宿主（同一个 dsh web 进程 / 同一 127.0.0.1:3080）
```

- 面板 = 主窗口 `shell.overlay` 上的一个占位 React 组件（右侧浮层，自带头部/关闭/宽度），内含 `<iframe src="<origin>/?dsh_sidechat=1">`。
- 实例 B 在 boot 后运行同一插件（side-mode 分支）：
  - 通过 `postMessage` 与父窗口握手；
  - 收到 `open`：在**当前 workspace** 创建临时会话 → `sessions.open(id)` → 预填划词文本；
  - 目录显示该行（允许）；
  - 收到/触发 `close`：归档或删除会话（待取证），销毁 iframe。
- 套娃防护：side-mode 分支不注册划词监听；另用 URL 参数 + 运行时双检。

## 4. 消息协议（草案）

主窗口 → 面板 iframe（`postMessage`，origin 校验 = 同源）：
- `{ type: 'dsh-sidechat:open', text: string, quote?: string, workspaceId?: string }`
- `{ type: 'dsh-sidechat:close' }`

面板 → 主窗口：
- `{ type: 'dsh-sidechat:ready' }`
- `{ type: 'dsh-sidechat:opened', sessionId: string }`
- `{ type: 'dsh-sidechat:closed' }`

## 5. 部署 / 迭代 runbook（本机）

1. 包本体：`<repo>/`（package.json `main` = node half；`exports["./client"]` = browser half bundle；`dsh.client` 元数据）。
2. 安装（把包复制/链接到 profile 的 node_modules）：
   `D:\dsh\data\profiles\node_modules\dsh-sidechat\`（与现有 hoisted 平铺布局一致，无需 pnpm）。
3. 注册行：编辑 `D:\dsh\data\profiles\web\cordis.patch.yml`（当前 `[]`），加入 `insert` 条目（id/name/config 语法与 `dsh-web-app/cordis.patch.yml` 的 insert 块同构）。
4. 重启：`D:\dsh\stop-dsh.cmd`（或 kill `web.pid`）→ 后台任务 `D:\dsh\dsh.cmd web`（首启会写 cordis.yml，需对 D:\dsh\data 的写权限；`--no-open` 阻止开浏览器），等日志出现 `dsh web: http://127.0.0.1:3080`。
5. 迭代：改 `client.js` 后无需重启（client-hmr 轮询该 bundle 变更即热更；插件状态会重置）。新增行/改包名需要重启。
6. 注意：重启会中断正在进行的会话 agent（宿主进程重启）。

## 6. 待取证结论（研究子代理输出后将填充）

- [ ] Host 侧"彻底删除会话"配方或 fallback（归档）决策 —— 影响临时会话清理。
- [ ] 正式回答 vs 思考的 DOM/数据判据（划词启用条件）。
- [ ] composer 预填 API 与 staged 要求。
- [ ] 面板 iframe 内 UI 精简方式（折叠侧栏即可 / 需隐藏 rail 的 CSS 锚点）。

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 单活舞台 → 并排双活需 iframe | 已接受 | B2 方案；套娃禁用 |
| 会话彻底删除无官方 RPC | 中 | host half 配方或归档 fallback（取证中） |
| ui-conversation 视图组件不对外导出 | 中 | 面板 = 官方完整 UI（iframe），不自绘 |
| 内层 UI 在窄面板下挤压 | 低 | 折叠侧栏；宽度自适应；视觉验收 |
| HMR 仅覆盖 bundle 迭代 | 低 | 新增行走重启流程 |
