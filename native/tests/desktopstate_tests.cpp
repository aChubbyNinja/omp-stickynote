#include "desktopstate.h"
#include <QtTest>

namespace {
QJsonObject client(const char *address, qint64 pid, int workspace = 1, int focus = 1,
                   QRect rect = QRect(100, 100, 1000, 800))
{
    return {{"address", address}, {"pid", pid}, {"workspace", QJsonObject{{"id", workspace}}},
            {"monitor", 0}, {"mapped", true}, {"hidden", false}, {"visible", true},
            {"focusHistoryID", focus}, {"at", QJsonArray{rect.x(), rect.y()}},
            {"size", QJsonArray{rect.width(), rect.height()}}};
}
QJsonObject monitor(int active = 1, int special = 0)
{
    return {{"id", 0}, {"x", 0}, {"y", 0}, {"width", 3840}, {"height", 2160},
            {"scale", 2}, {"transform", 0}, {"dpmsStatus", true},
            {"activeWorkspace", QJsonObject{{"id", active}}},
            {"specialWorkspace", QJsonObject{{"id", special}}}};
}
}

class DesktopStateTests : public QObject {
    Q_OBJECT
private slots:
    void ownershipUsesNearestAncestorNotFocus()
    {
        auto unrelated = client("unrelated", 99, 1, 0);
        const auto owner = DesktopState::findOwner({unrelated, client("terminal", 20), client("outer", 10)}, {30, 20, 10});
        QVERIFY(owner.error.isEmpty());
        QCOMPARE(owner.client.value("address").toString(), QString("terminal"));
        QVERIFY(DesktopState::findOwner({unrelated}, {30, 20, 10}).client.isEmpty());
    }

    void sharedTerminalServerPidIsRejected()
    {
        const auto owner = DesktopState::findOwner({client("a", 20), client("b", 20)}, {30, 20});
        QVERIFY(owner.client.isEmpty());
        QVERIFY(!owner.error.isEmpty());
    }

    void tiledFocusDoesNotHideOwner()
    {
        const auto owner = client("owner", 20, 1, 2, QRect(0, 0, 900, 1000));
        const auto tile = client("tile", 21, 1, 0, QRect(910, 0, 900, 1000));
        QVERIFY(DesktopState::isVisible(owner, monitor(), {owner, tile}));
    }

    void overlappingNewerFocusHidesOwner()
    {
        const auto owner = client("owner", 20, 1, 2);
        auto other = client("other", 21, 1, 0);
        QVERIFY(!DesktopState::isVisible(owner, monitor(), {owner, other}));
        other.insert("focusHistoryID", 3);
        QVERIFY(DesktopState::isVisible(owner, monitor(), {owner, other}));
        other.insert("hidden", true);
        other.insert("focusHistoryID", 0);
        QVERIFY(DesktopState::isVisible(owner, monitor(), {owner, other}));
    }

    void inactiveAndSpecialWorkspacesLeaveNoNotes()
    {
        const auto owner = client("owner", 20);
        QVERIFY(!DesktopState::isVisible(owner, monitor(2), {owner}));
        QVERIFY(!DesktopState::isVisible(owner, monitor(1, -99), {owner}));
        const auto special = client("special", 21, -99);
        QVERIFY(DesktopState::isVisible(special, monitor(1, -99), {special}));
        QVERIFY(!DesktopState::isVisible(special, monitor(), {special}));
        auto pinned = owner;
        pinned.insert("pinned", true);
        QVERIFY(DesktopState::isVisible(pinned, monitor(2), {pinned}));
        QVERIFY(!DesktopState::isVisible(pinned, monitor(2, -99), {pinned}));
    }

    void fullscreenAndUnmappedOwnersHide()
    {
        auto owner = client("owner", 20);
        auto fullscreen = client("fullscreen", 21, 1, 3, QRect(1200, 100, 500, 500));
        fullscreen.insert("fullscreen", 2);
        QVERIFY(!DesktopState::isVisible(owner, monitor(), {owner, fullscreen}));
        owner.insert("mapped", false);
        QVERIFY(!DesktopState::isVisible(owner, monitor(), {owner}));
        owner.insert("mapped", true);
        owner.insert("at", QJsonArray{-3000, 0});
        QVERIFY(!DesktopState::isVisible(owner, monitor(), {owner}));
    }

    void placementUsesRealCellScaleAndPadding()
    {
        const QRectF terminal(100, 200, 1200, 900);
        const auto right = DesktopState::placement(terminal, QSize(560, 600), 120, 10, 20, false, 29);
        QCOMPARE(right, QRectF(720, 176, 560, 600));
        const auto centered = DesktopState::placement(terminal, QSize(560, 600), 120, 10, 20, true, 29);
        QCOMPARE(centered, QRectF(420, 176, 560, 600));
        // A 30-row raster remains 600 pixels high when the viewport permits it.
        QCOMPARE(right.height(), 600.0);
        const auto scaled = DesktopState::placement(terminal, QSize(1120, 1200), 120, 20, 40, true, 58);
        QCOMPARE(scaled, centered);
    }

    void placementFitsOnlyTheActualViewport()
    {
        const QRectF terminal(0, 0, 500, 300);
        const auto rect = DesktopState::placement(terminal, QSize(560, 1000), 50, 10, 20, false, 29);
        QVERIFY(rect.width() <= terminal.width());
        QVERIFY(qAbs(rect.bottom() - terminal.bottom()) < .001);
        QVERIFY(rect.top() + 29 * rect.width() / 560 >= 0);
        QVERIFY(DesktopState::placement(terminal, QSize(), 50, 10, 20, false, 0).isEmpty());
    }

    void rotatedFractionalMonitorsUseLogicalCoordinates()
    {
        auto output = monitor();
        output.insert("x", -1440);
        output.insert("scale", 1.5);
        output.insert("transform", 1);
        QCOMPARE(DesktopState::monitorRect(output), QRectF(-1440, 0, 1440, 2560));
    }
};

QTEST_APPLESS_MAIN(DesktopStateTests)
#include "desktopstate_tests.moc"
