package polka.mobile;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayInputStream;
import java.util.Locale;
import java.util.regex.Pattern;

final class VideoPlayback {
    private static final String YOUTUBE = "www.youtube.com";
    private static final Pattern VIDEO_ID = Pattern.compile("[A-Za-z0-9_-]{11}");
    private static final String PLAYER_PAGE = """
        <!doctype html>
        <html lang="ru">
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="referrer" content="strict-origin-when-cross-origin">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com%s">
        <style>
        html, body, iframe { width: 100%%; height: 100%%; margin: 0; border: 0; background: #000; }
        iframe { display: block; }
        </style>
        <iframe id="player" title="Плеер YouTube" src="%s" allow="encrypted-media; fullscreen%s" allowfullscreen></iframe>
        <script>
        let player;
        let appVisible = true;
        let ready = false;
        let started = false;
        let ended = false;
        function pauseHiddenPlayer() {
          if ((!appVisible || document.hidden) && player && typeof player.pauseVideo === 'function') {
            player.pauseVideo();
          }
        }
        function setPlaybackVisible(visible) {
          appVisible = visible;
          pauseHiddenPlayer();
        }
        function startFromApp() {
          if (started) return true;
          if (!ready || !appVisible || document.hidden) return false;
          started = true;
          player.playVideo();
          return true;
        }
        function playbackEnded() {
          return ended;
        }
        function onYouTubeIframeAPIReady() {
          player = new YT.Player('player', { events: {
            onReady: () => {
              ready = true;
              pauseHiddenPlayer();
            },
            onStateChange: event => {
              if (event.data === YT.PlayerState.ENDED) ended = true;
              if (event.data === YT.PlayerState.BUFFERING) started = true;
              if (event.data === YT.PlayerState.PLAYING) {
                started = true;
                pauseHiddenPlayer();
              }
            }
          }});
        }
        document.addEventListener('visibilitychange', pauseHiddenPlayer);
        </script>
        <script src="https://www.youtube.com/iframe_api"></script>
        """;

    private final Activity activity;
    private final FrameLayout fullscreenRoot;
    private final Runnable onClosed;
    private final String appOrigin;
    private final Runnable completionPoll = this::checkCompletion;
    private FrameLayout playerFrame;
    private WebView web;
    private FrameLayout fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean paused;

    VideoPlayback(Activity activity, FrameLayout fullscreenRoot, Runnable onClosed) {
        this.activity = activity;
        this.fullscreenRoot = fullscreenRoot;
        this.onClosed = onClosed;
        // Google uses the installed application ID as the embedded player's HTTPS referrer.
        appOrigin = "https://" + activity.getPackageName().toLowerCase(Locale.ROOT);
    }

