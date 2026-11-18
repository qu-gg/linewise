import { Linter } from 'eslint';
import { builtinRules } from 'eslint/use-at-your-own-risk';
import babelParser from '@babel/eslint-parser';
import { parse } from '@babel/parser';
import sonar from 'eslint-plugin-sonarjs';
import escomplex from 'typhonjs-escomplex-module';
import ts from 'typescript';

export const limits = Object.freeze({
  cyclomatic: 10,
  cognitive: 15,
  functionLines: 80,
  fileLines: 500,
  halsteadVolume: 30000,
  halsteadDifficulty: 150,
  halsteadEffort: 4000000,
  crap: 30,
});

export function crapScore(cyclomatic, coverage) {
  if (
    !Number.isFinite(cyclomatic) ||
    cyclomatic < 1 ||
    !Number.isFinite(coverage) ||
    coverage < 0 ||
    coverage > 100
  ) {
    throw new Error('Invalid CRAP inputs.');
  }
  return cyclomatic ** 2 * (1 - coverage / 100) ** 3 + cyclomatic;
}

function nodeName(node, fallback) {
  return String(node?.name ?? node?.value ?? fallback);
}

function functionLabel(node) {
  if (node.id) return nodeName(node.id, '<function>');
  const parent = node.parent ?? {};
  if (parent.type === 'VariableDeclarator') return nodeName(parent.id, '<binding>');
  if (parent.key) return nodeName(parent.key, '<computed>');
  if (parent.type === 'CallExpression')
    return `<${nodeName(parent.callee.property ?? parent.callee, 'call')} callback>`;
  return '<callback>';
}

function qualifiedName(node) {
  const names = [];
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
    if (/Function/.test(ancestor.type)) names.unshift(functionLabel(ancestor));
    else if (ancestor.type === 'ClassDeclaration') names.unshift(ancestor.id?.name ?? '<class>');
  }
  return names.join('.');
}

function contains(location, point) {
  const afterStart =
    point.line > location.start.line ||
    (point.line === location.start.line && point.column >= location.start.column);
  const beforeEnd =
    point.line < location.end.line ||
    (point.line === location.end.line && point.column <= location.end.column);
  return afterStart && beforeEnd;
}

function measureRule(rule, metric, reports) {
  return {
    meta: rule.meta,
    create(context) {
      const collector = Object.create(context, {
        report: {
          value: (descriptor) => {
            if (descriptor.data?.name?.includes('initializer')) return;
            const value = Number(descriptor.data?.complexity ?? descriptor.data?.complexityAmount);
            if (!Number.isFinite(value))
              throw new Error(`Unsupported ${metric} analyzer response.`);
            reports.push({ metric, value, location: descriptor.loc ?? descriptor.node.loc });
          },
        },
      });
      return rule.create(collector);
    },
  };
}

function assignReports(functions, reports) {
  for (const report of reports) {
    const matches = functions.filter((item) => contains(item.location, report.location.start));
    const target = matches.sort((left, right) => left.span - right.span)[0];
    if (!target) throw new Error(`Cannot attribute ${report.metric} to a function.`);
    target[report.metric] = report.value;
  }
  return functions.map(({ name, location, cyclomatic, cognitive }) => {
    if (!Number.isFinite(cyclomatic)) throw new Error(`Missing McCabe score for ${name}.`);
    return {
      name,
      line: location.start.line,
      column: location.start.column,
      endLine: location.end.line,
      endColumn: location.end.column,
      cyclomatic,
      cognitive,
      functionLines: location.end.line - location.start.line + 1,
    };
  });
}

function functionRecorder(functions) {
  const occurrences = new Map();
  return {
    create() {
      return {
        ':function'(node) {
          const label = qualifiedName(node);
          const occurrence = (occurrences.get(label) ?? 0) + 1;
          occurrences.set(label, occurrence);
          const declaration = [
            'MethodDefinition',
            'Property',
            'PropertyDefinition',
            'VariableDeclarator',
            'ExportNamedDeclaration',
          ].includes(node.parent?.type)
            ? node.parent
            : node;
          functions.push({
            name: `${label}#${occurrence}`,
            location: declaration.loc,
            span: declaration.range[1] - declaration.range[0],
            cognitive: 0,
          });
        },
      };
    },
  };
}

function analyzerConfig(file, functions, reports) {
  return [
    {
      files: ['**/*.{js,mjs,ts}'],
      languageOptions: {
        parser: babelParser,
        parserOptions: {
          requireConfigFile: false,
          babelOptions: { parserOpts: { plugins: file.endsWith('.ts') ? ['typescript'] : [] } },
        },
      },
      plugins: {
        metrics: {
          rules: {
            functions: functionRecorder(functions),
            cyclomatic: measureRule(builtinRules.get('complexity'), 'cyclomatic', reports),
            cognitive: measureRule(sonar.rules['cognitive-complexity'], 'cognitive', reports),
          },
        },
      },
      rules: {
        'metrics/functions': 'error',
        'metrics/cyclomatic': ['error', { max: 0, variant: 'classic' }],
        'metrics/cognitive': ['error', 0],
      },
    },
  ];
}

