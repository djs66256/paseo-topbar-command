# paseo-topbar-command

一个 Paseo 插件：把每个项目的 `paseo.json` 命令放到 workspace **顶栏按钮**里，
每个按钮（command）对应一种能力：

1. **打开 / 切换应用**（如 Godot）：已启动则切换到它，未启动则启动。
2. **执行脚本**：运行任意 shell 命令，实时显示执行状态（运行中 / 成功 / 失败、退出码、输出末尾、耗时），可中途停止。

## 顶栏按钮

Paseo 0.8 的 `client.addHeaderButton({ id, workspaceId, button })` 在注册时就绑定到
**某一个 workspace**，所以插件会枚举 daemon 上的 workspace，为**每个存在 `paseo.json` 的项目**
注册一个顶栏按钮（右上角、内置操作之前）：

- 点击是**菜单**：直接列出该项目 `paseo.json` 里的按钮，Godot 一下打开/切换、导出脚本一下就跑。
- 菜单底部还有：**运行状态…**（popover，显示运行中/刚结束的任务、耗时、输出末尾，可停止）、
  **打开 Commands 面板**、**重新加载 paseo.json**。
- 有脚本在运行时，顶栏图标右上角会加一个**强调色小圆点**，不打开就知道在跑。
- 项目**没有** `paseo.json` 时不显示按钮（新建文件后在面板里点「重新加载」即可出现）。

另外保留两个贡献点：

- **workspace 面板** `Commands`（与 Agents / Terminal / Files 并列）：完整状态与输出视图。
- **Command Center 项**（⌘K 搜索 “Open project commands”）：快速打开该面板。

顶栏位置由 host 决定：宽窗口最多放 3 个插件按钮，窄窗口/移动端只放 1 个，多出的收进 workspace 的「更多操作」菜单。
菜单项的 id 使用配置下标（`run-0`…）而不是用户填的 `id`，因为 Paseo 会校验菜单 id 必须是
`^[a-z][a-z0-9-]*$` 并在非法时抛错。

## 安装

```bash
pnpm install
pnpm typecheck
pnpm check:client          # bundle 能注册面板 / 顶栏按钮（V8）
pnpm check:client:hermes   # bundle 在真机引擎 Hermes 里也能跑（见下方「移动端约束」）
paseo plugin install /绝对路径/paseo-topbar-command
paseo plugin ls          # 应显示 running
```

需要先在 **Settings → Plugins** 开启 **Enable plugins**（即 daemon `config.json` 的 `pluginsEnabled`）。
改代码后重载：

```bash
pnpm typecheck
pnpm check:client:hermes   # client/ 改过就建议跑一次（iPad 崩溃防线）
paseo plugin reload paseo-topbar-command
```

本仓库根目录自带一个 `paseo.json`（类型检查 / 重载插件 / 打开 Paseo），
可以直接在这个项目上试顶栏按钮。

## 配置

在**项目根目录**创建 `paseo.json`：

```json
{
  "buttons": [
    {
      "type": "app",
      "id": "godot-editor",
      "label": "Godot: open",
      "app": "Godot",
      "bundleId": "org.godotengine.Godot",
      "projectPath": "godot",
      "args": ["--editor"]
    },
    {
      "type": "script",
      "id": "export-web",
      "label": "导出 Web",
      "command": "godot --headless --export-release \"Web\"",
      "cwd": "build",
      "description": "导出 HTML5 版本"
    }
  ]
}
```

### app 按钮

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | `"app"` |
| `id` | 是 | 按钮唯一 id |
| `label` | 是 | 按钮显示名 |
| `app` | 是 | 应用名。macOS 上用 `open -a <app>`（例如 `Godot`）；Windows 用 `start` |
| `bundleId` | 否 | macOS bundle id（如 `org.godotengine.Godot`）。存在时优先用 `open -b`，聚焦已运行实例最可靠 |
| `projectPath` | 否 | 传给应用的工程路径（Godot → `--path <路径>`）。相对路径基于项目根目录解析，`.` 表示项目根目录本身 |
| `args` | 否 | 追加在工程路径之后的启动参数，如 `["--editor"]` |

macOS 下 `open -a/-b` 的语义正是「打开，若已打开则切换到它」。Linux 为尽力而为：
优先 `wmctrl -a` 聚焦，失败则 `gtk-launch` / `xdg-open` 启动。

**同一个项目才切换。** 当配置了 `projectPath` 时，插件不会只看「应用是否在运行」——
应用启动时带的是 `--path <解析后的路径>`，这个参数会留在进程 argv 里（每个 Godot
编辑器实例终身绑定一个项目），所以能精确判断「这个项目是否已经开着」：

