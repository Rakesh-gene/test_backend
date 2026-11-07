import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
const require = createRequire(import.meta.url);
export async function grammarProbe(
  source = 'export function greet(name) { return `Hello ${name}`; }',
) {
  await Parser.init();
  const language = await Language.load(
    require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm'),
  );
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree || tree.rootNode.hasError)
      throw new Error('JavaScript WASM grammar did not parse fixture.');
    const output = {
      language: 'javascript',
      root: tree.rootNode.type,
      declarations: tree.rootNode
        .descendantsOfType('function_declaration')
        .map((n) => ({ name: n.childForFieldName('name')?.text, line: n.startPosition.row + 1 })),
    };
    tree.delete();
    return output;
  } finally {
    parser.delete();
  }
}
