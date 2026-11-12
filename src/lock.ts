import { App, Modal, Notice, Platform, Setting, TextComponent } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type BookkeepingPlugin from "./main";
import type { BookkeepingSettings } from "./types";

export const LOCK_ITERATIONS = 210000;
const LOCK_REASON = "解锁 个人风格化记账";

const HELPER_SOURCE = String.raw`#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    NSString *reason = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"解锁 个人风格化记账";
    LAContext *context = [[LAContext alloc] init];
    context.localizedCancelTitle = @"取消";
    NSError *error = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&error]) {
      printf("UNAVAILABLE:%s\n", error.localizedDescription.UTF8String ?: "Touch ID 不可用");
      return 2;
    }
    __block int status = 1;
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics localizedReason:reason reply:^(BOOL success, NSError * _Nullable authError) {
      if (success) { printf("SUCCESS\n"); status = 0; }
      else { printf("FAILURE:%s\n", authError.localizedDescription.UTF8String ?: "验证失败"); status = 1; }
      dispatch_semaphore_signal(sema);
    }];
    dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
    return status;
  }
}
`;

type NodeRequire = (id: string) => unknown;
const nodeRequire = (globalThis as unknown as { require?: NodeRequire }).require;

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64ToBytes(value: string): Uint8Array {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持密码校验");
  const key = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

export function lockConfigured(settings: Pick<BookkeepingSettings, "lockSalt" | "lockHash">): boolean {
  return Boolean(settings.lockSalt) && Boolean(settings.lockHash);
}

export function isLedgerPath(settings: Pick<BookkeepingSettings, "ledgerFolder">, path: string): boolean {
  const root = settings.ledgerFolder.replace(/\/+$/, "");
  return Boolean(root) && (path === root || path.startsWith(`${root}/`));
}

export async function setLockPassword(settings: BookkeepingSettings, password: string): Promise<void> {
  if (password.length < 4) throw new Error("密码至少 4 位");
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, LOCK_ITERATIONS);
  settings.lockSalt = bytesToBase64(salt);
  settings.lockHash = bytesToBase64(hash);
  settings.lockIterations = LOCK_ITERATIONS;
}

export async function verifyLockPassword(settings: Pick<BookkeepingSettings, "lockSalt" | "lockHash" | "lockIterations">, password: string): Promise<boolean> {
  if (!settings.lockSalt || !settings.lockHash) return false;
  try {
    const iterations = Number(settings.lockIterations) > 0 ? Number(settings.lockIterations) : LOCK_ITERATIONS;
    const actual = await derivePassword(password, base64ToBytes(settings.lockSalt), iterations);
    const expected = base64ToBytes(settings.lockHash);
    if (actual.length !== expected.length) return false;
    let different = 0;
    for (let index = 0; index < actual.length; index++) different |= actual[index]! ^ expected[index]!;
    return different === 0;
  } catch {
    return false;
  }
}

