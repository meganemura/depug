export function heavyWork(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += Math.sqrt(i) * Math.sin(i);
  }
  return total;
}
