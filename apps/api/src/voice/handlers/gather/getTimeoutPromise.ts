interface PromiseWithResetTimer<T> extends Promise<T> {
  cancelGlobalTimer?: () => void;
}

function getTimeoutPromise(timeout: number) {
  const effectiveTimeout = timeout || 5000;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<unknown>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve("");
    }, effectiveTimeout);
  }) as PromiseWithResetTimer<unknown>;

  timeoutPromise.cancelGlobalTimer = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  return { timeoutPromise, effectiveTimeout };
}

export { getTimeoutPromise };
