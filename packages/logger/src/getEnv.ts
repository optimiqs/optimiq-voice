function getEnv<T = string>(key: string, defaultValue?: T): T {
  // Look for any environment variable that is a service-prefixed variable (e.g. API_LOGS_FORMAT)
  const prefixedKey = Object.keys(process.env).find(
    (envKey) => envKey !== key && envKey.endsWith(`_${key}`)
  );

  if (prefixedKey !== undefined && process.env[prefixedKey] !== undefined) {
    return process.env[prefixedKey] as unknown as T;
  }

  return process.env[key] !== undefined
    ? (process.env[key] as unknown as T)
    : (defaultValue as T);
}

export { getEnv };
