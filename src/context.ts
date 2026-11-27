import { randomUUID } from 'node:crypto';
import type { Attachment, Turn } from './state.js';
import { imageSchema, decodeImage, type ImagePayload } from './image-policy.js';

type ContextRequest =
  | { type: 'attach' }
  | { type: 'attachContext' }
  | { type: 'pasteImages'; images: ImagePayload[] }
  | { type: 'inspectAttachment'; id: string }
  | { type: 'removeAttachment'; id: string };
export function isContextRequest(request: { type: string }): request is ContextRequest {
  return [
    'attach',
    'attachContext',
    'pasteImages',
    'inspectAttachment',
    'removeAttachment',
  ].includes(request.type);
}

export function turnAttachments(turn: Pick<Turn, 'attachment' | 'attachments'>): Attachment[] {
  return turn.attachments ?? (turn.attachment ? [turn.attachment] : []);
}

export function contextSnapshot(
  kind: NonNullable<Attachment['kind']>,
  label: string,
  uri: string,
  text: string,
): Attachment {
  if (!['file:', 'vscode-remote:', 'untitled:'].includes(new URL(uri).protocol))
    throw new Error(
      'Only explicitly selected local, workspace-host or unsaved text resources can be attached.',
    );
  if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > 64_000)
    throw new Error('Select a smaller text excerpt to attach (64 KB maximum).');
  return { id: randomUUID(), kind, label, uri, text };
}

export function imageContextSnapshot(label: string, uri: string, image: ImagePayload): Attachment {
  return {
    ...contextSnapshot('image', label, uri, 'Untrusted image snapshot: ' + label),
    image: imageSchema.parse(image),
  };
}

export function pastedImageSnapshot(image: ImagePayload): Attachment {
  const validated = imageSchema.parse(image);
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[
    validated.mimeType
  ];
  const label = `Pasted ${extension.toUpperCase()} image`;
  return imageContextSnapshot(
    label,
    `untitled:pasted-image-${randomUUID()}.${extension}`,
    validated,
  );
}

function validatedSnapshot(snapshot: Attachment): Attachment {
  if (snapshot.kind === 'image') {
    if (!snapshot.image) throw new Error('Image attachment payload is missing.');
    return imageContextSnapshot(snapshot.label, snapshot.uri, snapshot.image);
  }
  if (snapshot.image) throw new Error('Image payload requires an image attachment.');
  return contextSnapshot(snapshot.kind ?? 'file', snapshot.label, snapshot.uri, snapshot.text);
}

export class ContextAttachments {
  private readonly drafts = new Map<string, Attachment[]>();
  private readonly dismissed = new Map<string, string>();
  private offered: { id: string; owner: string; uri: string; label: string } | undefined;

  offer(owner: string, resource?: { uri: string; label: string }) {
    if (
      !resource ||
      this.dismissed.get(owner) === resource.uri ||
      this.list(owner).some((item) => item.uri === resource.uri)
    ) {
      this.offered = undefined;
      return;
    }
    if (this.offered?.owner !== owner || this.offered.uri !== resource.uri)
      this.offered = { ...resource, owner, id: randomUUID() };
    const { id, uri, label } = this.offered;
    return { id, uri, label };
  }

  offeredUri(owner: string, id: string): string {
    if (this.offered?.owner !== owner || this.offered.id !== id)
      throw new Error('The active-editor context offer is stale.');
    return this.offered.uri;
  }

  dismissOffer(owner: string, id: string): void {
    this.dismissed.set(owner, this.offeredUri(owner, id));
    this.offered = undefined;
  }

  bindSession(owner: string, previousOwner?: string, resumed = false): void {
    if (previousOwner || resumed) return;
    this.add(owner, this.list('new'));
    this.clear('new');
  }

  list(owner: string): Attachment[] {
    return structuredClone(this.drafts.get(owner) ?? []);
  }

  count(owner: string): number {
    return this.drafts.get(owner)?.length ?? 0;
  }

  presentation(owner: string) {
    const pending = this.list(owner);
    return {
      attachment: pending[0]?.label,
      attachments: pending.map(({ id, label, kind, uri }) => ({ id, label, kind, uri })),
    };
  }

  capture(owner: string, original?: Attachment | Attachment[], attach = true): Attachment[] {
    if (original) return Array.isArray(original) ? original : [original];
    return attach ? this.list(owner) : [];
  }

  restore(owner: string, turn: Pick<Turn, 'attachment' | 'attachments'>, before: boolean): void {
    this.set(owner, before ? turnAttachments(turn) : []);
  }

  async handle(
    owner: string,
    request: ContextRequest,
    files: {
      editorContext(): Attachment;
      pickContext(): Promise<Attachment[]>;
      inspectContext(snapshot: Attachment): Promise<void>;
    },
  ): Promise<void> {
    if (request.type === 'attach') return this.add(owner, [files.editorContext()]);
    if (request.type === 'attachContext') return this.add(owner, await files.pickContext());
    if (request.type === 'pasteImages')
      return this.add(owner, request.images.map(pastedImageSnapshot));
    if (request.type === 'removeAttachment') return this.remove(owner, request.id);
    const selected = this.list(owner).find((item) => item.id === request.id);
    if (!selected) throw new Error('Attachment does not belong to this session.');
    await files.inspectContext(selected);
  }

  add(owner: string, snapshots: Attachment[]): void {
    const pending = this.list(owner);
    for (const snapshot of snapshots) {
      const validated = validatedSnapshot(snapshot);
      const index = pending.findIndex(
        (entry) =>
          entry.uri === snapshot.uri &&
          entry.label === snapshot.label &&
          entry.kind === snapshot.kind,
      );
      if (index < 0) pending.push(validated);
      else pending[index] = validated;
    }
    if (
      pending.length > 8 ||
      pending.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0) > 128_000
    )
      throw new Error('Attach at most eight snapshots and 128 KB in total.');
    const imageBytes = pending.reduce(
      (total, snapshot) => total + (snapshot.image ? decodeImage(snapshot.image).byteLength : 0),
      0,
    );
    if (imageBytes > 1_048_576)
      throw new Error('Attach at most 1 MiB of image snapshots in total.');
    this.drafts.set(owner, pending);
  }

  remove(owner: string, id: string): void {
    const pending = this.list(owner);
    if (!pending.some((entry) => entry.id === id))
      throw new Error('Attachment does not belong to this session.');
    this.drafts.set(
      owner,
      pending.filter((entry) => entry.id !== id),
    );
  }

  set(owner: string, snapshots: Attachment[]): void {
    const previous = this.drafts.get(owner);
    this.drafts.delete(owner);
    try {
      this.add(owner, snapshots);
    } catch (error) {
      if (previous) this.drafts.set(owner, previous);
      throw error;
    }
  }

  clear(owner: string): void {
    this.drafts.delete(owner);
    this.dismissed.delete(owner);
    if (this.offered?.owner === owner) this.offered = undefined;
  }
}
