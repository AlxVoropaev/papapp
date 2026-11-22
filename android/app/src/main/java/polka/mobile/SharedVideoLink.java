package polka.mobile;

import java.net.URI;
import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Pattern;

/** Extract a supported video link without opening URLs or reading shared files. */
final class SharedVideoLink {
    private static final Pattern LINK = Pattern.compile("https?://[^\\s<>\"'“”]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern SCHEME = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);
    private static final Pattern VIDEO_ID = Pattern.compile("[A-Za-z0-9_-]{11}");
    private static final Pattern VIDEO_PATH = Pattern.compile("/(?:shorts|embed|live)/([A-Za-z0-9_-]{11})/?");

    static String find(CharSequence text) {
        if (text == null) return null;
        var match = LINK.matcher(text);
        while (match.find()) {
            String candidate = match.group().replaceAll("[,.;!?)\\]»]+$", "");
            if (youtubeId(candidate) != null) return candidate;
        }
        return null;
    }

    static String youtubeId(String input) {
        if (input == null || input.length() > 2048) return null;
        String link = input.trim();
        if (!SCHEME.matcher(link).find()) link = "https://" + link;
        try {
            URI uri = URI.create(link);
            if (uri.getHost() == null || uri.getUserInfo() != null || uri.getPort() != -1) return null;
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            String path = uri.getRawPath();
            if ("youtu.be".equals(host)) return path.isEmpty() ? null : validId(path.substring(1).split("/", -1)[0]);
            if (!("youtube.com".equals(host) || "www.youtube.com".equals(host)
                || "m.youtube.com".equals(host) || "music.youtube.com".equals(host))) return null;
            if ("/watch".equals(path) && uri.getRawQuery() != null) {
                for (String part : uri.getRawQuery().split("&")) {
                    String[] pair = part.split("=", 2);
                    if ("v".equals(URLDecoder.decode(pair[0], "UTF-8"))) {
                        return pair.length == 2 ? validId(URLDecoder.decode(pair[1], "UTF-8")) : null;
                    }
                }
            }
            var match = VIDEO_PATH.matcher(path);
            return match.matches() ? match.group(1) : null;
        } catch (IllegalArgumentException | java.io.UnsupportedEncodingException ignored) {
            return null;
        }
    }

    private static String validId(String id) {
        return VIDEO_ID.matcher(id).matches() ? id : null;
    }
}
