import type { SidebarRequest } from './host-view.js';

export interface RequestHandlers {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  newSession(): Promise<void>;
  switchSession(): Promise<void>;
  cancel(): Promise<void>;
  postModelCatalog(): void;
  selectModelRoute(value: string): Promise<void>;
  prompt(text: string): Promise<void>;
  editPrompt(id: string, text: string): Promise<void>;
  forkTurn(id: string, boundary: 'before' | 'after'): Promise<void>;
  permissions(): Promise<void>;
  terminals(): Promise<void> | undefined;
  config(id: 'model' | 'thinking', value: string): Promise<void>;
  sessionCommand(command: 'compact' | 'context'): Promise<void>;
}

export function routeRequest(request: SidebarRequest, handlers: RequestHandlers): Promise<void> {
  switch (request.type) {
    case 'connect':
      return handlers.connect();
    case 'disconnect':
      return handlers.disconnect();
    case 'new':
      return handlers.newSession();
    case 'sessions':
      return handlers.switchSession();
    case 'cancel':
      return handlers.cancel();
    case 'modelCatalog':
      handlers.postModelCatalog();
      return Promise.resolve();
    case 'modelRoute':
      return handlers.selectModelRoute(request.value);
    default:
      return conversationRequest(request, handlers);
  }
}

async function conversationRequest(
  request: SidebarRequest,
  handlers: RequestHandlers,
): Promise<void> {
  switch (request.type) {
    case 'prompt':
      await handlers.prompt(request.text);
      break;
    case 'editPrompt':
      await handlers.editPrompt(request.id, request.text);
      break;
    case 'forkTurn':
      await handlers.forkTurn(request.id, request.boundary);
      break;
    case 'permissions':
      await handlers.permissions();
      break;
    case 'terminals':
      await handlers.terminals();
      break;
    case 'config':
      await handlers.config(request.id, request.value);
      break;
    case 'compact':
      await handlers.sessionCommand('compact');
      break;
    case 'inspectContext':
      await handlers.sessionCommand('context');
      break;
  }
}
