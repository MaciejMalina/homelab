package pl.maciej.jarvispanel;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.View;

import java.util.Locale;

/**
 * Podgląd diagnostyczny nad panelem (włączany w ustawieniach appki): co widzi kamera i co słyszy mikrofon,
 * razem z progami — do strojenia na miejscu bez logów przez USB. Nie przechwytuje dotyku.
 * Kadr z kamery jest tylko na ekranie telefonu, nigdzie nie wychodzi.
 */
final class Podglad extends View {

    private static final long ODSWIEZ_MS = 250;

    private final Gesty gesty;
    private final Glos glos;
    private final float dp;
    private final Paint tlo = new Paint();
    private final Paint tekst = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ramka = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint pasek = new Paint();
    private final RectF r = new RectF();

    private final Runnable odswiez = new Runnable() {
        @Override public void run() {
            invalidate();
            postDelayed(this, ODSWIEZ_MS);
        }
    };

    Podglad(Context c, Gesty gesty, Glos glos) {
        super(c);
        this.gesty = gesty;
        this.glos = glos;
        dp = c.getResources().getDisplayMetrics().density;
        tlo.setColor(Color.argb(200, 0, 0, 0));
        tekst.setColor(Color.rgb(220, 226, 235));
        tekst.setTextSize(11 * dp);
        ramka.setStyle(Paint.Style.STROKE);
        ramka.setStrokeWidth(2 * dp);
        setClickable(false);
        setFocusable(false);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        post(odswiez);
    }

    @Override
    protected void onDetachedFromWindow() {
        removeCallbacks(odswiez);
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth();
        float h = getHeight();
        r.set(0, 0, w, h);
        c.drawRoundRect(r, 8 * dp, 8 * dp, tlo);
        float m = 6 * dp;

        // ---- kadr z kamery (lustro, jak selfie) + ramka największej twarzy
        float kw = 0;
        Bitmap bm = gesty != null ? gesty.diagObraz : null;
        if (bm != null && bm.getWidth() > 0) {
            float kh = h - 2 * m;
            kw = kh * bm.getWidth() / bm.getHeight();
            r.set(m, m, m + kw, m + kh);
            c.save();
            c.scale(-1, 1, r.centerX(), r.centerY());
            c.drawBitmap(bm, null, r, null);
            RectF f = gesty.diagRamka;
            if (f != null) {
                boolean dosc = gesty.diagSzer >= gesty.twarzMin();
                ramka.setColor(dosc ? Color.rgb(80, 220, 120) : Color.rgb(240, 200, 60));
                c.drawRect(r.left + f.left * kw, r.top + f.top * kh, r.left + f.right * kw, r.top + f.bottom * kh, ramka);
            }
            c.restore();
            kw += m;
        }

        // ---- tekst
        float x = m + kw;
        float lh = 14 * dp;
        float y = m + lh - 3 * dp;
        if (gesty != null) {
            boolean dlon = SystemClock.uptimeMillis() - gesty.diagDlon < 1500;
            c.drawText(String.format(Locale.ROOT, "Twarz: %.0f%% kadru (włącza od %.0f%%)  pewność %.2f",
                    100 * gesty.diagSzer, 100 * gesty.twarzMin(), gesty.diagPewnosc), x, y, tekst);
            y += lh;
            c.drawText(String.format(Locale.ROOT, "Trafienia: %d/4 (włącza 3/4)  dłoń: %s  OBECNOŚĆ: %s",
                    gesty.diagTrafien, dlon ? "tak" : "nie", gesty.obecnyTeraz() ? "JEST" : "brak"), x, y, tekst);
            y += lh;
            c.drawText("Kamera: " + gesty.stan(), x, y, tekst);
            y += lh;
        }
        if (glos != null) {
            c.drawText(String.format(Locale.ROOT, "Mikrofon: %.0f dBFS  wzm ×%.1f (max ×%.1f)",
                    glos.diagPoziom, glos.diagWzm, glos.diagWzmMax), x, y, tekst);
            y += lh;
            // pasek wyniku „Hey Jarvis”: szary = szczyt z ~2 s, kolor = teraz, biała kreska = próg
            float pw = w - x - m;
            float ph = 8 * dp;
            float py = y - ph + 1 * dp;
            pasek.setColor(Color.rgb(60, 66, 76));
            c.drawRect(x, py, x + pw, py + ph, pasek);
            pasek.setColor(Color.rgb(110, 118, 130));
            c.drawRect(x, py, x + pw * Math.min(1f, glos.diagMax), py + ph, pasek);
            pasek.setColor(glos.diagWynik >= glos.diagProg ? Color.rgb(240, 90, 80) : Color.rgb(80, 160, 240));
            c.drawRect(x, py, x + pw * Math.min(1f, glos.diagWynik), py + ph, pasek);
            pasek.setColor(Color.WHITE);
            float px = x + pw * glos.diagProg;
            c.drawRect(px - dp, py - 2 * dp, px + dp, py + ph + 2 * dp, pasek);
            y += lh;
            c.drawText(String.format(Locale.ROOT, "Hey Jarvis: %.2f  szczyt %.2f  próg %.2f (2 kolejne ramki)",
                    glos.diagWynik, glos.diagMax, glos.diagProg), x, y, tekst);
            y += lh;
            Glos.Klaskacz k = glos.diagKlaskacz;
            c.drawText(glos.diagKlaski && k != null
                    ? String.format(Locale.ROOT, "Klaśnięcia: ostatni impuls +%.0f dB (próg %.0f) — %s", k.ostatniDb, glos.diagKlaskProg, k.ostatni)
                    : "Klaśnięcia: wyłączone", x, y, tekst);
            y += lh;
            c.drawText("Ostatnio: " + glos.diagZdarzenie + "  |  " + glos.stan(), x, y, tekst);
        }
    }
}
