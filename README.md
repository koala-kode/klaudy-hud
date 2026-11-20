# klaudy-hud

A sidebar HUD pane for Claude Code. It shows:

- **CONTEXT**: model, token usage and the 5-hour / weekly usage limits (as text until a limit passes 70%, then as a bar), with a small status bot beside them
- **SUBAGENTS** and **ACTIVITY**: live agent and tool-call status
- **FILES TOUCHED** and **MCP**: edited files and loaded MCP tools, with running/finished markers
- **BTW**: a side-question box; answers arrive without interrupting the main agent

The status bot reacts to the session: eyes darting while working, `^ ^` when a turn finishes, `x x` on an error, dimmed when idle for a while.

## Install

At the prompt of a terminal session:

```
/plugin install klaudy-hud --marketplace koala-kode/klaudy-hud
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install klaudy-hud --marketplace koala-kode/klaudy-hud
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koala-kode/klaudy-hud`, then Add plugin.

## Update

```
/plugin marketplace update koala-kode
/plugin update klaudy-hud
```

## Commands

- `/hud` — show or hide the pane
- `/qq <question>` — ask a side question in the BTW box

Card headings fold on click. Folded cards show count summaries.
