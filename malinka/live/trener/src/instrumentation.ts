// Next.js wywołuje register() raz przy starcie serwera — tu startuje harmonogram synchronizacji i planów
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.TRENER_SCHEDULER === "off") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
