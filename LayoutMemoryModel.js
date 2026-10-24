// Layout memory logic, kept Qt-free so it runs under `node --test`.
//
// Service.qml feeds Hyprland events into `step(state, event, now)` and carries
// out the effects it returns. Nothing here touches processes, files or timers.
//
// isTypedKeyboard and the keyboard selection are adapted from Omarchy's
// shell/plugins/bar/widgets/KeyboardLayoutModel.js (MIT, (c) Omarchy).

var STATE_VERSION = 1

// How long after our own switch an activelayout event is treated as its echo.
var ECHO_WINDOW_MS = 400

// A launcher that never reported closing must not pause learning forever.
var LAYER_PAUSE_MAX_MS = 120000

// After a Hyprland config reload, keymaps are rebuilt and readings settle.
var RELOAD_SETTLE_MS = 1000

// How long an announced switch waits for a reading that shows it.
var SWITCH_PENDING_MS = 1000

var DEFAULT_PAUSE_LAYERS = [
  "omarchy-menu",
  "omarchy-keyboard-panel",
  "omarchy-emojis",
  "omarchy-clipboard",
  "omarchy-image-selector",
  "walker",
  "wofi",
  "rofi",
  "fuzzel",
  "anyrun",
  "tofi"
]

var DEFAULT_CONFIG = {
  defaultLayout: "keep",
  rules: [],
  pauseLayers: DEFAULT_PAUSE_LAYERS,
  layerLayouts: {},
  focusDelayMs: 80,
  debug: false
}

var LAYOUT_NAME = /^[A-Za-z0-9_-]+(\([A-Za-z0-9_-]+\))?$/
var KNOWN_CONFIG_KEYS = ["id", "default", "rules", "pauseLayers", "layerLayouts", "focusDelayMs", "debug"]
var RULE_MODES = ["app", "window", "ignore"]

// ------------------------------------------------------------------ parsing

// Hyprland reports more than keyboards as keyboards: fcitx5's virtual keyboard
// (which often holds the `main` flag), power and sleep buttons, lid switches.
// Switching or reading those gives wrong answers, so leave them out.
var UNTYPED_KEYBOARDS = /^(hl-virtual-keyboard|power-button|sleep-button|lid-switch|video-bus)/

function isTypedKeyboard(name) {
  return !UNTYPED_KEYBOARDS.test(String(name || ""))
}

// "us,ru" + ",phonetic" -> ["us", "ru(phonetic)"]
function layoutNames(keyboard) {
  if (!keyboard || typeof keyboard.layout !== "string" || keyboard.layout === "") return []
  var layouts = keyboard.layout.split(",")
  var variants = typeof keyboard.variant === "string" ? keyboard.variant.split(",") : []
  return layouts.map(function (layout, i) {
    var variant = (variants[i] || "").trim()
    return layout.trim() + (variant ? "(" + variant + ")" : "")
  })
}

function baseName(name) {
  return String(name || "").split("(")[0]
}

// Exact match first, then the same layout with any variant.
function layoutIndex(layouts, name) {
  var exact = layouts.indexOf(name)
  if (exact !== -1) return exact
  var base = baseName(name)
  for (var i = 0; i < layouts.length; i++) {
    if (baseName(layouts[i]) === base) return i
  }
  return -1
}

// Hyprland prints addresses as "0x55d2..." in hyprctl and "55d2..." in events.
function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase().replace(/^0x/, "")
}

// activelayout>>KEYBOARD,DESCRIPTION. Older Hyprland versions kept commas in
// device names, so prefer Quickshell's parse(2) result and otherwise split at
// the last comma.
function activelayoutKeyboard(parts, raw) {
  if (Array.isArray(parts) && parts.length >= 2) return String(parts[0] || "")
  var data = String(raw || "")
  var comma = data.lastIndexOf(",")
  return comma === -1 ? data : data.substring(0, comma)
}

