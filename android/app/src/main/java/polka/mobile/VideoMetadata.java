package polka.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** YouTube titles and suggestions for existing topics. Network calls run off the UI thread. */
final class VideoMetadata {
    private static final String UNCATEGORIZED = "Другое";
    private static final String INVALID_URL = "Вставьте ссылку на одно видео YouTube, Shorts или youtu.be.";
    private static final String TITLE_UNAVAILABLE = "Не удалось получить название с YouTube. Введите его вручную или повторите попытку.";
    private static final String SUGGESTIONS_UNAVAILABLE = "AI временно недоступен.";
    private static final int TAG_LIMIT = 9;
    private static final int TITLE_LIMIT = 160;
    private static final String SPACE = "[\\s\\p{Z}\ufeff]";
    private static final String TAG_WORD = "[\\p{L}\\p{M}\\p{N}_]+";
    private static final String SEPARATOR = "[\\s\\p{Z}\ufeff|,;:·–—-]";
    private static final Pattern WORKER_URL = Pattern.compile("https://[a-z0-9.-]+\\.workers\\.dev/suggest");
    private static final Pattern HASHTAG = Pattern.compile("(^|[\\s\\p{Z}\ufeff\\[({«“|,;:·–—])#(" + TAG_WORD + "(?:-" + TAG_WORD + ")*)");
    private static final Pattern NUMBER = Pattern.compile("\\p{N}+");
    private static final Pattern WORD = Pattern.compile("[\\p{L}\\p{N}]+");
    private static final Pattern RU_ENDING = Pattern.compile("(?:иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ов|ев|ей|ия|ие|ии|ий|ый|ой|ая|яя|ое|ее|ые|ую|юю|ою|ею|ам|ям|ом|ем|ы|и|а|я|у|ю|е|о)$");
    private static final Set<String> STOP_WORDS = new HashSet<>(Arrays.asList("и", "или", "для", "про", "о", "об", "по", "на", "в", "с", "со", "the", "and", "for", "of"));

    private record Topic(String names, String keywords) {}
    private record Suggestion(String id, int score) {}

    // Same name aliases and keywords as the web catalog. Custom topics also match by name.
    private static final List<Topic> TOPICS = Arrays.asList(
        new Topic("наука|научное|познавательное|science", "науч*|физик*|хими*|математ*|эксперимент*|исследован*|астроном*|электрич*|молекул*|атом*|планет*|космос|космич*|science|physics|chemistry|math*|experiment*|space"),
        new Topic("природа|nature", "природ*|животн*|звер*|птиц*|насеком*|динозавр*|лес|океан*|морск*|растени*|вулкан*|nature|animal*|wildlife|dinosaur*"),
        new Topic("мультфильмы|мультики|cartoons", "мульт*|cartoon*|animation|animated|pixar|disney|смешарик*|фиксик*|лунтик|три кота|маша и медведь|синий трактор"),
        new Topic("творчество|поделки|рукоделие|crafts", "рисуем|рисован*|рисунок|лепк*|пластилин*|поделк*|оригами|аппликаци*|мастер класс|рукодел*|craft*|drawing|paint*|diy"),
        new Topic("космос|астрономия|space", "космос|космич*|планет*|астроном*|галактик*|вселенн*|ракета|луна|марс|сатурн|звезд*|space|planet*|galaxy|astronom*|rocket*"),
        new Topic("животные|звери|animals", "животн*|звер*|птиц*|насеком*|котенок|котята|кошк*|собак*|щенок|щенки|тигр*|слон*|жираф*|динозавр*|animal*|wildlife|dinosaur*|kitten*|pupp*"),
        new Topic("машины|транспорт|cars|vehicles", "машин*|автомобил*|грузовик*|трактор*|поезд*|самолет*|автобус*|транспорт*|car|cars|truck*|train*|vehicle*"),
        new Topic("музыка|песни|music", "музык*|песен*|песня|песни|поем|пианино|гитар*|оркестр*|music|song*|singing|piano|guitar*"),
        new Topic("рисование|drawing", "рисуем|рисован*|рисунок|карандаш*|акварел*|drawing|draw|paint*"),
        new Topic("английский|english", "английск*|english|alphabet|abc|phonics")
    );

    private final URI tagsEndpoint;
    private final String tagsOrigin;