- 已开着**同一个项目**的实例 → 直接切换到它，不再新开编辑器；
- 开着的是**别的项目**（或根本没开）→ 才新开一个实例加载本项目，避免抢走别的项目的编辑器。

### script 按钮

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | `"script"` |
| `id` | 是 | 按钮唯一 id（同时用作任务 id） |
| `label` | 是 | 按钮显示名 |
| `command` | 是 | 任意 shell 命令，经 `sh -c` 执行 |
| `cwd` | 否 | 工作目录，相对项目根目录或绝对路径；缺省为项目根目录 |
| `description` | 否 | 按钮下的说明文字 |

执行时按钮显示「运行中 + 耗时」与实时输出末尾，结束时显示 ✓/✕、退出码、总耗时与输出末尾；
运行中可点「停止」。面板和顶栏 popover 共用同一份运行状态（`client/run-store.ts`），
而且脚本任务 id 带上了 workspace 前缀，所以不同项目里同名的 `id` 可以同时跑。

### usage 按钮（订阅用量 / 多账号）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | `"usage"` |
| `id` | 是 | 按钮唯一 id |
| `label` | 是 | 按钮显示名 |
| `provider` | 是 | 内置：`commandcode` / `minimax-cn` / `minimax` |
| `apiKey` | 否 | 直接写 key（不推荐，会进 paseo.json） |
| `apiKeyEnv` | 否 | 从环境变量读 key |
| `apiKeyPath` | 否 | `文件#a.b.c` JSON 指针，如 `~/.pi/agent/auth.json#commandcode_1.key` |
| `baseUrl` | 否 | 覆盖 provider 端点 |
| `refreshIntervalMinutes` | 否 | 自动刷新间隔，默认 60 |
| `description` | 否 | 按钮下的说明文字 |

展开卡片显示 5 小时 / 每周 / 月度进度条、重置倒计时、剩余额度与 Key 来源；
顶栏菜单也会把每个 usage 按钮的摘要列出来。

**CommandCode 多账号是自动的。** 只写一个按钮：

```json
{ "type": "usage", "id": "cc", "label": "CommandCode", "provider": "commandcode" }
```

面板里会自动出现一张卡片**每个账号一张**：daemon 会扫描 auth 文件里所有匹配
`commandcode[-_]*` 的槽位（`commandcode`、`commandcode_1`、`commandcode-2`、`command_code3`…），
按 key 去重（同一个 key 存在多个槽位只算一个账号），并用槽位里的 `account` 作为账号名。
所以 `auth.json` 里 `commandcode` 和 `commandcode_2` 指同一个 key 时，只会出现一张对应卡片。
卡片标题保持你写的 `label`（如 `CommandCode`），副标题是 `用量 · <账号>`（如 `用量 · djs662566yccp`）；
套餐（`individual goat（active）`）、账号槽位、进度条、剩余额度与 Key 来源都在**展开后**的详情里。

- 卡片不直接保存 key：它记住的是 auth 文件里的**槽位**，由 daemon 在 fetch 时读取，
  所以 secret 不会进 paseo.json，也不需要为每个账号手写 `apiKeyPath`。
- 每个账号优先用**专属槽位**（不用 `commandcode` 这个“当前默认”指针），
  这样切换默认账号后卡片不会被 “带跑”，两张卡始终是两个账号。
- 如果一个 `commandcode` 槽位都没有，也会回退扫描（例如只有 `commandcode_2` 时照样能取到）。
- 想钉死某个账号、只要一张卡：按钮上写 `apiKeyPath`（则不再自动展开）；
  `apiKey` / `apiKeyEnv` 同理。

也可以用 `apiKeyPath` 手写多个按钮，效果和自动展开一样（同一个 `id` 重复也安全，
卡片按位置而不是 `id` 区分）：

```json
{
  "buttons": [
    {
      "type": "usage",
      "id": "cc-main",
      "label": "CommandCode · main",
      "provider": "commandcode",
      "apiKeyPath": "~/.pi/agent/auth.json#commandcode.key"
    },
    {
      "type": "usage",
      "id": "cc-second",
      "label": "CommandCode · second",
      "provider": "commandcode",
      "apiKeyPath": "~/.pi/agent/auth.json#commandcode_1.key"
    }
  ]
}
```

展开的卡片最底部有一行操作按钮：**设置为默认** 与 **设置**。

- 「设置为默认」把这个账号的 key（以及 `account` 名）写进 `auth.json["commandcode"]`，
  也就是 pi 以默认 provider 认证时读的那条记录 —— 点一下就能切换当前账号。
- 已经是当前默认（key 与 `auth.json[commandcode]` 相同）的卡片显示 **当前账号 · <account>**
  并置灰，不会再触发写入；切换后同一 workspace 的所有卡片会重新读取用量与状态。
