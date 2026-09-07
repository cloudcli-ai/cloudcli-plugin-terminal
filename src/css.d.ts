/** CSS files are bundled as text by scripts/build.mjs (esbuild `text` loader). */
declare module '*.css' {
  const content: string;
  export default content;
}