    VideoMetadata(Context context) {
        String endpoint = context.getString(R.string.tags_endpoint);
        tagsEndpoint = WORKER_URL.matcher(endpoint).matches() ? URI.create(endpoint) : null;
        tagsOrigin = context.getString(R.string.tags_origin);
    }

    boolean hasCloudSuggestions(URI origin) {
        if (tagsEndpoint == null || origin == null || !"https".equals(origin.getScheme())
            || origin.getHost() == null || origin.getUserInfo() != null || origin.getPort() != -1) return false;
        String cloudOrigin = "https://" + origin.getHost().toLowerCase(Locale.ROOT);
        return tagsOrigin.equals(cloudOrigin) || tagsOrigin.replace(".web.app", ".firebaseapp.com").equals(cloudOrigin);
    }

    static String youtubeId(String input) {
        return SharedVideoLink.youtubeId(input);
    }

    static String normalizeTitle(String value) {
        if (value == null) return "";
        Matcher tags = HASHTAG.matcher(value);
        StringBuffer withoutTags = new StringBuffer(value.length());
        boolean removed = false;
        while (tags.find()) {
            if (NUMBER.matcher(tags.group(2)).matches()) continue;
            tags.appendReplacement(withoutTags, Matcher.quoteReplacement(tags.group(1)));
            removed = true;
        }
        if (removed) tags.appendTail(withoutTags);
        String title = removed ? withoutTags.toString()
            .replaceAll("\\(" + SPACE + "*\\)|\\[" + SPACE + "*\\]|\\{" + SPACE + "*\\}|«" + SPACE + "*»|“" + SPACE + "*”", "")
            .replaceAll("([|,;:·])(?:" + SPACE + "*\\1)+", "$1")
            .replaceAll(SPACE + "{2,}", " ")
            .replaceAll("^" + SEPARATOR + "+|" + SEPARATOR + "+$", "")
            : value.replaceAll("^" + SPACE + "+|" + SPACE + "+$", "");
        if (title.length() <= TITLE_LIMIT) return title;
        int end = Character.isHighSurrogate(title.charAt(TITLE_LIMIT - 1)) ? TITLE_LIMIT - 1 : TITLE_LIMIT;
        return title.substring(0, end);
    }

    String fetchTitle(String input) throws IOException {
        String id = youtubeId(input);
        if (id == null) throw new IOException(INVALID_URL);
        String query = "/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D" + id + "&format=json";
        if (tagsEndpoint != null) {
            String title = requestTitle(URI.create("https://www.youtube-nocookie.com" + query), null, 3000);
            if (!title.isEmpty()) return title;
            URI proxy = tagsEndpoint.resolve("/video-title?id=" + id);
            title = requestTitle(proxy, tagsOrigin, 5500);
            if (!title.isEmpty()) return title;
        }
        String title = requestTitle(URI.create("https://www.youtube.com" + query), null, 7000);
        if (title.isEmpty()) throw new IOException(TITLE_UNAVAILABLE);
        return title;
    }

    private static String requestTitle(URI endpoint, String origin, int timeout) throws IOException {
        try {
            Object title = request(endpoint, origin, null, null, timeout, 32768).opt("title");
            return title instanceof String ? normalizeTitle((String) title) : "";
        } catch (IOException unavailable) {
            checkInterrupted();
            return "";
        }
    }

    static List<String> suggestTags(String title, JSONArray categories) {
        List<String> tokens = words(title);
        ArrayList<Suggestion> suggestions = new ArrayList<>();
        if (tokens.isEmpty()) return Collections.emptyList();
        for (int index = 0; index < categories.length(); index++) {
            JSONObject category = categories.optJSONObject(index);
            if (category == null) continue;
            String id = category.optString("id", "");
            if (id.isEmpty() || UNCATEGORIZED.equals(id)) continue;
            List<String> name = words(category.optString("name", ""));
            List<String> meaningful = new ArrayList<>(name);
            meaningful.removeAll(STOP_WORDS);
            boolean named = !meaningful.isEmpty() && meaningful.stream().allMatch(word -> matches(tokens, word));
            int hits = 0;
            for (Topic topic : TOPICS) {
                boolean related = false;
                for (String alias : topic.names.split("\\|")) {
                    if (matches(name, alias)) {
                        related = true;
                        break;
                    }
                }
                if (!related) continue;
                for (String keyword : topic.keywords.split("\\|")) {
                    if (matches(tokens, keyword)) hits++;
                }
            }
            int score = (named ? 4 : 0) + Math.min(hits, 3);
            if (score > 0) suggestions.add(new Suggestion(id, score));
        }
        suggestions.sort(Comparator.comparingInt(Suggestion::score).reversed());
        ArrayList<String> ids = new ArrayList<>();
        for (int index = 0; index < Math.min(suggestions.size(), TAG_LIMIT); index++) ids.add(suggestions.get(index).id());
        return ids;
    }

