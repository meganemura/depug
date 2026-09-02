export async function tag(label: string, delayMs: number): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return label;
}
