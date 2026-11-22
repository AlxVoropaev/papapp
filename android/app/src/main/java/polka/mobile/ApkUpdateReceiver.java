package polka.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

public final class ApkUpdateReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            ApkUpdates.prefs(context).edit().remove("session").remove("state").remove("readyVersion").apply();
            ApkUpdates.apk(context).delete();
            ApkUpdates.schedule(context);
            return;
        }
        if (!ApkUpdates.RESULT_ACTION.equals(intent.getAction())) return;
        var prefs = ApkUpdates.prefs(context);
        int id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        if (id < 0 || id != prefs.getInt("session", -1)) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            ApkUpdates.confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            prefs.edit().putString("state", "confirmation").apply();
        } else {
            prefs.edit().remove("session").putString("state", status == PackageInstaller.STATUS_SUCCESS ? "installed" : "failed").apply();
            ApkUpdates.confirmation = null;
            if (status == PackageInstaller.STATUS_SUCCESS) {
                prefs.edit().remove("readyVersion").apply();
                ApkUpdates.apk(context).delete();
            } else ApkUpdates.defer(context);
        }
    }
}
