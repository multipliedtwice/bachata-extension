const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");

const loadProduction = (relative, names, dependencies = {}, before = "", after = "") => {
  const filename = path.join(root, relative);
  const ast = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const found = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
      const name = node.name.getText(ast);
      if (found.has(name)) throw new Error(`Ambiguous production declaration: ${name}`);
      found.set(name, `const ${node.getText(ast)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) if (!found.has(name)) throw new Error(`Missing production declaration: ${name}`);
  const code = `${before}\n${names.map((name) => found.get(name)).join("\n")}\n${after}\nreturn {${names.join(",")}};`;
  const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
};

const loadFixture = (relative, names) => {
  const filename = path.join(root, relative);
  const source = fs.readFileSync(filename, "utf8");
  const start = source.search(/^test\(/m);
  if (start < 0) throw new Error(`Missing fixture boundary: ${relative}`);
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(`${source.slice(0, start)}\nmodule.exports = {${names.join(",")}};`, filename);
  return loaded.exports;
};

module.exports = { root, loadProduction, loadFixture };
