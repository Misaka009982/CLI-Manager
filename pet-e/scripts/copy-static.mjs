import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "renderer");
await mkdir(output, { recursive: true });
await Promise.all([
  cp(path.join(root, "src", "renderer", "index.html"), path.join(output, "index.html")),
  cp(path.join(root, "src", "renderer", "styles.css"), path.join(output, "styles.css")),
]);
