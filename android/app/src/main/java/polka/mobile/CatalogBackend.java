package polka.mobile;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import static java.nio.charset.StandardCharsets.UTF_8;
import static polka.mobile.FirebaseRest.json;

/** Native catalog and household operations compatible with the web shelf. */
final class CatalogBackend {
    private static final String OTHER = "Другое";
    private static final List<String> DEFAULT_CATEGORIES = Arrays.asList("Наука", "Природа", "Мультфильмы", "Творчество", OTHER);
    private static final String CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final String INVALID_CODE = "Код недействителен. Проверьте его или попросите новый.";

    private final FirebaseRest firebase;
    private final SecureRandom random = new SecureRandom();
    private String family;

    CatalogBackend(Context context, String origin) {
        firebase = new FirebaseRest(context, origin);
    }

    synchronized String idToken() throws Exception {
        return firebase.idToken();
    }

    boolean shortCodes() {
        return firebase.shortCodes();
    }

    synchronized JSONObject request(String path, String method, JSONObject data) throws Exception {
        try {
            return dispatch(path, method, data == null ? new JSONObject() : data);
        } catch (FirebaseRest.RemoteFailure error) {
            throw translate(error);
        } catch (Failure error) {
            throw error;
        } catch (IOException error) {
            throw new Failure(503, "Не удалось связаться с полкой. Проверьте интернет и попробуйте ещё раз.");
        }
    }

    private JSONObject dispatch(String path, String method, JSONObject data) throws Exception {
        switch (method + " " + path) {
            case "GET session":
                return session();
            case "POST families":
                return createShelf(data);
            case "POST login":
                firebase.signIn(data.optString("email").trim(), data.optString("password"), false);
                family = null;
                return session();
            case "POST reset-password":
                try {
                    firebase.resetPassword(data.optString("email").trim());
                } catch (FirebaseRest.RemoteFailure error) {
                    if (!error.is("EMAIL_NOT_FOUND", "USER_NOT_FOUND")) throw error;
                }
                return ok();
            case "POST join":
                return join(data.optString("code"));
            case "POST logout":
                firebase.signOut();
                family = null;
                return ok();
            default:
                break;
        }
        FirebaseRest.User user = firebase.user();
        if (user == null || family == null) throw new Failure(401, "Войдите в свою полку.");
        String shelf = "families/" + family;
        if ("GET".equals(method)) {
            if ("categories".equals(path)) return json("categories", categories(shelf));
            if ("videos".equals(path)) {
                JSONArray videos = new JSONArray();
                List<FirebaseRest.Document> records = firebase.list(shelf + "/videos");
                records.sort(Comparator.comparingLong((FirebaseRest.Document video) -> video.fields.optLong("created", 0))
                        .thenComparing(video -> video.id).reversed());
                for (FirebaseRest.Document video : records) {
                    JSONObject fields = video.fields;
                    JSONObject row = json("id", video.id, "youtube", video.id, "title", fields.optString("title"),
                            "category", fields.optString("category", OTHER), "note", fields.optString("note"),
                            "created", fields.optLong("created", 0));
                    JSONArray tags = fields.optJSONArray("categories");
                    if (tags != null) row.put("categories", tags);
                    videos.put(row);
                }
                return json("videos", videos, "categories", categories(shelf));
            }
        }
        if (user.anonymous) throw new Failure(403, "Действие доступно только родителю.");
        switch (method + " " + path) {
            case "POST pair-code":
                return makeInvite(shelf);
            case "DELETE child-devices":
                return revokeChildren(shelf);
            case "POST categories":
                return changeCategory(shelf, null, method, data);
            case "POST videos":
                String id = SharedVideoLink.youtubeId(data.optString("url"));
                if (id == null) throw new Failure(400, "Вставьте ссылку на одно видео YouTube, Shorts или youtu.be.");
                return saveVideo(shelf, id, data, true);
            default:
                break;
        }
        if (path.matches("categories/[^/]+") && ("PATCH".equals(method) || "DELETE".equals(method))) {
            return changeCategory(shelf, path.substring(11), method, data);
        }
        if (path.matches("videos/[A-Za-z0-9_-]{11}")) {
            String id = path.substring(7);
            if ("PATCH".equals(method)) return saveVideo(shelf, id, data, false);
            if ("DELETE".equals(method)) {
                firebase.delete(shelf + "/videos/" + id);
                return ok();
            }
        }
        throw new Failure(404, "Действие не найдено.");
    }

