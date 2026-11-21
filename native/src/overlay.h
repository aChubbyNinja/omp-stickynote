#pragma once

#include <QImage>
#include <QJsonArray>
#include <QJsonObject>
#include <QLocalSocket>
#include <QObject>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QSocketNotifier>
#include <QTimer>
#include <QVector>
#include <memory>
#include <functional>

namespace LayerShellQt { class Window; }

class RasterItem final : public QQuickItem {
public:
    RasterItem(QQuickItem *parent, std::function<void()> onClick);
    void setImage(const QImage &image);
protected:
    QSGNode *updatePaintNode(QSGNode *old, UpdatePaintNodeData *) override;
    void mousePressEvent(QMouseEvent *event) override;
    void mouseReleaseEvent(QMouseEvent *event) override;
    void mouseUngrabEvent() override;
private:
    QImage m_image;
    bool m_dirty = true;
    bool m_pressed = false;
    std::function<void()> m_onClick;
};

class Overlay final : public QObject {
public:
    explicit Overlay(qint64 parentPid, QObject *parent = nullptr);
    ~Overlay() override;
    void start();

private:
    void fail(const QString &message);
    void readInput();
    void acceptFrame(const QJsonObject &frame);
    void scheduleRefresh();
    void refresh();
    void query(const QByteArray &command);
    void queryFinished();
    void retrySnapshot(const QString &diagnostic);
    void applyState();
    void createSurface(QScreen *screen);
    void announceReady();
    bool parentAlive() const;

    qint64 m_parentPid;
    QByteArray m_parentIdentity;
    QVector<qint64> m_ancestors;
    QString m_socketDirectory;
    QString m_ownerAddress;
    QJsonArray m_clients, m_monitors, m_pendingClients;
    QLocalSocket m_events, m_query;
    QByteArray m_reply, m_eventBuffer, m_input;
    QByteArray m_command;
    QTimer m_refreshTimer, m_debounce, m_queryDeadline, m_retryTimer, m_startupDeadline, m_parentTimer;
    std::unique_ptr<QSocketNotifier> m_stdinNotifier, m_parentNotifier;
    int m_pidfd = -1;
    bool m_querying = false, m_queryActive = false, m_snapshotValid = false;
    bool m_refreshPending = false, m_ready = false, m_failed = false;
    int m_snapshotAttempts = 0;
    bool m_stdinOpen = true, m_visible = false, m_centered = false;
    bool m_minimized = false, m_surfaceMinimized = false, m_restoreRequested = false;
    int m_columns = 0, m_transparentTop = 0;
    double m_cellWidth = 0, m_cellHeight = 0;
    QImage m_image, m_tile;
    std::unique_ptr<QQuickWindow> m_window;
    QPointer<QScreen> m_surfaceScreen;
    RasterItem *m_raster = nullptr;
    LayerShellQt::Window *m_layer = nullptr;
};

void protocolEvent(const QJsonObject &event);
