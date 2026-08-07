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
pi install git:github.com/Tieboyh/pi-feishu-bot@v0.1.0
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
3. 开通 `im:message`、`im:message:readonly`；根据实际能力按需添加其他权限。
4. 订阅 `im.message.receive_v1`，接收方式选择“使用长连接接收事件”。
5. 创建并发布应用版本。

群聊默认只有在 @机器人时才响应。

## 配置凭据

扩展优先读取进程环境变量，其次读取：

```text
~/.pi/agent/state/pi-feishu-bot/.env
```

安全创建配置文件：

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

也可以直接在启动 Pi 的环境中设置这些变量。修改配置后执行 `/reload`。使用 `/feishu-setup` 可以检查凭据是否已经被扩展读取；该命令不会显示密钥内容。

## 使用

扩展加载后不会自动连接。在希望承载机器人的 Pi 会话中执行：

```text
/connect-feishu
```

该 Pi 会话执行命令时的当前目录会成为所有飞书 Agent 的工作区。Pi 会从这个目录加载 `AGENTS.md`、项目 Skill 和其他工作区资源。

可用命令：

| 命令 | 说明 |
|---|---|
| `/feishu-setup` | 显示凭据配置路径及是否缺少必要配置 |
| `/connect-feishu` | 获取独占锁并建立飞书长连接 |
| `/disconnect-feishu` | 断开连接、关闭会话进程并释放锁 |
| `/feishu` | 查看连接、锁持有者、工作区和活跃会话数量 |

Pi 退出、切换会话或 `/reload` 时会自动断开。之后需要重新执行 `/connect-feishu`。

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

- `index.json` 保存聊天键到 Pi Session 文件的映射。
- JSONL 文件包含用户消息、AI 回复、工具调用结果和压缩摘要。
- 群聊会把发送者姓名和 ID 作为消息元数据写入对应会话。
- Unix/macOS 下，状态目录会收紧为 `0700`，凭据、索引和会话文件为 `0600`。
- 删除某个 JSONL 及对应索引映射会丢失该聊天的可恢复历史；操作前先断开机器人并备份。

默认最多保留 20 个内存会话。安全空闲超过 30 分钟的 RPC 会话可以被关闭，但持久化历史不会删除。

## Subagent 策略

飞书 RPC 会话会暴露 `subagent` 和 `subagent_wait`，但默认不调用。只有最新一条用户消息明确要求使用 subagent、委派或指定代理角色执行时才允许使用，且授权不跨请求继承。

当前限制：

- 只允许 `worker`、`reviewer`、`scout`、`planner`。
- 执行必须使用 `async:false`。
- 禁止 detached/background 委派。
- 子 Agent 不可继续委派。
- 管理动作仅开放只读检查及停止/中断等安全动作。

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
