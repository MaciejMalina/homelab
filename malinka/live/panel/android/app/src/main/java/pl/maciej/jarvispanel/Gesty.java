package pl.maciej.jarvispanel;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.Context;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CaptureRequest;
import android.hardware.display.DisplayManager;
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
import com.google.mediapipe.tasks.components.containers.Detection;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.facedetector.FaceDetector;
import com.google.mediapipe.tasks.vision.facedetector.FaceDetectorResult;
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

    /** Obecność przy biurku: DUŻA twarz w 3 z 4 sprawdzeń włącza; potem twarz albo dłoń ją podtrzymuje
     *  (zmiana stanu -> strona -> malinka -> monitor). */
    interface Obecnosc {
        void zmiana(boolean jest);
    }

    private static final String TAG = "JarvisGesty";
    private static final String MODEL = "gesture_recognizer.task";
    private static final String MODEL_TWARZ = "blaze_face_short_range.tflite";
    private static final long TWARZ_CO_MS = 1000;           // wykrywanie twarzy raz na sekundę (oszczędnie)
    private static final long OBECNOSC_PAMIEC_MS = 5000;    // gdy już jest: twarz/dłoń w ostatnich 5 s podtrzymuje obecność
    static final float TWARZ_MIN = 0.13f;                    // szerokość twarzy / szerokość kadru, od której „siedzisz” (prefs twarz_min)
    private static final int TRAFIEN_WLACZ = 3;             // tyle z ostatnich 4 sprawdzeń (co 1 s) musi mieć dużą twarz
    private static final float PODTRZYMANIE = 0.7f;         // gdy już jest: wystarczy twarz >= 70% progu (odchylenie się)

    private static final long STABILNY_MS = 600;          // tyle trzeba trzymać gest
    private static final long PRZERWA_MS = 1000;          // po rozpoznaniu: przerwa na kolejny
    private static final long PO_DOTYKU_MS = 1500;        // ręka sięgająca do ekranu to nie machnięcie
    private static final long OKNO_MACHNIECIA_MS = 800;
    private static final long LUKA_MS = 350;              // tyle moze brakowac gestu w srodku przytrzymania
    private static final long PRZERWA_TORU_MS = 500;
    private static final long POWROT_MS = 1800;
    private static final boolean MACHNIECIA = false;      // machniecia w powietrzu zawodne (powrot reki) - zakladki zmienia wskazanie palcem w bok           // po machnieciu ruch w przeciwna strone = powrot reki, nie gest      // dluzszy brak dloni = koniec ruchu
    private static final float KIERUNEK_X = 1f;           // sprawdzone na telefonie: wskazanie w prawo uzytkownika = x rosnie
    private static final float PROG_WYNIKU = 0.6f;
    private static final float PROG_MACHNIECIA = 0.22f;   // czesc szerokosci kadru
    private static final float MAX_RUCH_STATYCZNY = 0.10f;
    private static final long CO_MS_AKTYWNY = 60;         // kazda klatka (15/s) - wiecej probek w szybkim ruchu
    private static final long CO_MS_USPIONY = 333;        // ~3 analizy/s
    private static final float EV_PLUS = 1.0f;            // rozjasnienie pod swiatlo; wiecej = dluzsza ekspozycja = rozmazana dlon w ruchu
    private static final long TEMP_CO_MS = 30_000;
    private static final double TEMP_STOP_USPIONY = 38.0;
    private static final double TEMP_STOP_ZAWSZE = 43.0;
    private static final double TEMP_WZNOW = 36.0;
    private static final long BRAK_KLATEK_MS = 15_000;   // kamera "podpieta", a klatek brak = system ja odebral
    private static final int PROB_DO_RESTARTU = 3;         // tyle nieudanych podpiec przy appce na wierzchu -> restart procesu
    private static final long RESTART_NIE_CZESCIEJ_MS = 30 * 60_000L;

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
    private final Obecnosc obecnoscCb;
    private FaceDetector twarze;
    private boolean twarzeBlad = false;
    private long ostatniaAnalizaTwarzy = 0;
    private volatile long ostatniaTwarz = 0;
    private volatile long ostatniaDlonObecnosc = 0;
    private volatile boolean obecny = false;
    private final boolean[] trafienia = new boolean[4];
    private int trafIdx = 0;
    private volatile float twarzMin = TWARZ_MIN;
    private volatile boolean podglad = false;
    // podgląd diagnostyczny (Podglad.java)
    volatile Bitmap diagObraz = null;        // kadr w pionie, tylko gdy podgląd włączony
    volatile RectF diagRamka = null;         // największa twarz, 0..1 względem diagObraz
    volatile float diagSzer = 0f;
    volatile float diagPewnosc = 0f;
    volatile int diagTrafien = 0;
    volatile long diagDlon = 0;              // czas ostatniej dłoni w kadrze (uptime)
    private final LifecycleRegistry cykl = new LifecycleRegistry(this);
    private final ExecutorService analiza = Executors.newSingleThreadExecutor();

    private ProcessCameraProvider dostawca;
    private ImageAnalysis analizaKamery;
    // telefon moze sie obrocic miedzy dwoma poziomami (90/270) - obraz do modelu musi isc zawsze w pionie
    private final DisplayManager.DisplayListener obrot = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) { }
        @Override public void onDisplayRemoved(int id) { }
        @Override public void onDisplayChanged(int id) { ustawObrot(); }
    };
    private GestureRecognizer rozpoznawanie;
    private boolean wlaczone = false;
    private boolean widoczna = true;   // appka na wierzchu (onStart..onStop); w tle Android i tak odbiera kamere
    private int nieudanePodpiecia = 0;
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
    private long kandydatOstatnio = 0;
    private String ostatniKierunek = null;
    private long ostatnieMachniecie = 0;
    private boolean wyslany = false;
    private final ArrayDeque<float[]> tor = new ArrayDeque<>();   // {czas ms, x, y}

    private final Runnable kontrolaTemp = new Runnable() {
        @Override public void run() {
            sprawdzTemperature();
            sprawdzKamere();
            h.postDelayed(this, TEMP_CO_MS);
        }
    };

    Gesty(Activity act, Handler h, Odbiorca odbiorca, Obecnosc obecnoscCb) {
        this.act = act;
        this.h = h;
        this.odbiorca = odbiorca;
        this.obecnoscCb = obecnoscCb;
        cykl.handleLifecycleEvent(Lifecycle.Event.ON_CREATE);
        h.postDelayed(kontrolaTemp, TEMP_CO_MS);
        DisplayManager dm = (DisplayManager) act.getSystemService(Context.DISPLAY_SERVICE);
        if (dm != null) dm.registerDisplayListener(obrot, h);
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

    /** onStart/onStop aktywnosci: w tle sami zamykamy kamere, zanim system ja zablokuje (po blokadzie CameraX nie wraca). */
    void ustawWidoczna(boolean w) {
        widoczna = w;
        nieudanePodpiecia = 0;
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

    void ustawTwarzMin(float f) {
        twarzMin = f;
    }

    float twarzMin() {
        return twarzMin;
    }

    void ustawPodglad(boolean p) {
        podglad = p;
        if (!p) diagObraz = null;
    }

    boolean obecnyTeraz() {
        return obecny;
    }

    /** Dla sygnału „żyję” do malinki: true/false, a null gdy kamera nie działa (wtedy nic nie wiemy). */
    Boolean obecnosc() {
        return dziala ? obecny : null;
    }

    void aktualizuj() {
        boolean uprawnienie = act.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean powinno = wlaczone && uprawnienie && !pauzaTermiczna && widoczna;
        if (powinno && !dziala) start();
        else if (!powinno && dziala) stop();
        if (!wlaczone) stan = "wyłączone";
        else if (!widoczna) stan = "pauza: appka w tle";
        else if (!uprawnienie) stan = "brak uprawnienia do kamery";
        else if (pauzaTermiczna) stan = String.format(java.util.Locale.ROOT, "pauza: bateria %.1f°C", ostatniaTemp);
    }

    /** Straznik: Android zabiera kamere appce w tle i CameraX jej sam nie odzyskuje - brak klatek = podpinamy od nowa. */
    private void sprawdzKamere() {
        if (!dziala || dostawca == null) return;
        long teraz = SystemClock.uptimeMillis();
        if (teraz - ostatniaKlatka < BRAK_KLATEK_MS) {
            nieudanePodpiecia = 0;
            return;
        }
        if (++nieudanePodpiecia > PROB_DO_RESTARTU) {
            restartProcesu();
            return;
        }
        Log.w(TAG, "brak klatek od " + (teraz - ostatniaKlatka) + " ms - podpinam kamere od nowa (proba " + nieudanePodpiecia + ")");
        try {
            podepnijKamere();
        } catch (Exception e) {
            stan = "błąd kamery: " + e.getMessage();
            Log.e(TAG, "ponowne podpiecie", e);
        }
    }

    /** CameraX potrafi utknac po ERROR_CAMERA_DISABLED (stan REOPENING) - pomaga tylko nowy proces. Appka jest ekranem
     *  glownym, wiec system sam ja uruchomi od nowa. Najwyzej raz na RESTART_NIE_CZESCIEJ_MS, zeby nie krecic petli. */
    private void restartProcesu() {
        android.content.SharedPreferences p = act.getSharedPreferences("jarvis_gesty", Context.MODE_PRIVATE);
        long teraz = System.currentTimeMillis();
        if (teraz - p.getLong("restart", 0) < RESTART_NIE_CZESCIEJ_MS) {
            stan = "kamera nie wraca - uruchom appkę ponownie";
            return;
        }
        p.edit().putLong("restart", teraz).commit();
        Log.e(TAG, "kamera nie wraca po " + PROB_DO_RESTARTU + " probach - restart procesu");
        android.os.Process.killProcess(android.os.Process.myPid());
    }

    void zamknij() {
        h.removeCallbacks(kontrolaTemp);
        DisplayManager dm = (DisplayManager) act.getSystemService(Context.DISPLAY_SERVICE);
        if (dm != null) dm.unregisterDisplayListener(obrot);
        stop();
        analiza.shutdown();
        if (rozpoznawanie != null) {
            rozpoznawanie.close();
            rozpoznawanie = null;
        }
        if (twarze != null) {
            twarze.close();
            twarze = null;
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
        if (twarze == null && !twarzeBlad) {
            try {
                twarze = FaceDetector.createFromOptions(act, FaceDetector.FaceDetectorOptions.builder()
                        .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL_TWARZ).build())
                        .setRunningMode(RunningMode.IMAGE)
                        .setMinDetectionConfidence(0.6f)
                        .build());
            } catch (Exception e) {
                twarzeBlad = true;   // bez modelu twarzy gesty działają dalej, tylko bez obecności
                Log.e(TAG, "model twarzy", e);
            }
        }
        java.util.Arrays.fill(trafienia, false);
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
        ostatniaKlatka = SystemClock.uptimeMillis();   // start odliczania dla straznika (sprawdzKamere)
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
        b.setTargetRotation(obrotEkranu());
        ImageAnalysis ia = b.build();
        ia.setAnalyzer(analiza, this::klatka);
        analizaKamery = ia;
        dostawca.unbindAll();
        Camera kam = dostawca.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, ia);
        cykl.handleLifecycleEvent(Lifecycle.Event.ON_RESUME);
        String ev = ustawEkspozycje(kam);
        stan = "aktywne" + (fps != null ? " (" + fps.getUpper() + " kl/s" + ev + ")" : "");
    }

    @SuppressWarnings("deprecation")
    private int obrotEkranu() {
        return act.getWindowManager().getDefaultDisplay().getRotation();
    }

    private void ustawObrot() {
        ImageAnalysis ia = analizaKamery;
        if (ia != null) ia.setTargetRotation(obrotEkranu());
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
                        + " jasnosc=" + jasnosc + " obecnosc=" + obecny + " twarz=" + fmt(diagSzer) + " trafien=" + diagTrafien
                        + (twarze == null ? " (bez modelu twarzy)" : "")
                        + (uspiony ? " (uspiony)" : ""));
            }
            MPImage mp = new BitmapImageBuilder(bm).build();
            ImageProcessingOptions opcje = ImageProcessingOptions.builder()
                    .setRotationDegrees(img.getImageInfo().getRotationDegrees())
                    .build();
            r.recognizeAsync(mp, opcje, teraz);
            FaceDetector fd = twarze;
            if (fd != null && teraz - ostatniaAnalizaTwarzy >= TWARZ_CO_MS) {
                ostatniaAnalizaTwarzy = teraz;
                analizaTwarzy(fd, bm, img.getImageInfo().getRotationDegrees(), teraz);
            }
        } catch (Exception e) {
            Log.w(TAG, "klatka", e);
        } finally {
            img.close();
        }
    }

    /** Twarz raz na sekundę. Kadr obracamy sami do pionu (jak w przykładach MediaPipe), żeby ramka była w tych samych
     *  współrzędnych co podgląd. Włącza tylko twarz dość duża (= siedzisz przy biurku, a nie stoisz obok). */
    private void analizaTwarzy(FaceDetector fd, Bitmap bm, int rot, long teraz) {
        Bitmap pion = bm;
        if (rot != 0) {
            Matrix m = new Matrix();
            m.postRotate(rot);
            pion = Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), m, true);
        }
        FaceDetectorResult fr = fd.detect(new BitmapImageBuilder(pion).build());
        float szer = 0f;
        float pewnosc = 0f;
        RectF ramka = null;
        float w = pion.getWidth();
        float hh = pion.getHeight();
        for (Detection d : fr.detections()) {
            RectF b = d.boundingBox();
            float sz = b.width() / w;
            if (sz > szer) {
                szer = sz;
                pewnosc = d.categories().isEmpty() ? 0f : d.categories().get(0).score();
                ramka = new RectF(b.left / w, b.top / hh, b.right / w, b.bottom / hh);
            }
        }
        float min = twarzMin;
        trafienia[trafIdx] = szer >= min;
        trafIdx = (trafIdx + 1) % trafienia.length;
        int n = 0;
        for (boolean t : trafienia) if (t) n++;
        if (n >= TRAFIEN_WLACZ || (obecny && szer >= min * PODTRZYMANIE)) ostatniaTwarz = teraz;
        diagSzer = szer;
        diagPewnosc = pewnosc;
        diagRamka = ramka;
        diagTrafien = n;
        if (podglad) diagObraz = pion;
        aktualizujObecnosc(teraz, n);
    }

    /** Wejście: duża twarz w TRAFIEN_WLACZ z 4 sprawdzeń. Potem twarz (>= 70% progu) albo dłoń w ostatnich
     *  OBECNOSC_PAMIEC_MS podtrzymuje. Sama dłoń NIE włącza. Zmiana stanu idzie od razu do strony. */
    private void aktualizujObecnosc(long teraz, int trafien) {
        boolean jest = obecny
                ? teraz - ostatniaTwarz < OBECNOSC_PAMIEC_MS || teraz - ostatniaDlonObecnosc < OBECNOSC_PAMIEC_MS
                : trafien >= TRAFIEN_WLACZ;
        if (jest == obecny) return;
        obecny = jest;
        Log.i(TAG, "OBECNOSC " + (jest ? "jest" : "brak"));
        if (obecnoscCb != null) h.post(() -> obecnoscCb.zmiana(jest));
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
            ostatniaDlonObecnosc = t;
            diagDlon = t;
            List<NormalizedLandmark> lm = r.landmarks().get(0);
            if (lm.size() > 9) {
                x = (lm.get(0).x() + lm.get(9).x()) / 2f;   // nadgarstek + srodek dloni
                y = (lm.get(0).y() + lm.get(9).y()) / 2f;
            }
            if (!r.gestures().isEmpty() && !r.gestures().get(0).isEmpty()) {
                Category c = r.gestures().get(0).get(0);
                if (c.score() >= PROG_WYNIKU) nazwa = NAZWY.get(c.categoryName());
            }
            String wsk = wskazanieWBok(lm);
            if (wsk != null) nazwa = wsk;
            // model slabo lapie kciuk w dol - gdy sie waha albo widzi piesc, sprawdzamy sami po punktach dloni
            if ((nazwa == null || "piesc".equals(nazwa)) && kciukWDol(lm)) nazwa = "kciuk_dol";
        }
        if (y >= 0 && t - ostatniLog >= 500) {
            ostatniLog = t;
            String surowy = r.gestures().isEmpty() || r.gestures().get(0).isEmpty() ? "-"
                    : r.gestures().get(0).get(0).categoryName() + " " + fmt(r.gestures().get(0).get(0).score());
            Log.d(TAG, "dlon x=" + fmt(x) + " y=" + fmt(y) + " gest=" + surowy + (uspiony ? " (uspiony)" : ""));
        }
        analizuj(t, nazwa, x, y);
    }

    /** Palec wskazujacy wyprostowany poziomo, srodkowy/serdeczny/maly zgiete -> "prawo" / "lewo" (z punktu widzenia uzytkownika). */
    private static String wskazanieWBok(List<NormalizedLandmark> lm) {
        if (lm.size() < 21) return null;
        NormalizedLandmark nadgarstek = lm.get(0);
        NormalizedLandmark mcp = lm.get(5);
        NormalizedLandmark tip = lm.get(8);
        if (odl(tip, nadgarstek) < odl(lm.get(6), nadgarstek) * 1.2f) return null;   // wskazujacy wyprostowany
        float dx = tip.x() - mcp.x();
        float dy = tip.y() - mcp.y();
        if (Math.abs(dx) < 0.08f || Math.abs(dx) < 1.5f * Math.abs(dy)) return null;   // wyraznie w bok
        int[][] palce = {{12, 10}, {16, 14}, {20, 18}};
        for (int[] p : palce) {
            if (odl(lm.get(p[0]), nadgarstek) > odl(lm.get(p[1]), nadgarstek) * 1.05f) return null;   // reszta zgieta
        }
        return dx * KIERUNEK_X > 0 ? "prawo" : "lewo";
    }

    /** Kciuk wyraznie w dol (czubek ponizej nasady i ponizej knykcia palca wskazujacego), pozostale palce zgiete. */
    private static boolean kciukWDol(List<NormalizedLandmark> lm) {
        if (lm.size() < 21) return false;
        NormalizedLandmark nadgarstek = lm.get(0);
        NormalizedLandmark kMcp = lm.get(2);
        NormalizedLandmark kTip = lm.get(4);
        float dy = kTip.y() - kMcp.y();
        if (dy < 0.06f || Math.abs(kTip.x() - kMcp.x()) > dy) return false;
        // kciuk WYPROSTOWANY (w piesci jest zawiniety i krotki) ...
        if (odl(kTip, kMcp) < 0.8f * odl(nadgarstek, lm.get(5))) return false;
        // ... i wyraznie ponizej WSZYSTKICH knykci (w piesci lezy na wysokosci palcow)
        float najnizszyKnykiec = Math.max(Math.max(lm.get(5).y(), lm.get(9).y()), Math.max(lm.get(13).y(), lm.get(17).y()));
        if (kTip.y() < najnizszyKnykiec + 0.03f) return false;
        int[][] palce = {{8, 6}, {12, 10}, {16, 14}, {20, 18}};   // {czubek, staw PIP}
        for (int[] p : palce) {
            if (odl(lm.get(p[0]), nadgarstek) > odl(lm.get(p[1]), nadgarstek) * 1.05f) return false;
        }
        return true;
    }

    private static float odl(NormalizedLandmark a, NormalizedLandmark b) {
        float dx = a.x() - b.x();
        float dy = a.y() - b.y();
        return (float) Math.sqrt(dx * dx + dy * dy);
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
        if (MACHNIECIA && !uspiony) {
            if (jest) {
                ostatniaDlon = t;
                tor.addLast(new float[]{t, x, y});
                while (!tor.isEmpty() && t - tor.peekFirst()[0] > OKNO_MACHNIECIA_MS) tor.removeFirst();
                float[] p = tor.peekFirst();
                float dx = x - p[1];
                float dy = y - p[2];
                if (tor.size() >= 2 && Math.abs(dx) >= PROG_MACHNIECIA && Math.abs(dx) > 1.5f * Math.abs(dy)) {
                    String kier = dx * KIERUNEK_X > 0 ? "prawo" : "lewo";
                    if (ostatniKierunek != null && !kier.equals(ostatniKierunek) && t - ostatnieMachniecie < POWROT_MS) {
                        Log.d(TAG, "ruch powrotny po " + ostatniKierunek + " - pomijam");
                        tor.clear();
                        return;
                    }
                    ostatniKierunek = kier;
                    ostatnieMachniecie = t;
                    Log.d(TAG, "machniecie dx=" + fmt(dx) + " dy=" + fmt(dy) + " probek=" + tor.size());
                    kandydat = null;
                    wyslij(kier, t);
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
            // krotka luka (model na chwile zgubil dlon albo dal None) nie przerywa liczenia czasu gestu
            if (kandydat != null && t - kandydatOstatnio <= LUKA_MS) return;
            kandydat = null;
            wyslany = false;
            return;
        }
        if (!nazwa.equals(kandydat)) {
            kandydat = nazwa;
            kandydatOd = t;
            kandydatOstatnio = t;
            kandydatX = x;
            kandydatY = y;
            wyslany = false;
            return;
        }
        kandydatOstatnio = t;
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