    List<String> fetchSuggestedTags(String title, JSONArray categories, String idToken) throws IOException {
        String normalizedTitle = normalizeTitle(title);
        if (tagsEndpoint == null || normalizedTitle.length() < 3) return null;
        if (idToken == null || idToken.isEmpty()) throw new IOException(SUGGESTIONS_UNAVAILABLE);
        try {
            JSONObject body = new JSONObject().put("title", normalizedTitle);
            JSONObject result = request(tagsEndpoint, tagsOrigin, idToken, body, 25000, 16384);
            if (Boolean.FALSE.equals(result.opt("enabled"))) return null;
            JSONArray tags = result.getJSONArray("tags");
            if (!Boolean.TRUE.equals(result.opt("enabled")) || tags.length() > TAG_LIMIT) throw new JSONException("Invalid suggestions");
            Set<String> categoryIds = new LinkedHashSet<>();
            for (int index = 0; index < categories.length(); index++) {
                JSONObject category = categories.optJSONObject(index);
                if (category != null) categoryIds.add(category.optString("id", ""));
            }
            categoryIds.remove("");
            categoryIds.remove(UNCATEGORIZED);
            Set<String> suggested = new LinkedHashSet<>();
            for (int index = 0; index < tags.length(); index++) {
                Object tag = tags.opt(index);
                if (!(tag instanceof String) || !categoryIds.contains(tag)) throw new JSONException("Unknown suggested topic");
                suggested.add((String) tag);
            }
            return new ArrayList<>(suggested);
        } catch (JSONException invalid) {
            throw new IOException(SUGGESTIONS_UNAVAILABLE, invalid);
        }
    }

    private static List<String> words(String text) {
        ArrayList<String> result = new ArrayList<>();
        if (text == null || text.isEmpty()) return result;
        String normalized = Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT).replace('ё', 'е');
        Matcher words = WORD.matcher(normalized);
        while (words.find()) result.add(words.group());
        return result;
    }

    private static boolean matches(List<String> tokens, String phrase) {
        List<String> parts = words(phrase);
        if (parts.isEmpty()) return false;
        boolean prefix = phrase.endsWith("*");
        for (int start = 0; start + parts.size() <= tokens.size(); start++) {
            int offset = 0;
            for (; offset < parts.size(); offset++) {
                String token = tokens.get(start + offset);
                String part = parts.get(offset);
                boolean match = prefix && offset == parts.size() - 1 ? token.startsWith(part) : stem(token).equals(stem(part));
                if (!match) break;
            }
            if (offset == parts.size()) return true;
        }
        return false;
    }

    private static String stem(String word) {
        return word.length() <= 4 ? word : RU_ENDING.matcher(word).replaceFirst("");
    }

    private static JSONObject request(URI endpoint, String origin, String token, JSONObject body,
                                      int timeout, int maxBytes) throws IOException {
        checkInterrupted();
        HttpURLConnection connection = (HttpURLConnection) endpoint.toURL().openConnection();
        try {
            connection.setConnectTimeout(timeout);
            connection.setReadTimeout(timeout);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            if (origin != null) connection.setRequestProperty("Origin", origin);
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (var output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("HTTP " + status);
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream data = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    checkInterrupted();
                    if (data.size() + read > maxBytes) throw new IOException("Metadata response too large");
                    data.write(buffer, 0, read);
                }
                return new JSONObject(new String(data.toByteArray(), StandardCharsets.UTF_8));
            } catch (JSONException invalid) {
                throw new IOException("Invalid metadata response", invalid);
            }
        } finally {
            connection.disconnect();
        }
    }

    private static void checkInterrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
    }
}
