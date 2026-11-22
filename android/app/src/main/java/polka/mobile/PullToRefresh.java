package polka.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import java.util.function.BooleanSupplier;

final class PullToRefresh extends FrameLayout {
    private final View content;
    private final ProgressBar indicator;
    private final BooleanSupplier canRefresh;
    private final Runnable refresh;
    private final int touchSlop;
    private final float threshold;
    private float startX;
    private float startY;
    private boolean tracking;
    private boolean dragging;
    private boolean refreshing;

    PullToRefresh(Context context, View content, int color, BooleanSupplier canRefresh, Runnable refresh) {
        super(context);
        this.content = content;
        this.canRefresh = canRefresh;
        this.refresh = refresh;
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        float density = getResources().getDisplayMetrics().density;
        threshold = 56 * density;
        addView(content, new LayoutParams(-1, -1));

        indicator = new ProgressBar(context);
        indicator.setIndeterminateTintList(ColorStateList.valueOf(color));
        indicator.setContentDescription("Обновление ленты");
        indicator.setVisibility(INVISIBLE);
        int size = Math.round(28 * density);
        var params = new LayoutParams(size, size, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        params.topMargin = Math.round((threshold - size) / 2);
        addView(indicator, params);
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                startX = event.getX();
                startY = event.getY();
                tracking = !refreshing && !content.canScrollVertically(-1) && canRefresh.getAsBoolean();
                return false;
            case MotionEvent.ACTION_MOVE:
                return startDrag(event);
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
            case MotionEvent.ACTION_POINTER_DOWN:
                tracking = false;
                return false;
            default:
                return false;
        }
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                return tracking;
            case MotionEvent.ACTION_MOVE:
                if (dragging || startDrag(event)) {
                    float distance = Math.max(0, (event.getY() - startY - touchSlop) / 2);
                    content.setTranslationY(Math.min(distance, threshold * 1.2f));
                    indicator.setAlpha(Math.min(1, distance / threshold));
                }
                return true;
            case MotionEvent.ACTION_UP:
                boolean shouldRefresh = dragging && content.getTranslationY() >= threshold
                    && canRefresh.getAsBoolean();
                tracking = dragging = false;
                if (shouldRefresh) {
                    refreshing = true;
                    content.animate().translationY(threshold).setDuration(160).start();
                    refresh.run();
                } else if (!refreshing) {
                    resetPull();
                }
                return true;
            case MotionEvent.ACTION_CANCEL:
            case MotionEvent.ACTION_POINTER_DOWN:
                tracking = dragging = false;
                if (!refreshing) resetPull();
                return true;
            default:
                return true;
        }
    }

    private boolean startDrag(MotionEvent event) {
        if (!tracking) return false;
        float dx = Math.abs(event.getX() - startX);
        float dy = event.getY() - startY;
        if ((dx > touchSlop && dx >= Math.abs(dy)) || dy < -touchSlop) tracking = false;
        if (!tracking || dy <= touchSlop || content.canScrollVertically(-1)) return false;
        dragging = true;
        content.animate().cancel();
        indicator.animate().cancel();
        indicator.setAlpha(0);
        indicator.setVisibility(VISIBLE);
        return true;
    }

    void finishRefresh() {
        if (!refreshing) return;
        refreshing = false;
        resetPull();
    }

    private void resetPull() {
        content.animate().translationY(0).setDuration(160).start();
        indicator.animate().alpha(0).setDuration(160).withEndAction(() -> indicator.setVisibility(INVISIBLE)).start();
    }
}
