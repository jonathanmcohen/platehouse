// How the Activity page writes its numbers. The size and duration follow the
// same style as the Files tab (model/FilesTab.tsx formatSize) and the
// library card (library/ModelCard.tsx formatDuration); they are written out
// here rather than imported, so this page does not depend on those modules
// while they change under other work.

/** A count with the browser's own digit grouping: 1,200. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** A size: 684 B, 120.6 KB, 89.4 MB, 4.5 GB (powers of 1000, as the Files tab). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Number((bytes / 1000).toFixed(1))} KB`;
  if (bytes < 1_000_000_000) return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
  if (bytes < 1_000_000_000_000) return `${Number((bytes / 1_000_000_000).toFixed(2))} GB`;
  return `${Number((bytes / 1_000_000_000_000).toFixed(2))} TB`;
}

/** A rough time left: 50m, 1h 25m, 2d 3h. Never less than 1m. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** A rate: 2, 0.5, 12.25. */
export function formatRate(perMinute: number): string {
  return String(Number(perMinute.toFixed(2)));
}
