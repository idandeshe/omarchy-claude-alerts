import QtQuick
import Quickshell
import Quickshell.Io

// Owns the alert service process.
//
// Declared as the plugin's "service" kind so it runs whenever the plugin is
// enabled, whether or not the bar widget has been placed: the sound and the
// desktop notification are the point, and they must work with no badge on
// screen. The widget is the optional display half, and reads the same state
// file this process writes.
Item {
  id: root

  property var shell: null

  // file:///…/idan.claude-alerts/  ->  /…/idan.claude-alerts/
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")

  property int restarts: 0
  property double startedAt: 0
  property bool failed: false

  readonly property int maxRestarts: 5
  readonly property int settledMs: 60000

  Process {
    id: server
    running: true
    command: [root.pluginDir + "bin/claude-alerts-server"]

    onRunningChanged: if (running) root.startedAt = Date.now()

    stdout: SplitParser {
      onRead: function (line) { console.log("claude-alerts:", line) }
    }
    stderr: SplitParser {
      onRead: function (line) { console.warn("claude-alerts:", line) }
    }

    onExited: function (exitCode, exitStatus) {
      // A clean exit(0) is the service's own single-instance guard stepping
      // aside: another copy (a systemd unit, another shell) already owns the
      // port, so restarting would only fight it.
      //
      // The service also treats SIGTERM as a graceful exit(0), so `kill` on it
      // lands here too and deliberately stays down until the next shell
      // restart — a way to stop it by hand. A crash or a SIGKILL reports
      // otherwise and does get restarted. exitStatus is checked alongside
      // exitCode, the same test the shell's own Menu.qml uses.
      if (exitCode === 0 && exitStatus === 0) {
        console.log("claude-alerts: service exited cleanly; not restarting")
        return
      }

      // A process that ran a good while and then died is an incident, not a
      // broken install: let it have a fresh budget rather than counting it
      // toward a crash loop that started hours ago.
      if (Date.now() - root.startedAt > root.settledMs) root.restarts = 0

      if (root.restarts >= root.maxRestarts) {
        root.failed = true
        console.warn("claude-alerts: service failed " + root.maxRestarts +
                     " times, giving up. Run " + root.pluginDir +
                     "bin/claude-alerts-server by hand to see why.")
        return
      }

      root.restarts++
      console.warn("claude-alerts: service exited " + exitCode +
                   ", restart " + root.restarts + "/" + root.maxRestarts)
      restartTimer.start()
    }
  }

  Timer {
    id: restartTimer
    interval: 3000
    repeat: false
    onTriggered: server.running = true
  }
}