function readKeyboards(devicesJson) {
  var listed = devicesJson && devicesJson.keyboards
  if (!Array.isArray(listed)) return null
  return listed
    .filter(function (kb) { return kb && isTypedKeyboard(kb.name) })
    .map(function (kb) {
      return {
        name: String(kb.name || ""),
        index: typeof kb.active_layout_index === "number" ? kb.active_layout_index : 0,
        layouts: layoutNames(kb),
        hasKeymap: !!kb.active_keymap
      }
    })
    .filter(function (kb) { return kb.layouts.length > 0 })
}

// The keyboard an activelayout event last named is the one being typed on.
// Without one, the furthest-advanced keyboard is the best guess, since only the
// keyboard in use moves away from the first layout.
function referenceKeyboard(keyboards, namedKeyboard) {
  if (!keyboards || keyboards.length === 0) return null
  for (var i = 0; i < keyboards.length; i++) {
    if (keyboards[i].name === namedKeyboard) return keyboards[i]
  }
  return keyboards.reduce(function (best, kb) {
    return kb.index > best.index ? kb : best
  }, keyboards[0])
}

function warnOnce(warnings, message) {
  if (warnings.indexOf(message) === -1) warnings.push(message)
}

function validLayout(value) {
  return typeof value === "string" && LAYOUT_NAME.test(value)
}

function globToRegExp(pattern) {
  var escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp("^" + escaped + "$", "i")
}

function parseRule(pattern, value, warnings) {
  if (!pattern) return null
  var rule = { pattern: pattern, layout: null, mode: "app", glob: null }
  if (/[*?]/.test(pattern)) rule.glob = globToRegExp(pattern)

  if (typeof value === "string") {
    if (RULE_MODES.indexOf(value) !== -1) {
      rule.mode = value
      return rule
    }
    if (!validLayout(value)) {
      warnOnce(warnings, "rule '" + pattern + "': invalid layout '" + value + "', ignored")
      return null
    }
    rule.layout = value
    return rule
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.layout !== undefined) {
      if (!validLayout(value.layout)) {
        warnOnce(warnings, "rule '" + pattern + "': invalid layout, ignored")
        return null
      }
      rule.layout = value.layout
    }
    if (value.mode !== undefined) {
      if (RULE_MODES.indexOf(value.mode) === -1) {
        warnOnce(warnings, "rule '" + pattern + "': mode must be app, window or ignore")
      } else {
        rule.mode = value.mode
      }
    }
    return rule
  }

  warnOnce(warnings, "rule '" + pattern + "': expected a layout name or an object, ignored")
  return null
}

// Reads the plugin's inline entry from shell.json. Never throws: anything
// invalid falls back to its default and adds a warning.
function parseConfig(entry) {
  var warnings = []
  var config = {
    defaultLayout: DEFAULT_CONFIG.defaultLayout,
    rules: [],
    pauseLayers: DEFAULT_CONFIG.pauseLayers.slice(),
    layerLayouts: {},
    focusDelayMs: DEFAULT_CONFIG.focusDelayMs,
    debug: DEFAULT_CONFIG.debug
  }
  if (!entry || typeof entry !== "object") return { config: config, warnings: warnings }

  Object.keys(entry).forEach(function (key) {
    if (KNOWN_CONFIG_KEYS.indexOf(key) === -1) warnOnce(warnings, "unknown option '" + key + "' ignored")
  })

  if (entry["default"] !== undefined) {
    if (entry["default"] === "keep" || validLayout(entry["default"])) config.defaultLayout = entry["default"]
    else warnOnce(warnings, "'default' must be \"keep\" or a layout name")
  }

  if (entry.rules !== undefined) {
    if (entry.rules && typeof entry.rules === "object" && !Array.isArray(entry.rules)) {
      Object.keys(entry.rules).forEach(function (pattern) {
        var rule = parseRule(pattern, entry.rules[pattern], warnings)
        if (rule) config.rules.push(rule)
      })
    } else {
      warnOnce(warnings, "'rules' must be an object keyed by window class")
    }
  }

  if (entry.pauseLayers !== undefined) {
    if (Array.isArray(entry.pauseLayers)) {
      config.pauseLayers = entry.pauseLayers.filter(function (ns) { return typeof ns === "string" && ns })
    } else {
      warnOnce(warnings, "'pauseLayers' must be a list of layer namespaces")
    }
  }

  if (entry.layerLayouts !== undefined) {
    if (entry.layerLayouts && typeof entry.layerLayouts === "object" && !Array.isArray(entry.layerLayouts)) {
      Object.keys(entry.layerLayouts).forEach(function (ns) {
        var layout = entry.layerLayouts[ns]
        if (ns && validLayout(layout)) config.layerLayouts[ns] = layout
        else warnOnce(warnings, "layerLayouts '" + ns + "': invalid layout, ignored")
      })
    } else {
      warnOnce(warnings, "'layerLayouts' must be an object keyed by layer namespace")
    }
  }

  if (entry.focusDelayMs !== undefined) {
    var delay = Number(entry.focusDelayMs)
    if (isFinite(delay)) config.focusDelayMs = Math.max(0, Math.min(1000, Math.round(delay)))
    else warnOnce(warnings, "'focusDelayMs' must be a number")
  }

  if (entry.debug !== undefined) config.debug = entry.debug === true

  return { config: config, warnings: warnings }
}

