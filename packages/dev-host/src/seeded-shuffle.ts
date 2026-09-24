// Preserve the reducer manifest bootstrap seed algorithm so identical seeds
// materialize identical initial tables across compiler and gameplay execution.
export function seededShuffle(seed: number | null) {
  const random = seededRandom(seed ?? 0);
  return <Value>(values: readonly Value[]): Value[] => {
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [
        shuffled[swapIndex] as Value,
        shuffled[index] as Value,
      ];
    }
    return shuffled;
  };
}

function seededRandom(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
