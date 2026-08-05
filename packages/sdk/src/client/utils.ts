import { MappingTuple } from "./types";

function isMapping(key: string, objectMapping: MappingTuple<unknown>): boolean {
  return objectMapping?.some((tuple) => tuple[0] === key);
}

function getEnumValue(
  key: string,
  value: string,
  enumMapping: MappingTuple<unknown>
): number {
  // Added to support the edge case of "PRIVATE" being passed as "ID"
  const realValue = value === "ID" ? "PRIVATE" : value;
  const tuple = enumMapping.find((tuple) => tuple[0] === key);
  return (tuple ? tuple[1][realValue] : 0) as number;
}

function getEnumKey(
  key: string,
  value: number,
  enumMapping: MappingTuple<unknown>
): string {
  const tuple = enumMapping.find((tuple) => tuple[0] === key);
  const result = Object.keys(tuple[1]).find((k) => tuple[1][k] === value) || "";
  // Added to support the edge case of "PRIVATE" being returned as "ID"
  return result === "PRIVATE" ? "ID" : result;
}

export { getEnumKey, getEnumValue, isMapping };
