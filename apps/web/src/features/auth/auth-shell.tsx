import type { ReactNode } from "react";

import { BrandMark } from "@/components/ui/brand-mark";

import { AuthIllustration } from "./auth-illustration";

export function AuthShell({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <main className="auth-page min-h-dvh text-foreground">
      <header className="auth-brand" aria-label="Linger">
        <BrandMark decorative />
        <strong className="block text-lg text-foreground">Linger</strong>
      </header>

      <div className="auth-stage">
        <section
          aria-labelledby="auth-title"
          className="auth-panel w-full max-w-[400px]"
        >
          <div className="mb-8 text-left">
            <h1
              className="text-balance font-(family-name:--app-font-slab) text-[40px] font-light leading-[1.1] tracking-[-0.02em]"
              id="auth-title"
            >
              {title}
            </h1>
          </div>
          {children}
        </section>

        <div aria-hidden="true" className="auth-illustration">
          <AuthIllustration />
        </div>
      </div>

      <footer className="auth-footer text-xs text-muted-foreground">
        &copy; 2026 Linger
      </footer>
    </main>
  );
}
