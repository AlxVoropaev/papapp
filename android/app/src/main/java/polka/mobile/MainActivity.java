package polka.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.Html;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.LruCache;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class MainActivity extends Activity {
    private static final int PAPER = 0xfff8f6ef;
    private static final int INK = 0xff142d27;
    private static final int GREEN = 0xff123b32;
    private static final int LIGHT_GREEN = 0xffe4ebe0;
    private static final int YELLOW = 0xffffd65a;
    private static final int MUTED = 0xff4d6259;
    private static final int ERROR = 0xff8b301b;
    private static final int FAVORITE = 0xffaa3552;
    private static final String OTHER = "Другое";
    private static final long REFRESH_MS = 10000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService catalogQueue = Executors.newSingleThreadExecutor();
    private final ExecutorService previews = Executors.newFixedThreadPool(2);
    private final ExecutorService images = Executors.newFixedThreadPool(3);
    private final LruCache<String, Bitmap> thumbnails = new LruCache<>(36);
    private final Runnable poll = this::refresh;
    private final Runnable deliver = this::deliverShare;

    private FrameLayout root;
    private LinearLayout body;
    private AlertDialog dialog;
    private TextView dialogError;
    private ApkUpdateController apkUpdates;
    private CatalogBackend cloudBackend;
    private VideoMetadata metadata;
    private VideoPlayback playback;
    private LocalCatalog localBackend;
    private URI endpoint;
    private JSONObject session;
    private JSONArray videos = new JSONArray();
    private JSONArray categories = new JSONArray();
    private final Set<String> favorites = new LinkedHashSet<>();
    private boolean showFavorites;
    private String filter;
    private String status;
    private String pendingLink;
    private ListView list;
    private VideoCard playingCard;
    private boolean renderPending;
    private boolean refreshInFlight;
    private boolean busy;
    private boolean catalogLoaded;
    private boolean resumed;
    private boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (playback != null && playback.isFullscreen()) {
                view.setPadding(0, 0, 0, 0);
            } else if (Build.VERSION.SDK_INT >= 30) {
                var safe = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            }
            return insets;
        });
        setContentView(root);
        apkUpdates = new ApkUpdateController(this, this::safeToInstall, this::deliverShare);
        metadata = new VideoMetadata(this);
        playback = new VideoPlayback(this, root, this::playbackClosed);
        var preferences = getPreferences(MODE_PRIVATE);
        pendingLink = preferences.getString("pendingShare", preferences.getString("activeShare", null));
        if (pendingLink != null) preferences.edit().putString("pendingShare", pendingLink).remove("activeShare").apply();
        if (state == null) captureShare(getIntent());
        URI endpoint = readEndpoint(getPreferences(MODE_PRIVATE)
            .getString("endpoint", getString(R.string.default_endpoint)));
        if (endpoint == null) endpoint = readEndpoint(getString(R.string.default_endpoint));
        if (endpoint == null) showConnection();
        else connect(endpoint);
    }

    private boolean safeToInstall() {
        return resumed && (cloudBackend != null || localBackend != null)
            && (session == null || catalogLoaded) && !busy && !refreshInFlight && dialog == null
            && !playback.isOpen() && pendingLink == null;
    }

    private URI readEndpoint(String input) {
        try {
            URI uri = URI.create(input.trim());
            boolean debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            if (uri.getHost() != null && uri.getUserInfo() == null && uri.getQuery() == null
                && uri.getFragment() == null && (uri.getPath().isEmpty() || "/".equals(uri.getPath()))
                && ("https".equals(uri.getScheme()) || debug && "http".equals(uri.getScheme()))) {
                return URI.create(uri.getScheme() + "://" + uri.getAuthority() + "/");
            }
        } catch (IllegalArgumentException ignored) {
            // The connection form handles invalid addresses.
        }
        return null;
    }

    private void connect(URI endpoint) {
        this.endpoint = endpoint;
        var preferences = getPreferences(MODE_PRIVATE);
        String host = endpoint.getHost().toLowerCase(java.util.Locale.ROOT);
        if (host.endsWith(".web.app") && endpoint.getPort() == -1 && "https".equals(endpoint.getScheme())) {
            cloudBackend = new CatalogBackend(this, endpoint.toString());
            localBackend = null;
        } else {
            cloudBackend = null;
            localBackend = new LocalCatalog(endpoint, preferences);
        }
        ApkUpdates.configure(this, endpoint);
        loadSession();
    }

    private JSONObject request(String path, String method, JSONObject data) throws Exception {
        return cloudBackend != null ? cloudBackend.request(path, method, data)
            : localBackend.request(path, method, data);
    }

    private void showConnection() {
        resetBody();
        var panel = screenPanel("Подключение", "Введите адрес сервера семейной полки.");
        var address = field(panel, "Адрес сервера", "", InputType.TYPE_TEXT_VARIATION_URI, 256, true);
        var error = label("", 14, ERROR);
        panel.addView(error);
        panel.addView(button("Открыть полку", true, () -> {
            URI endpoint = readEndpoint(value(address));
            if (endpoint == null) {
                error.setText("Проверьте адрес сервера.");
                return;
            }
            getPreferences(MODE_PRIVATE).edit().putString("endpoint", endpoint.toString()).apply();
            connect(endpoint);
        }));
    }

    private void loadSession() {
        resetBody();
        screenPanel("Видео от папы", "Открываем полку…");
        runBusy(() -> request("session", "GET", null), this::openSession,
            error -> showWelcome(unauthorized(error) ? "" : message(error)));
    }

    private void showWelcome(String problem) {
        resetBody();
        var panel = screenPanel("Видео от папы", "Семейная подборка любимых видео");
        if (!problem.isEmpty()) {
            panel.addView(label(problem, 15, ERROR));
            panel.addView(button("Повторить", true, this::loadSession));
        }
        if (pendingLink != null) panel.addView(label("Ссылка сохранена. Войдите как родитель, чтобы добавить видео.", 15, MUTED));
        panel.addView(button("Ввести код с телефона папы", true, () -> authForm("join")));
        panel.addView(button("Создать полку", false, () -> authForm("families")));
        panel.addView(button("Войти как родитель", false, () -> authForm("login")));
        if (getString(R.string.default_endpoint).isEmpty()) {
            panel.addView(button("Изменить адрес сервера", false, this::showConnection));
        }
        addVersionLabel(panel);
    }

    private void authForm(String action) {
        boolean create = action.equals("families");
        boolean join = action.equals("join");
        boolean reset = action.equals("reset-password");
        boolean cloud = cloudBackend != null;
        String header = create ? "Создать полку" : join ? "Подключить полку"
            : reset ? "Восстановить пароль" : "Войти как родитель";
        var panel = formPanel();
        Map<String, EditText> fields = new LinkedHashMap<>();
        if (join) {
            panel.addView(label("На телефоне папы откройте «Настройки» → «Подключить устройство».", 15, MUTED));
            boolean shortCode = !cloud || cloudBackend.shortCodes();
            var code = field(panel, shortCode ? "Код из 6 цифр" : "Код подключения", "",
                InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS, 38, true);
            if (shortCode) code.setRawInputType(InputType.TYPE_CLASS_NUMBER);
            fields.put("code", code);
        } else {
            if (create) fields.put("name", field(panel, "Название полки", "Видео полка", 0, 60, true));
            if (cloud) fields.put("email", field(panel, "Почта родителя", "",
                InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, 254, true));
            else if (!create) fields.put("family", field(panel, "Номер полки", "",
                InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS, 12, true));
            if (!reset) fields.put("password", field(panel, "Пароль родителя", "",
                InputType.TYPE_TEXT_VARIATION_PASSWORD, 128, true));
            if (create) fields.put("setupKey", field(panel, cloud ? "Ключ создания" : "Ключ создания, если задан", "",
                InputType.TYPE_TEXT_VARIATION_PASSWORD, 256, true));
            if (action.equals("login") && cloud) {
                panel.addView(button("Забыли пароль?", false, () -> authForm("reset-password")));
            }
        }
        String submit = create ? "Создать" : join ? "Подключить" : reset ? "Отправить ссылку" : "Войти";
        showForm(header, panel, submit, (current, error) -> {
            var data = new JSONObject();
            for (var entry : fields.entrySet()) {
                String key = entry.getKey();
                String input = value(entry.getValue());
                if (input.trim().isEmpty() && !(key.equals("setupKey") && !cloud)) {
                    entry.getValue().setError("Заполните поле");
                    return;
                }
                put(data, key, input);
            }
            if (create && data.optString("password").length() < 8) {
                fields.get("password").setError("Минимум 8 символов");
                return;
            }
            submit(current, error, () -> request(action, "POST", data), result -> {
                closeDialog();
                if (reset) toast("Если аккаунт существует, ссылка придёт на почту.");
                else openSession(result);
            });
        });
    }

    private void openSession(JSONObject next) {
        session = next;
        videos = new JSONArray();
        categories = new JSONArray();
        favorites.clear();
        showFavorites = false;
        filter = null;
        catalogLoaded = false;
        status = "Загружаем видео…";
        renderLibrary();
        refresh();
    }

    private void refresh() {
        handler.removeCallbacks(poll);
        if (session == null || refreshInFlight || apkUpdates.blocking()) return;
        var originalSession = session;
        refreshInFlight = true;
        run(catalogQueue, () -> request("videos", "GET", null), (result, error) -> {
            refreshInFlight = false;
            apkUpdates.reconsider();
            if (session != originalSession) {
                if (session != null) refresh();
                return;
            }
            if (error != null && unauthorized(error)) {
                closeDialog();
                playback.close();
                session = null;
                showWelcome("");
                toast("Подключите полку снова");
                return;
            }
            if (error != null) {
                String nextStatus = message(error);
                if (!nextStatus.equals(status)) {
                    status = nextStatus;
                    renderLibrary();
                }
            } else {
                JSONArray nextVideos = array(result, "videos");
                JSONArray nextCategories = array(result, "categories");
                JSONArray favoriteIds = array(result, "favorites");
                var nextFavorites = new LinkedHashSet<String>();
                for (int i = 0; i < favoriteIds.length(); i++) nextFavorites.add(favoriteIds.optString(i));
                boolean changed = status != null || !videos.toString().equals(nextVideos.toString())
                    || !categories.toString().equals(nextCategories.toString()) || !favorites.equals(nextFavorites);
                catalogLoaded = true;
                videos = nextVideos;
                categories = nextCategories;
                favorites.clear();
                favorites.addAll(nextFavorites);
                status = null;
                if (playingCard != null) {
                    String playingId = playingCard.video.optString("id");
                    for (int i = 0; i < videos.length(); i++) {
                        JSONObject row = videos.optJSONObject(i);
                        if (playingId.equals(row.optString("id"))) {
                            playingCard.showViews(row.optLong("viewCount"));
                            playingCard.showFavorite();
                            break;
                        }
                    }
                }
                if (changed) renderLibrary();
                deliverShare();
            }
            if (resumed) handler.postDelayed(poll, REFRESH_MS);
        });
    }

    private void renderLibrary() {
        if (playback.isOpen()) {
            renderPending = true;
            return;
        }
        renderPending = false;
        int first = list == null ? 0 : list.getFirstVisiblePosition();
        View top = list == null ? null : list.getChildAt(0);
        int offset = top == null ? 0 : top.getTop();
        resetBody();
        body.setPadding(0, dp(12), 0, 0);
        var controls = vertical();
        controls.setPadding(dp(20), 0, dp(20), 0);
        body.addView(controls, new LinearLayout.LayoutParams(-1, -2));
        var header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        controls.addView(header, new LinearLayout.LayoutParams(-1, -2));
        var title = label(showFavorites ? "Избранное" : session.optString("name", "Видео полка"), 26, INK);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        var favoritesButton = iconButton(showFavorites ? R.drawable.ic_heart_filled : R.drawable.ic_heart,
            showFavorites ? "Вернуться на полку" : "Избранное", 12, this::toggleFavoritesFeed);
        favoritesButton.setColorFilter(showFavorites ? FAVORITE : GREEN);
        addHeaderAction(header, favoritesButton);
        if (parent()) {
            if (catalogLoaded) {
                var addVideo = iconButton(R.drawable.ic_add, "Добавить видео", 12, () -> videoForm(null, null));
                addVideo.setColorFilter(Color.WHITE);
                addVideo.setBackground(new android.graphics.drawable.RippleDrawable(
                    android.content.res.ColorStateList.valueOf(0x35ffffff), shape(GREEN, 14), null));
                addHeaderAction(header, addVideo);
            }
            var settingsButton = iconButton(R.drawable.ic_settings, "Настройки", 12, this::settings);
            settingsButton.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(0x28123b32), shape(LIGHT_GREEN, 14), null));
            addHeaderAction(header, settingsButton);
        } else {
            header.addView(button("Устройство", false, this::settings));
        }

        if (status != null) {
            var feedback = label(status, 15, catalogLoaded ? ERROR : MUTED);
            controls.addView(feedback);
            if (!catalogLoaded && !status.equals("Загружаем видео…")) {
                controls.addView(button("Повторить", false, this::refresh));
            }
        }

        var all = new ArrayList<JSONObject>();
        var available = new LinkedHashSet<String>();
        for (int i = 0; i < videos.length(); i++) {
            JSONObject video = videos.optJSONObject(i);
            if (video == null || (showFavorites && !favorites.contains(video.optString("id")))) continue;
            all.add(video);
            available.addAll(effectiveTags(video));
        }
        if (filter != null && !available.contains(filter)) filter = null;
        if (all.isEmpty()) {
            if (catalogLoaded && status == null) {
                var empty = label(showFavorites ? "Избранное пока пусто" : "Полка пока пуста", 22, INK);
                empty.setPadding(0, dp(38), 0, dp(8));
                controls.addView(empty);
                String hint = showFavorites ? "Нажмите на сердечко в карточке видео, чтобы сохранить его."
                    : parent() ? "Добавьте ссылку на первое видео." : "Здесь появятся видео, которые добавит родитель.";
                controls.addView(label(hint, 16, MUTED));
            }
            return;
        }
        var chips = new HorizontalScrollView(this);
        chips.setHorizontalScrollBarEnabled(false);
        var row = new LinearLayout(this);
        chips.addView(row);
        addChip(row, "Все", null);
        for (int i = 0; i < categories.length(); i++) {
            JSONObject category = categories.optJSONObject(i);
            if (category != null && available.contains(category.optString("id"))) {
                addChip(row, category.optString("name"), category.optString("id"));
            }
        }
        controls.addView(chips);
        var visible = new ArrayList<JSONObject>();
        for (JSONObject video : all) {
            if (filter == null || effectiveTags(video).contains(filter)) visible.add(video);
        }
        list = new ListView(this);
        list.setDivider(null);
        list.setClipToPadding(false);
        list.setPadding(0, dp(8), 0, dp(8));
        list.setAdapter(new VideosAdapter(visible));
        body.addView(list, new LinearLayout.LayoutParams(-1, 0, 1));
        if (first < visible.size()) list.setSelectionFromTop(first, offset);
    }

    private void toggleFavoritesFeed() {
        showFavorites = !showFavorites;
        filter = null;
        playback.close();
        list = null;
        renderLibrary();
    }

    private void toggleFavorite(VideoCard card) {
        if (!catalogLoaded) return;
        var originalSession = session;
        String id = card.video.optString("id");
        boolean save = !favorites.contains(id);
        runBusy(() -> request("favorites/" + id, save ? "POST" : "DELETE", null), result -> {
            if (session != originalSession) return;
            if (save) favorites.add(id);
            else favorites.remove(id);
            card.showFavorite();
            renderLibrary();
        }, error -> {
            if (session != originalSession) return;
            toast(message(error));
            refresh();
        });
    }

    private void addHeaderAction(LinearLayout header, ImageButton button) {
        var params = new LinearLayout.LayoutParams(dp(48), dp(48));
        params.setMarginStart(dp(8));
        header.addView(button, params);
    }

    private void addChip(LinearLayout row, String name, String id) {
        var chip = button(name, java.util.Objects.equals(filter, id), () -> {
            playback.close();
            filter = id;
            list = null;
            renderLibrary();
        });
        var params = new LinearLayout.LayoutParams(-2, -2);
        params.setMarginEnd(dp(6));
        row.addView(chip, params);
    }

    private final class VideosAdapter extends BaseAdapter {
        private final List<JSONObject> rows;

        VideosAdapter(List<JSONObject> rows) { this.rows = rows; }
        @Override public int getCount() { return rows.size(); }
        @Override public JSONObject getItem(int position) { return rows.get(position); }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean isEnabled(int position) { return false; }
        @Override public View getView(int position, View convertView, ViewGroup parent) {
            var card = convertView == null ? new VideoCard() : (VideoCard) convertView.getTag();
            card.bind(getItem(position));
            return card.container;
        }
    }

    private final class VideoCard {
        final LinearLayout container = vertical();
        final FrameLayout media = new VideoFrame();
        final FrameLayout playerHost = new FrameLayout(MainActivity.this);
        final ImageView thumbnail = new ImageView(MainActivity.this);
        final TextView playBadge = label("▶", 22, Color.WHITE);
        final Button stop = button("Закрыть плеер", false, playback::close);
        final TextView themes = label("", 13, GREEN);
        final TextView views = label("", 13, MUTED);
        final TextView title = label("", 19, INK);
        final TextView note = label("", 15, MUTED);
        final ImageButton favoriteButton;
        final ImageButton editButton;
        final ImageButton removeButton;
        JSONObject video;

        VideoCard() {
            container.setTag(this);
            container.setPadding(0, 0, 0, dp(10));
            container.setOnClickListener(v -> play(this));
            container.setFocusable(false);
            container.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);

            media.setFocusable(true);
            media.setOnClickListener(v -> play(this));
            media.setBackgroundColor(Color.BLACK);
            container.addView(media, new LinearLayout.LayoutParams(-1, -2));
            thumbnail.setScaleType(ImageView.ScaleType.CENTER_CROP);
            thumbnail.setBackgroundColor(LIGHT_GREEN);
            thumbnail.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            media.addView(thumbnail, new FrameLayout.LayoutParams(-1, -1));
            playBadge.setBackground(shape(0xd9142d27, 24));
            playBadge.setGravity(Gravity.CENTER);
            playBadge.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            media.addView(playBadge, new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.CENTER));
            playerHost.setVisibility(View.GONE);
            media.addView(playerHost, new FrameLayout.LayoutParams(-1, -1));
            var details = vertical();
            details.setBackgroundColor(Color.WHITE);
            details.setPadding(dp(16), 0, dp(16), dp(12));
            container.addView(details, new LinearLayout.LayoutParams(-1, -2));

            var metadata = new LinearLayout(MainActivity.this);
            metadata.setGravity(Gravity.CENTER_VERTICAL);
            details.addView(metadata, new LinearLayout.LayoutParams(-1, -2));
            metadata.addView(themes, new LinearLayout.LayoutParams(0, -2, 1));
            var eye = getDrawable(R.drawable.ic_eye).mutate();
            eye.setTint(MUTED);
            eye.setBounds(0, 0, dp(16), dp(16));
            views.setCompoundDrawablesRelative(eye, null, null, null);
            views.setCompoundDrawablePadding(dp(5));
            var viewParams = new LinearLayout.LayoutParams(-2, -2);
            viewParams.setMarginStart(dp(8));
            metadata.addView(views, viewParams);
            favoriteButton = iconButton(R.drawable.ic_heart, "Добавить в избранное", 14, () -> toggleFavorite(this));
            metadata.addView(favoriteButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
            if (parent()) {
                editButton = iconButton(R.drawable.ic_edit, "Изменить", 15, () -> videoForm(video, null));
                removeButton = iconButton(R.drawable.ic_delete, "Удалить", 15, () -> removeVideo(video));
                metadata.addView(editButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
                metadata.addView(removeButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
            } else {
                editButton = null;
                removeButton = null;
            }

            title.setTypeface(Typeface.DEFAULT_BOLD);
            details.addView(title);
            note.setPadding(0, dp(4), 0, 0);
            details.addView(note);
            stop.setVisibility(View.GONE);
            details.addView(stop, new LinearLayout.LayoutParams(-1, -2));
        }

        void bind(JSONObject value) {
            if (playingCard == this && !video.optString("id").equals(value.optString("id"))) playback.close();
            video = value;
            String name = video.optString("title");
            media.setContentDescription(playingCard == this ? null : "Смотреть " + name);
            title.setText(name);
            var names = new ArrayList<String>();
            for (String tag : effectiveTags(video)) names.add(categoryName(tag));
            themes.setText(String.join(" · ", names));
            showViews(video.optLong("viewCount"));
            showFavorite();
            note.setText(video.optString("note"));
            note.setVisibility(video.optString("note").isEmpty() ? View.GONE : View.VISIBLE);
            if (editButton != null) {
                editButton.setContentDescription("Изменить видео " + name);
                removeButton.setContentDescription("Удалить видео " + name);
            }
            loadThumbnail(videoId(video), thumbnail);
        }

        void showFavorite() {
            boolean saved = favorites.contains(video.optString("id"));
            String action = saved ? "Убрать из избранного" : "Добавить в избранное";
            favoriteButton.setImageResource(saved ? R.drawable.ic_heart_filled : R.drawable.ic_heart);
            favoriteButton.setColorFilter(saved ? FAVORITE : GREEN);
            favoriteButton.setContentDescription(action + " — " + video.optString("title"));
            favoriteButton.setTooltipText(action);
        }

        void showViews(long count) {
            String number = java.text.NumberFormat.getIntegerInstance().format(count);
            views.setText(number);
            views.setContentDescription("Просмотров: " + number);
        }

        void showPlayer(boolean active) {
            playerHost.setVisibility(active ? View.VISIBLE : View.GONE);
            thumbnail.setVisibility(active ? View.INVISIBLE : View.VISIBLE);
            playBadge.setVisibility(active ? View.INVISIBLE : View.VISIBLE);
            stop.setVisibility(active ? View.VISIBLE : View.GONE);
            container.setClickable(!active);
            media.setClickable(!active);
            media.setFocusable(!active);
            media.setContentDescription(active ? null : "Смотреть " + video.optString("title"));
        }
    }

    private final class VideoFrame extends FrameLayout {
        VideoFrame() { super(MainActivity.this); }

        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int height = Math.max(dp(200), Math.round(MeasureSpec.getSize(widthSpec) * 9f / 16f));
            super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY));
        }
    }

    private void loadThumbnail(String id, ImageView target) {
        target.setTag(id);
        target.setImageDrawable(null);
        if (id == null) return;
        Bitmap cached = thumbnails.get(id);
        if (cached != null) {
            target.setImageBitmap(cached);
            return;
        }
        run(images, () -> {
            var connection = (HttpURLConnection) URI.create("https://i.ytimg.com/vi/" + id + "/mqdefault.jpg")
                .toURL().openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(3500);
                connection.setReadTimeout(3500);
                try (var input = connection.getInputStream()) {
                    Bitmap bitmap = BitmapFactory.decodeStream(input);
                    if (bitmap != null) thumbnails.put(id, bitmap);
                    return bitmap;
                }
            } finally {
                connection.disconnect();
            }
        }, (bitmap, error) -> {
            if (bitmap != null && id.equals(target.getTag())) target.setImageBitmap(bitmap);
        });
    }

    private void play(VideoCard card) {
        if (busy || apkUpdates.blocking()) return;
        playback.close();
        playingCard = card;
        card.showPlayer(true);
        String id = card.video.optString("id");
        JSONObject shelf = session;
        if (!playback.open(card.playerHost, videoId(card.video), 0, () -> recordView(id, shelf))) {
            playbackClosed();
            toast("Не удалось открыть видео.");
        }
    }

    private void recordView(String id, JSONObject shelf) {
        if (session != shelf) return;
        run(catalogQueue, () -> request("video-views/" + id, "POST", json()), (result, error) -> {
            if (session != shelf) return;
            if (error == null) refresh();
            else toast("Не удалось сохранить просмотр.");
        });
    }

    private void playbackClosed() {
        if (playingCard != null) {
            playingCard.showPlayer(false);
            playingCard = null;
        }
        if (destroyed) return;
        handler.post(() -> {
            if (renderPending && session != null && !playback.isOpen()) renderLibrary();
            deliverShare();
        });
        apkUpdates.reconsider();
    }

    private String videoId(JSONObject video) {
        String id = video.optString("youtube", video.optString("id"));
        return id.matches("[A-Za-z0-9_-]{11}") ? id : null;
    }

    private String categoryName(String id) {
        for (int i = 0; i < categories.length(); i++) {
            JSONObject category = categories.optJSONObject(i);
            if (category != null && id.equals(category.optString("id"))) return category.optString("name", id);
        }
        return id;
    }

    private List<String> effectiveTags(JSONObject video) {
        var active = new LinkedHashSet<String>();
        JSONArray tags = video.optJSONArray("categories");
        if (tags == null) tags = new JSONArray().put(video.optString("category"));
        for (int i = 0; i < tags.length(); i++) {
            String id = tags.optString(i);
            if (id.isEmpty() || id.equals(OTHER)) continue;
            for (int j = 0; j < categories.length(); j++) {
                JSONObject category = categories.optJSONObject(j);
                if (category != null && id.equals(category.optString("id"))) active.add(id);
            }
        }
        return active.isEmpty() ? Collections.singletonList(OTHER) : new ArrayList<>(active);
    }

    private void videoForm(JSONObject video, String shared) {
        if (!parent()) return;
        var panel = formPanel();
        var editor = new VideoEditor(panel, video, shared);
        var current = showForm(video == null ? "Добавить видео" : "Редактировать видео", panel,
            video == null ? "Добавить на полку" : "Сохранить", editor::save);
        editor.owner = current;
        if (shared != null) {
            getPreferences(MODE_PRIVATE).edit().remove("pendingShare").putString("activeShare", shared).apply();
            current.setOnDismissListener(ignored -> {
                getPreferences(MODE_PRIVATE).edit().remove("activeShare").apply();
                dialogDismissed(current);
            });
            editor.scheduleLookup();
        }
    }

    private final class VideoEditor {
        final JSONObject original;
        final EditText url;
        final EditText title;
        final EditText note;
        final TextView titleStatus;
        final TextView tagsStatus;
        final Button titleRetry;
        final Button applyTags;
        final Map<String, CheckBox> tags = new LinkedHashMap<>();
        final JSONArray availableCategories = categories;
        final Runnable lookup = this::loadTitle;
        final Runnable suggest = this::loadAiSuggestions;
        AlertDialog owner;
        List<String> suggestions = Collections.emptyList();
        String automaticTitle = "";
        int titleRevision;
        int lookupRevision;
        int tagsRevision;
        boolean manualTags;
        boolean fillingTags;
        boolean aiSuggestions;

        VideoEditor(LinearLayout panel, JSONObject video, String shared) {
            original = video;
            url = video == null ? field(panel, "Ссылка на YouTube", shared == null ? "" : shared,
                InputType.TYPE_TEXT_VARIATION_URI, 2048, true) : null;
            title = field(panel, "Название", video == null ? "" : video.optString("title"), 0, 160, false);
            titleStatus = label("", 14, MUTED);
            titleRetry = button("Повторить загрузку названия", false, this::loadTitle);
            titleRetry.setVisibility(View.GONE);
            if (url != null) {
                panel.addView(titleStatus);
                panel.addView(titleRetry);
                watchText(url, this::scheduleLookup);
                watchText(title, () -> {
                    titleRevision++;
                    suggestTags();
                });
            }
            panel.addView(label("Темы", 18, INK));
            var selected = video == null ? Collections.<String>emptyList() : effectiveTags(video);
            for (int i = 0; i < availableCategories.length(); i++) {
                JSONObject category = availableCategories.optJSONObject(i);
                if (category == null) continue;
                String id = category.optString("id");
                if (id.isEmpty() || id.equals(OTHER)) continue;
                var check = new CheckBox(MainActivity.this);
                check.setText(category.optString("name"));
                check.setTextColor(INK);
                check.setMinHeight(dp(44));
                check.setChecked(selected.contains(id));
                check.setOnCheckedChangeListener((view, checked) -> {
                    if (fillingTags) return;
                    manualTags = true;
                    if (checked && selectedTags().length() > 9) {
                        check.setChecked(false);
                        toast("Можно выбрать не больше 9 тем");
                    }
                    showSuggestions();
                });
                tags.put(id, check);
                panel.addView(check);
            }
            tagsStatus = label("Темы можно выбрать после ввода названия.", 14, MUTED);
            applyTags = button("Применить подсказки", false, () -> {
                manualTags = false;
                showSuggestions();
            });
            applyTags.setVisibility(View.GONE);
            if (url != null && !tags.isEmpty()) {
                panel.addView(tagsStatus);
                panel.addView(applyTags);
            }
            note = field(panel, "Заметка для сына", video == null ? "" : video.optString("note"), 0, 240, false);
        }

        void scheduleLookup() {
            handler.removeCallbacks(lookup);
            lookupRevision++;
            if (!automaticTitle.isEmpty() && automaticTitle.equals(value(title))) title.setText("");
            automaticTitle = "";
            titleRetry.setVisibility(View.GONE);
            String id = VideoMetadata.youtubeId(value(url));
            titleStatus.setText(id == null ? "Вставьте ссылку или введите название вручную."
                : "Загружаем название с YouTube…");
            if (id != null) handler.postDelayed(lookup, 400);
        }

        void loadTitle() {
            String input = value(url);
            if (!isOpen() || VideoMetadata.youtubeId(input) == null) return;
            int revision = ++lookupRevision;
            int edits = titleRevision;
            titleRetry.setVisibility(View.GONE);
            titleStatus.setText("Загружаем название с YouTube…");
            run(previews, () -> metadata.fetchTitle(input), (result, error) -> {
                if (!isOpen() || revision != lookupRevision) return;
                if (error != null || result == null || result.isEmpty()) {
                    titleStatus.setText("Не удалось получить название. Введите его вручную или повторите попытку.");
                    titleRetry.setVisibility(View.VISIBLE);
                } else if (titleRevision == edits && (value(title).isEmpty() || automaticTitle.equals(value(title)))) {
                    automaticTitle = result;
                    title.setText(result);
                    titleStatus.setText("Название получено с YouTube. Его можно изменить.");
                } else {
                    titleStatus.setText("Используется введённое вами название.");
                }
            });
        }

        void suggestTags() {
            handler.removeCallbacks(suggest);
            tagsRevision++;
            aiSuggestions = false;
            suggestions = VideoMetadata.suggestTags(VideoMetadata.normalizeTitle(value(title)), availableCategories);
            showSuggestions();
            if (cloudBackend != null && metadata.hasCloudSuggestions(endpoint) && !tags.isEmpty() && !value(title).trim().isEmpty()) {
                handler.postDelayed(suggest, 1500);
            }
        }

        void loadAiSuggestions() {
            if (!isOpen() || cloudBackend == null) return;
            int revision = tagsRevision;
            String heading = VideoMetadata.normalizeTitle(value(title));
            if (heading.length() < 3) return;
            var backend = cloudBackend;
            run(catalogQueue, backend::idToken, (token, authError) -> {
                if (!isOpen() || revision != tagsRevision || token == null) return;
                run(previews, () -> metadata.fetchSuggestedTags(heading, availableCategories, token),
                    (result, error) -> {
                        if (!isOpen() || revision != tagsRevision || result == null) return;
                        suggestions = result;
                        aiSuggestions = true;
                        showSuggestions();
                    });
            });
        }

        void showSuggestions() {
            if (!manualTags) {
                fillingTags = true;
                for (var entry : tags.entrySet()) entry.getValue().setChecked(suggestions.contains(entry.getKey()));
                fillingTags = false;
            }
            var names = new ArrayList<String>();
            for (String id : suggestions) names.add(categoryName(id));
            if (value(title).trim().isEmpty()) tagsStatus.setText("Темы можно выбрать после ввода названия.");
            else if (names.isEmpty()) tagsStatus.setText("Выберите подходящие темы.");
            else tagsStatus.setText((aiSuggestions ? "AI предлагает " : "По названию подходят ") + String.join(", ", names));
            applyTags.setVisibility(manualTags && !suggestions.isEmpty() ? View.VISIBLE : View.GONE);
        }

        boolean isOpen() {
            return owner != null && dialog == owner && owner.isShowing();
        }

        JSONArray selectedTags() {
            var selected = new JSONArray();
            for (var entry : tags.entrySet()) {
                if (entry.getValue().isChecked()) selected.put(entry.getKey());
            }
            return selected;
        }

        void save(AlertDialog current, TextView error) {
            String name = original == null ? VideoMetadata.normalizeTitle(value(title)) : value(title).trim();
            if (url != null && VideoMetadata.youtubeId(value(url)) == null) {
                url.setError("Вставьте ссылку на видео YouTube");
                return;
            }
            if (name.isEmpty()) {
                title.setError("Введите название видео");
                return;
            }
            var data = json("title", name, "note", value(note).trim(), "categories", selectedTags());
            if (url != null) put(data, "url", "https://www.youtube.com/watch?v=" + VideoMetadata.youtubeId(value(url)));
            String path = original == null ? "videos" : "videos/" + original.optString("id");
            submit(current, error, () -> request(path, original == null ? "POST" : "PATCH", data), result -> {
                closeDialog();
                if (original == null) filter = null;
                refresh();
                toast(original == null ? "Видео добавлено" : "Видео изменено");
            });
        }
    }

    private void removeVideo(JSONObject video) {
        var panel = formPanel();
        panel.addView(label("Убрать «" + video.optString("title") + "» с полки на всех устройствах?", 16, INK));
        showForm("Удалить видео", panel, "Удалить", (current, error) ->
            submit(current, error, () -> request("videos/" + video.optString("id"), "DELETE", null), result -> {
                closeDialog();
                refresh();
                toast("Видео удалено");
            }));
    }

    private void addVersionLabel(LinearLayout panel) {
        try {
            var version = getPackageManager().getPackageInfo(getPackageName(), 0);
            panel.addView(label("Версия " + version.versionName, 14, MUTED));
        } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {
            // The version label is optional.
        }
    }

    private void settings() {
        var panel = formPanel();
        addVersionLabel(panel);
        var updateControls = new UpdateSettings(panel);
        if (parent()) {
            if (cloudBackend == null) {
                var family = label("Номер полки " + session.optString("family"), 15, MUTED);
                family.setTextIsSelectable(true);
                panel.addView(family);
            }
            panel.addView(button("Подключить устройство", true, this::pairDevice));
            panel.addView(button("Темы видео", false, this::manageCategories));
            panel.addView(button("Отключить детские устройства", false, this::disconnectDevices));
        }
        panel.addView(button("Обновить полку", false, () -> {
            closeDialog();
            refresh();
        }));
        var current = showForm(parent() ? "Настройки" : "Устройство", panel, "Выйти", (owner, error) ->
            submit(owner, error, () -> request("logout", "POST", null), result -> {
                closeDialog();
                session = null;
                showWelcome("");
            }));
        updateControls.check(current);
    }

    private final class UpdateSettings {
        private final Button check;
        private final Button install;
        private final TextView status;

        UpdateSettings(LinearLayout panel) {
            check = button("Проверить обновления", false, () -> check(dialog));
            install = button("Обновить приложение", false, () -> {
                closeDialog();
                apkUpdates.installNow();
            });
            install.setBackground(buttonBackground(YELLOW, 0x28123b32));
            install.setVisibility(View.GONE);
            status = label("", 14, MUTED);
            status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            status.setVisibility(View.GONE);
            panel.addView(check);
            panel.addView(install);
            panel.addView(status);
        }

        void check(AlertDialog owner) {
            check.setEnabled(false);
            check.setText("Проверяем обновления…");
            status.setVisibility(View.GONE);
            ApkUpdates.check(MainActivity.this, true, error -> {
                if (dialog != owner || !owner.isShowing() || isDestroyed()) return;
                boolean available = error == null && ApkUpdates.ready(MainActivity.this);
                check.setText("Проверить обновления");
                check.setEnabled(true);
                check.setVisibility(available ? View.GONE : View.VISIBLE);
                install.setVisibility(available ? View.VISIBLE : View.GONE);
                if (!available) {
                    status.setText(error == null ? "Установлена актуальная версия"
                        : "Не удалось проверить обновления. Попробуйте ещё раз.");
                    status.setVisibility(View.VISIBLE);
                }
            });
        }
    }

    private void pairDevice() {
        var current = dialog;
        var error = dialogError;
        submit(current, error, () -> request("pair-code", "POST", null), result -> {
            String rawCode = result.optString("code");
            String code = rawCode.replaceAll(rawCode.length() == 6 ? "(.{3})(?!$)" : "(.{4})(?!$)", "$1 ");
            var panel = formPanel();
            var display = label(code, 24, INK);
            display.setTextIsSelectable(true);
            panel.addView(display);
            panel.addView(label("Введите код на втором устройстве. Код действует 10 минут и используется один раз. Новый код отменяет предыдущий.", 16, MUTED));
            panel.addView(button("Скопировать код", true, () -> {
                getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Код подключения", code));
                toast("Код скопирован");
            }));
            showForm("Код подключения", panel, null, null);
        });
    }

    private void disconnectDevices() {
        var panel = formPanel();
        panel.addView(label("Для повторного подключения потребуется новый код.", 16, INK));
        showForm("Отключить детские устройства?", panel, "Отключить", (current, error) ->
            submit(current, error, () -> request("child-devices", "DELETE", null), result -> {
                closeDialog();
                toast("Детские устройства отключены");
            }));
    }

    private void manageCategories() {
        var panel = formPanel();
        panel.addView(button("Добавить тему", true, () -> categoryForm(null, false)));
        for (int i = 0; i < categories.length(); i++) {
            JSONObject category = categories.optJSONObject(i);
            if (category == null || OTHER.equals(category.optString("id"))) continue;
            var title = label(category.optString("name"), 17, INK);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            panel.addView(title);
            var actions = new LinearLayout(this);
            panel.addView(actions);
            actions.addView(button("Переименовать", false, () -> categoryForm(category, false)));
            actions.addView(button("Удалить", false, () -> categoryForm(category, true)));
        }
        showForm("Темы видео", panel, null, null);
    }

    private void categoryForm(JSONObject category, boolean remove) {
        var panel = formPanel();
        boolean create = category == null;
        EditText name = remove ? null
            : field(panel, "Название темы", create ? "" : category.optString("name"), 0, 40, true);
        if (remove) panel.addView(label("Удалить тему «" + category.optString("name") + "»? Видео останутся на полке.", 16, INK));
        showForm(create ? "Добавить тему" : remove ? "Удалить тему" : "Переименовать тему", panel,
            remove ? "Удалить" : "Сохранить", (current, error) -> {
                if (!remove && value(name).trim().isEmpty()) {
                    name.setError("Введите название темы");
                    return;
                }
                String path = create ? "categories" : "categories/" + category.optString("id");
                JSONObject data = remove ? null : json("name", value(name).trim());
                submit(current, error, () -> request(path, create ? "POST" : remove ? "DELETE" : "PATCH", data),
                    result -> {
                        categories = array(result, "categories");
                        renderLibrary();
                        manageCategories();
                        refresh();
                    });
            });
    }

    private void resetBody() {
        root.removeAllViews();
        list = null;
        body = vertical();
        body.setPadding(dp(20), dp(12), dp(20), 0);
        root.addView(body, new FrameLayout.LayoutParams(-1, -1));
    }

    private LinearLayout screenPanel(String heading, String description) {
        var scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        body.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        var panel = vertical();
        panel.setGravity(Gravity.CENTER_VERTICAL);
        panel.setPadding(0, dp(16), 0, dp(24));
        scroll.addView(panel, new ViewGroup.LayoutParams(-1, -2));
        var icon = new ImageView(this);
        icon.setImageResource(R.drawable.ic_polka);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        panel.addView(icon, new LinearLayout.LayoutParams(dp(54), dp(54)));
        var title = label(heading, 36, INK);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(0, dp(12), 0, dp(2));
        panel.addView(title);
        var subtitle = label(description, 17, MUTED);
        subtitle.setPadding(0, 0, 0, dp(22));
        panel.addView(subtitle);
        return panel;
    }

    private LinearLayout vertical() {
        var layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout formPanel() {
        var panel = vertical();
        panel.setPadding(dp(22), dp(12), dp(22), dp(6));
        return panel;
    }

    private EditText field(LinearLayout panel, String hint, String value, int type, int max, boolean singleLine) {
        var name = label(hint, 14, MUTED);
        name.setPadding(0, dp(9), 0, 0);
        panel.addView(name);
        var input = new EditText(this);
        input.setId(View.generateViewId());
        name.setLabelFor(input.getId());
        if (singleLine) input.setSingleLine(true);
        input.setInputType((type & InputType.TYPE_MASK_CLASS) != 0 ? type
            : InputType.TYPE_CLASS_TEXT | type | (singleLine ? 0 : InputType.TYPE_TEXT_FLAG_MULTI_LINE));
        if (!singleLine) input.setMaxLines(4);
        input.setTextSize(16);
        input.setTextColor(INK);
        input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(max)});
        input.setText(value);
        panel.addView(input, new LinearLayout.LayoutParams(-1, -2));
        return input;
    }

    private TextView label(String text, int sp, int color) {
        var result = new TextView(this);
        result.setText(text);
        result.setTextSize(sp);
        result.setTextColor(color);
        return result;
    }

    private ImageButton iconButton(int drawable, String description, int inset, Runnable action) {
        var button = new ImageButton(this);
        button.setImageResource(drawable);
        button.setColorFilter(GREEN);
        button.setContentDescription(description);
        button.setTooltipText(description);
        button.setPadding(dp(inset), dp(inset), dp(inset), dp(inset));
        button.setScaleType(ImageView.ScaleType.FIT_CENTER);
        button.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(0x28123b32), null, shape(Color.WHITE, 24)));
        button.setOnClickListener(view -> {
            if (!busy && !apkUpdates.blocking()) action.run();
        });
        return button;
    }

    private Button button(String text, boolean primary, Runnable action) {
        var button = new Button(this);
        button.setAllCaps(false);
        button.setText(text);
        button.setTextColor(primary ? Color.WHITE : GREEN);
        button.setTextSize(14);
        button.setMinHeight(dp(48));
        button.setPadding(dp(14), dp(8), dp(14), dp(8));
        button.setBackground(buttonBackground(primary ? GREEN : LIGHT_GREEN, primary ? 0x35ffffff : 0x28123b32));
        button.setOnClickListener(view -> {
            if (!busy && !apkUpdates.blocking()) action.run();
        });
        return button;
    }

    private android.graphics.drawable.RippleDrawable buttonBackground(int color, int ripple) {
        var background = new android.graphics.drawable.InsetDrawable(shape(color, 14), 0, dp(3), 0, dp(3));
        return new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(ripple), background, null);
    }

    private GradientDrawable shape(int color, int radius) {
        var drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private interface FormAction {
        void click(AlertDialog current, TextView error);
    }

    private AlertDialog showForm(String heading, LinearLayout panel, String positive, FormAction action) {
        playback.close();
        closeDialog();
        var error = label("", 14, ERROR);
        error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        error.setVisibility(View.GONE);
        panel.addView(error);
        var scroll = new ScrollView(this);
        scroll.addView(panel);
        var builder = new AlertDialog.Builder(this)
            .setTitle(heading).setView(scroll).setNegativeButton("Закрыть", null);
        if (positive != null) builder.setPositiveButton(positive, null);
        var current = builder.create();
        dialog = current;
        dialogError = error;
        current.setOnDismissListener(ignored -> dialogDismissed(current));
        current.show();
        current.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
            | android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (positive != null) {
            current.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                if (!busy) action.click(current, error);
            });
        }
        return current;
    }

    private void dialogDismissed(AlertDialog current) {
        if (dialog == current) {
            dialog = null;
            dialogError = null;
            handler.post(deliver);
            apkUpdates.reconsider();
        }
    }

    private void closeDialog() {
        if (dialog == null) return;
        var closing = dialog;
        dialog = null;
        dialogError = null;
        closing.dismiss();
        handler.post(deliver);
        apkUpdates.reconsider();
    }

    private void submit(AlertDialog current, TextView error, Callable<JSONObject> request,
                        Consumer<JSONObject> success) {
        current.setCancelable(false);
        current.setCanceledOnTouchOutside(false);
        var negative = current.getButton(AlertDialog.BUTTON_NEGATIVE);
        var positive = current.getButton(AlertDialog.BUTTON_POSITIVE);
        negative.setEnabled(false);
        if (positive != null) positive.setEnabled(false);
        if (error != null) error.setVisibility(View.GONE);
        runBusy(request, result -> {
            if (dialog == current) {
                enableDialog(current);
                success.accept(result);
            }
        }, failure -> {
            if (dialog != current) return;
            enableDialog(current);
            if (error == null) toast(message(failure));
            else {
                error.setText(message(failure));
                error.setVisibility(View.VISIBLE);
            }
        });
    }

    private void enableDialog(AlertDialog current) {
        current.setCancelable(true);
        current.setCanceledOnTouchOutside(true);
        current.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true);
        var positive = current.getButton(AlertDialog.BUTTON_POSITIVE);
        if (positive != null) positive.setEnabled(true);
    }

    private void runBusy(Callable<JSONObject> task, Consumer<JSONObject> success, Consumer<Exception> failure) {
        busy = true;
        run(catalogQueue, task, (result, error) -> {
            busy = false;
            if (error == null) success.accept(result);
            else failure.accept(error);
            handler.post(deliver);
            apkUpdates.reconsider();
        });
    }

    private interface Completion<T> {
        void accept(T result, Exception error);
    }

    private <T> void run(ExecutorService queue, Callable<T> task, Completion<T> completion) {
        if (destroyed) return;
        queue.execute(() -> {
            try {
                T result = task.call();
                handler.post(() -> { if (!destroyed) completion.accept(result, null); });
            } catch (Exception error) {
                handler.post(() -> { if (!destroyed) completion.accept(null, error); });
            }
        });
    }

    private void watchText(EditText input, Runnable onChanged) {
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                onChanged.run();
            }
            @Override public void afterTextChanged(Editable text) {}
        });
    }

    private static JSONObject json(Object... entries) {
        var result = new JSONObject();
        for (int i = 0; i < entries.length; i += 2) put(result, (String) entries[i], entries[i + 1]);
        return result;
    }

    private static void put(JSONObject target, String key, Object value) {
        try { target.put(key, value); }
        catch (org.json.JSONException error) { throw new IllegalArgumentException(error); }
    }

    private static JSONArray array(JSONObject target, String key) {
        var array = target.optJSONArray(key);
        return array == null ? new JSONArray() : array;
    }

    private static String value(EditText input) { return input.getText().toString(); }

    private boolean parent() { return session != null && "parent".equals(session.optString("role")); }

    private boolean unauthorized(Exception error) {
        return error instanceof CatalogBackend.Failure cloud && cloud.status == 401
            || error instanceof LocalCatalog.Failure local && local.status == 401;
    }

    private String message(Exception error) {
        if (error instanceof CatalogBackend.Failure || error instanceof LocalCatalog.Failure) return error.getMessage();
        return "Не удалось связаться с сервером. Попробуйте ещё раз.";
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        apkUpdates.cancelPreparation();
        captureShare(intent);
        if (session == null && !busy && dialog == null && (cloudBackend != null || localBackend != null)) {
            showWelcome("");
        }
        deliverShare();
    }

    private void captureShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String link = SharedVideoLink.find(intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        if (link == null) {
            String html = intent.getStringExtra(Intent.EXTRA_HTML_TEXT);
            if (html != null) link = SharedVideoLink.find(Html.fromHtml(html, Html.FROM_HTML_MODE_LEGACY));
        }
        var clip = intent.getClipData();
        for (int i = 0; link == null && clip != null && i < clip.getItemCount(); i++) {
            var item = clip.getItemAt(i);
            link = SharedVideoLink.find(item.getText());
            if (link == null && item.getUri() != null) link = SharedVideoLink.find(item.getUri().toString());
            if (link == null && item.getHtmlText() != null) {
                link = SharedVideoLink.find(Html.fromHtml(item.getHtmlText(), Html.FROM_HTML_MODE_LEGACY));
            }
        }
        setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        if (link == null) toast("Поделитесь ссылкой на видео YouTube.");
        else {
            pendingLink = link;
            getPreferences(MODE_PRIVATE).edit().putString("pendingShare", link).apply();
        }
    }

    private void deliverShare() {
        if (pendingLink == null || !resumed || session == null || !catalogLoaded || busy
            || dialog != null || playback.isOpen() || apkUpdates.blocking()) return;
        String link = pendingLink;
        pendingLink = null;
        if (parent()) videoForm(null, link);
        else {
            getPreferences(MODE_PRIVATE).edit().remove("pendingShare").apply();
            toast("Добавлять видео можно в родительском режиме.");
        }
    }

    @Override public void onBackPressed() {
        if (apkUpdates.blocking() || busy || playback.back()) return;
        if (session != null && showFavorites) toggleFavoritesFeed();
        else super.onBackPressed();
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        playback.resume();
        apkUpdates.resume();
        deliverShare();
        if (session != null) refresh();
    }

    @Override protected void onPause() {
        resumed = false;
        handler.removeCallbacks(poll);
        apkUpdates.pause();
        playback.pause();
        super.onPause();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        playback.close();
        apkUpdates.destroy();
        handler.removeCallbacksAndMessages(null);
        if (dialog != null) {
            dialog.setOnDismissListener(null);
            dialog.dismiss();
        }
        catalogQueue.shutdownNow();
        previews.shutdownNow();
        images.shutdownNow();
        super.onDestroy();
    }
}