// Picks the plugin's entry out of a shell.json text.
function configEntry(shellJsonText, pluginId) {
  try {
    var parsed = JSON.parse(shellJsonText || "{}")
    var plugins = parsed && Array.isArray(parsed.plugins) ? parsed.plugins : []
    for (var i = 0; i < plugins.length; i++) {
      if (plugins[i] && plugins[i].id === pluginId) return plugins[i]
    }
  } catch (e) {
  }
  return null
}

function parseState(text) {
  if (!text) return { apps: {}, warning: "" }
  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { apps: {}, warning: "state file is not valid JSON, starting empty" }
  }
  if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.apps !== "object" || !parsed.apps) {
    return { apps: {}, warning: "state file has an unknown format, starting empty" }
  }
  var apps = {}
  Object.keys(parsed.apps).forEach(function (cls) {
    var item = parsed.apps[cls]
    if (item && validLayout(item.layout)) {
      apps[cls] = { layout: item.layout, updatedAt: Number(item.updatedAt) || 0 }
    }
  })
  return { apps: apps, warning: "" }
}

function serializeState(apps) {
  var sorted = {}
  Object.keys(apps || {}).sort().forEach(function (cls) { sorted[cls] = apps[cls] })
  return JSON.stringify({ version: STATE_VERSION, apps: sorted }, null, 2) + "\n"
}

// Exact class, then case-insensitive, then globs, each in declaration order.
function matchRule(rules, cls) {
  if (!cls || !rules) return null
  var i
  for (i = 0; i < rules.length; i++) {
    if (!rules[i].glob && rules[i].pattern === cls) return rules[i]
  }
  var lower = cls.toLowerCase()
  for (i = 0; i < rules.length; i++) {
    if (!rules[i].glob && rules[i].pattern.toLowerCase() === lower) return rules[i]
  }
  for (i = 0; i < rules.length; i++) {
    if (rules[i].glob && rules[i].glob.test(cls)) return rules[i]
  }
  return null
}

// -------------------------------------------------------------------- state

function initialState(config) {
  return {
    config: config || parseConfig(null).config,
    apps: {},
    windows: {},
    classes: {},
    keyboards: [],
    namedKeyboard: "",
    layouts: [],
    current: null,
    focusClass: "",
    focusAddress: "",
    focusPending: false,
    resolveWanted: false,
    userSwitchPending: false,
    userSwitchUntil: 0,
    settleUntil: 0,
    expected: null,
    layers: {},
    layerRestore: null,
    devicesReady: false,
    stateLoaded: false,
    configLoaded: false,
    devicesRetry: 0
  }
}

function copy(state) {
  var next = {}
  for (var key in state) next[key] = state[key]
  return next
}

function without(map, key) {
  var next = {}
  for (var k in map) if (k !== key) next[k] = map[k]
  return next
}

function withEntry(map, key, value) {
  var next = {}
  for (var k in map) next[k] = map[k]
  next[key] = value
  return next
}

function echoActive(state, now) {
  return !!state.expected && now < state.expected.until
}

function learningPaused(state, now) {
  for (var ns in state.layers) {
    var layer = state.layers[ns]
    if (layer.count > 0 && now - layer.since < LAYER_PAUSE_MAX_MS) return true
  }
  return false
}

