export function createVocationTransport() {
  return {
    async execute(request) {
      return {
        operation: request.operation,
        payload: request.payload,
        requestId: request.requestId ?? null,
        timeoutMs: request.timeoutMs ?? null
      };
    }
  };
}
