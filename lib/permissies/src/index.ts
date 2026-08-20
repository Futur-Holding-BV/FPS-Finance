export const financePermissions = [
  "finance.view",
  "finance.identities.manage",
  "finance.administrations.view",
  "finance.sync.run",
  "finance.audit.view",
  "finance.journal.post",
  "finance.period.close",
  "finance.payments.execute",
] as const;

export type FinancePermission = (typeof financePermissions)[number];

export const financeRolePermissions = {
  finance_reader: ["finance.view", "finance.administrations.view"],
  finance_bookkeeper: [
    "finance.view",
    "finance.administrations.view",
    "finance.journal.post",
  ],
  finance_period_closer: [
    "finance.view",
    "finance.administrations.view",
    "finance.period.close",
  ],
  finance_payments: [
    "finance.view",
    "finance.administrations.view",
    "finance.payments.execute",
  ],
  finance_admin: [...financePermissions],
} as const satisfies Record<string, readonly FinancePermission[]>;

export type FinanceRole = keyof typeof financeRolePermissions;

export function permissionsForRoles(roles: readonly string[]): FinancePermission[] {
  return [...new Set(roles.flatMap((role) => financeRolePermissions[role as FinanceRole] ?? []))];
}

export function hasFinancePermission(
  permissions: readonly string[],
  permission: FinancePermission,
): boolean {
  return permissions.includes(permission);
}