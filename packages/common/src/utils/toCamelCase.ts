import { toPascalCase } from "./toPascalCase";

function toCamelCase(str: string): string {
  const pascalCase = toPascalCase(str);
  return pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1);
}

export { toCamelCase };
