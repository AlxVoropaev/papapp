package polka.mobile;

public final class ApkReleaseTest {
    private static int checks;
    private static void reject(Runnable action) {
        checks++;
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Invalid release accepted");
    }

    public static void main(String[] args) {
        String hash = "a".repeat(64);
        new ApkRelease(3, "0.3.0", "https://example.com/app.apk", 123, hash, false);
        new ApkRelease(3, "0.3.0", "http://10.0.2.2/app.apk", 123, hash, true);
        reject(() -> new ApkRelease(0, "x", "https://example.com/a.apk", 1, hash, false));
        reject(() -> new ApkRelease(1, "x", "https://example.com/a.apk", 0, hash, false));
        reject(() -> new ApkRelease(1, "x", "https://example.com/a.apk", ApkRelease.MAX_BYTES + 1, hash, false));
        reject(() -> new ApkRelease(1, "x", "https://example.com/a.apk", 1, "bad", false));
        reject(() -> ApkRelease.checkedUrl("http://example.com/app.apk", false));
        reject(() -> ApkRelease.checkedUrl("http://example.com/app.apk", true));
        reject(() -> ApkRelease.checkedUrl("https://user:password@example.com/app.apk", false));
        reject(() -> ApkRelease.checkedUrl("https://example.com/app.apk#fragment", false));
        reject(() -> ApkRelease.checkedUrl("file:///tmp/app.apk", true));
        var disk = new ApkRelease(3, "0.3.0", "https://disk.yandex.ru/d/example", 123, hash, false);
        disk.useDiskPath("/papina-polka-v3.apk");
        reject(() -> disk.useDiskPath("/../secret.apk"));
        reject(() -> disk.useDiskPath("/latest.json"));
        var direct = new ApkRelease(3, "0.3.0", "https://example.com/d/example", 123, hash, false);
        reject(() -> direct.useDiskPath("/app.apk"));
        System.out.println("APK release validation: " + checks + " rejection cases passed.");
    }
}
