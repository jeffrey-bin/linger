// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  currentFragmentTheme,
  defaultFragmentTheme,
  extractWidgetBody,
  hostedFragmentDocument,
  hostedHtmlDocument,
  htmlFragmentSizeMessageType,
  wrapHtmlFragment,
} from "./html-fragment-host";

describe("wrapHtmlFragment", () => {
  it("hosts widget HTML in vis-container with color tokens and placeholder animation", () => {
    const html = wrapHtmlFragment("<svg></svg>");
    expect(html).toContain('id="vis-container"');
    expect(html).toContain("--color-text-primary");
    expect(html).toContain("vis-placeholder");
    expect(html).toContain("<svg></svg>");
    expect(html).toContain("#vis-container > svg");
    expect(html).toContain("max-width: 100%");
    expect(html).toContain(htmlFragmentSizeMessageType);
    expect(html).not.toContain(
      '<div id="vis-container" data-placeholder="true">',
    );
  });

  it("keeps the placeholder animation when the widget body is empty", () => {
    const html = wrapHtmlFragment("  ");
    expect(html).toContain('data-placeholder="true"');
  });

  it("scales fixed-width HTML fragments down to the host width", () => {
    const hosted = wrapHtmlFragment(
      '<div style="width:1180px"><span>last palette token</span></div>',
    );

    expect(hosted).toContain('id="vis-content"');
    expect(hosted).toContain(
      "const scale = Math.min(1, availableWidth / naturalWidth);",
    );
    expect(hosted).toContain(
      'content.style.transform = scale < 1 ? `scale(${scale})` : "";',
    );
    expect(hosted).toContain(
      "const scaledHeight = Math.ceil(naturalHeight * scale);",
    );
    expect(hosted).toContain(
      "if (vis.style.height !== nextHeight) vis.style.height = nextHeight;",
    );
    expect(hosted).toContain(
      "const height = Math.ceil(vis ? visRect : Math.max(",
    );
    expect(hosted).toContain("last palette token");
  });

  it("does not wrap an already hosted HTML document", () => {
    const hosted = wrapHtmlFragment("<p>chart</p>");
    expect(hostedHtmlDocument(hosted)).toBe(hosted);
    expect(hostedFragmentDocument(hosted)).toBe(hosted);
  });

  it("injects a size reporter into a complete HTML document", () => {
    const hosted = hostedHtmlDocument(
      "<!DOCTYPE html><html><body><p>ready</p></body></html>",
    );
    expect(hosted).toContain("<!DOCTYPE html>");
    expect(hosted).toContain("<p>ready</p>");
    expect(hosted).toContain(htmlFragmentSizeMessageType);
    expect(hosted).not.toContain('id="vis-container"');
  });

  it("wraps a fragment widget body in vis-container even when the agent sent a full HTML document", () => {
    const hosted = hostedFragmentDocument(
      '<!DOCTYPE html><html><body><svg width="1200" height="760"></svg></body></html>',
    );
    expect(hosted).toContain('id="vis-container"');
    expect(hosted).toContain('<svg width="1200" height="760"></svg>');
    expect(hosted).toContain("#vis-container > svg");
  });

  it("preserves presentation styles from a complete fragment document", () => {
    const hosted = hostedFragmentDocument(`<!DOCTYPE html>
      <html>
        <head>
          <style>.review-grid { display: grid; }</style>
          <link rel="stylesheet" href="https://example.com/deck.css" />
          <meta name="fragment-only" content="discard" />
          <script>window.headScriptExecuted = true;</script>
        </head>
        <body>
          <main class="review-grid">Layout review</main>
          <script>window.bodyScriptExecuted = true;</script>
        </body>
      </html>`);

    expect(hosted).toContain(".review-grid { display: grid; }");
    expect(hosted).toContain('rel="stylesheet"');
    expect(hosted).toContain('class="review-grid"');
    expect(hosted).toContain("window.bodyScriptExecuted = true;");
    expect(hosted).not.toContain("window.headScriptExecuted = true;");
    expect(hosted).not.toContain('name="fragment-only"');
    expect(hosted).toContain('id="vis-content"');
    expect(hosted).toContain(htmlFragmentSizeMessageType);
  });
});

describe("extractWidgetBody", () => {
  it("returns SVG widget markup unchanged", () => {
    expect(extractWidgetBody('<svg width="1200" height="760"></svg>')).toBe(
      '<svg width="1200" height="760"></svg>',
    );
  });
});

describe("fragment theme", () => {
  it("takes each variable from the app token, falling back where none is set", () => {
    const root = document.createElement("div");
    root.style.setProperty("--app-ink", "#111111");
    root.style.setProperty("--app-surface", "#fafafa");
    root.style.setProperty("--app-font-sans", '"Geist Variable", sans-serif');
    document.body.append(root);

    const theme = currentFragmentTheme(root);

    expect(theme["--color-text-primary"]).toBe("#111111");
    expect(theme["--color-background-primary"]).toBe("#fafafa");
    expect(theme["--font-sans"]).toBe('"Geist Variable", sans-serif');
    expect(theme["--color-accent"]).toBe(
      defaultFragmentTheme["--color-accent"],
    );
    root.remove();
  });

  it("writes the theme into the hosted document and styles the body with it", () => {
    const html = hostedFragmentDocument("<p>chart</p>", {
      ...defaultFragmentTheme,
      "--color-text-primary": "#222222",
    });
    expect(html).toContain("--color-text-primary: #222222;");
    expect(html).toContain("color-scheme: light;");
    expect(html).toContain("font-family: var(--font-sans);");
  });

  it("keeps a value from closing its declaration or the style element", () => {
    const html = wrapHtmlFragment("<p>x</p>", "", {
      ...defaultFragmentTheme,
      "--color-accent": "red;}</style><script>alert(1)</script>",
    });
    expect(html).not.toContain("</style><script>alert(1)");
  });
});
