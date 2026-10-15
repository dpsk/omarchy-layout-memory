const test = require("node:test")
const assert = require("node:assert/strict")
const M = require("../LayoutMemoryModel.js")

const TELEGRAM = "org.telegram.desktop"
const GHOSTTY = "com.mitchellh.ghostty"

// A seat shaped like a real one: a physical keyboard, a mouse that also
// reports as a keyboard, a power button, and fcitx5's virtual keyboard holding
// the main flag.
function devices(indexes, layout = "us,ru", variant = ",") {
  const kb = (name, index, extra = {}) => ({
    name,
    layout,
    variant,
    active_layout_index: index,
    active_keymap: index === 0 ? "English (US)" : "Russian",
    main: false,
    ...extra
  })
  return {
    keyboards: [
      kb("mouse-keyboard", indexes.mouse ?? 0),
      kb("main-keyboard", indexes.main ?? 0),
      kb("power-button", 0),
      kb("hl-virtual-keyboard-fcitx5", 0, { main: true })
    ]
  }
}

// Drives the reducer like Service.qml does, keeping time explicit.
function harness(entry = {}) {
  let state = M.initialState()
  let now = 1000000
  const log = []
  const api = {
    send(event, advance = 0) {
      now += advance
      const result = M.step(state, event, now)
      state = result.state
      log.push(...result.effects)
      return result.effects
    },
    tick(ms) { now += ms },
    get state() { return state },
    effects(type) { return log.filter(e => e.type === type) },
    clear() { log.length = 0 },
    focus(cls, address) {
      api.send({ type: "activewindow", cls })
      api.send({ type: "activewindowv2", address })
      return api.send({ type: "focusTimer" }, 100)
    },
    // The user presses Alt+Alt on the physical keyboard.
    userSwitch(index) {
      api.send({ type: "activelayout", keyboard: "main-keyboard" }, 1000)
      return api.send({ type: "devices", devices: devices({ main: index, mouse: state.keyboards.find(k => k.name === "mouse-keyboard")?.index ?? 0 }) }, 30)
    }
  }
  api.send({ type: "config", config: M.parseConfig(entry).config })
  api.send({ type: "stateLoaded", apps: {} })
  api.send({ type: "devices", devices: devices({}) })
  api.clear()
  return api
}

test("parses layout names with variants", () => {
  assert.deepEqual(M.layoutNames({ layout: "us,ru", variant: "," }), ["us", "ru"])
  assert.deepEqual(M.layoutNames({ layout: "us,ru", variant: "dvorak,phonetic" }), ["us(dvorak)", "ru(phonetic)"])
  assert.deepEqual(M.layoutNames({ layout: "us" }), ["us"])
  assert.deepEqual(M.layoutNames({}), [])
})

test("finds layouts by exact name, then by base layout", () => {
  const layouts = ["us(dvorak)", "ru"]
  assert.equal(M.layoutIndex(layouts, "ru"), 1)
  assert.equal(M.layoutIndex(layouts, "us"), 0)
  assert.equal(M.layoutIndex(layouts, "de"), -1)
})

test("excludes virtual keyboards and buttons", () => {
  const typed = M.readKeyboards(devices({})).map(k => k.name)
  assert.deepEqual(typed, ["mouse-keyboard", "main-keyboard"])
})

test("normalizes addresses from events and hyprctl", () => {
  assert.equal(M.normalizeAddress("0x55D2A5"), "55d2a5")
  assert.equal(M.normalizeAddress("55d2a5"), "55d2a5")
})

test("activelayout keyboard name survives commas", () => {
  assert.equal(M.activelayoutKeyboard(["mistel-co.,ltd.-", "Russian"], ""), "mistel-co.,ltd.-")
  assert.equal(M.activelayoutKeyboard(null, "mistel-co.,ltd.-,Russian"), "mistel-co.,ltd.-")
})

test("learns the layout the user picks in an app", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
  assert.equal(h.effects("save").length, 1)
})

