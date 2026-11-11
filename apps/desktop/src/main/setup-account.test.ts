import { afterEach, describe, expect, it, vi } from "vitest";

import { CLIPBOARD_CLEAR_MS, SetupAccount } from "./setup-account.js";

const ACCOUNT = {
  email: "owner@linger.local",
  password: "a-private-password",
  file: "/home/me/.simplexai/instances/desktop/local-account.json",
};

const setupAccount = (read = vi.fn(async () => ACCOUNT)) => {
  let text = "";
  const clipboard = {
    writeText: vi.fn(async (value: string) => {
      text = value;
    }),
    readText: vi.fn(async () => text),
    clear: vi.fn(() => {
      text = "";
    }),
  };
  const showFile = vi.fn();
  return {
    account: new SetupAccount({ read, clipboard, showFile }),
    clipboard,
    showFile,
    read,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("SetupAccount", () => {
  it("shows the email and keeps the password back until asked", async () => {
    const { account } = setupAccount();
    expect(account.view()).toBeUndefined();
    await account.refresh();
    expect(account.view()).toEqual({ email: ACCOUNT.email });
    await account.show(true);
    expect(account.view()).toEqual({
      email: ACCOUNT.email,
      password: ACCOUNT.password,
    });
    await account.show(false);
    expect(account.view()).toEqual({ email: ACCOUNT.email });
  });

  it("reads the password from the file when it is shown or copied", async () => {
    const { account, clipboard, read } = setupAccount();
    await account.refresh();
    const changed = { ...ACCOUNT, password: "a-new-password" };
    read.mockResolvedValue(changed);
    await account.show(true);
    expect(account.view()).toEqual({
      email: ACCOUNT.email,
      password: changed.password,
    });
    await account.copy();
    expect(clipboard.writeText).toHaveBeenCalledWith(changed.password);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("hides the password again when the setup window closes", async () => {
    const { account } = setupAccount();
    await account.refresh();
    await account.show(true);
    account.hide();
    expect(account.view()).toEqual({ email: ACCOUNT.email });
    await account.refresh();
    expect(account.view()).toEqual({ email: ACCOUNT.email });
  });

  it("copies the password and reveals the file without the page", async () => {
    const { account, clipboard, showFile } = setupAccount();
    await account.refresh();
    await account.copy();
    account.reveal();
    expect(clipboard.writeText).toHaveBeenCalledWith(ACCOUNT.password);
    expect(showFile).toHaveBeenCalledWith(ACCOUNT.file);
    expect(account.view()).not.toHaveProperty("password");
  });

  it("clears the copied password after a minute", async () => {
    vi.useFakeTimers();
    const { account, clipboard } = setupAccount();
    await account.copy();
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS - 1);
    expect(clipboard.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard.clear).toHaveBeenCalledOnce();
    expect(await clipboard.readText()).toBe("");
  });

  it("leaves the clipboard alone once something else was copied", async () => {
    vi.useFakeTimers();
    const { account, clipboard } = setupAccount();
    await account.copy();
    await clipboard.writeText("something else");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard.clear).not.toHaveBeenCalled();
    expect(await clipboard.readText()).toBe("something else");
  });

  it("counts the minute from the latest copy", async () => {
    vi.useFakeTimers();
    const { account, clipboard } = setupAccount();
    await account.copy();
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS / 2);
    await account.copy();
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS / 2);
    expect(clipboard.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS / 2);
    expect(clipboard.clear).toHaveBeenCalledOnce();
  });

  it("says why the file could not be read and offers nothing else", async () => {
    const { account, clipboard, showFile } = setupAccount(
      vi.fn(async () => {
        throw new Error("The local account file must be private");
      }),
    );
    await account.refresh();
    await account.show(true);
    await account.copy();
    account.reveal();
    expect(account.view()).toEqual({
      error: "The local account file must be private",
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(showFile).not.toHaveBeenCalled();
  });

  it("hides a shown password once the file stops reading", async () => {
    const read = vi.fn(async () => ACCOUNT);
    const { account } = setupAccount(read);
    await account.refresh();
    await account.show(true);
    read.mockRejectedValueOnce(new Error("gone"));
    await account.refresh();
    read.mockResolvedValueOnce(ACCOUNT);
    await account.refresh();
    expect(account.view()).toEqual({ email: ACCOUNT.email });
  });
});
