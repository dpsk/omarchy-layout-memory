import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "LayoutMemoryModel.js" as Model

// Headless service: remembers the last keyboard layout per application and
// restores it on focus. All decisions live in LayoutMemoryModel.js; this file
// only turns Hyprland events into model events and runs the effects it returns.
Item {
  id: root

  // Injected by omarchy-shell.
  property var shell: null
  property var manifest: null
  property string omarchyPath: ""

  readonly property string pluginId: manifest && manifest.id ? manifest.id : "io.github.dpsk.layout-memory"
  readonly property string home: Quickshell.env("HOME")
  readonly property string shellConfigPath: home + "/.config/omarchy/shell.json"
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy-layout-memory"
  readonly property string statePath: stateDir + "/state.json"

  property var model: Model.initialState(null)
  property string lastWarnings: ""
  property var pendingSwitch: null
  property bool devicesPending: false
  property bool saveDirty: false

  function log(message) {
    console.log("layout-memory: " + message)
  }

  function dispatch(event) {
    var result = Model.step(root.model, event, Date.now())
    root.model = result.state
    for (var i = 0; i < result.effects.length; i++) runEffect(result.effects[i])
  }

  function runEffect(effect) {
    switch (effect.type) {
    case "switch":
      requestSwitch(effect.keyboards, effect.index)
      break
    case "refreshDevices":
      if (effect.delayMs > 0) {
        refreshTimer.interval = effect.delayMs
        refreshTimer.restart()
      } else {
        refreshDevices()
      }
      break
    case "startFocusTimer":
      focusTimer.interval = Math.max(1, effect.ms)
      focusTimer.restart()
      break
    case "save":
      root.saveDirty = true
      saveTimer.restart()
      break
    case "log":
      log(effect.message)
      break
    }
  }

  // ---------------------------------------------------------------- events

  function eventParts(event, count) {
    try {
      if (event && event.parse) return event.parse(count)
    } catch (error) {
    }
    return String(event && event.data ? event.data : "").split(",")
  }

  function layoutKeyboard(event) {
    var parts = null
    try {
      if (event.parse) parts = event.parse(2)
    } catch (error) {
    }
    return Model.activelayoutKeyboard(parts, event.data)
  }

  function modelEvent(name, event) {
    var data = String(event.data || "")
    if (name === "activewindow") return { type: name, cls: eventParts(event, 2)[0] || "" }
    if (name === "activewindowv2" || name === "closewindow") return { type: name, address: data }
    if (name === "openwindow") {
      var parts = eventParts(event, 4)
      return { type: name, address: parts[0] || "", cls: parts[2] || "" }
    }
    if (name === "activelayout") return { type: name, keyboard: layoutKeyboard(event) }
    if (name === "openlayer" || name === "closelayer") return { type: name, namespace: data }
    if (name === "configreloaded") return { type: name }
    return null
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!event || !event.name) return
      var modelEvent = root.modelEvent(String(event.name), event)
      if (modelEvent) root.dispatch(modelEvent)
    }
  }

  // --------------------------------------------------------------- devices

  function refreshDevices() {
    if (devicesProc.running) {
      root.devicesPending = true
      return
    }
    root.devicesPending = false
    devicesProc.running = true
  }

  Process {
    id: devicesProc
    command: ["hyprctl", "-j", "devices"]
    onRunningChanged: {
      if (running) {
        devicesStallTimer.restart()
        return
      }
      devicesStallTimer.stop()
      if (root.devicesPending) root.refreshDevices()
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var devices
        try {
          devices = JSON.parse(text || "")
        } catch (e) {
          return
        }
        root.dispatch({ type: "devices", devices: devices })
      }
    }
  }

  Timer {
    id: refreshTimer
    onTriggered: root.refreshDevices()
  }

  // A Process that never returns can't be re-run, so give up on it.
  Timer {
    id: devicesStallTimer
    interval: 5000
    onTriggered: {
      devicesProc.running = false
      refreshTimer.interval = 500
      refreshTimer.restart()
    }
  }

  // Catch changes no event reported. Nothing can change on a single-layout
  // seat, so stop asking once one has been read.
  Timer {
    interval: 10000
    running: !root.model.devicesReady || root.model.layouts.length > 1
    repeat: true
    onTriggered: root.refreshDevices()
  }

  // ------------------------------------------------------------- switching

  // Device names are slugs, but they end up in a hyprctl batch string, so
  // refuse anything that could split or extend the command.
  function safeDeviceName(name) {
    return /^[^;\s'"`$\\]+$/.test(String(name || ""))
  }

  function requestSwitch(keyboards, index) {
    var all = keyboards || []
    var names = all.filter(safeDeviceName)
    if (names.length !== all.length) {
      root.dispatch({ type: "switchFailed", reason: "unsupported device name" })
      if (names.length === 0) return
    }
    root.pendingSwitch = { keyboards: names, index: index }
    if (!switchProc.running) runPendingSwitch()
  }

  function runPendingSwitch() {
    var request = root.pendingSwitch
    root.pendingSwitch = null
    if (!request) return
    var commands = request.keyboards.map(function (name) {
      return "switchxkblayout " + name + " " + request.index
    })
    switchProc.command = ["hyprctl", "--batch", commands.join(" ; ")]
    switchProc.running = true
  }

  // hyprctl --batch exits 0 even when a device is missing; it prints one reply
  // per command instead, "ok" on success.
  Process {
    id: switchProc
    onRunningChanged: {
      if (running) {
        switchStallTimer.restart()
        return
      }
      switchStallTimer.stop()
      if (root.pendingSwitch) root.runPendingSwitch()
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var failed = String(text || "").split("\n").map(function (line) {
          return line.trim()
        }).filter(function (line) {
          return line !== "" && line !== "ok"
        })
        if (failed.length > 0) root.dispatch({ type: "switchFailed", reason: failed.join("; ") })
      }
    }
  }

  // A hung hyprctl would otherwise block every later restore.
  Timer {
    id: switchStallTimer
    interval: 3000
    onTriggered: {
      root.dispatch({ type: "switchFailed", reason: "hyprctl did not respond" })
      // Stopping it lets onRunningChanged start any queued switch.
      switchProc.running = false
    }
  }

  // ----------------------------------------------------------------- focus

  Timer {
    id: focusTimer
    interval: 80
    onTriggered: root.dispatch({ type: "focusTimer" })
  }

  Process {
    id: clientsProc
    command: ["hyprctl", "-j", "clients"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var clients = JSON.parse(text || "[]")
          if (Array.isArray(clients)) root.dispatch({ type: "clients", clients: clients })
        } catch (e) {
        }
      }
    }
  }

  Process {
    id: activeProc
    command: ["hyprctl", "-j", "activewindow"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var active = JSON.parse(text || "{}")
          if (active && active["class"]) {
            root.dispatch({ type: "activewindow", cls: String(active["class"]), address: String(active.address || "") })
          }
        } catch (e) {
        }
      }
    }
  }

  // ---------------------------------------------------------------- config

  // Options live inline on this plugin's entry in shell.json, like every other
  // Omarchy plugin. The plugin only reads that file.
  FileView {
    id: configFile
    path: root.shellConfigPath
    watchChanges: true
    printErrors: false
    onLoaded: root.loadConfig(text())
    onLoadFailed: root.loadConfig("")
    // text() is stale inside the change signal, so reload and parse in onLoaded.
    onFileChanged: reload()
  }

  function loadConfig(raw) {
    var parsed = Model.parseConfig(Model.configEntry(raw, root.pluginId))
    var warnings = parsed.warnings.join("; ")
    if (warnings && warnings !== root.lastWarnings) log("config: " + warnings)
    root.lastWarnings = warnings
    root.dispatch({ type: "config", config: parsed.config })
  }

  // ----------------------------------------------------------------- state

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadState(text())
    // First run: no file yet.
    onLoadFailed: root.loadState("")
    onSaveFailed: root.log("could not write " + root.statePath)
  }

  function loadState(raw) {
    if (root.model.stateLoaded) return
    var parsed = Model.parseState(raw)
    if (parsed.warning) log(parsed.warning)
    root.dispatch({ type: "stateLoaded", apps: parsed.apps })
  }

  Process {
    id: mkdirProc
    command: ["mkdir", "-p", root.stateDir]
  }

  Timer {
    id: saveTimer
    interval: 500
    onTriggered: root.flushState()
  }

  function flushState(blocking) {
    // A reload creates the next instance right away; block so it reads the
    // finished file instead of racing the write.
    if (blocking) stateFile.blockWrites = true
    if (root.saveDirty) {
      root.saveDirty = false
      stateFile.setText(Model.serializeState(root.model.apps))
    }
    // Also wait for a save the timer started just before.
    if (blocking) stateFile.waitForJob()
  }

  Component.onCompleted: {
    mkdirProc.running = true
    refreshDevices()
    clientsProc.running = true
    activeProc.running = true
  }

  // Plugin reloads and shell restarts must not drop the last learned layout.
  Component.onDestruction: flushState(true)
}
