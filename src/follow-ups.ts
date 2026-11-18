import { randomUUID } from 'node:crypto';
import { assertPromptAllowed } from './history.js';
import type { Attachment, Turn } from './state.js';

export type QueuedPrompt = { id: string; text: string; attachments: Attachment[] };
export type QueueRequest =
  | { type: 'queuePrompt'; text: string }
  | { type: 'removeQueued'; id: string }
  | { type: 'clearQueue' }
  | { type: 'resumeQueue' };

export function isQueueRequest(request: { type: string }): request is QueueRequest {
  return ['queuePrompt', 'removeQueued', 'clearQueue', 'resumeQueue'].includes(request.type);
}

export class FollowUps {
  private owner: string | undefined;
  private items: QueuedPrompt[] = [];
  private paused = false;
  private draining = false;
  private generation = 0;

  snapshot(owner: string) {
    return {
      queued: this.owner === owner ? this.items.map(({ id, text }) => ({ id, text })) : [],
      queuePaused: this.paused,
    };
  }

  enqueue(owner: string, text: string, attachments: Attachment[]): void {
    assertPromptAllowed(text);
    if (!text.trim() || text.length > 128_000) throw new Error('Invalid follow-up prompt.');
    if (this.owner && this.owner !== owner) throw new Error('Queue belongs to another session.');
    const item = { id: randomUUID(), text, attachments: structuredClone(attachments) };
    if (
      this.items.length >= 5 ||
      Buffer.byteLength(JSON.stringify([...this.items, item])) > 512_000
    )
      throw new Error('Follow-up queue limit reached.');
    this.owner = owner;
    this.items.push(item);
  }

  remove(owner: string, id: string): void {
    const index = this.owner === owner ? this.items.findIndex((item) => item.id === id) : -1;
    if (index < 0) throw new Error('Queued prompt does not belong to this session.');
    this.items.splice(index, 1);
  }

  clear(paused = false): void {
    this.generation++;
    this.items = [];
    this.owner = undefined;
    this.paused = paused;
  }

  settle(status: Turn['status']): void {
    if (status !== 'completed') this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  async handle(
    owner: string,
    request: QueueRequest,
    controls: {
      busy: boolean;
      idle: boolean;
      capture: () => Attachment[];
      clearAttachments: () => void;
      drain: () => Promise<void>;
    },
  ): Promise<void> {
    if (request.type === 'queuePrompt') {
      if (!controls.busy) throw new Error('Queue follow-ups only during a running prompt.');
      this.enqueue(owner, request.text, controls.capture());
      controls.clearAttachments();
    } else if (request.type === 'removeQueued') this.remove(owner, request.id);
    else if (request.type === 'clearQueue') this.clear(true);
    else {
      if (!controls.idle)
        throw new Error('Wait for the current operation before resuming the queue.');
      this.resume();
      await controls.drain();
    }
  }

  async run(action: () => Promise<void>, drain: () => Promise<void>): Promise<void> {
    try {
      await action();
      await drain();
    } catch (error) {
      this.paused = true;
      throw error;
    }
  }

  async drain(
    owner: string,
    ready: () => boolean,
    send: (item: QueuedPrompt) => Promise<void>,
  ): Promise<void> {
    if (this.draining) return;
    const generation = this.generation;
    this.draining = true;
    try {
      while (
        this.items.length &&
        this.owner === owner &&
        !this.paused &&
        generation === this.generation
      ) {
        if (!ready()) {
          this.paused = true;
          break;
        }
        await send(this.items.shift()!);
      }
    } catch (error) {
      this.paused = true;
      throw error;
    } finally {
      this.draining = false;
    }
  }
}
