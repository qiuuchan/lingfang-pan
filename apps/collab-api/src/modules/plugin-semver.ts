const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type ParsedSemVer = {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
};

export function parseStrictSemVer(version: string): ParsedSemVer | null {
  const match = STRICT_SEMVER.exec(version);
  if (!match) return null;
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

export function compareStrictSemVer(left: string, right: string): number {
  const a = parseStrictSemVer(left);
  const b = parseStrictSemVer(right);
  if (!a || !b) throw new Error('compareStrictSemVer requires strict SemVer values');
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! < b.core[index]!) return -1;
    if (a.core[index]! > b.core[index]!) return 1;
  }
  if (a.prerelease === null) return b.prerelease === null ? 0 : 1;
  if (b.prerelease === null) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aId = a.prerelease[index];
    const bId = b.prerelease[index];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    if (aId === bId) continue;
    const aNumeric = /^\d+$/.test(aId);
    const bNumeric = /^\d+$/.test(bId);
    if (aNumeric && bNumeric) return BigInt(aId) < BigInt(bId) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aId < bId ? -1 : 1;
  }
  return 0;
}
