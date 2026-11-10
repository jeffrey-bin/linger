// esbuild bundles .html files as text and .png and .woff2 files as bytes.
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.png" {
  const content: Uint8Array;
  export default content;
}
declare module "*.woff2" {
  const content: Uint8Array;
  export default content;
}
