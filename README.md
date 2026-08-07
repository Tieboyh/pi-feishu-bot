# pi-feishu-bot

[Pi](https://github.com/badlogic/pi-mono) 的飞书机器人桥接扩展：通过飞书长连接接收消息，为每个群聊或私聊用户运行隔离、持久化的 Pi RPC 会话，并用单张流式卡片展示思考状态、工具进度和最终回复。

## 特性

- 无需公网回调地址，使用飞书 WebSocket 长连接。
- 群聊按 `chatId` 隔离，私聊按 `senderId` 隔离。
- 每个飞书会话拥有独立的 Pi RPC 进程、JSONL 历史和串行消息队列。
- 同一条消息只创建一张卡片，处理中持续更新，完成后原地替换为最终答案。
- 会话进程可按空闲时间安全释放，后续消息从持久化历史恢复。
- 跨 Pi 进程独占连接，避免一个机器人被重复消费和重复回复。
- 默认由当前 Agent 直接执行；只有用户在当前消息中明确要求委派时才允许前台 subagent。
- 飞书凭据不会传入隔离的 RPC Agent 或 subagent 环境。

## 要求

- Node.js 22 或更高版本。
- 已安装并可运行 `pi`。
- 一个已发布的飞书企业自建应用。

## 安装

推荐固定到 release tag：

```bash
pi install git:github.com/Tieboyh/pi-feishu-bot@v0.4.1
```

也可以临时试用当前主分支：

```bash
pi -e git:github.com/Tieboyh/pi-feishu-bot
```

安装或更新后，在 Pi 中执行：

```text
/reload
```

## 飞书开放平台配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建企业自建应用。
2. 开启机器人能力。
3. 开通 `im:message`、`im:message:readonly`；如需接收图片，再开通 `im:resource`。根据实际能力按需添加其他权限。
4. 订阅 `im.message.receive_v1`，接收方式选择“使用长连接接收事件”。
5. 创建并发布应用版本。

群聊默认只有在 @机器人时才响应。

## 配置凭据

推荐直接在 Pi TUI 中运行：

```text
/feishu-setup
```

交互流程会依次输入 App ID、以掩码输入 App Secret，并选择群聊响应策略。确认后扩展以 `0600` 权限写入配置文件并自动执行 `/reload`；密钥不会显示在界面、写入 Pi 会话或发送给模型。随后执行 `/connect-feishu` 即可。

交互配置仅支持 Pi TUI。扩展也支持手动配置：进程环境变量优先，其次读取：

```text
~/.pi/agent/state/pi-feishu-bot/.env
```

手动安全创建配置文件：

```bash
install -d -m 700 ~/.pi/agent/state/pi-feishu-bot
install -m 600 /dev/null ~/.pi/agent/state/pi-feishu-bot/.env
${EDITOR:-vi} ~/.pi/agent/state/pi-feishu-bot/.env
```

写入：

```dotenv
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_REQUIRE_MENTION=true
```

可选配置：

```dotenv
FEISHU_MAX_CONVERSATIONS=20
FEISHU_IDLE_CONVERSATION_MS=1800000
```

也可以直接在启动 Pi 的环境中设置这些变量。手动修改配置后执行 `/reload`。

## 使用

扩展加载后不会自动连接。在希望承载机器人的 Pi 会话中执行：

```text
/connect-feishu
```

该 Pi 会话执行命令时的当前目录会成为所有飞书 Agent 的工作区。Pi 会从这个目录加载 `AGENTS.md`、项目 Skill 和其他工作区资源。

可用命令：

| 命令 | 说明 |
|---|---|
| `/feishu-setup` | 交互输入并安全保存 App ID、掩码 App Secret 和群聊响应策略 |
| `/connect-feishu` | 获取独占锁并建立飞书长连接 |
| `/disconnect-feishu` | 断开连接、关闭会话进程并释放锁 |
| `/feishu` | 查看连接、锁持有者、工作区和活跃会话数量 |

Pi 退出、切换会话或 `/reload` 时会自动断开。之后需要重新执行 `/connect-feishu`。

### 在飞书中管理会话

会话控制语句由扩展在进入模型前确定性识别，不会作为普通任务发送给 AI。每个私聊用户独立管理自己的会话；群聊中的会话由该群共享。可直接发送：

| 飞书消息示例 | 行为 |
|---|---|
| `开一个新会话` / `清空当前上下文` | 保留历史并创建全新上下文 |
| `开一个名为 项目A 的新会话` | 创建并切换到命名会话 |
| `查看历史会话` | 列出名称、短 ID、最后使用时间和当前会话 |
| `当前是什么会话` | 查看当前活跃会话 |
| `切换到会话 项目A` | 切换到指定名称或短 ID |
| `恢复上一个会话` | 切回最近一次使用的上一会话 |
| `删除会话 项目A` | 发起删除并返回二次确认提示 |
| `确认删除会话 项目A` | 由同一发送者在 5 分钟内确认永久删除 |
| `取消删除` | 取消待确认删除 |

普通消息仍进入当前活跃会话。删除操作不可恢复；群聊中的切换和删除会影响整个群的共享上下文。

### 图片输入

可以在私聊或群聊中直接发送图片，也可以同时附带文字说明。扩展从飞书下载图片、校验真实文件格式并以 Pi RPC `ImageContent` 传给当前会话；飞书资源 key 不会进入模型提示词。

限制：

- 支持 PNG、JPEG、GIF、WebP。
- 单条消息最多 4 张。
- 单张最多 10 MB，总计最多 20 MB。
- 当前使用的模型必须支持视觉输入；不支持时会返回处理失败信息。
- 普通文件、音频、视频和贴纸暂不作为 Agent 附件处理。
- 图片会随对话内容写入受保护的 Pi JSONL 会话历史；删除对应历史会话时一并删除。

## 会话与数据

运行数据保存在：

```text
~/.pi/agent/state/pi-feishu-bot/
├── .env
├── connection.lock*
└── sessions/
    ├── index.json
    └── *.jsonl
```

- `index.json` 保存每个聊天的会话列表、当前/上一会话、名称、时间和 Pi Session 文件路径；旧版单会话索引会自动迁移。
- JSONL 文件包含用户消息、AI 回复、工具调用结果和压缩摘要。
- 群聊会把发送者姓名和 ID 作为消息元数据写入对应会话。
- Unix/macOS 下，状态目录会收紧为 `0700`，凭据、索引和会话文件为 `0600`。
- 推荐通过飞书中的二次确认流程删除历史会话，不要在机器人连接时手动修改索引或 JSONL。

默认最多保留 20 个内存会话。安全空闲超过 30 分钟的 RPC 会话可以被关闭，但持久化历史不会删除。

## Subagent 策略

飞书 RPC 会话会暴露 `subagent` 和 `subagent_wait`，但默认不调用。只有最新一条用户消息明确要求使用 subagent、委派或指定代理角色执行时才允许使用，且授权不跨请求继承。

当前限制：

- 只允许 `worker`、`reviewer`、`scout`、`planner`。
- 执行必须使用 `async:false`。
- 禁止 detached/background 委派。
- 子 Agent 不可继续委派。
- 管理动作仅开放只读检查及停止/中断等安全动作。

## 项目结构

```text
pi-feishu-bot/
├── src/
│   ├── index.ts                 # Pi 扩展入口与飞书通道编排
│   ├── config/                  # 交互配置与凭据落盘
│   ├── connection/              # 长连接独占锁
│   ├── messaging/               # 消息路由、图片输入、卡片与流式输出
│   ├── runtime/                 # 隔离 RPC Agent 与 subagent 策略
│   └── sessions/                # 会话生命周期、索引、切换与存储安全
├── tests/
│   ├── fixtures/                # 测试辅助进程
│   └── *.test.ts                # 单元与集成测试
├── .github/workflows/           # CI
├── package.json                 # Pi Package 清单
└── README.md
```

运行时状态不会写入源码目录，统一保存在 `~/.pi/agent/state/pi-feishu-bot/`。

## 开发

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

测试使用 Bun；运行时只需要 Node.js 和 Pi。

## 安全

Pi 扩展以当前用户的完整系统权限运行。安装第三方 Pi Package 前应审查源码。本扩展不会把 App ID、App Secret 或其他机器人平台凭据传给飞书 RPC Agent，但会将聊天内容和工具历史持久化到本机状态目录。

不要提交 `.env`、`sessions/`、锁文件或任何真实凭据。若凭据意外泄露，请立即在飞书开放平台轮换。

## License

MIT
