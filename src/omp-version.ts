export const OMP_TESTED_VERSION = '19.2.1';
export const OMP_MINIMUM_VERSION = '19.2.1';
export const OMP_MAJOR = 19;
export const VSCODE_TESTED_VERSION = '1.147.0';

type Semver = readonly [number, number, number];

const semverPattern = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/;

function parseVersion(value: string): Semver | undefined {
  const match = semverPattern.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: Semver, right: Semver): number {
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!;
    if (difference) return difference;
  }
  return 0;
}

export function parseOmpVersion(output: string): string | undefined {
  return parseVersion(output)?.join('.');
}

export function supportsOmpVersion(output: string): boolean {
  const version = parseVersion(output);
  const minimum = parseVersion(OMP_MINIMUM_VERSION);
  return !!version && !!minimum && version[0] === OMP_MAJOR && compare(version, minimum) >= 0;
}

export function ompVersionRequirement(): string {
  return `OMP ${OMP_MINIMUM_VERSION} or newer ${OMP_MAJOR}.x`;
}