    private JSONObject session() throws Exception {
        FirebaseRest.User user = firebase.user();
        if (user == null) throw new Failure(401, "Войдите в свою полку.");
        String candidate = user.uid;
        if (user.anonymous) {
            FirebaseRest.Document member = firebase.get("children/" + user.uid);
            if (member == null) throw new Failure(401, "Подключите полку по коду.");
            candidate = member.fields.getString("family");
        }
        return openShelf(user, candidate);
    }

    private JSONObject openShelf(FirebaseRest.User user, String candidate) throws Exception {
        FirebaseRest.Document shelf = firebase.get("families/" + candidate);
        if (shelf == null) throw new Failure(401, "Полка ещё не создана.");
        family = candidate;
        return json("family", family, "name", shelf.fields.getString("name"), "role", user.anonymous ? "child" : "parent");
    }

    private JSONObject createShelf(JSONObject data) throws Exception {
        String name = boundedText(data, "name", 60);
        String setupKey = data.optString("setupKey").trim();
        if (name.isEmpty() || setupKey.isEmpty()) throw new Failure(400, "Введите название и ключ создания.");
        String claim = sha256(setupKey);
        String email = data.optString("email").trim();
        String password = data.optString("password");
        try {
            firebase.signIn(email, password, true);
        } catch (FirebaseRest.RemoteFailure error) {
            if (!error.is("EMAIL_EXISTS")) throw error;
            firebase.signIn(email, password, false);
        }
        family = null;
        String uid = firebase.user().uid;
        String path = "families/" + uid;
        if (firebase.get(path) == null) {
            try {
                firebase.commit(
                        firebase.write("settings/owner", json("uid", uid, "claim", claim), json("exists", false), false, null),
                        firebase.write(path, json("name", name, "epoch", 1), json("exists", false), false, null));
            } catch (FirebaseRest.RemoteFailure error) {
                if (!error.conflict() && error.status != 403) throw error;
                if (firebase.get(path) == null) {
                    firebase.signOut();
                    throw new Failure(403, "Проверьте ключ создания. Для уже созданной полки используйте вход.");
                }
            }
        }
        return session();
    }

    private JSONObject join(String input) throws Exception {
        String code = input.toUpperCase(Locale.ROOT).replaceAll("[\\s\\p{Z}\\u0085\\uFEFF-]", "");
        if (shortCodes() && code.matches("[0-9]{6}")) {
            code = pairing("resolve", json("code", code), false).getString("invite");
        }
        if (!code.matches("[A-HJ-NP-Z2-9]{24}")) {
            throw new Failure(400, shortCodes() ? "Введите код подключения из 6 цифр." : "Введите код подключения из 24 символов.");
        }
        if (firebase.user() != null && !firebase.user().anonymous) firebase.signOut();
        if (firebase.user() == null) firebase.signInAnonymously();
        family = null;
        FirebaseRest.User user = firebase.user();
        String uid = user.uid;
        String path = "invites/" + code;
        FirebaseRest.Document invite;
        try {
            invite = firebase.get(path);
            if (invite != null) {
                firebase.commit(
                        firebase.write(path, json("claimedBy", uid), json("updateTime", invite.updateTime), true, null),
                        firebase.write("children/" + uid, json("family", invite.fields.getString("family"),
                                "epoch", invite.fields.getLong("epoch"), "invite", code), null, false, null));
            }
        } catch (FirebaseRest.RemoteFailure error) {
            if (error.status != 403 && !error.conflict()) throw error;
            return resumeJoin(user, code);
        }
        return invite == null ? resumeJoin(user, code) : session();
    }

    private JSONObject resumeJoin(FirebaseRest.User user, String code) throws Exception {
        // The first commit may have claimed the code before the client lost its response.
        FirebaseRest.Document member = firebase.get("children/" + user.uid);
        if (member != null && code.equals(member.fields.optString("invite"))) {
            try {
                return openShelf(user, member.fields.getString("family"));
            } catch (FirebaseRest.RemoteFailure error) {
                if (error.status != 403) throw error;
            }
        }
        throw new Failure(400, INVALID_CODE);
    }

