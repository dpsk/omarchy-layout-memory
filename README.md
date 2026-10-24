# Layout Memory

An [Omarchy](https://omarchy.org) plugin that remembers the last keyboard layout
you used in each application and restores it when you switch windows.

Chat in Russian in Telegram, write code in English in the terminal: switch
layouts once per app, and Layout Memory switches back for you every time you
change windows. The memory is kept per application (window class) and saved to
disk, so it survives closing windows, restarting the shell and rebooting.

## How it differs from per-window switchers

Existing Hyprland tools remember a layout per window and forget it once the
window closes. Layout Memory:

- learns per **application**, so a new terminal window opens in English
  because your terminals were in English last time;
- **persists** what it learned across restarts;
- refers to layouts **by name** (`us`, `ru`), so reordering `kb_layout` keeps
  each app on the right language;
- can still remember **per window** for chosen apps, pin an app to a fixed
  layout, or leave an app alone;
- learns only switches you make: keyboards being plugged in, devices
  reconnecting and Hyprland config reloads are not mistaken for a choice;
- leaves fcitx5's virtual keyboard, power buttons and the video bus untouched;
- never switches when the layout is already right, and never re-applies layouts
  on a Hyprland config reload.

## Requirements

- Omarchy 4 (the plugin runs inside `omarchy-shell`)
- At least two layouts in your Hyprland input config, for example in
  `~/.config/hypr/input.lua`:

  ```lua
  kb_layout = "us,ru",
  kb_options = "grp:alts_toggle",
  ```

No other dependencies: it uses `hyprctl` and Quickshell, which Omarchy ships.

## Install

```bash
omarchy plugin add https://github.com/dpsk/omarchy-layout-memory --enable
```

Plugins run as unsandboxed code inside `omarchy-shell`; `omarchy plugin add`
shows you what it is about to install. This one is a single QML file plus a
plain JavaScript model you can read in a few minutes.

## Remove

```bash
omarchy plugin remove io.github.dpsk.layout-memory
```

The learned layouts stay in
`~/.local/state/omarchy-layout-memory/state.json`; delete that file too if you
want them gone.

## Usage

Nothing to configure. Focus an app, switch to the layout you want there, and
move on. The next time you focus that app, its layout comes back.

## Configuration

Options are optional and live inline on the plugin's entry in the `plugins`
list of `~/.config/omarchy/shell.json`, like every other Omarchy plugin. Add
the fields to the existing entry rather than replacing the file. The plugin
reads that file and picks up changes immediately; it never writes to it.

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "io.github.dpsk.layout-memory",
      "default": "keep",
      "rules": {
        "com.mitchellh.ghostty": "us",
        "org.telegram.desktop": { "mode": "window" },
        "steam_app_*": "ignore"
      },
      "pauseLayers": ["omarchy-menu", "omarchy-keyboard-panel", "walker"],
      "layerLayouts": { "omarchy-menu": "us" },
      "focusDelayMs": 80,
      "debug": false
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `default` | `"keep"` | Layout for apps with no memory yet. `"keep"` leaves the current layout alone; a layout name such as `"us"` switches to it. |
| `rules` | `{}` | Per-class overrides, see below. |
| `pauseLayers` | Omarchy menu, keyboard panel, emoji picker, clipboard and image selector; walker, wofi, rofi, fuzzel, anyrun, tofi | Layer-shell namespaces (launchers, pickers) during which switches are not learned. When one closes, the focused window gets its remembered layout back (if it has one, or `default` is set). Setting this replaces the default list. |
| `layerLayouts` | `{}` | Layout to switch to while a layer-shell namespace is open, e.g. `{ "omarchy-menu": "us" }` to always type in the Omarchy menu in English. That covers Super+Space, the other `omarchy-menu` menus, and the `omarchy-menu` prompts scripts use (such as a Wi-Fi password). These layers also pause learning. When the layer closes, the focused window gets its layout as usual (rule, memory, or `default`); if that leaves nothing to restore, it goes back to the layout from before the layer opened. To find a launcher's namespace, run `sleep 3; hyprctl layers` and open the launcher. |
| `focusDelayMs` | `80` | How long focus must settle before restoring. Fast Alt+Tab sweeps resolve once instead of flipping layouts for every window passed. Range 0–1000. |
| `debug` | `false` | Log every decision to the journal. |

### Rules

Keys are Hyprland window classes (`hyprctl clients` lists them). Exact matches
win, then case-insensitive matches, then `*`/`?` globs (case-insensitive) in
the order written.

| Value | Effect |
|---|---|
| `"us"` | Always use this layout in the app; switches there are not learned. Same as `{ "layout": "us" }`. |
| `{ "mode": "window" }` | Remember per window. A new window starts from the app's last layout. Window memory lasts until the window closes. |
| `"ignore"` | Never switch or learn in this app. Same as `{ "mode": "ignore" }`. |
| `{ "mode": "app" }` | The default behaviour, useful to exempt a class from a broader glob. |

Layout names are the entries of `kb_layout`, with the variant in parentheses
when one is set: `kb_layout = "us,ru"` with `kb_variant = "dvorak,"` gives
`us(dvorak)` and `ru`. A name without a variant also matches the same layout
with one.

## How it works

The plugin is an Omarchy shell `service`. It listens to Hyprland's event
stream (`activewindow`, `activelayout`, `openlayer`, ...). When the layout
is changed on a keyboard it already knew, and the change did not come from the
plugin itself, it re-reads `hyprctl devices` and records the new layout for the
focused app. Learned layouts are written to disk half a second later. When focus
settles on another app, it runs `hyprctl switchxkblayout` for each real
keyboard that is not already on the remembered layout.

All decisions live in `LayoutMemoryModel.js`, a pure reducer with no Qt
dependency, covered by `node --test`. `Service.qml` only feeds events in and
runs the effects that come out.

## Troubleshooting

- **Watch the log:** `journalctl --user -t omarchy-shell -f | grep layout-memory`.
  Set `"debug": true` to see every decision.
- **Is it running?** `omarchy plugin list` should show it enabled, and
  `~/.config/omarchy/shell.json` should contain its entry in `plugins`.
- **An app is not remembered:** check its class with `hyprctl clients`; apps
  with a fixed or `ignore` rule are never learned.
- **A switch was not remembered:** switches made within a second of a Hyprland
  config reload, or right after the plugin itself switched, are not learned.
  A keyboard that disconnects and reconnects within a few seconds can, rarely,
  be taken for a switch; switch once more in that app to correct it.
- **Several keyboards:** on restore, every typed keyboard (including mice and
  headsets that report as keyboards) is set to the same layout, so two physical
  keyboards cannot hold different layouts at the same time.

## Development

```bash
make test       # unit tests (node, no dependencies)
make lint       # node --check and qmllint
make validate   # omarchy-plugin-validate
make dev        # copy the working tree over the installed plugin
```

The shell reloads the plugin when its files change. Shell logs:
`journalctl --user -t omarchy-shell -f`.

## Credits

Keyboard filtering and selection are adapted from Omarchy's keyboard layout bar
widget (MIT).

## License

[MIT](LICENSE)
