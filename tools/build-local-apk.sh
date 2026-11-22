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
platform="$sdk/platforms/android-35/android.jar"
source_dir="$root/android/app/src/main"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
version_code="${POLKA_VERSION_CODE:-$(sed -n 's/^versionCode=//p' android/version.properties)}"
version_name="${POLKA_VERSION_NAME:-$(sed -n 's/^versionName=//p' android/version.properties)}"
# A lower target is used only by the emulator regression test to exercise Android's confirmation fallback.
target_sdk="${POLKA_TEST_TARGET_SDK:-35}"
[[ "$target_sdk" =~ ^(2[6-9]|3[0-5])$ ]] || { printf 'Invalid target SDK\n' >&2; exit 2; }
[[ "$version_code" =~ ^[1-9][0-9]{0,8}$ ]] || { printf 'Invalid version code\n' >&2; exit 2; }
[[ "$version_name" =~ ^[0-9A-Za-z._-]{1,80}$ ]] || { printf 'Invalid version name\n' >&2; exit 2; }

mkdir -p "$work/r" "$work/classes" "$work/dex" "$root/artifacts" "$root/.tooling"
sed "s#<manifest #<manifest package=\"polka.mobile\" android:versionCode=\"$version_code\" android:versionName=\"$version_name\" #" \
    "$source_dir/AndroidManifest.xml" > "$work/AndroidManifest.xml"
cp -R "$source_dir/res" "$work/res"
if [ "$mode" = --local ] && [ "${POLKA_TEST_LOCAL_UPDATES:-0}" = 1 ]; then
    sed 's#\(<string name="apk_update_manifest"[^>]*>\)[^<]*#\1#' "$work/res/values/strings.xml" > "$work/strings.xml"
    mv "$work/strings.xml" "$work/res/values/strings.xml"
fi
case "$mode" in
    --local)
        sed 's#\(<string name="default_endpoint"[^>]*>\)[^<]*#\1#' "$work/res/values/strings.xml" > "$work/strings.xml"
        mv "$work/strings.xml" "$work/res/values/strings.xml"
        # The local build accepts HTTP for testing on a trusted Wi-Fi network.
        sed 's/android:usesCleartextTraffic="false"/android:usesCleartextTraffic="true" android:debuggable="true"/' \
            "$work/AndroidManifest.xml" > "$work/LocalManifest.xml"
        mv "$work/LocalManifest.xml" "$work/AndroidManifest.xml"
        apk="$root/artifacts/papina-polka-local.apk"
        ;;
    --cloud)
        [ "$target_sdk" = 35 ] || { printf 'Target override is for local emulator tests only.\n' >&2; exit 2; }
        if [ -n "$endpoint" ]; then
            if ! [[ "$endpoint" =~ ^https://[a-z0-9-]+\.web\.app/?$ ]]; then
                printf 'Expected a Firebase Hosting URL (https://project.web.app).\n' >&2
                exit 2
            fi
            sed "s#\(<string name=\"default_endpoint\"[^>]*>\)[^<]*#\1$endpoint#" \
                "$work/res/values/strings.xml" > "$work/strings.xml"
            mv "$work/strings.xml" "$work/res/values/strings.xml"
        fi
        apk="$root/artifacts/papina-polka.apk"
        ;;
    *) printf 'Use --local or --cloud [https://project.web.app].\n' >&2; exit 2 ;;
esac

apk="${POLKA_APK_OUTPUT:-$apk}"
mkdir -p "$(dirname "$apk")"

"$build_tools/aapt2" compile --dir "$work/res" -o "$work/resources.zip"
"$build_tools/aapt2" link -I "$platform" --manifest "$work/AndroidManifest.xml" \
    --min-sdk-version 26 --target-sdk-version "$target_sdk" --java "$work/r" -A "$source_dir/assets" \
    -o "$work/without-dex.apk" "$work/resources.zip"
"$JAVA_HOME/bin/javac" --release 17 -encoding UTF-8 -classpath "$platform" \
    -d "$work/classes" "$work/r/polka/mobile/R.java" \
    "$source_dir"/java/polka/mobile/*.java
"$JAVA_HOME/bin/jar" cf "$work/classes.jar" -C "$work/classes" .
"$build_tools/d8" --lib "$platform" --min-api 26 --output "$work/dex" "$work/classes.jar"
(cd "$work/dex" && zip -q "$work/without-dex.apk" classes.dex)
"$build_tools/zipalign" -f 4 "$work/without-dex.apk" "$work/aligned.apk"

key="$root/.tooling/local-debug.keystore"
if [ ! -f "$key" ]; then
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$key" -storepass android \
        -keypass android -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" \
        -keyalg RSA -keysize 2048 -validity 10000
fi
"$build_tools/apksigner" sign --ks "$key" --ks-key-alias androiddebugkey \
    --ks-pass pass:android --key-pass pass:android --v4-signing-enabled false \
    --out "$apk" "$work/aligned.apk"
"$build_tools/apksigner" verify --print-certs "$apk"
"$build_tools/aapt2" dump badging "$apk" | sed -n '1,15p'
printf 'APK: %s\n' "$apk"
