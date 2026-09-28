# fixel-mcp

Launcher package for [Fixel](https://github.com/AKollu72/fixel)'s Model Context Protocol server.

Installs the `fixel-mcp` binary so AI coding agents can run Fixel's verification
tools directly without installing the full `fixel` CLI.

## Add to Claude Code

```sh
claude mcp add fixel -- npx fixel-mcp
```

## Add to any MCP host (Cursor, Windsurf, etc.)

```json
{
  "mcpServers": {
    "fixel": {
      "command": "npx",
      "args": ["fixel-mcp"]
    }
  }
}
```

## Tools exposed

| Tool | What it does |
|------|-------------|
| `fixel_scan(path)` | Audit React files for prohibited design patterns |
| `fixel_verify(component?, node?)` | Drift detection against the stored Figma spec |
| `fixel_annotate(component, node)` | Post findings to the Figma frame |

## How it works

This package is a one-line launcher. It depends on `fixel` and calls its MCP
server entry point directly — no subprocess, no stdio wrapping. JSON-RPC over
stdin/stdout starts immediately.

See [fixel](https://github.com/AKollu72/fixel) for full documentation.
