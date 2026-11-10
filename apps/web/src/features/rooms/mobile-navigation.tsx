import { Menu01Icon } from "@hugeicons/core-free-icons";
import { createContext, useContext } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** Opens the narrow-screen navigation drawer the Room shell owns. */
export const OpenMobileNavigationContext = createContext<() => void>(() => {});

/** The narrow-screen menu button that opens the navigation drawer. */
export function MobileNavigationButton() {
  const open = useContext(OpenMobileNavigationContext);
  return (
    <Button
      aria-label="Open Room navigation"
      className="md:hidden"
      onClick={open}
      size="icon"
      tone="ghost"
    >
      <Icon icon={Menu01Icon} size={16} />
    </Button>
  );
}
