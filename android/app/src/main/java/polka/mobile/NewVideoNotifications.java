package polka.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONArray;
import org.json.JSONException;

import java.net.URI;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Registers the paired device and renders incoming pushes without contacting the shelf. */
final class NewVideoNotifications {
    static final String CHANNEL_ID = "new-shelf-videos";
    static final String OPEN_SHELF = "polka.mobile.OPEN_SHELF";
    private static final String NOTICE_TAG_PREFIX = "new-shelf-video:";
    private static final int NOTICE_ID = 1;
    private static final int MAX_RECENT_EVENTS = 128;
    private static final long PUSH_TTL_MS = 24 * 60 * 60 * 1000L;
    private static final ExecutorService registration = Executors.newSingleThreadExecutor();

    record Shelf(URI endpoint, String family, String uid) {}

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("new-video-notifications", Context.MODE_PRIVATE);
    }

    static boolean supports(Context context, URI endpoint) {
        return endpoint != null && endpoint.equals(URI.create(context.getString(R.string.firebase_origin) + "/"));
    }

    static boolean hasRegistration(Context context, String uid) {
        var current = shelf(context);
        return current != null && current.uid().equals(uid) && preferences(context).contains("registeredToken");
    }

    static Shelf shelf(Context context) {
        var stored = preferences(context);
        String uid = stored.getString("uid", "");
        if (uid.isEmpty()) return null;
        return new Shelf(URI.create(stored.getString("endpoint", "")), stored.getString("family", ""), uid);
    }

    static synchronized void setShelf(Context context, Shelf next) {
        Shelf previous = shelf(context);
        if (Objects.equals(next, previous)) return;
        var editor = preferences(context).edit()
            .remove("endpoint").remove("family").remove("uid").remove("registeredToken").remove("events");
        if (next != null) {
            editor.putString("endpoint", next.endpoint().toString()).putString("family", next.family()).putString("uid", next.uid());
        }
        editor.apply();
        if (next == null) FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        var manager = context.getSystemService(NotificationManager.class);
        for (var notice : manager.getActiveNotifications()) {
            if (notice.getTag() != null && notice.getTag().startsWith(NOTICE_TAG_PREFIX)) {
                manager.cancel(notice.getTag(), notice.getId());
            }
        }
    }

    static void createChannel(Context context) {
        context.getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL_ID, "Новые видео на полке", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private static boolean enabled(Context context) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        var manager = context.getSystemService(NotificationManager.class);
        var channel = manager.getNotificationChannel(CHANNEL_ID);
        return manager.areNotificationsEnabled() && channel != null
            && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    static void syncRegistration(Context context) {
        var app = context.getApplicationContext();
        var current = shelf(app);
        if (current == null) return;
        var messaging = FirebaseMessaging.getInstance();
        boolean allowed = enabled(app);
        messaging.setAutoInitEnabled(allowed);
        if (!allowed) {
            if (preferences(app).contains("registeredToken")) register(app, current, null);
            return;
        }
        messaging.getToken().addOnSuccessListener(token -> register(app, current, token));
    }

    static void tokenChanged(Context context, String token) {
        var app = context.getApplicationContext();
        var current = shelf(app);
        if (current != null && enabled(app)) register(app, current, token);
    }

    private static void register(Context context, Shelf expected, String token) {
        registration.execute(() -> {
            var stored = preferences(context);
            if (!expected.equals(shelf(context)) || (token != null && !enabled(context))
                    || Objects.equals(token, stored.getString("registeredToken", null))) return;
            try {
                var backend = CatalogBackend.forEndpoint(context, expected.endpoint());
                backend.registerVideoNotifications(expected, token);
                synchronized (NewVideoNotifications.class) {
                    if (expected.equals(shelf(context))) stored.edit().putString("registeredToken", token).apply();
                }
            } catch (Exception error) {
                Log.w("VideoNotifications", "Could not update push registration");
            }
        });
    }

    static void videoSaved(Context context, CatalogBackend backend, String family, String id, String created) {
        if (created.isEmpty()) return;
        String key = "outbox:" + family;
        var stored = preferences(context);
        synchronized (NewVideoNotifications.class) {
            var pending = new HashSet<>(stored.getStringSet(key, Collections.emptySet()));
            pending.add(id + "|" + created);
            stored.edit().putStringSet(key, pending).apply();
        }
        flush(context, backend, family);
    }

    static void flush(Context context, CatalogBackend backend, String family) {
        var stored = preferences(context);
        String key = "outbox:" + family;
        if (!stored.contains(key)) return;
        registration.execute(() -> {
            for (String event : stored.getStringSet(key, Collections.emptySet())) {
                int split = event.indexOf('|');
                if (split < 0) continue;
                String created = event.substring(split + 1);
                try {
                    if (System.currentTimeMillis() - Instant.parse(created).toEpochMilli() < PUSH_TTL_MS
                            && !backend.sendVideoNotification(family, event.substring(0, split), created)) return;
                } catch (DateTimeParseException ignored) {
                    // Invalid saved data cannot be delivered.
                } catch (Exception error) {
                    continue;
                }
                synchronized (NewVideoNotifications.class) {
                    var pending = new HashSet<>(stored.getStringSet(key, Collections.emptySet()));
                    pending.remove(event);
                    var editor = stored.edit();
                    if (pending.isEmpty()) editor.remove(key);
                    else editor.putStringSet(key, pending);
                    editor.apply();
                }
            }
        });
    }

    static synchronized void receive(Context context, Map<String, String> data) {
        var current = shelf(context);
        if (current == null || !"newShelfVideo".equals(data.get("type"))
                || !current.family().equals(data.get("family")) || !current.uid().equals(data.get("recipient"))
                || !enabled(context)) return;
        String event = data.get("event");
        if (event == null || event.isEmpty() || event.length() > 200) return;
        var stored = preferences(context);
        JSONArray recent;
        try {
            recent = new JSONArray(stored.getString("events", "[]"));
        } catch (JSONException error) {
            recent = new JSONArray();
        }
        for (int i = 0; i < recent.length(); i++) if (event.equals(recent.optString(i))) return;
        if (recent.length() >= MAX_RECENT_EVENTS) recent.remove(0);

        var intent = new Intent(context, MainActivity.class).setAction(OPEN_SHELF);
        var openShelf = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE);
        String title = data.getOrDefault("title", "На семейной полке появилось новое видео");
        var notification = new Notification.Builder(context, CHANNEL_ID)
            .setContentTitle("Новое видео на полке")
            .setContentText(title)
            .setSmallIcon(R.drawable.ic_new_video_notification)
            .setStyle(new Notification.BigTextStyle().bigText(title))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(openShelf)
            .setAutoCancel(true)
            .build();
        context.getSystemService(NotificationManager.class).notify(NOTICE_TAG_PREFIX + event, NOTICE_ID, notification);
        stored.edit().putString("events", recent.put(event).toString()).apply();
    }
}