    private JSONObject makeInvite(String shelf) throws Exception {
        for (int attempt = 0; attempt < 3; attempt++) {
            FirebaseRest.Document record = firebase.get(shelf);
            if (record == null) throw new Failure(401, "Полка ещё не создана.");
            long epoch = record.fields.getLong("epoch");
            StringBuilder generated = new StringBuilder(24);
            for (int i = 0; i < 24; i++) generated.append(CODE_ALPHABET.charAt(random.nextInt(CODE_ALPHABET.length())));
            String code = generated.toString();
            try {
                firebase.commit(
                        firebase.write("invites/" + code, json("family", family, "epoch", epoch,
                                "claimedBy", JSONObject.NULL), json("exists", false), false, "createdAt"),
                        firebase.write(shelf + "/private/pairing", json("invite", code), null, false, null));
            } catch (FirebaseRest.RemoteFailure error) {
                if (error.status == 403) {
                    FirebaseRest.Document current = firebase.get(shelf);
                    if (current != null && current.fields.getLong("epoch") != epoch) continue;
                }
                if (!error.conflict()) throw error;
                continue;
            }
            return shortCodes() ? pairing("issue", json("invite", code), true) : json("code", code);
        }
        throw new Failure(409, "Не удалось создать код. Попробуйте ещё раз.");
    }

    private JSONObject pairing(String operation, JSONObject data, boolean authorize) throws Exception {
        try {
            return firebase.pairing(operation, data, authorize);
        } catch (FirebaseRest.RemoteFailure error) {
            if (error.status == 400 && !authorize) throw new Failure(400, INVALID_CODE);
            if (error.status == 429) throw new Failure(429, "Слишком много попыток. Попробуйте позже.");
            if (error.status == 409) throw new Failure(409, "Уже создан другой код. Попробуйте ещё раз.");
            if (error.status == 401 || error.status == 403) throw error;
            throw new Failure(503, "Сервис подключения временно недоступен. Попробуйте ещё раз.");
        }
    }

    private JSONObject revokeChildren(String shelf) throws Exception {
        for (int attempt = 0; attempt < 3; attempt++) {
            FirebaseRest.Document record = firebase.get(shelf);
            if (record == null) throw new Failure(401, "Полка ещё не создана.");
            try {
                firebase.commit(firebase.write(shelf, json("epoch", record.fields.getLong("epoch") + 1),
                        json("updateTime", record.updateTime), true, null));
                return ok();
            } catch (FirebaseRest.RemoteFailure error) {
                if (!error.conflict()) throw error;
            }
        }
        throw new Failure(409, "Не удалось отключить устройства. Попробуйте ещё раз.");
    }

    private JSONArray categories(String shelf) throws Exception {
        LinkedHashMap<String, String> categories = new LinkedHashMap<>();
        for (String category : DEFAULT_CATEGORIES) categories.put(category, category);
        for (FirebaseRest.Document row : firebase.list(shelf + "/categories")) {
            if (row.fields.optBoolean("active")) categories.put(row.id, row.fields.getString("name"));
            else categories.remove(row.id);
        }
        JSONArray result = new JSONArray();
        for (var entry : categories.entrySet()) result.put(json("id", entry.getKey(), "name", entry.getValue()));
        return result;
    }

    private JSONObject changeCategory(String shelf, String existingId, String method, JSONObject data) throws Exception {
        JSONArray list = categories(shelf);
        JSONObject existing = null;
        for (int i = 0; existingId != null && i < list.length(); i++) {
            JSONObject row = list.getJSONObject(i);
            if (existingId.equals(row.getString("id"))) existing = row;
        }
        if (existingId != null && existing == null) throw new Failure(404, "Тема не найдена.");
        if (OTHER.equals(existingId)) throw new Failure(400, "Тема «Другое» нужна для видео без темы.");
        boolean active = !"DELETE".equals(method);
        String name = active ? data.optString("name").trim() : existing.getString("name");
        if (active) validateCategoryName(name, list, existingId);
        String path = shelf + "/categories/" + (existingId == null ? "c_" + UUID.randomUUID() : existingId);
        FirebaseRest.Document record = existingId == null ? null : firebase.get(path);
        if (record != null && !record.fields.optBoolean("active")) throw new Failure(409, "Тема уже удалена.");
        JSONObject condition = record == null ? json("exists", false) : json("updateTime", record.updateTime);
        try {
            firebase.commit(firebase.write(path, json("name", name, "active", active), condition, false, null));
        } catch (FirebaseRest.RemoteFailure error) {
            if (error.conflict()) throw new Failure(409, "Тема уже изменилась. Попробуйте ещё раз.");
            throw error;
        }
        return json("categories", categories(shelf));
    }

    private static void validateCategoryName(String name, JSONArray list, String existingId) throws Exception {
        if (name.isEmpty() || name.length() > 40) throw new Failure(400, "Название темы должно содержать от 1 до 40 символов.");
        String lower = name.toLowerCase(Locale.ROOT);
        if ("все".equals(lower)) throw new Failure(400, "Название «Все» уже используется для всей полки.");
        for (int i = 0; i < list.length(); i++) {
            JSONObject row = list.getJSONObject(i);
            if (!row.getString("id").equals(existingId) && lower.equals(row.getString("name").toLowerCase(Locale.ROOT))) {
                throw new Failure(409, "Тема с таким названием уже есть.");
            }
        }
    }