test("restores each app's layout on focus", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus(GHOSTTY, "b1")
  h.userSwitch(0)
  h.clear()

  const toTelegram = h.focus(TELEGRAM, "a1")
  assert.deepEqual(toTelegram.find(e => e.type === "switch"), {
    type: "switch",
    keyboards: ["mouse-keyboard", "main-keyboard"],
    index: 1
  })
  assert.equal(h.state.current, "ru")

  const toGhostty = h.focus(GHOSTTY, "b1")
  assert.equal(toGhostty.find(e => e.type === "switch").index, 0)
})

test("our own switch is not learned as a user choice", () => {
  const h = harness({ rules: { [GHOSTTY]: "us" } })
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus(GHOSTTY, "b1")
  h.clear()
  // Echoes from both keyboards, then the reading reflecting our switch.
  h.send({ type: "activelayout", keyboard: "mouse-keyboard" }, 10)
  h.send({ type: "activelayout", keyboard: "main-keyboard" }, 5)
  h.send({ type: "devices", devices: devices({ main: 0, mouse: 0 }) }, 30)
  assert.equal(h.effects("save").length, 0)
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
  assert.equal(h.state.apps[GHOSTTY], undefined)
})

test("does nothing when the layout is already right", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus("other-app", "c1")
  h.clear()
  // Still on ru from Telegram: no switch needed.
  assert.equal(h.focus(TELEGRAM, "a1").filter(e => e.type === "switch").length, 0)
})

test("unknown apps keep the current layout by default", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.clear()
  assert.equal(h.focus("new-app", "d1").filter(e => e.type === "switch").length, 0)
})

test("a default layout applies to unknown apps", () => {
  const h = harness({ default: "us" })
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.clear()
  assert.equal(h.focus("new-app", "d1").find(e => e.type === "switch").index, 0)
})

test("fixed rules win and are never learned", () => {
  const h = harness({ rules: { [GHOSTTY]: "us" } })
  h.focus(GHOSTTY, "b1")
  h.userSwitch(1)
  assert.equal(h.state.apps[GHOSTTY], undefined)
  h.focus(TELEGRAM, "a1")
  h.clear()
  assert.equal(h.focus(GHOSTTY, "b1").find(e => e.type === "switch").index, 0)
})

test("ignored apps are neither switched nor learned", () => {
  const h = harness({ default: "us", rules: { "steam_app_*": "ignore" } })
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.clear()
  assert.equal(h.focus("steam_app_123", "g1").filter(e => e.type === "switch").length, 0)
  h.userSwitch(0)
  assert.equal(h.state.apps.steam_app_123, undefined)
})

test("rapid focus changes resolve once", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus(GHOSTTY, "b1")
  h.userSwitch(0)
  h.clear()
  h.send({ type: "activewindow", cls: TELEGRAM })
  h.send({ type: "activewindowv2", address: "a1" })
  h.send({ type: "activewindow", cls: GHOSTTY }, 20)
  h.send({ type: "activewindowv2", address: "b1" })
  h.send({ type: "focusTimer" }, 80)
  assert.equal(h.effects("startFocusTimer").length, 4)
  assert.equal(h.effects("switch").length, 0)
})

test("a switch while focus is settling is not learned", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.send({ type: "activewindow", cls: GHOSTTY })
  h.send({ type: "activewindowv2", address: "b1" })
  h.send({ type: "activelayout", keyboard: "main-keyboard" }, 1000)
  h.send({ type: "devices", devices: devices({ main: 1 }) }, 10)
  assert.deepEqual(h.state.apps, {})
})

test("window mode remembers per window and falls back to the app", () => {
  const h = harness({ rules: { [TELEGRAM]: { mode: "window" } } })
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus(TELEGRAM, "a2")
  h.userSwitch(0)
  h.clear()
  assert.equal(h.focus(TELEGRAM, "a1").find(e => e.type === "switch").index, 1)
  assert.equal(h.focus(TELEGRAM, "a2").find(e => e.type === "switch").index, 0)

  h.send({ type: "closewindow", address: "a1" })
  assert.equal(h.state.windows.a1, undefined)
  // A new window starts from the app's last layout (us, learned in a2).
  h.focus(TELEGRAM, "a3")
  assert.equal(h.state.current, "us")
})

