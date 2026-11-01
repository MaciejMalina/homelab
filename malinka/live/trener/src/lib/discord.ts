// Powiadomienia przez webhook Discorda (ten sam kanał co reszta JARVIS-a)

export const COLOR = { ok: 3066993, info: 3447003, plan: 10181046, warn: 15105570, err: 15158332 };

interface Embed {
  title: string;
  description: string;
  color?: number;
  path?: string; // ścieżka w appce, np. /aktywnosci/i123
  fields?: { name: string; value: string; inline?: boolean }[];
}

export async function notify(e: Embed, mention = false) {
  const hook = process.env.DISCORD_WEBHOOK?.trim();
  if (!hook) return;
  const base = process.env.APP_URL?.trim().replace(/\/$/, "");
  const user = process.env.DISCORD_USER_ID?.trim();
  const payload = {
    username: "JARVIS • Trener",
    content: mention && user ? `<@${user}>` : undefined,
    allowed_mentions: mention && user ? { users: [user] } : { parse: [] },
    embeds: [
      {
        title: e.title.slice(0, 250),
        description: e.description.slice(0, 4000),
        color: e.color ?? COLOR.info,
        url: base && e.path ? base + e.path : undefined,
        fields: e.fields?.slice(0, 10).map((f) => ({ ...f, value: f.value.slice(0, 1020) })),
        footer: { text: "JARVIS • trener" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) console.error("[discord]", r.status, (await r.text()).slice(0, 200));
  } catch (err) {
    console.error("[discord]", err);
  }
}
