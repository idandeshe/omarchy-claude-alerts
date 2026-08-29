import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar slot for claude-alerts. Watches the state file the service writes and
// shows how many agents are blocked on you.
//
// A sound is transient — away from the desk you miss it entirely. This badge
// is the durable half: it keeps naming the waiting agents until you deal with
// them. With nothing waiting it takes no space at all, the way the stock
// agents widget leaves the bar when it has nothing to say.
BarWidget {
  id: root
  moduleName: "idan.claude-alerts"

  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")
  readonly property string stateFile:
    (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") +
    "/omarchy/claude-alerts/state.json"

  property var waiting: []
  readonly property int count: waiting.length
  readonly property bool urgent: {
    for (var i = 0; i < waiting.length; i++)
      if (waiting[i] && waiting[i].level === "critical") return true
    return false
  }

  FileView {
    path: root.stateFile
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.parseState(text())
    // No file yet just means the service has not written one: not an error.
    onLoadFailed: root.waiting = []
  }

  function parseState(content) {
    try {
      var parsed = JSON.parse(String(content || ""))
      var list = parsed && parsed.waiting ? parsed.waiting : []
      root.waiting = Array.isArray(list) ? list : []
    } catch (e) {
      console.warn("claude-alerts: ignoring bad state file", root.stateFile, e)
      root.waiting = []
    }
  }

  // ---- Actions -------------------------------------------------------------

  Process { id: ctl; running: false }

  function run(args) {
    if (ctl.running) return
    ctl.command = [root.pluginDir + "bin/claude-alerts-ctl"].concat(args)
    ctl.running = true
  }

  function focusProject(project) {
    root.run(["focus", project])
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  function clearAll() {
    root.run(["clear"])
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  // ---- Panel wiring --------------------------------------------------------

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract the bar's popout coordinator looks for on a widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey() }
  function close() { if (panelLoader.item && panelLoader.item.close) panelLoader.item.close() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  onBarChanged: root.injectPanel()
  onSettingsChanged: root.injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // ---- Bar slot ------------------------------------------------------------

  // Nothing waiting, nothing drawn — and no gap left behind either.
  visible: root.count > 0
  implicitWidth: root.count > 0 ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight
  readonly property real openPanelIndicatorWidth: button.implicitWidth

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "◉ " + root.count
    active: root.count > 0
    activeColor: root.urgent ? "#e06c75" : "#ffb454"
    tooltipText: root.count === 1
      ? "1 agent is waiting on you"
      : root.count + " agents are waiting on you"
    horizontalMargin: 7.5
    onPressed: function () { root.togglePanel() }
  }
}
