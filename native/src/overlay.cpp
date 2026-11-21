#include "overlay.h"
#include "desktopstate.h"

#include <LayerShellQt/Window>
#include <QBuffer>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QImageReader>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QMouseEvent>
#include <QPainter>
#include <QScreen>
#include <QSGSimpleTextureNode>
#include <QSGTexture>
#include <QStyleHints>
#include <QTransform>
#include <QThread>
#include <QtGui/qguiapplication_platform.h>
#include <wayland-client.h>

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <utility>

namespace {
constexpr qsizetype MaxFrameBytes = 32 * 1024 * 1024;
constexpr int MaxSnapshotAttempts = 3;

QByteArray processStat(qint64 pid)
{
    QFile file(QStringLiteral("/proc/%1/stat").arg(pid));
    if (!file.open(QIODevice::ReadOnly))
        return {};
    const auto stat = file.readAll();
    // The comm field may contain spaces and parentheses.
    return stat.mid(stat.lastIndexOf(')') + 2);
}

QByteArray identity(const QByteArray &stat)
{
    return stat.split(' ').value(19); // Field 22: starttime, after pid and comm.
}

bool hasLayerShell()
{
    auto *native = qGuiApp->nativeInterface<QNativeInterface::QWaylandApplication>();
    if (!native)
        return false;
    bool found = false;
    auto *registry = wl_display_get_registry(native->display());
    static const wl_registry_listener listener = {
        [](void *data, wl_registry *, uint32_t, const char *interface, uint32_t) {
            if (std::strcmp(interface, "zwlr_layer_shell_v1") == 0)
                *static_cast<bool *>(data) = true;
        },
        [](void *, wl_registry *, uint32_t) {}
    };
    wl_registry_add_listener(registry, &listener, &found);
    const int result = wl_display_roundtrip(native->display());
    wl_registry_destroy(registry);
    return result >= 0 && found;
}

QImage minimizedTile()
{
    QImage image(DesktopState::MinimizedTileSize, DesktopState::MinimizedTileSize,
                 QImage::Format_ARGB32_Premultiplied);
    image.fill(QColor("#ffe780"));
    QPainter painter(&image);
    painter.setPen(QColor("#b19a44"));
    painter.drawRect(0, 0, image.width() - 1, image.height() - 1);
    painter.setPen(Qt::NoPen);
    painter.setBrush(QColor("#fff2af"));
    painter.drawPolygon(QPolygon{{20, 0}, {27, 7}, {20, 7}});
    painter.setPen(QPen(QColor("#756124"), 2));
    painter.drawLine(9, 15, 19, 15);
    painter.drawLine(14, 10, 14, 20);
    return image;
}
}

