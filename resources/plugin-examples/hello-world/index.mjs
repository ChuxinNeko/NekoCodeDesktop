/** @type {import('@nekocode/plugin-api').NekoPlugin} */
export default {
  activate(api) {
    api.registerTool({
      name: "greet",
      description: "Return a greeting for a person using the Hello NekoCode example plugin.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1, description: "Person to greet" } },
        required: ["name"],
        additionalProperties: false,
      },
      execute({ name }, context) {
        if (context.signal.aborted) throw new Error("Greeting cancelled");
        return `你好，${name}！来自 ${api.plugin.name}，当前项目：${context.cwd}`;
      },
    });

    api.registerCommand({
      name: "hello",
      description: "显示来自 Hello NekoCode 插件的问候",
      execute(args, context) {
        context.notify(`你好，${args.trim() || "NekoCode"}！插件 API v${api.apiVersion}`);
      },
    });

    api.on("session.start", (event, context) => {
      context.notify(`Hello NekoCode 已就绪（${event.reason}）`);
    });
  },
};
