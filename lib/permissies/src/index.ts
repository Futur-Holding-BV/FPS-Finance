export const financePermissions = [
  "finance.view",
  "finance.identities.manage",
  "finance.administrations.view",
  "finance.sync.run",
  "finance.invoices.view",
  "finance.invoices.import",
  "finance.audit.view",
  "finance.journal.post",
] as const;

export type FinancePermission = (typeof financePermissions)[number];

export const financeRolePermissions = {
  finance_reader: ["finance.view", "finance.administrations.view", "finance.invoices.view"],
  finance_accountant: [
    "finance.view",
    "finance.administrations.view",
    "finance.audit.view",
    "finance.invoices.view",
    "finance.journal.post",
  ],
  finance_bookkeeper: [
    "finance.view",
    "finance.administrations.view",
    "finance.invoices.view",
    "finance.journal.post",
  ],
  finance_period_closer: [
    "finance.view",
    "finance.administrations.view",
    "finance.invoices.view",
  ],
  finance_payments: [
    "finance.view",
    "finance.administrations.view",
    "finance.invoices.view",
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

const financeStrongSecondFactorPermissions = new Set<FinancePermission>([
  "finance.journal.post",
  "finance.invoices.import",
]);

export function requiresFinanceSecondFactor(permissions: readonly string[]): boolean {
  return permissions.some((permission) => (
    financeStrongSecondFactorPermissions.has(permission as FinancePermission)
  ));
}