test("launchers pause learning and the window gets its layout back", () => {
  const h = harness()
  h.focus(GHOSTTY, "b1")
  h.userSwitch(0)
  h.send({ type: "openlayer", namespace: "omarchy-menu" })
  h.userSwitch(1)
  assert.equal(h.state.apps[GHOSTTY], undefined)

  h.clear()
  h.send({ type: "closelayer", namespace: "omarchy-menu" })
  assert.equal(h.effects("startFocusTimer").length, 1)
  h.send({ type: "focusTimer" }, 100)
  // Ghostty has no memory yet, so nothing to restore.
  assert.equal(h.effects("switch").length, 0)

  h.userSwitch(0)
  h.send({ type: "openlayer", namespace: "omarchy-menu" })
  h.userSwitch(1)
  h.clear()
  h.send({ type: "closelayer", namespace: "omarchy-menu" })
  h.send({ type: "focusTimer" }, 100)
  assert.equal(h.effects("switch")[0].index, 0)
  assert.equal(h.state.apps[GHOSTTY].layout, "us")
})

test("layers outside the pause list do not pause learning", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.send({ type: "openlayer", namespace: "omarchy-bar" })
  h.userSwitch(1)
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
})

test("a launcher that never closes stops pausing after a while", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.send({ type: "openlayer", namespace: "walker" })
  h.tick(10 * 60 * 1000)
  h.userSwitch(1)
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
})

test("memory survives reordering kb_layout", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus(GHOSTTY, "b1")
  h.userSwitch(0)
  h.send({ type: "configreloaded" })
  h.send({ type: "devices", devices: devices({ main: 1, mouse: 1 }, "ru,us") }, 10)
  assert.equal(h.state.current, "us")
  h.clear()
  assert.equal(h.focus(TELEGRAM, "a1").find(e => e.type === "switch").index, 0)
})

test("a remembered layout that was removed is left alone", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus(GHOSTTY, "b1")
  h.userSwitch(0)
  h.send({ type: "devices", devices: devices({}, "us,de") }, 10)
  h.clear()
  assert.equal(h.focus(TELEGRAM, "a1").filter(e => e.type === "switch").length, 0)
})

test("configreloaded only re-reads devices", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.clear()
  const effects = h.send({ type: "configreloaded" })
  assert.deepEqual(effects, [{ type: "refreshDevices", delayMs: 0 }])
})

test("waits for devices and state before restoring at startup", () => {
  let state = M.initialState()
  const run = event => {
    const r = M.step(state, event, 5000)
    state = r.state
    return r.effects
  }
  run({ type: "activewindow", cls: TELEGRAM, address: "0xa1" })
  assert.deepEqual(run({ type: "focusTimer" }), [])
  assert.deepEqual(run({ type: "config", config: M.parseConfig({}).config }), [])
  assert.deepEqual(run({ type: "stateLoaded", apps: { [TELEGRAM]: { layout: "ru", updatedAt: 1 } } }), [])
  const effects = run({ type: "devices", devices: devices({}) })
  assert.equal(effects.find(e => e.type === "switch").index, 1)
})

test("retries with backoff while no keyboard is reported", () => {
  let state = M.initialState()
  const delays = []
  for (let i = 0; i < 6; i++) {
    const r = M.step(state, { type: "devices", devices: { keyboards: [] } }, 0)
    state = r.state
    delays.push(r.effects.find(e => e.type === "refreshDevices").delayMs)
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000, 5000])
})

test("the bar widget's keyboard choice: the named keyboard wins", () => {
  const kbs = M.readKeyboards(devices({ main: 0, mouse: 1 }))
  assert.equal(M.referenceKeyboard(kbs, "main-keyboard").name, "main-keyboard")
  assert.equal(M.referenceKeyboard(kbs, "").name, "mouse-keyboard")
})