function layerLayout(state, ns) {
  var layouts = state.config.layerLayouts
  return Object.prototype.hasOwnProperty.call(layouts, ns) ? layouts[ns] : null
}

// The open layer whose layout wins over the focused window's, if any.
function openLayerWithLayout(state, now) {
  for (var ns in state.layers) {
    var layer = state.layers[ns]
    if (layerLayout(state, ns) && layer.count > 0 && now - layer.since < LAYER_PAUSE_MAX_MS) return ns
  }
  return null
}

function debugLog(state, effects, message) {
  if (state.config.debug) effects.push({ type: "log", message: message })
}

// Which layout the focused window should get, or null to leave it alone.
function targetLayout(state) {
  var rule = matchRule(state.config.rules, state.focusClass)
  if (rule && rule.mode === "ignore") return null
  if (rule && rule.layout) return rule.layout
  if (rule && rule.mode === "window" && state.windows[state.focusAddress]) {
    return state.windows[state.focusAddress]
  }
  var remembered = state.apps[state.focusClass]
  if (remembered) return remembered.layout
  return state.config.defaultLayout === "keep" ? null : state.config.defaultLayout
}

function resolveFocus(state, now, effects) {
  if (!state.devicesReady || !state.stateLoaded || !state.configLoaded) {
    state.resolveWanted = true
    return state
  }
  state.resolveWanted = false

  // A layer with its own layout keeps it until it closes, whatever focus does.
  var layer = openLayerWithLayout(state, now)
  if (layer) return applyLayerLayout(state, layer, now, effects)

  // A layer's own layout must not outlive it: without anything to restore,
  // go back to the layout from before the layer opened.
  var restore = state.layerRestore
  state.layerRestore = null
  var target = state.focusClass ? targetLayout(state) : null
  var reason = "focus " + state.focusClass
  if (!target && restore) {
    target = restore
    reason = "layer restore"
  }
  if (!target) {
    if (state.focusClass) debugLog(state, effects, reason + ": nothing to restore")
    return state
  }
  var index = layoutIndex(state.layouts, target)
  if (index === -1) {
    debugLog(state, effects, reason + ": layout '" + target + "' is not configured")
    return state
  }
  return switchTo(state, index, now, effects, reason)
}

function switchTo(state, index, now, effects, reason) {
  // Never switch needlessly: a keymap change while a modifier is held is what
  // leaves keys stuck.
  if (state.current === state.layouts[index]) return state

  // Align every typed keyboard, so the next user switch moves exactly one of
  // them and the event that follows names the keyboard being typed on.
  var behind = state.keyboards.filter(function (kb) { return kb.index !== index })
  effects.push({ type: "switch", keyboards: behind.map(function (kb) { return kb.name }), index: index })
  state.keyboards = state.keyboards.map(function (kb) {
    return { name: kb.name, index: index, layouts: kb.layouts, hasKeymap: kb.hasKeymap }
  })
  state.current = state.layouts[index]
  state.expected = { until: now + ECHO_WINDOW_MS }
  debugLog(state, effects, reason + ": switch to " + state.current)
  return state
}

// state.current can lag a switch made just before the layer opened, until the
// next devices reading; the restore then aims at the older layout.
function applyLayerLayout(state, ns, now, effects) {
  var layout = layerLayout(state, ns)
  var index = layoutIndex(state.layouts, layout)
  if (index === -1) {
    debugLog(state, effects, "layer " + ns + ": layout '" + layout + "' is not configured")
    return state
  }
  return switchTo(state, index, now, effects, "layer " + ns)
}

function learn(state, layout, now, effects) {
  var cls = state.focusClass
  if (!cls) return state
  var rule = matchRule(state.config.rules, cls)
  if (rule && (rule.layout || rule.mode === "ignore")) return state

  if (rule && rule.mode === "window" && state.focusAddress) {
    state.windows = withEntry(state.windows, state.focusAddress, layout)
  }
  var previous = state.apps[cls]
  if (!previous || previous.layout !== layout) {
    state.apps = withEntry(state.apps, cls, { layout: layout, updatedAt: Math.floor(now / 1000) })
    effects.push({ type: "save" })
  }
  debugLog(state, effects, "learned " + cls + " -> " + layout)
  return state
}

