/**
 * Fail-closed release gate: the Jupiter response has not been independently
 * validated against the requested trade and may contain unrelated instructions.
 * No environment variable or runtime option can bypass this gate.
 */
export function assertLiveExecutionAvailable(): void {
  throw new Error('Exécution réelle désactivée : transaction Jupiter non validée indépendamment.');
}
