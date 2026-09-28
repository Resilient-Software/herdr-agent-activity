# herdr-agent-activity

See what your coding agents are still doing after they stop talking.

[Herdr](https://herdr.dev) tells you whether an agent is `working`, `blocked`,
or `idle`. It cannot tell you that an "idle" Claude Code session is really
waiting on two background subagents, tailing a build with a monitor, or will
wake itself up at 14:30 to check CI again. This plugin can.

```
 spaces                 agents
 ● gram                 ● gram
   main ↓2                claude
   2 subagents · 1 bg     2 subagents · 1 bg
 ○ reflow               ○ reflow
   loop 14:30             codex
                          loop 14:30
```

It tracks, per agent session:

- **Subagents** still running, including background (`run_in_background`) agents
- **Background shells** started with `run_in_background`
- **Monitors** watching a stream or log
- **Scheduled checks**: session crons (`CronCreate`, `/loop`) and dynamic
  `ScheduleWakeup` loops, with the next fire time

and shows them in Herdr's sidebar on both **agent rows** and **space rows**
(summed per workspace), colour-coded: yellow for subagents, blue for
background work and monitors, mauve for scheduled checks.

Everything is also published as plain Herdr metadata tokens (see
[CONTRACT.md](CONTRACT.md)), so other tools can build on it. The
[Herdr Deck](https://github.com/Resilient-Software/herdr-opendeck) Stream Deck
plugin uses them to light up its keys; it works with or without this plugin
installed.

## Install

Requires Herdr 0.9.0+ and Node.js 20+ on macOS or Linux.

```sh
herdr plugin install Resilient-Software/herdr-agent-activity
herdr plugin action invoke resilient-software.agent-activity.install
```

The install action:

1. adds hooks to every Claude Code config home (`~/.claude`, `~/.claude-N`,
   `$CLAUDE_CONFIG_DIR`) and Codex home (`~/.codex`, `~/.codex-N`,
   `$CODEX_HOME`) it finds, next to your existing hooks;
2. appends a clearly marked sidebar layout block to Herdr's `config.toml`
   (validated with `herdr config check` first) and reloads the config;
3. starts a small publisher that sums activity per workspace and keeps
   schedule times current.

Restart running agents afterwards so they pick up the hooks. Codex asks you to
review new hooks once per account on its next launch.

Every file it edits is backed up once as `<file>.bak-agent-activity`.

### Check it

```sh
herdr plugin action invoke resilient-software.agent-activity.doctor
herdr plugin pane open --plugin resilient-software.agent-activity --entrypoint doctor
```

`doctor` lists each agent home and its hook count, the sidebar status, the
publisher, the panes with activity, and the last lines of the plugin log
(`activity.log` in the plugin's state directory).

### Uninstall

```sh
herdr plugin action invoke resilient-software.agent-activity.uninstall
herdr plugin uninstall resilient-software.agent-activity
```

Run the uninstall action first: Herdr plugins have no uninstall hook, so the
action is what removes the agent hooks, the sidebar block, and the published
tokens. If you forget, the leftover hooks are harmless; they exit immediately
once the plugin's files are gone.

## Configuration

Optional `config.json` in the plugin's config directory
(`herdr plugin config-dir resilient-software.agent-activity`):

```json
{
  "claude": ["/Users/me/.claude", "/Users/me/.claude-work"],
  "codex": ["/Users/me/.codex"],
  "sidebar": true
}
```

`claude` / `codex` replace auto-discovery; `sidebar: false` skips the layout
block. Re-run the install action after changing it.

### Your own sidebar layout

If `config.toml` already defines `[ui.sidebar]` rows, the plugin leaves your
layout alone. Add the token yourself wherever you like:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent"],
  [{ token = "$rsact_summary", fg = "#89b4fa", rules = [
    { contains = "subagent", fg = "#f9e2af" },
    { starts_with = "loop", fg = "#cba6f7" },
    { starts_with = "next", fg = "#cba6f7" },
  ] }],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$rsact_summary" }],
]
```

## How it works

Claude Code hooks (`PostToolUse` for background-capable tools, `SubagentStart`,
`SubagentStop`, `Stop`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`) feed
a small reducer per session. `Stop` and `SubagentStop` carry Claude Code's own
snapshot of running background tasks and session crons, which the reducer
treats as authoritative, so missed events self-correct at the end of every
turn. Task-completion notifications end tasks between turns.

Hooks run asynchronously and only for relevant tools, so they add no latency
to your agent. State lives in the plugin's state directory, one small JSON
file per active session.

Codex exposes fewer hooks: subagents are tracked; background shells and
schedules are not visible to Codex hooks today.

The publisher (started by the plugin's startup hook) listens to Herdr events,
clears activity when an agent leaves its pane, advances cron times, and writes
the per-workspace sum used by space rows.

## Development

```sh
npm test
herdr plugin link "$PWD"
herdr plugin action invoke resilient-software.agent-activity.install
tail -f "$(herdr plugin config-dir resilient-software.agent-activity | sed 's#/config/#/state/#')/activity.log"
```

## License

MIT © Resilient Software
