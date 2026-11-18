import path from 'node:path';

export class Uri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = '',
  ) {}
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`;
  }
  static file(target: string) {
    return new Uri('file', '', target);
  }
  static parse(target: string) {
    const parsed = new URL(target);
    return new Uri(
      parsed.protocol.slice(0, -1),
      parsed.host,
      parsed.pathname,
      parsed.search.slice(1),
    );
  }
  static from(value: { scheme: string; authority?: string; path: string; query?: string }) {
    return new Uri(value.scheme, value.authority ?? '', value.path, value.query);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...parts));
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
export class FileSystemError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
type Edit = {
  type: 'create' | 'delete' | 'replace' | 'rename';
  uri: Uri;
  content?: string;
  destination?: Uri;
};
export class WorkspaceEdit {
  readonly edits: Edit[] = [];
  createFile(uri: Uri) {
    this.edits.push({ type: 'create', uri });
  }
  deleteFile(uri: Uri) {
    this.edits.push({ type: 'delete', uri });
  }
  renameFile(uri: Uri, destination: Uri) {
    this.edits.push({ type: 'rename', uri, destination });
  }
  replace(uri: Uri, _range: Range, content: string) {
    this.edits.push({ type: 'replace', uri, content });
  }
}

export class Document {
  isDirty = true;
  constructor(
    public uri: Uri,
    public text: string,
  ) {}
  getText(range?: Range) {
    if (!range) return this.text;
    const offset = (position: Position) =>
      this.text
        .split('\n')
        .slice(0, position.line)
        .reduce((total, line) => total + line.length + 1, 0) + position.character;
    return this.text.slice(offset(range.start), offset(range.end));
  }
  positionAt(offset: number) {
    const lines = this.text.slice(0, offset).split('\n');
    return new Position(lines.length - 1, lines.at(-1)!.length);
  }
  async save() {
    if (!fixture.saveAllowed) return false;
    fixture.disk.set(this.uri.path, {
      bytes: new TextEncoder().encode(this.text),
      type: FileType.File,
    });
    this.isDirty = false;
    return true;
  }
}

export const fixture = {
  disk: new Map<string, { bytes: Uint8Array; type: number; size?: number }>(),
  documents: [] as Document[],
  configuration: new Map<string, unknown>(),
  applyAllowed: true,
  saveAllowed: true,
  fileError: undefined as Error | undefined,
  roots: [] as { uri: Uri; name: string; index: number }[],
  trusted: true,
  editor: undefined as
    | { document: Document; selection: { isEmpty: boolean; start?: Position; end?: Position } }
    | undefined,
  provider: undefined as { resolveWebviewView(resolved: typeof view): void } | undefined,
  commands: new Map<string, () => unknown>(),
  contentProviders: new Map<
    string,
    { provideTextDocumentContent(uri: Uri): string | Promise<string> }
  >(),
  commandCalls: [] as { id: string; args: unknown[] }[],
  messages: [] as unknown[],
  logs: [] as string[],
  clipboard: '',
  outputShown: false,
  approval: undefined as string | undefined,
  quickPick: undefined as string | undefined,
  openFiles: [] as Uri[],
  saveFile: undefined as Uri | undefined,
  resourcePicks: [] as string[],
  diagnostics: [] as [Uri, { message: string; severity: number; range: Range }[]][],
  warnings: [] as { message: string; detail?: string; choices: string[] }[],
  onWarning: undefined as (() => Promise<string | undefined>) | undefined,
  listeners: [] as (() => void)[],
  messageListener: undefined as ((message: unknown) => void) | undefined,
  viewDisposed: undefined as (() => void) | undefined,
  delivery: true as boolean | 'reject',
};

export function reset() {
  fixture.disk.clear();
  fixture.documents.length = 0;
  fixture.configuration.clear();
  fixture.applyAllowed = true;
  fixture.saveAllowed = true;
  fixture.fileError = undefined;
  fixture.roots = [];
  fixture.trusted = true;
  fixture.editor = undefined;
  fixture.provider = undefined;
  fixture.commands.clear();
  fixture.contentProviders.clear();
  fixture.commandCalls.length = 0;
  fixture.messages.length = 0;
  fixture.logs.length = 0;
  fixture.clipboard = '';
  fixture.outputShown = false;
  fixture.approval = undefined;
  fixture.quickPick = undefined;
  fixture.openFiles = [];
  fixture.saveFile = undefined;
  fixture.resourcePicks = [];
  fixture.diagnostics = [];
  fixture.warnings.length = 0;
  fixture.onWarning = undefined;
  fixture.listeners.length = 0;
  fixture.messageListener = undefined;
  fixture.viewDisposed = undefined;
  fixture.delivery = true;
}

export function seedFile(target: string, text: string | Uint8Array, type = FileType.File) {
  fixture.disk.set(target, {
    bytes: typeof text === 'string' ? new TextEncoder().encode(text) : text,
    type,
  });
}

function existing(uri: Uri) {
  if (fixture.fileError) throw fixture.fileError;
  const file = fixture.disk.get(uri.path);
  if (!file) throw new FileSystemError('FileNotFound');
  return file;
}

export const workspace = {
  get workspaceFolders() {
    return fixture.roots;
  },
  get isTrusted() {
    return fixture.trusted;
  },
  getWorkspaceFolder: (uri: Uri) =>
    fixture.roots.find((root) => uri.path.startsWith(root.uri.path + '/')),
  asRelativePath: (uri: Uri) => path.relative(fixture.roots[0]!.uri.path, uri.path),
  registerTextDocumentContentProvider: (
    scheme: string,
    provider: { provideTextDocumentContent(uri: Uri): string | Promise<string> },
  ) => {
    fixture.contentProviders.set(scheme, provider);
    return {
      dispose() {
        fixture.contentProviders.delete(scheme);
      },
    };
  },
  onDidChangeTextDocument: (listener: () => void) => {
    fixture.listeners.push(listener);
    return disposable();
  },
  createFileSystemWatcher: () => ({
    dispose() {},
    onDidChange: () => disposable(),
    onDidCreate: () => disposable(),
    onDidDelete: () => disposable(),
  }),
  get textDocuments() {
    return fixture.documents;
  },
  fs: {
    stat: async (uri: Uri) => {
      const file = existing(uri);
      return { type: file.type, size: file.size ?? file.bytes.length };
    },
    readFile: async (uri: Uri) => existing(uri).bytes,
  },
  getConfiguration: (section: string) => ({
    get: (name: string, fallback?: unknown) =>
      fixture.configuration.get(`${section}.${name}`) ?? fallback,
    inspect: (name: string) => ({ globalValue: fixture.configuration.get(`${section}.${name}`) }),
  }),
  openTextDocument: async (input: Uri | { content: string; language?: string }) => {
    if (!(input instanceof Uri)) {
      const document = new Document(
        Uri.parse(`untitled:///snapshot-${fixture.documents.length}.txt`),
        input.content,
      );
      fixture.documents.push(document);
      return document;
    }
    const uri = input;
    const found = fixture.documents.find((document) => document.uri.toString() === uri.toString());
    if (found) return found;
    const provider = fixture.contentProviders.get(uri.scheme);
    const text = provider
      ? await provider.provideTextDocumentContent(uri)
      : new TextDecoder().decode(existing(uri).bytes);
    const document = new Document(uri, text);
    fixture.documents.push(document);
    return document;
  },
  applyEdit: async (edit: WorkspaceEdit) => {
    if (!fixture.applyAllowed) return false;
    for (const change of edit.edits) {
      if (change.type === 'rename') {
        renameFixtureFile(change.uri, change.destination!);
        continue;
      }
      if (change.type === 'delete') {
        fixture.disk.delete(change.uri.path);
        continue;
      }
      if (change.type === 'create') seedFile(change.uri.path, '');
      else (await workspace.openTextDocument(change.uri)).text = change.content!;
    }
    return true;
  },
};