void protocolEvent(const QJsonObject &event)
{
    const auto json = QJsonDocument(event).toJson(QJsonDocument::Compact);
    std::fwrite(json.constData(), 1, size_t(json.size()), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

RasterItem::RasterItem(QQuickItem *parent, std::function<void()> onClick)
    : QQuickItem(parent), m_onClick(std::move(onClick))
{
    setFlag(ItemHasContents);
    setClip(true);
}

void RasterItem::setImage(const QImage &image)
{
    if (m_image.cacheKey() == image.cacheKey())
        return;
    m_image = image;
    m_imageRegion = {};
    // Half-opacity excludes the blurred shadow without rectangularizing the
    // rounded, transformed paper or its foldout. Storage is bounded by the PNG.
    for (int y = 0; y < image.height(); ++y) {
        const auto *pixels = reinterpret_cast<const QRgb *>(image.constScanLine(y));
        int start = -1;
        for (int x = 0; x <= image.width(); ++x) {
            const bool paper = x < image.width() && qAlpha(pixels[x]) >= 128;
            if (paper && start < 0)
                start = x;
            if (!paper && start >= 0) {
                m_imageRegion += QRect(start, y, x - start, 1);
                start = -1;
            }
        }
    }
    updateInputRegion();
    m_dirty = true;
    update();
}

void RasterItem::setInteraction(Interaction interaction)
{
    if (m_interaction == interaction)
        return;
    resetGesture();
    m_interaction = interaction;
    setAcceptedMouseButtons(interaction == Interaction::Disabled ? Qt::NoButton : Qt::LeftButton);
    updateInputRegion();
}

void RasterItem::resetGesture()
{
    m_pressed = false;
    m_firstClick = false;
    m_doublePressed = false;
}

void RasterItem::updateInputRegion()
{
    if (m_interaction == Interaction::Tile) {
        m_inputRegion = QRegion(boundingRect().toAlignedRect());
    } else if (m_interaction == Interaction::Paper && !m_image.isNull()) {
        QTransform scale;
        scale.scale(width() / m_image.width(), height() / m_image.height());
        m_inputRegion = scale.map(m_imageRegion).intersected(boundingRect().toAlignedRect());
    } else {
        m_inputRegion = {};
    }
}

bool RasterItem::contains(const QPointF &point) const
{
    return boundingRect().contains(point)
        && m_inputRegion.contains(QPoint(int(std::floor(point.x())), int(std::floor(point.y()))));
}

void RasterItem::geometryChange(const QRectF &newGeometry, const QRectF &oldGeometry)
{
    QQuickItem::geometryChange(newGeometry, oldGeometry);
    if (newGeometry.size() != oldGeometry.size())
        updateInputRegion();
}

void RasterItem::itemChange(ItemChange change, const ItemChangeData &data)
{
    QQuickItem::itemChange(change, data);
    if ((change == ItemVisibleHasChanged || change == ItemEnabledHasChanged) && !data.boolValue)
        resetGesture();
}

QSGNode *RasterItem::updatePaintNode(QSGNode *old, UpdatePaintNodeData *)
{
    auto *node = static_cast<QSGSimpleTextureNode *>(old);
    if (m_image.isNull()) {
        delete node;
        return nullptr;
    }
    if (!node) {
        node = new QSGSimpleTextureNode;
        node->setOwnsTexture(true);
        m_dirty = true;
    }
    if (m_dirty) {
        auto *texture = window()->createTextureFromImage(m_image);
        node->setTexture(texture);
        node->setFiltering(QSGTexture::Linear);
        m_dirty = false;
    }
    node->setRect(boundingRect());
    return node;
}

void RasterItem::mousePressEvent(QMouseEvent *event)
{
    m_pressed = m_interaction != Interaction::Disabled && isVisible()
        && window() && window()->isVisible() && event->button() == Qt::LeftButton
        && contains(event->position());
    event->setAccepted(m_pressed);
    if (!m_pressed) {
        resetGesture();
        return;
    }
    m_pressPosition = event->globalPosition();
    const auto *hints = QGuiApplication::styleHints();
    const QPointF distance = m_pressPosition - m_firstPosition;
    m_doublePressed = m_firstClick && event->timestamp() >= m_firstTimestamp
        && std::abs(distance.x()) <= hints->mouseDoubleClickDistance()
        && event->timestamp() - m_firstTimestamp <= ulong(hints->mouseDoubleClickInterval())
        && std::abs(distance.y()) <= hints->mouseDoubleClickDistance();
    m_firstClick = false;
    if (!m_doublePressed)
        m_firstTimestamp = event->timestamp();
}

void RasterItem::mouseDoubleClickEvent(QMouseEvent *event)
{
    // Qt Quick can deliver both the second press and a double-click event for
    // that press. Do not overwrite the completed first-click candidate twice.
    if (!m_pressed)
        mousePressEvent(event);
    else
        event->accept();
}

void RasterItem::mouseMoveEvent(QMouseEvent *event)
{
    if (m_pressed && (!contains(event->position())
        || (event->globalPosition() - m_pressPosition).manhattanLength()
            > QGuiApplication::styleHints()->startDragDistance()))
        resetGesture();
    event->accept();
}

void RasterItem::mouseReleaseEvent(QMouseEvent *event)
{
    const bool clicked = m_pressed && isVisible() && window() && window()->isVisible()
        && event->button() == Qt::LeftButton && contains(event->position())
        && (event->globalPosition() - m_pressPosition).manhattanLength()
            <= QGuiApplication::styleHints()->startDragDistance();
    const bool activate = clicked && (m_interaction == Interaction::Tile || m_doublePressed);
    m_pressed = false;
    event->setAccepted(clicked);
    if (activate) {
        resetGesture();
        m_onClick();
    } else if (clicked) {
        m_firstClick = true;
        m_firstPosition = m_pressPosition;
    } else {
        resetGesture();
    }
}

void RasterItem::mouseUngrabEvent()
{
    // Qt releases its implicit mouse grab after every normal release too.
    if (m_pressed)
        resetGesture();
}

Overlay::Overlay(qint64 parentPid, QObject *parent) : QObject(parent), m_parentPid(parentPid)
{
    m_debounce.setSingleShot(true);
    m_debounce.setInterval(20);
    m_queryDeadline.setSingleShot(true);
    m_queryDeadline.setInterval(1500);
    m_retryTimer.setSingleShot(true);
    m_startupDeadline.setSingleShot(true);
    m_startupDeadline.setInterval(5000);
    connect(&m_debounce, &QTimer::timeout, this, &Overlay::refresh);
    connect(&m_refreshTimer, &QTimer::timeout, this, &Overlay::scheduleRefresh);
    connect(&m_retryTimer, &QTimer::timeout, this, [this] { query("j/clients"); });
    connect(&m_queryDeadline, &QTimer::timeout, this, [this] {
        retrySnapshot(QStringLiteral("Hyprland %1 response timed out (%2 bytes)")
                          .arg(QString::fromLatin1(m_command)).arg(m_reply.size()));
    });
    connect(&m_startupDeadline, &QTimer::timeout, this, [this] {
        fail(m_ownerAddress.isEmpty() ? QStringLiteral("No Hyprland window belongs to the OMP process ancestry")
                                    : QStringLiteral("Layer-shell surface did not initialize"));
    });
    connect(&m_events, &QLocalSocket::connected, this, &Overlay::scheduleRefresh);
    connect(&m_events, &QLocalSocket::readyRead, this, [this] {
        m_eventBuffer += m_events.readAll();
        qsizetype end;
        while ((end = m_eventBuffer.indexOf('\n')) >= 0) {
            const auto event = m_eventBuffer.left(end);
            m_eventBuffer.remove(0, end + 1);
            // Hide immediately during transitions; the next snapshot decides
            // whether the owner remains visible, without changing compositor state.
            if (event.startsWith("workspace>>") || event.startsWith("workspacev2>>")
                || event.startsWith("activespecial") || event.startsWith("fullscreen>>")
                || event.startsWith("closewindow>>")) {
                m_snapshotValid = false;
                if (m_window)
                    m_window->hide();
            }
            scheduleRefresh();
        }
        if (m_eventBuffer.size() > 1024 * 1024)
            fail(QStringLiteral("Invalid Hyprland event stream"));
    });
    connect(&m_events, &QLocalSocket::errorOccurred, this, [this](QLocalSocket::LocalSocketError) {
        fail(QStringLiteral("Hyprland event socket: %1").arg(m_events.errorString()));
    });
    connect(&m_events, &QLocalSocket::disconnected, this, [this] {
        fail(QStringLiteral("Hyprland event socket closed"));
    });
    connect(&m_query, &QLocalSocket::connected, this, [this] {
        // Hyprland reads one short command, without a newline or NUL, then
        // closes the connection to delimit its reply.
        if (m_query.write(m_command) != m_command.size())
            fail(QStringLiteral("Cannot write the Hyprland IPC request"));
    });
    connect(&m_query, &QLocalSocket::readyRead, this, [this] {
        if (!m_queryActive || m_failed)
            return;
        m_reply += m_query.readAll();
        if (m_reply.size() > MaxFrameBytes)
            fail(QStringLiteral("Hyprland IPC response is too large"));
    });
    // QLocalSocket still unwinds its underlying socket's disconnect handling
    // after this signal. Drain and reconnect only once that stack has returned.
    connect(&m_query, &QLocalSocket::disconnected, this, &Overlay::queryFinished, Qt::QueuedConnection);
    connect(&m_query, &QLocalSocket::errorOccurred, this, [this](QLocalSocket::LocalSocketError error) {
        if (error != QLocalSocket::PeerClosedError)
            fail(QStringLiteral("Hyprland command socket: %1").arg(m_query.errorString()));
    });
    m_parentTimer.setInterval(250);
    connect(&m_parentTimer, &QTimer::timeout, this, [this] {
        if (!parentAlive())
            QCoreApplication::quit();
    });
}

Overlay::~Overlay()
{
    m_stdinNotifier.reset();
    m_parentNotifier.reset();
    if (m_pidfd >= 0)
        ::close(m_pidfd);
}

bool Overlay::parentAlive() const
{
    const auto stat = processStat(m_parentPid);
    return !stat.isEmpty() && stat[0] != 'Z' && identity(stat) == m_parentIdentity;
}

void Overlay::start()
{
    m_parentIdentity = identity(processStat(m_parentPid));
    if (m_parentIdentity.isEmpty() || !parentAlive()) {
        fail(QStringLiteral("OMP parent process does not exist"));
        return;
    }
    qint64 pid = m_parentPid;
    while (pid > 1 && !m_ancestors.contains(pid)) {
        m_ancestors.append(pid);
        pid = processStat(pid).split(' ').value(1).toLongLong();
    }
    const auto signature = qEnvironmentVariable("HYPRLAND_INSTANCE_SIGNATURE");
    const auto runtime = qEnvironmentVariable("XDG_RUNTIME_DIR");
    if (signature.isEmpty() || signature.contains('/') || runtime.isEmpty()) {
        fail(QStringLiteral("HYPRLAND_INSTANCE_SIGNATURE and XDG_RUNTIME_DIR are required"));
        return;
    }
    m_socketDirectory = runtime + "/hypr/" + signature;
    if (!hasLayerShell()) {
        fail(QStringLiteral("The Wayland compositor does not provide wlr-layer-shell"));
        return;
    }
#ifdef SYS_pidfd_open
    m_pidfd = int(::syscall(SYS_pidfd_open, pid_t(m_parentPid), 0));
#endif
    if (m_pidfd >= 0) {
        m_parentNotifier = std::make_unique<QSocketNotifier>(m_pidfd, QSocketNotifier::Read, this);
        connect(m_parentNotifier.get(), &QSocketNotifier::activated, this, [] { QCoreApplication::quit(); });
    }
    // Also verify starttime so an exit during pidfd_open cannot bind a reused PID.
    m_parentTimer.start();
    const int flags = ::fcntl(STDIN_FILENO, F_GETFL);
    if (flags < 0 || ::fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) {
        fail(QStringLiteral("Cannot read the frame protocol from stdin"));
        return;
    }
    m_stdinNotifier = std::make_unique<QSocketNotifier>(STDIN_FILENO, QSocketNotifier::Read, this);
    connect(m_stdinNotifier.get(), &QSocketNotifier::activated, this, &Overlay::readInput);
    m_startupDeadline.start();
    m_refreshTimer.start(250);
    m_events.connectToServer(m_socketDirectory + "/.socket2.sock", QIODevice::ReadOnly);
}

void Overlay::fail(const QString &message)
{
    if (m_failed || !m_stdinOpen)
        return;
    m_failed = true;
    if (m_window)
        m_window->hide();
    protocolEvent({{"event", "error"}, {"message", message}});
    std::fprintf(stderr, "omp-stickynote-overlay: %s\n", qPrintable(message));
    QCoreApplication::exit(1);
}

void Overlay::readInput()
{
    char buffer[65536];
    for (;;) {
        const ssize_t count = ::read(STDIN_FILENO, buffer, sizeof buffer);
        if (count == 0) {
            m_stdinOpen = false;
            m_stdinNotifier->setEnabled(false);
            QCoreApplication::quit();
            return;
        }
        if (count < 0) {
            if (errno == EINTR)
                continue;
            if (errno != EAGAIN && errno != EWOULDBLOCK)
                fail(QStringLiteral("Reading frame protocol failed"));
            return;
        }
        m_input.append(buffer, qsizetype(count));
        qsizetype end;
        while ((end = m_input.indexOf('\n')) >= 0) {
            if (end > MaxFrameBytes) {
                fail(QStringLiteral("Frame protocol line is too large"));
                return;
            }
            QJsonParseError error;
            const auto document = QJsonDocument::fromJson(m_input.left(end), &error);
            m_input.remove(0, end + 1);
            if (error.error != QJsonParseError::NoError || !document.isObject()) {
                fail(QStringLiteral("Invalid frame JSON"));
                return;
            }
            acceptFrame(document.object());
            if (m_failed)
                return;
        }
        if (m_input.size() > MaxFrameBytes) {
            fail(QStringLiteral("Frame protocol line is too large"));
            return;
        }
    }
}

void Overlay::acceptFrame(const QJsonObject &frame)
{
    const double columns = frame.value("columns").toDouble();
    const double rows = frame.value("rows").toDouble();
    const double cellWidth = frame.value("cellWidthPx").toDouble();
    const double cellHeight = frame.value("cellHeightPx").toDouble();
    const bool minimized = frame.value("minimized").toBool();
    const double scene = frame.value("scene").toDouble(-1);
    if (frame.value("op").toString() != "frame" || columns < 1 || columns > 100000
        || std::floor(columns) != columns || rows < 1 || rows > 100000 || std::floor(rows) != rows
        || !std::isfinite(cellWidth) || !std::isfinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0
        || !frame.value("visible").isBool() || !frame.value("centered").isBool()
        || !frame.value("minimized").isBool() || !std::isfinite(scene)
        || scene < 0 || scene > 9007199254740991.0 || std::floor(scene) != scene) {
        fail(QStringLiteral("Invalid frame fields"));
        return;
    }
    if (quint64(scene) != m_scene) {
        m_scene = quint64(scene);
        m_actionRequested = false;
        if (m_raster)
            m_raster->resetGesture();
    }
    if (minimized != m_minimized) {
        // Never resurrect a pre-minimize PNG while the current raster is pending.
        m_image = {};
        m_transparentTop = 0;
        m_actionRequested = false;
    }
    m_minimized = minimized;
    if (m_minimized && m_tile.isNull())
        m_tile = minimizedTile();
    if (!m_minimized && frame.contains("png")) {
        if (!frame.value("png").isString()) {
            fail(QStringLiteral("Frame PNG must be base64 text"));
            return;
        }
        const auto decoded = QByteArray::fromBase64Encoding(frame.value("png").toString().toLatin1(), QByteArray::AbortOnBase64DecodingErrors);
        if (!decoded) {
            fail(QStringLiteral("Invalid base64 frame PNG"));
            return;
        }
        QBuffer buffer;
        buffer.setData(decoded.decoded);
        buffer.open(QIODevice::ReadOnly);
        QImageReader reader(&buffer, "png");
        const QSize size = reader.size();
        if (size.isEmpty() || size.width() > 16384 || size.height() > 16384
            || qint64(size.width()) * size.height() > 32 * 1024 * 1024) {
            fail(QStringLiteral("Invalid or oversized frame PNG"));
            return;
        }
        QImage image = reader.read();
        if (image.isNull()) {
            fail(QStringLiteral("Cannot decode frame PNG: %1").arg(reader.errorString()));
            return;
        }
        m_image = image.convertToFormat(QImage::Format_ARGB32_Premultiplied);
        m_transparentTop = 0;
        for (int y = 0; y < m_image.height(); ++y) {
            const auto *pixels = reinterpret_cast<const QRgb *>(m_image.constScanLine(y));
            bool ink = false;
            for (int x = 0; x < m_image.width(); ++x) {
                if (qAlpha(pixels[x]) != 0) {
                    ink = true;
                    break;
                }
            }
            if (ink)
                break;
            ++m_transparentTop;
        }
    }
    if (m_raster)
        m_raster->setImage(m_minimized ? m_tile : m_image);
    m_columns = int(columns);
    m_cellWidth = cellWidth;
    m_cellHeight = cellHeight;
    m_centered = frame.value("centered").toBool();
    m_visible = frame.value("visible").toBool();
    applyState();
}

void Overlay::scheduleRefresh()
{
    if (!m_failed && !m_debounce.isActive())
        m_debounce.start();
}

void Overlay::refresh()
{
    if (m_failed || m_events.state() != QLocalSocket::ConnectedState)
        return;
    if (m_querying) {
        m_refreshPending = true;
        return;
    }
    m_snapshotAttempts = 1;
    query("j/clients");
}

void Overlay::query(const QByteArray &command)
{
    if (m_failed)
        return;
    m_querying = true;
    m_queryActive = true;
    m_command = command;
    m_reply.clear();
    // One deadline covers both halves of the snapshot, not each connection.
    if (command == "j/clients")
        m_queryDeadline.start();
    m_query.connectToServer(m_socketDirectory + "/.socket.sock");
}

void Overlay::queryFinished()
{
    if (m_failed || !m_queryActive)
        return;
    m_queryActive = false;
    m_reply += m_query.readAll();
    if (m_reply.size() > MaxFrameBytes) {
        fail(QStringLiteral("Hyprland IPC response is too large"));
        return;
    }
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(m_reply, &error);
    if (error.error != QJsonParseError::NoError || !document.isArray()) {
        retrySnapshot(QStringLiteral("Invalid Hyprland %1 response (%2 bytes, JSON error %3: %4, offset %5, root %6)")
                          .arg(QString::fromLatin1(m_command)).arg(m_reply.size())
                          .arg(int(error.error)).arg(error.errorString()).arg(error.offset)
                          .arg(document.isObject() ? QStringLiteral("object") : QStringLiteral("none")));
        return;
    }
    auto entries = document.array();
    for (const auto &entry : entries) {
        if (!entry.isObject()) {
            retrySnapshot(QStringLiteral("Invalid Hyprland %1 response (%2 bytes, non-object array entry)")
                              .arg(QString::fromLatin1(m_command)).arg(m_reply.size()));
            return;
        }
    }
    if (m_command == "j/clients") {
        m_pendingClients = std::move(entries);
        if (!m_ownerAddress.isEmpty()) {
            bool found = false;
            for (const auto &entry : m_pendingClients) {
                if (entry.toObject().value("address").toString() == m_ownerAddress) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                retrySnapshot(QStringLiteral("Hyprland clients snapshot omits the owner (%1 bytes)").arg(m_reply.size()));
                return;
            }
        }
        query("j/monitors");
        return;
    }
    m_queryDeadline.stop();
    // Publish a pair together. Frames arriving between requests must never
    // combine new clients with an old monitor layout.
    m_clients = std::move(m_pendingClients);
    m_monitors = std::move(entries);
    m_snapshotValid = true;
    m_querying = false;
    applyState();
    if (m_refreshPending) {
        m_refreshPending = false;
        scheduleRefresh();
    }
}

void Overlay::retrySnapshot(const QString &diagnostic)
{
    if (m_failed)
        return;
    m_snapshotValid = false;
    if (m_window)
        m_window->hide();
    m_queryDeadline.stop();
    m_queryActive = false;
    m_query.abort();
    m_pendingClients = {};
    if (m_snapshotAttempts >= MaxSnapshotAttempts) {
        fail(QStringLiteral("%1; failed after %2 snapshot attempts").arg(diagnostic).arg(m_snapshotAttempts));
        return;
    }
    const int delay = 50 * m_snapshotAttempts;
    std::fprintf(stderr, "omp-stickynote-overlay: %s; retrying snapshot %d/%d in %d ms\n",
                 qPrintable(diagnostic), m_snapshotAttempts + 1, MaxSnapshotAttempts, delay);
    ++m_snapshotAttempts;
    // Keep m_querying set while backing off so event/poll refreshes cannot
    // bypass the retry limit. The startup deadline remains independent.
    m_retryTimer.start(delay);
}

void Overlay::announceReady()
{
    if (m_ready || m_failed || !m_window || !m_window->isExposed())
        return;
    m_ready = true;
    m_startupDeadline.stop();
    protocolEvent({{"event", "ready"}, {"protocol", 3}});
    applyState();
}

void Overlay::createSurface(QScreen *screen)
{
    m_window.reset();
    m_window = std::make_unique<QQuickWindow>();
    m_window->setScreen(screen);
    m_surfaceScreen = screen;
    m_window->setColor(Qt::transparent);
    m_window->setTitle(QStringLiteral("OMP sticky note"));
    m_window->setFlags(Qt::Window | Qt::FramelessWindowHint | Qt::WindowDoesNotAcceptFocus
                       | Qt::NoDropShadowWindowHint);
    // A nonempty region outside the bootstrap surface accepts no pointer input.
    m_surfaceMask = QRegion(-1, -1, 1, 1);
    m_window->setMask(m_surfaceMask);
    m_layer = LayerShellQt::Window::get(m_window.get());
    m_layer->setScope(QStringLiteral("omp-stickynote-%1-%2").arg(m_parentPid).arg(::getpid()));
    m_layer->setLayer(LayerShellQt::Window::LayerOverlay);
    m_layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorTop) | LayerShellQt::Window::AnchorLeft);
    // -1 reserves no space and ignores panels' exclusive zones: coordinates
    // are relative to the output origin, as Hyprland IPC reports them.
    m_layer->setExclusiveZone(-1);
    m_layer->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityNone);
    m_layer->setActivateOnShow(false);
    m_layer->setScreen(screen);
    m_layer->setCloseOnDismissed(false);
    m_raster = new RasterItem(m_window->contentItem(), [this] {
        if (!m_visible || !m_snapshotValid || m_actionRequested
            || !m_window || !m_window->isVisible())
            return;
        m_actionRequested = true;
        m_window->hide();
        protocolEvent({{"event", m_minimized ? "restore" : "minimize"}, {"scene", qint64(m_scene)}});
    });
    m_raster->setInteraction(m_minimized ? RasterItem::Interaction::Tile : RasterItem::Interaction::Paper);
    m_raster->setImage(m_minimized ? m_tile : m_image);
    connect(m_window.get(), &QQuickWindow::sceneGraphError, this, [this](QQuickWindow::SceneGraphError, const QString &message) {
        fail(QStringLiteral("Qt Quick scene graph: %1").arg(message));
    });
    connect(m_window.get(), &QWindow::visibleChanged, this, [this](bool visible) {
        if (!visible && m_raster)
            m_raster->resetGesture();
        if (visible)
            QTimer::singleShot(0, this, &Overlay::announceReady);
    });
    connect(m_window.get(), &QWindow::visibilityChanged, this, [this] {
        QTimer::singleShot(0, this, &Overlay::announceReady);
    });
    connect(m_window.get(), &QQuickWindow::frameSwapped, this, &Overlay::announceReady, Qt::QueuedConnection);
    if (!m_ready) {
        m_window->resize(1, 1);
        m_layer->setDesiredSize(QSize(1, 1));
        m_raster->setVisible(false);
        m_window->show();
    }
}

