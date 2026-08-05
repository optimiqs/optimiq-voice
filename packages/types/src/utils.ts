type Flatten<T> = { [K in keyof T]: T[K] };

type RenameAndConvertToTimestamp<T> = Omit<T, "createdAt" | "updatedAt"> & {
  createdAt: number;
  updatedAt: number;
};

export { Flatten, RenameAndConvertToTimestamp };
