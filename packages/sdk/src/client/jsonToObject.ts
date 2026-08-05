import { MappingTuple } from "./types";
import { getEnumValue, isMapping } from "./utils";

function jsonToObject<J extends Record<string, unknown>, T>(params: {
	json: J;
	objectConstructor: new () => T;
	enumMapping?: MappingTuple<unknown>;
	objectMapping?: MappingTuple<unknown>;
}): T {
	const { json, objectConstructor: ObjectConstructor, enumMapping, objectMapping } = params;
	const instance = new ObjectConstructor();

	Object.keys(json).forEach((key) => {
		const setterName = `set${key.charAt(0).toUpperCase() + key.slice(1)}`;

		if (json[key] === null || json[key] === undefined) {
			return;
		}

		if (isMapping(key, enumMapping)) {
			const enumValue = getEnumValue(key, json[key] as string, enumMapping);
			instance[setterName](enumValue);
		} else if (isMapping(key, objectMapping)) {
			const objectValue = jsonToObject({
				json: json[key] as Record<string, unknown>,
				objectConstructor: objectMapping.find((tuple) => tuple[0] === key)[1] as new () => unknown,
				enumMapping,
				objectMapping,
			});

			instance[setterName](objectValue);
		} else if (typeof instance[setterName] === "function") {
			instance[setterName](json[key]);
		}
	});

	return instance;
}

export { jsonToObject };
