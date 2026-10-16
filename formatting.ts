const TIMESINCE_CHUNKS: ReadonlyArray<
  readonly [string, number, number | null]
> = [
  ["second", 1, 60],
  ["minute", 60, 60],
  ["hour", 60 * 60, 24],
  ["day", 60 * 60 * 24, 6],
  ["week", 60 * 60 * 24 * 7, 6],
  ["month", 60 * 60 * 24 * 30, 11],
  ["year", 60 * 60 * 24 * 365, null],
];

function pyRound(x: number): number {
  const floor = Math.floor(x);
  if (x === floor + 0.5) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(x);
}

function timeSinceChunk(delta: number): { value: number; label: string } {
  let value = 0;
  let label = "";
  for (const [chunkLabel, divider, maxValue] of TIMESINCE_CHUNKS) {
    value = pyRound(delta / divider);
    label = chunkLabel;
    if (maxValue !== null && value <= maxValue) break;
  }
  return { value, label };
}

export function formatTimeSince(ts: number): string {
  const delta = Date.now() / 1000 - ts;
  if (delta < 20) {
    return "a few seconds ago";
  }
  const { value, label } = timeSinceChunk(delta);
  return `${value} ${label}${value > 1 ? "s" : ""} ago`;
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatSize(sizeBytes: number): string {
  const sizeGb = sizeBytes / 1024 ** 3;
  if (sizeGb >= 1) {
    return `${sizeGb.toFixed(2)} GB`;
  }
  const sizeMb = sizeBytes / 1024 ** 2;
  return `${sizeMb.toFixed(2)} MB`;
}
