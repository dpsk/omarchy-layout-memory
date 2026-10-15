# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-15

### Added

- Per-application keyboard layout memory, restored on focus change.
- Memory saved to `$XDG_STATE_HOME/omarchy-layout-memory/state.json`.
- Rules per window class: fixed layout, per-window memory, or ignore.
- Learning paused while launchers are open; layout restored when they close.
- Only switches announced by a known keyboard are learned; hotplug, config
  reloads and failed switches only resync.
- Focus debounce so fast window switching resolves once.
