package polka.mobile;

import android.app.job.JobParameters;
import android.app.job.JobService;
import java.util.concurrent.Future;

public final class ApkUpdateJob extends JobService {
    private Future<?> work;
    private boolean stopped;

    @Override public boolean onStartJob(JobParameters params) {
        stopped = false;
        work = ApkUpdates.check(this, true, error -> { if (!stopped) jobFinished(params, false); });
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) {
        stopped = true;
        if (work != null) work.cancel(true);
        return true;
    }
}