test("parseConfig falls back to defaults with warnings", () => {
  const { config, warnings } = M.parseConfig({
    id: "x",
    default: 42,
    rules: { a: "us", b: { mode: "window" }, c: "bad layout!", d: { mode: "nope" }, "e*": "ru" },
    pauseLayers: "walker",
    focusDelayMs: 99999,
    surprise: true
  })
  assert.equal(config.defaultLayout, "keep")
  assert.deepEqual(config.rules.map(r => r.pattern), ["a", "b", "d", "e*"])
  assert.deepEqual(config.pauseLayers, M.DEFAULT_PAUSE_LAYERS)
  assert.equal(config.focusDelayMs, 1000)
  assert.equal(warnings.length, 5)
})

test("rules match exact, then case-insensitive, then glob", () => {
  const { config } = M.parseConfig({ rules: { "chrome-*": "ru", "Google-chrome": "us", "google-chrome": "de" } })
  assert.equal(M.matchRule(config.rules, "google-chrome").layout, "de")
  assert.equal(M.matchRule(config.rules, "GOOGLE-CHROME").layout, "us")
  assert.equal(M.matchRule(config.rules, "chrome-abc-Default").layout, "ru")
  assert.equal(M.matchRule(config.rules, "firefox"), null)
})

test("configEntry finds the plugin entry in shell.json", () => {
  const text = JSON.stringify({ version: 1, plugins: [{ id: "other" }, { id: "me", default: "us" }] })
  assert.deepEqual(M.configEntry(text, "me"), { id: "me", default: "us" })
  assert.equal(M.configEntry("{not json", "me"), null)
  assert.equal(M.configEntry("", "me"), null)
})

test("state round-trips and tolerates garbage", () => {
  const apps = { [TELEGRAM]: { layout: "ru", updatedAt: 5 } }
  assert.deepEqual(M.parseState(M.serializeState(apps)).apps, apps)
  assert.deepEqual(M.parseState("").apps, {})
  assert.ok(M.parseState("{oops").warning)
  assert.ok(M.parseState(JSON.stringify({ version: 99, apps: {} })).warning)
  assert.deepEqual(M.parseState(JSON.stringify({ version: 1, apps: { x: { layout: "; rm" } } })).apps, {})
})

test("state loaded later does not overwrite fresher learning", () => {
  let state = M.initialState()
  state = M.step(state, { type: "devices", devices: devices({}) }, 0).state
  state = { ...state, apps: { [TELEGRAM]: { layout: "us", updatedAt: 9 } } }
  state = M.step(state, { type: "stateLoaded", apps: { [TELEGRAM]: { layout: "ru", updatedAt: 1 }, x: { layout: "ru", updatedAt: 1 } } }, 0).state
  assert.equal(state.apps[TELEGRAM].layout, "us")
  assert.equal(state.apps.x.layout, "ru")
})

test("a newly attached keyboard does not count as a user switch", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.clear()
  // Hyprland announces a new device with its initial layout.
  h.send({ type: "activelayout", keyboard: "new-keyboard" }, 1000)
  const withNew = devices({ main: 1 })
  withNew.keyboards.push({ name: "new-keyboard", layout: "us,ru", variant: ",", active_layout_index: 0, active_keymap: "English (US)" })
  h.send({ type: "devices", devices: withNew }, 30)
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
  assert.equal(h.effects("save").length, 0)
})

test("readings without an activelayout event only resync", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.clear()
  h.send({ type: "devices", devices: devices({ main: 0 }) }, 10000)
  assert.equal(h.state.current, "us")
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
})

