#include "desktopstate.h"

#include <algorithm>
#include <cmath>

namespace {
int workspace(const QJsonObject &client) { return client.value("workspace").toObject().value("id").toInt(); }
int activeWorkspace(const QJsonObject &monitor) { return monitor.value("activeWorkspace").toObject().value("id").toInt(); }
int specialWorkspace(const QJsonObject &monitor) { return monitor.value("specialWorkspace").toObject().value("id").toInt(); }
bool mapped(const QJsonObject &client)
{
    return client.value("mapped").toBool() && !client.value("hidden").toBool()
        && client.value("visible").toBool(true);
}
bool onWorkspace(const QJsonObject &client, const QJsonObject &monitor)
{
    const int special = specialWorkspace(monitor);
    if (workspace(client) < 0)
        return special != 0 && workspace(client) == special;
    return special == 0 && (client.value("pinned").toBool() || workspace(client) == activeWorkspace(monitor));
}
}

DesktopState::Owner DesktopState::findOwner(const QJsonArray &clients, const QVector<qint64> &ancestors)
{
    for (const qint64 pid : ancestors) {
        QJsonObject match;
        for (const auto &entry : clients) {
            const auto client = entry.toObject();
            if (client.value("pid").toInteger() != pid)
                continue;
            if (!match.isEmpty())
                return {{}, QStringLiteral("Multiple terminal windows share ancestor PID %1; ownership is ambiguous").arg(pid)};
            match = client;
        }
        if (!match.isEmpty())
            return {match, {}};
    }
    return {};
}

QRectF DesktopState::clientRect(const QJsonObject &client)
{
    const auto at = client.value("at").toArray();
    const auto size = client.value("size").toArray();
    if (at.size() != 2 || size.size() != 2)
        return {};
    return {at[0].toDouble(), at[1].toDouble(), size[0].toDouble(), size[1].toDouble()};
}

QRectF DesktopState::monitorRect(const QJsonObject &monitor)
{
    const double scale = monitor.value("scale").toDouble(1);
    if (scale <= 0)
        return {};
    double width = monitor.value("width").toDouble();
    double height = monitor.value("height").toDouble();
    if (monitor.value("transform").toInt() % 2 != 0)
        std::swap(width, height);
    return {monitor.value("x").toDouble(), monitor.value("y").toDouble(), width / scale, height / scale};
}

bool DesktopState::isVisible(const QJsonObject &owner, const QJsonObject &monitor, const QJsonArray &clients)
{
    if (!mapped(owner) || monitor.value("disabled").toBool() || !monitor.value("dpmsStatus").toBool(true)
        || !onWorkspace(owner, monitor) || !clientRect(owner).intersects(monitorRect(monitor)))
        return false;

    const auto bounds = clientRect(owner).intersected(monitorRect(monitor));
    const int ownerFocus = owner.value("focusHistoryID").toInt(-1);
    for (const auto &entry : clients) {
        const auto other = entry.toObject();
        if (other.value("address") == owner.value("address") || !mapped(other))
            continue;
        // A fullscreen client suppresses the overlay even when its reported
        // geometry is stale during a compositor animation.
        const bool sameWorkspace = workspace(other) == workspace(owner)
            || (owner.value("pinned").toBool() && workspace(other) == activeWorkspace(monitor))
            || (other.value("pinned").toBool() && workspace(owner) >= 0);
        if (!sameWorkspace)
            continue;
        if (other.value("monitor").toInt() == monitor.value("id").toInt()
            && other.value("fullscreen").toInt() != 0 && owner.value("fullscreen").toInt() == 0)
            return false;
        const int focus = other.value("focusHistoryID").toInt(-1);
        if (focus >= 0 && (ownerFocus < 0 || focus < ownerFocus) && clientRect(other).intersects(bounds))
            return false;
    }
    return true;
}

QRectF DesktopState::placement(const QRectF &client, const QSize &image, int columns,
                               double cellWidth, double cellHeight, bool centered, int transparentTop)
{
    if (client.isEmpty() || image.isEmpty() || columns <= 0 || cellWidth <= 0 || cellHeight <= 0)
        return {};
    const double logicalCell = client.width() / columns;
    double scale = logicalCell / cellWidth;
    const double topGap = std::min(client.height() / 4, cellHeight * scale / 4);
    // Only the actual viewport limits a tall raster, never an arbitrary row cap.
    scale = std::min({scale, client.width() / image.width(),
                      (client.height() - topGap) / std::max(1, image.height() - transparentTop)});
    const double width = image.width() * scale;
    const double height = image.height() * scale;
    const double x = centered ? client.center().x() - width / 2
        : std::max(client.left(), client.right() - 2 * logicalCell - width);
    return {x, client.top() + topGap - transparentTop * scale, width, height};
}

QRectF DesktopState::minimizedPlacement(const QRectF &client, int columns, double cellWidth, double cellHeight)
{
    if (client.isEmpty() || columns <= 0 || cellWidth <= 0 || cellHeight <= 0)
        return {};
    // Integral logical-pixel bounds keep the input surface exactly coincident
    // with the paper square, without a transparent, mouse-blocking fringe.
    const QRectF aligned(QPointF(std::ceil(client.left()), std::ceil(client.top())),
                         QPointF(std::floor(client.right()), std::floor(client.bottom())));
    const double size = std::min({double(MinimizedTileSize), aligned.width(), aligned.height()});
    if (size <= 0)
        return {};
    const double logicalCell = client.width() / columns;
    const double topGap = std::min({client.height() / 4, cellHeight * logicalCell / cellWidth / 4,
                                    aligned.height() - size});
    return {std::max(aligned.left(), std::floor(aligned.right() - 2 * logicalCell - size)),
            std::max(aligned.top(), std::floor(aligned.top() + topGap)), size, size};
}
