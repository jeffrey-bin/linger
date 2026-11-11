import { useEffect, useState } from "react";

export type DesktopLocalAccountSignIn =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

// The desktop app's sign-in with the owner account of the Linger it installed
// on this computer (`window.lingerDesktop.localAccount`). The desktop reads
// the account file and signs this window in itself; the page never sees the
// password.
export interface DesktopLocalAccount {
  available(): Promise<boolean>;
  signIn(): Promise<DesktopLocalAccountSignIn>;
}

function desktopLocalAccount(): DesktopLocalAccount | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { localAccount?: DesktopLocalAccount } })
        .lingerDesktop?.localAccount;
}

/**
 * The account sign-in when this page runs in the desktop app and shows the
 * Linger installed on this computer; undefined in a browser, in older desktop
 * builds and for any other server.
 */
export function useDesktopLocalAccount(): DesktopLocalAccount | undefined {
  const [account, setAccount] = useState<DesktopLocalAccount>();
  useEffect(() => {
    const api = desktopLocalAccount();
    if (!api) return;
    let active = true;
    api
      .available()
      .then((available) => {
        if (active && available) setAccount(api);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return account;
}
