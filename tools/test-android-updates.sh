#!/usr/bin/env bash
set -euo pipefail
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 17 installation}"
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"$JAVA_HOME/bin/javac" --release 17 -encoding UTF-8 -d "$work" \
    android/app/src/main/java/polka/mobile/ApkRelease.java test/android/ApkReleaseTest.java
"$JAVA_HOME/bin/java" -cp "$work" polka.mobile.ApkReleaseTest
