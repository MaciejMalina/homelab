package pl.maciej.jarvispanel;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * JARVIS Panel — pełnoekranowy WebView z dashboardem z malinki.
 *
 * Strona sama decyduje, kiedy "zasnąć" (czarna zasłona + JarvisPanel.setSleep(true)),
 * a appka tylko ściemnia podświetlenie do minimum i trzyma ekran włączony, żeby dotyk
 * dalej działał i mógł go obudzić. Ustawienia: przytrzymaj 3 s lewy górny róg.
 */
public class MainActivity extends Activity {

    static final String DOMYSLNY_URL = "http://192.168.254.10:8084/";
    private static final long PRZYTRZYMAJ_MS = 3000;
    private static final long PONOW_MS = 10_000;
    private static final long PRZELADUJ_CO_MS = 6L * 60 * 60 * 1000; // świeża strona co 6 h

    private final Handler h = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private SharedPreferences prefs;
    private boolean uspiony = false;
    private Gesty gesty;
    private Glos glos;
    private static final int PROSBA_KAMERA = 1;

    private final Runnable pokazUstawienia = this::ustawienia;
    private final Runnable ponow = this::zaladuj;
    private final Runnable przeladujOkresowo = new Runnable() {
        @Override public void run() {
            zaladuj();
            h.postDelayed(this, PRZELADUJ_CO_MS);
        }
    };

    // ------------------------------------------------------------------ cykl życia
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("panel", MODE_PRIVATE);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        obejscieKlawiatury();
        utworzWebView();
        pelnyEkran();
        zaladuj();
        h.postDelayed(przeladujOkresowo, PRZELADUJ_CO_MS);

