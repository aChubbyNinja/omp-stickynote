#include "overlay.h"
#include <QtTest>
#include <QPainter>
#include <QStyleHints>

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
        m_item->setInteraction(RasterItem::Interaction::Tile);
        QImage paper(28, 28, QImage::Format_ARGB32_Premultiplied);
        paper.fill(Qt::yellow);
        m_item->setImage(paper);
        connect(m_window.get(), &QWindow::visibleChanged, m_item, [this](bool visible) {
            if (!visible)
                m_item->resetGesture();
        });
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

    void hiddenAndDisabledItemsDoNotRestore()
    {
        m_item->setVisible(false);
        click();
        m_item->setVisible(true);
        m_item->setInteraction(RasterItem::Interaction::Disabled);
        click();
        QCOMPARE(m_clicks, 0);
    }

    void paperSingleClicksDoNotMinimize()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        QCOMPARE(m_clicks, 0);
        click(QPoint(24, 24), QGuiApplication::styleHints()->mouseDoubleClickInterval() + 1);
        QCOMPARE(m_clicks, 0);
    }

    void paperDoubleClickMinimizesOnceAndTripleDoesNotRepeat()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        QTest::mouseDClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24), 10);
        QCOMPARE(m_clicks, 1);
        click();
        QCOMPARE(m_clicks, 1);
        QVERIFY(!m_item->hasActiveFocus());
        QVERIFY(m_window->flags().testFlag(Qt::WindowDoesNotAcceptFocus));
    }

    void distantClicksDoNotPair()
    {
        m_window->resize(250, 80);
        m_item->setSize(QSizeF(220, 28));
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click(QPoint(24, 24));
        click(QPoint(24 + QGuiApplication::styleHints()->mouseDoubleClickDistance() + 1, 24));
        QCOMPARE(m_clicks, 0);
    }

    void dragAndReturnDoNotCountAsClick()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        QTest::mousePress(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24), 10);
        QTest::mouseMove(m_window.get(), QPoint(60, 24), 10);
        QTest::mouseMove(m_window.get(), QPoint(24, 24), 10);
        QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24), 10);
        click();
        QCOMPARE(m_clicks, 0);
    }

    void hiddenWindowCancelsClickSequence()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        m_window->hide();
        m_window->show();
        QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));
        click();
        QCOMPARE(m_clicks, 0);
    }

    void hiddenItemCancelsClickSequence()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        m_item->setVisible(false);
        m_item->setVisible(true);
        click();
        QCOMPARE(m_clicks, 0);
    }

    void sceneResetCancelsClickSequence()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        m_item->resetGesture();
        click();
        QCOMPARE(m_clicks, 0);
    }

    void tileTransitionsDoNotLeakPaperClickSequence()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        m_item->setInteraction(RasterItem::Interaction::Tile);
        click();
        QCOMPARE(m_clicks, 1);
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        QCOMPARE(m_clicks, 1);
        click();
        QCOMPARE(m_clicks, 2);
    }

    void transitionDuringPressDoesNotActivateReplacement()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        QTest::mousePress(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24), 10);
        m_item->setInteraction(RasterItem::Interaction::Tile);
        QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24), 10);
        QCOMPARE(m_clicks, 0);
        click();
        QCOMPARE(m_clicks, 1);
    }

    void rasterAndPoseUpdatesPreserveDoubleClickSequence()
    {
        m_item->setInteraction(RasterItem::Interaction::Paper);
        click();
        QImage next(28, 28, QImage::Format_ARGB32_Premultiplied);
        next.fill(Qt::green);
        m_item->setImage(next);
        m_item->setPosition(QPointF(11, 11));
        m_item->setSize(QSizeF(27, 27));
        click();
        QCOMPARE(m_clicks, 1);
    }

    void guttersShadowAndRoundedCornersAreOutsidePaperMask()
    {
        QImage image(28, 28, QImage::Format_ARGB32_Premultiplied);
        image.fill(Qt::transparent);
        QPainter painter(&image);
        painter.fillRect(QRect(2, 2, 24, 24), QColor(0, 0, 0, 40));
        painter.setPen(Qt::NoPen);
        painter.setBrush(Qt::yellow);
        painter.drawRoundedRect(QRectF(5, 5, 18, 18), 5, 5);
        painter.end();
        m_item->setImage(image);
        m_item->setInteraction(RasterItem::Interaction::Paper);
        QVERIFY(!m_item->inputRegion().contains(QPoint(0, 14)));
        QVERIFY(!m_item->inputRegion().contains(QPoint(3, 14)));
        QVERIFY(!m_item->inputRegion().contains(QPoint(5, 5)));
        QVERIFY(m_item->inputRegion().contains(QPoint(14, 14)));
        QVERIFY(m_item->inputRegion().boundingRect().width() <= 18);
        QTest::mouseDClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(13, 24), 10);
        QCOMPARE(m_clicks, 0);
        QTest::mouseDClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, QPoint(24, 24), 10);
        QCOMPARE(m_clicks, 1);
    }

private:
    void click(QPoint position = QPoint(24, 24), int delay = 10)
    {
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, position, delay);
    }
    std::unique_ptr<QQuickWindow> m_window;
    RasterItem *m_item = nullptr;
    int m_clicks = 0;
};

QTEST_MAIN(OverlayTests)
#include "overlay_tests.moc"
