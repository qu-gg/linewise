export const nativePlans = [
  { name: 'update', operations: ['PUT 1.=1:\n+after'], after: 'after\n' },
  {
    name: 'range',
    before: 'one\ntwo\nthree\n',
    operations: ['PUT 1.=2:\n+replaced'],
    after: 'replaced\nthree\n',
  },
  { name: 'insert', operations: ['PUT <1:\n+head\nPUT >$:\n+tail'], after: 'head\nbefore\ntail\n' },
  {
    name: 'register',
    before: 'one\ntwo\n',
    operations: ['CUT 1.=1 @saved\nPUT >2 @saved'],
    after: 'two\none\n',
  },
  {
    name: 'anonymous',
    before: 'one\ntwo\n',
    operations: ['CUT 1.=1\nPUT >2'],
    after: 'two\none\n',
  },
  {
    name: 'persistent',
    before: 'one\ntwo\n',
    operations: ['CUT 1.=1 @saved', 'PUT >$ @saved'],
    after: 'two\none\n',
  },
  {
    name: 'block',
    before: 'function example() {\n  return 1;\n}\n',
    operations: ['PUT 1*:\n+function example() {\n+  return 2;\n+}'],
    after: 'function example() {\n  return 2;\n}\n',
    source: 'probe.ts',
  },
  {
    name: 'blockcut',
    before: 'function example() {\n  return 1;\n}\nconst tail = true;\n',
    operations: ['CUT 1*'],
    after: 'const tail = true;\n',
    source: 'probe.ts',
  },
  { name: 'delete', operations: ['REM'], after: null },
  {
    name: 'move',
    operations: ['MV moved.txt'],
    after: null,
    destination: 'moved.txt',
    moved: 'before\n',
  },
  {
    name: 'editedmove',
    operations: ['PUT 1.=1:\n+changed\nMV "moved space.txt"'],
    after: null,
    destination: 'moved space.txt',
    moved: 'changed\n',
  },
  { name: 'multi', operations: ['PUT 1.=1:\n+after'], after: 'after\n', second: true },
  { name: 'stale', operations: ['PUT 1.=1:\n+after'], tag: '0000', error: true, after: 'before\n' },
  { name: 'malformed', operations: ['NOT_AN_OPERATION'], error: true, after: 'before\n' },
  {
    name: 'private',
    operations: ['REM'],
    header: 'private/secret.txt#ABCD',
    error: true,
    after: 'before\n',
  },
];

export function nativeInput(plan, replies, operation) {
  const targets = plan.second
    ? [plan.source ?? 'probe.txt', 'second.txt']
    : [plan.source ?? 'probe.txt'];
  return targets
    .map((target, index) => {
      const text = JSON.stringify(replies[index].content);
      const tag = text.match(/#([a-fA-F0-9]{4})/);
      if (!tag) throw new Error(`Native read did not return a hashline tag: ${text}`);
      return `[${plan.header ?? `${target}#${plan.tag ?? tag[1]}`}]\n${operation}`;
    })
    .join('\n');
}