function execFileAsync(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!nodeRequire) return reject(new Error("当前环境不支持调用系统命令"));
    try {
      const child = nodeRequire("child_process") as typeof import("child_process");
      child.execFile(file, args, { timeout }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve(String(stdout));
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export class TouchIdHelper {
  private helperPath: string | null = null;
  private preparing: Promise<boolean> | null = null;
  private failure = "";

  constructor(private readonly plugin: BookkeepingPlugin) {}

  get lastError(): string { return this.failure; }

  private nativeDir(): string | null {
    const manifestDir = this.plugin.manifest.dir;
    const adapter = this.plugin.app.vault.adapter as { getFullPath?: (path: string) => string };
    if (!manifestDir || typeof adapter.getFullPath !== "function") return null;
    return `${adapter.getFullPath(manifestDir)}/native`;
  }

  async prepare(): Promise<boolean> {
    if (this.helperPath) return true;
    if (!Platform.isDesktop || !Platform.isMacOS) return false;
    if (this.preparing) return this.preparing;
    this.preparing = this.build();
    try {
      return await this.preparing;
    } finally {
      this.preparing = null;
    }
  }

  private sdkCandidates(fs: typeof import("fs")): string[] {
    const preferred = ["MacOSX15.sdk", "MacOSX15.4.sdk", "MacOSX26.sdk", "MacOSX26.5.sdk", "MacOSX.sdk"];
    const root = "/Library/Developer/CommandLineTools/SDKs";
    const available = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.endsWith(".sdk")) : [];
    const ordered = preferred.filter((name) => available.includes(name));
    for (const name of available) if (!ordered.includes(name)) ordered.push(name);
    return ordered.map((name) => `${root}/${name}`);
  }

  private async build(): Promise<boolean> {
    try {
      if (!nodeRequire) throw new Error("当前环境不支持本地助手");
      const fs = nodeRequire("fs") as typeof import("fs");
      const directory = this.nativeDir();
      if (!directory) throw new Error("找不到插件目录");
      const helper = `${directory}/Obsidian`;
      if (fs.existsSync(helper)) {
        this.helperPath = helper;
        return true;
      }
      await fs.promises.mkdir(directory, { recursive: true });
      const source = `${directory}/TouchIDAuth.m`;
      await fs.promises.writeFile(source, HELPER_SOURCE, "utf8");
      let lastError = "";
      let built = false;
      for (const sdk of this.sdkCandidates(fs)) {
        try {
          if (fs.existsSync(helper)) await fs.promises.unlink(helper);
          await execFileAsync("/usr/bin/clang", ["-isysroot", sdk, "-fobjc-arc", "-O2", "-framework", "Foundation", "-framework", "LocalAuthentication", "-o", helper, source], 120000);
          if (fs.existsSync(helper)) { built = true; break; }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!built) throw new Error(lastError || "Touch ID 助手编译失败");
      await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", helper], 30000);
      this.helperPath = helper;
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async authenticate(): Promise<boolean> {
    if (!(await this.prepare())) return false;
    try {
      const output = await execFileAsync(this.helperPath!, ["--reason", LOCK_REASON], 60000);
      if (output.includes("SUCCESS")) return true;
      this.failure = output.trim() || "Touch ID 未通过";
      return false;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
}

export class BookkeepingLock {
  readonly touchId: TouchIdHelper;
  private unlocked = false;
  private pending: Promise<boolean> | null = null;
  private expiryTimer = 0;
  private leaveTimer = 0;

  constructor(private readonly plugin: BookkeepingPlugin) {
    this.touchId = new TouchIdHelper(plugin);
  }

  get enabled(): boolean { return this.plugin.settings.lockEnabled === true && lockConfigured(this.plugin.settings); }
  get isUnlocked(): boolean { return !this.enabled || this.unlocked; }

  private leafKind(leaf: WorkspaceLeaf | null): "dashboard" | "ledger" | null {
    if (!leaf) return null;
    const view = leaf.view as { getViewType: () => string; file?: { path: string } | null };
    if (view.getViewType() === "bookkeeping-dashboard") return "dashboard";
    const path = view.file?.path;
    return path && isLedgerPath(this.plugin.settings, path) ? "ledger" : null;
  }

  mount(): void {
    this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
      this.handleLeaf(leaf);
    }));
    this.plugin.app.workspace.onLayoutReady(() => {
      this.handleLeaf(this.plugin.app.workspace.activeLeaf);
    });
  }

  private clearLeaveTimer(): void {
    if (this.leaveTimer) window.clearTimeout(this.leaveTimer);
    this.leaveTimer = 0;
  }

  private handleLeaf(leaf: WorkspaceLeaf | null): void {
    if (!this.enabled) return;
    const kind = this.leafKind(leaf);
    if (kind) {
      this.clearLeaveTimer();
      if (!this.unlocked) void this.ensureUnlocked(kind === "dashboard" ? "仪表盘" : "账本");
      return;
    }
    // 新建标签页、切换视图时会短暂出现空标签；等页面落定后再判断是否真的离开了账本。
    const viewType = leaf?.view.getViewType();
    if (!leaf || viewType === "empty") {
      this.clearLeaveTimer();
      this.leaveTimer = window.setTimeout(() => {
        this.leaveTimer = 0;
        if (!this.leafKind(this.plugin.app.workspace.activeLeaf)) this.lockSession();
      }, 500);
      return;
    }
    this.lockSession();
  }

  private lockSession(): void {
    this.unlocked = false;
    this.clearLeaveTimer();
    if (this.expiryTimer) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = 0;
  }

  private activeKind(): "dashboard" | "ledger" | null {
    return this.leafKind(this.plugin.app.workspace.activeLeaf);
  }

  lockNow(): void {
    this.lockSession();
    const kind = this.activeKind();
    if (kind) void this.ensureUnlocked(kind === "dashboard" ? "仪表盘" : "账本");
  }

  markUnlocked(): void {
    this.unlocked = true;
    if (this.expiryTimer) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = 0;
    const raw = Number(this.plugin.settings.lockTimeoutMinutes);
    const minutes = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    if (minutes > 0) {
      this.expiryTimer = window.setTimeout(() => {
        this.unlocked = false;
        this.expiryTimer = 0;
        const kind = this.activeKind();
        if (kind) void this.ensureUnlocked(kind === "dashboard" ? "仪表盘" : "账本");
      }, minutes * 60000);
    }
  }

  async ensureUnlocked(reason: string): Promise<boolean> {
    if (!this.enabled || this.unlocked) return true;
    if (this.pending) return this.pending;
    this.pending = new Promise<boolean>((resolve) => {
      const modal = new UnlockModal(this.plugin.app, this.plugin, reason, (ok) => resolve(ok));
      modal.open();
    });
    try {
      const ok = await this.pending;
      if (ok) this.markUnlocked();
      return ok;
    } finally {
      this.pending = null;
    }
  }

  async confirm(reason: string): Promise<boolean> {
    this.lockSession();
    return this.ensureUnlocked(reason);
  }
}

class UnlockModal extends Modal {
  private password = "";
  private errorEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private busy = false;
  private touchBusy = false;
  private done = false;

  constructor(app: App, private readonly plugin: BookkeepingPlugin, private readonly reason: string, private readonly resolve: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.containerEl.addClass("bookkeeping-lock-container");
    this.modalEl.addClass("bookkeeping-lock-modal");
    this.modalEl.querySelector(".modal-close-button")?.remove();
    this.modalEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    });
    this.scope.register([], "Escape", (event) => { event.preventDefault(); return false; });
    this.containerEl.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target === this.containerEl || target?.classList.contains("modal-bg")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    this.titleEl.setText("个人风格化记账已锁定");
    const content = this.contentEl;
    content.addClass("bookkeeping-lock-content");
    content.createDiv({ cls: "bookkeeping-lock-icon", text: "🔒" });
    content.createEl("p", { text: `打开${this.reason}前需要验证。这里只锁 个人风格化记账，不影响其他笔记。`, cls: "bookkeeping-lock-description" });
    new Setting(content).setName("密码").addText((text: TextComponent) => {
      text.inputEl.type = "password";
      text.setPlaceholder("输入记账密码");
      text.onChange((value) => { this.password = value; });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); void this.submit(); }
      });
      window.setTimeout(() => text.inputEl.focus(), 60);
    });
    this.statusEl = content.createDiv({ cls: "bookkeeping-lock-status" });
    this.errorEl = content.createDiv({ cls: "bookkeeping-lock-error" });
    const actions = content.createDiv({ cls: "bookkeeping-lock-actions" });
    const unlock = actions.createEl("button", { text: "解锁", cls: "mod-cta" });
    unlock.addEventListener("click", () => void this.submit());
    if (Platform.isMacOS && Platform.isDesktop && this.plugin.settings.lockTouchId) {
      const touch = actions.createEl("button", { text: "使用 Touch ID" });
      touch.addEventListener("click", () => void this.tryTouchId());
      window.setTimeout(() => void this.tryTouchId(), 350);
    }
    content.createEl("p", { text: "忘记密码时，可在 data.json 中删除 lockSalt、lockHash 后重启 Obsidian 重置。", cls: "bookkeeping-lock-hint" });
  }

  onClose(): void {
    if (!this.done) { this.done = true; this.resolve(false); }
    this.contentEl.empty();
  }

  private finish(ok: boolean): void {
    if (this.done) return;
    this.done = true;
    this.resolve(ok);
    this.close();
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    if (this.statusEl) this.statusEl.setText(value ? "正在验证…" : "");
  }

  private async tryTouchId(): Promise<void> {
    if (this.touchBusy || this.done) return;
    this.touchBusy = true;
    if (this.statusEl) this.statusEl.setText("正在准备 Touch ID…");
    if (this.errorEl) this.errorEl.setText("");
    const ok = await this.plugin.lock.touchId.authenticate();
    this.touchBusy = false;
    if (this.done) return;
    if (this.statusEl) this.statusEl.setText("");
    if (ok) { this.finish(true); return; }
    if (this.errorEl) this.errorEl.setText(this.plugin.lock.touchId.lastError || "Touch ID 未通过，请输入密码");
  }

  private async submit(): Promise<void> {
    if (this.busy || this.done) return;
    if (!this.password) { if (this.errorEl) this.errorEl.setText("请输入密码"); return; }
    this.setBusy(true);
    if (this.errorEl) this.errorEl.setText("");
    const ok = await verifyLockPassword(this.plugin.settings, this.password);
    this.setBusy(false);
    if (ok) this.finish(true);
    else if (this.errorEl) this.errorEl.setText("密码不正确");
  }
}