    private JSONArray selectedCategories(String shelf, JSONObject data) throws Exception {
        Object raw = data.opt("categories");
        if (raw == null || raw == JSONObject.NULL) {
            String single = data.optString("category", "");
            raw = single.isEmpty() ? new JSONArray() : new JSONArray().put(single);
        }
        Failure invalid = new Failure(400, "Можно выбрать не больше 9 тем для одного видео.");
        if (!(raw instanceof JSONArray)) throw invalid;
        JSONArray input = (JSONArray) raw;
        if (input.length() > 9) throw invalid;
        LinkedHashSet<String> requested = new LinkedHashSet<>();
        for (int i = 0; i < input.length(); i++) {
            Object value = input.get(i);
            if (!(value instanceof String)) throw invalid;
            String id = (String) value;
            if (id.isEmpty() || id.length() > 60 || id.contains("/")) throw invalid;
            if (!OTHER.equals(id)) requested.add(id);
        }
        if (requested.isEmpty()) return new JSONArray();
        JSONArray available = categories(shelf);
        LinkedHashSet<String> active = new LinkedHashSet<>();
        for (int i = 0; i < available.length(); i++) active.add(available.getJSONObject(i).getString("id"));
        requested.retainAll(active);
        return new JSONArray(requested);
    }

    private JSONObject saveVideo(String shelf, String id, JSONObject data, boolean create) throws Exception {
        Object input = data.opt("title");
        if (!(input instanceof String)) throw new Failure(400, "Введите название видео.");
        String title = create ? VideoMetadata.normalizeTitle((String) input) : boundedText(data, "title", 160);
        if (title.isEmpty()) throw new Failure(400, "Введите название видео.");
        String path = shelf + "/videos/" + id;
        JSONArray tags = selectedCategories(shelf, data);
        JSONObject video = json("title", title, "categories", tags, "category", tags.optString(0, OTHER),
                "note", boundedText(data, "note", 240));
        try {
            firebase.commit(firebase.write(path, video, json("exists", !create), !create, create ? "created" : null));
        } catch (FirebaseRest.RemoteFailure error) {
            if (create && error.conflict()) throw new Failure(409, "Это видео уже есть на полке.");
            if (!create && (error.status == 404 || error.conflict())) throw new Failure(404, "Видео не найдено.");
            throw error;
        }
        return ok();
    }

    private Failure translate(FirebaseRest.RemoteFailure error) {
        if (error.status == 401) return new Failure(401, "Войдите в свою полку снова.");
        if (error.status == 403) {
            if (firebase.user() != null && firebase.user().anonymous) {
                family = null;
                return new Failure(401, "Подключите полку снова.");
            }
            return new Failure(403, "У этого устройства нет доступа к полке.");
        }
        if (error.status >= 500) return new Failure(503, "Проверьте подключение к интернету и попробуйте ещё раз.");
        String message = switch (error.code) {
            case "INVALID_EMAIL", "MISSING_EMAIL" -> "Проверьте адрес электронной почты.";
            case "INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD", "MISSING_PASSWORD", "EMAIL_NOT_FOUND", "USER_DISABLED" -> "Неверная почта или пароль.";
            case "WEAK_PASSWORD", "PASSWORD_DOES_NOT_MEET_REQUIREMENTS" -> "Используйте более длинный пароль.";
            case "TOO_MANY_ATTEMPTS_TRY_LATER" -> "Слишком много попыток. Попробуйте позже.";
            case "OPERATION_NOT_ALLOWED", "ADMIN_ONLY_OPERATION" -> "Вход через Firebase ещё не настроен.";
            default -> "Не удалось выполнить действие. Попробуйте ещё раз.";
        };
        return new Failure(error.status, message);
    }

    private static String boundedText(JSONObject data, String key, int limit) {
        Object input = data.opt(key);
        if (!(input instanceof String)) return "";
        String value = ((String) input).trim();
        if (value.length() <= limit) return value;
        int length = Character.isHighSurrogate(value.charAt(limit - 1)) ? limit - 1 : limit;
        return value.substring(0, length);
    }

    private static JSONObject ok() throws Exception {
        return json("ok", true);
    }

    private static String sha256(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(UTF_8));
        StringBuilder result = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            result.append(Character.forDigit((b >> 4) & 15, 16));
            result.append(Character.forDigit(b & 15, 16));
        }
        return result.toString();
    }

    static final class Failure extends IOException {
        final int status;

        Failure(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
