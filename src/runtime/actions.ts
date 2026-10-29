import type { UiActionButtonConfig } from '../ui/types.js';
import type { DatabaseShape, IceboltClient } from './client.js';
import { IceboltQueryError } from './errors.js';

export interface ActionResult {
  action: UiActionButtonConfig['action'];
  /** Updated row (null for deleteRow or when the row vanished). */
  row: Record<string, unknown> | null;
  deleted: boolean;
}

/**
 * Execute a manifest-declared button against one row. The row is addressed
 * strictly by its primary key; values come from the compiled behavior, never
 * from the DOM.
 */
export function executeAction<DB extends DatabaseShape<DB>>(
  client: IceboltClient<DB>,
  action: UiActionButtonConfig,
  row: object,
  primaryKey: readonly string[],
): ActionResult {
  const fields = row as Readonly<Record<string, unknown>>;
  if (primaryKey.length === 0) throw new IceboltQueryError(`table '${action.table}' has no primary key`);
  const where: Record<string, unknown> = {};
  for (const k of primaryKey) {
    const v = fields[k];
    if (v === undefined || v === null) throw new IceboltQueryError(`row is missing primary key '${k}'`);
    where[k] = v;
  }
  const q = client.tableUnsafe(action.table).where(where);
  const b = action.behavior;

  if (b.type === 'delete') {
    return { action: action.action, row: null, deleted: q.delete() > 0 };
  }

  const target = action.target;
  if (target === null) throw new IceboltQueryError(`action '${action.id}' has no target column`);

  return client.transaction(() => {
    const current = q.first();
    if (!current) return { action: action.action, row: null, deleted: false };
    const value = current[target];
    let next: unknown;
    switch (b.type) {
      case 'toggle-boolean':
        next = !value;
        break;
      case 'cycle': {
        const i = b.values.findIndex((v) => v === value);
        next = b.values[(i + 1) % b.values.length];
        break;
      }
      case 'set':
        next = b.value;
        break;
      case 'increment':
        next = (typeof value === 'number' ? value : 0) + b.by;
        break;
    }
    const [updated] = q.update({ [target]: next });
    return { action: action.action, row: updated ?? null, deleted: false };
  });
}