export class LockPasswordModal extends Modal {
  private password = "";
  private confirmation = "";
  private errorEl: HTMLElement | null = null;
  private busy = false;

  constructor(app: App, private readonly plugin: BookkeepingPlugin, private readonly onSaved: () => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("设置记账锁密码");
    this.contentEl.createEl("p", { text: "密码只用于 个人风格化记账 的界面解锁，不加密磁盘文件。请设置一个自己能记住的密码。", cls: "bookkeeping-lock-description" });
    new Setting(this.contentEl).setName("新密码").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("至少 4 位");
      text.onChange((value) => { this.password = value; });
    });
    new Setting(this.contentEl).setName("确认密码").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("再输入一次");
      text.onChange((value) => { this.confirmation = value; });
    });
    this.errorEl = this.contentEl.createDiv({ cls: "bookkeeping-lock-error" });
    const actions = this.contentEl.createDiv({ cls: "bookkeeping-lock-actions" });
    const save = actions.createEl("button", { text: "保存并启用", cls: "mod-cta" });
    save.addEventListener("click", () => void this.save());
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    if (this.password.length < 4) { if (this.errorEl) this.errorEl.setText("密码至少 4 位"); return; }
    if (this.password !== this.confirmation) { if (this.errorEl) this.errorEl.setText("两次输入的密码不一致"); return; }
    this.busy = true;
    try {
      await setLockPassword(this.plugin.settings, this.password);
      this.plugin.settings.lockEnabled = true;
      await this.plugin.saveSettingsQuietly();
      new Notice("记账锁已启用");
      this.onSaved();
      this.close();
    } catch (error) {
      if (this.errorEl) this.errorEl.setText(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }
}
