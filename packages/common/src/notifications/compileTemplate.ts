import fs from "fs";
import handlebars from "handlebars";

type CompileTemplateParams = {
  filePath: string;
  data: Record<string, string>;
};

function compileTemplate(params: CompileTemplateParams) {
  const { filePath, data } = params;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }

  const source = fs.readFileSync(filePath, "utf-8").toString();
  const template = handlebars.compile(source);
  return template(data);
}

export { CompileTemplateParams, compileTemplate };