        gesty = new Gesty(this, h, this::gestDoStrony);
        glos = new Glos(this, h, this::glosDoStrony);
        poprosOUprawnienia();
        gesty.ustawWlaczone(prefs.getBoolean("gesty", true));
        glos.ustawWlaczone(prefs.getBoolean("glos", true));
    }

    @Override
    public void onRequestPermissionsResult(int kod, String[] uprawnienia, int[] wyniki) {
        super.onRequestPermissionsResult(kod, uprawnienia, wyniki);
        if (kod == PROSBA_KAMERA) {
            if (gesty != null) gesty.aktualizuj();
            if (glos != null) glos.aktualizuj();
        }
    }

    /** Kamera (gesty) i mikrofon (Hey Jarvis) — jedna prośba o oba, tylko o te włączone i jeszcze nienadane. */
    private void poprosOUprawnienia() {
        java.util.ArrayList<String> brak = new java.util.ArrayList<>();
        if (prefs.getBoolean("gesty", true) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            brak.add(Manifest.permission.CAMERA);
        }
        if (prefs.getBoolean("glos", true) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            brak.add(Manifest.permission.RECORD_AUDIO);
        }
        if (!brak.isEmpty()) requestPermissions(brak.toArray(new String[0]), PROSBA_KAMERA);
    }

    /** Zdarzenie głosowe → strona (window.jarvisGlos). Bez strony (ekran błędu) przynajmniej zapal ekran. */
    private void glosDoStrony(String stan, String tekst) {
        if ("wake".equals(stan) && uspiony) ustawSen(false);
        if (web == null) return;
        web.evaluateJavascript("window.jarvisGlos&&window.jarvisGlos(" + JSONObject.quote(stan) + "," + JSONObject.quote(tekst) + ")", null);
    }

    /** Rozpoznany gest → strona (window.jarvisGest). Gdy strona go nie obsługuje (np. ekran błędu), ✋ i tak budzi. */
    private void gestDoStrony(String g) {
        if (web == null) {
            if ("dlon".equals(g) && uspiony) ustawSen(false);
            return;
        }
        web.evaluateJavascript("(window.jarvisGest?(window.jarvisGest('" + g + "'),1):0)", v -> {
            if ("0".equals(v) && "dlon".equals(g) && uspiony) ustawSen(false);
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        pelnyEkran();
        if (web == null) {
            utworzWebView();
            zaladuj();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) pelnyEkran();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // kiosk: "wstecz" nic nie robi
    }

    @Override
    protected void onDestroy() {
        h.removeCallbacksAndMessages(null);
        if (gesty != null) gesty.zamknij();
        if (glos != null) glos.zamknij();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ WebView
    private void utworzWebView() {
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true); // bez menu kontekstowego przy przytrzymaniu
        web.setHapticFeedbackEnabled(false);
        web.addJavascriptInterface(new Most(), "JarvisPanel");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return false; // wszystko zostaje w panelu
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) stronaBledu(String.valueOf(err.getDescription()));
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                // proces renderujący padł (np. brak RAM-u) — stawiamy WebView od nowa zamiast crasha appki
                root.removeView(v);
                v.destroy();
                if (v == web) web = null;
                h.postDelayed(() -> {
                    if (web == null) {
                        utworzWebView();
                        zaladuj();
                    }
                }, 1000);
                return true;
            }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private String url() {
        return prefs.getString("url", DOMYSLNY_URL);
    }

    private void zaladuj() {
        h.removeCallbacks(ponow);
        if (web != null) web.loadUrl(url());
    }

    private void stronaBledu(String opis) {
        if (web == null) return;
        String html = "<html><body style='background:#000;color:#8b95a5;font:16px sans-serif;"
                + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'"
                + " onclick='JarvisPanel.setSleep(false)'>"
                + "<div>Brak połączenia z panelem<br><small>" + esc(url()) + "<br>" + esc(opis)
                + "</small><br><br>Ponawiam co 10 s…</div>"
                // bez malinki strona nie wygasi ekranu sama — robimy to tutaj po 2 min
                + "<script>setTimeout(function(){JarvisPanel.setSleep(true)},120000)</script>"
                + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        h.removeCallbacks(ponow);
        h.postDelayed(ponow, PONOW_MS);
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;");
    }

    // ------------------------------------------------------------------ ekran
    private void ustawSen(boolean sen) {
        uspiony = sen;
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        // 0 = najniższe podświetlenie (na części telefonów całkiem wyłączone); dotyk dalej działa
        lp.screenBrightness = sen ? 0f : prefs.getFloat("jasnosc", WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE);
        getWindow().setAttributes(lp);
        if (!sen) wybudzEkran();
        if (gesty != null) gesty.ustawSen(sen);
    }

    /** Gdy ekran wyłączono przyciskiem zasilania, a JARVIS każe świecić — włącz go. */
    @SuppressWarnings("deprecation")
    private void wybudzEkran() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null && !pm.isInteractive()) {
            PowerManager.WakeLock wl = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "jarvispanel:wake");
            wl.acquire(3000);
        }
    }

    @SuppressWarnings("deprecation")
    private void pelnyEkran() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    /** W trybie pełnoekranowym adjustResize nie działa — klawiatura zasłoniłaby pole "Nowe zadanie".
     *  Podnosimy zawartość o wysokość klawiatury ręcznie. */
    private void obejscieKlawiatury() {
        final int prog = (int) (100 * getResources().getDisplayMetrics().density);
        root.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            Rect r = new Rect();
            root.getWindowVisibleDisplayFrame(r);
            int zakryte = root.getRootView().getHeight() - r.bottom;
            int pad = zakryte > prog ? zakryte : 0;
            if (root.getPaddingBottom() != pad) root.setPadding(0, 0, 0, pad);
        });
    }

    // ------------------------------------------------------------------ ustawienia (3 s w lewym górnym rogu)
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        float rog = 72 * getResources().getDisplayMetrics().density;
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (gesty != null) gesty.dotyk();
                if (ev.getX() < rog && ev.getY() < rog) h.postDelayed(pokazUstawienia, PRZYTRZYMAJ_MS);
                break;
            case MotionEvent.ACTION_MOVE:
                if (ev.getX() > rog * 1.5f || ev.getY() > rog * 1.5f) h.removeCallbacks(pokazUstawienia);
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
            case MotionEvent.ACTION_POINTER_DOWN:
                h.removeCallbacks(pokazUstawienia);
                break;
            default:
                break;
        }
        return super.dispatchTouchEvent(ev);
    }

    private void ustawienia() {
        ustawSen(false);
        int p = (int) (16 * getResources().getDisplayMetrics().density);
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(p, p, p, 0);

        TextView t1 = new TextView(this);
        t1.setText("Adres panelu");
        EditText poleUrl = new EditText(this);
        poleUrl.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        poleUrl.setText(url());

        TextView t2 = new TextView(this);
        t2.setText("Token (PANEL_TOKEN z .env, puste = brak)");
        EditText token = new EditText(this);
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setText(prefs.getString("token", ""));

        TextView t3 = new TextView(this);
        t3.setText("Jasność po wybudzeniu: 1–100 (puste = systemowa)");
        EditText jasnosc = new EditText(this);
        jasnosc.setInputType(InputType.TYPE_CLASS_NUMBER);
        float j = prefs.getFloat("jasnosc", -1f);
        jasnosc.setText(j < 0 ? "" : String.valueOf(Math.round(j * 100)));

        CheckBox gestyPole = new CheckBox(this);
        gestyPole.setText("Gesty dłoni (przednia kamera) — teraz: " + (gesty != null ? gesty.stan() : "?"));
        gestyPole.setChecked(prefs.getBoolean("gesty", true));

        CheckBox glosPole = new CheckBox(this);
        glosPole.setText("Hey Jarvis (mikrofon) — teraz: " + (glos != null ? glos.stan() : "?"));
        glosPole.setChecked(prefs.getBoolean("glos", true));

        TextView info = new TextView(this);
        info.setText("\nWersja " + BuildInfo.WERSJA + ". Żeby wyjść z kiosku: Ustawienia Androida → Aplikacje → "
                + "Aplikacje domyślne → Ekran główny.");

        l.addView(t1);
        l.addView(poleUrl);
        l.addView(t2);
        l.addView(token);
        l.addView(t3);
        l.addView(jasnosc);
        l.addView(gestyPole);
        l.addView(glosPole);

        // głos JARVIS-a: lista polskich głosów (wybór od razu odtwarza próbkę) + tempo mowy
        final String glosZapisany = prefs.getString("glos_tts", "");
        final float tempoZapisane = prefs.getFloat("glos_tempo", 1.0f);
        java.util.List<android.speech.tts.Voice> glosy = glos != null ? glos.glosyPl() : new java.util.ArrayList<>();
        java.util.List<String> nazwy = new java.util.ArrayList<>();
        java.util.List<String> etykiety = new java.util.ArrayList<>();
        nazwy.add("");
        etykiety.add("Domyślny polski");
        for (android.speech.tts.Voice v : glosy) {
            nazwy.add(v.getName());
            etykiety.add(v.getName().replace("pl-pl-x-", "").replace("-local", " (w telefonie)")
                    .replace("-network", " (online, naturalniejszy)"));
        }
        TextView t4 = new TextView(this);
        t4.setText("\nGłos JARVIS-a (wybierz, żeby odsłuchać)");
        android.widget.Spinner glosLista = new android.widget.Spinner(this);
        glosLista.setAdapter(new android.widget.ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, etykiety));
        glosLista.setSelection(Math.max(0, nazwy.indexOf(glosZapisany)));
        final boolean[] pierwszyWybor = {true};
        glosLista.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> p, View v, int poz, long id) {
                if (pierwszyWybor[0]) { pierwszyWybor[0] = false; return; }   // ustawienie startowe, nie wybór
                if (glos != null) { glos.ustawGlos(nazwy.get(poz)); glos.probka(); }
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> p) { }
        });
        TextView t5 = new TextView(this);
        t5.setText("Tempo mowy: " + Math.round(tempoZapisane * 100) + "%");
        android.widget.SeekBar tempo = new android.widget.SeekBar(this);
        tempo.setMax(150);                                   // 50–200 %
        tempo.setProgress(Math.round(tempoZapisane * 100) - 50);
        tempo.setOnSeekBarChangeListener(new android.widget.SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(android.widget.SeekBar s, int p, boolean odUzytkownika) {
                t5.setText("Tempo mowy: " + (p + 50) + "%");
            }
            @Override public void onStartTrackingTouch(android.widget.SeekBar s) { }
            @Override public void onStopTrackingTouch(android.widget.SeekBar s) {
                if (glos != null) { glos.ustawTempo((s.getProgress() + 50) / 100f); glos.probka(); }
            }
        });
        l.addView(t4);
        l.addView(glosLista);
        l.addView(t5);
        l.addView(tempo);
        l.addView(info);

        android.widget.ScrollView przewijanie = new android.widget.ScrollView(this);   // w poziomie nie mieści się bez przewijania
        przewijanie.addView(l);

        new AlertDialog.Builder(this)
                .setTitle("JARVIS Panel — ustawienia")
                .setView(przewijanie)
                .setPositiveButton("Zapisz", (d, w) -> {
                    String u = poleUrl.getText().toString().trim();
                    if (!u.isEmpty() && !u.matches("^https?://.*")) u = "http://" + u;
                    SharedPreferences.Editor e = prefs.edit()
                            .putString("url", u.isEmpty() ? DOMYSLNY_URL : u)
                            .putString("token", token.getText().toString().trim());
                    String js = jasnosc.getText().toString().trim();
                    float val = -1f;
                    if (!js.isEmpty()) {
                        try {
                            val = Math.max(1, Math.min(100, Integer.parseInt(js))) / 100f;
                        } catch (NumberFormatException ignored) {
                            val = -1f;
                        }
                    }
                    boolean g = gestyPole.isChecked();
                    boolean gl = glosPole.isChecked();
                    e.putFloat("jasnosc", val).putBoolean("gesty", g).putBoolean("glos", gl)
                            .putString("glos_tts", nazwy.get(Math.max(0, glosLista.getSelectedItemPosition())))
                            .putFloat("glos_tempo", (tempo.getProgress() + 50) / 100f).apply();
                    poprosOUprawnienia();
                    if (gesty != null) gesty.ustawWlaczone(g);
                    if (glos != null) glos.ustawWlaczone(gl);
                    ustawSen(false);
                    zaladuj();
                })
                .setNeutralButton("Ustawienia Androida", (d, w) ->
                        startActivity(new Intent(Settings.ACTION_SETTINGS)))
                .setNegativeButton("Anuluj", null)
                .setOnDismissListener(d -> {
                    pelnyEkran();
                    // po „Zapisz” to już nowe wartości; po „Anuluj” wraca głos i tempo sprzed odsłuchiwania
                    if (glos != null) {
                        glos.ustawGlos(prefs.getString("glos_tts", ""));
                        glos.ustawTempo(prefs.getFloat("glos_tempo", 1.0f));
                    }
                })
                .show();
    }

    // ------------------------------------------------------------------ mostek JS: window.JarvisPanel
    public class Most {
        @JavascriptInterface
        public void setSleep(boolean sen) {
            h.post(() -> ustawSen(sen));
        }

        /** Strona: przeczytaj odpowiedź JARVIS-a na głos. */
        @JavascriptInterface
        public void mow(String tekst) {
            h.post(() -> { if (glos != null) glos.mow(tekst); });
        }

        /** Strona: przycisk 🎙️ — słuchaj polecenia bez słowa-klucza. */
        @JavascriptInterface
        public void sluchaj() {
            h.post(() -> { if (glos != null) glos.sluchajTeraz(); });
        }

        @JavascriptInterface
        public String token() {
            return prefs.getString("token", "");
        }

        @JavascriptInterface
        public String version() {
            return BuildInfo.WERSJA;
        }

        @JavascriptInterface
        public String battery() {
            IntentFilter f = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
            // stan baterii to "sticky" broadcast systemowy — odbiornik null tylko go odczytuje
            Intent b = Build.VERSION.SDK_INT >= 33
                    ? registerReceiver(null, f, RECEIVER_NOT_EXPORTED)
                    : registerReceiver(null, f);
            if (b == null) return "null";
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            JSONObject o = new JSONObject();
            try {
                o.put("level", scale > 0 ? Math.round(level * 100f / scale) : level);
                o.put("temp", b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
                o.put("status", b.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN));
                o.put("plugged", b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0));
                o.put("voltage", b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0));
                o.put("health", b.getIntExtra(BatteryManager.EXTRA_HEALTH, BatteryManager.BATTERY_HEALTH_UNKNOWN));
                o.put("sleeping", uspiony);
                o.put("kamera", gesty != null ? gesty.stan() : "brak");
                o.put("mikrofon", glos != null ? glos.stan() : "brak");
            } catch (JSONException e) {
                return "null";
            }
            return o.toString();
        }
    }
}
