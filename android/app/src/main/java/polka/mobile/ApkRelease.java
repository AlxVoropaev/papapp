package polka.mobile;

import java.net.URI;

/** Validation shared by download and installation; independent of Android for regression tests. */
final class ApkRelease {
    static final long MAX_BYTES = 50L * 1024 * 1024;
    final long versionCode;
    final String versionName;
    final URI url;
    final long size;
    final String sha256;

    ApkRelease(long versionCode, String versionName, String url, long size, String sha256, boolean debug) {
        if (versionCode < 1 || versionName == null || versionName.length() > 80
                || size < 1 || size > MAX_BYTES || sha256 == null || !sha256.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("Invalid APK release");
        }
        this.url = checkedUrl(url, debug);
        this.versionCode = versionCode;
        this.versionName = versionName;
        this.size = size;
        this.sha256 = sha256;
    }

    static URI checkedUrl(String value, boolean debug) {
        URI uri = URI.create(value);
        boolean local = "http".equals(uri.getScheme()) && debug
            && ("10.0.2.2".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost()));
        if (!("https".equals(uri.getScheme()) || local) || uri.getHost() == null
                || uri.getUserInfo() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("APK updates require HTTPS");
        }
        return uri;
    }
}
