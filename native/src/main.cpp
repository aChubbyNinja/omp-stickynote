#include "overlay.h"

#include <QGuiApplication>
#include <QSurfaceFormat>
#include <QTimer>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <signal.h>
#include <sys/types.h>

int main(int argc, char **argv)
{
    if (argc == 2 && (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0)) {
        std::puts("Usage: omp-stickynote-overlay --parent-pid PID\n"
                  "Click-through Hyprland companion for OMP sticky notes; minimized tiles restore on left-click.\n"
                  "Reads newline-delimited frame JSON from stdin; exits on EOF or OMP death.\n"
                  "Options: --help, --version");
        return 0;
    }
    if (argc == 2 && std::strcmp(argv[1], "--version") == 0) {
        std::puts("omp-stickynote-overlay " OVERLAY_VERSION);
        return 0;
    }
    char *end = nullptr;
    errno = 0;
    const long long pid = argc == 3 ? std::strtoll(argv[2], &end, 10) : 0;
    if (argc != 3 || std::strcmp(argv[1], "--parent-pid") != 0 || errno != 0
        || !end || *end || pid <= 1 || pid > std::numeric_limits<pid_t>::max()) {
        const QString message = QStringLiteral("Expected --parent-pid with the owning OMP process PID; use --help");
        protocolEvent({{"event", "error"}, {"message", message}});
        std::fprintf(stderr, "%s\n", qPrintable(message));
        return 1;
    }
    ::signal(SIGPIPE, SIG_IGN);
    qputenv("QT_QPA_PLATFORM", "wayland");
    qputenv("QT_WAYLAND_DISABLE_WINDOWDECORATION", "1");
    qputenv("QT_FORCE_STDERR_LOGGING", "1");
    qInstallMessageHandler([](QtMsgType type, const QMessageLogContext &, const QString &message) {
        if (type == QtFatalMsg)
            protocolEvent({{"event", "error"}, {"message", message}});
        std::fprintf(stderr, "omp-stickynote-overlay: %s\n", qPrintable(message));
    });
    QSurfaceFormat format;
    format.setAlphaBufferSize(8);
    QSurfaceFormat::setDefaultFormat(format);
    QQuickWindow::setDefaultAlphaBuffer(true);
    QGuiApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("omp-stickynote-overlay"));
    app.setApplicationVersion(QStringLiteral(OVERLAY_VERSION));
    app.setDesktopFileName(QStringLiteral("omp-stickynote-overlay"));
    app.setQuitOnLastWindowClosed(false);
    Overlay overlay(pid);
    QTimer::singleShot(0, &overlay, &Overlay::start);
    return app.exec();
}
