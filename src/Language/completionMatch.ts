/** Prefer contiguous matches, then accept characters in order (rdcsv -> read.csv).
 * Offsets use UTF-16, as do completion edit ranges and terminal input snapshots. */
export function completionMatch(label: string, query: string): number[] | undefined {
  const text = label.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return [];
  const start = text.indexOf(needle);
  const positions: number[] = [];
  if (start >= 0) {
    for (let i = 0; i < needle.length; i++) positions.push(start + i);
  } else {
    let offset = 0;
    for (const character of needle) {
      const index = text.indexOf(character, offset);
      if (index < 0) return undefined;
      for (let i = 0; i < character.length; i++) positions.push(index + i);
      offset = index + character.length;
    }
  }
  if (text.length === label.length) return positions;
  // Case conversion can expand a character (İ -> i + combining dot). Map
  // matches back to the original label rather than highlighting shifted text.
  const offsets: number[][] = [];
  let offset = 0;
  for (const character of label) {
    const units = Array.from({ length: character.length }, (_, i) => offset + i);
    for (let i = 0; i < character.toLowerCase().length; i++) offsets.push(units);
    offset += character.length;
  }
  return [...new Set(positions.flatMap(position => offsets[position]))];
}
