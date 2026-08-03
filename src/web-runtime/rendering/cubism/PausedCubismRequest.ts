/** Single overwrite slot used by Cubism's pause-time playback channels. */
export class PausedCubismRequest<T> {
  private pending: T | null = null;

  retain(request: T): void {
    this.pending = request;
  }

  take(): T | null {
    const request = this.pending;
    this.pending = null;
    return request;
  }

  clear(): void {
    this.pending = null;
  }
}
