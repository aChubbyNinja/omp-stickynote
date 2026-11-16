QT += core testlib
QT -= gui
CONFIG += c++17 testcase console
TEMPLATE = app
TARGET = desktopstate_tests
INCLUDEPATH += ../src
HEADERS += ../src/desktopstate.h
SOURCES += desktopstate_tests.cpp ../src/desktopstate.cpp
