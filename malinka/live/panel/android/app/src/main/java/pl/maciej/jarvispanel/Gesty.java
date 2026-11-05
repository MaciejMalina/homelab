package pl.maciej.jarvispanel;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CaptureRequest;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.SystemClock;
import android.util.Log;
import android.util.Range;
import android.util.Size;

import androidx.annotation.NonNull;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExposureState;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.SurfaceOrientedMeteringPointFactory;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LifecycleRegistry;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.tasks.components.containers.Category;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer;
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizerResult;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Gesty dłoni przednią kamerą — CameraX + MediaPipe Gesture Recognizer, wszystko liczone na telefonie
 * (obraz nigdzie nie wychodzi). Do strony trafia tylko nazwa gestu.
 *
 * Gesty statyczne (dłoń, pięść, palec, kciuki, V) trzeba przytrzymać STABILNY_MS w miejscu.
 * Machnięcie w górę/dół = szybki pionowy ruch dłoni (tylko gdy ekran świeci).
 * Przy wygaszonym ekranie: tryb oszczędny (3 analizy/s) i tylko ✋ (budzi ekran).
 * Temperatura baterii >= 38 °C przy wygaszonym ekranie (albo >= 43 °C zawsze) wyłącza kamerę, < 36 °C włącza z powrotem.
 */
final class Gesty implements LifecycleOwner {

    interface Odbiorca {
        void gest(String nazwa);
    }

    private static final String TAG = "JarvisGesty";
    private static final String MODEL = "gesture_recognizer.task";

    private static final long STABILNY_MS = 400;          // tyle trzeba trzymać gest
    private static final long PRZERWA_MS = 1000;          // po rozpoznaniu: przerwa na kolejny
    private static final long PO_DOTYKU_MS = 1500;        // ręka sięgająca do ekranu to nie machnięcie
    private static final long OKNO_MACHNIECIA_MS = 800;
    private static final long PRZERWA_TORU_MS = 500;      // dluzszy brak dloni = koniec ruchu
    private static final float KIERUNEK_X = -1f;          // przednia kamera: ruch w prawo uzytkownika = x maleje
    private static final float PROG_WYNIKU = 0.5f;
    private static final float PROG_MACHNIECIA = 0.22f;   // czesc szerokosci kadru
    private static final float MAX_RUCH_STATYCZNY = 0.10f;
    private static final long CO_MS_AKTYWNY = 60;         // kazda klatka (15/s) - wiecej probek w szybkim ruchu
    private static final long CO_MS_USPIONY = 333;        // ~3 analizy/s
    private static final float EV_PLUS = 1.0f;            // rozjasnienie pod swiatlo; wiecej = dluzsza ekspozycja = rozmazana dlon w ruchu
    private static final long TEMP_CO_MS = 30_000;
    private static final double TEMP_STOP_USPIONY = 38.0;
    private static final double TEMP_STOP_ZAWSZE = 43.0;
    private static final double TEMP_WZNOW = 36.0;

    private static final Map<String, String> NAZWY = new HashMap<>();

    static {
        NAZWY.put("Open_Palm", "dlon");
        NAZWY.put("Closed_Fist", "piesc");
        NAZWY.put("Pointing_Up", "palec");
        NAZWY.put("Thumb_Up", "kciuk_gora");
        NAZWY.put("Thumb_Down", "kciuk_dol");
        NAZWY.put("Victory", "v");
        NAZWY.put("ILoveYou", "rock");
    }

    private final Activity act;
    private final Handler h;
    private final Odbiorca odbiorca;
    private final LifecycleRegistry cykl = new LifecycleRegistry(this);
    private final ExecutorService analiza = Executors.newSingleThreadExecutor();

    private ProcessCameraProvider dostawca;
    private GestureRecognizer rozpoznawanie;
    private boolean wlaczone = false;
    private boolean dziala = false;
    private boolean pauzaTermiczna = false;
    private volatile boolean uspiony = false;
    private volatile String stan = "wyłączone";
    private volatile long ostatniaKlatka = 0;
    private volatile long przerwaDo = 0;
    private double ostatniaTemp = 0;
    private long ostatniLog = 0;
    // diagnostyka: liczniki z ostatnich 10 s (log co 10 s)
    private final java.util.concurrent.atomic.AtomicInteger nKlatek = new java.util.concurrent.atomic.AtomicInteger();
    private final java.util.concurrent.atomic.AtomicInteger nWynikow = new java.util.concurrent.atomic.AtomicInteger();
    private final java.util.concurrent.atomic.AtomicInteger nDloni = new java.util.concurrent.atomic.AtomicInteger();
    private volatile long ostatniLicznik = 0;
    private volatile String jasnosc = "?";

