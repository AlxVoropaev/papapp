package polka.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static java.nio.charset.StandardCharsets.UTF_8;

/** Firebase Auth and Cloud Firestore transport for the native client. */
final class FirebaseRest {
    private static final String AUTH = "https://identitytoolkit.googleapis.com/v1/accounts:";
    private static final String TOKENS = "https://securetoken.googleapis.com/v1/token";
    private static final String FIRESTORE = "https://firestore.googleapis.com/v1/";

    private final String origin;
    private final String pairingServer;
    private final SharedPreferences credentials;
    private String apiKey;
    private String documents;
    private String refreshToken;
    private String idToken;
    private long expiresAt;
    private User user;

    FirebaseRest(Context context, String origin) {
        URI uri = URI.create(origin);
        String host = uri.getHost();
        if (host != null) host = host.toLowerCase(Locale.ROOT);
        if (!"https".equals(uri.getScheme()) || host == null || !host.endsWith(".web.app")
                || uri.getPort() != -1 || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("Expected a Firebase Hosting origin");
        }
        this.origin = "https://" + host;
        boolean familyProject = this.origin.equals(context.getString(R.string.firebase_origin));
        pairingServer = familyProject ? context.getString(R.string.pairing_server) : "";
        if (familyProject) {
            configure(context.getString(R.string.firebase_project_id), context.getString(R.string.firebase_api_key));
        }
        credentials = context.getSharedPreferences("firebase-native-" + host, Context.MODE_PRIVATE);
        refreshToken = credentials.getString("refreshToken", "");
        String uid = credentials.getString("uid", "");
        if (!refreshToken.isEmpty() && !uid.isEmpty()) {
            user = new User(uid, credentials.getBoolean("anonymous", false));
        }
    }

    User user() {
        return user;
    }

    boolean shortCodes() {
        return !pairingServer.isEmpty();
    }

    JSONObject pairing(String operation, JSONObject data, boolean authorize) throws Exception {
        URI url = URI.create(pairingServer + "/pairing/" + operation);
        String body = data.toString();
        String bearer = authorize ? idToken() : null;
        return WorkerDns.request(url, connection ->
            request(connection, "POST", body, "application/json", bearer, null, origin));
    }

    void signIn(String email, String password, boolean create) throws Exception {
        JSONObject credentials = json("email", email, "password", password, "returnSecureToken", true);
        acceptSignIn(auth(create ? "signUp" : "signInWithPassword", credentials), false);
    }

    void signInAnonymously() throws Exception {
        acceptSignIn(auth("signUp", json("returnSecureToken", true)), true);
    }

    void resetPassword(String email) throws Exception {
        auth("sendOobCode", json("requestType", "PASSWORD_RESET", "email", email));
    }

    void signOut() {
        user = null;
        idToken = null;
        refreshToken = "";
        expiresAt = 0;
        credentials.edit().clear().apply();
    }

    String idToken() throws Exception {
        if (user == null) throw new CatalogBackend.Failure(401, "Войдите в свою полку.");
        if (idToken == null || SystemClock.elapsedRealtime() >= expiresAt - 60_000) {
            initialize();
            try {
                JSONObject response = request(TOKENS + "?key=" + Uri.encode(apiKey), "POST",
                        "grant_type=refresh_token&refresh_token=" + Uri.encode(refreshToken),
                        "application/x-www-form-urlencoded", null, origin);
                if (!user.uid.equals(response.getString("user_id"))) {
                    signOut();
                    throw new CatalogBackend.Failure(401, "Войдите в свою полку снова.");
                }
                saveTokens(response.getString("id_token"), response.getString("refresh_token"), response.getLong("expires_in"));
            } catch (RemoteFailure error) {
                if (error.is("TOKEN_EXPIRED", "INVALID_REFRESH_TOKEN", "INVALID_GRANT", "USER_NOT_FOUND", "USER_DISABLED")) {
                    signOut();
                    throw new CatalogBackend.Failure(401, "Войдите в свою полку снова.");
                }
                throw error;
            }
        }
        return idToken;
    }

    Document get(String path) throws Exception {
        try {
            return new Document(firestore("/" + encodePath(path), "GET", null));
        } catch (RemoteFailure error) {
            if (error.status == 404) return null;
            throw error;
        }
    }

