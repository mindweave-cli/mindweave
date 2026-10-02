/**
 * toolBatches.ts — how the tool calls of ONE model step are scheduled.
 *
 * A model can ask for several calls in a single step, and the order it wrote them in is part
 * of what it asked for: "write the file, then read it back" means the read sees the write.
 * Read-only calls can safely overlap each other, so running them together is a real saving,
 * but only with the calls NEXT to them. Running every read-only call of the step first and the
 * rest afterwards (which is what this did before) hands the model the old content of a file
 * it has just changed, and it carries on believing it.
 *
 * So a step is split into batches that keep the model's order: a run of consecutive
 * concurrency-safe calls is one parallel batch, and every other call is a batch of its own.
 * Results are returned in call order whichever way each batch ran.
 *
 * A cap on how many run at once keeps a model that fans out thirty sub-agents or fifty reads
 * from starting all of them in the same instant: file handles, child processes and the
 * provider's own rate limits are shared.
 */

/** Calls started at the same time within a parallel batch. */
export const MAX_PARALLEL_CALLS = 10;

export interface Batch<T> {
  /** True for a run of calls that may overlap; false for a single call that runs alone. */
  parallel: boolean;
  calls: T[];
}

/** Split a step's calls into batches that keep their order (pure). */
export function partitionCalls<T>(calls: readonly T[], isSafe: (call: T) => boolean): Batch<T>[] {
  const batches: Batch<T>[] = [];
  for (const call of calls) {
    const last = batches[batches.length - 1];
    if (isSafe(call) && last?.parallel) last.calls.push(call);
    else batches.push({ parallel: isSafe(call), calls: [call] });
  }
  return batches;
}

/**
 * Run `fn` over `items`, at most `limit` at a time, returning results in the order of `items`
 * (not the order they finished). A rejection stops new starts and rejects, like Promise.all.
 */
export async function runLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
