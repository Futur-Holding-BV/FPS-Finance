export const FINANCE_ACCOUNTANT_ROLE = "finance_accountant";
export const HERBERT_FINANCE_EMAIL = "herbert@krudersweda.nl";

export function normalizeFinanceEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function rolesForManagedSyncedIdentity(email: string): string[] | null {
  return normalizeFinanceEmail(email) === HERBERT_FINANCE_EMAIL
    ? [FINANCE_ACCOUNTANT_ROLE]
    : null;
}

export function applyManagedSyncedRolePolicy(
  previousEmail: string | null,
  incomingEmail: string,
  existingRoles: readonly string[],
): string[] {
  const managedRoles = rolesForManagedSyncedIdentity(incomingEmail);
  if (managedRoles) return managedRoles;

  if (previousEmail && normalizeFinanceEmail(previousEmail) === HERBERT_FINANCE_EMAIL) {
    return existingRoles.filter((role) => role !== FINANCE_ACCOUNTANT_ROLE);
  }

  return [...existingRoles];
}

export function haveSameRoles(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightRoles = new Set(right);
  return left.every((role) => rightRoles.has(role));
}