export function retainAnonymousFunctions(report, roots) {
  for (const script of report.result ?? []) {
    if (!roots.some((root) => script.url.startsWith(root))) continue;
    for (const current of script.functions.slice(1)) {
      if (current.functionName === '') current.functionName = '<anonymous>';
    }
  }
  return report;
}
