# pi-feishu-bot

[Pi](https://github.com/badlogic/pi-mono) 的飞书机器人桥接扩展：通过飞书长连接接收消息，为每个群聊或私聊用户运行隔离、持久化的 Pi RPC 会话，并用单张流式卡片展示思考状态、工具进度和最终回复。

## 特性

- 无需公网回调地址，使用飞书 WebSocket 长连接。
- 群聊按 `chatId` 隔离，私聊按 `senderId` 隔离。
- 可在群聊触发 Agent 时按需拉取近期的人类聊天消息作为背景，不会响应未 @ 的普通消息。
- 每个飞书会话拥有独立的 Pi RPC 进程、JSONL 历史和串行消息队列。
- 可用英文斜杠命令管理会话，并通过 `/models`、`/model` 查看或切换当前会话模型；重启可恢复，不修改全局默认模型。
- 同一条消息只创建一张卡片，处理中持续更新，完成后原地替换为最终答案。
- 内置 `notify` 工具，可由 Pi Agent 向配置好的固定飞书信息同步群发送任务开始、里程碑、阻塞和完成通知。
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
pi install git:github.com/Tieboyh/pi-feishu-bot@v0.6.0
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

Windows PowerShell 可使用：

```powershell
$stateDir = Join-Path $HOME ".pi\agent\state\pi-feishu-bot"
New-Item -ItemType Directory -Force $stateDir | Out-Null
notepad (Join-Path $stateDir ".env")
```

Windows 不支持 Unix 的 `0600` / `0700` 权限语义，配置文件和会话文件会继承当前用户目录的 NTFS ACL。不要把状态目录放到共享或对其他用户开放的位置。

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

# 群聊上下文预取，0 表示关闭（默认）
FEISHU_GROUP_CONTEXT_MESSAGES=20
FEISHU_GROUP_CONTEXT_LOOKBACK_MS=1800000
# bot（默认）或 lark-cli-user
FEISHU_GROUP_CONTEXT_SOURCE=bot

# 可选：notify 工具的固定信息同步群自定义机器人 Webhook
FEISHU_NOTIFY_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
# 默认 10000，范围 1-60000 毫秒
FEISHU_NOTIFY_TIMEOUT_MS=10000
```

启用群聊上下文后，只有已经通过群聊响应策略的消息（默认是 @机器人）才会触发历史拉取。机器人从同一群聊最近的消息中选取指定数量的人类消息，排除当前触发消息、历史 @机器人消息、机器人消息和已删除消息，并把它们作为“不受信任的用户内容”附加给 Agent。普通群消息仍然不会调用 Agent 或产生回复。

`FEISHU_GROUP_CONTEXT_SOURCE=bot` 使用当前应用的机器人身份，应用需要拥有 `im:message:readonly` 与群历史读取权限，机器人需要在目标群内。若现有机器人权限不足，也可以显式设置为 `lark-cli-user`，使用本机 `lark-cli` 已有的用户授权读取该用户可见的群消息；该模式要求已安装 `lark-cli`，且不会自动发起登录或申请权限。启动 `lark-cli` 时只传递系统环境，不继承飞书机器人凭据。

历史拉取失败或超时不会阻断当前消息，Agent 会退化为仅处理当前消息。也可以直接在启动 Pi 的环境中设置这些变量。手动修改配置后执行 `/reload`。

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

### 固定群通知工具

配置 `FEISHU_NOTIFY_WEBHOOK` 后，主 Pi 会话和飞书隔离 RPC 会话都会注册 `notify` 工具。工具只接收 `title` 与 `message`，接收群由 Webhook 固定，模型不能选择或修改目标。

`notify` 适用于来自飞书的中长任务：任务实际开始后、重要里程碑、阻塞或失败、需要用户处理以及最终完成。普通聊天、简单操作、重复状态和仅面向当前会话的回复不应调用。标题最多 64 个 Unicode 字符，正文最多 1200 个 Unicode 字符；默认请求超时为 10 秒。

Webhook 只在工具执行时从进程环境或权限为 `0600` 的状态文件读取，不写入工具参数、结果、Pi 会话或模型上下文。飞书隔离 RPC 进程仍不会继承 `FEISHU_*` 环境变量；subagent 不加载该工具。

### 在飞书中管理会话

推荐直接发送 `/help` 查看命令集。命令在进入模型前由扩展执行，不需要 Agent 调用工具；群聊默认仍需 @机器人。

| 命令 | 功能 |
|---|---|
| `/help` | 显示命令帮助 |
| `/new [名称]` | 创建并切换会话，名称可省略 |
| `/list` | 查看当前聊天的历史会话 |
| `/current` | 查看当前会话 |
| `/models [页码]` | 分页查看可用模型（每页 12 个） |
| `/model` | 查看当前会话模型 |
| `/model <provider>/<modelId>` | 切换当前会话模型，保留历史 |
| `/switch <名称或短 ID>` | 切换会话并恢复历史 |
| `/restore` | 恢复上一个会话 |
| `/delete <名称或短 ID>` | 发起删除 |
| `/confirm [名称或短 ID]` | 确认自己在 5 分钟内发起的删除 |
| `/cancel` | 取消自己发起的删除 |

每条消息只发送一条命令。英文命令不区分大小写，名称可以包含空格，例如 `/new 项目 A`。未知命令或缺少参数时直接返回帮助，不交给模型猜测。删除仍需同一发送者二次确认。仅支持英文斜杠命令，中文会话名称仍然可用。中文自然语言消息不会触发会话管理操作。

每个私聊用户独立管理自己的会话；群聊中的会话由该群共享。

普通消息仍进入当前活跃会话。删除操作不可恢复；群聊中的切换和删除会影响整个群的共享上下文。

模型命令示例：先发送 `/models`，复制完整标识后发送 `/model provider/model-id`。模型 ID 可以包含 `/`，且区分大小写；不做模糊匹配。有任务执行或排队时，模型命令会提示等待完成。首次使用模型命令会自动创建当前会话，不调用 LLM。

模型切换只影响当前活跃会话；群聊中影响当前群共享会话，私聊不会影响其他用户。显式模型选择写入会话索引，即使新会话尚无消息历史，重启后也会恢复；有历史的会话还会保留 Pi JSONL 模型变更记录。新会话继续使用本机原有默认模型。

默认 Node RPC 启动器通过 `src/runtime/isolated-settings.mjs` 预加载适配，将 Pi 的 SettingsManager 存储变为进程内写时复制；仍从原位置读取配置、认证和资源，但模型/思考等级等设置写入不会改动全局或项目 `settings.json`。该适配依赖 Pi 的公开 SettingsManager 工厂，真实 RPC 测试覆盖其兼容性。使用 `PI_SUBAGENT_PI_BINARY` 自定义启动器时，未验证此隔离，模型切换会被拒绝，查询仍可用。

列表只展示模型标识、名称和图片能力，不输出认证或接口配置。切换成功表示会话模型已确认，不代表供应商接口调用一定可用；未配置认证、服务限流等仍可能在下一条普通消息时报错。

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
- 启用群聊上下文预取后，拉取到的近期人类聊天文本也会随触发消息写入对应 JSONL 会话；附件仅记录类型占位符，不会自动下载。
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
│   ├── sessions/                # 会话生命周期、索引、切换与存储安全
│   └── tools/                   # Pi 自定义工具（固定群 notify）
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

CI 会在 Linux、macOS 和 Windows 上运行完整验证。Windows 下 RPC 子进程由当前 `node.exe` 直接启动 Pi 官方导出的 `rpc-entry`，不依赖 npm 生成的 `pi.cmd` 或 PATH；如设置了 `PI_SUBAGENT_PI_BINARY`，仍优先使用该自定义入口。`lark-cli-user` 模式会直接运行官方 CLI 的原生可执行文件或 Node 包装入口，不通过 `cmd.exe` shell。

## 安全

Pi 扩展以当前用户的完整系统权限运行。安装第三方 Pi Package 前应审查源码。本扩展不会把 App ID、App Secret、Webhook 或其他机器人平台凭据写入模型上下文或传给 subagent；飞书 RPC Agent 的 `notify` 扩展只在工具执行边界从受保护状态文件解析 Webhook。聊天内容和工具历史会持久化到本机状态目录。

不要提交 `.env`、`sessions/`、锁文件或任何真实凭据。若凭据意外泄露，请立即在飞书开放平台轮换。

## License

MIT
