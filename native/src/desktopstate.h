#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QRectF>
#include <QSize>
#include <QVector>

namespace DesktopState {
struct Owner {
    QJsonObject client;
    QString error;
};

// Ancestors are ordered from OMP towards init. Ambiguous terminal-server PIDs
// must fail instead of silently attaching to another terminal window.
Owner findOwner(const QJsonArray &clients, const QVector<qint64> &ancestors);
QRectF clientRect(const QJsonObject &client);
QRectF monitorRect(const QJsonObject &monitor);
bool isVisible(const QJsonObject &owner, const QJsonObject &monitor, const QJsonArray &clients);
constexpr int MinimizedTileSize = 28;
QRectF minimizedPlacement(const QRectF &client, int columns, double cellWidth, double cellHeight);
QRectF placement(const QRectF &client, const QSize &image, int columns,
                 double cellWidth, double cellHeight, bool centered, int transparentTop);
}