    boolean open(FrameLayout host, String videoId, int startSeconds) {
        if (videoId == null || !VIDEO_ID.matcher(videoId).matches()
            || activity.isFinishing() || activity.isDestroyed() || isOpen()
            || !host.isAttachedToWindow()) return false;

        var frame = new FrameLayout(activity);
        frame.setBackgroundColor(Color.BLACK);
        frame.setClickable(true);
        frame.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override public void onViewAttachedToWindow(View view) {}

            @Override public void onViewDetachedFromWindow(View view) {
                fullscreenRoot.post(() -> {
                    if (frame == playerFrame && !frame.isAttachedToWindow()) close();
                });
            }
        });
        playerFrame = frame;
        host.addView(frame, new FrameLayout.LayoutParams(-1, -1));
        // The card's media slot already has bounds when its previously hidden host first opens.
        View visibleSlot = host.isLayoutRequested() && host.getParent() instanceof View parent ? parent : host;
        preparePlayer(videoId, startSeconds, !paused && mostlyVisible(visibleSlot));
        return true;
    }

    private void preparePlayer(String videoId, int startSeconds, boolean autoplay) {
        playerFrame.removeAllViews();
        String embedPath = "/embed/" + videoId;
        var embed = new Uri.Builder()
            .scheme("https")
            .authority(YOUTUBE)
            .path(embedPath)
            .appendQueryParameter("origin", appOrigin)
            .appendQueryParameter("enablejsapi", "1")
            .appendQueryParameter("playsinline", "1")
            .appendQueryParameter("rel", "0")
            .appendQueryParameter("hl", "ru");
        if (startSeconds > 0) embed.appendQueryParameter("start", Integer.toString(startSeconds));

        WebView view;
        try {
            view = new WebView(activity);
        } catch (RuntimeException noWebView) {
            showFailure(videoId, startSeconds);
            return;
        }
        web = view;
        view.setBackgroundColor(Color.BLACK);
        view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        view.setOnLongClickListener(ignored -> true);
        var settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(!autoplay);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);

        view.setWebViewClient(new WebViewClient() {
            private boolean autoplayScheduled;

            @Override public boolean shouldOverrideUrlLoading(WebView sender, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (request.isForMainFrame()) return true;
                if ("about:blank".equals(uri.toString())) return false;
                if (!allowedResource(uri)) return true;
                String path = uri.getPath();
                return YOUTUBE.equals(uri.getHost()) && !isEmbed(uri, embedPath)
                    && (path == null || !path.startsWith("/api/"));
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView sender, WebResourceRequest request) {
                Uri uri = request.getUrl();
                boolean allowed = request.isForMainFrame()
                    ? (appOrigin + "/").equals(uri.toString())
                    : allowedResource(uri) || "data".equals(uri.getScheme()) || "about:blank".equals(uri.toString());
                if (allowed) return null;
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }

            @Override public void onPageFinished(WebView sender, String url) {
                if (sender != web) return;
                if (paused) setPlaybackVisible(false);
                else {
                    scheduleCompletionCheck();
                    if (autoplay && !autoplayScheduled) {
                        autoplayScheduled = true;
                        tryAutoplay(sender, 40);
                    }
                }
            }

            @Override public void onReceivedError(WebView sender, WebResourceRequest request, WebResourceError error) {
                if (sender == web && (request.isForMainFrame() || isEmbed(request.getUrl(), embedPath))) {
                    playerFrame.post(() -> {
                        if (sender == web) showFailure(videoId, startSeconds);
                    });
                }
            }

            @Override public void onReceivedHttpError(WebView sender, WebResourceRequest request, WebResourceResponse response) {
                if (sender == web && (request.isForMainFrame() || isEmbed(request.getUrl(), embedPath))) {
                    playerFrame.post(() -> {
                        if (sender == web) showFailure(videoId, startSeconds);
                    });
                }
            }

            @Override public boolean onRenderProcessGone(WebView sender, RenderProcessGoneDetail detail) {
                if (sender == web) showFailure(videoId, startSeconds);
                return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View customView, CustomViewCallback callback) {
                if (fullscreen != null || web != view || !isOpen()) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreen = new FrameLayout(activity);
                fullscreen.setBackgroundColor(Color.BLACK);
                fullscreen.setClickable(true);
                fullscreen.setKeepScreenOn(true);
                fullscreenCallback = callback;
                fullscreen.addView(customView, new FrameLayout.LayoutParams(-1, -1));
                fullscreenRoot.addView(fullscreen, new FrameLayout.LayoutParams(-1, -1));
                setFullscreenBars(true);
            }

            @Override public void onHideCustomView() {
                if (web == view) hideFullscreen();
            }
        });
        playerFrame.addView(view, new FrameLayout.LayoutParams(-1, -1));
        // A local HTML document with this base URL emits the HTTPS Referer required by YouTube.
        String html = String.format(Locale.ROOT, PLAYER_PAGE, embedPath,
            embed.build().toString().replace("&", "&amp;"), autoplay ? "; autoplay" : "");
        view.loadDataWithBaseURL(appOrigin + "/", html, "text/html", "UTF-8", null);
        if (paused) view.onPause();
    }

    private static boolean mostlyVisible(View view) {
        var clipped = new Rect();
        return view.getWindowVisibility() == View.VISIBLE && view.getGlobalVisibleRect(clipped)
            && (long) clipped.width() * clipped.height() > (long) view.getWidth() * view.getHeight() / 2;
    }

    private void tryAutoplay(WebView view, int attempts) {
        if (view != web || paused || !mostlyVisible(view)) return;
        // The IFrame API becomes ready asynchronously. Check clipping before each attempt.
        view.evaluateJavascript("typeof startFromApp === 'function' && startFromApp()", result -> {
            if (!"true".equals(result) && attempts > 1 && view == web) {
                view.postDelayed(() -> tryAutoplay(view, attempts - 1), 250);
            }
        });
    }

    private void scheduleCompletionCheck() {
        if (web == null || paused) return;
        web.removeCallbacks(completionPoll);
        web.postDelayed(completionPoll, 750);
    }

    private void checkCompletion() {
        WebView current = web;
        if (current == null || paused) return;
        current.evaluateJavascript("typeof playbackEnded === 'function' && playbackEnded()", finished -> {
            if (current != web || paused) return;
            if ("true".equals(finished)) close();
            else scheduleCompletionCheck();
        });
    }

    private static boolean isEmbed(Uri uri, String embedPath) {
        return YOUTUBE.equals(uri.getHost()) && embedPath.equals(uri.getPath());
    }

    private static boolean allowedResource(Uri uri) {
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null || uri.getUserInfo() != null
            || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
        host = host.toLowerCase(Locale.ROOT);
        // Media, captions, images, player dependencies and YouTube ad delivery.
        return host.equals(YOUTUBE) || host.equals("youtubei.googleapis.com")
            || matchesDomain(host, "googlevideo.com") || matchesDomain(host, "ytimg.com")
            || matchesDomain(host, "ggpht.com") || matchesDomain(host, "gstatic.com")
            || host.equals("fonts.googleapis.com") || matchesDomain(host, "doubleclick.net")
            || matchesDomain(host, "googlesyndication.com") || host.equals("www.googleadservices.com");
    }

    private static boolean matchesDomain(String host, String domain) {
        return host.equals(domain) || host.endsWith("." + domain);
    }

    private void showFailure(String videoId, int startSeconds) {
        destroyPlayer();
        var feedback = new LinearLayout(activity);
        feedback.setOrientation(LinearLayout.VERTICAL);
        feedback.setGravity(Gravity.CENTER);
        feedback.setPadding(dp(20), dp(12), dp(20), dp(12));
        var message = new TextView(activity);
        message.setText("Не удалось загрузить плеер YouTube.");
        message.setTextColor(Color.WHITE);
        message.setGravity(Gravity.CENTER);
        message.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        feedback.addView(message);
        var retry = new Button(activity);
        retry.setText("Повторить");
        retry.setOnClickListener(view -> preparePlayer(videoId, startSeconds, false));
        feedback.addView(retry);
        playerFrame.addView(feedback, new FrameLayout.LayoutParams(-1, -1));
    }

    boolean isOpen() {
        return playerFrame != null;
    }

    boolean isFullscreen() {
        return fullscreen != null;
    }

    boolean back() {
        if (!isOpen()) return false;
        if (fullscreen != null) hideFullscreen();
        else close();
        return true;
    }

    private void hideFullscreen() {
        if (fullscreen == null) return;
        var overlay = fullscreen;
        fullscreen = null;
        var callback = fullscreenCallback;
        fullscreenCallback = null;
        fullscreenRoot.removeView(overlay);
        overlay.removeAllViews();
        setFullscreenBars(false);
        callback.onCustomViewHidden();
    }

    @SuppressWarnings("deprecation")
    private void setFullscreenBars(boolean full) {
        Window window = activity.getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null && full) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            } else if (controller != null) {
                controller.show(WindowInsets.Type.systemBars());
            }
            fullscreenRoot.requestApplyInsets();
        } else {
            window.getDecorView().setSystemUiVisibility(full
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                : 0);
        }
    }

    void pause() {
        paused = true;
        if (web == null) return;
        web.removeCallbacks(completionPoll);
        setPlaybackVisible(false);
        web.onPause();
    }

    void resume() {
        paused = false;
        if (web == null) return;
        web.onResume();
        setPlaybackVisible(true);
        scheduleCompletionCheck();
    }

    private void setPlaybackVisible(boolean visible) {
        web.evaluateJavascript("if (typeof setPlaybackVisible === 'function') setPlaybackVisible(" + visible + ")", null);
    }

    void close() {
        if (playerFrame == null) return;
        destroyPlayer();
        var frame = playerFrame;
        playerFrame = null;
        if (frame.getParent() instanceof FrameLayout host) host.removeView(frame);
        onClosed.run();
    }

    private void destroyPlayer() {
        hideFullscreen();
        if (web == null) return;
        var current = web;
        web = null;
        current.removeCallbacks(completionPoll);
        playerFrame.removeView(current);
        current.destroy();
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