    // stabilizacja — wywoływane tylko z wątku wyników MediaPipe
    private String kandydat = null;
    private long kandydatOd = 0;
    private float kandydatX = 0;
    private float kandydatY = 0;
    private long ostatniaDlon = 0;
    private boolean wyslany = false;
    private final ArrayDeque<float[]> tor = new ArrayDeque<>();   // {czas ms, x, y}

    private final Runnable kontrolaTemp = new Runnable() {
        @Override public void run() {
            sprawdzTemperature();
            h.postDelayed(this, TEMP_CO_MS);
        }
    };

    Gesty(Activity act, Handler h, Odbiorca odbiorca) {
        this.act = act;
        this.h = h;
        this.odbiorca = odbiorca;
        cykl.handleLifecycleEvent(Lifecycle.Event.ON_CREATE);
        h.postDelayed(kontrolaTemp, TEMP_CO_MS);
    }

    @NonNull
    @Override
    public Lifecycle getLifecycle() {
        return cykl;
    }

    // ------------------------------------------------------------------ sterowanie (wątek główny)
    void ustawWlaczone(boolean w) {
        wlaczone = w;
        aktualizuj();
    }

    void ustawSen(boolean sen) {
        uspiony = sen;   // historia ruchu czyści się sama w wątku wyników (przy uśpieniu nie liczymy machnięć)
        sprawdzTemperature();
    }

    /** Dotyk ekranu: ręka sięgająca do telefonu nie może zostać wzięta za machnięcie. */
    void dotyk() {
        przerwaDo = Math.max(przerwaDo, SystemClock.uptimeMillis() + PO_DOTYKU_MS);
    }

    String stan() {
        return stan;
    }

    double temperatura() {
        return ostatniaTemp;
    }

    void aktualizuj() {
        boolean uprawnienie = act.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean powinno = wlaczone && uprawnienie && !pauzaTermiczna;
        if (powinno && !dziala) start();
        else if (!powinno && dziala) stop();
        if (!wlaczone) stan = "wyłączone";
        else if (!uprawnienie) stan = "brak uprawnienia do kamery";
        else if (pauzaTermiczna) stan = String.format(java.util.Locale.ROOT, "pauza: bateria %.1f°C", ostatniaTemp);
    }

