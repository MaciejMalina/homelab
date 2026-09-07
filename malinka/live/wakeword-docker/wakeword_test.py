#!/usr/bin/env python3
# Test wykrywania slowa-klucza "Hey Jarvis" na malince.
# Uruchom w venv: source ~/wakeword/bin/activate && python wakeword_test.py
import sounddevice as sd
import numpy as np
from openwakeword.model import Model

RATE = 16000          # openWakeWord wymaga 16 kHz mono
CHUNK = 1280          # 80 ms ramki
THRESHOLD = 0.5       # czulosc (0-1); podnies jak lapie falszywie, obniz jak nie lapie
WAKEWORD = "hey_jarvis"

# Jesli mic NIE jest domyslnym urzadzeniem, ustaw indeks z: python -c "import sounddevice; print(sounddevice.query_devices())"
# sd.default.device = (INDEKS_MIKROFONU, None)

model = Model(wakeword_models=[WAKEWORD], inference_framework="onnx")

print("Sluucham... powiedz 'Hey Jarvis' (Ctrl+C aby zakonczyc)")
with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK) as stream:
    while True:
        audio, _ = stream.read(CHUNK)
        prediction = model.predict(audio.flatten())
        score = prediction.get(WAKEWORD, 0.0)
        if score > THRESHOLD:
            print(f"[WYKRYTO] {WAKEWORD}  (pewnosc {score:.2f})")
