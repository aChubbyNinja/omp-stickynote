QT += core gui quick network
CONFIG += c++17 release link_pkgconfig
CONFIG -= app_bundle
TEMPLATE = app
TARGET = omp-stickynote-overlay
VERSION = 1.4.0
DEFINES += OVERLAY_VERSION=\\\"$$VERSION\\\"
PKGCONFIG += wayland-client
LIBS += -lLayerShellQtInterface
SOURCES += src/main.cpp src/overlay.cpp src/desktopstate.cpp
HEADERS += src/overlay.h src/desktopstate.h

# qmake does not otherwise rebuild existing objects when only a define changes.
version_dependency.target = main.o
version_dependency.depends = $$PWD/omp-stickynote-overlay.pro
QMAKE_EXTRA_TARGETS += version_dependency