    void zamknij() {
        h.removeCallbacks(kontrolaTemp);
        stop();
        analiza.shutdown();
        if (rozpoznawanie != null) {
            rozpoznawanie.close();
            rozpoznawanie = null;
        }
        cykl.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY);
    }

    private void start() {
        if (rozpoznawanie == null) {
            try {
                rozpoznawanie = utworzRozpoznawanie();
            } catch (Exception e) {
                stan = "błąd modelu: " + e.getMessage();
                Log.e(TAG, "model", e);
                return;
            }
        }
        dziala = true;
        ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(act);
        f.addListener(() -> {
            try {
                dostawca = f.get();
                if (dziala) podepnijKamere();
            } catch (Exception e) {
                stan = "błąd kamery: " + e.getMessage();
                dziala = false;
                Log.e(TAG, "kamera", e);
            }
        }, ContextCompat.getMainExecutor(act));
    }

    private void stop() {
        dziala = false;
        if (dostawca != null) dostawca.unbindAll();
        if (cykl.getCurrentState().isAtLeast(Lifecycle.State.STARTED)) cykl.handleLifecycleEvent(Lifecycle.Event.ON_STOP);
    }

    private void podepnijKamere() {
        ImageAnalysis.Builder b = new ImageAnalysis.Builder()
                .setResolutionSelector(new ResolutionSelector.Builder()
                        .setResolutionStrategy(new ResolutionStrategy(new Size(320, 240),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                        .build())
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888);
        Range<Integer> fps = najnizszeFps();
        if (fps != null) {
            new Camera2Interop.Extender<>(b).setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fps);
        }
        ImageAnalysis ia = b.build();
        ia.setAnalyzer(analiza, this::klatka);
        dostawca.unbindAll();
        Camera kam = dostawca.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, ia);
        cykl.handleLifecycleEvent(Lifecycle.Event.ON_RESUME);
        String ev = ustawEkspozycje(kam);
        stan = "aktywne" + (fps != null ? " (" + fps.getUpper() + " kl/s" + ev + ")" : "");
    }

    /** Pod światło (jasne tło za plecami) automatyka ciemni dłoń do konturu: rozjaśniamy o EV_PLUS i mierzymy na środku kadru. */
    private String ustawEkspozycje(Camera kam) {
        String opis = "";
        try {
            ExposureState es = kam.getCameraInfo().getExposureState();
            if (es.isExposureCompensationSupported()) {
                float krok = es.getExposureCompensationStep().floatValue();
                int idx = Math.min(es.getExposureCompensationRange().getUpper(), Math.round(EV_PLUS / krok));
                kam.getCameraControl().setExposureCompensationIndex(idx);
                opis = String.format(java.util.Locale.ROOT, ", %+.1f EV", idx * krok);
            }
            MeteringPoint p = new SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f, 0.5f);
            kam.getCameraControl().startFocusAndMetering(
                    new FocusMeteringAction.Builder(p, FocusMeteringAction.FLAG_AE).disableAutoCancel().build());
        } catch (Exception e) {
            Log.w(TAG, "ekspozycja", e);
        }
        return opis;
    }

    /** Najniższy zakres klatek przedniej kamery z górną granicą >= 10 — mniej ciepła, dłuższa ekspozycja w półmroku. */
    private Range<Integer> najnizszeFps() {
        try {
            for (CameraInfo ci : dostawca.getAvailableCameraInfos()) {
                if (CameraSelector.DEFAULT_FRONT_CAMERA.filter(Collections.singletonList(ci)).isEmpty()) continue;
                Range<Integer>[] zakresy = Camera2CameraInfo.from(ci)
                        .getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
                if (zakresy == null) return null;
                Range<Integer> best = null;
                for (Range<Integer> r : zakresy) {
                    if (r.getUpper() < 10) continue;
                    if (best == null || r.getUpper() < best.getUpper()
                            || (r.getUpper().equals(best.getUpper()) && r.getLower() < best.getLower())) best = r;
                }
                return best;
            }
        } catch (Exception e) {
            Log.w(TAG, "fps", e);
        }
        return null;
    }

    private GestureRecognizer utworzRozpoznawanie() {
        BaseOptions base = BaseOptions.builder().setModelAssetPath(MODEL).build();
        GestureRecognizer.GestureRecognizerOptions o = GestureRecognizer.GestureRecognizerOptions.builder()
                .setBaseOptions(base)
                .setRunningMode(RunningMode.LIVE_STREAM)
                .setNumHands(1)
                .setMinHandDetectionConfidence(0.4f)
                .setMinHandPresenceConfidence(0.4f)
                .setMinTrackingConfidence(0.4f)
                .setResultListener((wynik, obraz) -> wynik(wynik))
                .setErrorListener(e -> Log.w(TAG, "mediapipe", e))
                .build();
        return GestureRecognizer.createFromOptions(act, o);
    }

    // ------------------------------------------------------------------ klatki (wątek analizy)
    private void klatka(ImageProxy img) {
        try {
            long teraz = SystemClock.uptimeMillis();
            long co = uspiony ? CO_MS_USPIONY : CO_MS_AKTYWNY;
            GestureRecognizer r = rozpoznawanie;
            if (r == null || teraz - ostatniaKlatka < co) return;
            ostatniaKlatka = teraz;
            Bitmap bm = img.toBitmap();
            nKlatek.incrementAndGet();
            if (teraz - ostatniLicznik >= 10_000) {
                ostatniLicznik = teraz;
                jasnosc = sredniaJasnosc(bm);
                Log.d(TAG, "10 s: klatki=" + nKlatek.getAndSet(0) + " wyniki=" + nWynikow.getAndSet(0) + " dlonie=" + nDloni.getAndSet(0)
                        + " obraz=" + bm.getWidth() + "x" + bm.getHeight() + " rot=" + img.getImageInfo().getRotationDegrees()
                        + " jasnosc=" + jasnosc + (uspiony ? " (uspiony)" : ""));
            }
            MPImage mp = new BitmapImageBuilder(bm).build();
            ImageProcessingOptions opcje = ImageProcessingOptions.builder()
                    .setRotationDegrees(img.getImageInfo().getRotationDegrees())
                    .build();
            r.recognizeAsync(mp, opcje, teraz);
        } catch (Exception e) {
            Log.w(TAG, "klatka", e);
        } finally {
            img.close();
        }
    }

    /** Średnia jasność kadru 0–255 (próbka co 16 px) — czy obraz nie jest za ciemny / prześwietlony. */
    private static String sredniaJasnosc(Bitmap bm) {
        long suma = 0;
        int n = 0;
        for (int y = 0; y < bm.getHeight(); y += 16) {
            for (int x = 0; x < bm.getWidth(); x += 16) {
                int c = bm.getPixel(x, y);
                suma += (((c >> 16) & 0xff) * 299 + ((c >> 8) & 0xff) * 587 + (c & 0xff) * 114) / 1000;
                n++;
            }
        }
        return n == 0 ? "?" : String.valueOf(suma / n);
    }

    // ------------------------------------------------------------------ wyniki (wątek MediaPipe)
    private void wynik(GestureRecognizerResult r) {
        long t = r.timestampMs();
        nWynikow.incrementAndGet();
        String nazwa = null;
        float x = -1f;
        float y = -1f;
        if (!r.landmarks().isEmpty()) {
            nDloni.incrementAndGet();
            List<NormalizedLandmark> lm = r.landmarks().get(0);
            if (lm.size() > 9) {
                x = (lm.get(0).x() + lm.get(9).x()) / 2f;   // nadgarstek + srodek dloni
                y = (lm.get(0).y() + lm.get(9).y()) / 2f;
            }
            if (!r.gestures().isEmpty() && !r.gestures().get(0).isEmpty()) {
                Category c = r.gestures().get(0).get(0);
                if (c.score() >= PROG_WYNIKU) nazwa = NAZWY.get(c.categoryName());
            }
        }
        if (y >= 0 && t - ostatniLog >= 500) {
            ostatniLog = t;
            String surowy = r.gestures().isEmpty() || r.gestures().get(0).isEmpty() ? "-"
                    : r.gestures().get(0).get(0).categoryName() + " " + fmt(r.gestures().get(0).get(0).score());
            Log.d(TAG, "dlon x=" + fmt(x) + " y=" + fmt(y) + " gest=" + surowy + (uspiony ? " (uspiony)" : ""));
        }
        analizuj(t, nazwa, x, y);
    }

    private static String fmt(float v) {
        return String.format(java.util.Locale.ROOT, "%.2f", v);
    }

    private void analizuj(long t, String nazwa, float x, float y) {
        if (t < przerwaDo) {
            tor.clear();
            return;
        }
        boolean jest = y >= 0;
        // machniecie w bok (tylko przy swiecacym ekranie). Pojedyncza zgubiona klatka (rozmazana dlon) NIE kasuje toru.
        if (!uspiony) {
            if (jest) {
                ostatniaDlon = t;
                tor.addLast(new float[]{t, x, y});
                while (!tor.isEmpty() && t - tor.peekFirst()[0] > OKNO_MACHNIECIA_MS) tor.removeFirst();
                float[] p = tor.peekFirst();
                float dx = x - p[1];
                float dy = y - p[2];
                if (tor.size() >= 2 && Math.abs(dx) >= PROG_MACHNIECIA && Math.abs(dx) > 1.5f * Math.abs(dy)) {
                    Log.d(TAG, "machniecie dx=" + fmt(dx) + " dy=" + fmt(dy) + " probek=" + tor.size());
                    kandydat = null;
                    wyslij(dx * KIERUNEK_X > 0 ? "prawo" : "lewo", t);
                    return;
                }
            } else if (t - ostatniaDlon > PRZERWA_TORU_MS) {
                tor.clear();
            }
        } else {
            tor.clear();
        }
        // gest statyczny: ten sam przez STABILNY_MS, dlon prawie w miejscu, raz na jedno pokazanie.
        // Otwarta dlon przy swiecacym ekranie nic nie robi - nie wysylamy jej (blokowalaby machniecie zaraz po niej).
        if (nazwa == null || (!uspiony && "dlon".equals(nazwa))) {
            kandydat = null;
            wyslany = false;
            return;
        }
        if (!nazwa.equals(kandydat)) {
            kandydat = nazwa;
            kandydatOd = t;
            kandydatX = x;
            kandydatY = y;
            wyslany = false;
            return;
        }
        if (wyslany) return;
        if (Math.abs(y - kandydatY) > MAX_RUCH_STATYCZNY || Math.abs(x - kandydatX) > MAX_RUCH_STATYCZNY) {
            kandydatOd = t;
            kandydatX = x;
            kandydatY = y;
            return;
        }
        if (t - kandydatOd >= STABILNY_MS) {
            if (uspiony && !"dlon".equals(nazwa)) return;
            wyslany = true;
            wyslij(nazwa, t);
        }
    }
    private void wyslij(String gest, long t) {
        Log.i(TAG, "GEST " + gest);
        przerwaDo = t + PRZERWA_MS;
        tor.clear();
        h.post(() -> odbiorca.gest(gest));
    }

    // ------------------------------------------------------------------ temperatura (wątek główny)
    private void sprawdzTemperature() {
        IntentFilter f = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent b = Build.VERSION.SDK_INT >= 33
                ? act.registerReceiver(null, f, Activity.RECEIVER_NOT_EXPORTED)
                : act.registerReceiver(null, f);
        if (b != null) ostatniaTemp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0;
        double tc = ostatniaTemp;
        if (!pauzaTermiczna && ((uspiony && tc >= TEMP_STOP_USPIONY) || tc >= TEMP_STOP_ZAWSZE)) {
            pauzaTermiczna = true;
            Log.i(TAG, "pauza termiczna " + tc);
        } else if (pauzaTermiczna && (tc <= TEMP_WZNOW || (!uspiony && tc < TEMP_STOP_ZAWSZE))) {
            pauzaTermiczna = false;
        }
        aktualizuj();
    }
}
