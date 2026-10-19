# NekoCode 原生插件 API v1

原生插件使用 `nekocode.plugin.json` 清单和 `@nekocode/plugin-api` SDK。插件作者只依赖 NekoCode 的公开接口；工具、命令和事件由宿主接入当前会话。已有 PI 插件继续兼容，PI 目录展示的仍然是 PI 社区插件。

## 安装和实测

1. 在设置 → 插件 → 手动安装，输入本地插件目录的绝对路径，或相对于当前项目的 `./路径`。目录内必须包含清单和入口文件。
2. 选择用户或项目范围并安装。安装只复制文件，默认不执行插件代码。
3. 在「已安装」中启用插件。项目插件还需要项目已有的信任决定。
4. 修改已安装目录中的代码后，点击该插件的「重新加载」。禁用、移除、重新加载或结束会话都会清理对应激活实例。

可直接安装仓库中的 `resources/plugin-examples/hello-world`。启用后输入 `/hello-world.hello 小猫`，应收到问候通知；让智能体调用 `neko_hello_world__greet`，参数 `{"name":"小猫"}`，应返回带当前项目路径的问候。

默认用户目录是 `~/.nekocode/agent/plugins/<id>/`；项目目录是 `<项目>/.nekocode/plugins/<id>/`。配置了自定义 agentDir 时，用户插件跟随该目录。也可以手动放入目录，再重新进入插件设置并启用。直接放入目录同样默认关闭。

插件是用户授权的本地 Node.js 代码，具备宿主进程的系统访问能力，v1 不提供进程隔离或权限沙箱。禁用的插件不会被导入；未获信任的项目插件不会执行。生命周期和资源按会话管理，同一个用户插件可以在多个会话中分别激活，插件应避免共享不可重入的全局可变状态。

## 清单

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "dist/index.mjs",
  "description": "提供项目专用工具"
}
```

`id` 为 1–32 位小写字母、数字、连字符，首位必须是字母；同一会话不能同时启用两个同 ID 的原生插件。`apiVersion` 必须为数字 `1`。`main` 必须指向插件目录内的 `.js`、`.mjs` 或 `.cjs` 文件，不能越界或经符号链接指向外部文件。未支持的 API 版本、无效清单和加载错误会显示在设置页。

## SDK 和入口

SDK 源码位于 `packages/plugin-api`，可通过本地路径依赖安装，不依赖发布到 npm：

```sh
npm install --save-dev /绝对路径/NekoCodeDesktop/packages/plugin-api
```

TypeScript 插件可以这样定义入口：

```ts
import { definePlugin } from "@nekocode/plugin-api";

export default definePlugin({
  activate(api) {
    api.registerTool<{ name: string }>({
      name: "greet",
      description: "Greet someone",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
        additionalProperties: false,
      },
      execute(input, ctx) {
        return `Hello ${input.name}, workspace: ${ctx.cwd}`;
      },
    });
    api.registerCommand({
      name: "hello",
      description: "显示问候",
      execute(args, ctx) { ctx.notify(`Hello ${args}`); },
    });
    api.on("agent.start", (_event, ctx) => { ctx.notify("开始处理请求"); });
  },
  deactivate() {
    // 清理插件自行创建的定时器、连接和文件监听器。
  },
});
```

入口必须默认导出带 `activate(api)` 方法的对象。普通 JavaScript 可以直接导出该对象，无需运行时导入 SDK。TypeScript 和第三方依赖应预先打包为入口文件，例如：

```sh
npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs
```

宿主不会安装依赖或编译 TypeScript。重新加载会重新导入入口；建议打包依赖，避免子模块缓存影响开发时的重载。

## API

| API | 说明 |
| --- | --- |
| `api.apiVersion` | 当前接口版本，固定为 `1` |
| `api.plugin` | 只读清单信息 |
| `api.signal` | 当前激活实例的取消信号，卸载或激活失败时中止 |
| `api.registerTool(tool)` | 在 `activate()` 中注册工具，返回完整工具名 |
| `api.registerCommand(command)` | 在 `activate()` 中注册命令，返回不带 `/` 的完整命令名 |
| `api.on(event, handler)` | 订阅事件，返回可调用 `dispose()` 的订阅对象 |

工具和命令的本地名称为 1–24 位小写字母、数字、下划线，首位为字母。工具名为 `neko_<id 中连字符替换成下划线>__<name>`，命令为 `/<id>.<name>`。命名空间避免普通插件之间及与内置命令重名。

工具 `inputSchema` 是根类型为 `object` 的 JSON Schema。宿主会验证模型提交的参数。`execute(input, ctx)` 可以返回字符串，或 `{ content: [{ type: "text", text: "..." }], details: ... }`；执行失败请抛出异常。v1 只承诺文本工具输出。

命令 `execute(args, ctx)` 接收命令后面的参数字符串，通过 `ctx.notify()` 显示结果；命令处理器的返回值不作为聊天回答。

所有回调的上下文包含 `cwd`、`sessionId`、`signal` 和 `notify(message, level?)`。通知级别支持 `info`、`warning`、`error`；无界面会话中通知不显示。长任务应遵循 `ctx.signal` 并及时取消。

## 生命周期

| 事件 | 数据 |
| --- | --- |
| `session.start` | `{ reason }`，原因是 `startup/reload/new/resume/fork` |
| `session.stop` | `{ reason }`，原因是 `quit/reload/new/resume/fork` |
| `agent.start` | `{}`，一次智能体运行开始 |
| `agent.stop` | `{}`，一次智能体运行结束 |
| `tool.start` | `{ toolName, toolCallId, input }` |
| `tool.end` | `{ toolName, toolCallId, result, isError }` |

事件属于当前会话，v1 是通知接口，返回值不会拦截或改写模型请求、工具参数及工具结果。订阅对象可以单独释放，插件卸载时宿主会释放剩余订阅并调用一次 `deactivate()`。插件关闭后，遗留的工具和命令引用也会拒绝执行。

激活（包括入口导入）最长 10 秒，普通生命周期回调最长 10 秒；停止事件和 `deactivate()` 各限 1 秒。超时会报告错误，插件仍应使用取消信号主动结束自己的异步工作。激活失败不会提交已经暂存的工具、命令或事件订阅。

此版本暂不开放界面面板、模型提供商、任意 IPC 或全局 `window.nekocode` 桥。后续 API 应继续通过 SDK 和版本化清单扩展。
