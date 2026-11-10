export function isUpgradeRecommended(computer: {
  daemon_version?: string;
  recommended_version?: string;
}): boolean {
  if (!computer.recommended_version) return false;
  if (!computer.daemon_version) return true;
  const current = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(
    computer.daemon_version,
  );
  const recommended = /^(\d+)\.(\d+)\.(\d+)$/.exec(
    computer.recommended_version,
  );
  if (!current || !recommended) return false;
  for (const index of [1, 2, 3]) {
    if (Number(current[index]) !== Number(recommended[index])) {
      return Number(current[index]) < Number(recommended[index]);
    }
  }
  return Boolean(current[4]);
}
