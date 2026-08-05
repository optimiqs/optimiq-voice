import { GRPC_NOT_SERVING_STATUS } from "./constants";

const statusMap = {
  // By convention, the empty string represents the entire server
  "": GRPC_NOT_SERVING_STATUS
};

export { statusMap };
