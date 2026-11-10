import path from "node:path";

function repoPath(file) {
  return (path.isAbsolute(file) ? path.relative(process.cwd(), file) : file)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
}

function shellQuote(file) {
  return `'${file.replaceAll("'", "'\\''")}'`;
}

function codeTasks(files) {
  const codeFiles = files.filter(
    (file) => !/^skills\/builtin\/[^/]+\/[^/]+\//u.test(repoPath(file)),
  );
  if (codeFiles.length === 0) {
    return [];
  }
  const fileArgs = codeFiles.map(shellQuote).join(" ");
  return [
    `eslint --fix --max-warnings=0 --no-warn-ignored ${fileArgs}`,
    `prettier --write ${fileArgs}`,
  ];
}

export default {
  "*.{js,cjs,mjs,jsx,ts,tsx,mts,cts}": codeTasks,
  "*.{css,graphql,gql,html,json,json5,md,markdown,mdx,scss,yaml,yml}":
    "prettier --write",
};
