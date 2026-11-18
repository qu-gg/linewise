import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = {
  connected: true,
  busy: true,
  cancellable: true,
  connecting: false,
  host: 'Local',
  workspace: 'vs-omp',
  session: 'Refine the chat window',
  sessionId: 'preview-original',
  canHistory: true,
  context: { used: 94700, size: 400000, cost: { amount: 0.18, currency: 'USD' } },
  canCompact: true,
  canInspectContext: true,
  attachments: [
    {
      id: 'preview-selection',
      kind: 'selection',
      label: 'main.js:12-36',
      uri: 'file:///workspace/media/main.js',
    },
    {
      id: 'preview-problems',
      kind: 'diagnostics',
      label: 'Problems (2/2)',
      uri: 'file:///workspace',
    },
  ],
  queued: [
    { id: 'preview-follow-up', text: 'Check the narrow sidebar once the layout is updated.' },
  ],
  queuePaused: false,
  approval: {
    id: 'preview-approval',
    kind: 'command',
    title: 'Run bash command?',
    summary: "printf '%s\\n' 'approval preview'",
    cwd: '/workspace/vs-omp',
    notice: 'Not sandboxed. Allow applies once.',
    configurable: true,
    details:
      'Executable: "/bin/bash"\n\nArguments: ["-l", "-c", "printf ..."]\n\nWorking directory: "/workspace/vs-omp"\n\nEnvironment overrides: {}\n\nCommands can change files outside the workspace or send data. Their effects are not covered by Keep/Discard or conversation rewind. Review resulting files in Source Control.',
  },
  approvalCount: 1,
  turns: [
    {
      id: 'turn-1',
      prompt: 'Update the workspace settings and preserve my existing changes.',
      status: 'completed',
      startedAt: Date.now() - 23000,
      endedAt: Date.now(),
      blocks: [
        {
          id: 'progress',
          kind: 'text',
          text: 'I will inspect the current settings and update the requested values.',
        },
        {
          id: 'thinking',
          kind: 'thought',
          text: 'The current user changes must remain in the review baseline.',
        },
        {
          id: 'read',
          kind: 'tool',
          title: 'Read settings.json',
          status: 'completed',
          text: '{ "formatOnSave": false }',
        },
        {
          id: 'write',
          kind: 'tool',
          title: 'Write settings.json',
          status: 'completed',
          input: '{ "path": "/workspace/settings.json" }',
          text: 'Updated settings.json',
        },
        {
          id: 'answer',
          kind: 'text',
          text: 'Updated **settings.json**. Your existing changes are preserved.\n\n- Enabled format on save.\n- Kept the existing tab size.\n\n```json\n{ "formatOnSave": true, "tabSize": 2 }\n```',
        },
      ],
    },
    {
      id: 'turn-2',
      prompt: 'Start the preview so we can refine the chat window.',
      status: 'running',
      startedAt: Date.now() - 4000,
      blocks: [
        {
          id: 'preview-plan',
          kind: 'plan',
          text: 'Inspect the existing UI\nUpdate the layout\nVerify accessibility',
          entries: [
            { content: 'Inspect the existing UI', status: 'completed' },
            { content: 'Update the layout', status: 'in_progress' },
            { content: 'Verify accessibility', status: 'pending' },
          ],
        },
        {
          id: 'terminal-progress',
          kind: 'text',
          text: 'I will start the preview server and check the rendered chat.',
        },
        {
          id: 'terminal',
          kind: 'tool',
          toolKind: 'execute',
          title: 'Run preview server',
          command: 'node scripts/preview.mjs',
          status: 'in_progress',
          text: 'OMP fixture: http://127.0.0.1:5174/',
        },
      ],
    },
  ],
  changes: [
    { id: 'file-1', name: 'scripts/test-extension.mjs', state: 'pending', added: 24, removed: 1 },
    { id: 'file-2', name: 'src/acp.ts', state: 'pending', added: 115, removed: 1 },
    { id: 'file-3', name: 'src/extension.ts', state: 'pending', added: 312, removed: 1 },
    { id: 'file-4', name: 'src/omp-guard.ts', state: 'pending', added: 60, removed: 1 },
    { id: 'file-5', name: 'src/review.ts', state: 'pending', added: 198, removed: 1 },
    { id: 'file-6', name: 'src/state.ts', state: 'pending', added: 68, removed: 1 },
    { id: 'file-7', name: 'media/main.css', state: 'pending', added: 96, removed: 20 },
  ],
  configs: [
    {
      id: 'model',
      name: 'Model',
      value: 'github-copilot/gpt-4.1',
      options: [{ name: 'GPT-4.1', value: 'github-copilot/gpt-4.1' }],
    },
    {
      id: 'thinking',
      name: 'Thinking',
      value: 'medium',
      options: [{ name: 'Medium', value: 'medium' }],
    },
  ],
};
for (const current of fixture.turns) {
  current.history = {
    sessionId: 'preview-native',
    promptEntryId: `prompt-${current.id}`,
    afterEntryId: `after-${current.id}`,
  };
  for (const [index, block] of current.blocks.entries()) {
    if (block.kind === 'text' || block.kind === 'thought')
      Object.assign(block, {
        receivedAt: current.startedAt + index * 1000,
        model: 'github-copilot/gpt-4.1',
      });
  }
}
Object.assign(fixture.changes[0], {
  kind: 'edit',
  hunks: [
    { id: 'preview-hunk-one', newStart: 12 },
    { id: 'preview-hunk-two', newStart: 84 },
  ],
  operations: [{ kind: 'edit', turn: 2, tool: 'write' }],
});
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OMP Webview Fixture</title><link rel="stylesheet" href="/main.css"><style>
:root{--vscode-font-family:'Segoe UI',sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;--vscode-descriptionForeground:#9d9d9d;--vscode-editorWidget-background:#232323;--vscode-chat-requestBackground:#232323;--vscode-editor-background:#121212;--vscode-terminal-background:#181818;--vscode-input-background:#1b1b1b;--vscode-input-foreground:#cccccc;--vscode-input-placeholderForeground:#989898;--vscode-widget-border:#343434;--vscode-tree-indentGuidesStroke:#383838;--vscode-dropdown-background:#232323;--vscode-focusBorder:#4b8bac;--vscode-button-background:#376f8d;--vscode-button-foreground:white;--vscode-textCodeBlock-background:#252525;--vscode-textLink-foreground:#6aa7d4;--vscode-progressBar-background:#508bab;--vscode-testing-iconPassed:#73c991;--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#e56b60;--vscode-editorWarning-foreground:#cca700;--vscode-toolbar-hoverBackground:#303030}
body.light{--vscode-foreground:#333;--vscode-sideBar-background:#f8f8f8;--vscode-descriptionForeground:#616161;--vscode-chat-requestBackground:#eee;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-dropdown-background:#eee;--vscode-widget-border:#ccc;--vscode-tree-indentGuidesStroke:#ccc;--vscode-textCodeBlock-background:#eee;--vscode-toolbar-hoverBackground:#ddd;--vscode-editor-background:#fff;--vscode-editorWidget-background:#f8f8f8;--vscode-terminal-background:#fff;--vscode-textLink-foreground:#006ab1;--vscode-symbolIcon-variableForeground:#846f00;--vscode-symbolIcon-classForeground:#2b7ab0;--vscode-gitDecoration-addedResourceForeground:#326e39;--vscode-gitDecoration-deletedResourceForeground:#b5302d}
body.contrast{--vscode-foreground:#fff;--vscode-sideBar-background:#000;--vscode-descriptionForeground:#fff;--vscode-widget-border:#fff;--vscode-tree-indentGuidesStroke:#fff;--vscode-focusBorder:#f38518;--vscode-button-background:#000;--vscode-button-foreground:#fff;--vscode-textLink-foreground:#6fc3df}
</style></head><body><main id="app"></main><script>
globalThis.fixtureState=${JSON.stringify(fixture)};globalThis.messages=[];
let saved=JSON.parse(sessionStorage.getItem('omp-fixture')||'null');
const publish=()=>postMessage({v:1,type:'state',state:fixtureState},location.origin);
const finish=()=>{fixtureState.busy=false;const current=fixtureState.turns.at(-1);current.status='completed';current.endedAt=Date.now();for(const block of current.blocks)if(block.status==='in_progress')block.status='completed'};
globalThis.acquireVsCodeApi=()=>({getState:()=>saved,setState:value=>{saved=value;sessionStorage.setItem('omp-fixture',JSON.stringify(value))},postMessage:message=>{
  messages.push(message);
  if(message.type==='ready')publish();
  if(message.type==='editPrompt'){const index=fixtureState.turns.findIndex(current=>current.id===message.id);fixtureState.turns=fixtureState.turns.slice(0,index);fixtureState.turns.push({id:crypto.randomUUID(),prompt:message.text,status:'completed',startedAt:Date.now(),endedAt:Date.now(),history:{sessionId:'preview-native',promptEntryId:crypto.randomUUID(),afterEntryId:crypto.randomUUID()},blocks:[{id:crypto.randomUUID(),kind:'text',text:'Replacement response. Workspace files and shared memory are unchanged.'}]});publish();postMessage({v:1,type:'editResult',id:message.id,ok:true},location.origin)}
  if(message.type==='forkTurn'){const index=fixtureState.turns.findIndex(current=>current.id===message.id);const original=fixtureState.turns[index];fixtureState.turns=fixtureState.turns.slice(0,index+(message.boundary==='after'?1:0));fixtureState.sessionId=crypto.randomUUID();fixtureState.session='Forked conversation';publish();if(message.boundary==='before')postMessage({v:1,type:'draft',text:original.prompt},location.origin)}
  if(message.type==='cancel'){finish();fixtureState.turns.at(-1).status='cancelled';fixtureState.queued=[];fixtureState.approval=undefined;fixtureState.approvalCount=0;publish()}
  if(message.type==='approval'&&message.id===fixtureState.approval?.id){fixtureState.approval=undefined;fixtureState.approvalCount=0;finish();publish()}
  if(message.type==='queuePrompt'){fixtureState.queued.push({id:crypto.randomUUID(),text:message.text});publish()}
  if(message.type==='removeQueued'){fixtureState.queued=fixtureState.queued.filter(item=>item.id!==message.id);publish()}
  if(message.type==='clearQueue'){fixtureState.queued=[];publish()}
  if(message.type==='removeAttachment'){fixtureState.attachments=fixtureState.attachments.filter(item=>item.id!==message.id);publish()}
  if(message.type==='hunkKeep'||message.type==='hunkDiscard'){const change=fixtureState.changes.find(item=>item.id===message.id);change.hunks=change.hunks.filter(hunk=>hunk.id!==message.hunkId);if(!change.hunks.length)fixtureState.changes=fixtureState.changes.filter(item=>item.id!==message.id);publish()}
  if(message.type==='compact'){fixtureState.compacting=true;fixtureState.busy=true;publish();setTimeout(()=>{fixtureState.context.used=21500;fixtureState.compacting=false;finish();publish()},700)}
  if(message.type==='inspectContext'){fixtureState.turns.push({id:crypto.randomUUID(),prompt:'/context',status:'completed',startedAt:Date.now(),endedAt:Date.now(),blocks:[{id:crypto.randomUUID(),kind:'text',text:'Context window: **'+fixtureState.context.used.toLocaleString()+' / 400,000 tokens**. This preview uses sample session data.'}]});publish()}
  if(message.type==='keepAll'||message.type==='discardAll'){fixtureState.changes=[];publish()}
  if(message.type==='keep'||message.type==='discard'){fixtureState.changes=fixtureState.changes.filter(change=>change.id!==message.id);publish()}
  if(message.type==='config'){fixtureState.configs.find(config=>config.id===message.id).value=message.value;publish()}
}});
</script><script src="/main.js"></script></body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    response.setHeader('cache-control', 'no-store');
    const filename = new URL(request.url, 'http://localhost').pathname;
    if (filename === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(html);
      return;
    }
    if (!/^\/[\w.-]+\.(js|css|ttf)$/.test(filename)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      'content-type',
      filename.endsWith('.js')
        ? 'text/javascript'
        : filename.endsWith('.css')
          ? 'text/css'
          : 'font/ttf',
    );
    response.end(await readFile(path.join(process.cwd(), 'dist', 'webview', filename)));
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(Number(process.env.PORT ?? 5174), '127.0.0.1', () =>
  console.log(`OMP fixture: http://127.0.0.1:${server.address().port}`),
);
