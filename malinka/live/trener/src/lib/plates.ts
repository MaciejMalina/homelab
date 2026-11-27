// Kalkulator talerzy: co założyć na każdą stronę gryfu (czyste funkcje — test w plates.test.ts)

export const DOSTEPNE = [25, 20, 15, 10, 5, 2.5, 1.25];

export function platesFor(total: number, bar = 20, available: number[] = DOSTEPNE) {
  const side = Math.max(0, (total - bar) / 2);
  let left = Math.round(side * 1000) / 1000;
  const plates: number[] = [];
  for (const p of [...available].sort((a, b) => b - a)) {
    while (left + 1e-9 >= p) {
      plates.push(p);
      left = Math.round((left - p) * 1000) / 1000;
    }
  }
  // left > 0 -> ciężaru nie da się złożyć dokładnie z dostępnych talerzy
  return { side, plates, rest: left, real: bar + 2 * plates.reduce((n, p) => n + p, 0) };
}
