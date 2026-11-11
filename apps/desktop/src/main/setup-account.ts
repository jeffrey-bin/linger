import type { SetupLocalAccount } from "../shared/setup.js";
import type { LocalAccount } from "./local-server.js";

export interface SetupAccountOptions {
  // Reads the installation's local-account.json.
  readonly read: () => Promise<LocalAccount>;
  readonly copy: (text: string) => void;
  readonly showFile: (file: string) => void;
}

// The owner account the setup page shows once Linger is installed. The page
// gets the password only while the person chose to show it; copying and
// revealing the file happen here.
export class SetupAccount {
  readonly #options: SetupAccountOptions;
  #account: LocalAccount | { readonly error: string } | undefined;
  #shown = false;

  constructor(options: SetupAccountOptions) {
    this.#options = options;
  }

  async refresh(): Promise<void> {
    try {
      this.#account = await this.#options.read();
    } catch (error) {
      this.#account = {
        error: error instanceof Error ? error.message : String(error),
      };
      this.#shown = false;
    }
  }

  view(): SetupLocalAccount | undefined {
    const account = this.#account;
    if (!account || "error" in account) return account;
    return {
      email: account.email,
      ...(this.#shown ? { password: account.password } : {}),
    };
  }

  show(on: boolean): void {
    this.#shown = on && this.#readable() !== undefined;
  }

  copy(): void {
    const account = this.#readable();
    if (account) this.#options.copy(account.password);
  }

  reveal(): void {
    const account = this.#readable();
    if (account) this.#options.showFile(account.file);
  }

  #readable(): LocalAccount | undefined {
    const account = this.#account;
    return account && !("error" in account) ? account : undefined;
  }
}
