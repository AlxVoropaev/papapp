package polka.mobile;

import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.AtomicFile;
import android.util.Log;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

final class ApkUpdates {
    static final String RESULT_ACTION = "polka.mobile.APK_INSTALL_RESULT";
    static final int JOB_ID = 704103;
    private static final long CHECK_INTERVAL = 15 * 60 * 1000L;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean CHECKING = new AtomicBoolean();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    static Intent confirmation;

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("apk-updates", Context.MODE_PRIVATE);
    }

    static boolean debug(Context context) {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    static void configure(Context context, URI endpoint) {
        String manifest = context.getString(R.string.apk_update_manifest);
        if (manifest.isEmpty()) {
            if (endpoint == null) return;
            manifest = endpoint.resolve("android/latest.json").toString();
        }
        try {
            ApkRelease.checkedUrl(manifest, debug(context));
            var preferences = prefs(context);
            if (!manifest.equals(preferences.getString("manifest", ""))) {
                preferences.edit().putString("manifest", manifest).remove("checked").apply();
            }
            schedule(context);
        } catch (IllegalArgumentException ignored) {
            // Ordinary local HTTP prototypes do not opt into package updates.
        }
    }

    static void schedule(Context context) {
        if (prefs(context).getString("manifest", "").isEmpty()) return;
        var scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler.getPendingJob(JOB_ID) == null) {
            scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, ApkUpdateJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
                .setPeriodic(6 * 60 * 60 * 1000L).build());
        }
    }

    static long installedVersion(Context context) throws Exception {
        return version(context.getPackageManager().getPackageInfo(context.getPackageName(), 0));
    }

    static long version(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    static File directory(Context context) {
        File folder = new File(context.getFilesDir(), "apk-updates");
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("Cannot create update directory");
        return folder;
    }

    static File apk(Context context) { return new File(directory(context), "ready.apk"); }

    static ApkRelease readRelease(Context context) throws Exception {
        var saved = new AtomicFile(new File(directory(context), "ready.json"));
        return parse(context, new JSONObject(new String(saved.readFully(), StandardCharsets.UTF_8)));
    }

    private static ApkRelease parse(Context context, JSONObject data) throws Exception {
        if (data.getInt("schema") != 1 || !context.getPackageName().equals(data.getString("packageName"))) {
            throw new IllegalArgumentException("Wrong APK package");
        }
        if (!"direct".equals(data.optString("source", "direct"))) {
            throw new IllegalArgumentException("Unknown APK source");
        }
        return new ApkRelease(data.getLong("versionCode"), data.getString("versionName"), data.getString("url"),
            data.getLong("size"), data.getString("sha256"), debug(context));
    }

    static boolean ready(Context context) {
        try {
            return prefs(context).getLong("readyVersion", 0) > installedVersion(context) && apk(context).isFile();
        } catch (Exception ignored) { return false; }
    }

    static Future<?> check(Context context, boolean force, Consumer<Exception> finished) {
        Context app = context.getApplicationContext();
        return IO.submit(() -> {
            Exception failure = null;
            try {
                var preferences = prefs(app);
                String bundledSource = app.getString(R.string.apk_update_manifest);
                String configuredSource = preferences.getString("manifest", "");
                String source = bundledSource.isEmpty() ? configuredSource : bundledSource;
                if (source.isEmpty()) {
                    if (force) throw new IllegalStateException("APK update source is not configured");
                    return;
                }
                if (preferences.getInt("session", -1) >= 0 || (!force
                        && source.equals(configuredSource)
                        && System.currentTimeMillis() - preferences.getLong("checked", 0) < CHECK_INTERVAL)) return;
                if (!CHECKING.compareAndSet(false, true)) return;
                try {
                    JSONObject data;
                    HttpURLConnection connection = connect(app, URI.create(source));
                    try (InputStream in = connection.getInputStream()) {
                        data = new JSONObject(new String(readLimited(in, 32768), StandardCharsets.UTF_8));
                    } finally { connection.disconnect(); }
                    ApkRelease release = parse(app, data);
                    preferences.edit().putString("manifest", source).putLong("checked", System.currentTimeMillis()).apply();
                    if (release.versionCode <= installedVersion(app)) {
                        preferences.edit().remove("readyVersion").apply();
                        return;
                    }
                    if (ready(app) && readRelease(app).sha256.equals(release.sha256)) return;
                    preferences.edit().remove("readyVersion").apply();
                    File partial = new File(directory(app), "download.part");
                    try {
                        connection = connect(app, release.url);
                        try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(partial)) {
                            var digest = MessageDigest.getInstance("SHA-256");
                            byte[] buffer = new byte[32768];
                            long total = 0;
                            int count;
                            while ((count = in.read(buffer)) != -1) {
                                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                                total += count;
                                if (total > release.size) throw new IllegalArgumentException("APK exceeds declared size");
                                digest.update(buffer, 0, count);
                                out.write(buffer, 0, count);
                            }
                            out.getFD().sync();
                            if (total != release.size || !hex(digest.digest()).equals(release.sha256)) {
                                throw new IllegalArgumentException("APK checksum or size mismatch");
                            }
                        } finally { connection.disconnect(); }
                        validateApk(app, partial, release);
                        File target = apk(app);
                        if (!partial.renameTo(target)) throw new IllegalStateException("Cannot store APK");
                        var saved = new AtomicFile(new File(directory(app), "ready.json"));
                        FileOutputStream output = saved.startWrite();
                        try {
                            output.write(data.toString().getBytes(StandardCharsets.UTF_8));
                            saved.finishWrite(output);
                        } catch (Exception e) { saved.failWrite(output); throw e; }
                        preferences.edit().putLong("readyVersion", release.versionCode).remove("deferUntil").commit();
                    } finally { partial.delete(); }
                } finally { CHECKING.set(false); }
            } catch (Exception e) {
                failure = e;
                Log.w("PolkaUpdates", "Update check deferred: " + e.getClass().getSimpleName());
            } finally {
                Exception result = failure;
                if (finished != null) MAIN.post(() -> finished.accept(result));
            }
        });
    }

    private static HttpURLConnection connect(Context context, URI source) throws Exception {
        URI current = source;
        for (int i = 0; i < 6; i++) {
            ApkRelease.checkedUrl(current.toString(), debug(context));
            var connection = (HttpURLConnection) current.toURL().openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("Cache-Control", "no-cache");
            connection.setRequestProperty("Accept-Encoding", "identity");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null) throw new IllegalArgumentException("Invalid redirect");
                current = current.resolve(location);
            } else if (status == 200) return connection;
            else {
                connection.disconnect();
                throw new IllegalStateException("Update HTTP " + status);
            }
        }
        throw new IllegalArgumentException("Too many redirects");
    }

    private static byte[] readLimited(InputStream in, int limit) throws Exception {
        var output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = in.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
            if (output.size() + count > limit) throw new IllegalArgumentException("Manifest too large");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    static void validateApk(Context context, File file, ApkRelease release) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = in.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        if (file.length() != release.size || !hex(digest.digest()).equals(release.sha256)) {
            throw new IllegalArgumentException("Downloaded APK changed");
        }
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(file.toString(), flags);
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        if (archive == null || !context.getPackageName().equals(archive.packageName)
                || version(archive) != release.versionCode || version(archive) <= version(installed)
                || archive.applicationInfo == null || archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT
                || !signers(archive).equals(signers(installed)) || signers(installed).isEmpty()) {
            throw new IllegalArgumentException("APK identity, version, platform or signing certificate mismatch");
        }
    }

    private static HashSet<String> signers(PackageInfo info) {
        var result = new HashSet<String>();
        var signatures = Build.VERSION.SDK_INT >= 28
            ? info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners() : info.signatures;
        if (signatures != null) for (var signature : signatures) result.add(hex(signature.toByteArray()));
        return result;
    }

    static String hex(byte[] data) {
        var out = new StringBuilder(data.length * 2);
        for (byte value : data) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return out.toString();
    }

    static void prepare(Context context, BiConsumer<Integer, Exception> result) {
        Context app = context.getApplicationContext();
        IO.execute(() -> {
            int id = -1;
            try {
                if (!ready(app)) {
                    MAIN.post(() -> result.accept(-1, null));
                    return;
                }
                ApkRelease release = readRelease(app);
                validateApk(app, apk(app), release);
                var parameters = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                parameters.setAppPackageName(app.getPackageName());
                parameters.setSize(release.size);
                if (Build.VERSION.SDK_INT >= 31) parameters.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                var installer = app.getPackageManager().getPackageInstaller();
                id = installer.createSession(parameters);
                try (var session = installer.openSession(id); var in = new FileInputStream(apk(app));
                        var out = session.openWrite("base.apk", 0, release.size)) {
                    byte[] buffer = new byte[32768];
                    int count;
                    while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                    session.fsync(out);
                }
                final int prepared = id;
                MAIN.post(() -> result.accept(prepared, null));
            } catch (Exception e) {
                if (id >= 0) abandon(app, id);
                MAIN.post(() -> result.accept(-1, e));
            }
        });
    }

    static void commit(Context context, int id) throws Exception {
        var intent = new Intent(context, ApkUpdateReceiver.class).setAction(RESULT_ACTION)
            .setData(android.net.Uri.parse("polka-update://session/" + id));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        var callback = PendingIntent.getBroadcast(context, id, intent, flags);
        prefs(context).edit().putInt("session", id).putString("state", "installing").commit();
        try (var session = context.getPackageManager().getPackageInstaller().openSession(id)) {
            session.commit(callback.getIntentSender());
        } catch (Exception e) { abandon(context, id); throw e; }
    }

    static void abandon(Context context, int id) {
        try { context.getPackageManager().getPackageInstaller().abandonSession(id); } catch (Exception ignored) {}
        if (prefs(context).getInt("session", -1) == id) {
            prefs(context).edit().remove("session").remove("state").apply();
            confirmation = null;
        }
    }

    static void defer(Context context) {
        prefs(context).edit().putLong("deferUntil", System.currentTimeMillis() + 24 * 60 * 60 * 1000L).apply();
    }
}
