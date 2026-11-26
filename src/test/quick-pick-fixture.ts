export interface QuickPickHost {
  quickPick?: string;
}

export const picker = {
  items: [] as readonly { label: string; kind?: number; value?: string }[],
  active: [] as readonly { label: string; value?: string }[],
};

export function resetPicker() {
  picker.items = [];
  picker.active = [];
}

const disposable = () => ({ dispose() {} });

export class QuickPickFixture<
  T extends { label: string; value?: string } = { label: string; value?: string },
> {
  items: readonly T[] = [];
  activeItems: readonly T[] = [];
  selectedItems: readonly T[] = [];
  value = '';
  title = '';
  placeholder = '';
  matchOnDescription = false;
  ignoreFocusOut = false;
  private acceptListeners: (() => void)[] = [];
  private hideListeners: (() => void)[] = [];
  private hidden = false;
  constructor(private readonly host: QuickPickHost) {}
  onDidAccept(listener: () => void) {
    this.acceptListeners.push(listener);
    return disposable();
  }
  onDidHide(listener: () => void) {
    this.hideListeners.push(listener);
    return disposable();
  }
  show() {
    picker.items = this.items;
    picker.active = this.activeItems;
    queueMicrotask(() => {
      if (this.hidden) return;
      const target = this.items.find((item) => item.value === this.host.quickPick);
      if (!target) return this.fireHide();
      this.selectedItems = [target];
      this.activeItems = [target];
      for (const listener of this.acceptListeners.splice(0)) listener();
      this.fireHide();
    });
  }
  hide() {
    this.fireHide();
  }
  dispose() {
    this.hidden = true;
    this.acceptListeners = [];
    this.hideListeners = [];
  }
  private fireHide() {
    if (this.hidden) return;
    this.hidden = true;
    for (const listener of this.hideListeners.splice(0)) listener();
  }
}
