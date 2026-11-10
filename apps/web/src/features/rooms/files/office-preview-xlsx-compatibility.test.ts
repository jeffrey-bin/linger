import { describe, expect, it } from "vitest";
import * as xlsx from "xlsx";

describe("Office preview SheetJS override", () => {
  it("uses the exact safe version and reads a bilingual workbook", () => {
    expect(xlsx.version).toBe("0.20.3");

    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet([
      ["Mois", "Messages"],
      ["Janvier", 1200],
      ["February", 1480],
    ]);
    xlsx.utils.book_append_sheet(workbook, worksheet, "Français-English");
    const bytes = xlsx.write(workbook, { bookType: "xlsx", type: "array" });
    const parsed = xlsx.read(bytes, { type: "array" });

    expect(parsed.SheetNames).toEqual(["Français-English"]);
    expect(
      xlsx.utils.sheet_to_json(parsed.Sheets["Français-English"]!, {
        header: 1,
      }),
    ).toEqual([
      ["Mois", "Messages"],
      ["Janvier", 1200],
      ["February", 1480],
    ]);
  });
});
