import {
  BaseWindow,
  WebContentsView,
  ipcMain,
  nativeImage,
  protocol,
  session,
  shell,
  type BaseWindowConstructorOptions,
  type IpcMainEvent,
  type WebContents,
} from "electron";

import iconPng from "../../resources/icon.png";
import offlineHtml from "../shell/offline.html";
import titlebarHtml from "../shell/titlebar.html";
import {
  SHELL_IPC,
  type ShellCommand,
  type ShellPlatform,
  type TitlebarState,
} from "../shared/shell.js";
import type { DiagnosticsModule } from "./diagnostics.js";
import type { Module, ModuleContext } from "./modules.js";
import {
  OFFLINE_ORIGIN,
  SHELL_ORIGIN,
  framableHeaders,
  navigationDecision,
  parseServerUrl,
  permissionAllowed,
  sameOrigin,
} from "./navigation.js";

// Must run before app "ready".
export const registerAppScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true } },
  ]);
};

export interface WindowManagerOptions {
  readonly preload: string;
  readonly shellPreload: string;
  readonly background: boolean;
}

const TITLEBAR_HEIGHT = 40;
const CANVAS = "#f6f6f6";
const COMMANDS = new Set<ShellCommand>([
  "back",
  "forward",
  "reload",
  "minimize",
  "maximize",
  "close",
]);

const chrome = (platform: NodeJS.Platform): BaseWindowConstructorOptions => {
  if (platform === "darwin")
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 13 },
    };
  if (platform === "win32")
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: CANVAS,
        symbolColor: "#404040",
        height: TITLEBAR_HEIGHT - 1,
      },
    };
  return { frame: false };
};

export const INVALID_SERVER =
  "Enter a server address that starts with http:// or https://";

const html = (body: string): Response =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

// macOS keeps the native traffic lights over a full-height SPA, which leaves
// room for them (see the preload); elsewhere a desktop-owned title bar sits on
// top of the SPA.
const drawsTitlebar = (platform: NodeJS.Platform): boolean =>
  platform !== "darwin";

