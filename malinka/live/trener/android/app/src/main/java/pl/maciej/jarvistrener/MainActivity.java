package pl.maciej.jarvistrener;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * JARVIS Trener: pełnoekranowy WebView z appką z malinki (tylko przez Tailscale).
 * Appka aktualizuje się sama przy każdym wdrożeniu na malince — APK trzeba zmieniać tylko przy zmianie tej nakładki.
 * Most JS "TrenerApp": ekran nie gaśnie w trakcie treningu (Wake Lock API w WebView nie działa).
 */
public class MainActivity extends Activity {
    static final String URL = "https://malinka.tail0524ca.ts.net:8444/";
    static final String HOST = "malinka.tail0524ca.ts.net";

    WebView web;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0d0f12"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // sygnał końca przerwy (AudioContext) bez dotknięcia w tej samej chwili
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " JarvisTrener/1");

        web.addJavascriptInterface(new Bridge(), "TrenerApp");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // linki na zewnątrz (np. zdjęcia ćwiczeń, intervals.icu) — w przeglądarce
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showOffline(String.valueOf(e.getDescription()));
            }
        });

        if (b != null) web.restoreState(b);
        else web.loadUrl(URL);
    }

    void showOffline(String why) {
        String html = "<html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>body{background:#0d0f12;color:#e8ecf0;font:16px system-ui;display:flex;flex-direction:column;"
                + "align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}"
                + "b{font-size:22px}p{color:#8b95a1}button{font:inherit;font-weight:700;background:#c6f432;color:#10130a;"
                + "border:0;border-radius:14px;padding:14px 28px;margin-top:12px}</style></head><body>"
                + "<b>Brak połączenia z malinką</b>"
                + "<p>Sprawdź, czy Tailscale na telefonie jest włączony i czy jest internet.</p>"
                + "<p style='font-size:12px'>" + android.text.TextUtils.htmlEncode(why) + "</p>"
                + "<button onclick='TrenerApp.reload()'>Spróbuj ponownie</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    class Bridge {
        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> web.loadUrl(URL));
        }
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }
}
