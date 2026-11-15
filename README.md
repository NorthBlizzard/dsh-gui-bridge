# dsh-gui-bridge

Agent tools that perform DeepSeek Harness GUI operations on the agent's behalf. Every tool calls the
same Host service the browser calls, so anything created or changed is persisted and rendered by the GUI.

## Tools

| Tool | Actions |
| --- | --- |
| `dsh_gui_session` | `list`, `create`, `state`, `rename`, `fork`, `archive`, `unarchive`, `pin`, `unpin`, `prompt`, `cancel` |
| `dsh_gui_workspace` | `list`, `create`, `rename`, `delete`, `reorder`, `move_session` |
| `dsh_gui_mode` | `list`, `set` |
| `dsh_gui_settings` | `describe`, `update`, `replace`, `mutate` |
| `dsh_gui_market` | `catalog`, `indexes`, `add_source`, `search`, `detail`, `installed`, `enable`, `disable` |

`session_id` defaults to the calling session. `dsh_gui_settings` lists namespace keys in `describe`
and returns one namespace's schema and values when `namespace` is given. `dsh_gui_market` `catalog`
lists the bundles this installation offers, including official ones not installed yet, with the
`install_spec` to hand to `plugin_manager`; `indexes`, `search`, and `detail` cover remote market
indexes configured under Settings > Plugins.

## Install

Add this repository's index as a market source:

1. Open **Plugins**, enable the experimental **Custom plugin indexes** bundle.
2. Open **Discover** → **Add index source** and paste
   `https://raw.githubusercontent.com/NorthBlizzard/dsh-gui-bridge/main/market/index.json`
3. Choose `GUI bridge`, confirm the source, and install.

Or install the repository directly:

```sh
dsh plugin --profile desktop add "git+https://github.com/NorthBlizzard/dsh-gui-bridge.git"
```

Once the plugin is running, the agent can register that index source itself:

```
dsh_gui_market  action: add_source
                index_url: https://raw.githubusercontent.com/NorthBlizzard/dsh-gui-bridge/main/market/index.json
```

Restart is not required when the profile applies changes live.

## Configuration

The plugin row accepts these keys in `cordis.patch.yml`:

| Key | Default | Effect |
| --- | --- | --- |
| `maxItems` | `50` | Row limit for list and catalog queries, capped at 200. |
| `sessionPrompt` | `true` | Allow `dsh_gui_session` `prompt` to deliver messages into a session. |
| `marketToggle` | `true` | Allow `dsh_gui_market` `enable` and `disable`. |
| `modeWidening` | `"deny"` | `"allow"` lets `dsh_gui_mode` `set` raise a session's sandbox level or drop approval prompts. |
| `language` | `"en"` | Default language for `dsh_gui_market` `detail`. |

## Boundaries

- `dsh_gui_mode` `set` narrows authority freely but refuses to widen it unless `modeWidening`
  is `"allow"`. A user can always change the mode in the composer.
- Plan mode is not bridged: its service is not reachable from a Host plugin scope in this
  deployment, so the composer's `/plan` command remains the way to toggle it.
- Installing, updating, and removing packages is not exposed here; use the approval-gated
  `plugin_manager` tool.
- `dsh_gui_settings` writes the same user layer the Settings page writes, and never returns
  secret values.
- Turning the plugin off removes the five tools and leaves changed state untouched.

## License

MIT
