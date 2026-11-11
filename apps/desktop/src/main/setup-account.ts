import type { SetupLocalAccount } from "../shared/setup.js";
import type { LocalAccount } from "./local-server.js";

// How long a copied password may stay on the clipboard.
export const CLIPBOARD_CLEAR_MS = 60_000;

export interface SetupAccountOptions {
  // Reads the installation's local-account.json.
  readonly read: () => Promise<LocalAccount>;
  readonly clipboard: {
    writeText(text: string): Promise<void>;
    readText(): Promise<string>;
    clear(): void;
  };
  readonly showFile: (file: string) => void;
}

type Cached = Pick<LocalAccount, "email" | "file"> | { readonly error: string };

// The owner account the setup page shows once Linger is installed. Only the
// email and the file are kept; the password is read from the file when the
// person shows or copies it, and is held only while it is shown.
export class SetupAccount {
  readonly #options: SetupAccountOptions;
  #account: Cached | undefined;
  #shown: string | undefined;
  #clear: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SetupAccountOptions) {
    this.#options = options;
  }

  async refresh(): Promise<void> {
    const account = await this.#read();
    if (this.#shown !== undefined) this.#shown = account?.password;
  }

  view(): SetupLocalAccount | undefined {
    const account = this.#account;
    if (!account || "error" in account) return account;
    return {
      email: account.email,
      ...(this.#shown !== undefined ? { password: this.#shown } : {}),
    };
  }

  async show(on: boolean): Promise<void> {
    this.#shown = on ? (await this.#read())?.password : undefined;
  }

  // The setup window closed: whatever was shown is hidden again.
  hide(): void {
    this.#shown = undefined;
  }

  async copy(): Promise<void> {
    const password = (await this.#read())?.password;
    if (password === undefined) return;
    const clipboard = this.#options.clipboard;
    await clipboard.writeText(password);
    clearTimeout(this.#clear);
    this.#clear = setTimeout(() => {
      this.#clear = undefined;
      // Something copied since is left alone.
      void clipboard
        .readText()
        .then((text) => {
          if (text === password) clipboard.clear();
        })
        .catch(() => undefined);
    }, CLIPBOARD_CLEAR_MS);
    this.#clear.unref?.();
  }

  reveal(): void {
    const account = this.#account;
    if (account && !("error" in account)) this.#options.showFile(account.file);
  }

  async #read(): Promise<LocalAccount | undefined> {
    try {
      const account = await this.#options.read();
      this.#account = { email: account.email, file: account.file };
      return account;
    } catch (error) {
      this.#account = {
        error: error instanceof Error ? error.message : String(error),
      };
      this.#shown = undefined;
      return undefined;
    }
  }
}