- 被顶掉的旧默认账号如果没存在别处，会被存到第一个空闲的 `commandcode_<n>` 槽位，
  所以来回切换不会丢账号；写文件用临时文件 + rename，权限保持 `0600`。
- 写入的是 pi 的凭证文件，已经开着的 pi 会话可能仍持有旧凭证（新会话一定生效）；
  切换后卡片会自动重新展开，不需要重新加载插件。
- 账号列表来自 auth 文件，新增/删除账号后要在面板里点一下「重新加载」
  （或 `paseo plugin reload`）才会多出/收起卡片。

## 代码结构（Paseo 0.8 runtime entries）

```
paseo-plugin.json      清单：插件 id + requirements.paseo (>=0.8.0)
index.client.tsx       client 入口：枚举 workspace、逐个注册顶栏按钮，兼注册面板与 Command Center 项
index.server.ts        server 入口：注册 RPC handler、卸载时停止脚本任务
client/header.tsx      顶栏按钮：菜单组装 + 带运行小圆点的图标
client/status-popover.tsx  菜单里的「运行状态…」popover
client/run-store.ts    运行状态 store（顶栏/面板共用，单一轮询）
client/refresh-bus.ts  让面板的「重新加载」也能刷新顶栏菜单
client/format.ts       耗时格式化
client/commands.tsx    Commands 面板 UI
client/usage-card.tsx  用量卡片 UI
client/usage-store.ts  用量 store（面板/顶栏共用，单一刷新定时器）
server/commands.ts     daemon 侧：读配置、聚焦应用、spawn 脚本任务（仅 daemon bundle）
server/usage.ts        daemon 侧：读取 provider 用量（仅 daemon bundle）
shared/config.ts       paseo.json 的 Zod schema（两端共享）
shared/rpc.ts          RPC 契约（两端共享）
scripts/check-client-bundle.mjs  Node(V8) 侧：bundle 能注册面板/顶栏按钮
scripts/check-client-hermes.mjs  真机引擎侧：bundle 在 Hermes 里能跑（iPad 崩溃防线）
```

> Paseo 0.8 移除了旧的单入口 `index.ts`：`client/`、`server/`、`shared/` 目录即编译边界，
> client 代码不能 import `server/`（反之亦然），root 下也不允许放代码模块。
> 类型检查使用 npm 上的 `@getpaseo/plugin`（devDependency，本仓库固定在 0.8.0），
> 运行时实例由 Paseo 提供，不需要在插件里打包。
>
> `load-config` 的返回带一个 `exists` 字段：只有文件真的不存在（ENOENT）才不显示顶栏按钮；
> JSON 语法错或字段不合法时按钮仍在，菜单里显示一条提示，详情看面板。

## 移动端（Hermes）约束：client 代码不要用 `class`

Paseo 用 `globalThis.eval(bundle)` 在**客户端引擎**里执行插件 bundle：桌面是 Chromium（V8），
iPad / iPhone 是 React Native 的 **Hermes**。Hermes 有个会让本插件在 iPad 上必崩的行为：

> 在一个足够大的 eval 函数里，Hermes 会把**每一个 `class` 静默编译成 `undefined`**（不报错），
> 于是 `var store = new RunStore()` 直接抛
> `TypeError: Cannot read property 'prototype' of undefined`。
> 同一个 bundle 在 Node / Chrome / Electron（V8、JSC）里完全正常，所以这是**只在 iPad 上出现**的错。
> 函数、闭包、对象字面量不受影响（实测往 bundle 里再塞 1 万个顶层声明也照跑）。

因此 `client/` 与 `shared/` 里的代码（以及它们能 import 到的东西）**不要出现 `class`**：
`client/run-store.ts`、`client/usage-store.ts` 已经改成工厂函数 + 闭包，不要再改回 `class`。

两道检查兜住这个坑：

```bash
npm run check:client         # V8：bundle 能 eval、能注册面板与顶栏按钮
npm run check:client:hermes  # Hermes（真机引擎）：bundle 能 eval、contribute() 成功、按钮注册
npm run diagnose             # 上面两个 + 连 daemon 的 RPC smoke
```

`check:client:hermes` 用 `node_modules/react-native` 自带的 Hermes 二进制跑真正的
`eval(bundle)` 流程（含 daemon 的 esbuild 参数、`async-await` 降级、Hermes eager interop 包装），
是唯一能在 PC 上提前发现 iPad 崩溃的检查；没有该二进制时会自动跳过。

> 上游建议（可选）：daemon 侧 `plugins/compiler.js` 若把 client bundle 的 `class` 也降级掉
> （或改成 `new Function`/单独模块作用域执行），所有插件都能绕开这个 Hermes 缺陷；
> 在这之前，插件作者只能在 client 代码里避开 `class`。