function renameFixtureFile(source: Uri, destination: Uri): void {
  if (fixture.disk.has(destination.path)) throw new Error('Destination exists.');
  fixture.disk.set(destination.path, existing(source));
  fixture.disk.delete(source.path);
  for (const document of fixture.documents)
    if (document.uri.toString() === source.toString()) document.uri = destination;
}

const disposable = () => ({ dispose() {} });
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}
export const env = {
  remoteName: undefined,
  clipboard: {
    writeText: async (text: string) => {
      fixture.clipboard = text;
    },
  },
  openExternal: async (uri: Uri) => {
    fixture.commandCalls.push({ id: 'external', args: [uri] });
    return true;
  },
};
export const DiagnosticSeverity = { 0: 'Error', 1: 'Warning', 2: 'Information', 3: 'Hint' };
export const languages = { getDiagnostics: () => fixture.diagnostics };
export const window = {
  get activeTextEditor() {
    return fixture.editor;
  },
  createOutputChannel: () => ({
    appendLine: (text: string) => fixture.logs.push(text),
    append: (text: string) => fixture.logs.push(text),
    show: () => {
      fixture.outputShown = true;
    },
    dispose() {},
  }),
  registerWebviewViewProvider: (_id: string, provider: NonNullable<typeof fixture.provider>) => {
    fixture.provider = provider;
    return disposable();
  },
  showWarningMessage: async (
    message: string,
    options: { detail?: string },
    ...choices: string[]
  ) => {
    fixture.warnings.push({ message, detail: options.detail, choices });
    return fixture.onWarning ? fixture.onWarning() : fixture.approval;
  },
  showInformationMessage: async () => undefined,
  showQuickPick: async (
    items: { value?: string; label?: string }[],
    options?: { canPickMany?: boolean },
  ) =>
    options?.canPickMany
      ? items.filter((item) => fixture.resourcePicks.includes(item.label ?? ''))
      : items.find((item) => item.value === fixture.quickPick),
  showOpenDialog: async () => fixture.openFiles,
  showSaveDialog: async () => fixture.saveFile,
  showTextDocument: async () => undefined,
};
export const commands = {
  registerCommand: (id: string, callback: () => unknown) => {
    fixture.commands.set(id, callback);
    return disposable();
  },
  executeCommand: async (id: string, ...args: unknown[]) => {
    fixture.commandCalls.push({ id, args });
    return fixture.commands.get(id)?.();
  },
};
export const view = {
  onDidDispose: (listener: () => void) => {
    fixture.viewDisposed = listener;
    return disposable();
  },
  webview: {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: Uri) => uri,
    postMessage: async (message: unknown) => {
      fixture.messages.push(message);
      if (fixture.delivery === 'reject') throw new Error('View unavailable');
      return fixture.delivery;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      fixture.messageListener = listener;
      return disposable();
    },
  },
};
