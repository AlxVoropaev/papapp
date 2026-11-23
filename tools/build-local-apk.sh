#!/usr/bin/env bash
set -euo pipefail

: "${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT to Android SDK with API 35 and Build Tools 35.0.0}"
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 17 installation}"
cd "$(dirname "$0")/.."

root="$PWD"
mode="${1:---local}"
endpoint="${2:-}"
sdk="$ANDROID_SDK_ROOT"
build_tools="$sdk/build-tools/35.0.0"
version_code="${POLKA_VERSION_CODE:-$(sed -n 's/^versionCode=//p' android/version.properties)}"
version_name="${POLKA_VERSION_NAME:-$(sed -n 's/^versionName=//p' android/version.properties)}"
target_sdk="${POLKA_TEST_TARGET_SDK:-35}"
[[ "$target_sdk" =~ ^(2[6-9]|3[0-5])$ ]] || { printf 'Invalid target SDK\n' >&2; exit 2; }
[[ "$version_code" =~ ^[1-9][0-9]{0,8}$ ]] || { printf 'Invalid version code\n' >&2; exit 2; }
[[ "$version_name" =~ ^[0-9A-Za-z._-]{1,80}$ ]] || { printf 'Invalid version name\n' >&2; exit 2; }

case "$mode" in
    --local)
        task=assembleDebug
        variant=debug
        endpoint=""
        apk="$root/artifacts/papina-polka-local.apk"
        ;;
    --cloud)
        [ "$target_sdk" = 35 ] || { printf 'Target override is for local emulator tests only.\n' >&2; exit 2; }
        endpoint="${endpoint:-https://papina-polka-bec464.web.app}"
        [[ "$endpoint" =~ ^https://[a-z0-9-]+\.web\.app/?$ ]] || {
            printf 'Expected a Firebase Hosting URL (https://project.web.app).\n' >&2; exit 2;
        }
        task=assembleRelease
        variant=release
        apk="$root/artifacts/papina-polka.apk"
        export POLKA_TEST_LOCAL_UPDATES=0
        ;;
    *) printf 'Use --local or --cloud [https://project.web.app].\n' >&2; exit 2 ;;
esac

apk="${POLKA_APK_OUTPUT:-$apk}"
mkdir -p "$(dirname "$apk")" "$root/.tooling"
key="$root/.tooling/local-debug.keystore"
if [ ! -f "$key" ]; then
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$key" -storepass android \
        -keypass android -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" \
        -keyalg RSA -keysize 2048 -validity 10000
fi

gradle="${POLKA_GRADLE:-$root/android/gradlew}"
POLKA_BUILD_ENDPOINT="$endpoint" "$gradle" --project-dir "$root/android" ":app:$task"
cp "$root/android/app/build/outputs/apk/$variant/app-$variant.apk" "$apk"
"$build_tools/apksigner" verify --print-certs "$apk"
"$build_tools/aapt2" dump badging "$apk" | sed -n '1,15p'
printf 'APK: %s\n' "$apk"
