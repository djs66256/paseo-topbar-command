# paseo-topbar-command

一个 Paseo 插件：为项目提供一个「命令面板」，从项目根目录的 `paseo.json` 读取按钮配置，
每个按钮对应一种能力：

1. **打开 / 切换应用**（如 Godot）：已启动则切换到它，未启动则启动。
2. **执行脚本**：运行任意 shell 命令，实时显示执行状态（运行中 / 成功 / 失败、退出码、输出末尾、耗时），可中途停止。

## 关于「topbar」

Paseo **0.6.1（当前安装版本）** 的插件 API **没有**顶栏按钮的贡献点
（该能力在 Paseo 插件路线图上，v0.8 才加入 header buttons）。
本插件使用 API 支持的最接近方案：一个 **workspace 面板**，它会出现在 workspace 头部
标签栏（与 Agents / Terminal / Files 并列），并且是**按项目**的 —— 正好匹配按项目的 `paseo.json` 配置。
另外注册了一个 Command Center 项（⌘K 搜索 “Open project commands”）快速打开。

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
运行中可点「停止」。

## 代码结构（Paseo 0.6.1 单入口风格）

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
