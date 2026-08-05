import { z } from "zod";

const hostOrHostPortSchema = z.string().refine(
  (value) => {
    const hostRegex =
      /^(?!:\/\/)([a-zA-Z0-9-_]+(\.[a-zA-Z0-9-_]+)*|(\d{1,3}\.){3}\d{1,3})$/;
    const hostPortRegex =
      /^(?!:\/\/)([a-zA-Z0-9-_]+(\.[a-zA-Z0-9-_]+)*|(\d{1,3}\.){3}\d{1,3}):\d{1,5}$/;

    return hostRegex.test(value) || hostPortRegex.test(value);
  },
  {
    message: "Invalid format. Expects 'host' or 'host:port'"
  }
);

export { hostOrHostPortSchema };
