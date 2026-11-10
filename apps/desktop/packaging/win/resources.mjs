// Writes the icon and version information into Linger.exe (Electron ships
// its own). Run in the wintool image: node resources.mjs EXE ICO VERSION.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The image installs resedit globally (NODE_PATH), where import alone does
// not look.
const require = createRequire(import.meta.url);
const ResEdit = await import(pathToFileURL(require.resolve("resedit")).href);

const [exe, ico, version] = process.argv.slice(2);
const image = ResEdit.NtExecutable.from(readFileSync(exe), {
  ignoreCert: true,
});
const resources = ResEdit.NtExecutableResource.from(image);
const icon = ResEdit.Data.IconFile.from(readFileSync(ico));
for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(
  resources.entries,
))
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    group.id,
    group.lang,
    icon.icons.map((item) => item.data),
  );
const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
const [major, minor, patch] = version.split(/[.-]/).map(Number);
info.setFileVersion(major, minor, patch, 0, 1033);
info.setProductVersion(major, minor, patch, 0, 1033);
info.setStringValues(
  { lang: 1033, codepage: 1200 },
  {
    CompanyName: "Linger",
    FileDescription: "Linger",
    InternalName: "Linger",
    OriginalFilename: "Linger.exe",
    ProductName: "Linger",
    FileVersion: version,
    ProductVersion: version,
  },
);
info.outputToResourceEntries(resources.entries);
resources.outputResource(image);
writeFileSync(exe, Buffer.from(image.generate()));
