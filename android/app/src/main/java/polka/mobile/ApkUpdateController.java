package polka.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.Toast;
import java.util.function.BooleanSupplier;

/** Only this foreground coordinator may commit an installation. Downloads cannot commit. */
final class ApkUpdateController {
    private final Activity activity;
    private final BooleanSupplier safeNative;
    private final Runnable onUnblocked;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean resumed;
    private boolean destroyed;
    private boolean committed;
    private boolean confirmationLaunched;
    private boolean awaitingPermission;
    private int generation;
    private long lastCheck;
    private Dialog shield;
    private AlertDialog permissionDialog;
    private final Runnable poll = this::poll;

    ApkUpdateController(Activity activity, BooleanSupplier safeNative, Runnable onUnblocked) {
        this.activity = activity;
        this.safeNative = safeNative;
        this.onUnblocked = onUnblocked;
        // A previous process may have died while waiting for confirmation. Re-prepare at a new safe point.
        int stale = ApkUpdates.prefs(activity).getInt("session", -1);
        if (stale >= 0) ApkUpdates.abandon(activity, stale);
    }

    void resume() {
        resumed = true;
        if (awaitingPermission) {
            awaitingPermission = false;
            if (!activity.getPackageManager().canRequestPackageInstalls()) ApkUpdates.defer(activity);
        }
        ApkUpdates.check(activity, false, null);
        reconsider();
    }

    void reconsider() {
        if (!resumed || destroyed) return;
        handler.removeCallbacks(poll);
        handler.post(poll);
    }

    void installNow() {
        ApkUpdates.prefs(activity).edit().remove("deferUntil").apply();
        reconsider();
    }

    void pause() {
        resumed = false;
        handler.removeCallbacks(poll);
        if (!committed) cancelPreparation();
    }

    void destroy() {
        destroyed = true;
        generation++;
        handler.removeCallbacksAndMessages(null);
        release();
    }

    boolean blocking() { return shield != null || committed; }

    void cancelPreparation() {
        generation++;
        if (!committed) release();
    }

    private void poll() {
        if (!resumed || destroyed) return;
        if (System.currentTimeMillis() - lastCheck > 60000) {
            lastCheck = System.currentTimeMillis();
            ApkUpdates.check(activity, false, null);
        }
        var prefs = ApkUpdates.prefs(activity);
        if (committed) {
            String state = prefs.getString("state", "");
            if ("failed".equals(state) || "installed".equals(state) || prefs.getInt("session", -1) < 0) {
                if ("failed".equals(state)) Toast.makeText(activity,
                    "Обновление не установлено. Текущая версия продолжает работать.", Toast.LENGTH_LONG).show();
                committed = false;
                confirmationLaunched = false;
                release();
            } else if ("confirmation".equals(state) && !confirmationLaunched && ApkUpdates.confirmation != null) {
                confirmationLaunched = true;
                try { activity.startActivity(ApkUpdates.confirmation); }
                catch (RuntimeException e) {
                    ApkUpdates.abandon(activity, prefs.getInt("session", -1));
                    ApkUpdates.defer(activity);
                    committed = false;
                    confirmationLaunched = false;
                    release();
                }
            }
        } else if (!blocking() && safeNative.getAsBoolean() && ApkUpdates.ready(activity)
                && System.currentTimeMillis() >= prefs.getLong("deferUntil", 0)) {
            int token = ++generation;
            showShield();
            if (!activity.getPackageManager().canRequestPackageInstalls()) askPermission();
            else prepare(token);
        }
        if (resumed && !destroyed) handler.postDelayed(poll, 2000);
    }

    private void askPermission() {
        permissionDialog = new AlertDialog.Builder(activity)
            .setTitle("Разрешить обновления?")
            .setMessage(activity.getString(R.string.apk_update_permission_message, activity.getString(R.string.app_name)))
            .setPositiveButton("Разрешить", (dialog, which) -> {
                permissionDialog = null;
                release();
                awaitingPermission = true;
                try { activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()))); }
                catch (RuntimeException e) { awaitingPermission = false; ApkUpdates.defer(activity); }
            })
            .setNegativeButton("Позже", (dialog, which) -> { ApkUpdates.defer(activity); release(); })
            .setOnCancelListener(dialog -> { permissionDialog = null; ApkUpdates.defer(activity); release(); })
            .create();
        permissionDialog.show();
    }

    private void prepare(int token) {
        ApkUpdates.prepare(activity, (id, error) -> {
            if (token != generation || destroyed || !resumed || !safeNative.getAsBoolean()) {
                if (id >= 0) ApkUpdates.abandon(activity, id);
                if (token == generation) release();
                return;
            }
            if (error != null) {
                ApkUpdates.defer(activity);
                release();
                Toast.makeText(activity, "Не удалось подготовить обновление. Попробуем позже.", Toast.LENGTH_LONG).show();
                return;
            }
            if (id < 0) {
                release();
                return;
            }
            try {
                ApkUpdates.commit(activity, id);
                committed = true;
            } catch (Exception e) {
                ApkUpdates.defer(activity);
                release();
            }
        });
    }

    private void showShield() {
        var text = new TextView(activity);
        text.setText("Готовим обновление…");
        text.setTextSize(20);
        text.setTextColor(Color.rgb(20, 45, 39));
        text.setBackgroundColor(Color.rgb(248, 246, 239));
        text.setGravity(Gravity.CENTER);
        shield = new Dialog(activity, R.style.AppTheme);
        shield.setCancelable(false);
        shield.setContentView(text, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        shield.show();
        shield.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private void release() {
        boolean wasLocked = shield != null;
        if (permissionDialog != null) permissionDialog.dismiss();
        permissionDialog = null;
        if (shield != null) shield.dismiss();
        shield = null;
        if (wasLocked && resumed && !destroyed) handler.post(onUnblocked);
    }
}
