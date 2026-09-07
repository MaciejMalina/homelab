#!/usr/bin/env python3
# JARVIS - asystent glosowy (malinka).
# Nasluch "Hey Jarvis" -> WoL Node 2 + nagranie polecenia -> Whisper -> n8n -> Discord.
import os, io, time, wave, socket
import numpy as np
import sounddevice as sd
import requests
from openwakeword.model import Model

# --- Konfiguracja (z env, z domyslnymi) ---
WAKEWORD       = os.getenv("WAKEWORD", "hey_jarvis")
THRESHOLD      = float(os.getenv("THRESHOLD", "0.6"))
NODE2_IP       = os.getenv("NODE2_IP", "192.168.1.162")
NODE2_MAC      = os.getenv("NODE2_MAC", "4c:cc:6a:4a:33:6d")
WHISPER_BASE   = os.getenv("WHISPER_BASE", "http://100.93.105.37:9000")
N8N_URL        = os.getenv("N8N_URL", "http://100.93.105.37:5678/webhook/chat")
DISCORD_WEBHOOK= os.getenv("DISCORD_WEBHOOK", "")
USER_ID        = os.getenv("USER_ID", "340572098873393153")

RATE  = 16000
CHUNK = 1280
SILENCE_RMS    = float(os.getenv("SILENCE_RMS", "500"))   # prog ciszy - dostroic
SILENCE_CHUNKS = int(1.0 * RATE / CHUNK)                  # ~1 s ciszy konczy nagranie
MAX_CHUNKS     = int(8.0 * RATE / CHUNK)                  # max 8 s polecenia

def send_wol(mac):
    mac_b = bytes.fromhex(mac.replace(":", ""))
    pkt = b"\xff" * 6 + mac_b * 16
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.sendto(pkt, ("255.255.255.255", 9))
    s.close()

def wait_whisper(timeout=150):
    end = time.time() + timeout
    while time.time() < end:
        try:
            requests.get(WHISPER_BASE + "/docs", timeout=3)
            return True
        except Exception:
            pass
        time.sleep(3)
    return False

def record_command(stream):
    frames = []; silent = 0; spoke = False
    for _ in range(MAX_CHUNKS):
        audio, _ = stream.read(CHUNK)
        frames.append(audio.copy())
        rms = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
        if rms > SILENCE_RMS:
            spoke = True; silent = 0
        elif spoke:
            silent += 1
            if silent >= SILENCE_CHUNKS:
                break
    data = np.concatenate(frames).flatten().astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(RATE)
        wf.writeframes(data.tobytes())
    buf.seek(0)
    return buf

def discord(msg):
    if not DISCORD_WEBHOOK:
        print("[discord] brak webhooka:", msg); return
    payload = {"content": msg}
    if USER_ID:
        payload["allowed_mentions"] = {"users": [USER_ID]}
    try:
        requests.post(DISCORD_WEBHOOK, json=payload, timeout=10)
    except Exception as e:
        print("[discord] blad:", e)

model = Model(wakeword_models=[WAKEWORD], inference_framework="onnx")
print(f"Sluucham '{WAKEWORD}'... (prog {THRESHOLD})")

with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK) as stream:
    while True:
        audio, _ = stream.read(CHUNK)
        score = model.predict(audio.flatten()).get(WAKEWORD, 0.0)
        if score <= THRESHOLD:
            continue

        print(f"[WAKE] {score:.2f} -> WoL Node 2 + nagrywam")
        send_wol(NODE2_MAC)
        wav = record_command(stream)

        if not wait_whisper():
            discord(f"<@{USER_ID}> ⚠️ Node 2 nie wstał na czas (głos).")
            try: model.reset()
            except Exception: pass
            continue

        try:
            r = requests.post(
                WHISPER_BASE + "/asr?task=transcribe&language=pl&output=txt",
                files={"audio_file": ("cmd.wav", wav, "audio/wav")}, timeout=90)
            text = r.text.strip()
        except Exception as e:
            discord(f"<@{USER_ID}> ⚠️ Błąd Whisper: {e}")
            try: model.reset()
            except Exception: pass
            continue

        print("[STT]", text)
        if not text:
            try: model.reset()
            except Exception: pass
            continue

        try:
            rr = requests.post(N8N_URL, json={"prompt": text}, timeout=120)
            reply = rr.json().get("reply", "(brak odpowiedzi)")
        except Exception as e:
            reply = f"⚠️ Błąd n8n: {e}"

        discord(f"<@{USER_ID}>\n🎤 **Ty:** {text}\n🤖 **JARVIS:** {reply}")
        try: model.reset()
        except Exception: pass
        time.sleep(2)   # krotki cooldown, by nie zlapac echa
