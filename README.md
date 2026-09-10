# paseo-topbar-command

一个 Paseo 插件：为项目提供一个「命令面板」，从项目根目录的 `paseo.json` 读取按钮配置，
每个按钮对应一种能力：

1. **打开 / 切换应用**（如 Godot）：已启动则切换到它，未启动则启动。
2. **执行脚本**：运行任意 shell 命令，实时显示执行状态（运行中 / 成功 / 失败、退出码、输出末尾、耗时），可中途停止。

## 关于「topbar」

Paseo **0.7（当前安装版本）** 的插件 API **没有**顶栏按钮的贡献点
（该能力在 Paseo 插件路线图上，v0.8 才加入 header buttons）。
本插件使用 API 支持的最接近方案：一个 **workspace 面板**，它会出现在 workspace 头部
标签栏（与 Agents / Terminal / Files 并列），并且是**按项目**的 —— 正好匹配按项目的 `paseo.json` 配置。
另外注册了一个 Command Center 项（⌘K 搜索 “Open project commands”）快速打开。

### Header buttons（需要 Paseo 0.8）

v0.8 的 `client.addHeaderButton({ id, workspaceId, button })` 可以把按钮放到 workspace
头部右侧，并支持 `action` / `menu` / `popover` 三种行为（dropdown 里可以放执行状态）。
但 v0.8 使用**全新的运行时入口**（`index.client.tsx` + `index.server.ts` + `client/` `server/` `shared/`
目录，并要求 `paseo-plugin.json` 里声明 `requirements.paseo >= 0.8.0`），与当前 0.7 的单入口
`index.ts` **不兼容**（迁移文档明确说 “Do not keep a compatibility entry”）。

本机当前是 **Paseo 0.7.0**（`paseo --version`），因此本插件仍使用 0.7 的单入口写法。
等升级到 0.8 beta 后，再按官方 Migration 文档迁移并加 header buttons。

## 显示位置（plugin.config.json）

面板显示在哪些位置由插件目录下的 `plugin.config.json` 控制（不是每个项目的 `paseo.json`）：

```json
{
  "locations": ["workspace", "explorer"]
}
```

| 可选值 | 位置 |
| --- | --- |
| `workspace` | workspace 头部标签栏（与 Agents / Terminal / Files 并列） |
| `explorer` | explorer 区域 |

可以只选 1 个，也可以两个都选（默认两个）。改完需要重新加载插件（会重新编译）：

```bash
paseo plugin reload paseo-topbar-command
```

合法性规则：重复项会去重、顺序按 `workspace, explorer` 归一；非法值会被忽略并打 warning；
空数组或全部非法会回退为两个位置（因为注册到任何位置都达不到的面板无法打开）。

> 为何是插件级而不是项目级：Paseo 0.7 的面板位置在**插件加载时一次性注册**
> （`addWorkspacePanel` 是静态 collector，见 `PluginWorkspacePanelContribution.locations`），
> 组件也拿不到自己渲染在哪个 location，所以无法按项目动态切换。项目级仍然只有
> `paseo.json` 里的 `buttons`。

## 详情下拉

每个按钮卡片右侧都有一个 `▸ / ▾` 下拉按钮，与「执行按钮」相互独立：

- 收起时：只显示一行状态（✓/✕、耗时、最近输出）。
- 展开时：显示完整「执行状态」（状态、退出码/耗时、应用或命令、工作目录、项目路径、附加参数）
  以及脚本的完整输出末尾（可选中复制，运行中实时刷新）。
- 展开状态下脚本仍可直接点「停止」。

## 安装

```bash
npm run typecheck
paseo plugin install /绝对路径/paseo-topbar-command
paseo plugin ls          # 应显示 running
```

需要先在 **Settings → Plugins** 开启 **Enable plugins**（即 daemon `config.json` 的 `pluginsEnabled`）。
改代码后重载：

```bash
npm run typecheck
paseo plugin reload paseo-topbar-command
```

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
      "bundleId": "org.godotengine.Godot",
      "projectPath": "."
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
| `projectPath` | 否 | 要打开的项目路径。配置后启动时带上（Godot 为 `--path <解析后路径>`）。相对路径相对项目根目录解析：`.` 即项目根本身，`game` 即 `<项目根>/game` |
| `args` | 否 | 附加启动参数，追加在 `projectPath` 之后。例如 `["--editor"]`、`["--headless", "-e"]` |

macOS 下 `open -a/-b` 的语义正是「打开，若已打开则切换到它」。Linux 为尽力而为：
优先 `wmctrl -a` 聚焦，失败则 `gtk-launch` / `xdg-open` 启动。

配置 `projectPath` 后行为略有不同：因为已运行的实例会忽略 `--args`，macOS 上会加 `-n`
强制新实例，保证按指定项目打开（可同时开多个项目窗口）。未配置时保持原有的「打开/切换」语义。

最简用法（当前仓库本身就是 Godot 项目）：

```json
{
  "buttons": [
    {
      "type": "app",
      "id": "godot",
      "label": "Godot",
      "app": "Godot",
      "bundleId": "org.godotengine.Godot",
      "projectPath": "."
    }
  ]
}
```

### Godot 常用按钮（通过 `args` 组合）

`projectPath` 会转成 `--path <项目>`。Godot 的 `--path` **默认是运行项目**（跑场景），
要打开编辑器需要额外加 `--editor`（`-e`）。用 `args` 可以自由组合出几种常用按钮：

| 功能 | 关键配置 | 最终传给 Godot 的参数 |
| --- | --- | --- |
| 打开编辑器 | `projectPath: "godot"`, `args: ["--editor"]` | `--path <项目> --editor` |
| 运行项目 | `projectPath: "godot"` | `--path <项目>` |
| 项目管理器 | 不配 `projectPath`，`args: ["--project-manager"]` | `--project-manager` |
| 导入资源并退出 | `projectPath: "godot"`, `args: ["--import"]` | `--path <项目> --import` |

完整示例（运行 + 编辑器两个按钮）：

```json
{
  "buttons": [
    {
      "type": "app",
      "id": "godot",
      "label": "Godot 运行",
      "app": "Godot",
      "bundleId": "org.godotengine.Godot",
      "projectPath": "godot"
    },
    {
      "type": "app",
      "id": "godot-editor",
      "label": "Godot 编辑器",
      "app": "Godot",
      "bundleId": "org.godotengine.Godot",
      "projectPath": "godot",
      "args": ["--editor"]
    }
  ]
}
```

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
运行中可点「停止」。停止会终止**整个进程组**（不只是 shell），所以脚本里再启动的子进程
（例如 Godot 游戏、webpack dev server）也会一起被关掉。

## 代码结构（Paseo 0.7 单入口风格）

```
index.ts            入口：注册 workspace 面板、Command Center 项、RPC handler
commands.client.tsx 客户端面板 UI（仅 App bundle）
commands.server.ts  daemon 侧：读配置、聚焦应用、spawn 脚本任务
config.shared.ts    paseo.json 的 Zod schema（两端共享）
rpc.shared.ts       RPC 契约（两端共享）
```

> 注意：`index.ts` 是客户端与 daemon 两份 bundle 的公共入口。Paseo 编译器会在客户端 bundle
> 中剔除 `plugin.handle(...)` 以及对 `*.server` 的 import（反之在 daemon bundle 中剔除 UI 注册）。
> 因此 index.ts 里的清理函数对 `stopAllScripts` 做了 `typeof` 保护，保证客户端 bundle 中为安全的 no-op。
