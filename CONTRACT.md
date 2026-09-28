# Token contract (v1)

herdr-agent-activity publishes activity as herdr metadata tokens with source
`resilient-software.agent-activity`. Any herdr client (sidebar layouts, Stream
Deck plugins, dashboards) can read them from `pane.list` / `pane.get`
(`tokens` on each pane) and `workspace.list` / `workspace.get` (`tokens` on
each workspace). Changes arrive as `pane.updated` events.

The same keys appear on panes (one agent session) and on workspaces (the sum
over the workspace's panes).

| Key | Value | Meaning |
|---|---|---|
| `rsact_v` | `"1"` | Contract version. Absent when there is no activity. |
| `rsact_state` | `subagents` \| `background` \| `scheduled` | Dominant activity, in that priority order. |
| `rsact_subagents` | integer string | Subagents still running (background or foreground). |
| `rsact_background` | integer string | Background shell tasks, excluding monitors. |
| `rsact_monitors` | integer string | Monitor watches. |
| `rsact_next_at` | ISO 8601 UTC | Next scheduled wake-up (session cron or `ScheduleWakeup`). |
| `rsact_loop` | `"1"` | The schedule recurs (a loop or recurring cron). |
| `rsact_summary` | text, ≤ 80 chars | Human summary, e.g. `2 subagents · 1 bg · loop 14:30`. Display only; do not parse. |

Absent keys mean zero / none. When a session has no activity every key is
cleared, so consumers must treat missing tokens as "no activity".

## Rules for consumers

- **Fail open.** If `rsact_v` is missing or not a version you understand,
  ignore every `rsact_*` key and render as if the plugin were not installed.
- **Herdr's own state wins.** `agent_status` (`working`, `blocked`, `done`,
  `idle`) is authoritative. Activity refines it, e.g. an `idle` agent whose
  `rsact_state` is `background` is waiting on background work rather than
  finished. Never let activity hide `blocked`.
- **Tokens expire.** Pane and workspace tokens carry a TTL (6 hours,
  refreshed while active) so a crashed agent cannot leave stale activity
  behind indefinitely.
- **Countdowns are yours.** `rsact_next_at` is absolute; compute "in 4m"
  locally rather than expecting the summary to tick.

Additive changes (new keys, new `rsact_state` values) keep `rsact_v = "1"`;
consumers should treat unknown `rsact_state` values like `background`.
Incompatible changes bump `rsact_v`.