    List<Document> list(String path) throws Exception {
        List<Document> result = new ArrayList<>();
        String pageToken = "";
        do {
            String query = "/" + encodePath(path) + "?pageSize=100";
            if (!pageToken.isEmpty()) query += "&pageToken=" + Uri.encode(pageToken);
            JSONObject page = firestore(query, "GET", null);
            JSONArray rows = page.optJSONArray("documents");
            for (int i = 0; rows != null && i < rows.length(); i++) result.add(new Document(rows.getJSONObject(i)));
            pageToken = page.optString("nextPageToken", "");
        } while (!pageToken.isEmpty());
        return result;
    }

    void commit(JSONObject... writes) throws Exception {
        JSONArray operations = new JSONArray();
        for (JSONObject write : writes) operations.put(write);
        firestore(":commit", "POST", json("writes", operations));
    }

    JSONObject write(String path, JSONObject fields, JSONObject condition, boolean patch, String serverTimestamp) throws Exception {
        initialize();
        JSONObject encoded = new JSONObject();
        JSONArray names = new JSONArray();
        var keys = fields.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            names.put(key);
            encoded.put(key, encodeField(fields.get(key)));
        }
        JSONObject write = json("update", json("name", documents + "/" + path, "fields", encoded));
        if (patch) write.put("updateMask", json("fieldPaths", names));
        if (condition != null) write.put("currentDocument", condition);
        if (serverTimestamp != null) {
            write.put("updateTransforms", new JSONArray().put(json("fieldPath", serverTimestamp,
                    "setToServerValue", "REQUEST_TIME")));
        }
        return write;
    }

    void delete(String path) throws Exception {
        initialize();
        commit(json("delete", documents + "/" + path));
    }

    void increment(String path, String field, boolean requireExisting) throws Exception {
        initialize();
        JSONObject write = json("transform", json("document", documents + "/" + path, "fieldTransforms",
                new JSONArray().put(json("fieldPath", field, "increment", json("integerValue", "1")))));
        if (requireExisting) write.put("currentDocument", json("exists", true));
        commit(write);
    }

    static JSONObject json(Object... pairs) throws JSONException {
        JSONObject result = new JSONObject();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }

    private void initialize() throws Exception {
        if (apiKey != null) return;
        JSONObject config = request(origin + "/__/firebase/init.json", "GET", null, null, null, null);
        String project = config.optString("projectId");
        String key = config.optString("apiKey");
        if (!project.matches("[a-z0-9-]+") || !key.matches("[A-Za-z0-9_-]+")) {
            throw new CatalogBackend.Failure(503, "Не загрузилась конфигурация Firebase.");
        }
        configure(project, key);
    }

    private void configure(String project, String key) {
        documents = "projects/" + project + "/databases/(default)/documents";
        apiKey = key;
    }

    private JSONObject auth(String operation, JSONObject data) throws Exception {
        initialize();
        return request(AUTH + operation + "?key=" + Uri.encode(apiKey), "POST", data.toString(),
                "application/json", null, origin);
    }

    private void acceptSignIn(JSONObject response, boolean anonymous) throws JSONException {
        User newUser = new User(response.getString("localId"), anonymous);
        String token = response.getString("idToken");
        String refresh = response.getString("refreshToken");
        long expiresIn = response.getLong("expiresIn");
        user = newUser;
        saveTokens(token, refresh, expiresIn);
    }

    private void saveTokens(String token, String refresh, long expiresIn) {
        idToken = token;
        refreshToken = refresh;
        expiresAt = SystemClock.elapsedRealtime() + 1000 * expiresIn;
        credentials.edit().putString("uid", user.uid).putBoolean("anonymous", user.anonymous)
                .putString("refreshToken", refresh).apply();
    }

    private JSONObject firestore(String operation, String method, JSONObject data) throws Exception {
        String token = idToken();
        String url = FIRESTORE + documents + operation;
        String body = data == null ? null : data.toString();
        try {
            return request(url, method, body, "application/json", token, null);
        } catch (RemoteFailure error) {
            if (error.status != 401) throw error;
            idToken = null;
            return request(url, method, body, "application/json", idToken(), null);
        }
    }

    private static String encodePath(String path) {
        return Uri.encode(path, "/");
    }

    private static JSONObject request(String url, String method, String body, String contentType,
                                      String bearer, String referer) throws IOException, JSONException {
        return request(url, method, body, contentType, bearer, referer, null);
    }

    private static JSONObject request(String url, String method, String body, String contentType,
                                      String bearer, String referer, String origin) throws IOException, JSONException {
        return request((HttpURLConnection) URI.create(url).toURL().openConnection(), method,
                body, contentType, bearer, referer, origin);
    }

    private static JSONObject request(HttpURLConnection connection, String method, String body, String contentType,
                                      String bearer, String referer, String origin) throws IOException, JSONException {
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
            if (referer != null) connection.setRequestProperty("Referer", referer + "/");
            if (origin != null) connection.setRequestProperty("Origin", origin);
            if (body != null) {
                byte[] bytes = body.getBytes(UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", contentType);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (var output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            boolean success = status >= 200 && status < 300;
            var stream = success ? connection.getInputStream() : connection.getErrorStream();
            String response = "";
            if (stream != null) {
                try (stream; var output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = stream.read(buffer)) != -1) {
                        if (output.size() + count > 16 * 1024 * 1024) throw new IOException("Response too large");
                        output.write(buffer, 0, count);
                    }
                    response = new String(output.toByteArray(), UTF_8);
                }
            }
            if (success) return response.isEmpty() ? new JSONObject() : new JSONObject(response);
            throw new RemoteFailure(status, errorCode(response));
        } finally {
            connection.disconnect();
        }
    }

    private static String errorCode(String response) {
        try {
            JSONObject error = new JSONObject(response).getJSONObject("error");
            String message = error.optString("message");
            if (message.matches("[A-Z][A-Z_]+( : [\\s\\S]*)?")) return message.split(" : ", 2)[0];
            return error.optString("status");
        } catch (JSONException ignored) {
            return "";
        }
    }

    private static JSONObject encodeField(Object value) throws JSONException {
        if (value == JSONObject.NULL) return json("nullValue", JSONObject.NULL);
        if (value instanceof String) return json("stringValue", value);
        if (value instanceof Boolean) return json("booleanValue", value);
        if (value instanceof Integer || value instanceof Long) return json("integerValue", value.toString());
        if (value instanceof JSONArray) {
            JSONArray source = (JSONArray) value;
            JSONArray encoded = new JSONArray();
            for (int i = 0; i < source.length(); i++) encoded.put(encodeField(source.get(i)));
            return json("arrayValue", json("values", encoded));
        }
        throw new JSONException("Unsupported Firestore field value");
    }

    private static Object decodeField(JSONObject field) throws JSONException {
        if (field.has("stringValue")) return field.getString("stringValue");
        if (field.has("integerValue")) return field.getLong("integerValue");
        if (field.has("booleanValue")) return field.getBoolean("booleanValue");
        if (field.has("timestampValue")) {
            try {
                return Instant.parse(field.getString("timestampValue")).toEpochMilli();
            } catch (DateTimeParseException ignored) {
                return 0L;
            }
        }
        JSONObject array = field.optJSONObject("arrayValue");
        if (array != null) {
            JSONArray values = array.optJSONArray("values");
            JSONArray decoded = new JSONArray();
            for (int i = 0; values != null && i < values.length(); i++) decoded.put(decodeField(values.getJSONObject(i)));
            return decoded;
        }
        return JSONObject.NULL;
    }

    static final class Document {
        final JSONObject fields = new JSONObject();
        final String id;
        final String updateTime;

        Document(JSONObject raw) throws JSONException {
            String name = raw.getString("name");
            id = name.substring(name.lastIndexOf('/') + 1);
            updateTime = raw.getString("updateTime");
            JSONObject encoded = raw.optJSONObject("fields");
            if (encoded == null) return;
            var keys = encoded.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                fields.put(key, decodeField(encoded.getJSONObject(key)));
            }
        }
    }

    static final class User {
        final String uid;
        final boolean anonymous;

        User(String uid, boolean anonymous) {
            this.uid = uid;
            this.anonymous = anonymous;
        }
    }

    static final class RemoteFailure extends IOException {
        final int status;
        final String code;

        RemoteFailure(int status, String code) {
            super(code);
            this.status = status;
            this.code = code;
        }

        boolean is(String... codes) {
            for (String candidate : codes) if (code.equals(candidate)) return true;
            return false;
        }

        boolean conflict() {
            return status == 409 || is("FAILED_PRECONDITION");
        }
    }
}
