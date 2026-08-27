# n8n — narzędzie `set_light` dla agenta JARVIS

Domyka pomysł z §3 audytu (agent z narzędziami): po dodaniu tego node'a
„Jarvis, zgaś światło w salonie" albo „ustaw ciepłe światło na 30%" działa
i z czatu, i z głosu — bez nowego workflow.

## Node: **HTTP Request Tool** (podpięty pod AI Agent → Tools)

| Pole | Wartość |
|---|---|
| **Name** | `set_light` |
| **Description** | `Steruje paskiem LED w salonie. Używaj gdy użytkownik prosi o włączenie, wyłączenie, przygaszenie, rozjaśnienie lub zmianę koloru światła. Parametry: on (true/false), bri (jasność 1-255), r,g,b (składowe koloru 0-255).` |
| **Method** | `POST` |
| **URL** | `http://192.168.1.60/json/state` |
| **Send Body** | ON, Body Content Type: `JSON`, Specify Body: `Using JSON` |

**JSON body** (wyrażenie n8n — model wypełnia `$fromAI`):

```
={{ JSON.stringify({
  on:  $fromAI('on',  'true zeby wlaczyc, false zeby wylaczyc', 'boolean'),
  bri: $fromAI('bri', 'jasnosc 1-255, domyslnie 128',           'number'),
  seg: [{ col: [[
    $fromAI('r', 'skladowa czerwona 0-255', 'number'),
    $fromAI('g', 'skladowa zielona 0-255',  'number'),
    $fromAI('b', 'skladowa niebieska 0-255','number')
  ]]}]
}) }}
```

**Options → Timeout:** 3000 ms. ESP to mikrokontroler — jeśli nie odpowie
w 3 sekundy, to znaczy, że jest offline, a agent nie ma na co czekać.

---

## Uwagi z „twardych reguł" Twojej dokumentacji

- **Publish** po każdej zmianie w n8n — inaczej webhook dalej trzyma starą wersję.
- Kontekst dla małych modeli trzymaj w **User Message**, nie w System.
- Po przejściu na `qwen3:8b` (wariant A z §6) function-calling jest natywny
  i router intencji przestaje być potrzebny — to narzędzie zadziała bezpośrednio.
  Na `bielik-1.5b` wywołania narzędzi bywają nietrafione; wtedy zostaw router.

---

## Wariant przez MQTT (jeśli postawisz Mosquitto)

Prostszy i szybszy — jedna publikacja zamiast HTTP:

| Temat | Ładunek | Efekt |
|---|---|---|
| `wled/salon` | `ON` / `OFF` | włącz / wyłącz |
| `wled/salon` | `128` | jasność |
| `wled/salon/col` | `#FF9640` | kolor |
| `wled/salon/api` | `T=2` | dowolne polecenie starego API (tu: toggle) |

W WLED: **Config → Sync Interfaces → MQTT**, broker = IP malinki,
Device Topic = `wled/salon`.

W n8n użyj node'a **MQTT** zamiast HTTP Request. Zaleta: broker przyjmuje
publikację nawet gdy ESP chwilowo padło, a WLED nadrobi po powrocie —
przy HTTP dostajesz twardy timeout.