function onDevices(state, event, now, effects) {
  var keyboards = readKeyboards(event.devices)
  var reference = keyboards ? referenceKeyboard(keyboards, state.namedKeyboard) : null

  if (!reference || !reference.hasKeymap) {
    state.devicesReady = false
    var delay = Math.min(5000, 500 * Math.pow(2, state.devicesRetry))
    state.devicesRetry = state.devicesRetry + 1
    if (keyboards && keyboards.length === 0 && event.devices && Array.isArray(event.devices.keyboards)
        && event.devices.keyboards.length > 0 && state.devicesRetry === 1) {
      effects.push({ type: "log", message: "no typed keyboard with a layout list found; waiting" })
    }
    effects.push({ type: "refreshDevices", delayMs: delay })
    return state
  }

  var wasReady = state.devicesReady
  var previous = state.current
  var previousLayouts = state.layouts
  var userSwitch = state.userSwitchPending && now < state.userSwitchUntil
  state.keyboards = keyboards
  state.layouts = reference.layouts
  state.current = reference.layouts[reference.index] || null
  state.devicesReady = true
  state.devicesRetry = 0

  // A reading already in flight when the switch happened shows nothing new;
  // keep waiting for the one after it.
  if (state.current !== previous || now >= state.userSwitchUntil) state.userSwitchPending = false

  if (!wasReady) {
    if (state.layouts.length < 2) {
      effects.push({ type: "log", message: "only one keyboard layout configured; nothing to remember" })
    }
    if (state.resolveWanted || state.focusClass) return resolveFocus(state, now, effects)
    return state
  }

  // Learn only when a keyboard we already knew announced the change: Alt+Alt,
  // the bar widget, or anything else the user did. Readings after a hotplug, a
  // config reload, a failed switch or a periodic poll only resync.
  if (userSwitch && previous && state.current && state.current !== previous
      && previousLayouts.join(",") === state.layouts.join(",")
      && now >= state.settleUntil
      && !echoActive(state, now) && !state.focusPending && !learningPaused(state, now)) {
    return learn(state, state.current, now, effects)
  }
  return state
}

function startFocus(state, effects) {
  state.focusPending = true
  effects.push({ type: "startFocusTimer", ms: state.config.focusDelayMs })
  return state
}

