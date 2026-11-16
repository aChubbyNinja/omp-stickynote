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

namespace LayerShellQt { class Window; }

class RasterItem final : public QQuickItem {
public:
    explicit RasterItem(QQuickItem *parent);
    void setImage(const QImage &image);
protected:
    QSGNode *updatePaintNode(QSGNode *old, UpdatePaintNodeData *) override;
private:
    QImage m_image;
    bool m_dirty = true;
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
    void applyState();
    void createSurface(QScreen *screen);
    void announceReady();
    bool parentAlive() const;

    qint64 m_parentPid;
    QByteArray m_parentIdentity;
    QVector<qint64> m_ancestors;
    QString m_socketDirectory;
    QString m_ownerAddress;
    QJsonArray m_clients, m_monitors;
    QLocalSocket m_events, m_query;
    QByteArray m_reply, m_eventBuffer, m_input;
    QByteArray m_command;
    QTimer m_refreshTimer, m_debounce, m_queryDeadline, m_startupDeadline, m_parentTimer;
    std::unique_ptr<QSocketNotifier> m_stdinNotifier, m_parentNotifier;
    int m_pidfd = -1;
    bool m_querying = false, m_refreshPending = false, m_ready = false, m_failed = false;
    bool m_stdinOpen = true, m_visible = false, m_centered = false;
    int m_columns = 0, m_transparentTop = 0;
    double m_cellWidth = 0, m_cellHeight = 0;
    QImage m_image;
    std::unique_ptr<QQuickWindow> m_window;
    QPointer<QScreen> m_surfaceScreen;
    RasterItem *m_raster = nullptr;
    LayerShellQt::Window *m_layer = nullptr;
};

void protocolEvent(const QJsonObject &event);