// The main window. Native window controls stay native (macOS
// traffic lights, the Windows caption overlay); Linux gets drawn controls.
// Closing hides the window; the tray keeps the app running.
export class WindowManagerModule implements Module {
  readonly name = "WindowManager";
  readonly dependsOn = ["Config"];
  readonly #options: WindowManagerOptions;
  #ctx: ModuleContext | undefined;
  #window: BaseWindow | undefined;
  #titlebar: WebContentsView | undefined;
  #content: WebContentsView | undefined;
  #quitting = false;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: WindowManagerOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#secureSession();
    protocol.handle("app", (request) => this.#serveApp(request));
    const onState = (event: IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      this.#fromTitlebar(event);
    ipcMain.handle(SHELL_IPC.state, (event) => {
      if (!onState(event)) throw new Error("Not allowed");
      return this.#titlebarState();
    });
    ipcMain.on(SHELL_IPC.command, (event, name: unknown) => {
      if (!onState(event) || !COMMANDS.has(name as ShellCommand)) return;
      this.#command(name as ShellCommand);
    });
    this.#unsubscribe.push(
      () => ipcMain.removeHandler(SHELL_IPC.state),
      () => ipcMain.removeAllListeners(SHELL_IPC.command),
    );
    if (!this.#options.background) this.show();
  }

  async stop(): Promise<void> {
    this.#quitting = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    protocol.unhandle("app");
    this.#window?.destroy();
    this.#window = undefined;
  }

  // Lets the next close really close the window.
  prepareQuit(): void {
    this.#quitting = true;
  }

  window(): BaseWindow | undefined {
    return this.#window;
  }

  webContents(): WebContents | undefined {
    return this.#content?.webContents;
  }

  show(): void {
    if (this.#window) {
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show();
      this.#window.focus();
      return;
    }
    const bounds = this.#ctx!.config.get().window;
    const window = new BaseWindow({
      ...(bounds ?? { width: 1280, height: 820 }),
      minWidth: 800,
      minHeight: 560,
      title: "Linger",
      backgroundColor: CANVAS,
      icon: nativeImage.createFromBuffer(Buffer.from(iconPng)),
      ...chrome(process.platform),
    });
    const titlebar = drawsTitlebar(process.platform)
      ? new WebContentsView({
          webPreferences: {
            preload: this.#options.shellPreload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
          },
        })
      : undefined;
    titlebar?.setBackgroundColor(CANVAS);
    const content = new WebContentsView({
      webPreferences: {
        preload: this.#options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    content.setBackgroundColor("#ffffff");
    if (titlebar) window.contentView.addChildView(titlebar);
    window.contentView.addChildView(content);
    this.#window = window;
    this.#titlebar = titlebar;
    this.#content = content;

    const layout = (): void => {
      const { width, height } = window.getContentBounds();
      const top = titlebar ? TITLEBAR_HEIGHT : 0;
      titlebar?.setBounds({ x: 0, y: 0, width, height: top });
      content.setBounds({ x: 0, y: top, width, height: height - top });
    };
    layout();
    window.on("resize", layout);
    for (const event of [
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
      "focus",
      "blur",
    ] as const)
      window.on(event as "focus", () => this.#pushState());

    if (titlebar) this.#guardTitlebar(titlebar.webContents);
    this.#guardContent(content.webContents);
    window.on("close", (event) => {
      const { x, y, width, height } = window.getNormalBounds();
      this.#ctx!.config.update({ window: { x, y, width, height } });
      if (this.#quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on("closed", () => {
      titlebar?.webContents.close();
      content.webContents.close();
      if (this.#window === window) {
        this.#window = undefined;
        this.#titlebar = undefined;
        this.#content = undefined;
      }
    });

    void titlebar?.webContents
      .loadURL(`${SHELL_ORIGIN}/titlebar`)
      .catch(() => undefined);
    this.loadServer();
    content.webContents.focus();
  }

  // Points the app at another server; false when the address is invalid.
  setServer(value: string): boolean {
    const serverUrl = parseServerUrl(value);
    if (!serverUrl) return false;
    const ctx = this.#ctx!;
    if (serverUrl !== ctx.config.get().serverUrl) {
      ctx.config.update({ serverUrl });
      ctx.bus.emit("server.changed", serverUrl);
    }
    setImmediate(() => {
      this.loadServer();
      this.#pushState();
    });
    return true;
  }

  loadServer(): void {
    const serverUrl = this.#serverUrl();
    if (!serverUrl) this.#loadOffline();
    else void this.#content?.webContents.loadURL(serverUrl).catch(() => {});
  }

  // While the services on this computer restart on a new version; the
  // server's own pages would fail until they are back.
  showUpdating(): void {
    this.#loadLocal("updating", "1");
  }

  // While the services on this computer start again after the app or the
  // computer restarted.
  showStarting(): void {
    this.#loadLocal("starting", "1");
  }

  // The services on this computer did not start; Try Again starts them again.
  showStartFailed(reason: string): void {
    this.#loadLocal("failed", reason);
  }

  #loadLocal(mode: "updating" | "starting" | "failed", value: string): void {
    const url = new URL(`${OFFLINE_ORIGIN}/`);
    url.searchParams.set(mode, value);
    void this.#content?.webContents
      .loadURL(url.toString())
      .catch(() => undefined);
  }

  #serverUrl(): string | undefined {
    return this.#ctx!.config.get().serverUrl;
  }

  #loadOffline(error?: string): void {
    const url = new URL(`${OFFLINE_ORIGIN}/`);
    const serverUrl = this.#serverUrl();
    if (serverUrl) url.searchParams.set("server", serverUrl);
    if (error) url.searchParams.set("error", error);
    void this.#content?.webContents
      .loadURL(url.toString())
      .catch(() => undefined);
  }

  #titlebarState(): TitlebarState {
    const window = this.#window;
    const contents = this.#content?.webContents;
    const serverUrl = this.#serverUrl();
    return {
      platform: process.platform as ShellPlatform,
      title: serverUrl ? new URL(serverUrl).host : "",
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      loading: contents?.isLoading() ?? false,
      maximized: window?.isMaximized() ?? false,
      focused: window?.isFocused() ?? false,
    };
  }

  #pushState(): void {
    const contents = this.#titlebar?.webContents;
    if (contents && !contents.isDestroyed())
      contents.send(SHELL_IPC.stateEvent, this.#titlebarState());
  }

  #fromTitlebar(event: { sender: WebContents }): boolean {
    return (
      event.sender === this.#titlebar?.webContents &&
      event.sender.getURL().startsWith(`${SHELL_ORIGIN}/`)
    );
  }

  #command(name: ShellCommand): void {
    const window = this.#window;
    const history = this.#content?.webContents.navigationHistory;
    if (!window) return;
    switch (name) {
      case "back":
        if (history?.canGoBack()) history.goBack();
        break;
      case "forward":
        if (history?.canGoForward()) history.goForward();
        break;
      case "reload":
        if (this.#content?.webContents.getURL().startsWith(OFFLINE_ORIGIN))
          this.loadServer();
        else this.#content?.webContents.reload();
        break;
      case "minimize":
        window.minimize();
        break;
      case "maximize":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "close":
        window.close();
        break;
    }
  }

  // The title bar is a fixed local page: it never navigates or opens windows.
  #guardTitlebar(contents: WebContents): void {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
  }

