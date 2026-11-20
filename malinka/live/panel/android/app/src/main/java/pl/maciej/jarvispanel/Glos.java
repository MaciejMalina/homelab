package pl.maciej.jarvispanel;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.os.Handler;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import org.tensorflow.lite.Interpreter;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Locale;

/**
 * JARVIS głosem, w całości na telefonie aż do tekstu polecenia:
 *  1. słowo-klucz „Hey Jarvis” — openWakeWord (3 małe modele TFLite: melspektrogram → embedding → hey_jarvis),
 *     mikrofon 16 kHz, analiza co 80 ms; dźwięk nigdzie nie wychodzi,
 *  2. po wykryciu: sygnał + rozpoznawanie mowy Google (pl-PL) — dopiero to nagranie idzie do Google,
 *  3. tekst → strona (window.jarvisGlos) → /api/jarvis na malince → odpowiedź → mow() czyta ją na głos.
 * Mikrofon ma jeden właściciel naraz: na czas rozpoznawania i mówienia nasłuch słowa-klucza jest zatrzymany.
 */
final class Glos {

    interface Sluchacz {
        void zdarzenie(String stan, String tekst);   // wake | czesciowy | tekst | blad
    }

    private static final String TAG = "JarvisGlos";
    private static final int RATE = 16000;
    private static final int CHUNK = 1280;            // 80 ms
    private static final int OGON = 480;              // openWakeWord: 3 ramki kontekstu z poprzedniego kawałka
    private static final int MEL_OKNO = 76;           // ramek melspektrogramu na jedno okno embeddingu
    private static final int MEL_PASMA = 32;
    private static final int EMB = 96;
    private static final float PROG = 0.4f;           // próg słowa-klucza (openWakeWord ma 0.5; zmierzone 2026-11-10: mowa z daleka 0.45-0.5, cisza < 0.1)
    private static final float WZM_MAX = 8f;          // maks. automatyczne wzmocnienie (mikrofon VOICE_RECOGNITION w Redmi jest ~20 dB za cichy)
    private static final float CEL_SZCZYT = 16000f;   // AGC: szczyt mowy po wzmocnieniu ok. -6 dBFS
    private static final int RAMEK_WAKE = 2;          // tyle KOLEJNYCH kawałków 80 ms musi przekroczyć próg (1 = dawne zachowanie)
    static final float KLASK_DB = 18f;
    /** Kolejność = wartość mic_zrodlo w ustawieniach (VOICE_RECOGNITION, MIC, VOICE_COMMUNICATION, UNPROCESSED). */
    static final String[] NAZWY_ZRODEL = {"Rozpoznawanie mowy (domyślne, z redukcją szumów)", "Mikrofon (MIC)",
            "Rozmowa (VOICE_COMMUNICATION)", "Bez przetwarzania (UNPROCESSED)"};                // klaśnięcie: o ile dB ponad szum tła (prefs klask_db)
    private static final long CZEKAJ_NA_ODPOWIEDZ_MS = 20_000;
    private static final long MAX_MOWIENIE_MS = 90_000;

    private final Activity act;
    private final Handler h;
    private final Sluchacz sluchacz;

    private Interpreter mel;
    private Interpreter emb;
    private Interpreter ww;
    private int melRamek;
    private int wwRamek;
    private ByteBuffer melWe;
    private ByteBuffer melWy;
    private ByteBuffer embWe;
    private ByteBuffer embWy;
    private ByteBuffer wwWe;
    private ByteBuffer wwWy;
    private final float[] ogon = new float[OGON];
    private final ArrayDeque<float[]> melHist = new ArrayDeque<>();
    private final ArrayDeque<float[]> embHist = new ArrayDeque<>();

    private volatile boolean wlaczone = false;
    private volatile boolean nasluchuje = false;
    private Thread watek;
    private boolean zajety = false;                   // rozpoznawanie / czekanie na odpowiedź / mówienie
    private volatile String stan = "wyłączony";

    private SpeechRecognizer rozpoznawanie;
    private TextToSpeech tts;
    private boolean ttsGotowy = false;
    private ToneGenerator ton;

    private final Runnable wznow = this::wznowNasluch;

