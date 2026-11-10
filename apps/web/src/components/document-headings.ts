export interface DocumentHeading {
  id: string;
  level: number;
  text: string;
}

export function extractRenderedDocumentHeadings(
  root: HTMLElement | null,
): DocumentHeading[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].flatMap(
    (heading, index) => {
      const text = heading.textContent?.trim();
      if (!text) return [];
      const block = heading.closest<HTMLElement>("[data-id]");
      for (
        let ancestor: HTMLElement | null = heading;
        ancestor && ancestor !== root;
        ancestor = ancestor.parentElement
      ) {
        if (getComputedStyle(ancestor).display === "none") return [];
      }
      const id =
        block?.dataset.id ??
        heading.dataset.id ??
        `document-preview-heading-${index + 1}`;
      if (!block) heading.dataset.id = id;
      return [{ id, level: Number(heading.tagName.slice(1)), text }];
    },
  );
}