  #guardContent(contents: WebContents): void {
    contents.on("will-navigate", (event, url) =>
      this.#guard(event, url, contents.getURL()),
    );
    // Redirects inside frames, such as a site in the link preview panel, stay
    // in their frame.
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame) this.#guard(event, event.url, contents.getURL());
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (navigationDecision(url, this.#serverUrl()) !== "deny")
        void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-fail-load", (_event, code, description, url, isMain) => {
      // -3 is an aborted load, usually a navigation replacing another.
      if (!isMain || code === -3 || url.startsWith(OFFLINE_ORIGIN)) return;
      this.#ctx!.log.warn("window.load_failed", { code, description });
      this.#loadOffline(description);
    });
    for (const event of [
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
    ] as const)
      contents.on(event as "did-start-loading", () => this.#pushState());
  }

  #guard(
    event: { preventDefault(): void },
    url: string,
    fromUrl: string,
  ): void {
    const decision = navigationDecision(url, this.#serverUrl(), fromUrl);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  }

  #secureSession(): void {
    const target = session.defaultSession;
    target.setPermissionRequestHandler((_contents, permission, done, details) =>
      done(
        permissionAllowed(
          permission,
          {
            requestingUrl: details.requestingUrl,
            ...("mediaTypes" in details
              ? { mediaTypes: details.mediaTypes ?? [] }
              : {}),
          },
          this.#serverUrl(),
        ),
      ),
    );
    target.setPermissionCheckHandler((_contents, permission, origin, details) =>
      permissionAllowed(
        permission,
        {
          requestingUrl: origin,
          ...(details.mediaType ? { mediaTypes: [details.mediaType] } : {}),
        },
        this.#serverUrl(),
      ),
    );
    // Frames in the app's own page, such as the link preview panel.
    target.webRequest.onHeadersReceived((details, done) => {
      const contents = this.#content?.webContents;
      const server = this.#serverUrl();
      done(
        details.resourceType === "subFrame" &&
          details.responseHeaders &&
          contents &&
          !contents.isDestroyed() &&
          details.webContentsId === contents.id &&
          server &&
          sameOrigin(contents.getURL(), server)
          ? { responseHeaders: framableHeaders(details.responseHeaders) }
          : {},
      );
    });
  }

  #serveApp(request: Request): Response {
    const url = new URL(request.url);
    if (url.host === "shell" && url.pathname === "/titlebar")
      return html(titlebarHtml);
    if (url.host !== "offline") return new Response(null, { status: 404 });
    if (url.pathname === "/logo.png")
      return new Response(Buffer.from(iconPng), {
        headers: { "content-type": "image/png" },
      });
    // The start failure page's Show Logs and Save Diagnostics.
    if (url.pathname === "/logs" || url.pathname === "/diagnostics") {
      const diagnostics = this.#ctx!.get<DiagnosticsModule>("Diagnostics");
      void (
        url.pathname === "/logs" ? diagnostics.openLogs() : diagnostics.save()
      ).catch((error: unknown) =>
        this.#ctx?.log.warn("window.diagnostics_failed", {
          error: String(error),
        }),
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/restart") {
      this.#ctx!.bus.emit("local-server.retry");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/connect") {
      if (!this.setServer(url.searchParams.get("server") ?? ""))
        this.#loadOffline(INVALID_SERVER);
      return new Response(null, { status: 204 });
    }
    return html(offlineHtml);
  }
}
