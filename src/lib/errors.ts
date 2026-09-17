/** Best-effort human message from an HTTP error response body. */
export function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>
    const data =
      candidate.data && typeof candidate.data === 'object'
        ? (candidate.data as Record<string, unknown>)
        : null
    const statusMessage = data?.statusMessage ?? candidate.statusMessage
    const message = data?.message ?? candidate.message
    if (typeof statusMessage === 'string' && statusMessage) return statusMessage
    if (typeof message === 'string' && message) return message
  }
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong'
}