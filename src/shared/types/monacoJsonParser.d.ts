// Monaco 已随包提供 JSON AST；这里只声明使用的窄接口，不复制解析器。
declare module "monaco-editor/esm/external/jsonc-parser/lib/esm/impl/parser.js" {
  export function visit(text: string, visitor: {
    onObjectBegin?: () => void;
    onObjectProperty?: (name: string) => void;
    onObjectEnd?: () => void;
  }): boolean;
}