test("a config reload that reorders layouts is not learned", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.clear()
  // us,ru -> ru,us keeps group index 1, which now reads as us.
  h.send({ type: "activelayout", keyboard: "main-keyboard" }, 1000)
  h.send({ type: "configreloaded" })
  h.send({ type: "devices", devices: devices({ main: 1 }, "ru,us") }, 10)
  h.send({ type: "activelayout", keyboard: "main-keyboard" }, 200)
  h.send({ type: "devices", devices: devices({ main: 1 }, "ru,us") }, 30)
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
  assert.equal(h.effects("save").length, 0)
})

test("the class from activewindow beats a stale cached class", () => {
  const h = harness()
  h.send({ type: "openwindow", address: "e1", cls: "steam" })
  h.focus("steam_app_42", "e1")
  h.userSwitch(1)
  assert.equal(h.state.apps.steam_app_42.layout, "ru")
  assert.equal(h.state.apps.steam, undefined)
  assert.equal(h.state.classes.e1, "steam_app_42")
})

test("fresh hyprctl clients data replaces cached classes", () => {
  const h = harness()
  h.send({ type: "openwindow", address: "e1", cls: "steam" })
  h.send({ type: "clients", clients: [{ address: "0xe1", class: "steam_app_42" }] })
  assert.equal(h.state.classes.e1, "steam_app_42")
})

test("no restore happens before the config is known", () => {
  let state = M.initialState()
  const run = event => {
    const r = M.step(state, event, 5000)
    state = r.state
    return r.effects
  }
  run({ type: "stateLoaded", apps: { [GHOSTTY]: { layout: "ru", updatedAt: 1 } } })
  run({ type: "devices", devices: devices({}) })
  run({ type: "activewindow", cls: GHOSTTY, address: "b1" })
  assert.equal(run({ type: "focusTimer" }).filter(e => e.type === "switch").length, 0)
  // The config pins Ghostty to us, which is already current.
  const effects = run({ type: "config", config: M.parseConfig({ rules: { [GHOSTTY]: "us" } }).config })
  assert.equal(effects.filter(e => e.type === "switch").length, 0)
})

test("a failed switch rebaselines without learning", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.focus(GHOSTTY, "b1")
  h.userSwitch(0)
  h.focus(TELEGRAM, "a1")
  h.clear()
  h.send({ type: "switchFailed", reason: "device not found" }, 50)
  assert.equal(h.state.current, null)
  h.send({ type: "devices", devices: devices({ main: 0 }) }, 10000)
  assert.equal(h.state.current, "us")
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
  assert.equal(h.effects("save").length, 0)
})

test("an early switchFailed keeps our own echo from being learned", () => {
  const h = harness({ default: "us" })
  h.focus(TELEGRAM, "a1")
  h.userSwitch(1)
  h.clear()
  h.send({ type: "activewindow", cls: "newapp" })
  h.send({ type: "activewindowv2", address: "n1" })
  h.send({ type: "focusTimer" }, 100)
  h.send({ type: "switchFailed", reason: "unsupported device name" })
  h.send({ type: "devices", devices: devices({ main: 1 }) }, 5)
  h.send({ type: "activelayout", keyboard: "main-keyboard" }, 20)
  h.send({ type: "devices", devices: devices({ main: 0, mouse: 0 }) }, 30)
  assert.equal(h.state.apps.newapp, undefined)
})

test("a stale reading in flight does not swallow the user's switch", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.send({ type: "activelayout", keyboard: "main-keyboard" }, 1000)
  h.send({ type: "devices", devices: devices({ main: 0 }) }, 5)
  h.send({ type: "devices", devices: devices({ main: 1 }) }, 30)
  assert.equal(h.state.apps[TELEGRAM].layout, "ru")
})

test("an announced switch that never shows up expires", () => {
  const h = harness()
  h.focus(TELEGRAM, "a1")
  h.send({ type: "activelayout", keyboard: "main-keyboard" }, 1000)
  h.send({ type: "devices", devices: devices({ main: 0 }) }, 5)
  h.send({ type: "devices", devices: devices({ main: 1 }) }, 5000)
  assert.equal(h.state.apps[TELEGRAM], undefined)
})
