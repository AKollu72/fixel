Shipped something this week: Fixel — an open-source CI guard for AI-generated React.

If you generate React from Figma with AI, Fixel locks the exact design values and fails CI when they drift.

I'm the sole frontend engineer at an AI startup. We generated 60+ components from Figma using AI and built tooling at work to catch drift. Fixel is a from-scratch open-source tool I built on nights and weekends — same problem, independent implementation.

One command to try it:

    npx fixel scan ./src

No config, no API key, no Figma account. Flags raw hex literals, bare numeric border-radius, and rgba() calls that bypass your token system. Exits 1 in CI.

For AI coding agents: `claude mcp add fixel -- npx fixel-mcp` adds three verification tools so your agent can check its own output before you review.

React-only. Claude-only for generation. Scan and verify need no AI.

🔧 https://github.com/AKollu72/fixel
