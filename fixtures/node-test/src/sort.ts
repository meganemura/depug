export function order(xs: number[]): number[] {
  const copy = [...xs];
  copy.sort((a, b) => a - b);
  return copy;
}