    // podgląd diagnostyczny (Podglad.java) — zapisywane w wątku nasłuchu, czytane w wątku głównym
    volatile float diagWynik = 0f;        // wynik „Hey Jarvis” z ostatniego kawałka
    volatile float diagMax = 0f;          // szczyt z ostatnich ~2 s (opada)
    volatile float diagPoziom = -90f;     // poziom SUROWY kawałka, dBFS
    volatile float diagWzm = 1f;          // bieżące wzmocnienie AGC
    volatile float diagWzmMax = WZM_MAX;
    volatile float diagProg = PROG;
    volatile boolean diagKlaski = false;
    volatile float diagKlaskProg = KLASK_DB;
    volatile Klaskacz diagKlaskacz = null;
    volatile String diagZdarzenie = "—";
    volatile int diagZrodlo = 0;

    Glos(Activity act, Handler h, Sluchacz sluchacz) {
        this.act = act;
        this.h = h;
        this.sluchacz = sluchacz;
        tts = new TextToSpeech(act, s -> {
            if (s != TextToSpeech.SUCCESS) return;
            int r = tts.setLanguage(new Locale("pl", "PL"));
            ttsGotowy = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
            ustawGlos(act.getSharedPreferences("panel", Activity.MODE_PRIVATE).getString("glos_tts", ""));
            tts.setSpeechRate(act.getSharedPreferences("panel", Activity.MODE_PRIVATE).getFloat("glos_tempo", 1.0f));
            for (android.speech.tts.Voice v : glosyPl()) Log.i(TAG, "glos: " + v.getName() + (v.isNetworkConnectionRequired() ? " (online)" : ""));
            tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { h.post(wznow); }
                @Override public void onError(String id) { h.post(wznow); }
            });
        });
    }

    // ------------------------------------------------------------------ sterowanie (wątek główny)
    void ustawWlaczone(boolean w) {
        wlaczone = w;
        aktualizuj();
    }

    String stan() {
        return stan;
    }

    void aktualizuj() {
        boolean upr = act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (!wlaczone) {
            zatrzymajNasluch();
            stan = "wyłączony";
        } else if (!upr) {
            zatrzymajNasluch();
            stan = "brak uprawnienia do mikrofonu";
        } else if (!zajety && !nasluchuje) {
            startNasluch();
        }
    }

    /** Po zmianie progów w ustawieniach: pętla czyta je przy starcie, więc uruchamiamy ją od nowa. */
    void restartNasluch() {
        if (nasluchuje && !zajety) {
            zatrzymajNasluch();
            aktualizuj();
        }
    }

    /** Przycisk 🎙️ na panelu — mów bez słowa-klucza. */
    void sluchajTeraz() {
        if (zajety) return;
        if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            sluchacz.zdarzenie("blad", "Brak uprawnienia do mikrofonu");
            return;
        }
        rozpocznijPolecenie();
    }

    /** Odpowiedź na głos. Nasłuch słowa-klucza wraca po skończeniu mówienia (żeby JARVIS nie obudził sam siebie). */
    void mow(String tekst) {
        h.removeCallbacks(wznow);
        if (!ttsGotowy || tekst == null || tekst.trim().isEmpty()) {
            wznowNasluch();
            return;
        }
        zajety = true;
        zatrzymajNasluch();
        stan = "mówi";
        tts.speak(tekst, TextToSpeech.QUEUE_FLUSH, null, "jarvis-" + SystemClock.uptimeMillis());
        h.postDelayed(wznow, MAX_MOWIENIE_MS);   // zapas, gdyby TTS nie zgłosił końca
    }

    // ------------------------------------------------------------------ głos JARVIS-a (wybór w ustawieniach appki)
    /** Polskie głosy syntezatora (Google TTS ma kilka: damskie i męskie, lokalne i online). */
    java.util.List<android.speech.tts.Voice> glosyPl() {
        java.util.List<android.speech.tts.Voice> out = new java.util.ArrayList<>();
        if (!ttsGotowy || tts.getVoices() == null) return out;
        for (android.speech.tts.Voice v : tts.getVoices()) {
            if ("pl".equals(v.getLocale().getLanguage()) && !v.getFeatures().contains("notInstalled")) out.add(v);
        }
        out.sort((a, b) -> a.getName().compareTo(b.getName()));
        return out;
    }

    /** Pusta nazwa = domyślny polski głos. */
    void ustawGlos(String nazwa) {
        if (!ttsGotowy) return;
        if (nazwa == null || nazwa.isEmpty()) {
            tts.setLanguage(new Locale("pl", "PL"));
            return;
        }
        for (android.speech.tts.Voice v : glosyPl()) {
            if (v.getName().equals(nazwa)) {
                tts.setVoice(v);
                return;
            }
        }
    }

    void ustawTempo(float tempo) {
        if (ttsGotowy) tts.setSpeechRate(tempo);
    }

    /** Odsłuch w ustawieniach — bez wstrzymywania nasłuchu (krótka próbka). */
    void probka() {
        if (ttsGotowy) tts.speak("Dzień dobry, tak brzmi mój głos. Na zewnątrz jest pięć stopni.", TextToSpeech.QUEUE_FLUSH, null, "probka");
    }

    void zamknij() {
        h.removeCallbacks(wznow);
        zatrzymajNasluch();
        if (rozpoznawanie != null) rozpoznawanie.destroy();
        if (tts != null) tts.shutdown();
        if (ton != null) ton.release();
        for (Interpreter i : new Interpreter[]{mel, emb, ww}) if (i != null) i.close();
    }

    // ------------------------------------------------------------------ słowo-klucz
    private void startNasluch() {
        try {
            if (mel == null) wczytajModele();
        } catch (Exception e) {
            stan = "błąd modelu: " + e.getMessage();
            Log.e(TAG, "modele", e);
            return;
        }
        nasluchuje = true;
        watek = new Thread(this::petla, "jarvis-nasluch");
        watek.start();
    }

    private void zatrzymajNasluch() {
        nasluchuje = false;
        Thread w = watek;
        if (w != null) {
            try {
                w.join(400);   // pętla oddaje mikrofon najpóźniej po jednym kawałku (80 ms)
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        watek = null;
    }

    private void wznowNasluch() {
        h.removeCallbacks(wznow);
        zajety = false;
        aktualizuj();
    }

    private void petla() {
        AudioRecord ar = null;
        try {
            // strojenie bez przebudowy (prefs "panel"): mic_zrodlo 0=VOICE_RECOGNITION 1=MIC 2=VOICE_COMMUNICATION 3=UNPROCESSED,
            // mic_wzm = maks. automatyczne wzmocnienie przed modelem (1 = bez wzmacniania), mic_prog = próg słowa-klucza
            android.content.SharedPreferences pr = act.getSharedPreferences("panel", Activity.MODE_PRIVATE);
            int[] zrodla = {MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.UNPROCESSED};
            int zr = Math.max(0, Math.min(zrodla.length - 1, pr.getInt("mic_zrodlo", 0)));
            float wzm = Math.max(1f, Math.min(16f, pr.getFloat("mic_wzm", WZM_MAX)));
            float prog = Math.max(0.1f, Math.min(0.95f, pr.getFloat("mic_prog", PROG)));
            boolean klaski = pr.getBoolean("klaski", false);   // 1.7: domyślnie wyłączone (dwuklik myszką = fałszywe klaśnięcie)
            diagZrodlo = zr;
            float klaskDb = Math.max(6f, Math.min(40f, pr.getFloat("klask_db", KLASK_DB)));
            Klaskacz klaskacz = klaski ? new Klaskacz(klaskDb) : null;
            diagProg = prog;
            diagWzmMax = wzm;
            diagKlaski = klaski;
            diagKlaskProg = klaskDb;
            diagKlaskacz = klaskacz;
            int nadProgiem = 0;
            float pierwszyNad = 0f;
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            ar = new AudioRecord(zrodla[zr], RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(min, CHUNK * 2 * 4));
            Log.i(TAG, String.format(Locale.ROOT, "mikrofon: zrodlo=%d wzm=%.1f prog=%.2f ramek=%d klaski=%s(%.0f dB)",
                    zr, wzm, prog, RAMEK_WAKE, klaski, klaskDb));
            if (ar.getState() != AudioRecord.STATE_INITIALIZED) {
                stan = "mikrofon niedostępny";
                return;
            }
            ar.startRecording();
            stan = "nasłuchuje „Hey Jarvis”";
            resetModelu();
            short[] buf = new short[CHUNK];
            float maks = 0f;
            double sumaKw = 0;
            long probek = 0;
            int szczyt = 0;
            float obwiednia = 0f;   // AGC: szczyt z ostatniej ~1 s (opada o 10% na kawałek 80 ms)
            float wzmSuma = 0f;
            int kawalkow = 0;
            long ostLog = SystemClock.uptimeMillis();
            while (nasluchuje) {
                int n = 0;
                while (n < CHUNK && nasluchuje) {
                    int r = ar.read(buf, n, CHUNK - n);
                    if (r < 0) throw new IOException("AudioRecord.read " + r);
                    n += r;
                }
                if (!nasluchuje) break;
                int szczytKaw = 0;
                double kwKaw = 0;
                for (int i = 0; i < CHUNK; i++) {
                    int v = buf[i];
                    kwKaw += (double) v * v;
                    szczytKaw = Math.max(szczytKaw, Math.abs(v));
                }
                sumaKw += kwKaw;
                szczyt = Math.max(szczyt, szczytKaw);
                probek += CHUNK;
                diagPoziom = (float) (20 * Math.log10(Math.max(Math.sqrt(kwKaw / CHUNK), 1) / 32768.0));
                // podwójne klaśnięcie: na SUROWYM dźwięku (przed wzmocnieniem), działa jak „Hey Jarvis”
                if (klaskacz != null && klaskacz.kawalek(buf)) {
                    Log.i(TAG, String.format(Locale.ROOT, "KLASK x2 (+%.0f dB ponad tło)", klaskacz.ostatniDb));
                    diagZdarzenie = "klaśnięcie ×2 " + godzina();
                    nasluchuje = false;
                    h.post(this::poSlowieKluczu);
                    break;
                }
                // AGC: cichy głos z daleka dostaje do wzm razy więcej, głośny z bliska mniej - bez przesterowania
                obwiednia = Math.max(szczytKaw, obwiednia * 0.9f);
                float g = Math.min(wzm, Math.max(1f, CEL_SZCZYT / Math.max(obwiednia, 1f)));
                wzmSuma += g;
                kawalkow++;
                diagWzm = g;
                if (g > 1.001f) {
                    for (int i = 0; i < CHUNK; i++) buf[i] = (short) Math.max(-32768, Math.min(32767, Math.round(buf[i] * g)));
                }
                float s = przetworz(buf);
                maks = Math.max(maks, s);
                diagWynik = s;
                diagMax = Math.max(s, diagMax * 0.97f);
                if (s >= 0.1f) Log.d(TAG, String.format(Locale.ROOT, "wynik %.3f", s));
                long t = SystemClock.uptimeMillis();
                if (t - ostLog >= 10_000) {
                    // poziom SUROWY (przed wzmocnieniem), dBFS: 0 = pełna skala, cisza w pokoju zwykle -60..-45
                    double rms = Math.sqrt(sumaKw / Math.max(1, probek));
                    Log.d(TAG, String.format(Locale.ROOT, "10 s: max wynik %.3f, poziom sr %.1f dBFS, szczyt %.1f dBFS, wzm sr x%.1f",
                            maks, 20 * Math.log10(Math.max(rms, 1) / 32768.0), 20 * Math.log10(Math.max(szczyt, 1) / 32768.0),
                            wzmSuma / Math.max(1, kawalkow)));
                    wzmSuma = 0f;
                    kawalkow = 0;
                    maks = 0f;
                    sumaKw = 0;
                    probek = 0;
                    szczyt = 0;
                    ostLog = t;
                }
                // słowo-klucz dopiero po RAMEK_WAKE kolejnych kawałkach nad progiem — pojedynczy skok (szum, stuk) odpada
                if (s >= prog) {
                    if (nadProgiem == 0) pierwszyNad = s;
                    nadProgiem++;
                } else if (nadProgiem > 0) {
                    Log.d(TAG, String.format(Locale.ROOT, "odrzucone: %d kawałek nad progiem (%.3f)", nadProgiem, pierwszyNad));
                    diagZdarzenie = String.format(Locale.ROOT, "odrzucone (%d×80 ms) %.2f %s", nadProgiem, pierwszyNad, godzina());
                    nadProgiem = 0;
                }
                if (nadProgiem >= RAMEK_WAKE) {
                    Log.i(TAG, String.format(Locale.ROOT, "WAKE %.3f (%d kawałki nad progiem)", s, nadProgiem));
                    diagZdarzenie = String.format(Locale.ROOT, "Hey Jarvis %.2f %s", s, godzina());
                    nasluchuje = false;
                    h.post(this::poSlowieKluczu);
                    break;
                }
            }
        } catch (Exception e) {
            stan = "błąd mikrofonu: " + e.getMessage();
            Log.e(TAG, "petla", e);
        } finally {
            if (ar != null) {
                try {
                    ar.stop();
                } catch (Exception ignored) {
                    // nie nagrywał
                }
                ar.release();
            }
        }
    }

    private static String godzina() {
        return new java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new java.util.Date());
    }

    /**
     * Podwójne klaśnięcie: dwa krótkie, ostre impulsy w odstępie 150–700 ms, z ciszą przed pierwszym (500 ms)
     * i po drugim (400 ms). Trzeci impuls (oklaski, stukanie) albo dłuższy głośny dźwięk (mowa) kasuje sekwencję.
     * Liczone w ramkach 10 ms na surowym dźwięku, względem szumu tła, który uczy się sam (~2 s).
     */
    static final class Klaskacz {
        private static final int RAMKA = 160;              // 10 ms przy 16 kHz
        private static final double MIN_E = 200.0 * 200.0; // bezwzględne minimum energii (cisza cyfrowa nie wyzwala)
        private final double prog;                         // krotność energii tła
        private double tlo = -1;
        private double poprzednia = 0;
        private long ramka = 0;
        private long kandOd = -1;                          // kandydat: sprawdzamy, czy po 50–80 ms dźwięk zgasł
        private double kandSzczyt = 0;
        private double kandOgon = 0;
        private long ostatniImpuls = -1000;
        private long ostatniKlask = -1000;
        private long pierwszy = -1;
        private long drugi = -1;
        volatile float ostatniDb = 0f;                     // podgląd: o ile dB ponad tło był ostatni ostry impuls
        volatile String ostatni = "—";

        Klaskacz(float db) {
            prog = Math.pow(10, db / 10.0);
        }

        /** Kawałek 80 ms surowych próbek → true, gdy właśnie rozpoznano podwójne klaśnięcie. */
        boolean kawalek(short[] buf) {
            boolean wynik = false;
            for (int o = 0; o + RAMKA <= buf.length; o += RAMKA) {
                double e = 0;
                for (int i = o; i < o + RAMKA; i++) e += (double) buf[i] * buf[i];
                if (ramka(e / RAMKA)) wynik = true;
            }
            return wynik;
        }

        private boolean ramka(double e) {
            long r = ramka++;
            if (tlo < 0) tlo = Math.max(e, 1);
            if (kandOd >= 0) {
                long d = r - kandOd;
                if (d <= 1) kandSzczyt = Math.max(kandSzczyt, e);
                else if (d >= 5) kandOgon = Math.max(kandOgon, e);
                if (d >= 8) {
                    boolean krotki = kandOgon < kandSzczyt / 16;   // po 50–80 ms co najmniej 12 dB ciszej
                    if (krotki) {
                        ostatni = "klask";
                        klask(kandOd);
                    } else {
                        ostatni = "długi dźwięk (nie klask)";
                        pierwszy = -1;
                        drugi = -1;
                        ostatniImpuls = r;
                    }
                    kandOd = -1;
                }
            } else if (e > tlo * prog && e > MIN_E && poprzednia * 8 < e) {
                ostatniDb = (float) (10 * Math.log10(e / tlo));     // ostry skok ponad tło = kandydat
                kandOd = r;
                kandSzczyt = e;
                kandOgon = 0;
            } else {
                if (e > tlo * prog && e > MIN_E && r - ostatniKlask > 15) {
                    ostatniImpuls = r;                              // głośno, ale nie ostro (mowa, muzyka)
                    pierwszy = -1;
                    drugi = -1;
                }
                tlo += (e - tlo) * 0.005;
            }
            poprzednia = e;
            if (pierwszy >= 0 && drugi < 0 && r - pierwszy > 70) pierwszy = -1;
            if (drugi >= 0 && kandOd < 0 && r - drugi >= 40) {
                pierwszy = -1;
                drugi = -1;
                ostatni = "KLASK ×2";
                return true;
            }
            return false;
        }

        private void klask(long t) {
            if (drugi >= 0) {                     // trzeci = oklaski / stukanie
                pierwszy = -1;
                drugi = -1;
            } else if (pierwszy >= 0 && t - pierwszy >= 15 && t - pierwszy <= 70) {
                drugi = t;
            } else if (t - ostatniImpuls >= 50) {
                pierwszy = t;
            } else {
                pierwszy = -1;
            }
            ostatniImpuls = t;
            ostatniKlask = t;
        }
    }

    private void poSlowieKluczu() {
        if (zajety) return;
        rozpocznijPolecenie();
    }

    // ------------------------------------------------------------------ polecenie (Google, pl-PL)
    private void rozpocznijPolecenie() {
        zajety = true;
        zatrzymajNasluch();
        stan = "słucha polecenia";
        sluchacz.zdarzenie("wake", "");
        try {
            if (ton == null) ton = new ToneGenerator(AudioManager.STREAM_MUSIC, 70);
            ton.startTone(ToneGenerator.TONE_PROP_BEEP, 120);
        } catch (Exception ignored) {
            // bez sygnału
        }
        h.postDelayed(this::rozpoznawaj, 200);
    }

    private void rozpoznawaj() {
        if (!SpeechRecognizer.isRecognitionAvailable(act)) {
            sluchacz.zdarzenie("blad", "Brak rozpoznawania mowy Google na telefonie");
            wznowNasluch();
            return;
        }
        if (rozpoznawanie == null) {
            rozpoznawanie = SpeechRecognizer.createSpeechRecognizer(act);
            rozpoznawanie.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle p) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rms) { }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onEvent(int typ, Bundle p) { }

                @Override public void onPartialResults(Bundle wyniki) {
                    String t = pierwszy(wyniki);
                    if (!t.isEmpty()) sluchacz.zdarzenie("czesciowy", t);
                }

                @Override public void onResults(Bundle wyniki) {
                    String t = pierwszy(wyniki);
                    if (t.isEmpty()) {
                        sluchacz.zdarzenie("blad", "Nie usłyszałem");
                        wznowNasluch();
                        return;
                    }
                    Log.i(TAG, "POLECENIE: " + t);
                    stan = "czeka na odpowiedź";
                    sluchacz.zdarzenie("tekst", t);
                    h.removeCallbacks(wznow);
                    h.postDelayed(wznow, CZEKAJ_NA_ODPOWIEDZ_MS);   // strona zwykle wcześniej woła mow()
                }

                @Override public void onError(int kod) {
                    Log.w(TAG, "rozpoznawanie: blad " + kod);
                    sluchacz.zdarzenie("blad", opisBledu(kod));
                    wznowNasluch();
                }
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pl-PL");
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, act.getPackageName());
        rozpoznawanie.startListening(i);
    }

    private static String pierwszy(Bundle wyniki) {
        ArrayList<String> l = wyniki == null ? null : wyniki.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return l == null || l.isEmpty() || l.get(0) == null ? "" : l.get(0).trim();
    }

    private static String opisBledu(int kod) {
        switch (kod) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "Nie usłyszałem";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "Brak internetu do rozpoznawania mowy";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "Brak uprawnienia do mikrofonu";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "Rozpoznawanie mowy zajęte";
            default:
                return "Błąd rozpoznawania mowy (" + kod + ")";
        }
    }

    // ------------------------------------------------------------------ openWakeWord (TFLite)
    private void wczytajModele() throws IOException {
        // melspektrogram ma wejście o zmiennej długości [1, -1] — domyślny delegat XNNPACK próbuje je przygotować
        // przed resizeInput i pada (BytesRequired overflowed); model jest malutki, liczymy go zwyklym CPU
        mel = wczytaj("melspectrogram.tflite", false);
        mel.resizeInput(0, new int[]{1, OGON + CHUNK});
        mel.allocateTensors();
        int[] ms = mel.getOutputTensor(0).shape();     // [1, 1, ramki, 32]
        melRamek = ms[ms.length - 2];
        emb = wczytaj("embedding_model.tflite", true);
        ww = wczytaj("hey_jarvis_v0.1.tflite", true);
        wwRamek = ww.getInputTensor(0).shape()[1];     // 16 embeddingów
        melWe = bufor(OGON + CHUNK);
        melWy = bufor(iloczyn(ms));
        embWe = bufor(MEL_OKNO * MEL_PASMA);
        embWy = bufor(iloczyn(emb.getOutputTensor(0).shape()));
        wwWe = bufor(wwRamek * EMB);
        wwWy = bufor(iloczyn(ww.getOutputTensor(0).shape()));
        Log.i(TAG, "modele: mel ramek/kawałek=" + melRamek + " ww ramek=" + wwRamek);
    }

    private Interpreter wczytaj(String plik, boolean xnnpack) throws IOException {
        try (AssetFileDescriptor fd = act.getAssets().openFd(plik);
             FileInputStream in = new FileInputStream(fd.getFileDescriptor())) {
            MappedByteBuffer mb = in.getChannel().map(FileChannel.MapMode.READ_ONLY, fd.getStartOffset(), fd.getDeclaredLength());
            Interpreter.Options o = new Interpreter.Options();
            o.setNumThreads(1);
            o.setUseXNNPACK(xnnpack);
            return new Interpreter(mb, o);
        }
    }

    private static ByteBuffer bufor(int floaty) {
        return ByteBuffer.allocateDirect(floaty * 4).order(ByteOrder.nativeOrder());
    }

    private static int iloczyn(int[] s) {
        int n = 1;
        for (int v : s) n *= v;
        return n;
    }

    /** Jak w openWakeWord: bufor melspektrogramu startuje z jedynek, historia embeddingów pusta. */
    private void resetModelu() {
        melHist.clear();
        embHist.clear();
        for (int i = 0; i < MEL_OKNO; i++) {
            float[] r = new float[MEL_PASMA];
            java.util.Arrays.fill(r, 1f);
            melHist.addLast(r);
        }
        java.util.Arrays.fill(ogon, 0f);
    }

    /** Jeden kawałek 80 ms → wynik słowa-klucza 0..1 (0, dopóki historia się nie zapełni ~1,3 s). */
    private float przetworz(short[] kawalek) {
        melWe.rewind();
        for (float v : ogon) melWe.putFloat(v);
        for (short s : kawalek) melWe.putFloat(s);           // surowe wartości int16 jako float — tak uczono model
        for (int i = 0; i < OGON; i++) ogon[i] = kawalek[CHUNK - OGON + i];
        melWe.rewind();
        melWy.rewind();
        mel.run(melWe, melWy);
        melWy.rewind();
        for (int f = 0; f < melRamek; f++) {
            float[] r = new float[MEL_PASMA];
            for (int k = 0; k < MEL_PASMA; k++) r[k] = melWy.getFloat() / 10f + 2f;
            melHist.addLast(r);
            if (melHist.size() > MEL_OKNO) melHist.removeFirst();
        }

        embWe.rewind();
        for (float[] r : melHist) for (float v : r) embWe.putFloat(v);
        embWe.rewind();
        embWy.rewind();
        emb.run(embWe, embWy);
        embWy.rewind();
        float[] e = new float[EMB];
        for (int k = 0; k < EMB; k++) e[k] = embWy.getFloat();
        embHist.addLast(e);
        if (embHist.size() > wwRamek) embHist.removeFirst();
        if (embHist.size() < wwRamek) return 0f;

        wwWe.rewind();
        for (float[] r : embHist) for (float v : r) wwWe.putFloat(v);
        wwWe.rewind();
        wwWy.rewind();
        ww.run(wwWe, wwWy);
        wwWy.rewind();
        return wwWy.getFloat();
    }
}
