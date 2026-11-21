#include "overlay.h"
#include <QtTest>

class OverlayTests : public QObject {
    Q_OBJECT
private slots:
    void init()
    {
        m_clicks = 0;
        m_window = std::make_unique<QQuickWindow>();
        m_window->setFlags(Qt::Window | Qt::WindowDoesNotAcceptFocus);
        m_window->resize(80, 80);
        m_item = new RasterItem(m_window->contentItem(), [this] { ++m_clicks; });
        m_item->setPosition(QPointF(10, 10));
        m_item->setSize(QSizeF(28, 28));
        m_item->setAcceptedMouseButtons(Qt::LeftButton);
        m_window->show();
        QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));
    }

    void cleanup()
    {
        m_window.reset();
        m_item = nullptr;
    }

    void leftClickRestoresWithoutTakingItemFocus()
    {
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24));
        QCOMPARE(m_clicks, 1);
        QVERIFY(!m_item->hasActiveFocus());
    }

    void otherButtonsAndOutsideClicksDoNotRestore()
    {
        QTest::mouseClick(m_window.get(), Qt::RightButton, Qt::NoModifier, QPoint(24, 24));
        QTest::mouseClick(m_window.get(), Qt::MiddleButton, Qt::NoModifier, QPoint(24, 24));
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(9, 24));
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(38, 24));
        QCOMPARE(m_clicks, 0);
    }

    void releaseOutsideAndPressOutsideDoNotRestore()
    {
        QTest::mousePress(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24));
        QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(60, 24));
        QTest::mousePress(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(60, 24));
        QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24));
        QCOMPARE(m_clicks, 0);
    }

    void hiddenAndExpandedItemsDoNotRestore()
    {
        m_item->setVisible(false);
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24));
        m_item->setVisible(true);
        m_item->setAcceptedMouseButtons(Qt::NoButton);
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24));
        QCOMPARE(m_clicks, 0);
    }

private:
    std::unique_ptr<QQuickWindow> m_window;
    RasterItem *m_item = nullptr;
    int m_clicks = 0;
};

QTEST_MAIN(OverlayTests)
#include "overlay_tests.moc"