function halsteadMetrics(source, file) {
  const javascript = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2017,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
    },
  }).outputText;
  const report = escomplex.analyze(parse(javascript, { sourceType: 'module' }));
  if (report.errors.length) throw new Error(`${file}: Halstead analysis failed.`);
  const halstead = report.aggregate.halstead;
  const metrics = {
    fileLines: source.trimEnd().split('\n').length,
    halsteadVolume: halstead.volume,
    halsteadDifficulty: halstead.difficulty,
    halsteadEffort: halstead.effort,
  };
  if (Object.values(metrics).some((value) => !Number.isFinite(value)))
    throw new Error(`${file}: invalid file metrics.`);
  return metrics;
}

export function analyzeSource(source, file) {
  const functions = [];
  const reports = [];
  const diagnostics = new Linter().verify(source, analyzerConfig(file, functions, reports), {
    filename: file,
  });
  if (diagnostics.length)
    throw new Error(`${file}: ${diagnostics.map((item) => item.message).join('; ')}`);
  return { metrics: halsteadMetrics(source, file), functions: assignReports(functions, reports) };
}

function executedDefinition(current, coverage) {
  const location = {
    start: { line: current.line, column: current.column ?? 0 },
    end: { line: current.endLine, column: current.endColumn ?? Infinity },
  };
  const candidates = Object.entries(coverage.fnMap).filter(
    ([, item]) =>
      item.name !== '(empty-report)' &&
      item.loc.start.line === current.line &&
      contains(location, item.loc.start) &&
      contains(location, item.loc.end ?? item.loc.start),
  );
  candidates.sort((left, right) => left[1].loc.start.column - right[1].loc.start.column);
  return candidates.length > 0 && coverage.f[candidates[0][0]] > 0;
}

export function functionCoverage(current, coverage) {
  if (!coverage) throw new Error('Missing production coverage record.');
  if (!executedDefinition(current, coverage)) return 0;
  const lines = new Map();
  for (const [id, statement] of Object.entries(coverage.statementMap)) {
    const line = statement.start.line;
    if (line >= current.line && line <= current.endLine)
      lines.set(line, Math.max(lines.get(line) ?? 0, coverage.s[id]));
  }
  if (!lines.size) return 0;
  return ([...lines.values()].filter((count) => count > 0).length / lines.size) * 100;
}

function compareMetric(item, metric, value, exception, used) {
  const normal = limits[metric];
  if (normal === undefined || !Number.isFinite(value))
    throw new Error(`Unknown or invalid metric ${metric}.`);
  const override = exception ? exception.max[metric] : undefined;
  const allowed = override ?? normal;
  if (override !== undefined) used.add(`${item.id}:${metric}`);
  const failures = [];
  if (value > allowed)
    failures.push(`${item.id}: ${metric} ${value.toFixed(3)} exceeds ${allowed}`);
  if (override !== undefined && value <= normal)
    failures.push(`${item.id}: remove obsolete ${metric} exception`);
  return failures;
}

function validateException(id, metric, value, used) {
  if (!(metric in limits) || !Number.isFinite(value) || value <= limits[metric])
    throw new Error(`${id}: invalid ${metric} exception.`);
  return used.has(`${id}:${metric}`) ? [] : [`${id}: stale ${metric} exception`];
}

export function compareBudgets(items, baseline) {
  const used = new Set();
  const failures = items.flatMap((item) =>
    Object.entries(item.metrics).flatMap(([metric, value]) =>
      compareMetric(item, metric, value, baseline.exceptions[item.id], used),
    ),
  );
  for (const [id, exception] of Object.entries(baseline.exceptions)) {
    if (exception.reason.trim().length < 20)
      throw new Error(`${id}: a meaningful exception reason is required.`);
    for (const [metric, value] of Object.entries(exception.max)) {
      failures.push(...validateException(id, metric, value, used));
    }
  }
  return failures;
}

function assertNoRegression(items, baseline) {
  for (const item of items) {
    for (const [metric, value] of Object.entries(item.metrics)) {
      const maximum = baseline.exceptions[item.id]?.max[metric] ?? limits[metric];
      if (!Number.isFinite(value) || maximum === undefined || value > maximum) {
        throw new Error(`${item.id}: cannot tighten a regressed or invalid ${metric} metric.`);
      }
    }
  }
}

function tightenedException(item, exception) {
  if (!item) return undefined;
  const max = {};
  for (const [metric, ceiling] of Object.entries(exception.max)) {
    const value = item.metrics[metric];
    if (value > limits[metric]) max[metric] = Math.min(ceiling, Math.ceil(value * 1e6) / 1e6);
  }
  return Object.keys(max).length ? { ...exception, max } : undefined;
}

export function tightenBaseline(items, files, baseline) {
  assertNoRegression(items, baseline);
  const result = structuredClone(baseline);
  const measured = new Map(items.map((item) => [item.id, item]));
  result.exceptions = {};
  for (const [id, exception] of Object.entries(baseline.exceptions)) {
    const next = tightenedException(measured.get(id), exception);
    if (next) result.exceptions[id] = next;
  }
  result.coverageFloors = {};
  for (const file of files.filter((file) => file.lineCoverage !== undefined)) {
    const previous = baseline.coverageFloors[file.file] ?? {
      min: 80,
      reason: 'New production code requires at least eighty percent deterministic line coverage.',
    };
    if (!Number.isFinite(file.lineCoverage) || file.lineCoverage < previous.min)
      throw new Error(`${file.file}: cannot tighten regressed coverage.`);
    result.coverageFloors[file.file] = {
      ...previous,
      min: Math.max(previous.min, Math.floor(file.lineCoverage * 100) / 100),
    };
  }
  return result;
}
