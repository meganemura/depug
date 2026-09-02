// Two functions, both named (not anonymous): `checkpoint` is what proves
// interleaving actually reaches the fid assignment, not just `worker`'s
// own entry order (fixed by the synchronous call order Promise.all makes
// regardless of interleaving). `worker`'s hop count decides how many
// microtask ticks it waits through before calling `checkpoint`, so two
// concurrent `worker` calls with a different hop count resume, and reach
// `checkpoint`, in an order that depends on that difference rather than
// on which one Promise.all called first.
export async function checkpoint(label: string): Promise<string> {
  return label;
}

export async function worker(label: string, hops: number): Promise<string> {
  for (let i = 0; i < hops; i++) {
    await Promise.resolve();
  }
  const result = await checkpoint(label);
  return result;
}
