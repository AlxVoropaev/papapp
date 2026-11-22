package polka.mobile;

import android.content.SharedPreferences;
import android.net.Uri;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;

import static java.nio.charset.StandardCharsets.UTF_8;

/** Native client for the development SQLite server. */
final class LocalCatalog {
    private final URI endpoint;
    private final SharedPreferences preferences;
    private final String cookieKey;

    LocalCatalog(URI endpoint, SharedPreferences preferences) {
        this.endpoint = endpoint;
        this.preferences = preferences;
        cookieKey = "localSession:" + endpoint;
    }

    JSONObject request(String path, String method, JSONObject data) throws Exception {
        String[] parts = path.split("/", 2);
        String apiPath = "api/" + parts[0] + (parts.length == 2 ? "/" + Uri.encode(parts[1]) : "");
        var connection = (HttpURLConnection) endpoint.resolve(apiPath).toURL().openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Origin", endpoint.getScheme() + "://" + endpoint.getAuthority());
            String cookie = preferences.getString(cookieKey, "");
            if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            if (data != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = data.toString().getBytes(UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (var output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            String issued = connection.getHeaderField("Set-Cookie");
            if (issued != null && issued.startsWith("polka=")) {
                String value = issued.split(";", 2)[0];
                var editor = preferences.edit();
                if (value.equals("polka=")) editor.remove(cookieKey);
                else editor.putString(cookieKey, value);
                editor.apply();
            }
            var input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            JSONObject result = new JSONObject();
            if (input != null) {
                try (input; var output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 16 * 1024 * 1024) throw new IOException("Response too large");
                        output.write(buffer, 0, count);
                    }
                    if (output.size() > 0) result = new JSONObject(new String(output.toByteArray(), UTF_8));
                }
            }
            if (status >= 200 && status < 300) return result;
            throw new Failure(status, result.optString("error", "Не удалось выполнить действие."));
        } finally {
            connection.disconnect();
        }
    }

    static final class Failure extends IOException {
        final int status;

        Failure(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