// Applies one event. Returns the next state and the effects to run.
function step(previousState, event, now) {
  var state = copy(previousState)
  var effects = []
  var type = event && event.type

  if (type === "config") {
    state.config = event.config
    var firstConfig = !state.configLoaded
    state.configLoaded = true
    if (firstConfig && state.resolveWanted) state = resolveFocus(state, now, effects)
    else if (state.focusClass) startFocus(state, effects)
  } else if (type === "stateLoaded") {
    var merged = {}
    var loaded = event.apps || {}
    for (var cls in loaded) merged[cls] = loaded[cls]
    for (var learned in state.apps) merged[learned] = state.apps[learned]
    state.apps = merged
    state.stateLoaded = true
    if (state.resolveWanted || state.focusClass) state = resolveFocus(state, now, effects)
  } else if (type === "devices") {
    state = onDevices(state, event, now, effects)
  } else if (type === "clients") {
    var classes = {}
    ;(event.clients || []).forEach(function (client) {
      if (client && client.address) classes[normalizeAddress(client.address)] = String(client["class"] || "")
    })
    for (var addr in state.classes) {
      if (!(addr in classes)) classes[addr] = state.classes[addr]
    }
    state.classes = classes
  } else if (type === "activewindow") {
    state.focusClass = String(event.cls || "")
    if (event.address !== undefined) {
      state.focusAddress = normalizeAddress(event.address)
      if (state.focusAddress && state.focusClass) {
        state.classes = withEntry(state.classes, state.focusAddress, state.focusClass)
      }
    }
    startFocus(state, effects)
  } else if (type === "activewindowv2") {
    // activewindow (sent just before) carries the current class; the cache
    // can be stale for windows that change class after mapping.
    state.focusAddress = normalizeAddress(event.address)
    if (state.focusAddress && state.focusClass) {
      state.classes = withEntry(state.classes, state.focusAddress, state.focusClass)
    } else if (!state.focusClass && state.classes[state.focusAddress]) {
      state.focusClass = state.classes[state.focusAddress]
    }
    startFocus(state, effects)
  } else if (type === "focusTimer") {
    state.focusPending = false
    state = resolveFocus(state, now, effects)
  } else if (type === "openwindow") {
    var opened = normalizeAddress(event.address)
    if (opened) state.classes = withEntry(state.classes, opened, String(event.cls || ""))
  } else if (type === "closewindow") {
    var closed = normalizeAddress(event.address)
    state.classes = without(state.classes, closed)
    state.windows = without(state.windows, closed)
  } else if (type === "activelayout") {
    var keyboard = String(event.keyboard || "")
    var known = state.keyboards.some(function (kb) { return kb.name === keyboard })
    // Our own switch announces itself once per keyboard, and a newly attached
    // keyboard announces its initial layout. Neither is the user choosing.
    if (known && !echoActive(state, now)) {
      state.namedKeyboard = keyboard
      state.userSwitchPending = true
      state.userSwitchUntil = now + SWITCH_PENDING_MS
    }
    effects.push({ type: "refreshDevices", delayMs: 30 })
  } else if (type === "openlayer" || type === "closelayer") {
    var ns = String(event.namespace || "")
    if (state.config.pauseLayers.indexOf(ns) !== -1 || layerLayout(state, ns)) {
      var layer = state.layers[ns] || { count: 0, since: now }
      // An expired entry is a close we never saw; do not let it pile up.
      var previousCount = now - layer.since < LAYER_PAUSE_MAX_MS ? layer.count : 0
      // Remember the layout from before the first layout layer opened, even
      // when it already matches: the user may still change it inside.
      if (type === "openlayer" && layerLayout(state, ns) && !openLayerWithLayout(state, now)) {
        state.layerRestore = state.current
      }
      var count = type === "openlayer" ? previousCount + 1 : Math.max(0, previousCount - 1)
      state.layers = count > 0
        ? withEntry(state.layers, ns, { count: count, since: type === "openlayer" ? now : layer.since })
        : without(state.layers, ns)
      // Switch through the focus delay, like focus changes do, so the keys
      // that opened the layer are likely released by then.
      if (type === "openlayer" && layerLayout(state, ns)) startFocus(state, effects)
      // Whatever was typed in the launcher, the window underneath gets its
      // own layout back.
      if (type === "closelayer" && (!learningPaused(state, now) || layerLayout(state, ns))) startFocus(state, effects)
    }
  } else if (type === "switchFailed") {
    // The keyboards are not where we assumed; take the next reading as truth.
    // Keep the echo window: the rest of the batch may still be applied.
    state.current = null
    effects.push({ type: "log", message: "switch failed: " + String(event.reason || "unknown") })
    effects.push({ type: "refreshDevices", delayMs: 0 })
  } else if (type === "configreloaded") {
    // Keymaps were rebuilt and announced themselves just before this event.
    // Re-read without learning, and never re-apply here: switching keymaps
    // while a modifier is held can leave it stuck.
    state.userSwitchPending = false
    state.settleUntil = now + RELOAD_SETTLE_MS
    effects.push({ type: "refreshDevices", delayMs: 0 })
  }

  return { state: state, effects: effects }
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_PAUSE_LAYERS: DEFAULT_PAUSE_LAYERS,
    ECHO_WINDOW_MS: ECHO_WINDOW_MS,
    activelayoutKeyboard: activelayoutKeyboard,
    configEntry: configEntry,
    initialState: initialState,
    isTypedKeyboard: isTypedKeyboard,
    layoutIndex: layoutIndex,
    layoutNames: layoutNames,
    matchRule: matchRule,
    normalizeAddress: normalizeAddress,
    parseConfig: parseConfig,
    parseState: parseState,
    readKeyboards: readKeyboards,
    referenceKeyboard: referenceKeyboard,
    serializeState: serializeState,
    step: step
  }
}
