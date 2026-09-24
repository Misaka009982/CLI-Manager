export function pairingRefreshDelay(
  pairingCode: string | null | undefined,
  expiresAt: number | null | undefined,
  now: number,
): number | null {
  if (!pairingCode || !Number.isFinite(expiresAt)) return null;
  return Math.max(0, Number(expiresAt) - now + 50);
}
