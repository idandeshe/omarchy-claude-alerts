import QtQuick
import qs.Commons
import qs.Ui

// The list behind the bar badge: which agents are waiting, what each wants,
// and how long it has been stuck. Clicking a row focuses that project's
// window and drops it from the list — the fastest path from "something needs
// me" to actually being there.
Panel {
  id: root
  moduleName: "idan.claude-alerts"
  ipcTarget: "idan.claude-alerts"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property var waiting: hostWidget ? hostWidget.waiting : []
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Ticks only while the panel is open, so idle cost is nil.
  property double now: Date.now()

  function open() { root.now = Date.now(); root.controller.show() }
  function openFromHotkey() { root.open() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? root.close() : root.open() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function elapsed(since) {
    var started = Date.parse(String(since || ""))
    if (isNaN(started)) return ""
    var secs = Math.max(0, Math.round((root.now - started) / 1000))
    if (secs < 60) return secs + "s"
    if (secs < 3600) return Math.floor(secs / 60) + "m"
    return Math.floor(secs / 3600) + "h"
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.opened
    onTriggered: root.now = Date.now()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(4)

        PanelSectionHeader {
          text: "WAITING ON YOU"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Item { width: 1; height: Style.space(2) }

        Repeater {
          model: root.waiting

          Rectangle {
            id: row
            required property var modelData

            width: parent.width
            height: Style.space(46)
            radius: Style.space(6)
            color: hover.hovered ? Qt.rgba(1, 1, 1, 0.07) : "transparent"

            HoverHandler { id: hover }

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: root.hostWidget && root.hostWidget.focusProject(row.modelData.project)
            }

            Column {
              anchors.left: parent.left
              anchors.right: elapsedLabel.left
              anchors.leftMargin: Style.space(8)
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              // project, title and message are the agent's words, arriving
              // over the HTTP API — not ours. The default AutoText sniffs any
              // markup-shaped string and promotes it to rich text inside the
              // long-lived shell process, where the markup is honoured and
              // rich text can pull in resources it references. Every label here
              // is pinned to plain text, including the ones we compose.
              Text {
                width: parent.width
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: (row.modelData.project || "") + " — " + (row.modelData.title || "")
                color: row.modelData.level === "critical" ? "#e06c75" : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.space(13)
                font.bold: true
              }

              Text {
                width: parent.width
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: row.modelData.message || ""
                color: root.foreground
                opacity: 0.7
                font.family: root.fontFamily
                font.pixelSize: Style.space(11)
              }
            }

            Text {
              id: elapsedLabel
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: root.elapsed(row.modelData.since)
              color: root.foreground
              opacity: 0.5
              font.family: root.fontFamily
              font.pixelSize: Style.space(11)
            }
          }
        }

        Item { width: 1; height: Style.space(2) }

        // Plain primitives, matching the rows above, so the whole panel is built
        // from the same shapes.
        Rectangle {
          width: parent.width
          height: Style.space(28)
          radius: Style.space(6)
          color: clearHover.hovered ? Qt.rgba(1, 1, 1, 0.07) : "transparent"

          HoverHandler { id: clearHover }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: root.hostWidget && root.hostWidget.clearAll()
          }

          Text {
            anchors.centerIn: parent
            textFormat: Text.PlainText
            text: "Clear all"
            color: root.foreground
            opacity: 0.75
            font.family: root.fontFamily
            font.pixelSize: Style.space(12)
          }
        }
      }
    }
  }
}
