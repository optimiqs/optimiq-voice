const originalLog = console.log;

const containsDeprecationWarning = (str: string) => {
	const deprecationWarning =
		"This API is using a deprecated version of Swagger!  Please see http://github.com/wordnik/swagger-core/wiki for more info";
	return str.includes(deprecationWarning);
};

// eslint-disable-next-line no-console
console.log = (...args) => {
	const logString = args.join(" ");
	if (!containsDeprecationWarning(logString)) {
		originalLog(...args);
	}
};

export default {};
