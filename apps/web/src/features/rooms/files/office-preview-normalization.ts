const legacyPlaceholderPrefix = /^click to edit (?:the )?/i;
const pptxSlideCanvasSelector = ".ofv-pptx-viewer > div > div > div";

export function normalizeOfficePreviewOnce(
  container: HTMLElement,
  filename: string,
) {
  const extension = fileExtension(filename);
  if (extension === "ppt") {
    removeLegacyPowerPointPlaceholders(container);
  } else if (extension === "pptx") {
    repairUnreadablePptxBackgrounds(container);
  }
}

function removeLegacyPowerPointPlaceholders(container: HTMLElement) {
  for (const shape of container.querySelectorAll<HTMLElement>(
    ".ofv-ppt-binary-master-shape",
  )) {
    const text = normalizeText(shape.textContent ?? "");
    if (legacyPlaceholderPrefix.test(text)) {
      shape.remove();
    }
  }
}

function repairUnreadablePptxBackgrounds(container: HTMLElement) {
  for (const canvas of container.querySelectorAll<HTMLElement>(
    pptxSlideCanvasSelector,
  )) {
    const background = parseRgb(getComputedStyle(canvas).backgroundColor);
    if (!background || relativeLuminance(background) > 0.03) {
      continue;
    }

    const textColors: Rgb[] = [];
    for (const element of canvas.querySelectorAll<HTMLElement>("*")) {
      if (
        element.children.length !== 0 ||
        normalizeText(element.textContent ?? "") === "" ||
        getComputedStyle(element).display === "none"
      ) {
        continue;
      }
      const color = parseRgb(getComputedStyle(element).color);
      if (color) textColors.push(color);
    }
    if (textColors.length === 0) {
      continue;
    }

    const unreadableTextCount = textColors.filter(
      (color) => contrastRatio(background, color) < 2.5,
    ).length;
    if (unreadableTextCount / textColors.length < 0.6) {
      continue;
    }

    canvas.style.backgroundColor = "rgb(255, 255, 255)";
    canvas.dataset.lingerBackgroundRepaired = "true";
  }
}

type Rgb = readonly [number, number, number];

function parseRgb(value: string): Rgb | undefined {
  const match = value.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/,
  );
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contrastRatio(first: Rgb, second: Rgb) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function relativeLuminance(color: Rgb) {
  const [red, green, blue] = color.map((component) => {
    const normalized = component / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function fileExtension(filename: string) {
  const separator = filename.lastIndexOf(".");
  return separator < 0 ? "" : filename.slice(separator + 1).toLowerCase();
}
