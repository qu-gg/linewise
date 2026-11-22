import ignore from 'ignore';
import path from 'node:path';

type ReadRule = (relative: string) => Promise<string | undefined>;

export class ProjectIgnores {
  private readonly rules = new Map<string, ReturnType<typeof ignore>>();
  private readonly observed = new Map<string, string | undefined>();
  private bytes = 0;

  constructor(
    private readonly read: ReadRule,
    private readonly signal: AbortSignal,
  ) {}

  private async rule(directory: string) {
    const cached = this.rules.get(directory);
    if (cached) return cached;
    if (this.rules.size >= 256) throw new Error('Project ignores exceed 256 scoped directories.');
    const matcher = ignore();
    for (const name of ['.gitignore', '.ignore']) {
      this.signal.throwIfAborted();
      const relative = path.posix.join(directory, name);
      const text = await this.read(relative);
      this.signal.throwIfAborted();
      const size = Buffer.byteLength(text ?? '');
      this.bytes += size;
      if (size > 65536 || this.bytes > 1_048_576)
        throw new Error('Project ignores exceed bounded text limits.');
      this.observed.set(relative, text);
      if (text) matcher.add(text);
    }
    this.rules.set(directory, matcher);
    return matcher;
  }

  async accepts(relative: string) {
    this.signal.throwIfAborted();
    const parts = relative.split('/');
    if (path.posix.isAbsolute(relative) || parts.includes('..') || parts.length > 64)
      throw new Error('Project ignore target is outside its bounded root scope.');
    let ignored = false;
    for (let depth = 0; depth < parts.length; depth++) {
      const matcher = await this.rule(parts.slice(0, depth).join('/'));
      const local = parts.slice(depth);
      for (let parent = 1; parent < local.length; parent++)
        if (matcher.ignores(`${local.slice(0, parent).join('/')}/`)) return false;
      const result = matcher.test(local.join('/'));
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return !ignored;
  }

  async fresh() {
    for (const [relative, text] of this.observed) {
      this.signal.throwIfAborted();
      if ((await this.read(relative)) !== text) return false;
    }
    this.signal.throwIfAborted();
    return true;
  }

  get inspectedFiles() {
    return this.observed.size;
  }
}
