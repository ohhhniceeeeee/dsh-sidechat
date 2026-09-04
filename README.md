# dsh-sidechat

DSH (DeepSeek Harness) 客户端插件：**划词提问 → 侧边聊天面板**。

在聊天的"正式回答"（assistant final answer）文本上划词，弹出"提问"浮标；点击后在页面右侧以**同源 iframe** 打开一个侧边聊天面板（side-mode，官方完整聊天功能），并把划词内容预填进输入框。侧边会话是临时会话：打开期间可在目录中看到，**关闭面板即彻底移除**，不残留。

设计约束（源自客户端运行时模型）：
- DSH Web 客户端是"单活会话舞台"模型（`dsh-client-runtime`：event window ⟺ staged session），同页双活对话需独立浏览上下文 → 采用同源 iframe 双实例（B2 方案）。
- **不做嵌套（套娃）**：side-mode 的内层实例完全禁用划词提问功能。

## 仓库结构（规划）

```
dsh-sidechat/            ← npm 包（本仓库根），node half + browser half
  package.json
  index.js               ← node half（宿主端 cordis 插件体，可选）
  client.js              ← browser half bundle（ModuleLoader.load 工厂）
  src/…
docs/design.md           ← 设计文档（可行性分析、约束、协议）
```

安装到运行中的 web profile：
1. 将本包放到 `$DSH_HOME/profiles/node_modules/dsh-sidechat`；
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `[]` 改为插入行（见 docs/design.md）；
3. 重启 `dsh web`（`stop-dsh.cmd` + `dsh web`）。

状态：v0 已实现并入库；正在做"安装进 web profile + 重启 GUI + 真机验证"。
清理语义：临时会话关闭后通过官方 `workspace.archiveSession` 归档（目录永久隐藏；DSH 无删除会话 API，归档即产品级"移除"）。
