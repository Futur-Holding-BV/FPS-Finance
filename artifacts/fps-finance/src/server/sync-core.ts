export type VersionedRecord = {
  sourceId: string;
  sourceVersion: string;
};

export type IdempotentApplyResult<T extends VersionedRecord> = {
  next: Map<string, T>;
  changed: number;
  skipped: number;
};

/**
 * Applies a one-way snapshot without ever overwriting a record with the same
 * or an older source version. The function is deliberately side-effect free
 * so adapters can be retried safely.
 */
export function applyIdempotentUpserts<T extends VersionedRecord>(
  existing: ReadonlyMap<string, T>,
  incoming: readonly T[],
): IdempotentApplyResult<T> {
  const next = new Map(existing);
  let changed = 0;
  let skipped = 0;

  for (const record of incoming) {
    const current = next.get(record.sourceId);
    if (current && current.sourceVersion >= record.sourceVersion) {
      skipped += 1;
      continue;
    }

    next.set(record.sourceId, record);
    changed += 1;
  }

  return { next, changed, skipped };
}