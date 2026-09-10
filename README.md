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
paseo plugin install /绝对路径/paseo-topbar-command
paseo plugin ls          # 应显示 running
```

需要先在 **Settings → Plugins** 开启 **Enable plugins**（即 daemon `config.json` 的 `pluginsEnabled`）。
改代码后重载：

```bash
pnpm typecheck
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
      "id": "godot",
      "label": "Godot",
      "app": "Godot",
      "bundleId": "org.godotengine.Godot"
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

macOS 下 `open -a/-b` 的语义正是「打开，若已打开则切换到它」。Linux 为尽力而为：
优先 `wmctrl -a` 聚焦，失败则 `gtk-launch` / `xdg-open` 启动。

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
server/commands.ts     daemon 侧：读配置、聚焦应用、spawn 脚本任务（仅 daemon bundle）
shared/config.ts       paseo.json 的 Zod schema（两端共享）
shared/rpc.ts          RPC 契约（两端共享）
```

> Paseo 0.8 移除了旧的单入口 `index.ts`：`client/`、`server/`、`shared/` 目录即编译边界，
> client 代码不能 import `server/`（反之亦然），root 下也不允许放代码模块。
> 类型检查使用 npm 上的 `@getpaseo/plugin`（devDependency，本仓库固定在 0.8.0），
> 运行时实例由 Paseo 提供，不需要在插件里打包。
>
> `load-config` 的返回带一个 `exists` 字段：只有文件真的不存在（ENOENT）才不显示顶栏按钮；
> JSON 语法错或字段不合法时按钮仍在，菜单里显示一条提示，详情看面板。
