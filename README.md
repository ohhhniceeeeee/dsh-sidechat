# dsh-sidechat

DSH（DeepSeek Harness）Web 客户端插件：**对回答划词提问，在侧边打开一个临时聊天面板**。

在聊天的**正式回答**（assistant final answer）文本上划词，会浮出一个「在侧边聊天提问」按钮；点击后页面右侧展开一个侧边聊天面板，并把划词内容**预填**进输入框。面板内是**官方完整的聊天界面**（同源 iframe 的第二实例），可以正常对话、使用工具、流式输出；侧边会话是**临时会话**——关闭面板即从目录中移除，不残留。

## 功能

- ✅ 划词只对"正式回答"生效：**思考过程（thinking）与流式中的回答不可划词提问**。
- ✅ 侧边面板 = 官方完整聊天（不是自绘的简化聊天框）。
- ✅ 划词内容自动预填为输入框草稿，可编辑后再发送（不自动发送）。
- ✅ 临时会话：打开期间允许出现在目录中；**关闭面板后从目录消失**。
- ✅ 不做"套娃"：面板内的聊天实例完全禁用划词提问（side-mode 分支）。

## 为什么用 iframe（B2 方案）

DSH Web 客户端是"单活会话舞台"模型（`dsh-client-runtime`：事件窗口只对当前 session 打开）。同一页面无法并行渲染两个"活"对话。因此侧边面板采用**同源 iframe 双实例**——iframe 是独立的浏览上下文，拥有自己的舞台与数据连接，天然支持并排双活，且无需改动 DSH 核心。

详见 [docs/design.md](docs/design.md)（可行性分析、源码取证、postMessage 协议、风险登记）。

## 临时会话的清理语义

DSH Web 目前**没有删除会话的官方 API**（浏览器 RPC 仅支持 `workspace.archiveSession` 归档）。因此关闭面板时对已有内容的临时会话执行归档：

- 归档后会话从所有分组/目录/搜索中隐藏，且 UI 没有"取消归档"入口——对用户而言即"彻底移除"；
- 会话日志文件与账号槽位仍留在 `$DSH_HOME` 磁盘上（与官方产品行为一致：Web 本就不提供删除）；
- 未发送任何消息（blank）的会话本就不显示在目录中，可被"新建会话"自然复用，故不归档；
- 若页面在面板打开时被强制关闭，插件会在下次启动时依据 `localStorage` 标记清理残留会话。

## 仓库结构

```
dsh-sidechat/
├── package.json        # 包清单 + dsh.client 元数据（浏览器端入口声明）
├── index.js            # node half：空插件体（清理全部走浏览器端公共 RPC）
├── client.js           # browser half：主窗口 UI + side-mode（自包含，无构建步骤）
├── docs/design.md      # 设计文档：约束考证、协议、部署与迭代、风险登记
└── tools/probe/        # 无头浏览器（playwright-core + Chrome/Edge）验证脚本
```

## 安装

面向 DSH `0.1.1-rc.2`（`$DSH_HOME` 即部署数据目录，如本机 `D:\dsh\data`）。

1. 把本仓库放入 `$DSH_HOME/profiles/node_modules/dsh-sidechat/`（与既有平铺依赖布局一致）：

   ```sh
   # 例：把仓库内容放进 profile 依赖目录
   cp -r dsh-sidechat "$DSH_HOME/profiles/node_modules/dsh-sidechat"
   ```

2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml`（初始内容为 `[]`）注册插件行：

   ```yaml
   - insert:
       - id: sidechat
         name: 'dsh-sidechat'
   ```

3. 重启 `dsh web`，刷新页面即可（新插件行在启动时进入模块图）。

## 开发迭代

- 修改 `client.js` 后**无需重启**：`dsh-client-hmr` 会轮询该 bundle 变更并热重载插件（页面上的面板状态会重置）。
- 新增插件行、改名或改动 `package.json` 则需要重启 `dsh web`。
- 端到端自检脚本：`node tools/probe/probe3.js`（需先在 `tools/probe/` 安装 `playwright-core`，并配置本机 Chrome/Edge 路径）。

## 已知边界

- 会话删除依赖官方归档语义（见上），磁盘文件不做物理删除；
- 预填但未发送的会话保持"blank"，可能被官方"新建会话"逻辑复用（与产品自身语义一致）；
- 面板默认宽度为 `min(50% 视口宽, 760px)`，若内层界面被挤压可调小/调大后反馈。

## License

MIT
