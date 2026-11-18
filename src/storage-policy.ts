export const retentionPolicy = {
  inactiveDays: 30,
  maximumStateBytes: 64 * 1024 * 1024,
  maximumArtifactBytes: 32 * 1024 * 1024,
  maximumExportBytes: 128 * 1024 * 1024,
  maximumScanFiles: 4096,
  maximumRemovalFiles: 128,
} as const;
