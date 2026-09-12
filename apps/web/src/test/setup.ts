import "@testing-library/jest-dom/vitest";

if (!globalThis.MediaStream) {
  class TestMediaStream {
    private tracks: MediaStreamTrack[] = [];

    addTrack(track: MediaStreamTrack) {
      this.tracks.push(track);
    }

    removeTrack(track: MediaStreamTrack) {
      this.tracks = this.tracks.filter((existing) => existing !== track);
    }

    getTracks() {
      return this.tracks;
    }
  }

  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    value: TestMediaStream
  });
}
