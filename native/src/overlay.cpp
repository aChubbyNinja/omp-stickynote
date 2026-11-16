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
#include <QScreen>
#include <QSGSimpleTextureNode>
#include <QSGTexture>
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

namespace {
constexpr qsizetype MaxFrameBytes = 32 * 1024 * 1024;

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
}

void protocolEvent(const QJsonObject &event)
{
    const auto json = QJsonDocument(event).toJson(QJsonDocument::Compact);
    std::fwrite(json.constData(), 1, size_t(json.size()), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

RasterItem::RasterItem(QQuickItem *parent) : QQuickItem(parent)
{
    setFlag(ItemHasContents);
    setClip(true);
}

void RasterItem::setImage(const QImage &image)
{
    m_image = image;
    m_dirty = true;
    update();
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

Overlay::Overlay(qint64 parentPid, QObject *parent) : QObject(parent), m_parentPid(parentPid)
{
    m_debounce.setSingleShot(true);
    m_debounce.setInterval(20);
    m_queryDeadline.setSingleShot(true);
    m_queryDeadline.setInterval(1500);
    m_startupDeadline.setSingleShot(true);
    m_startupDeadline.setInterval(5000);
    connect(&m_debounce, &QTimer::timeout, this, &Overlay::refresh);
    connect(&m_refreshTimer, &QTimer::timeout, this, &Overlay::scheduleRefresh);
    connect(&m_queryDeadline, &QTimer::timeout, this, [this] { fail(QStringLiteral("Hyprland IPC request timed out")); });
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
            if (m_ready && m_window && (event.startsWith("workspace>>") || event.startsWith("workspacev2>>")
                || event.startsWith("activespecial") || event.startsWith("fullscreen>>")
                || event.startsWith("closewindow>>")))
                m_window->hide();
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
    connect(&m_query, &QLocalSocket::connected, this, [this] { m_query.write(m_command); });
    connect(&m_query, &QLocalSocket::readyRead, this, [this] {
        m_reply += m_query.readAll();
        if (m_reply.size() > MaxFrameBytes)
            fail(QStringLiteral("Hyprland IPC response is too large"));
    });
    connect(&m_query, &QLocalSocket::disconnected, this, &Overlay::queryFinished);
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
    if (frame.value("op").toString() != "frame" || columns < 1 || columns > 100000
        || std::floor(columns) != columns || rows < 1 || rows > 100000 || std::floor(rows) != rows
        || !std::isfinite(cellWidth) || !std::isfinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0
        || !frame.value("visible").isBool() || !frame.value("centered").isBool()) {
        fail(QStringLiteral("Invalid frame fields"));
        return;
    }
    if (frame.contains("png")) {
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
        if (m_raster)
            m_raster->setImage(m_image);
    }
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
    query("j/clients");
}

void Overlay::query(const QByteArray &command)
{
    m_querying = true;
    m_command = command;
    m_reply.clear();
    m_queryDeadline.start();
    m_query.connectToServer(m_socketDirectory + "/.socket.sock");
}

void Overlay::queryFinished()
{
    if (m_failed || !m_querying)
        return;
    m_queryDeadline.stop();
    m_reply += m_query.readAll();
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(m_reply, &error);
    if (error.error != QJsonParseError::NoError || !document.isArray()) {
        fail(QStringLiteral("Invalid Hyprland %1 response").arg(QString::fromLatin1(m_command)));
        return;
    }
    if (m_command == "j/clients") {
        m_clients = document.array();
        // Reconnect outside the disconnected signal's stack.
        QTimer::singleShot(0, this, [this] { if (!m_failed) query("j/monitors"); });
        return;
    }
    m_monitors = document.array();
    m_querying = false;
    applyState();
    if (m_refreshPending) {
        m_refreshPending = false;
        scheduleRefresh();
    }
}

void Overlay::announceReady()
{
    if (m_ready || m_failed || !m_window || !m_window->isExposed())
        return;
    m_ready = true;
    m_startupDeadline.stop();
    protocolEvent({{"event", "ready"}});
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
    // Qt Wayland turns WindowTransparentForInput into an empty wl_region on
    // every surface commit, including remapping after a workspace switch.
    m_window->setFlags(Qt::Window | Qt::FramelessWindowHint | Qt::WindowDoesNotAcceptFocus
                       | Qt::WindowTransparentForInput | Qt::NoDropShadowWindowHint);
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
    m_raster = new RasterItem(m_window->contentItem());
    if (!m_image.isNull())
        m_raster->setImage(m_image);
    connect(m_window.get(), &QQuickWindow::sceneGraphError, this, [this](QQuickWindow::SceneGraphError, const QString &message) {
        fail(QStringLiteral("Qt Quick scene graph: %1").arg(message));
    });
    connect(m_window.get(), &QWindow::visibleChanged, this, [this](bool visible) {
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
    const auto rasterRect = DesktopState::placement(bounds, m_image.size(), m_columns,
                                                    m_cellWidth, m_cellHeight, m_centered, m_transparentTop);
    const auto clipped = rasterRect.intersected(bounds).intersected(DesktopState::monitorRect(monitor));
    const bool show = m_visible && !m_image.isNull() && !clipped.isEmpty()
        && DesktopState::isVisible(owner, monitor, m_clients);
    m_refreshTimer.setInterval(show ? 150 : 500);
    if (!show) {
        m_window->hide();
        return;
    }
    const auto output = DesktopState::monitorRect(monitor);
    const QPoint origin(int(std::floor(clipped.left())), int(std::floor(clipped.top())));
    const QSize size(int(std::ceil(clipped.right())) - origin.x(), int(std::ceil(clipped.bottom())) - origin.y());
    m_layer->setMargins(QMargins(origin.x() - int(output.left()), origin.y() - int(output.top()), 0, 0));
    m_layer->setDesiredSize(size);
    m_window->resize(size);
    m_raster->setPosition(rasterRect.topLeft() - origin);
    m_raster->setSize(rasterRect.size());
    m_raster->setVisible(true);
    m_window->show();
    m_window->update();
}