void Overlay::applyState()
{
    if (m_failed)
        return;
    if (!m_snapshotValid) {
        if (m_window)
            m_window->hide();
        return;
    }
    QJsonObject owner;
    if (m_ownerAddress.isEmpty()) {
        const auto result = DesktopState::findOwner(m_clients, m_ancestors);
        if (!result.error.isEmpty()) {
            fail(result.error);
            return;
        }
        owner = result.client;
        m_ownerAddress = owner.value("address").toString();
    } else {
        for (const auto &entry : m_clients) {
            if (entry.toObject().value("address").toString() == m_ownerAddress) {
                owner = entry.toObject();
                break;
            }
        }
        if (owner.isEmpty()) {
            if (m_window)
                m_window->hide();
            QCoreApplication::quit();
            return;
        }
    }
    if (owner.isEmpty())
        return;
    QJsonObject monitor;
    for (const auto &entry : m_monitors) {
        if (entry.toObject().value("id") == owner.value("monitor")) {
            monitor = entry.toObject();
            break;
        }
    }
    QScreen *screen = nullptr;
    for (auto *candidate : QGuiApplication::screens()) {
        if (candidate->name() == monitor.value("name").toString()) {
            screen = candidate;
            break;
        }
    }
    if (!screen) {
        if (m_window)
            m_window->hide();
        return;
    }
    if (!m_window || m_surfaceScreen != screen)
        createSurface(screen);
    if (!m_ready)
        return;
    const auto bounds = DesktopState::clientRect(owner);
    const auto rasterRect = m_minimized
        ? DesktopState::minimizedPlacement(bounds, m_columns, m_cellWidth, m_cellHeight)
        : DesktopState::placement(bounds, m_image.size(), m_columns,
                                  m_cellWidth, m_cellHeight, m_centered, m_transparentTop);
    const auto clipped = rasterRect.intersected(bounds).intersected(DesktopState::monitorRect(monitor));
    const bool show = m_visible && !m_actionRequested && (m_minimized || !m_image.isNull()) && !clipped.isEmpty()
        && DesktopState::isVisible(owner, monitor, m_clients);
    m_refreshTimer.setInterval(show ? 150 : 500);
    if (!show) {
        m_window->hide();
        return;
    }
    const auto output = DesktopState::monitorRect(monitor);
    const QPoint origin(int(std::floor(clipped.left())), int(std::floor(clipped.top())));
    const QSize size(int(std::ceil(clipped.right())) - origin.x(), int(std::ceil(clipped.bottom())) - origin.y());
    if (bounds != m_gestureBounds)
        m_raster->resetGesture();
    m_gestureBounds = bounds;
    m_layer->setMargins(QMargins(origin.x() - int(output.left()), origin.y() - int(output.top()), 0, 0));
    m_layer->setDesiredSize(size);
    m_window->resize(size);
    m_raster->setPosition(rasterRect.topLeft() - origin);
    m_raster->setSize(rasterRect.size());
    m_raster->setInteraction(m_minimized ? RasterItem::Interaction::Tile : RasterItem::Interaction::Paper);
    QRegion mask = m_raster->inputRegion().translated(m_raster->position().toPoint())
        .intersected(QRect(QPoint(), size));
    // An empty QWindow mask restores input to the entire surface. Keep drawing
    // faded paper while a nonempty, off-surface region makes it click-through.
    if (mask.isEmpty())
        mask = QRegion(-1, -1, 1, 1);
    if (mask != m_surfaceMask) {
        m_surfaceMask = mask;
        m_window->setMask(mask);
    }
    m_raster->setVisible(true);
    m_window->show();
    m_window->update();
}
