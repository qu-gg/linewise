export const TaskScope = { Global: 1, Workspace: 2 };

export const DiagnosticSeverity = {
  0: 'Error',
  1: 'Warning',
  2: 'Information',
  3: 'Hint',
  Error: 0,
  Warning: 1,
};

export class Diagnostic {
  source?: string;
  constructor(
    readonly range: unknown,
    readonly message: string,
    readonly severity = 0,
  ) {}
}

class DiagnosticCollection {
  entries: readonly [unknown, Diagnostic[]][] = [];
  disposed = false;
  clear() {
    this.entries = [];
  }
  set(entries: readonly [unknown, Diagnostic[]][]) {
    this.entries = entries;
  }
  dispose() {
    this.disposed = true;
    this.clear();
  }
}

export const taskDiagnosticCollections: DiagnosticCollection[] = [];
export function createDiagnosticCollection() {
  const collection = new DiagnosticCollection();
  taskDiagnosticCollections.push(collection);
  return collection;
}

export class ProcessExecution {
  constructor(
    public process = '',
    public args: string[] = [],
    public options?: { cwd?: string; env?: Record<string, string> },
  ) {}
}

export class ShellExecution {
  commandLine?: string;
  command?: string;
  constructor(
    command = '',
    public args?: unknown[],
    public options?: {
      cwd?: string;
      env?: Record<string, string>;
      executable?: string;
      shellArgs?: string[];
    },
  ) {
    if (args === undefined) this.commandLine = command;
    else this.command = command;
  }
}

export class EventEmitter<Value> {
  private readonly listeners = new Set<(value: Value) => void>();
  readonly event = (listener: (value: Value) => void) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };
  fire(value: Value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

export interface TaskPty {
  open(): void;
  close(): void;
  onDidWrite(listener: (text: string) => void): unknown;
  onDidClose(listener: (code: number) => void): unknown;
}

export class CustomExecution {
  constructor(readonly callback: (definition: object) => Promise<TaskPty>) {}
}

export class Task {
  isBackground = false;
  constructor(
    readonly definition: object,
    public scope: unknown,
    readonly name: string,
    readonly source: string,
    public execution?: unknown,
    readonly problemMatchers: string[] = [],
  ) {}
}
