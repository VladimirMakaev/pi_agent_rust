# Extensions Template

This file documents how to add extensions to this package.

## Extension Structure

Extensions are TypeScript modules that extend pi's behavior.

```
pi-extensions/
├── my-extension.ts       # Single-file extension
└── another-extension/    # Multi-file extension
    ├── index.ts          # Entry point
    ├── package.json      # Dependencies
    └── utils.ts
```

## Basic Extension Template

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // React to events
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  // Register a custom tool
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does",
    parameters: Type.Object({
      message: Type.String({ description: "Message to display" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.message}!` }],
        details: {},
      };
    },
  });

  // Register a command
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

## Common Events

| Event | Description |
|-------|-------------|
| `session_start` | Fired when pi starts |
| `session_shutdown` | Fired on exit |
| `tool_call` | Before tool executes (can block) |
| `tool_result` | After tool executes (can modify) |
| `agent_start` | Before agent processes prompt |
| `agent_end` | After agent finishes |
| `turn_start` | Before each LLM turn |
| `turn_end` | After each LLM turn |

## Extension Locations

Extensions are auto-discovered from:
- `pi-extensions/*.ts` - Single-file extensions
- `pi-extensions/*/index.ts` - Directory-based extensions

## Testing

```bash
pi -e ./pi-extensions/my-extension.ts
```

## Documentation

See [pi extensions documentation](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/extensions.md) for full API reference.
