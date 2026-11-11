import { describe, expect, it, vi } from "vitest";

import { SetupAccount } from "./setup-account.js";

const ACCOUNT = {
  email: "owner@linger.local",
  password: "a-private-password",
  file: "/home/me/.simplexai/instances/desktop/local-account.json",
};

const setupAccount = (read = vi.fn(async () => ACCOUNT)) => {
  const copy = vi.fn();
  const showFile = vi.fn();
  return {
    account: new SetupAccount({ read, copy, showFile }),
    copy,
    showFile,
  };
};

describe("SetupAccount", () => {
  it("shows the email and keeps the password back until asked", async () => {
    const { account } = setupAccount();
    expect(account.view()).toBeUndefined();
    await account.refresh();
    expect(account.view()).toEqual({ email: ACCOUNT.email });
    account.show(true);
    expect(account.view()).toEqual({
      email: ACCOUNT.email,
      password: ACCOUNT.password,
    });
    account.show(false);
    expect(account.view()).toEqual({ email: ACCOUNT.email });
  });

  it("copies the password and reveals the file without the page", async () => {
    const { account, copy, showFile } = setupAccount();
    await account.refresh();
    account.copy();
    account.reveal();
    expect(copy).toHaveBeenCalledWith(ACCOUNT.password);
    expect(showFile).toHaveBeenCalledWith(ACCOUNT.file);
    expect(account.view()).not.toHaveProperty("password");
  });

  it("says why the file could not be read and offers nothing else", async () => {
    const { account, copy, showFile } = setupAccount(
      vi.fn(async () => {
        throw new Error("The local account file must be private");
      }),
    );
    await account.refresh();
    account.show(true);
    account.copy();
    account.reveal();
    expect(account.view()).toEqual({
      error: "The local account file must be private",
    });
    expect(copy).not.toHaveBeenCalled();
    expect(showFile).not.toHaveBeenCalled();
  });

  it("hides a shown password once the file stops reading", async () => {
    const read = vi.fn(async () => ACCOUNT);
    const { account } = setupAccount(read);
    await account.refresh();
    account.show(true);
    read.mockRejectedValueOnce(new Error("gone"));
    await account.refresh();
    read.mockResolvedValueOnce(ACCOUNT);
    await account.refresh();
    expect(account.view()).toEqual({ email: ACCOUNT.email });
  });
});
