import { Key01Icon, LaptopIcon, UserIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Suspense, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";

/** Settings is a page in the Space shell: its own sections beside the rail. */
export function SettingsLayout() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        aria-label="Settings navigation"
        className="flex shrink-0 flex-col border-b border-border px-3 py-4 md:w-[228px] md:border-r md:border-b-0"
      >
        <div className="flex items-center pt-0.5 pb-3.5">
          <h1 className="text-lg">Settings</h1>
        </div>
        <nav
          aria-label="Settings sections"
          className="workspace-scrollbar flex min-h-0 flex-1 gap-0.5 overflow-x-auto md:flex-col md:overflow-x-visible md:overflow-y-auto"
        >
          <SettingsLink
            icon={<Icon icon={UserIcon} size={14} />}
            label="Profile"
            to="account"
          />
          <SettingsLink
            icon={<Icon icon={Key01Icon} size={14} />}
            label="Security"
            to="security"
          />
          <SettingsLink
            icon={<Icon icon={LaptopIcon} size={14} />}
            label="Computers"
            to="computers"
          />
        </nav>
      </aside>
      <div className="workspace-content-viewport workspace-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6 md:px-8">
        <Suspense
          fallback={
            <SettingsSectionLoading
              computers={pathname.endsWith("/settings/computers")}
            />
          }
        >
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}

function SettingsSectionLoading({ computers }: { computers: boolean }) {
  const label = computers ? "Loading Computers" : "Loading content";
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="mx-auto w-full max-w-(--app-settings-width) space-y-4"
      role="status"
    >
      <span className="sr-only">{label}...</span>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function SettingsLink({
  icon,
  label,
  to,
}: {
  icon: ReactNode;
  label: string;
  to: string;
}) {
  return (
    <NavLink
      className={({ isActive }) =>
        `flex h-[33px] shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
          isActive
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        }`
      }
      replace
      to={to}
    >
      {icon}
      {label}
    </NavLink>
  );
}
